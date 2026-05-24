import type { FastifyInstance } from 'fastify';
import { prisma } from '@nexus/db';
import { requireAuth } from '../lib/auth';

export async function dashboardRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireAuth(app));

  /** GET /api/dashboard — aggregate per-project stats for all projects */
  app.get('/', async (req) => {
    const userId = req.user.sub;

    // Optional membership roles — show all projects regardless
    const memberships = await prisma.projectMember.findMany({
      where: { userId },
      select: { projectId: true, role: true },
    });
    const roleMap = Object.fromEntries(memberships.map((m) => [m.projectId, m.role]));

    const projects = await prisma.project.findMany({
      where: {},
      orderBy: { updatedAt: 'desc' },
      include: {
        customer: { select: { id: true, name: true } },
        xliffFiles: {
          select: {
            id: true,
            uploadedAt: true,
            lastSyncAt: true,
            remotePrId: true,
            remoteConnectionId: true,
          },
        },
        _count: {
          select: {
            alHealthReviews: true,
          },
        },
      },
    });

    const projectIds = projects.map((p) => p.id);

    // Batch translation counts per project
    const translationCounts = await prisma.translation.groupBy({
      by: ['projectId', 'state'],
      where: { projectId: { in: projectIds } },
      _count: { id: true },
    });

    // Map: projectId → { total, translated }
    const translationMap: Record<string, { total: number; translated: number }> = {};
    for (const row of translationCounts) {
      if (!translationMap[row.projectId]) translationMap[row.projectId] = { total: 0, translated: 0 };
      translationMap[row.projectId].total += row._count.id;
      if (row.state === 'translated' || row.state === 'final' || row.state === 'signed-off') {
        translationMap[row.projectId].translated += row._count.id;
      }
    }

    // Resolve connection types (unique connectionIds across all projects' xliff files + project.connectionId)
    const connectionIds = new Set<string>();
    for (const p of projects) {
      if (p.connectionId) connectionIds.add(p.connectionId);
      for (const f of p.xliffFiles) {
        if (f.remoteConnectionId) connectionIds.add(f.remoteConnectionId);
      }
    }

    const connections =
      connectionIds.size > 0
        ? await prisma.customerConnection.findMany({
            where: { id: { in: [...connectionIds] } },
            select: { id: true, type: true, name: true },
          })
        : [];
    const connMap = Object.fromEntries(connections.map((c) => [c.id, c]));

    const data = projects.map((p) => {
      const ts = translationMap[p.id];

      // Determine connection type — prefer project-level connectionId, fall back to first xliff file connection
      const primaryConnId =
        p.connectionId ??
        p.xliffFiles.find((f) => f.remoteConnectionId)?.remoteConnectionId ??
        null;
      const conn = primaryConnId ? connMap[primaryConnId] : null;

      // Last activity: newest of xliffFile.lastSyncAt or xliffFile.uploadedAt
      let lastActivityAt: string | null = null;
      for (const f of p.xliffFiles) {
        const candidate = f.lastSyncAt ?? f.uploadedAt;
        if (!lastActivityAt || candidate > new Date(lastActivityAt)) {
          lastActivityAt = candidate instanceof Date ? candidate.toISOString() : String(candidate);
        }
      }

      // Open PR count: xliff files with a remotePrId
      const openPrCount = p.xliffFiles.filter((f) => f.remotePrId).length;

      return {
        id: p.id,
        name: p.name,
        description: p.description ?? null,
        capabilities: p.capabilities,
        userRole: roleMap[p.id] ?? 'viewer',
        customer: p.customer ? { id: p.customer.id, name: p.customer.name } : null,
        connectionType: conn?.type ?? null,
        connectionName: conn?.name ?? null,
        translationStats: ts
          ? {
              totalUnits: ts.total,
              translatedUnits: ts.translated,
              percentComplete: ts.total > 0 ? Math.round((ts.translated / ts.total) * 100) : 0,
            }
          : null,
        alHealth: {
          reviewedIssueCount: p._count.alHealthReviews,
        },
        openPrCount,
        lastActivityAt,
        updatedAt: p.updatedAt.toISOString(),
      };
    });

    return { data };
  });
}
