import type { Prisma } from '@nexus/db';
import { prisma } from '@nexus/db';
import type { TranslationState } from '@nexus/types';
import type { FastifyInstance } from 'fastify';

export async function translationRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: {
      xliffFileId?: string;
      projectId?: string;
      state?: string;
      search?: string;
      searchIn?: string;      // 'all' | 'source' | 'target' | 'objectName'
      untranslatedOnly?: string;
      objectType?: string;
      objectFilters?: string; // comma-separated "{ObjectType} {ObjectName}" pairs from AL folder drop
      page?: string;
      pageSize?: string;
    };
  }>('/', async (req) => {
    const { xliffFileId, projectId, state, search, searchIn = 'all', untranslatedOnly, objectType, objectFilters, page = '1', pageSize = '50' } = req.query;

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

    return {
      data: items,
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

    return { data: results };
  });
}
