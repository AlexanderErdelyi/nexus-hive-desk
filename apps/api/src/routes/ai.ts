import { createProvider } from '@nexus/ai';
import { prisma } from '@nexus/db';
import type { AIProviderType, TranslationState } from '@nexus/types';
import type { FastifyInstance } from 'fastify';

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
    where: { projectId, sourceLanguage: project.sourceLanguage, targetLanguage: project.targetLanguage },
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
      sourceLanguage: project.sourceLanguage,
      targetLanguage: project.targetLanguage,
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
        where: { projectId, sourceLanguage: project.sourceLanguage, targetLanguage: project.targetLanguage },
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
          sourceLanguage: project.sourceLanguage,
          targetLanguage: project.targetLanguage,
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

  // ─── Generative AI: generate Agent / Skill / MCP config from description ─────
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
      agent: `You are an AI agent designer. Given a plain-text description of what an AI agent should do, generate a complete agent configuration as JSON.
Return ONLY valid JSON with these fields:
{
  "name": "short descriptive name",
  "description": "one-line description of what the agent does",
  "modelProvider": "github-models" | "openai" | "azure-openai" | "ollama",
  "triggerType": "manual" | "scheduled" | "event-driven",
  "systemPrompt": "detailed system prompt that instructs the agent how to behave",
  "suggestedSkills": ["skill name 1", "skill name 2"]
}
Choose modelProvider based on context (default: github-models).
Write a thorough, professional systemPrompt that would actually make this agent work well.`,

      skill: `You are an AI skill designer. Given a plain-text description of a skill, generate a skill configuration as JSON.
Return ONLY valid JSON with these fields:
{
  "name": "short skill name (PascalCase or Title Case)",
  "description": "one-line description",
  "type": "prompt" | "code" | "mcp-tool",
  "promptTemplate": "the prompt template with {{variable}} placeholders (only for prompt type, otherwise empty string)"
}
For prompt skills: write a clear, professional prompt template with appropriate {{variable}} placeholders.
For code/mcp-tool types, leave promptTemplate as an empty string.`,

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
  "description": "detailed HTML description (use <h3>, <p>, <ul> tags) explaining the work, context and goals",
  "acceptanceCriteria": "HTML acceptance criteria using a bulleted list (<ul><li>Given...When...Then...</li></ul> format for user stories)",
  "type": "${workItemType ?? 'User Story'}",
  "priority": 2,
  "tags": "comma-separated relevant tags or empty string"
}
Write professional, clear, testable content. Use proper BDD-style acceptance criteria for User Stories. For Bugs, focus on repro steps and expected vs actual behavior.`,
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
}
