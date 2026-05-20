import type { FastifyInstance } from 'fastify';
import { prisma } from '@nexus/db';

function azureHeaders(pat: string): Record<string, string> {
  return {
    Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`,
    'Content-Type': 'application/json',
  };
}

function azurePatchHeaders(pat: string): Record<string, string> {
  return {
    Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`,
    'Content-Type': 'application/json-patch+json',
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchJsonWithInit<T = any>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}


type ChatModelMessage = { role: 'system' | 'user' | 'assistant'; content: string };

type AdoClassificationNode = {
  name: string;
  path?: string;
  children?: AdoClassificationNode[];
  attributes?: { startDate?: string; finishDate?: string };
};

async function fetchModelJson<T = Record<string, unknown>>(
  token: string,
  model: string,
  messages: ChatModelMessage[],
  temperature = 0.7
): Promise<T> {
  const response = await fetch('https://models.inference.ai.azure.com/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`AI API error: ${text}`);
  }

  const aiResponse = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = aiResponse.choices?.[0]?.message?.content ?? '{}';
  return JSON.parse(content) as T;
}

function getFirstLevelPaths(root?: AdoClassificationNode | null): string[] {
  return (root?.children ?? [])
    .map((child) => child.path ?? child.name)
    .filter((value): value is string => Boolean(value));
}

function getActiveIterationPaths(root?: AdoClassificationNode | null): string[] {
  const now = Date.now();
  const paths = new Set<string>();

  const visit = (node: AdoClassificationNode, depth: number) => {
    if (depth > 0 && node.path) {
      const finishDate = node.attributes?.finishDate ? Date.parse(node.attributes.finishDate) : Number.POSITIVE_INFINITY;
      if (Number.isNaN(finishDate) || finishDate >= now) {
        paths.add(node.path);
      }
    }

    if (depth >= 2) return;
    for (const child of node.children ?? []) visit(child, depth + 1);
  };

  if (root) visit(root, 0);
  return [...paths];
}

export async function workItemRoutes(app: FastifyInstance) {
  // ─── List work items ───────────────────────────────────────────────────────
  app.get<{
    Params: { id: string };
    Querystring: { type?: string; state?: string; top?: string; assignedTo?: string };
  }>('/:id/work-items', async (req, reply) => {
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) return reply.status(404).send({ error: 'not_found', message: 'Project not found' });

    const connId = project.connectionId;
    const adoProject = project.adoProjectName;
    if (!connId || !adoProject) {
      return reply.status(400).send({ error: 'not_configured', message: 'ADO connection not configured for this project' });
    }

    const conn = await prisma.customerConnection.findUnique({ where: { id: connId } });
    if (!conn || conn.type !== 'azure-devops') {
      return reply.status(404).send({ error: 'not_found', message: 'Azure DevOps connection not found' });
    }

    const { type, state, top = '50', assignedTo } = req.query;
    const topN = Math.min(Math.max(parseInt(top, 10) || 50, 1), 200);

    // Build WIQL where clause
    const conditions: string[] = [`[System.TeamProject] = '${adoProject}'`];
    if (type) conditions.push(`[System.WorkItemType] = '${type}'`);
    if (state) conditions.push(`[System.State] = '${state}'`);
    if (assignedTo) conditions.push(`[System.AssignedTo] = '${assignedTo}'`);

    const wiql = `SELECT [System.Id], [System.Title], [System.WorkItemType], [System.State], [System.AssignedTo], [System.CreatedDate], [System.ChangedDate] FROM WorkItems WHERE ${conditions.join(' AND ')} ORDER BY [System.ChangedDate] DESC`;

    try {
      const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';

      // Run WIQL query to get IDs
      const wiqlResult = await fetchJsonWithInit<{ workItems: Array<{ id: number; url: string }> }>(
        `${baseUrl}/${encodeURIComponent(adoProject)}/_apis/wit/wiql?$top=${topN}&api-version=7.1`,
        { method: 'POST', headers: azureHeaders(conn.pat), body: JSON.stringify({ query: wiql }) }
      );

      const ids = (wiqlResult.workItems ?? []).map((wi) => wi.id).slice(0, topN);
      if (ids.length === 0) return { data: [], meta: { total: 0 } };

      // Batch fetch details
      const fields = [
        'System.Id', 'System.Title', 'System.WorkItemType', 'System.State',
        'System.AssignedTo', 'System.CreatedDate', 'System.ChangedDate',
        'Microsoft.VSTS.Common.Priority', 'System.Description',
        'Microsoft.VSTS.Common.AcceptanceCriteria',
        'System.Tags', 'System.AreaPath', 'System.IterationPath',
      ].join(',');

      const detailsUrl = `${baseUrl}/_apis/wit/workitems?ids=${ids.join(',')}&fields=${fields}&api-version=7.1`;
      const detailsResult = await fetchJsonWithInit<{ value: Array<Record<string, unknown>> }>(
        detailsUrl,
        { method: 'GET', headers: azureHeaders(conn.pat) }
      );

      const items = (detailsResult.value ?? []).map((wi) => {
        const f = wi.fields as Record<string, unknown>;
        const assignee = f['System.AssignedTo'] as { displayName?: string; uniqueName?: string } | null;
        return {
          id: wi.id,
          title: f['System.Title'],
          type: f['System.WorkItemType'],
          state: f['System.State'],
          priority: f['Microsoft.VSTS.Common.Priority'],
          assignedTo: assignee ? (assignee.displayName ?? assignee.uniqueName ?? null) : null,
          description: f['System.Description'] ?? null,
          acceptanceCriteria: f['Microsoft.VSTS.Common.AcceptanceCriteria'] ?? null,
          tags: f['System.Tags'] ?? null,
          areaPath: f['System.AreaPath'] ?? null,
          iterationPath: f['System.IterationPath'] ?? null,
          createdDate: f['System.CreatedDate'],
          changedDate: f['System.ChangedDate'],
          url: `${conn.baseUrl?.replace(/\/$/, '')}/${encodeURIComponent(adoProject)}/_workitems/edit/${wi.id}`,
        };
      });

      return { data: items, meta: { total: items.length } };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(502).send({ error: 'remote_error', message });
    }
  });

  // ─── Get single work item ──────────────────────────────────────────────────
  app.get<{ Params: { id: string; wiId: string } }>(
    '/:id/work-items/:wiId',
    async (req, reply) => {
      const project = await prisma.project.findUnique({ where: { id: req.params.id } });
      if (!project?.connectionId || !project.adoProjectName) {
        return reply.status(400).send({ error: 'not_configured', message: 'ADO connection not configured' });
      }

      const conn = await prisma.customerConnection.findUnique({ where: { id: project.connectionId } });
      if (!conn || conn.type !== 'azure-devops') {
        return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
      }

      try {
        const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';
        const fields = [
          'System.Id', 'System.Title', 'System.WorkItemType', 'System.State',
          'System.AssignedTo', 'System.CreatedDate', 'System.ChangedDate',
          'Microsoft.VSTS.Common.Priority', 'System.Description',
          'Microsoft.VSTS.Common.AcceptanceCriteria',
          'System.Tags', 'System.AreaPath', 'System.IterationPath', 'System.History',
        ].join(',');

        const data = await fetchJsonWithInit<Record<string, unknown>>(
          `${baseUrl}/_apis/wit/workitems/${req.params.wiId}?fields=${fields}&api-version=7.1`,
          { method: 'GET', headers: azureHeaders(conn.pat) }
        );

        const f = data.fields as Record<string, unknown>;
        const assignee = f['System.AssignedTo'] as { displayName?: string; uniqueName?: string } | null;
        return {
          data: {
            id: data.id,
            title: f['System.Title'],
            type: f['System.WorkItemType'],
            state: f['System.State'],
            priority: f['Microsoft.VSTS.Common.Priority'],
            assignedTo: assignee ? (assignee.displayName ?? assignee.uniqueName ?? null) : null,
            description: f['System.Description'] ?? null,
            acceptanceCriteria: f['Microsoft.VSTS.Common.AcceptanceCriteria'] ?? null,
            tags: f['System.Tags'] ?? null,
            areaPath: f['System.AreaPath'] ?? null,
            iterationPath: f['System.IterationPath'] ?? null,
            createdDate: f['System.CreatedDate'],
            changedDate: f['System.ChangedDate'],
            url: `${baseUrl}/${encodeURIComponent(project.adoProjectName!)}/_workitems/edit/${data.id}`,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(502).send({ error: 'remote_error', message });
      }
    }
  );

  // ─── Create work item ──────────────────────────────────────────────────────
  app.post<{
    Params: { id: string };
    Body: {
      type: string; // e.g. 'User Story', 'Bug', 'Task', 'Feature'
      title: string;
      description?: string;
      acceptanceCriteria?: string;
      priority?: number;
      tags?: string;
      areaPath?: string;
      iterationPath?: string;
    };
  }>('/:id/work-items', async (req, reply) => {
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project?.connectionId || !project.adoProjectName) {
      return reply.status(400).send({ error: 'not_configured', message: 'ADO connection not configured' });
    }

    const conn = await prisma.customerConnection.findUnique({ where: { id: project.connectionId } });
    if (!conn || conn.type !== 'azure-devops') {
      return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
    }

    const { type, title, description, acceptanceCriteria, priority, tags, areaPath, iterationPath } = req.body;
    if (!type || !title?.trim()) {
      return reply.status(400).send({ error: 'validation', message: 'type and title are required' });
    }

    // Build JSON Patch document
    const patchDoc: Array<{ op: string; path: string; value: unknown }> = [
      { op: 'add', path: '/fields/System.Title', value: title },
    ];
    if (description) patchDoc.push({ op: 'add', path: '/fields/System.Description', value: description });
    if (acceptanceCriteria) patchDoc.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.AcceptanceCriteria', value: acceptanceCriteria });
    if (priority) patchDoc.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: priority });
    if (tags) patchDoc.push({ op: 'add', path: '/fields/System.Tags', value: tags });
    if (areaPath) patchDoc.push({ op: 'add', path: '/fields/System.AreaPath', value: areaPath });
    if (iterationPath) patchDoc.push({ op: 'add', path: '/fields/System.IterationPath', value: iterationPath });

    try {
      const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';
      const workItemType = encodeURIComponent(`$${type}`);
      const url = `${baseUrl}/${encodeURIComponent(project.adoProjectName)}/_apis/wit/workitems/${workItemType}?api-version=7.1`;

      const created = await fetchJsonWithInit<Record<string, unknown>>(url, {
        method: 'POST',
        headers: azurePatchHeaders(conn.pat),
        body: JSON.stringify(patchDoc),
      });

      const f = created.fields as Record<string, unknown>;
      return reply.status(201).send({
        data: {
          id: created.id,
          title: f['System.Title'],
          type: f['System.WorkItemType'],
          state: f['System.State'],
          url: `${baseUrl}/${encodeURIComponent(project.adoProjectName)}/_workitems/edit/${created.id}`,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(502).send({ error: 'remote_error', message });
    }
  });

  // ─── Update work item ──────────────────────────────────────────────────────
  app.patch<{
    Params: { id: string; wiId: string };
    Body: { title?: string; description?: string; acceptanceCriteria?: string; state?: string; priority?: number; tags?: string };
  }>('/:id/work-items/:wiId', async (req, reply) => {
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project?.connectionId || !project.adoProjectName) {
      return reply.status(400).send({ error: 'not_configured', message: 'ADO connection not configured' });
    }

    const conn = await prisma.customerConnection.findUnique({ where: { id: project.connectionId } });
    if (!conn || conn.type !== 'azure-devops') {
      return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
    }

    const patchDoc: Array<{ op: string; path: string; value: unknown }> = [];
    if (req.body.title) patchDoc.push({ op: 'add', path: '/fields/System.Title', value: req.body.title });
    if (req.body.description !== undefined) patchDoc.push({ op: 'add', path: '/fields/System.Description', value: req.body.description });
    if (req.body.acceptanceCriteria !== undefined) patchDoc.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.AcceptanceCriteria', value: req.body.acceptanceCriteria });
    if (req.body.state) patchDoc.push({ op: 'add', path: '/fields/System.State', value: req.body.state });
    if (req.body.priority) patchDoc.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: req.body.priority });
    if (req.body.tags !== undefined) patchDoc.push({ op: 'add', path: '/fields/System.Tags', value: req.body.tags });

    if (patchDoc.length === 0) {
      return reply.status(400).send({ error: 'validation', message: 'No fields to update' });
    }

    try {
      const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';
      const updated = await fetchJsonWithInit<Record<string, unknown>>(
        `${baseUrl}/_apis/wit/workitems/${req.params.wiId}?api-version=7.1`,
        { method: 'PATCH', headers: azurePatchHeaders(conn.pat), body: JSON.stringify(patchDoc) }
      );

      const f = updated.fields as Record<string, unknown>;
      return {
        data: {
          id: updated.id,
          title: f['System.Title'],
          type: f['System.WorkItemType'],
          state: f['System.State'],
          url: `${baseUrl}/${encodeURIComponent(project.adoProjectName!)}/_workitems/edit/${updated.id}`,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(502).send({ error: 'remote_error', message });
    }
  });

  // ─── List work item types for project ─────────────────────────────────────
  app.get<{ Params: { id: string } }>('/:id/work-item-types', async (req, reply) => {
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project?.connectionId || !project.adoProjectName) {
      return reply.status(400).send({ error: 'not_configured', message: 'ADO connection not configured' });
    }

    const conn = await prisma.customerConnection.findUnique({ where: { id: project.connectionId } });
    if (!conn || conn.type !== 'azure-devops') {
      return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
    }

    try {
      const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';
      const data = await fetchJsonWithInit<{ value: Array<{ name: string; color?: string; icon?: { url?: string } }> }>(
        `${baseUrl}/${encodeURIComponent(project.adoProjectName)}/_apis/wit/workitemtypes?api-version=7.1`,
        { method: 'GET', headers: azureHeaders(conn.pat) }
      );

      const types = (data.value ?? []).map((t) => ({
        name: t.name,
        color: t.color,
        icon: t.icon?.url,
      }));

      return { data: types };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(502).send({ error: 'remote_error', message });
    }
  });

  // ─── AI agent streaming run for work item generation ───────────────────────
  app.post<{
    Params: { id: string };
    Body: { agentId?: string; description: string; workItemType?: string };
  }>('/:id/work-items/generate-stream', async (req, reply) => {
    reply.hijack();
    reply.raw.statusCode = 200;
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.flushHeaders?.();

    const sendEvent = (type: string, payload: Record<string, unknown>) => {
      reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    const sendLog = (message: string) => sendEvent('log', { message });
    const endStream = () => {
      if (!reply.raw.writableEnded) reply.raw.end();
    };

    try {
      const { agentId, description, workItemType } = req.body;
      if (!description?.trim()) throw new Error('description is required');

      const project = await prisma.project.findUnique({ where: { id: req.params.id } });
      if (!project) throw new Error('Project not found');

      const token = process.env.GITHUB_TOKEN;
      if (!token) throw new Error('AI provider token not configured');

      const model = process.env.AI_MODEL ?? 'gpt-4o-mini';
      const trimmedDescription = description.trim();
      let adoContext = 'Azure DevOps project context was not available for this request.';

      sendLog('Loading project context from Azure DevOps...');
      if (project.connectionId && project.adoProjectName) {
        const conn = await prisma.customerConnection.findUnique({ where: { id: project.connectionId } });
        if (!conn || conn.type !== 'azure-devops') {
          throw new Error('Azure DevOps connection not found');
        }

        const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';
        const adoProject = encodeURIComponent(project.adoProjectName);
        const [typesData, areasData, iterationsData] = await Promise.all([
          fetchJsonWithInit<{ value?: Array<{ name: string }> }>(
            `${baseUrl}/${adoProject}/_apis/wit/workitemtypes?api-version=7.1`,
            { method: 'GET', headers: azureHeaders(conn.pat) }
          ),
          fetchJsonWithInit<AdoClassificationNode>(
            `${baseUrl}/${adoProject}/_apis/wit/classificationnodes/areas?$depth=2&api-version=7.1`,
            { method: 'GET', headers: azureHeaders(conn.pat) }
          ),
          fetchJsonWithInit<AdoClassificationNode>(
            `${baseUrl}/${adoProject}/_apis/wit/classificationnodes/iterations?$depth=2&api-version=7.1`,
            { method: 'GET', headers: azureHeaders(conn.pat) }
          ),
        ]);

        const workItemTypes = (typesData.value ?? []).map((item) => item.name).filter(Boolean);
        const areaPaths = getFirstLevelPaths(areasData);
        const iterationPaths = getActiveIterationPaths(iterationsData).filter((path) => path !== project.adoProjectName);

        adoContext = [
          `Azure DevOps project: ${project.adoProjectName}`,
          `Allowed work item types:\n${workItemTypes.length > 0 ? workItemTypes.map((item) => `- ${item}`).join('\n') : '- None returned'}`,
          `Available area paths:\n${areaPaths.length > 0 ? areaPaths.map((item) => `- ${item}`).join('\n') : '- None returned'}`,
          `Active iterations:\n${iterationPaths.length > 0 ? iterationPaths.map((item) => `- ${item}`).join('\n') : '- None returned'}`,
        ].join('\n\n');

        sendLog(`Context loaded: ${workItemTypes.length} work item types, ${areaPaths.length} area paths, ${iterationPaths.length} iterations`);
      } else {
        sendLog('Context loaded: 0 work item types, 0 area paths, 0 iterations');
      }

      let agent: Awaited<ReturnType<typeof prisma.agent.findUnique>> | null = null;
      let selectedSkillLinks: Array<{ skill: { name: string; type: string; promptTemplate: string | null } }> = [];

      if (agentId) {
        agent = await prisma.agent.findUnique({
          where: { id: agentId },
          include: { skills: { include: { skill: true } } },
        });

        if (!agent) throw new Error('Agent not found');

        sendLog(`Loading agent: ${agent.name}...`);
        const skillNames = agent.skills.map((entry) => entry.skill.name);
        sendLog(`Agent has ${agent.skills.length} skill(s): ${skillNames.length > 0 ? skillNames.join(', ') : 'none'}`);

        if (agent.skills.length > 0) {
          sendLog('Selecting relevant skills for this request...');
          const skillSelection = await fetchModelJson<{ selectedSkills?: string[] }>(
            token,
            model,
            [
              {
                role: 'system',
                content: 'You are a skill selector. Given a user request and a list of skills, select the most relevant skills to use. Return JSON: { "selectedSkills": ["skill name 1", "skill name 2"] }',
              },
              {
                role: 'user',
                content: `Request: ${trimmedDescription}\nAvailable skills:\n${agent.skills.map((entry) => `- ${entry.skill.name}: ${entry.skill.description ?? 'No description provided.'}`).join('\n')}`,
              },
            ],
            0.2
          );

          const selectedSkillNames = Array.isArray(skillSelection.selectedSkills)
            ? skillSelection.selectedSkills.map((name) => String(name))
            : [];

          selectedSkillLinks = agent.skills.filter((entry) => selectedSkillNames.includes(entry.skill.name));
          for (const entry of selectedSkillLinks) {
            sendLog(`Using skill: ${entry.skill.name}`);
          }
        }
      }

      sendLog('Generating work item content...');
      const selectedSkillPrompts = selectedSkillLinks
        .filter((entry) => entry.skill.type === 'prompt' && entry.skill.promptTemplate)
        .map((entry) => `## Skill: ${entry.skill.name}\n${entry.skill.promptTemplate}`)
        .join('\n\n');

      const systemContent = [
        agent?.systemPrompt?.trim() || 'You are a helpful work item writer.',
        selectedSkillPrompts,
        adoContext,
        `Your task is to generate a work item. IMPORTANT: Follow the language and style instructions above exactly.
Return ONLY valid JSON with these fields (plain text or markdown only, no HTML):
{
  "title": "concise title",
  "description": "plain text or markdown description of the work item",
  "acceptanceCriteria": "plain text or markdown acceptance criteria",
  "type": "${workItemType ?? 'User Story'}",
  "priority": 2,
  "tags": "comma-separated tags or empty string",
  "areaPath": "best matching Azure DevOps area path or empty string"
}
If the system prompt above specifies a language, ALL text fields must be written in that language. Prefer one of the provided work item types and area paths when context is available.`,
      ].filter(Boolean).join('\n\n');

      const generated = await fetchModelJson<Record<string, unknown>>(
        token,
        model,
        [
          { role: 'system', content: systemContent },
          { role: 'user', content: trimmedDescription },
        ]
      );

      sendEvent('result', generated);
      sendEvent('done', { ok: true });
      endStream();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      sendEvent('error', { message });
      endStream();
    }
  });

  // ─── AI agent sync-run for work item generation ────────────────────────────
  // Runs an agent synchronously (waits for result) — safe for lightweight prompt skills
  app.post<{
    Params: { id: string };
    Body: { agentId: string; description: string; workItemType?: string };
  }>('/:id/work-items/agent-generate', async (req, reply) => {
    const { agentId, description, workItemType } = req.body;
    if (!agentId || !description?.trim()) {
      return reply.status(400).send({ error: 'validation', message: 'agentId and description are required' });
    }

    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      include: { skills: { include: { skill: true } } },
    });

    if (!agent) return reply.status(404).send({ error: 'not_found', message: 'Agent not found' });

    const token = process.env.GITHUB_TOKEN;
    if (!token) return reply.status(500).send({ error: 'config', message: 'AI provider token not configured' });

    const model = process.env.AI_MODEL ?? 'gpt-4o-mini';
    const baseURL = 'https://models.inference.ai.azure.com';

    // Build system prompt: agent system prompt + any skill prompt templates
    const skillPrompts = agent.skills
      .filter((as) => as.skill.type === 'prompt' && as.skill.promptTemplate)
      .map((as) => `\n\n## Skill: ${as.skill.name}\n${as.skill.promptTemplate}`)
      .join('');

    const systemContent = `${agent.systemPrompt ?? 'You are a helpful work item writer.'}${skillPrompts}

Your task is to generate a work item. IMPORTANT: Follow the language and style instructions above exactly.
Return ONLY valid JSON with these fields (no HTML tags — use plain text or markdown only):
{
  "title": "concise title",
  "description": "plain text or markdown description of the work item",
  "acceptanceCriteria": "plain text or markdown acceptance criteria (BDD format for User Stories)",
  "type": "${workItemType ?? 'User Story'}",
  "priority": 2,
  "tags": "comma-separated tags or empty string"
}
If the system prompt above specifies a language (e.g. German, French), ALL text fields must be written in that language.`;

    try {
      const response = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemContent },
            { role: 'user', content: description.trim() },
          ],
          temperature: 0.7,
          response_format: { type: 'json_object' },
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        return reply.status(502).send({ error: 'ai_error', message: `AI API error: ${text}` });
      }

      const aiResponse = await response.json() as { choices: Array<{ message: { content: string } }> };
      const content = aiResponse.choices?.[0]?.message?.content ?? '{}';
      const generated = JSON.parse(content);

      return { data: generated };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: 'ai_error', message });
    }
  });
}
