import { prisma } from '@nexus/db';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../lib/auth';

// ─── Simple similarity helper (normalised Levenshtein, 0–1) ──────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a.toLowerCase(), b.toLowerCase()) / maxLen;
}

const FUZZY_THRESHOLD = 0.75;

// ─── Routes ──────────────────────────────────────────────────────────────────

export async function translationMemoryRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireAuth(app));

  // POST /lookup — find TM matches for a list of source strings
  app.post<{
    Body: {
      sources: string[];
      sourceLanguage: string;
      targetLanguage: string;
      projectId?: string;
    };
  }>('/lookup', async (req, reply) => {
    const { sources, sourceLanguage, targetLanguage, projectId } = req.body;
    if (!sources?.length || !sourceLanguage || !targetLanguage) {
      return reply.status(400).send({ error: 'validation', message: 'sources, sourceLanguage and targetLanguage are required' });
    }

    // Fetch all TM entries for this language pair (project-scoped + global)
    const entries = await prisma.translationMemory.findMany({
      where: {
        sourceLanguage,
        targetLanguage,
        ...(projectId
          ? { OR: [{ projectId }, { projectId: null }] }
          : { projectId: null }),
      },
    });

    const results: Record<string, { target: string; score: number; projectId: string | null }> = {};

    for (const source of sources) {
      let best: { target: string; score: number; projectId: string | null } | null = null;

      for (const entry of entries) {
        const score = similarity(source, entry.source);
        if (score >= FUZZY_THRESHOLD) {
          if (!best || score > best.score || (score === best.score && entry.projectId !== null)) {
            best = { target: entry.target, score: Math.round(score * 100) / 100, projectId: entry.projectId };
          }
        }
      }

      if (best) results[source] = best;
    }

    return { data: results };
  });

  // GET / — list TM entries with optional filters
  app.get<{
    Querystring: { projectId?: string; sourceLanguage?: string; targetLanguage?: string; search?: string; page?: string; pageSize?: string };
  }>('/', async (req) => {
    const { projectId, sourceLanguage, targetLanguage, search, page = '1', pageSize = '50' } = req.query;
    const skip = (Number(page) - 1) * Number(pageSize);

    const where = {
      ...(projectId ? { projectId } : {}),
      ...(sourceLanguage ? { sourceLanguage } : {}),
      ...(targetLanguage ? { targetLanguage } : {}),
      ...(search ? { OR: [
        { source: { contains: search } },
        { target: { contains: search } },
      ]} : {}),
    };

    const [entries, total] = await Promise.all([
      prisma.translationMemory.findMany({ where, skip, take: Number(pageSize), orderBy: { usageCount: 'desc' } }),
      prisma.translationMemory.count({ where }),
    ]);

    return { data: entries, meta: { total, page: Number(page), pageSize: Number(pageSize) } };
  });

  // DELETE /:id — remove a TM entry
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    try {
      await prisma.translationMemory.delete({ where: { id: req.params.id } });
      return { success: true };
    } catch {
      return reply.status(404).send({ error: 'not_found', message: 'Entry not found' });
    }
  });

  // POST /bulk-delete — delete multiple TM entries by ID
  app.post<{ Body: { ids: string[] } }>('/bulk-delete', async (req, reply) => {
    const { ids } = req.body;
    if (!ids?.length) return reply.status(400).send({ error: 'validation', message: 'ids array is required' });
    const { count } = await prisma.translationMemory.deleteMany({ where: { id: { in: ids } } });
    return { success: true, deleted: count };
  });

  // POST /import — import TMX or CSV entries in bulk
  app.post<{
    Body: { entries: Array<{ source: string; target: string; sourceLanguage: string; targetLanguage: string }>; projectId?: string };
  }>('/import', async (req, reply) => {
    const { entries, projectId = null } = req.body;
    if (!entries?.length) return reply.status(400).send({ error: 'validation', message: 'entries array is required' });

    let created = 0, updated = 0;
    for (const e of entries) {
      if (!e.source || !e.target || !e.sourceLanguage || !e.targetLanguage) continue;
      const existing = await prisma.translationMemory.findFirst({
        where: { source: e.source, sourceLanguage: e.sourceLanguage, targetLanguage: e.targetLanguage, projectId },
      });
      if (existing) {
        await prisma.translationMemory.update({ where: { id: existing.id }, data: { target: e.target, updatedAt: new Date() } });
        updated++;
      } else {
        await prisma.translationMemory.create({ data: { ...e, projectId } });
        created++;
      }
    }
    return { success: true, created, updated };
  });

  // POST /upsert — manually add/update a TM entry
  app.post<{
    Body: { source: string; target: string; sourceLanguage: string; targetLanguage: string; projectId?: string };
  }>('/upsert', async (req, reply) => {
    const { source, target, sourceLanguage, targetLanguage, projectId = null } = req.body;
    if (!source || !target || !sourceLanguage || !targetLanguage) {
      return reply.status(400).send({ error: 'validation', message: 'source, target, sourceLanguage and targetLanguage are required' });
    }

    const existing = await prisma.translationMemory.findFirst({
      where: { source, sourceLanguage, targetLanguage, projectId },
    });

    const entry = existing
      ? await prisma.translationMemory.update({
          where: { id: existing.id },
          data: { target, usageCount: { increment: 1 }, updatedAt: new Date() },
        })
      : await prisma.translationMemory.create({
          data: { source, target, sourceLanguage, targetLanguage, projectId },
        });

    return { data: entry };
  });

  // PATCH /:id — update target of a TM entry
  app.patch<{ Params: { id: string }; Body: { target: string } }>('/:id', async (req, reply) => {
    const { target } = req.body;
    if (!target) return reply.status(400).send({ error: 'validation', message: 'target is required' });
    try {
      const entry = await prisma.translationMemory.update({ where: { id: req.params.id }, data: { target, updatedAt: new Date() } });
      return { data: entry };
    } catch {
      return reply.status(404).send({ error: 'not_found', message: 'Entry not found' });
    }
  });
}
