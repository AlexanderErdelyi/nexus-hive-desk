import type { FastifyInstance } from 'fastify';
import { prisma } from '@nexus/db';
import { requireAuth } from '../lib/auth';

// ─── DevOps helpers ─────────────────────────────────────────────────────────

function adoAuthHeader(pat: string) {
  return `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchJsonSafe<T = any>(url: string, init: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, init);
    if (!res.ok) return null;
    return res.json() as Promise<T>;
  } catch {
    return null;
  }
}

type DevopsItem = {
  id: string;
  type: string;
  projectId: string;
  projectName: string;
  label: string;
  detail: string | null;
  /** NexusHiveDesk internal link (project view) */
  internalUrl: string;
  /** Direct URL to the ADO/GitHub item — open in new tab */
  externalUrl: string | null;
  occurredAt: string;
};

export async function dashboardRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireAuth(app));

  /** GET /api/dashboard/devops-activity?since=<iso> — PRs, work items from connected ADO/GitHub repos */
  app.get<{ Querystring: { since?: string } }>('/devops-activity', async (req) => {
    const userId = req.user.sub;
    const since = req.query.since ? new Date(req.query.since) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const memberships = await prisma.projectMember.findMany({
      where: { userId },
      select: { projectId: true },
    });
    const projectIds = memberships.map((m) => m.projectId);
    if (projectIds.length === 0) return { data: [] };

    const projects = await prisma.project.findMany({
      where: { id: { in: projectIds } },
      include: { repositories: true },
    });

    // Build a normalised list of "repo entries" per project.
    // Prefer explicit ProjectRepository rows; fall back to the legacy
    // connectionId/adoProjectName stored directly on the Project model.
    type RepoEntry = {
      connectionId: string;
      adoProjectName: string | null;
      repoName: string;
    };
    const projectRepos: { project: typeof projects[0]; repos: RepoEntry[] }[] = [];
    for (const p of projects) {
      if (p.repositories.length > 0) {
        projectRepos.push({ project: p, repos: p.repositories });
      } else if (p.connectionId) {
        // Legacy: project has a direct connection but no ProjectRepository rows
        projectRepos.push({
          project: p,
          repos: [{ connectionId: p.connectionId, adoProjectName: p.adoProjectName ?? null, repoName: p.name }],
        });
      }
    }

    // Collect all unique connectionIds
    const connectionIds = new Set<string>();
    for (const { repos } of projectRepos) {
      for (const r of repos) connectionIds.add(r.connectionId);
    }
    if (connectionIds.size === 0) return { data: [] };

    const connections = await prisma.customerConnection.findMany({
      where: { id: { in: [...connectionIds] } },
    });
    const connMap = Object.fromEntries(connections.map((c) => [c.id, c]));

    // Cache "who am I" per connection
    const meCache = new Map<string, string>();

    async function getAdoMeId(connId: string, pat: string, baseUrl: string): Promise<string | null> {
      if (meCache.has(connId)) return meCache.get(connId)!;
      const data = await fetchJsonSafe<{ authenticatedUser?: { id?: string } }>(
        `${baseUrl}/_apis/connectionData`,
        { headers: { Authorization: adoAuthHeader(pat) } }
      );
      const id = data?.authenticatedUser?.id ?? null;
      if (id) meCache.set(connId, id);
      return id;
    }

    async function getGithubLogin(connId: string, pat: string, apiBase: string): Promise<string | null> {
      if (meCache.has(connId)) return meCache.get(connId)!;
      const data = await fetchJsonSafe<{ login?: string }>(
        `${apiBase}/user`,
        { headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json' } }
      );
      const login = data?.login ?? null;
      if (login) meCache.set(connId, login);
      return login;
    }

    const items: DevopsItem[] = [];
    const sinceIso = since.toISOString();
    const sinceDateStr = sinceIso.split('T')[0]; // YYYY-MM-DD

    const tasks: Promise<void>[] = [];

    for (const { project, repos } of projectRepos) {
      for (const repo of repos) {
        const conn = connMap[repo.connectionId];
        if (!conn) continue;

        // ─── Azure DevOps ───────────────────────────────────────────────────
        if (conn.type === 'azure-devops') {
          tasks.push((async () => {
            try {
              const baseUrl = (conn.baseUrl ?? '').replace(/\/$/, '');
              const adoProject = repo.adoProjectName;
              if (!adoProject) return;
              const auth = { Authorization: adoAuthHeader(conn.pat) };
              const repoEnc = encodeURIComponent(repo.repoName);
              const projEnc = encodeURIComponent(adoProject);

              const meId = await getAdoMeId(conn.id, conn.pat, baseUrl);
              if (!meId) return;

              // PRs where I'm a reviewer
              const reviewerPrs = await fetchJsonSafe<{
                value: Array<{
                  pullRequestId: number; title: string; creationDate: string;
                  createdBy: { displayName: string };
                }>;
              }>(
                `${baseUrl}/${projEnc}/_apis/git/repositories/${repoEnc}/pullrequests?searchCriteria.reviewerId=${encodeURIComponent(meId)}&searchCriteria.status=active&$top=20&api-version=7.1`,
                { headers: auth }
              );
              for (const pr of reviewerPrs?.value ?? []) {
                if (new Date(pr.creationDate) < since) continue;
                items.push({
                  id: `ado-pr-review-${pr.pullRequestId}`,
                  type: 'pr_review_requested',
                  projectId: project.id,
                  projectName: project.name,
                  label: `Review requested: ${pr.title}`,
                  detail: `by ${pr.createdBy.displayName} · ${repo.repoName}`,
                  internalUrl: `/projects/${project.id}?view=pull-requests`,
                  externalUrl: `${baseUrl}/${projEnc}/_git/${repoEnc}/pullrequest/${pr.pullRequestId}`,
                  occurredAt: pr.creationDate,
                });
              }

              // My open PRs — check vote status
              type AdoPr = {
                pullRequestId: number; title: string; creationDate: string;
                reviewers?: Array<{ vote: number }>;
              };
              const myPrs = await fetchJsonSafe<{ value: AdoPr[] }>(
                `${baseUrl}/${projEnc}/_apis/git/repositories/${repoEnc}/pullrequests?searchCriteria.creatorId=${encodeURIComponent(meId)}&searchCriteria.status=active&$top=20&api-version=7.1`,
                { headers: auth }
              );
              for (const pr of myPrs?.value ?? []) {
                if (new Date(pr.creationDate) < since) continue;
                const votes = (pr.reviewers ?? []).map((r) => r.vote);
                const hasApproval = votes.some((v) => v >= 10);
                const hasRejection = votes.some((v) => v <= -10);
                const type = hasRejection ? 'pr_rejected' : hasApproval ? 'pr_approved' : 'pr_created';
                const prefix = hasRejection ? 'PR rejected' : hasApproval ? 'PR approved' : 'My PR open';
                items.push({
                  id: `ado-pr-mine-${pr.pullRequestId}`,
                  type,
                  projectId: project.id,
                  projectName: project.name,
                  label: `${prefix}: ${pr.title}`,
                  detail: repo.repoName,
                  internalUrl: `/projects/${project.id}?view=pull-requests`,
                  externalUrl: `${baseUrl}/${projEnc}/_git/${repoEnc}/pullrequest/${pr.pullRequestId}`,
                  occurredAt: pr.creationDate,
                });
              }

              // Work items assigned to me, changed since `since`
              const wiqlRes = await fetchJsonSafe<{ workItems?: Array<{ id: number }> }>(
                `${baseUrl}/${projEnc}/_apis/wit/wiql?api-version=7.1`,
                {
                  method: 'POST',
                  headers: { ...auth, 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${adoProject}' AND [System.AssignedTo] = @me AND [System.ChangedDate] >= '${sinceDateStr}' ORDER BY [System.ChangedDate] DESC`,
                  }),
                }
              );
              const wiIds = (wiqlRes?.workItems ?? []).slice(0, 15).map((w) => w.id);
              if (wiIds.length > 0) {
                const batch = await fetchJsonSafe<{
                  value: Array<{
                    id: number;
                    fields: {
                      'System.Title': string; 'System.State': string;
                      'System.ChangedDate': string; 'System.WorkItemType': string;
                    };
                  }>;
                }>(
                  `${baseUrl}/_apis/wit/workitems?ids=${wiIds.join(',')}&fields=System.Id,System.Title,System.State,System.ChangedDate,System.WorkItemType&api-version=7.1`,
                  { headers: auth }
                );
                for (const wi of batch?.value ?? []) {
                  const f = wi.fields;
                  items.push({
                    id: `ado-wi-${wi.id}`,
                    type: 'work_item_assigned',
                    projectId: project.id,
                    projectName: project.name,
                    label: `${f['System.WorkItemType']}: ${f['System.Title']}`,
                    detail: f['System.State'],
                    internalUrl: `/projects/${project.id}?view=work-items`,
                    externalUrl: `${baseUrl}/${projEnc}/_workitems/edit/${wi.id}`,
                    occurredAt: f['System.ChangedDate'],
                  });
                }
              }
            } catch {
              // swallow — don't fail the whole request on one repo
            }
          })());
        }

        // ─── GitHub ───────────────────────────────────────────────────────
        if (conn.type === 'github') {
          tasks.push((async () => {
            try {
              const apiBase = (conn.baseUrl ?? 'https://api.github.com').replace(/\/$/, '');
              const ghHeaders = {
                Authorization: `Bearer ${conn.pat}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
              };

              const login = await getGithubLogin(conn.id, conn.pat, apiBase);
              if (!login) return;

              // Open PRs — mine or review-requested
              type GhPr = {
                number: number; title: string; html_url: string; created_at: string;
                user: { login: string };
                requested_reviewers?: Array<{ login: string }>;
                labels?: Array<{ name: string }>;
              };
              const openPrs = await fetchJsonSafe<GhPr[]>(
                `${apiBase}/repos/${encodeURIComponent(repo.repoName)}/pulls?state=open&per_page=50`,
                { headers: ghHeaders }
              );
              for (const pr of openPrs ?? []) {
                if (new Date(pr.created_at) < since) continue;
                const isMine = pr.user.login === login;
                const reviewRequested = (pr.requested_reviewers ?? []).some((r) => r.login === login);
                if (isMine) {
                  items.push({
                    id: `gh-pr-mine-${pr.number}`,
                    type: 'pr_created',
                    projectId: project.id,
                    projectName: project.name,
                    label: `My PR open: ${pr.title}`,
                    detail: repo.repoName,
                    internalUrl: `/projects/${project.id}?view=pull-requests`,
                    externalUrl: pr.html_url,
                    occurredAt: pr.created_at,
                  });
                } else if (reviewRequested) {
                  items.push({
                    id: `gh-pr-review-${pr.number}`,
                    type: 'pr_review_requested',
                    projectId: project.id,
                    projectName: project.name,
                    label: `Review requested: ${pr.title}`,
                    detail: `by ${pr.user.login} · ${repo.repoName}`,
                    internalUrl: `/projects/${project.id}?view=pull-requests`,
                    externalUrl: pr.html_url,
                    occurredAt: pr.created_at,
                  });
                }
              }

              // Issues assigned to me
              type GhIssue = {
                number: number; title: string; html_url: string; updated_at: string;
                pull_request?: unknown;
              };
              const issues = await fetchJsonSafe<GhIssue[]>(
                `${apiBase}/repos/${encodeURIComponent(repo.repoName)}/issues?state=open&assignee=${encodeURIComponent(login)}&since=${encodeURIComponent(sinceIso)}&per_page=20`,
                { headers: ghHeaders }
              );
              for (const issue of issues ?? []) {
                if (issue.pull_request) continue; // skip PRs listed as issues
                items.push({
                  id: `gh-issue-${issue.number}`,
                  type: 'issue_assigned',
                  projectId: project.id,
                  projectName: project.name,
                  label: `Issue assigned: ${issue.title}`,
                  detail: repo.repoName,
                  internalUrl: `/projects/${project.id}`,
                  externalUrl: issue.html_url,
                  occurredAt: issue.updated_at,
                });
              }
            } catch {
              // swallow
            }
          })());
        }
      }
    }

    await Promise.allSettled(tasks);
    items.sort((a, b) => (b.occurredAt > a.occurredAt ? 1 : -1));
    return { data: items.slice(0, 80) };
  });

  /** GET /api/dashboard/activity?since=<iso> — recent events across all user projects */
  app.get<{ Querystring: { since?: string } }>('/activity', async (req) => {
    const userId = req.user.sub;
    const since = req.query.since ? new Date(req.query.since) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const memberships = await prisma.projectMember.findMany({
      where: { userId },
      select: { projectId: true },
    });
    const projectIds = memberships.map((m) => m.projectId);
    if (projectIds.length === 0) return { data: [] };

    const projects = await prisma.project.findMany({
      where: { id: { in: projectIds } },
      select: { id: true, name: true },
    });
    const projectName = Object.fromEntries(projects.map((p) => [p.id, p.name]));

    type ActivityItem = {
      id: string;
      type: string;
      projectId: string;
      projectName: string;
      label: string;
      detail: string | null;
      occurredAt: string;
    };
    const items: ActivityItem[] = [];

    // XLIFF file uploads
    const uploads = await prisma.xliffFile.findMany({
      where: { projectId: { in: projectIds }, uploadedAt: { gte: since } },
      select: { id: true, projectId: true, filename: true, uploadedAt: true },
      orderBy: { uploadedAt: 'desc' },
      take: 50,
    });
    for (const f of uploads) {
      items.push({
        id: `upload-${f.id}`,
        type: 'xliff_upload',
        projectId: f.projectId,
        projectName: projectName[f.projectId] ?? '',
        label: 'XLIFF file uploaded',
        detail: f.filename,
        occurredAt: f.uploadedAt.toISOString(),
      });
    }

    // XLIFF syncs from remote
    const syncs = await prisma.xliffFile.findMany({
      where: { projectId: { in: projectIds }, lastSyncAt: { gte: since } },
      select: { id: true, projectId: true, filename: true, lastSyncAt: true },
      orderBy: { lastSyncAt: 'desc' },
      take: 50,
    });
    for (const f of syncs) {
      if (!f.lastSyncAt) continue;
      items.push({
        id: `sync-${f.id}`,
        type: 'xliff_sync',
        projectId: f.projectId,
        projectName: projectName[f.projectId] ?? '',
        label: 'File synced from remote',
        detail: f.filename,
        occurredAt: f.lastSyncAt.toISOString(),
      });
    }

    // Source-changed / added translation units
    const changedUnits = await prisma.translation.groupBy({
      by: ['projectId', 'syncChangeType'],
      where: {
        projectId: { in: projectIds },
        syncChangedAt: { gte: since },
        syncChangeType: { not: null },
      },
      _count: { id: true },
    });
    for (const row of changedUnits) {
      const verb = row.syncChangeType === 'added' ? 'New translation units added' : 'Translation source changed';
      items.push({
        id: `translation-${row.projectId}-${row.syncChangeType}`,
        type: 'translation_change',
        projectId: row.projectId,
        projectName: projectName[row.projectId] ?? '',
        label: verb,
        detail: `${row._count.id} unit${row._count.id !== 1 ? 's' : ''}`,
        occurredAt: since.toISOString(), // approx
      });
    }

    // AL health reviews created
    const alReviews = await prisma.aLHealthReview.findMany({
      where: { projectId: { in: projectIds }, createdAt: { gte: since } },
      select: { id: true, projectId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    // group by project
    const alByProject: Record<string, number> = {};
    for (const r of alReviews) alByProject[r.projectId] = (alByProject[r.projectId] ?? 0) + 1;
    for (const [pid, count] of Object.entries(alByProject)) {
      items.push({
        id: `al-${pid}`,
        type: 'al_review',
        projectId: pid,
        projectName: projectName[pid] ?? '',
        label: 'AL Health issues reviewed',
        detail: `${count} review${count !== 1 ? 's' : ''}`,
        occurredAt: alReviews.find((r) => r.projectId === pid)!.createdAt.toISOString(),
      });
    }

    // New project members added
    const newMembers = await prisma.projectMember.findMany({
      where: { projectId: { in: projectIds }, createdAt: { gte: since } },
      select: { id: true, projectId: true, createdAt: true, user: { select: { name: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    for (const m of newMembers) {
      items.push({
        id: `member-${m.id}`,
        type: 'member_added',
        projectId: m.projectId,
        projectName: projectName[m.projectId] ?? '',
        label: 'Team member added',
        detail: m.user.name ?? m.user.email,
        occurredAt: m.createdAt.toISOString(),
      });
    }

    items.sort((a, b) => (b.occurredAt > a.occurredAt ? 1 : -1));
    return { data: items.slice(0, 60) };
  });

  /** GET /api/dashboard — aggregate per-project stats for the current user */
  app.get('/', async (req) => {
    const userId = req.user.sub;

    // Projects the user is a member of
    const memberships = await prisma.projectMember.findMany({
      where: { userId },
      select: { projectId: true, role: true },
    });
    const projectIds = memberships.map((m) => m.projectId);
    const roleMap = Object.fromEntries(memberships.map((m) => [m.projectId, m.role]));

    if (projectIds.length === 0) {
      return { data: [] };
    }

    const projects = await prisma.project.findMany({
      where: { id: { in: projectIds } },
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
