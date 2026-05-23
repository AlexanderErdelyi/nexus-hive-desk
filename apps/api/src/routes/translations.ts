import { Prisma, prisma } from '@nexus/db';
import type { TranslationState } from '@nexus/types';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../lib/auth';

export async function translationRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireAuth(app));
  app.get<{
    Querystring: {
      xliffFileId?: string;
      projectId?: string;
      state?: string;
      search?: string;
      searchIn?: string;      // 'all' | 'source' | 'target' | 'objectName'
      untranslatedOnly?: string;
      qualityIssuesOnly?: string; // 'true' → only return rows with detected quality issues
      changesOnly?: string;       // 'true' → only rows changed/added in last sync (syncChangedAt IS NOT NULL)
      objectType?: string;
      objectFilters?: string; // comma-separated "{ObjectType} {ObjectName}" pairs from AL folder drop
      page?: string;
      pageSize?: string;
    };
  }>('/', async (req) => {
    const { xliffFileId, projectId, state, search, searchIn = 'all', untranslatedOnly, qualityIssuesOnly, changesOnly, objectType, objectFilters, page = '1', pageSize = '50' } = req.query;

    const pageNum = Math.max(1, Number(page));
    const pageSizeNum = Math.min(200, Math.max(1, Number(pageSize)));
    const skip = (pageNum - 1) * pageSizeNum;

    const andClauses: Prisma.TranslationWhereInput[] = [];

    if (xliffFileId) andClauses.push({ xliffFileId });
    if (projectId) andClauses.push({ projectId });
    if (state) andClauses.push({ state });
    if (untranslatedOnly === 'true') {
      andClauses.push({
        OR: [{ state: 'new' }, { state: 'needs-translation' }, { target: '' }],
      });
    }
    // ── Quality issue sets ────────────────────────────────────────────────────
    // Only computed when qualityIssuesOnly=true.
    let sameAsSourceIds = new Set<string>();
    let inconsistentIds = new Set<string>();

    if (qualityIssuesOnly === 'true') {
      // Single fast O(n) scan — fetch all (id, source, target) for the scope,
      // then compute same-as-source and inconsistency in JS (avoids correlated subqueries).
      const allRows = await prisma.translation.findMany({
        where: {
          ...(xliffFileId ? { xliffFileId } : {}),
          ...(projectId   ? { projectId }   : {}),
          NOT: { target: '' },
        },
        select: { id: true, source: true, target: true },
      });

      // Group by source: track IDs where target==source vs. target!=source, and all distinct targets
      const bySource = new Map<string, { sameIds: string[]; diffIds: string[]; targets: Set<string> }>();
      for (const row of allRows) {
        if (!bySource.has(row.source)) {
          bySource.set(row.source, { sameIds: [], diffIds: [], targets: new Set() });
        }
        const g = bySource.get(row.source)!;
        if (row.source === row.target) {
          g.sameIds.push(row.id);
        } else {
          g.diffIds.push(row.id);
          g.targets.add(row.target);
        }
      }

      for (const [source, g] of bySource) {
        // Same-as-source: only flag if there's also at least one real translation (>= 3 words)
        if (g.sameIds.length > 0 && g.diffIds.length > 0 && source.trim().split(/\s+/).length >= 3) {
          for (const id of g.sameIds) sameAsSourceIds.add(id);
        }
        // Inconsistent: 2+ distinct real targets for the same source
        if (g.targets.size > 1) {
          for (const id of g.diffIds) inconsistentIds.add(id);
        }
      }

      const qualityIds = [...new Set([...sameAsSourceIds, ...inconsistentIds])];
      andClauses.push({
        OR: [
          { state: 'needs-review-translation' },
          ...(qualityIds.length > 0 ? [{ id: { in: qualityIds } }] : []),
        ],
      });
    }
    if (changesOnly === 'true') {
      andClauses.push({ syncChangedAt: { not: null } });
    }
    if (objectType) {
      // note starts with "{ObjectType} " — e.g. "Table ", "Codeunit "
      andClauses.push({ note: { startsWith: `${objectType} ` } });
    }
    // AL folder filter: OR of exact "{ObjectType} {ObjectName} - " note prefixes
    if (objectFilters) {
      const filters = objectFilters.split(',').map((f) => f.trim()).filter(Boolean);
      if (filters.length > 0) {
        andClauses.push({
          OR: filters.map((f) => ({ note: { startsWith: `${f} - ` } })),
        });
      }
    }
    if (search) {
      // searchIn scopes where the search text is matched
      const searchClause: Prisma.TranslationWhereInput =
        searchIn === 'source'     ? { source: { contains: search } }
        : searchIn === 'target'   ? { target: { contains: search } }
        : searchIn === 'objectName' ? { note: { contains: search } }
        : { // 'all' — search everywhere
            OR: [
              { source: { contains: search } },
              { target: { contains: search } },
              { unitId: { contains: search } },
              { note: { contains: search } },
              { developerNote: { contains: search } },
            ],
          };
      andClauses.push(searchClause);
    }

    const where: Prisma.TranslationWhereInput = andClauses.length > 0 ? { AND: andClauses } : {};

    const [items, total] = await Promise.all([
      prisma.translation.findMany({
        where,
        skip,
        take: pageSizeNum,
        orderBy: { unitId: 'asc' },
      }),
      prisma.translation.count({ where }),
    ]);

    // Annotate each row with detected quality issues (client can render badges)
    // For quality-only pages the sets are pre-computed above.
    // For other pages, derive inconsistency from the current page items only.
    if (qualityIssuesOnly !== 'true') {
      // Build source → Set<target> map from page items for cheap page-local inconsistency detection
      const pageSourceTargets = new Map<string, Set<string>>();
      for (const item of items) {
        if (item.target && item.source !== item.target) {
          if (!pageSourceTargets.has(item.source)) pageSourceTargets.set(item.source, new Set());
          pageSourceTargets.get(item.source)!.add(item.target);
        }
      }
      for (const item of items) {
        const targets = pageSourceTargets.get(item.source);
        if (targets && targets.size > 1) inconsistentIds.add(item.id);
      }
    }

    const annotated = items.map((item) => {
      const issues: string[] = [];
      if (item.state === 'needs-review-translation') issues.push('ai-review');
      // Same-as-source: only flag when pre-computed set says it's translatable elsewhere
      if (item.target && sameAsSourceIds.has(item.id)) {
        issues.push('same-as-source');
      }
      // Inconsistent: same source has multiple distinct translations
      if (inconsistentIds.has(item.id)) {
        issues.push('inconsistent-translation');
      }
      // Placeholder mismatch: count {N}, %N, {{var}} tokens in source vs target
      const phRegex = /\{[\w\d]+\}|%\d+|\{\{[\w]+\}\}/g;
      const srcPh = (item.source.match(phRegex) ?? []).sort();
      const tgtPh = (item.target.match(phRegex) ?? []).sort();
      if (srcPh.length !== tgtPh.length || srcPh.join() !== tgtPh.join()) {
        if (srcPh.length > 0) issues.push('placeholder-mismatch');
      }
      // Length anomaly: target much shorter or longer than source (ignore very short strings)
      if (item.source.length > 15 && item.target.length > 0) {
        const ratio = item.target.length / item.source.length;
        if (ratio < 0.2 || ratio > 5) issues.push('length-anomaly');
      }
      return { ...item, qualityIssues: issues };
    });

    return {
      data: annotated,
      meta: {
        total,
        page: pageNum,
        pageSize: pageSizeNum,
        totalPages: Math.ceil(total / pageSizeNum),
      },
    };
  });

  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const translation = await prisma.translation.findUnique({ where: { id: req.params.id } });
    if (!translation) {
      return reply.status(404).send({ error: 'not_found', message: 'Translation not found' });
    }

    return { data: translation };
  });

  app.patch<{
    Params: { id: string };
    Body: { target?: string; state?: TranslationState };
  }>('/:id', async (req) => {
    const { target, state } = req.body;
    const updated = await prisma.translation.update({
      where: { id: req.params.id },
      data: {
        ...(target !== undefined ? { target } : {}),
        ...(state ? { state } : {}),
        updatedAt: new Date(),
      },
    });

    return { data: updated };
  });

  app.patch<{
    Body: { updates: Array<{ id: string; target?: string; state?: TranslationState }> };
  }>('/bulk', async (req, reply) => {
    const { updates } = req.body;
    if (!Array.isArray(updates) || updates.length === 0) {
      return reply.status(400).send({ error: 'validation', message: 'updates array is required' });
    }

    const results = await prisma.$transaction(
      updates.map((update) =>
        prisma.translation.update({
          where: { id: update.id },
          data: {
            ...(update.target !== undefined ? { target: update.target } : {}),
            ...(update.state ? { state: update.state } : {}),
            updatedAt: new Date(),
          },
        })
      )
    );

    // Auto-populate translation memory for translated/final entries
    const translatedResults = results.filter(
      (r) => r.state === 'translated' || r.state === 'final' || r.state === 'signed-off'
    );

    if (translatedResults.length > 0) {
      // Group by projectId so we can look up language pairs
      const projectIds = [...new Set(translatedResults.map((r) => r.projectId))];
      const projects = await prisma.project.findMany({
        where: { id: { in: projectIds } },
        select: { id: true, sourceLanguage: true, targetLanguage: true },
      });
      const projectMap = new Map(projects.map((p) => [p.id, p]));

      await Promise.allSettled(
        translatedResults
          .filter((r) => r.target && r.source)
          .map(async (r) => {
            const project = projectMap.get(r.projectId);
            if (!project) return;
            const existing = await prisma.translationMemory.findFirst({
              where: {
                source: r.source,
                sourceLanguage: project.sourceLanguage ?? undefined,
                targetLanguage: project.targetLanguage ?? undefined,
                projectId: r.projectId,
              },
            });
            if (existing) {
              return prisma.translationMemory.update({
                where: { id: existing.id },
                data: { target: r.target, usageCount: { increment: 1 }, updatedAt: new Date() },
              });
            } else {
              return prisma.translationMemory.create({
                data: {
                  source: r.source,
                  target: r.target,
                  sourceLanguage: project.sourceLanguage ?? 'en',
                  targetLanguage: project.targetLanguage ?? 'de',
                  projectId: r.projectId,
                },
              });
            }
          })
      );
    }

    return { data: results };
  });
}
