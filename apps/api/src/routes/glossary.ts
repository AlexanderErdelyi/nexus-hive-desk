import { createProvider } from '@nexus/ai';
import { prisma } from '@nexus/db';
import type { AIProviderType } from '@nexus/types';
import type { FastifyInstance } from 'fastify';

export async function glossaryRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { projectId: string; search?: string } }>('/', async (req, reply) => {
    const { projectId, search } = req.query;
    if (!projectId) {
      return reply.status(400).send({ error: 'validation', message: 'projectId is required' });
    }

    const entries = await prisma.glossaryEntry.findMany({
      where: {
        projectId,
        ...(search
          ? {
              OR: [
                { sourceTerm: { contains: search } },
                { targetTerm: { contains: search } },
              ],
            }
          : {}),
      },
      orderBy: { sourceTerm: 'asc' },
    });

    return { data: entries };
  });

  app.post<{
    Body: {
      projectId: string;
      sourceTerm: string;
      targetTerm: string;
      sourceLanguage: string;
      targetLanguage: string;
      description?: string;
      caseSensitive?: boolean;
    };
  }>('/', async (req, reply) => {
    const { projectId, sourceTerm, targetTerm, sourceLanguage, targetLanguage, description, caseSensitive } = req.body;
    if (!projectId || !sourceTerm || !targetTerm) {
      return reply.status(400).send({ error: 'validation', message: 'projectId, sourceTerm, targetTerm required' });
    }

    const entry = await prisma.glossaryEntry.create({
      data: {
        projectId,
        sourceTerm,
        targetTerm,
        sourceLanguage: sourceLanguage ?? 'en',
        targetLanguage: targetLanguage ?? 'de',
        description,
        caseSensitive: caseSensitive ?? false,
      },
    });

    return reply.status(201).send({ data: entry });
  });

  app.patch<{
    Params: { id: string };
    Body: { sourceTerm?: string; targetTerm?: string; description?: string };
  }>('/:id', async (req) => {
    const entry = await prisma.glossaryEntry.update({
      where: { id: req.params.id },
      data: req.body,
    });

    return { data: entry };
  });

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    await prisma.glossaryEntry.delete({ where: { id: req.params.id } });
    return reply.status(204).send();
  });

  app.post<{
    Body: {
      projectId: string;
      entries: Array<{ sourceTerm: string; targetTerm: string; description?: string }>;
      sourceLanguage: string;
      targetLanguage: string;
    };
  }>('/import', async (req, reply) => {
    const { projectId, entries, sourceLanguage = 'en', targetLanguage = 'de' } = req.body;
    if (!projectId || !Array.isArray(entries)) {
      return reply.status(400).send({ error: 'validation', message: 'projectId and entries array required' });
    }

    const created = await prisma.$transaction(
      entries.map((entry) =>
        prisma.glossaryEntry.upsert({
          where: {
            projectId_sourceTerm_sourceLanguage_targetLanguage: {
              projectId,
              sourceTerm: entry.sourceTerm,
              sourceLanguage,
              targetLanguage,
            },
          },
          update: { targetTerm: entry.targetTerm, description: entry.description },
          create: {
            projectId,
            sourceTerm: entry.sourceTerm,
            targetTerm: entry.targetTerm,
            sourceLanguage,
            targetLanguage,
            description: entry.description,
          },
        })
      )
    );

    return reply.status(201).send({ data: created, meta: { imported: created.length } });
  });

  /** AI: Analyze XLIFF translations and suggest BC glossary terms */
  app.post<{
    Body: {
      projectId: string;
      xliffFileId?: string;
      provider?: AIProviderType;
      model?: string;
    };
  }>('/ai-generate', async (req, reply) => {
    const { projectId, xliffFileId, provider, model } = req.body;
    if (!projectId) return reply.status(400).send({ error: 'validation', message: 'projectId required' });

    const token = process.env.GITHUB_TOKEN;
    if (!token) return reply.status(500).send({ error: 'config', message: 'AI token not configured' });

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return reply.status(404).send({ error: 'not_found', message: 'Project not found' });

    // Fetch existing glossary to avoid duplicates
    const existing = await prisma.glossaryEntry.findMany({ where: { projectId }, select: { sourceTerm: true } });
    const existingTerms = existing.map((e) => e.sourceTerm);

    // Sample translated strings (prefer ones with notes for BC context)
    const samples = await prisma.translation.findMany({
      where: {
        projectId,
        ...(xliffFileId ? { xliffFileId } : {}),
        NOT: { target: '' },
        state: { not: 'new' },
      },
      select: { source: true, target: true, note: true },
      orderBy: { note: 'asc' }, // grouped by object type = better context
      take: 200,
    });

    const aiProvider = createProvider({
      type: provider ?? (process.env.AI_PROVIDER as AIProviderType) ?? 'github-models',
      token,
      model: model ?? process.env.AI_MODEL,
    });

    try {
      const result = await aiProvider.generateGlossary({
        samples: samples.map((s) => ({ source: s.source, target: s.target, context: s.note ?? undefined })),
        sourceLanguage: project.sourceLanguage,
        targetLanguage: project.targetLanguage,
        existingTerms,
      });
      return { data: result.suggestions, meta: { count: result.suggestions.length } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: 'ai_error', message });
    }
  });

  /** AI: Generate glossary entries from a natural language prompt */
  app.post<{
    Body: {
      projectId: string;
      prompt: string;
      provider?: AIProviderType;
      model?: string;
    };
  }>('/ai-suggest', async (req, reply) => {
    const { projectId, prompt, provider, model } = req.body;
    if (!projectId || !prompt) return reply.status(400).send({ error: 'validation', message: 'projectId and prompt required' });

    const token = process.env.GITHUB_TOKEN;
    if (!token) return reply.status(500).send({ error: 'config', message: 'AI token not configured' });

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return reply.status(404).send({ error: 'not_found', message: 'Project not found' });

    const existing = await prisma.glossaryEntry.findMany({ where: { projectId }, select: { sourceTerm: true } });
    const existingTerms = existing.map((e) => e.sourceTerm);

    const aiProvider = createProvider({
      type: provider ?? (process.env.AI_PROVIDER as AIProviderType) ?? 'github-models',
      token,
      model: model ?? process.env.AI_MODEL,
    });

    try {
      const result = await aiProvider.suggestGlossaryFromPrompt({
        prompt,
        sourceLanguage: project.sourceLanguage,
        targetLanguage: project.targetLanguage,
        existingTerms,
      });
      return { data: result.suggestions, meta: { count: result.suggestions.length } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: 'ai_error', message });
    }
  });
}
