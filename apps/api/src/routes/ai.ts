import { createProvider } from '@nexus/ai';
import { prisma } from '@nexus/db';
import type { AIProviderType, TranslationState } from '@nexus/types';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../lib/auth';

const BATCH_SIZE = 20;
const REVIEW_BATCH_SIZE = 10;

async function translateTranslations(options: {
  translationIds: string[];
  projectId: string;
  providerType?: AIProviderType;
  model?: string;
  dryRun?: boolean;
}) {
  const { translationIds, projectId, providerType, model, dryRun = false } = options;

  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('AI provider token not configured');

  const translations = await prisma.translation.findMany({
    where: { id: { in: translationIds } },
    orderBy: { unitId: 'asc' },
  });
  if (!translations.length) return { suggestions: [], translated: 0 };

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Error('Project not found');

  const glossaryEntries = await prisma.glossaryEntry.findMany({
    where: { projectId, sourceLanguage: project.sourceLanguage ?? undefined, targetLanguage: project.targetLanguage ?? undefined },
  });
  const glossary = glossaryEntries.map((e) => ({ sourceTerm: e.sourceTerm, targetTerm: e.targetTerm }));

  const provider = createProvider({
    type: providerType ?? (process.env.AI_PROVIDER as AIProviderType) ?? 'github-models',
    token,
    model: model ?? process.env.AI_MODEL,
  });

  const allResults: Array<{ id: string; suggestedTarget: string }> = [];

  for (let i = 0; i < translations.length; i += BATCH_SIZE) {
    const batch = translations.slice(i, i + BATCH_SIZE);
    const response = await provider.translate({
      units: batch.map((t) => ({ id: t.id, source: t.source })),
      sourceLanguage: project.sourceLanguage ?? 'en',
      targetLanguage: project.targetLanguage ?? 'de',
      glossary,
    });
    allResults.push(...response.results.map((r) => ({ id: r.id, suggestedTarget: r.translatedText })));
  }

  if (dryRun) {
    return { suggestions: allResults, translated: allResults.length };
  }

  await prisma.$transaction(
    allResults.map((r) =>
      prisma.translation.update({
        where: { id: r.id },
        data: { target: r.suggestedTarget, state: 'translated' as TranslationState, updatedAt: new Date() },
      })
    )
  );

  return { suggestions: allResults, translated: allResults.length };
}


