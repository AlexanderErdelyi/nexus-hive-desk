import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
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

function azureAttachmentHeaders(pat: string): Record<string, string> {
  return {
    Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`,
    'Content-Type': 'application/octet-stream',
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

type ScreenshotUpload = { index: number; url: string | null };

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

function replaceScreenshotPlaceholders(value: string | undefined, uploads: ScreenshotUpload[]): string | undefined {
  if (!value) return value;

  return uploads.reduce((content, upload) => (
    upload.url ? content.replaceAll(`SCREENSHOT_PLACEHOLDER_${upload.index}`, upload.url) : content
  ), value);
}

export async function workItemRoutes(app: FastifyInstance) {
  // ─── List work items ───────────────────────────────────────────────────────
  app.get<{
    Params: { id: string };
    Querystring: { type?: string; state?: string; top?: string; assignedTo?: string; search?: string };
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

    const { type, state, top = '50', assignedTo, search } = req.query;
    const topN = Math.min(Math.max(parseInt(top, 10) || 50, 1), 200);

    // Build WIQL where clause
    const conditions: string[] = [`[System.TeamProject] = '${adoProject}'`];
    if (type) conditions.push(`[System.WorkItemType] = '${type}'`);
    if (state) conditions.push(`[System.State] = '${state}'`);
    if (assignedTo) conditions.push(`[System.AssignedTo] = '${assignedTo}'`);
    if (search) {
      const safe = search.replace(/'/g, "''");
      if (/^\d+$/.test(search)) {
        conditions.push(`[System.Id] = ${parseInt(search, 10)}`);
      } else {
        conditions.push(`[System.Title] CONTAINS '${safe}'`);
      }
    }
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
      screenshotPaths?: string[];
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

    const { type, title, description, acceptanceCriteria, priority, tags, areaPath, iterationPath, screenshotPaths } = req.body;
    if (!type || !title?.trim()) {
      return reply.status(400).send({ error: 'validation', message: 'type and title are required' });
    }

    try {
      const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';
      const screenshotUploads = await Promise.all((Array.isArray(screenshotPaths) ? screenshotPaths : []).map(async (screenshotPath, index) => {
        if (typeof screenshotPath !== 'string' || !screenshotPath || !existsSync(screenshotPath)) {
          return { index, url: null };
        }

        try {
          const attachment = await fetchJsonWithInit<{ url?: string }>(
            `${baseUrl}/${encodeURIComponent(project.adoProjectName!)}/_apis/wit/attachments?fileName=${encodeURIComponent(basename(screenshotPath))}&api-version=7.1`,
            {
              method: 'POST',
              headers: azureAttachmentHeaders(conn.pat),
              body: readFileSync(screenshotPath),
            }
          );

          return { index, url: attachment.url ?? null };
        } catch {
          return { index, url: null };
        }
      }));

      const descriptionWithScreenshots = replaceScreenshotPlaceholders(description, screenshotUploads);
      const acceptanceCriteriaWithScreenshots = replaceScreenshotPlaceholders(acceptanceCriteria, screenshotUploads);

      // Build JSON Patch document
      const patchDoc: Array<{ op: string; path: string; value: unknown }> = [
        { op: 'add', path: '/fields/System.Title', value: title },
      ];
      if (descriptionWithScreenshots) patchDoc.push({ op: 'add', path: '/fields/System.Description', value: descriptionWithScreenshots });
      if (acceptanceCriteriaWithScreenshots) patchDoc.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.AcceptanceCriteria', value: acceptanceCriteriaWithScreenshots });
      if (priority) patchDoc.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: priority });
      if (tags) patchDoc.push({ op: 'add', path: '/fields/System.Tags', value: tags });
      if (areaPath) patchDoc.push({ op: 'add', path: '/fields/System.AreaPath', value: areaPath });
      if (iterationPath) patchDoc.push({ op: 'add', path: '/fields/System.IterationPath', value: iterationPath });

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
    Body: { agentId?: string; description: string; workItemType?: string; recordingId?: string; includeRepoContext?: boolean };
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
      const { agentId, description, workItemType, includeRepoContext = true } = req.body;
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

      let repoContext = '';
      if (includeRepoContext) {
        sendLog('Loading repository context...');
        try {
          const repos = await prisma.projectRepository.findMany({ where: { projectId: project.id } });

          if (repos.length > 0) {
            const repoContextParts: string[] = [];

            for (const repo of repos.slice(0, 2)) {
              const repoConn = await prisma.customerConnection.findUnique({ where: { id: repo.connectionId } });
              if (!repoConn || repoConn.type !== 'azure-devops') continue;

              const baseUrl = repoConn.baseUrl?.replace(/\/$/, '') ?? '';
              const adoProj = encodeURIComponent(repo.adoProjectName ?? project.adoProjectName ?? '');
              const branch = repo.defaultBranch ?? 'main';

              sendLog(`Scanning repo: ${repo.repoName} (${branch})...`);

              const treeUrl = `${baseUrl}/${adoProj}/_apis/git/repositories/${encodeURIComponent(repo.repoName)}/items?recursionLevel=Full&versionDescriptor.version=${encodeURIComponent(branch)}&versionDescriptor.versionType=branch&api-version=7.1`;
              const treeData = await fetchJsonWithInit<{ value?: Array<{ path: string; gitObjectType?: string }> }>(
                treeUrl,
                { method: 'GET', headers: azureHeaders(repoConn.pat) }
              );

              const allFiles = (treeData.value ?? [])
                .filter((item) => item.gitObjectType === 'blob')
                .map((item) => item.path);

              const xliffFiles = allFiles.filter((path) => /\.(xlf|xliff|xlf2)$/i.test(path));
              const alFiles = allFiles.filter((path) => /\.al$/i.test(path)).slice(0, 10);

              sendLog(`Found ${xliffFiles.length} XLIFF file(s) and ${alFiles.length} AL file(s)`);

              const repoParts: string[] = [`Repository: ${repo.label ?? repo.repoName}`];
              repoParts.push(`File tree summary:\n${allFiles.slice(0, 50).map((path) => `  ${path}`).join('\n')}${allFiles.length > 50 ? `\n  ... and ${allFiles.length - 50} more files` : ''}`);

              if (xliffFiles.length > 0) {
                const xliffPath = xliffFiles[0];
                sendLog(`Reading XLIFF: ${xliffPath}...`);
                try {
                  const contentUrl = `${baseUrl}/${adoProj}/_apis/git/repositories/${encodeURIComponent(repo.repoName)}/items?path=${encodeURIComponent(xliffPath)}&versionDescriptor.version=${encodeURIComponent(branch)}&versionDescriptor.versionType=branch&api-version=7.1`;
                  const contentRes = await fetch(contentUrl, { headers: azureHeaders(repoConn.pat) });
                  if (contentRes.ok) {
                    const xliffContent = await contentRes.text();
                    repoParts.push(`XLIFF file (${xliffPath}) — first 3000 chars:\n${xliffContent.slice(0, 3000)}`);
                  }
                } catch {
                  // ignore XLIFF content errors
                }

                if (xliffFiles.length > 1) {
                  repoParts.push(`Other XLIFF files:\n${xliffFiles.slice(1).map((path) => `  ${path}`).join('\n')}`);
                }
              }

              if (alFiles.length > 0) {
                repoParts.push(`Relevant AL files:\n${alFiles.map((path) => `  ${path}`).join('\n')}`);
              }

              repoContextParts.push(repoParts.join('\n\n'));
            }

            if (repoContextParts.length > 0) {
              repoContext = `## Repository Context\n\n${repoContextParts.join('\n\n---\n\n')}`;
              sendLog('Repository context loaded');
            }
          } else {
            sendLog('No repositories configured for this project');
          }
        } catch (repoError) {
          sendLog(`Repository context unavailable: ${repoError instanceof Error ? repoError.message : 'unknown error'}`);
        }
      } else {
        sendLog('Repository context skipped for this request');
      }

      let agentSystemPrompt: string | null = null;
      let selectedSkillLinks: Array<{ skill: { name: string; type: string; promptTemplate: string | null; description?: string | null } }> = [];

      if (agentId) {
        const agent = await prisma.agent.findUnique({
          where: { id: agentId },
          include: { skills: { include: { skill: true } } },
        });

        if (!agent) throw new Error('Agent not found');

        agentSystemPrompt = agent.systemPrompt;
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

      // ─── MCP Context (e.g. Teams recordings) ────────────────────────────────
      let mcpContext = '';
      let screenshotPaths: string[] = [];
      if (agentId) {
        const agentWithMcp = await prisma.agent.findUnique({
          where: { id: agentId },
          include: {
            skills: { include: { skill: true } },
            mcpConnections: { include: { mcpConnection: true } },
          },
        });

        const teamsMcps = (agentWithMcp?.mcpConnections ?? [])
          .filter((link) => link.mcpConnection.type === 'teams_recorder');

        if (teamsMcps.length > 0) {
          sendLog(`Agent has ${teamsMcps.length} Teams Recorder MCP(s) connected...`);

          for (const link of teamsMcps.slice(0, 1)) {
            const conn = link.mcpConnection;
            const mcpPath = conn.baseUrl;
            if (!mcpPath) continue;

            let mcpCredential: string | null = null;
            if (conn.encryptedCredential && conn.credentialIv && conn.credentialTag) {
              const { decryptToken } = await import('../lib/crypto.js');
              mcpCredential = decryptToken(conn.encryptedCredential, conn.credentialIv, conn.credentialTag);
            }

            const mcpEnv: Record<string, string> = {};
            if (mcpCredential) mcpEnv.GITHUB_TOKEN = mcpCredential;

            const { callMcpTool } = await import('../lib/mcp-client.js');

            try {
              const requestedRecordingId = (req.body as { recordingId?: string }).recordingId;

              let recordingId = requestedRecordingId;

              if (!recordingId) {
                sendLog('Fetching available Teams recordings...');
                const listResult = await callMcpTool('node', [mcpPath], mcpEnv, 'list_recordings', {});
                const listText = listResult.content.find(c => c.type === 'text')?.text ?? '[]';
                let recordings: Array<{ id: string; title?: string; processedAt?: string }> = [];
                try { recordings = JSON.parse(listText); } catch { recordings = []; }

                if (recordings.length > 0) {
                  const mostRecent = recordings.sort((a, b) =>
                    new Date(b.processedAt ?? 0).getTime() - new Date(a.processedAt ?? 0).getTime()
                  )[0];
                  recordingId = mostRecent.id;
                  sendLog(`Found ${recordings.length} recording(s) — using most recent: ${mostRecent.title ?? recordingId}`);
                } else {
                  sendLog('No recordings found in cache');
                }
              }

              if (recordingId) {
                const wiType = (workItemType ?? '').toLowerCase();
                let summarizerTool = 'summarize_for_user_story';
                if (wiType.includes('bug')) summarizerTool = 'summarize_for_bug_report';
                else if (wiType.includes('doc')) summarizerTool = 'summarize_for_documentation';

                sendLog('Loading full meeting transcript...');
                // Fetch the transcript, structured summary, and screenshot analysis in parallel
                const [transcriptResult, summaryResult, recordingAnalysisResult] = await Promise.all([
                  callMcpTool('node', [mcpPath], mcpEnv, 'get_full_transcript', { recording_id: recordingId }),
                  callMcpTool('node', [mcpPath], mcpEnv, summarizerTool, { recording_id: recordingId }),
                  callMcpTool('node', [mcpPath], mcpEnv, 'get_recording_analysis', { recording_id: recordingId }),
                ]);

                const transcriptText = transcriptResult.content.find(c => c.type === 'text')?.text ?? '';
                const summaryText = summaryResult.content.find(c => c.type === 'text')?.text ?? '';
                const recordingAnalysisText = recordingAnalysisResult.content.find(c => c.type === 'text')?.text ?? '';

                let transcriptData: Record<string, unknown> | null = null;
                let summaryData: Record<string, unknown> | null = null;
                let recordingAnalysisData: Record<string, unknown> | null = null;
                try { transcriptData = JSON.parse(transcriptText); } catch { /* keep null */ }
                try { summaryData = JSON.parse(summaryText); } catch { /* keep null */ }
                try { recordingAnalysisData = JSON.parse(recordingAnalysisText); } catch { /* keep null */ }

                if (transcriptData || summaryData) {
                  const lines: string[] = [
                    '## ⚠️  TEAMS MEETING RECORDING — USE THIS AS THE SOLE BASIS FOR THE WORK ITEM',
                    '',
                    'CRITICAL INSTRUCTIONS:',
                    '- Base the work item ENTIRELY on the meeting content below.',
                    '- IGNORE any folder paths or file paths in the user\'s message — those are just pointers to the recording.',
                    '- Generate a DETAILED, RICHLY FORMATTED description (use Markdown: headings, bullet lists, tables, code blocks).',
                    '- Describe: Kontext (meeting date/topic), Ist-Zustand (current state), Soll-Zustand (desired state), and Implementierungshinweise (implementation notes) if applicable.',
                    '- If the transcript mentions specific technical items (actions, fields, groups, AL objects), list them explicitly in tables or code blocks.',
                    '',
                  ];

                  // Recording metadata
                  const recTitle = (transcriptData?.title ?? summaryData?.title ?? '') as string;
                  const duration = (transcriptData?.duration ?? '') as string;
                  if (recTitle) lines.push(`**Recording:** ${recTitle}${duration ? ` (${duration})` : ''}`);

                  // Human-readable bullet summary from transcript
                  const hrSummary = (transcriptData as any)?.humanReadableSummary as string | undefined;
                  if (hrSummary) {
                    lines.push('', '### Themen laut Meeting (Bullet-Zusammenfassung)', hrSummary);
                  }

                  // Full timestamped transcript for deep analysis
                  const fullText = (transcriptData as any)?.fullTranscriptText as string | undefined;
                  if (fullText) {
                    lines.push('', '### Vollständiges Transkript', '```', fullText, '```');
                  }

                  // Structured summary fields
                  if (summaryData) {
                    if (summaryData.iWant) lines.push('', `**Kernwunsch (I want):** ${summaryData.iWant}`);
                    if (summaryData.soThat) lines.push(`**Ziel (So that):** ${summaryData.soThat}`);
                    if (Array.isArray(summaryData.acceptanceCriteria) && (summaryData.acceptanceCriteria as unknown[]).length > 0) {
                      lines.push('', '**Akzeptanzkriterien aus Meeting:**');
                      (summaryData.acceptanceCriteria as string[]).forEach(ac => lines.push(`- ${ac}`));
                    }
                    if (Array.isArray(summaryData.tags)) {
                      lines.push('', `**Tags:** ${(summaryData.tags as string[]).join(', ')}`);
                    }
                  }

                  const screenshots = Array.isArray(recordingAnalysisData?.screenshots)
                    ? (recordingAnalysisData.screenshots as Array<Record<string, unknown>>)
                    : [];
                  const existingScreenshotPaths: string[] = [];
                  for (const screenshot of screenshots) {
                    const screenshotPath = typeof screenshot.filePath === 'string' ? screenshot.filePath : '';
                    if (!screenshotPath || !existsSync(screenshotPath)) continue;
                    const placeholderIndex = existingScreenshotPaths.length;
                    existingScreenshotPaths.push(screenshotPath);
                    const rawTimestamp = typeof screenshot.timestamp === 'number'
                      ? screenshot.timestamp
                      : Number(screenshot.timestamp);
                    const timestampLabel = Number.isFinite(rawTimestamp) ? `${rawTimestamp}s` : 'unknown';

                    if (placeholderIndex === 0) lines.push('', '### Screenshots');
                    lines.push(`- Screenshot at timestamp ${timestampLabel}: SCREENSHOT_PLACEHOLDER_${placeholderIndex} (filePath: ${screenshotPath.replace(/\\/g, '/')})`);
                  }

                  screenshotPaths = existingScreenshotPaths;
                  mcpContext = lines.join('\n');
                  sendLog(`Full meeting transcript + summary loaded ✓${existingScreenshotPaths.length > 0 ? ` (${existingScreenshotPaths.length} screenshot${existingScreenshotPaths.length === 1 ? '' : 's'})` : ''}`);
                }
              }
            } catch (mcpErr) {
              sendLog(`Teams MCP unavailable: ${mcpErr instanceof Error ? mcpErr.message : 'unknown'}`);
              mcpContext = '## Note\nThe Teams Recording MCP was unavailable. Do NOT create a work item about recording, transcription, or audio processing features. Instead, use the user\'s message as a plain feature/bug description and generate a work item based on the actual intent.';
            }
          }
        }
      }

      const includeTechnicalSpec = /(technical\s+spec|technische|specification)/i.test(trimmedDescription);
      const systemContent = [
        agentSystemPrompt?.trim() || 'You are a helpful work item writer.',
        selectedSkillPrompts,
        adoContext,
        repoContext,
        mcpContext,
        includeTechnicalSpec
          ? 'The user requested a technical specification. Fill the technicalSpec field with a concise, implementation-oriented technical specification based on the repository context when possible.'
          : 'Only populate the technicalSpec field when the user explicitly asks for a technical specification; otherwise return an empty string.',
        `Your task is to generate a work item. The user's message is an INSTRUCTION to you — it tells you what kind of work item to create, possibly referencing a recording or file for context. Do NOT create a work item whose subject IS the user's instruction. Do NOT create a work item about file management, audio recordings, or transcription unless that is explicitly the meeting topic.
${mcpContext ? `
A Teams Meeting Recording context is provided above. You MUST:
1. Base the work item ENTIRELY on the meeting content — ignore folder paths in the user message
2. Generate a DETAILED, RICHLY FORMATTED Markdown description like a professional Azure DevOps work item:
   - **Kontext**: 1-2 sentences about the meeting (date, topic, project)
   - **Ist-Zustand**: Current state — if the transcript mentions specific items (actions, fields, UI elements, AL objects), list them in a Markdown table
   - **Soll-Zustand**: Desired state — what was discussed as the target, again with tables if multiple items
   - **Implementierungshinweise**: If AL code structure is mentioned, include a code block with the suggested structure
   - **Hinweise**: Important notes, constraints, things to preserve
3. Acceptance criteria must be a bulleted list matching the meeting discussion points exactly
4. If screenshots are listed above, include them in the description using the placeholder exactly as written: \`![Screenshot – Ist-Zustand (10s)](SCREENSHOT_PLACEHOLDER_0)\`. The placeholders will be replaced with real URLs after upload.
` : ''}
IMPORTANT: Follow the language and style instructions above exactly. Write ALL text fields in the same language as the agent system prompt specifies (default German).
Return ONLY valid JSON with these fields:
{
  "title": "concise title in target language",
  "description": "rich Markdown description with sections, tables, and code blocks where relevant",
  "acceptanceCriteria": "bulleted Markdown list of acceptance criteria",
  "technicalSpec": "optional AL/technical spec based on repo context and meeting, or empty string",
  "type": "${workItemType ?? 'User Story'}",
  "priority": 2,
  "tags": "semicolon-separated tags",
  "areaPath": "best matching Azure DevOps area path or empty string"
}
Prefer one of the provided work item types and area paths when context is available.`,
      ].filter(Boolean).join('\n\n');

      const generated = await fetchModelJson<Record<string, unknown>>(
        token,
        model,
        [
          { role: 'system', content: systemContent },
          { role: 'user', content: trimmedDescription },
        ]
      );

      sendEvent('result', { ...generated, screenshotPaths });
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
