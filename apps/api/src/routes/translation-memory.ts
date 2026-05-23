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
  if (a === b) return 1;                        // exact case-sensitive match → 100%
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  // Case-insensitive fuzzy score, capped at 0.99 so it never shows as "100%" when case differs
  const fuzzy = 1 - levenshtein(a.toLowerCase(), b.toLowerCase()) / maxLen;
  return Math.min(fuzzy, 0.99);
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

    const results: Record<string, Array<{ target: string; score: number; usageCount: number; projectId: string | null }>> = {};

    for (const source of sources) {
      const candidates: Array<{ target: string; score: number; usageCount: number; projectId: string | null }> = [];

      for (const entry of entries) {
        const score = similarity(source, entry.source);
        if (score >= FUZZY_THRESHOLD) {
          // Merge into existing candidate with same target (keep highest score + combined usageCount)
          const existing = candidates.find((c) => c.target === entry.target);
          if (existing) {
            if (score > existing.score) existing.score = Math.round(score * 100) / 100;
            existing.usageCount += entry.usageCount;
            if (entry.projectId !== null) existing.projectId = entry.projectId;
          } else {
            candidates.push({ target: entry.target, score: Math.round(score * 100) / 100, usageCount: entry.usageCount, projectId: entry.projectId });
          }
        }
      }

      // Sort: score DESC, then project-scoped first, then usageCount DESC; return top 3
      candidates.sort((a, b) =>
        b.score - a.score ||
        (b.projectId !== null ? 1 : 0) - (a.projectId !== null ? 1 : 0) ||
        b.usageCount - a.usageCount
      );

      if (candidates.length) results[source] = candidates.slice(0, 3);
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

  // POST /populate — harvest confirmed translations from the project into TM
  // Supports dryRun (analyse only) and conflict resolution via resolutions map
  app.post<{
    Body: {
      projectId: string;
      scope?: 'project' | 'global';
      states?: string[];
      dryRun?: boolean;
      resolutions?: Record<string, string>; // key → chosen target
    };
  }>('/populate', async (req, reply) => {
    const {
      projectId,
      scope = 'project',
      states = ['translated', 'final'],
      dryRun = false,
      resolutions = {},
    } = req.body;
    if (!projectId) return reply.status(400).send({ error: 'validation', message: 'projectId is required' });

    const tmProjectId = scope === 'project' ? projectId : null;

    // Batch-fetch XLIFF files and translations in parallel
    const [xliffFiles, rawTranslations] = await Promise.all([
      prisma.xliffFile.findMany({
        where: { projectId },
        select: { id: true, sourceLanguage: true, targetLanguage: true },
      }),
      prisma.translation.findMany({
        where: { projectId, state: { in: states }, target: { not: '' } },
        select: { xliffFileId: true, source: true, target: true },
      }),
    ]);

    if (!xliffFiles.length) return { dryRun, conflicts: [], willCreate: 0, willUpdate: 0, skipped: 0, created: 0, updated: 0 };

    const fileMap = new Map(xliffFiles.map((f) => [f.id, f]));

    // Group translations by (source, srcLang, tgtLang) — detect multiple different targets
    type Group = { source: string; sourceLanguage: string; targetLanguage: string; targets: Set<string> };
    const groups = new Map<string, Group>();

    for (const t of rawTranslations) {
      const file = fileMap.get(t.xliffFileId);
      if (!file) continue;
      const key = `${t.source}\x00${file.sourceLanguage}\x00${file.targetLanguage}`;
      if (!groups.has(key)) {
        groups.set(key, { source: t.source, sourceLanguage: file.sourceLanguage, targetLanguage: file.targetLanguage, targets: new Set() });
      }
      groups.get(key)!.targets.add(t.target);
    }

    // Batch-fetch all existing TM entries for this project scope
    const existingEntries = await prisma.translationMemory.findMany({
      where: { projectId: tmProjectId },
      select: { id: true, source: true, target: true, sourceLanguage: true, targetLanguage: true },
    });
    const existingMap = new Map(existingEntries.map((e) => [`${e.source}\x00${e.sourceLanguage}\x00${e.targetLanguage}`, e]));

    // Categorise each group
    const toCreate: Array<{ source: string; target: string; sourceLanguage: string; targetLanguage: string; projectId: string | null; usageCount: number }> = [];
    const toUpdate: Array<{ id: string; target: string }> = [];
    const conflicts: Array<{ key: string; source: string; sourceLanguage: string; targetLanguage: string; options: string[] }> = [];
    let skipped = 0;

    for (const [key, group] of groups) {
      let chosenTarget: string | undefined;

      if (group.targets.size > 1) {
        // Multiple different translations for same source — conflict
        if (resolutions[key] !== undefined) {
          chosenTarget = resolutions[key]; // user resolved it
        } else {
          conflicts.push({
            key,
            source: group.source,
            sourceLanguage: group.sourceLanguage,
            targetLanguage: group.targetLanguage,
            options: [...group.targets],
          });
          continue;
        }
      } else {
        chosenTarget = [...group.targets][0];
      }

      const existing = existingMap.get(key);
      if (existing) {
        if (existing.target !== chosenTarget) {
          toUpdate.push({ id: existing.id, target: chosenTarget });
        } else {
          skipped++;
        }
      } else {
        toCreate.push({
          source: group.source,
          target: chosenTarget,
          sourceLanguage: group.sourceLanguage,
          targetLanguage: group.targetLanguage,
          projectId: tmProjectId,
          usageCount: 1,
        });
      }
    }

    // If dry run OR there are unresolved conflicts — return preview only
    if (dryRun || conflicts.length > 0) {
      return {
        dryRun: true,
        conflicts,
        willCreate: toCreate.length,
        willUpdate: toUpdate.length,
        skipped,
      };
    }

    // Apply: bulk create + batch update in a transaction
    const CHUNK = 500;
    let created = 0;
    for (let i = 0; i < toCreate.length; i += CHUNK) {
      const chunk = toCreate.slice(i, i + CHUNK);
      const result = await prisma.translationMemory.createMany({ data: chunk });
      created += result.count;
    }

    // Batch updates in a transaction (chunked)
    for (let i = 0; i < toUpdate.length; i += CHUNK) {
      const chunk = toUpdate.slice(i, i + CHUNK);
      await prisma.$transaction(chunk.map((u) =>
        prisma.translationMemory.update({ where: { id: u.id }, data: { target: u.target, updatedAt: new Date() } })
      ));
    }

    return { success: true, created, updated: toUpdate.length, skipped };
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