export async function aiRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireAuth(app));
  app.post<{
    Body: { translationIds: string[]; projectId: string; provider?: AIProviderType; model?: string };
  }>('/translate', async (req, reply) => {
    const { translationIds, projectId, provider, model } = req.body;
    if (!translationIds?.length || !projectId) {
      return reply.status(400).send({ error: 'validation', message: 'translationIds and projectId are required' });
    }
    try {
      const result = await translateTranslations({ translationIds, projectId, providerType: provider, model, dryRun: true });
      if (!result.suggestions.length) {
        return reply.status(404).send({ error: 'not_found', message: 'No translations found' });
      }
      return { data: result.suggestions, meta: { translated: result.translated } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: 'ai_error', message });
    }
  });

  app.post<{
    Body: { xliffFileId: string; projectId: string; provider?: AIProviderType; model?: string };
  }>('/translate-file', async (req, reply) => {
    const { xliffFileId, projectId, provider, model } = req.body;
    if (!xliffFileId || !projectId) {
      return reply.status(400).send({ error: 'validation', message: 'xliffFileId and projectId are required' });
    }
    const untranslated = await prisma.translation.findMany({
      where: { xliffFileId, OR: [{ state: 'new' }, { state: 'needs-translation' }, { target: '' }] },
      select: { id: true },
      orderBy: { unitId: 'asc' },
    });
    if (!untranslated.length) return { data: [], meta: { translated: 0, message: 'Nothing to translate' } };
    try {
      const result = await translateTranslations({
        translationIds: untranslated.map((t) => t.id),
        projectId,
        providerType: provider,
        model,
        dryRun: false,
      });
      return { data: result.suggestions, meta: { translated: result.translated } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: 'ai_error', message });
    }
  });

  // ÔöÇÔöÇÔöÇ SSE streaming bulk translate ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  // Streams translation suggestions in batches; client collects them all and
  // calls PATCH /translations/bulk when ready to save.
  app.post<{
    Body: {
      projectId: string;
      xliffFileId?: string;
      translationIds?: string[];
      provider?: AIProviderType;
      model?: string;
    };
  }>('/translate-stream', async (req, reply) => {
    const { projectId, xliffFileId, translationIds, provider, model } = req.body;
    if (!projectId) {
      return reply.status(400).send({ error: 'validation', message: 'projectId is required' });
    }

    const token = process.env.GITHUB_TOKEN;
    if (!token) return reply.status(500).send({ error: 'config', message: 'AI provider token not configured' });

    // Resolve the list of IDs to translate
    let ids: string[];
    if (translationIds?.length) {
      ids = translationIds;
    } else if (xliffFileId) {
      const rows = await prisma.translation.findMany({
        where: { xliffFileId, OR: [{ state: 'new' }, { state: 'needs-translation' }, { target: '' }] },
        select: { id: true },
        orderBy: { unitId: 'asc' },
      });
      ids = rows.map((r) => r.id);
    } else {
      return reply.status(400).send({ error: 'validation', message: 'xliffFileId or translationIds required' });
    }

    if (!ids.length) {
      reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      reply.raw.write(`data: ${JSON.stringify({ type: 'complete', done: 0, total: 0 })}\n\n`);
      reply.raw.end();
      return;
    }

    const translations = await prisma.translation.findMany({
      where: { id: { in: ids } },
      orderBy: { unitId: 'asc' },
    });
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return reply.status(404).send({ error: 'not_found', message: 'Project not found' });

    const glossaryEntries = await prisma.glossaryEntry.findMany({
      where: { projectId, sourceLanguage: project.sourceLanguage ?? undefined, targetLanguage: project.targetLanguage ?? undefined },
    });
    const glossary = glossaryEntries.map((e) => ({ sourceTerm: e.sourceTerm, targetTerm: e.targetTerm }));

    const providerInstance = createProvider({
      type: provider ?? (process.env.AI_PROVIDER as AIProviderType) ?? 'github-models',
      token,
      model: model ?? process.env.AI_MODEL,
    });

    const total = translations.length;
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    reply.raw.write(`data: ${JSON.stringify({ type: 'start', total })}\n\n`);

    let done = 0;
    try {
      for (let i = 0; i < translations.length; i += BATCH_SIZE) {
        const batch = translations.slice(i, i + BATCH_SIZE);
        const response = await providerInstance.translate({
          units: batch.map((t) => ({ id: t.id, source: t.source })),
          sourceLanguage: project.sourceLanguage ?? 'en',
          targetLanguage: project.targetLanguage ?? 'de',
          glossary,
        });
        done += batch.length;
        const results = response.results.map((r) => ({
          id: r.id,
          suggestedTarget: r.translatedText,
          confidenceScore: r.confidenceScore ?? 85,
          confidence: r.confidence ?? 'high',
        }));
        reply.raw.write(`data: ${JSON.stringify({ type: 'progress', done, total, results })}\n\n`);
      }
      reply.raw.write(`data: ${JSON.stringify({ type: 'complete', done, total })}\n\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
    }
    reply.raw.end();
  });

  app.post<{
    Body: {
      translationIds: string[];
      projectId: string;
      additionalContext?: string;
      provider?: AIProviderType;
      model?: string;
    };
  }>('/review', async (req, reply) => {
    const { translationIds, projectId, additionalContext, provider, model } = req.body;
    if (!translationIds?.length || !projectId) {
      return reply.status(400).send({ error: 'validation', message: 'translationIds and projectId are required' });
    }

    const token = process.env.GITHUB_TOKEN;
    if (!token) return reply.status(500).send({ error: 'config', message: 'AI provider token not configured' });

    try {
      const translations = await prisma.translation.findMany({
        where: { id: { in: translationIds } },
        orderBy: { unitId: 'asc' },
      });
      const project = await prisma.project.findUnique({ where: { id: projectId } });
      if (!project) return reply.status(404).send({ error: 'not_found', message: 'Project not found' });

      const glossaryEntries = await prisma.glossaryEntry.findMany({
        where: { projectId, sourceLanguage: project.sourceLanguage ?? undefined, targetLanguage: project.targetLanguage ?? undefined },
      });
      const glossary = glossaryEntries.map((e) => ({ sourceTerm: e.sourceTerm, targetTerm: e.targetTerm }));

      const providerInstance = createProvider({
        type: provider ?? (process.env.AI_PROVIDER as AIProviderType) ?? 'github-models',
        token,
        model: model ?? process.env.AI_MODEL,
      });

      const allResults: Array<{ id: string; quality: string; suggestion?: string; reason?: string }> = [];
      for (let i = 0; i < translations.length; i += REVIEW_BATCH_SIZE) {
        const batch = translations.slice(i, i + REVIEW_BATCH_SIZE);
        const response = await providerInstance.review({
          units: batch.map((t) => ({
            id: t.id,
            source: t.source,
            target: t.target,
            context: t.note ?? undefined,
          })),
          sourceLanguage: project.sourceLanguage ?? 'en',
          targetLanguage: project.targetLanguage ?? 'de',
          glossary,
          additionalContext,
        });
        allResults.push(...response.results);
      }

      const good = allResults.filter((r) => r.quality === 'good').length;
      const warnings = allResults.filter((r) => r.quality === 'warning').length;
      const errors = allResults.filter((r) => r.quality === 'error').length;

      return { data: allResults, meta: { total: allResults.length, good, warnings, errors } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: 'ai_error', message });
    }
  });

  // ÔöÇÔöÇÔöÇ Generative AI: generate Agent / Skill / MCP config from description ÔöÇÔöÇÔöÇÔöÇÔöÇ
  app.post<{
    Body: { type: 'agent' | 'skill' | 'mcp' | 'work-item'; description: string; workItemType?: string };
  }>('/generate', async (req, reply) => {
    const { type, description, workItemType } = req.body;
    if (!type || !description?.trim()) {
      return reply.status(400).send({ error: 'validation', message: 'type and description are required' });
    }

    const token = process.env.GITHUB_TOKEN;
    if (!token) return reply.status(500).send({ error: 'config', message: 'AI provider token not configured' });

    const baseURL = 'https://models.inference.ai.azure.com';
    const model = process.env.AI_MODEL ?? 'gpt-4o-mini';

    const systemPrompts: Record<string, string> = {
      agent: `You are an AI agent designer for the GitHub Copilot / NexusHiveDesk platform. Given a plain-text description of what an agent should do, generate a complete agent configuration in JSON format matching the VS Code Copilot agent spec.

Return ONLY valid JSON with these fields:
{
  "name": "PascalCase or Title Case name, concise (e.g. 'TranslationOrchestrator', 'WorkItemWriter')",
  "description": "Multi-sentence 'when to use' description with concrete trigger phrases separated by commas. Start with 'Use when:' then list 6-12 trigger phrases that a user might say, followed by '. ' and a one-sentence summary of what the agent does and what it reads/delegates to.",
  "modelProvider": "github-models",
  "model": "gpt-4o",
  "triggerType": "manual",
  "argumentHint": "Short hint about what argument/input this agent expects, e.g. 'Feature WI ID or description' or 'XLIFF file path or translation unit ID'",
  "tools": ["list", "of", "tool", "categories", "this", "agent", "needs"],
  "systemPrompt": "Detailed, professional system prompt. Must include: role definition, responsibilities, constraints (what it MUST and MUST NEVER do), step-by-step approach, and output format. Use markdown headers (##) and bullet points. At least 300 words."
}

For tools, choose from: ["read", "search", "edit", "execute", "azure-devops", "azure-mcp", "github", "mcp", "todo"]
For model: use "gpt-4o" for complex orchestration, "gpt-4o-mini" for simple tasks, "claude-sonnet-4-6" for writing/analysis.
For description: follow this exact pattern from the example:
  "Use when: <trigger phrase 1>, <trigger phrase 2>, ..., <trigger phrase N>. <One sentence about what the agent coordinates/does and what spec/skill it reads first>."

Write a thorough, professional systemPrompt with clear constraints, step-by-step approach, and output format ÔÇö similar to production-quality agent definitions.`,

      skill: `You are an AI skill designer for the GitHub Copilot / NexusHiveDesk platform. Given a plain-text description of a skill, generate a skill configuration as JSON matching the VS Code Copilot skill spec.

Return ONLY valid JSON with these fields:
{
  "name": "PascalCase or Title Case name (e.g. 'TranslateXliff', 'ReviewTranslation', 'CreateUserStory')",
  "description": "Multi-sentence description. Start with 'Use when:' then list 4-8 trigger phrases, followed by '. ' and what the skill does step by step.",
  "type": "prompt",
  "promptTemplate": "The full prompt template. Use {{variable_name}} placeholders for dynamic values. Must be detailed and production-quality ÔÇö include role, task, input format, output format, and any constraints. At least 150 words for non-trivial skills."
}
For type: use 'prompt' for LLM-based skills, 'code' for scripted logic, 'mcp-tool' for MCP protocol tools.
For promptTemplate: write a thorough template that actually makes the skill work ÔÇö include clear instructions, output format, and examples where helpful. Use {{variable}} syntax for all dynamic inputs.`,

      mcp: `You are an MCP (Model Context Protocol) connection designer. Given a description of what service to connect to, generate an MCP connection config as JSON.
Return ONLY valid JSON with these fields:
{
  "name": "friendly display name",
  "type": "wiki_js" | "azure_devops_wiki" | "github" | "azure_devops" | "custom",
  "baseUrl": "expected base URL pattern (use placeholder like https://your-domain.com if not specified)",
  "authType": "pat" | "oauth" | "api_key",
  "description": "one-line description of what this connection is for"
}
Infer type from the description. If unclear, use "custom".`,

      'work-item': `You are a professional agile work item writer specializing in Azure DevOps. Given a plain-text description of what the user wants to build or fix, generate a complete work item as JSON.
Return ONLY valid JSON with these fields:
{
  "title": "concise, action-oriented title (max 100 chars)",
  "description": "detailed plain-text or markdown description (no HTML tags) explaining the work, context and goals",
  "acceptanceCriteria": "plain-text or markdown acceptance criteria (BDD Given/When/Then format for user stories, repro steps for bugs)",
  "type": "${workItemType ?? 'User Story'}",
  "priority": 2,
  "tags": "comma-separated relevant tags or empty string"
}
Write professional, clear, testable content. Respond in the same language as the user's input. Do NOT use HTML tags ÔÇö use plain text or markdown only.`,
    };

    try {
      const response = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompts[type] },
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

  // ÔöÇÔöÇÔöÇ Quick suggest ÔÇö lightweight single-turn AI call ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  app.post<{ Body: { prompt: string } }>('/quick-suggest', async (req, reply) => {
    const { prompt } = req.body;
    if (!prompt?.trim()) {
      return reply.status(400).send({ error: 'validation', message: 'prompt is required' });
    }
    const token = process.env.GITHUB_TOKEN;
    if (!token) return reply.status(500).send({ error: 'config', message: 'AI provider token not configured' });

    try {
      const response = await fetch('https://models.inference.ai.azure.com/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: process.env.AI_MODEL ?? 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'You are a helpful assistant. Respond only with valid JSON.' },
            { role: 'user', content: prompt.trim() },
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
      return { data: JSON.parse(content) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: 'ai_error', message });
    }
  });

  // ÔöÇÔöÇÔöÇ PR code review ÔÇö analyze diff and return suggestions ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  app.post<{
    Body: {
      prTitle: string;
      prDescription?: string;
      files: Array<{ path: string; changeType?: string; patch?: string; additions?: number; deletions?: number }>;
    };
  }>('/pr-review', async (req, reply) => {
    const { prTitle, prDescription, files } = req.body;
    if (!files?.length) {
      return reply.status(400).send({ error: 'validation', message: 'files is required' });
    }
    const token = process.env.GITHUB_TOKEN;
    if (!token) return reply.status(500).send({ error: 'config', message: 'AI provider token not configured' });

    const diffSummary = files
      .slice(0, 20)
      .map((f) => {
        const lines = [`--- File: ${f.path} (${f.changeType ?? 'modified'})`];
        if (f.patch) lines.push(f.patch.slice(0, 2000));
        else if (f.additions !== undefined) lines.push(`+${f.additions} additions, -${f.deletions ?? 0} deletions`);
        return lines.join('\n');
      })
      .join('\n\n');

    const prompt = `You are an expert code reviewer. Analyze the following pull request diff and provide specific, actionable review suggestions.

PR Title: ${prTitle}
${prDescription ? `PR Description: ${prDescription}\n` : ''}
Changed files (${files.length} total, showing ${Math.min(files.length, 20)}):
${diffSummary}

Return a JSON object with this structure:
{
  "suggestions": [
    {
      "file": "path/to/file",
      "line": null,
      "severity": "info" | "warning" | "error",
      "comment": "concise actionable comment",
      "codeSnippet": "1-4 lines of the problematic code quoted verbatim from the diff, or null",
      "suggestion": "1-4 lines showing how the code should be changed, or null if no code fix needed"
    }
  ],
  "summary": "1-2 sentence overall review summary"
}

Focus on: bugs, security issues, performance problems, missing error handling, and code quality. Skip style comments. Limit to the 8 most important suggestions. Include codeSnippet whenever you are referencing a specific piece of code. Include suggestion when you can propose a concrete code fix.`;

    try {
      const response = await fetch('https://models.inference.ai.azure.com/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: process.env.AI_MODEL ?? 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'You are a code review assistant. Respond only with valid JSON.' },
            { role: 'user', content: prompt },
          ],
          temperature: 0.3,
          response_format: { type: 'json_object' },
          max_tokens: 3000,
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        return reply.status(502).send({ error: 'ai_error', message: `AI API error: ${text}` });
      }

      const aiResponse = await response.json() as { choices: Array<{ message: { content: string } }> };
      const content = aiResponse.choices?.[0]?.message?.content ?? '{}';
      const parsed = JSON.parse(content) as { suggestions?: unknown[]; summary?: string };
      return { data: { suggestions: parsed.suggestions ?? [], summary: parsed.summary ?? '' } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: 'ai_error', message });
    }
  });

  // ─── Dashboard AI insights ──────────────────────────────────────────────────
  app.post<{
    Body: {
      projects: Array<{
        name: string;
        capabilities: string;
        openPrs: number;
        translationPct: number | null;
        alReviewed: number;
        recentActivity: number;
      }>;
      /** DevOps events from connected repos (PRs, work items) */
      devopsEvents?: Array<{
        type: string;
        projectName: string;
        label: string;
        detail: string | null;
      }>;
    };
  }>('/dashboard-insights', async (req, reply) => {
    const { projects, devopsEvents } = req.body;
    if (!projects?.length) return reply.status(400).send({ error: 'validation', message: 'projects is required' });

    const token = process.env.GITHUB_TOKEN;
    if (!token) return reply.status(500).send({ error: 'config', message: 'AI provider token not configured' });

    const projectSummary = projects.map((p) => {
      const parts = [`Project "${p.name}":`];
      if (p.openPrs > 0) parts.push(`${p.openPrs} open PR${p.openPrs !== 1 ? 's' : ''} awaiting review`);
      if (p.translationPct !== null) parts.push(`translation ${p.translationPct}% complete`);
      if (p.alReviewed > 0) parts.push(`${p.alReviewed} AL health issues reviewed`);
      if (p.recentActivity > 0) parts.push(`${p.recentActivity} recent change${p.recentActivity !== 1 ? 's' : ''} in last 7 days`);
      const caps = p.capabilities.split(',').map((c) => c.trim()).filter(Boolean);
      parts.push(`capabilities: ${caps.join(', ')}`);
      return parts.join(', ');
    }).join('\n');

    // Build devops context section
    let devopsSection = '';
    if (devopsEvents && devopsEvents.length > 0) {
      const reviewRequested = devopsEvents.filter((e) => e.type === 'pr_review_requested');
      const myPrs = devopsEvents.filter((e) => e.type === 'pr_created');
      const approvedPrs = devopsEvents.filter((e) => e.type === 'pr_approved');
      const rejectedPrs = devopsEvents.filter((e) => e.type === 'pr_rejected');
      const workItems = devopsEvents.filter((e) => e.type === 'work_item_assigned');
      const issues = devopsEvents.filter((e) => e.type === 'issue_assigned');

      const lines: string[] = ['\nDevOps activity for the current user:'];
      if (reviewRequested.length) lines.push(`- ${reviewRequested.length} PR(s) waiting for my review: ${reviewRequested.slice(0, 3).map((e) => `"${e.label}"`).join(', ')}`);
      if (myPrs.length) lines.push(`- ${myPrs.length} of my PR(s) are open and awaiting merge`);
      if (approvedPrs.length) lines.push(`- ${approvedPrs.length} of my PR(s) were approved — ready to merge`);
      if (rejectedPrs.length) lines.push(`- ${rejectedPrs.length} of my PR(s) were rejected — need attention`);
      if (workItems.length) lines.push(`- ${workItems.length} work item(s) assigned to me recently changed: ${workItems.slice(0, 3).map((e) => `"${e.label}" (${e.detail ?? ''})`).join(', ')}`);
      if (issues.length) lines.push(`- ${issues.length} GitHub issue(s) assigned to me`);
      devopsSection = lines.join('\n');
    }

    const prompt = `You are a software project manager assistant. Based on the following project status and DevOps activity, provide 3-5 prioritized action items for today.

${projectSummary}
${devopsSection}

Return a JSON object:
{
  "insights": [
    {
      "priority": "high" | "medium" | "low",
      "projectName": "exact project name or null if cross-project",
      "action": "short imperative sentence (max 12 words)",
      "reason": "1 sentence explaining why this matters now"
    }
  ],
  "summary": "1 sentence overall status assessment"
}

Prioritize: PRs waiting for my review (high urgency), rejected PRs (high), approved PRs ready to merge (medium), assigned work items, translations below 70%, stale work. Order by urgency.`;

    try {
      const response = await fetch('https://models.inference.ai.azure.com/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: process.env.AI_MODEL ?? 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'You are a project management assistant. Respond only with valid JSON.' },
            { role: 'user', content: prompt },
          ],
          temperature: 0.4,
          response_format: { type: 'json_object' },
          max_tokens: 800,
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        return reply.status(502).send({ error: 'ai_error', message: `AI API error: ${text}` });
      }

      const aiResponse = await response.json() as { choices: Array<{ message: { content: string } }> };
      const content = aiResponse.choices?.[0]?.message?.content ?? '{}';
      const parsed = JSON.parse(content) as { insights?: unknown[]; summary?: string };
      return { data: { insights: parsed.insights ?? [], summary: parsed.summary ?? '' } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: 'ai_error', message });
    }
  });
}
