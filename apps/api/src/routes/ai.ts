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
}
