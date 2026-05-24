import type { FastifyInstance } from 'fastify';
import { prisma } from '@nexus/db';
import { serializeXliff } from '@nexus/xliff';
import type { TranslationState } from '@nexus/types';
import { requireAuth } from '../lib/auth';

// ÔöÇÔöÇÔöÇ Helpers ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

async function getConnection(connId: string) {
  return prisma.customerConnection.findUnique({ where: { id: connId } });
}

function azureHeaders(pat: string): Record<string, string> {
  return {
    Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`,
    'Content-Type': 'application/json',
  };
}

function githubHeaders(pat: string): Record<string, string> {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchJson<T = any>(url: string, headers: Record<string, string>): Promise<T> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchJsonWithInit<T = any>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ÔöÇÔöÇÔöÇ Routes ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ


export async function remoteRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireAuth(app));
  // ÔöÇÔöÇÔöÇ Azure DevOps: List projects in organization ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  app.get<{ Params: { connId: string } }>(
    '/connections/:connId/azure/projects',
    async (req, reply) => {
      const conn = await getConnection(req.params.connId);
      if (!conn || conn.type !== 'azure-devops') {
        return reply.status(404).send({ error: 'not_found', message: 'Azure DevOps connection not found' });
      }

      try {
        const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';
        const data = await fetchJson(
          `${baseUrl}/_apis/projects?api-version=7.1&$top=200`,
          azureHeaders(conn.pat)
        );

        const projects = (data.value ?? []).map((p: { id: string; name: string; description?: string }) => ({
          id: p.id,
          name: p.name,
          description: p.description,
        }));

        return { data: projects };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(502).send({ error: 'remote_error', message });
      }
    }
  );

  // ÔöÇÔöÇÔöÇ Azure DevOps: List repos in project ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  app.get<{ Params: { connId: string; project: string } }>(
    '/connections/:connId/azure/projects/:project/repos',
    async (req, reply) => {
      const conn = await getConnection(req.params.connId);
      if (!conn || conn.type !== 'azure-devops') {
        return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
      }

      try {
        const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';
        const data = await fetchJson(
          `${baseUrl}/${encodeURIComponent(req.params.project)}/_apis/git/repositories?api-version=7.1`,
          azureHeaders(conn.pat)
        );

        const repos = (data.value ?? []).map((r: { id: string; name: string; defaultBranch?: string; webUrl?: string }) => ({
          id: r.id,
          name: r.name,
          defaultBranch: r.defaultBranch?.replace('refs/heads/', ''),
          url: r.webUrl,
        }));

        return { data: repos };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(502).send({ error: 'remote_error', message });
      }
    }
  );

  // ÔöÇÔöÇÔöÇ Azure DevOps: List branches ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  app.get<{ Params: { connId: string; project: string; repoId: string } }>(
    '/connections/:connId/azure/projects/:project/repos/:repoId/branches',
    async (req, reply) => {
      const conn = await getConnection(req.params.connId);
      if (!conn || conn.type !== 'azure-devops') {
        return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
      }

      try {
        const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';
        const data = await fetchJson(
          `${baseUrl}/${encodeURIComponent(req.params.project)}/_apis/git/repositories/${encodeURIComponent(req.params.repoId)}/refs?filter=heads/&api-version=7.1`,
          azureHeaders(conn.pat)
        );

        const branches = (data.value ?? []).map((b: { name: string }) => ({
          name: b.name.replace('refs/heads/', ''),
        }));

        return { data: branches };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(502).send({ error: 'remote_error', message });
      }
    }
  );

  // ÔöÇÔöÇÔöÇ Azure DevOps: List files (tree) ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  app.get<{
    Params: { connId: string; project: string; repoId: string };
    Querystring: { branch?: string; path?: string };
  }>(
    '/connections/:connId/azure/projects/:project/repos/:repoId/files',
    async (req, reply) => {
      const conn = await getConnection(req.params.connId);
      if (!conn || conn.type !== 'azure-devops') {
        return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
      }

      try {
        const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';
        const { branch, path: scopePath } = req.query;

        let url = `${baseUrl}/${encodeURIComponent(req.params.project)}/_apis/git/repositories/${encodeURIComponent(req.params.repoId)}/items?recursionLevel=oneLevel&api-version=7.1`;
        if (branch) url += `&versionDescriptor.version=${encodeURIComponent(branch)}&versionDescriptor.versionType=branch`;
        if (scopePath) url += `&scopePath=${encodeURIComponent(scopePath)}`;

        const data = await fetchJson(url, azureHeaders(conn.pat));

        const entries = (data.value ?? [])
          .filter((item: { path: string }) => item.path !== (scopePath ?? '/'))
          .map((item: { path: string; isFolder: boolean; contentMetadata?: { fileName?: string } }) => ({
            path: item.path,
            name: item.path.split('/').pop() ?? item.path,
            type: item.isFolder ? 'directory' : 'file',
          }));

        return { data: entries };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(502).send({ error: 'remote_error', message });
      }
    }
  );

  // ÔöÇÔöÇÔöÇ Azure DevOps: Scan repo for XLIFF files ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  app.get<{
    Params: { connId: string; project: string; repoId: string };
    Querystring: { branch?: string };
  }>(
    '/connections/:connId/azure/projects/:project/repos/:repoId/xliff-scan',
    async (req, reply) => {
      const conn = await getConnection(req.params.connId);
      if (!conn || conn.type !== 'azure-devops') {
        return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
      }

      try {
        const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';
        const { branch } = req.query;

        // Full recursive tree ÔÇö returns all items in the repo
        let url = `${baseUrl}/${encodeURIComponent(req.params.project)}/_apis/git/repositories/${encodeURIComponent(req.params.repoId)}/items?recursionLevel=full&api-version=7.1`;
        if (branch) url += `&versionDescriptor.version=${encodeURIComponent(branch)}&versionDescriptor.versionType=branch`;

        const data = await fetchJson(url, azureHeaders(conn.pat));

        const xliffFiles = (data.value ?? [])
          .filter((item: { path: string; isFolder: boolean }) => {
            if (item.isFolder) return false;
            const lower = item.path.toLowerCase();
            return lower.endsWith('.xlf') || lower.endsWith('.xliff');
          })
          .map((item: { path: string }) => ({
            path: item.path,
            name: item.path.split('/').pop() ?? item.path,
            type: 'file' as const,
          }));

        return { data: xliffFiles };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(502).send({ error: 'remote_error', message });
      }
    }
  );

  // ÔöÇÔöÇÔöÇ Azure DevOps: Get file content ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  app.get<{
    Params: { connId: string; project: string; repoId: string };
    Querystring: { branch?: string; path: string };
  }>(
    '/connections/:connId/azure/projects/:project/repos/:repoId/file-content',
    async (req, reply) => {
      const conn = await getConnection(req.params.connId);
      if (!conn || conn.type !== 'azure-devops') {
        return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
      }

      try {
        const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';
        const { branch, path: filePath } = req.query;

        // download=true bypasses ADO's inline size limit for large XLIFF files
        let url = `${baseUrl}/${encodeURIComponent(req.params.project)}/_apis/git/repositories/${encodeURIComponent(req.params.repoId)}/items?path=${encodeURIComponent(filePath)}&$format=text&download=true&api-version=7.1`;
        if (branch) url += `&versionDescriptor.version=${encodeURIComponent(branch)}&versionDescriptor.versionType=branch`;

        // Get as text ÔÇö omit Content-Type on GET so ADO returns raw file bytes
        const res = await fetch(url, { headers: { Authorization: azureHeaders(conn.pat).Authorization } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const content = await res.text();

        // Get objectId for commits
        let objectId: string | undefined;
        try {
          const metaUrl = url + '&includeContent=false&$format=json';
          const meta = await fetchJson(metaUrl, azureHeaders(conn.pat));
          objectId = meta.objectId;
        } catch {
          // objectId is optional
        }

        return { data: { path: filePath, content, objectId } };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(502).send({ error: 'remote_error', message });
      }
    }
  );

  // ÔöÇÔöÇÔöÇ Azure DevOps: Commit file ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  app.post<{
    Params: { connId: string; project: string; repoId: string };
    Body: { branch: string; path: string; content: string; message: string; oldObjectId?: string };
  }>(
    '/connections/:connId/azure/projects/:project/repos/:repoId/commit',
    async (req, reply) => {
      const conn = await getConnection(req.params.connId);
      if (!conn || conn.type !== 'azure-devops') {
        return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
      }

      try {
        const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';
        const { branch, path: filePath, content, message, oldObjectId } = req.body;

        // Get the latest commit on the branch to use as oldObjectId for the ref
        const refsData = await fetchJson(
          `${baseUrl}/${encodeURIComponent(req.params.project)}/_apis/git/repositories/${encodeURIComponent(req.params.repoId)}/refs?filter=heads/${encodeURIComponent(branch)}&api-version=7.1`,
          azureHeaders(conn.pat)
        );

        const branchRef = refsData.value?.[0];
        if (!branchRef) {
          return reply.status(400).send({ error: 'branch_not_found', message: `Branch '${branch}' not found` });
        }

        const pushBody = {
          refUpdates: [
            {
              name: `refs/heads/${branch}`,
              oldObjectId: branchRef.objectId,
            },
          ],
          commits: [
            {
              comment: message,
              changes: [
                {
                  changeType: 'edit',
                  item: { path: filePath },
                  newContent: {
                    content,
                    contentType: 'rawtext',
                  },
                },
              ],
            },
          ],
        };

        const pushUrl = `${baseUrl}/${encodeURIComponent(req.params.project)}/_apis/git/repositories/${encodeURIComponent(req.params.repoId)}/pushes?api-version=7.1`;
        const result = await fetchJsonWithInit(pushUrl, {
          method: 'POST',
          headers: azureHeaders(conn.pat),
          body: JSON.stringify(pushBody),
        });

        return { data: { success: true, pushId: result.pushId, commitId: result.commits?.[0]?.commitId } };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(502).send({ error: 'remote_error', message });
      }
    }
  );

  // ÔöÇÔöÇÔöÇ Azure DevOps: Create branch ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  app.post<{
    Params: { connId: string; project: string; repoId: string };
    Body: { name: string; sourceBranch: string };
  }>(
    '/connections/:connId/azure/projects/:project/repos/:repoId/branches',
    async (req, reply) => {
      const conn = await getConnection(req.params.connId);
      if (!conn || conn.type !== 'azure-devops') {
        return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
      }

      try {
        const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';
        const { name, sourceBranch } = req.body;

        // Get source branch ref
        const refsData = await fetchJson(
          `${baseUrl}/${encodeURIComponent(req.params.project)}/_apis/git/repositories/${encodeURIComponent(req.params.repoId)}/refs?filter=heads/${encodeURIComponent(sourceBranch)}&api-version=7.1`,
          azureHeaders(conn.pat)
        );

        const sourceRef = refsData.value?.[0];
        if (!sourceRef) {
          return reply.status(400).send({ error: 'branch_not_found', message: `Source branch '${sourceBranch}' not found` });
        }

        const createBody = [
          {
            name: `refs/heads/${name}`,
            oldObjectId: '0000000000000000000000000000000000000000',
            newObjectId: sourceRef.objectId,
          },
        ];

        const result = await fetchJsonWithInit(
          `${baseUrl}/${encodeURIComponent(req.params.project)}/_apis/git/repositories/${encodeURIComponent(req.params.repoId)}/refs?api-version=7.1`,
          {
            method: 'POST',
            headers: azureHeaders(conn.pat),
            body: JSON.stringify(createBody),
          }
        );

        return reply.status(201).send({ data: { success: true, ref: result.value?.[0] } });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(502).send({ error: 'remote_error', message });
      }
    }
  );

  // ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
  // GitHub Routes
  // ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

  // ÔöÇÔöÇÔöÇ GitHub: List repos for authenticated user ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  app.get<{ Params: { connId: string }; Querystring: { org?: string } }>(
    '/connections/:connId/github/repos',
    async (req, reply) => {
      const conn = await getConnection(req.params.connId);
      if (!conn || conn.type !== 'github') {
        return reply.status(404).send({ error: 'not_found', message: 'GitHub connection not found' });
      }

      try {
        const { org } = req.query;
        const url = org
          ? `https://api.github.com/orgs/${encodeURIComponent(org)}/repos?per_page=100&sort=updated`
          : 'https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member';

        const data = await fetchJson(url, githubHeaders(conn.pat));

        const repos = (data as Array<{ id: number; full_name: string; name: string; default_branch: string; html_url: string }>).map((r) => ({
          id: String(r.id),
          name: r.full_name,
          defaultBranch: r.default_branch,
          url: r.html_url,
        }));

        return { data: repos };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(502).send({ error: 'remote_error', message });
      }
    }
  );

  // ÔöÇÔöÇÔöÇ GitHub: List orgs ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  app.get<{ Params: { connId: string } }>(
    '/connections/:connId/github/orgs',
    async (req, reply) => {
      const conn = await getConnection(req.params.connId);
      if (!conn || conn.type !== 'github') {
        return reply.status(404).send({ error: 'not_found', message: 'GitHub connection not found' });
      }

      try {
        const data = await fetchJson(
          'https://api.github.com/user/orgs?per_page=100',
          githubHeaders(conn.pat)
        );

        const orgs = (data as Array<{ id: number; login: string }>).map((o) => ({
          id: String(o.id),
          name: o.login,
        }));

        return { data: orgs };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(502).send({ error: 'remote_error', message });
      }
    }
  );

  // ÔöÇÔöÇÔöÇ GitHub: List branches ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  app.get<{ Params: { connId: string; owner: string; repo: string } }>(
    '/connections/:connId/github/repos/:owner/:repo/branches',
    async (req, reply) => {
      const conn = await getConnection(req.params.connId);
      if (!conn || conn.type !== 'github') {
        return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
      }

      try {
        const data = await fetchJson(
          `https://api.github.com/repos/${encodeURIComponent(req.params.owner)}/${encodeURIComponent(req.params.repo)}/branches?per_page=100`,
          githubHeaders(conn.pat)
        );

        const branches = (data as Array<{ name: string }>).map((b) => ({
          name: b.name,
        }));

        return { data: branches };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(502).send({ error: 'remote_error', message });
      }
    }
  );

  // ÔöÇÔöÇÔöÇ GitHub: List files (tree) ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  app.get<{
    Params: { connId: string; owner: string; repo: string };
    Querystring: { branch?: string; path?: string };
  }>(
    '/connections/:connId/github/repos/:owner/:repo/files',
    async (req, reply) => {
      const conn = await getConnection(req.params.connId);
      if (!conn || conn.type !== 'github') {
        return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
      }

      try {
        const { branch, path: dirPath } = req.query;
        const ref = branch ? `?ref=${encodeURIComponent(branch)}` : '';
        const pathPart = dirPath ? `/${dirPath}` : '';

        const data = await fetchJson(
          `https://api.github.com/repos/${encodeURIComponent(req.params.owner)}/${encodeURIComponent(req.params.repo)}/contents${pathPart}${ref}`,
          githubHeaders(conn.pat)
        );

        const entries = (Array.isArray(data) ? data : [data]).map(
          (item: { path: string; name: string; type: string; size?: number }) => ({
            path: item.path,
            name: item.name,
            type: item.type === 'dir' ? 'directory' : 'file',
            size: item.size,
          })
        );

        return { data: entries };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(502).send({ error: 'remote_error', message });
      }
    }
  );

  // ÔöÇÔöÇÔöÇ GitHub: Get file content ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  app.get<{
    Params: { connId: string; owner: string; repo: string };
    Querystring: { branch?: string; path: string };
  }>(
    '/connections/:connId/github/repos/:owner/:repo/file-content',
    async (req, reply) => {
      const conn = await getConnection(req.params.connId);
      if (!conn || conn.type !== 'github') {
        return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
      }

      try {
        const { branch, path: filePath } = req.query;
        const ref = branch ? `?ref=${encodeURIComponent(branch)}` : '';

        const data = await fetchJson(
          `https://api.github.com/repos/${encodeURIComponent(req.params.owner)}/${encodeURIComponent(req.params.repo)}/contents/${filePath}${ref}`,
          githubHeaders(conn.pat)
        );

        const fileData = data as { content?: string; sha: string; encoding?: string };
        let content: string;

        if (fileData.encoding === 'base64' && fileData.content) {
          content = Buffer.from(fileData.content, 'base64').toString('utf-8');
        } else {
          content = fileData.content ?? '';
        }

        return { data: { path: filePath, content, sha: fileData.sha } };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(502).send({ error: 'remote_error', message });
      }
    }
  );

  // ÔöÇÔöÇÔöÇ GitHub: Commit file ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  app.post<{
    Params: { connId: string; owner: string; repo: string };
    Body: { branch: string; path: string; content: string; message: string; sha: string };
  }>(
    '/connections/:connId/github/repos/:owner/:repo/commit',
    async (req, reply) => {
      const conn = await getConnection(req.params.connId);
      if (!conn || conn.type !== 'github') {
        return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
      }

      try {
        const { branch, path: filePath, content, message, sha } = req.body;

        const result = await fetchJsonWithInit(
          `https://api.github.com/repos/${encodeURIComponent(req.params.owner)}/${encodeURIComponent(req.params.repo)}/contents/${filePath}`,
          {
            method: 'PUT',
            headers: githubHeaders(conn.pat),
            body: JSON.stringify({
              message,
              content: Buffer.from(content, 'utf-8').toString('base64'),
              sha,
              branch,
            }),
          }
        );

        return {
          data: {
            success: true,
            commitSha: result.commit?.sha,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(502).send({ error: 'remote_error', message });
      }
    }
  );

  // ÔöÇÔöÇÔöÇ GitHub: Create branch ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  app.post<{
    Params: { connId: string; owner: string; repo: string };
    Body: { name: string; sourceBranch: string };
  }>(
    '/connections/:connId/github/repos/:owner/:repo/branches',
    async (req, reply) => {
      const conn = await getConnection(req.params.connId);
      if (!conn || conn.type !== 'github') {
        return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
      }

      try {
        const { name, sourceBranch } = req.body;

        // Get source branch SHA
        const refData = await fetchJson(
          `https://api.github.com/repos/${encodeURIComponent(req.params.owner)}/${encodeURIComponent(req.params.repo)}/git/ref/heads/${encodeURIComponent(sourceBranch)}`,
          githubHeaders(conn.pat)
        );

        const sourceSha = (refData as { object: { sha: string } }).object.sha;

        const result = await fetchJsonWithInit(
          `https://api.github.com/repos/${encodeURIComponent(req.params.owner)}/${encodeURIComponent(req.params.repo)}/git/refs`,
          {
            method: 'POST',
            headers: githubHeaders(conn.pat),
            body: JSON.stringify({
              ref: `refs/heads/${name}`,
              sha: sourceSha,
            }),
          }
        );

        return reply.status(201).send({ data: { success: true, ref: result } });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(502).send({ error: 'remote_error', message });
      }
    }
  );

  // ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
  // Azure DevOps: Work Items
  // ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

  // ÔöÇÔöÇÔöÇ ADO: Search work items ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  app.get<{
    Params: { connId: string; project: string };
    Querystring: { q?: string; top?: string };
  }>(
    '/connections/:connId/azure/projects/:project/work-items/search',
    async (req, reply) => {
      const conn = await getConnection(req.params.connId);
      if (!conn || conn.type !== 'azure-devops') {
        return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
      }

      try {
        const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';
        const q = req.query.q ?? '';
        const top = Math.min(parseInt(req.query.top ?? '20', 10), 50);
        const project = req.params.project;

        const whereClause = q.trim()
          ? `[System.TeamProject] = '${project}' AND ([System.Title] CONTAINS '${q.replace(/'/g, "''")}' OR [System.Id] = '${parseInt(q, 10) || 0}')`
          : `[System.TeamProject] = '${project}'`;

        const wiql = {
          query: `SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType] FROM WorkItems WHERE ${whereClause} ORDER BY [System.ChangedDate] DESC`,
        };

        const wiqlRes = await fetchJsonWithInit<{ workItems?: Array<{ id: number; url: string }> }>(
          `${baseUrl}/${encodeURIComponent(project)}/_apis/wit/wiql?$top=${top}&api-version=7.1`,
          { method: 'POST', headers: azureHeaders(conn.pat), body: JSON.stringify(wiql) }
        );

        const ids = (wiqlRes.workItems ?? []).slice(0, top).map((w) => w.id);
        if (ids.length === 0) return { data: [] };

        const batchRes = await fetchJson<{ value: Array<{ id: number; fields: Record<string, string> }> }>(
          `${baseUrl}/_apis/wit/workitems?ids=${ids.join(',')}&fields=System.Id,System.Title,System.State,System.WorkItemType&api-version=7.1`,
          azureHeaders(conn.pat)
        );

        const items = (batchRes.value ?? []).map((wi) => ({
          id: wi.id,
          title: wi.fields['System.Title'],
          state: wi.fields['System.State'],
          type: wi.fields['System.WorkItemType'],
        }));

        return { data: items };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(502).send({ error: 'remote_error', message });
      }
    }
  );

  // ÔöÇÔöÇÔöÇ ADO: Create work item ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  app.post<{
    Params: { connId: string; project: string; type: string };
    Body: { title: string; description?: string };
  }>(
    '/connections/:connId/azure/projects/:project/work-items/:type',
    async (req, reply) => {
      const conn = await getConnection(req.params.connId);
      if (!conn || conn.type !== 'azure-devops') {
        return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
      }

      try {
        const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';
        const { title, description } = req.body;
        const patch = [
          { op: 'add', path: '/fields/System.Title', value: title },
          ...(description ? [{ op: 'add', path: '/fields/System.Description', value: description }] : []),
        ];

        const result = await fetchJsonWithInit<{ id: number; fields: Record<string, string> }>(
          `${baseUrl}/${encodeURIComponent(req.params.project)}/_apis/wit/workitems/$${encodeURIComponent(req.params.type)}?api-version=7.1`,
          {
            method: 'POST',
            headers: {
              Authorization: `Basic ${Buffer.from(`:${conn.pat}`).toString('base64')}`,
              'Content-Type': 'application/json-patch+json',
            },
            body: JSON.stringify(patch),
          }
        );

        return reply.status(201).send({
          data: {
            id: result.id,
            title: result.fields['System.Title'],
            state: result.fields['System.State'],
            type: result.fields['System.WorkItemType'],
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(502).send({ error: 'remote_error', message });
      }
    }
  );

  // ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
  // Azure DevOps: Pull Requests
  // ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

  // ÔöÇÔöÇÔöÇ ADO: Create Pull Request ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  app.post<{
    Params: { connId: string; project: string; repoId: string };
    Body: {
      title: string;
      description?: string;
      sourceBranch: string;
      targetBranch: string;
      workItemIds?: number[];
    };
  }>(
    '/connections/:connId/azure/projects/:project/repos/:repoId/pull-requests',
    async (req, reply) => {
      const conn = await getConnection(req.params.connId);
      if (!conn || conn.type !== 'azure-devops') {
        return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
      }

      try {
        const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';
        const { title, description, sourceBranch, targetBranch, workItemIds } = req.body;

        const body: Record<string, unknown> = {
          title,
          description: description ?? '',
          sourceRefName: `refs/heads/${sourceBranch}`,
          targetRefName: `refs/heads/${targetBranch}`,
        };

        if (workItemIds && workItemIds.length > 0) {
          body.workItemRefs = workItemIds.map((id) => ({
            id: String(id),
            url: `${baseUrl}/_apis/wit/workitems/${id}`,
          }));
        }

        const result = await fetchJsonWithInit<{
          pullRequestId: number;
          title: string;
          status: string;
          _links?: { web?: { href?: string } };
        }>(
          `${baseUrl}/${encodeURIComponent(req.params.project)}/_apis/git/repositories/${encodeURIComponent(req.params.repoId)}/pullrequests?api-version=7.1`,
          { method: 'POST', headers: azureHeaders(conn.pat), body: JSON.stringify(body) }
        );

        return reply.status(201).send({
          data: {
            prId: result.pullRequestId,
            title: result.title,
            status: result.status,
            webUrl: result._links?.web?.href,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(502).send({ error: 'remote_error', message });
      }
    }
  );

  // ÔöÇÔöÇÔöÇ ADO: Get Pull Request status ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  app.get<{
    Params: { connId: string; project: string; repoId: string; prId: string };
  }>(
    '/connections/:connId/azure/projects/:project/repos/:repoId/pull-requests/:prId',
    async (req, reply) => {
      const conn = await getConnection(req.params.connId);
      if (!conn || conn.type !== 'azure-devops') {
        return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
      }

      try {
        const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';
        const result = await fetchJson<{
          pullRequestId: number;
          title: string;
          status: string;
          createdBy?: { displayName?: string };
          creationDate?: string;
          closedDate?: string;
          _links?: { web?: { href?: string } };
        }>(
          `${baseUrl}/${encodeURIComponent(req.params.project)}/_apis/git/repositories/${encodeURIComponent(req.params.repoId)}/pullrequests/${encodeURIComponent(req.params.prId)}?api-version=7.1`,
          azureHeaders(conn.pat)
        );

        return {
          data: {
            prId: result.pullRequestId,
            title: result.title,
            status: result.status, // active | completed | abandoned
            createdBy: result.createdBy?.displayName,
            createdAt: result.creationDate,
            closedAt: result.closedDate,
            webUrl: result._links?.web?.href,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(502).send({ error: 'remote_error', message });
      }
    }
  );

  // ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
  // GitHub: Pull Requests
  // ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

  // ÔöÇÔöÇÔöÇ GitHub: Create Pull Request ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  app.post<{
    Params: { connId: string; owner: string; repo: string };
    Body: { title: string; description?: string; sourceBranch: string; targetBranch: string };
  }>(
    '/connections/:connId/github/repos/:owner/:repo/pull-requests',
    async (req, reply) => {
      const conn = await getConnection(req.params.connId);
      if (!conn || conn.type !== 'github') {
        return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
      }

      try {
        const { title, description, sourceBranch, targetBranch } = req.body;
        const result = await fetchJsonWithInit<{
          number: number;
          title: string;
          state: string;
          html_url: string;
        }>(
          `https://api.github.com/repos/${encodeURIComponent(req.params.owner)}/${encodeURIComponent(req.params.repo)}/pulls`,
          {
            method: 'POST',
            headers: githubHeaders(conn.pat),
            body: JSON.stringify({ title, body: description ?? '', head: sourceBranch, base: targetBranch }),
          }
        );

        return reply.status(201).send({
          data: { prId: result.number, title: result.title, status: result.state, webUrl: result.html_url },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(502).send({ error: 'remote_error', message });
      }
    }
  );

  // ÔöÇÔöÇÔöÇ GitHub: Get Pull Request status ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  app.get<{
    Params: { connId: string; owner: string; repo: string; prId: string };
  }>(
    '/connections/:connId/github/repos/:owner/:repo/pull-requests/:prId',
    async (req, reply) => {
      const conn = await getConnection(req.params.connId);
      if (!conn || conn.type !== 'github') {
        return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
      }

      try {
        const result = await fetchJson<{
          number: number;
          title: string;
          state: string;
          merged: boolean;
          html_url: string;
          user?: { login: string };
          created_at: string;
          closed_at?: string;
        }>(
          `https://api.github.com/repos/${encodeURIComponent(req.params.owner)}/${encodeURIComponent(req.params.repo)}/pulls/${encodeURIComponent(req.params.prId)}`,
          githubHeaders(conn.pat)
        );

        return {
          data: {
            prId: result.number,
            title: result.title,
            status: result.merged ? 'completed' : result.state, // map to same shape as ADO
            createdBy: result.user?.login,
            createdAt: result.created_at,
            closedAt: result.closed_at,
            webUrl: result.html_url,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(502).send({ error: 'remote_error', message });
      }
    }
  );

  // ÔöÇÔöÇÔöÇ ADO: Search project members (for reviewer assignment) ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  app.get<{
    Params: { connId: string; project: string };
    Querystring: { q?: string };
  }>(
    '/connections/:connId/azure/projects/:project/members/search',
    async (req, reply) => {
      const conn = await getConnection(req.params.connId);
      if (!conn || conn.type !== 'azure-devops') {
        return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
      }

      try {
        const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';
        const q = req.query.q ?? '';

        // Derive vssps base URL (handles both dev.azure.com and legacy *.visualstudio.com)
        let vsspsBase: string;
        const devAzureMatch = /https:\/\/dev\.azure\.com\/([^/]+)/.exec(baseUrl);
        const vstsMatch = /https:\/\/([^.]+)\.visualstudio\.com/.exec(baseUrl);
        if (devAzureMatch) {
          vsspsBase = `https://vssps.dev.azure.com/${devAzureMatch[1]}`;
        } else if (vstsMatch) {
          vsspsBase = `https://${vstsMatch[1]}.vssps.visualstudio.com`;
        } else {
          vsspsBase = baseUrl;
        }

        const data = await fetchJson<{ value?: Array<{ id: string; providerDisplayName: string; subjectDescriptor?: string }> }>(
          `${vsspsBase}/_apis/identities?searchFilter=General&filterValue=${encodeURIComponent(q)}&queryMembership=None&api-version=7.1`,
          azureHeaders(conn.pat)
        );

        const members = (data.value ?? [])
          .filter((m) => m.providerDisplayName && !m.providerDisplayName.startsWith('['))
          .map((m) => ({ id: m.id, name: m.providerDisplayName }));

        return { data: members };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(502).send({ error: 'remote_error', message });
      }
    }
  );

  // ÔöÇÔöÇÔöÇ ADO: Vote on Pull Request ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  app.put<{
    Params: { connId: string; project: string; repoId: string; prId: string };
    Body: { vote: number }; // 10=approved, 5=approved w/ suggestions, 0=none, -5=waiting, -10=rejected
  }>(
    '/connections/:connId/azure/projects/:project/repos/:repoId/pull-requests/:prId/vote',
    async (req, reply) => {
      const conn = await getConnection(req.params.connId);
      if (!conn || conn.type !== 'azure-devops') {
        return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
      }

      try {
        const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';

        // Resolve current user's ADO identity ID via profile API
        const profile = await fetchJson<{ id: string }>(
          'https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1',
          azureHeaders(conn.pat)
        );
        const userId = profile.id;

        const result = await fetchJsonWithInit<{ id: string; vote: number; displayName?: string }>(
          `${baseUrl}/${encodeURIComponent(req.params.project)}/_apis/git/repositories/${encodeURIComponent(req.params.repoId)}/pullRequests/${encodeURIComponent(req.params.prId)}/reviewers/${userId}?api-version=7.1`,
          { method: 'PUT', headers: azureHeaders(conn.pat), body: JSON.stringify({ vote: req.body.vote }) }
        );

        return { data: { vote: result.vote, reviewerId: result.id } };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(502).send({ error: 'remote_error', message });
      }
    }
  );

  // ÔöÇÔöÇÔöÇ ADO: Post comment thread on Pull Request ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  app.post<{
    Params: { connId: string; project: string; repoId: string; prId: string };
    Body: { content: string };
  }>(
    '/connections/:connId/azure/projects/:project/repos/:repoId/pull-requests/:prId/threads',
    async (req, reply) => {
      const conn = await getConnection(req.params.connId);
      if (!conn || conn.type !== 'azure-devops') {
        return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
      }

      try {
        const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';
        const result = await fetchJsonWithInit<{ id: number }>(
          `${baseUrl}/${encodeURIComponent(req.params.project)}/_apis/git/repositories/${encodeURIComponent(req.params.repoId)}/pullRequests/${encodeURIComponent(req.params.prId)}/threads?api-version=7.1`,
          {
            method: 'POST',
            headers: azureHeaders(conn.pat),
            body: JSON.stringify({
              comments: [{ parentCommentId: 0, content: req.body.content, commentType: 1 }],
              status: 1,
            }),
          }
        );

        return reply.status(201).send({ data: { threadId: result.id } });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(502).send({ error: 'remote_error', message });
      }
    }
  );

  // ÔöÇÔöÇÔöÇ GitHub: Submit Pull Request review ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  app.post<{
    Params: { connId: string; owner: string; repo: string; prId: string };
    Body: { event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'; body?: string };
  }>(
    '/connections/:connId/github/repos/:owner/:repo/pull-requests/:prId/review',
    async (req, reply) => {
      const conn = await getConnection(req.params.connId);
      if (!conn || conn.type !== 'github') {
        return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
      }

      try {
        const result = await fetchJsonWithInit<{ id: number; state: string; html_url: string }>(
          `https://api.github.com/repos/${encodeURIComponent(req.params.owner)}/${encodeURIComponent(req.params.repo)}/pulls/${encodeURIComponent(req.params.prId)}/reviews`,
          {
            method: 'POST',
            headers: githubHeaders(conn.pat),
            body: JSON.stringify({ event: req.body.event, body: req.body.body ?? '' }),
          }
        );

        return reply.status(201).send({ data: { id: result.id, state: result.state, url: result.html_url } });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(502).send({ error: 'remote_error', message });
      }
    }
  );

  // ÔöÇÔöÇÔöÇ ADO: List work items linked to a Pull Request ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  app.get<{
    Params: { connId: string; project: string; repoId: string; prId: string };
  }>(
    '/connections/:connId/azure/projects/:project/repos/:repoId/pull-requests/:prId/work-items',
    async (req, reply) => {
      const conn = await getConnection(req.params.connId);
      if (!conn || conn.type !== 'azure-devops') {
        return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
      }

      try {
        const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';
        const refs = await fetchJson<{ value?: Array<{ id: number; url: string }> }>(
          `${baseUrl}/${encodeURIComponent(req.params.project)}/_apis/git/repositories/${encodeURIComponent(req.params.repoId)}/pullRequests/${encodeURIComponent(req.params.prId)}/workitems?api-version=7.1`,
          azureHeaders(conn.pat)
        );

        const ids = (refs.value ?? []).map((w) => w.id);
        if (ids.length === 0) return { data: [] };

        const details = await fetchJson<{ value?: Array<{ id: number; fields: Record<string, string> }> }>(
          `${baseUrl}/_apis/wit/workitems?ids=${ids.join(',')}&fields=System.Id,System.Title,System.State,System.WorkItemType&api-version=7.1`,
          azureHeaders(conn.pat)
        );

        const items = (details.value ?? []).map((wi) => ({
          id: wi.id,
          title: wi.fields['System.Title'],
          state: wi.fields['System.State'],
          type: wi.fields['System.WorkItemType'],
          url: `${baseUrl}/${encodeURIComponent(req.params.project)}/_workitems/edit/${wi.id}`,
        }));

        return { data: items };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(502).send({ error: 'remote_error', message });
      }
    }
  );

  // ÔöÇÔöÇÔöÇ ADO: Link a work item to a Pull Request ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  app.post<{
    Params: { connId: string; project: string; repoId: string; prId: string };
    Body: { workItemId: number };
  }>(
    '/connections/:connId/azure/projects/:project/repos/:repoId/pull-requests/:prId/work-items',
    async (req, reply) => {
      const conn = await getConnection(req.params.connId);
      if (!conn || conn.type !== 'azure-devops') {
        return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
      }

      try {
        const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';
        const { workItemId } = req.body;

        // Fetch current PR to get existing workItemRefs
        const pr = await fetchJson<{ workItemRefs?: Array<{ id: string; url: string }> }>(
          `${baseUrl}/${encodeURIComponent(req.params.project)}/_apis/git/repositories/${encodeURIComponent(req.params.repoId)}/pullRequests/${encodeURIComponent(req.params.prId)}?api-version=7.1`,
          azureHeaders(conn.pat)
        );

        const existing = pr.workItemRefs ?? [];
        const alreadyLinked = existing.some((r) => String(r.id) === String(workItemId));
        if (alreadyLinked) {
          return reply.status(409).send({ error: 'conflict', message: 'Work item already linked' });
        }

        const updated = [
          ...existing,
          { id: String(workItemId), url: `${baseUrl}/_apis/wit/workItems/${workItemId}` },
        ];

        await fetchJsonWithInit(
          `${baseUrl}/${encodeURIComponent(req.params.project)}/_apis/git/repositories/${encodeURIComponent(req.params.repoId)}/pullRequests/${encodeURIComponent(req.params.prId)}?api-version=7.1`,
          { method: 'PATCH', headers: azureHeaders(conn.pat), body: JSON.stringify({ workItemRefs: updated }) }
        );

        return reply.status(201).send({ data: { workItemId } });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(502).send({ error: 'remote_error', message });
      }
    }
  );

  // ÔöÇÔöÇÔöÇ ADO: Unlink a work item from a Pull Request ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  app.delete<{
    Params: { connId: string; project: string; repoId: string; prId: string; wiId: string };
  }>(
    '/connections/:connId/azure/projects/:project/repos/:repoId/pull-requests/:prId/work-items/:wiId',
    async (req, reply) => {
      const conn = await getConnection(req.params.connId);
      if (!conn || conn.type !== 'azure-devops') {
        return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
      }

      try {
        const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';

        const pr = await fetchJson<{ workItemRefs?: Array<{ id: string; url: string }> }>(
          `${baseUrl}/${encodeURIComponent(req.params.project)}/_apis/git/repositories/${encodeURIComponent(req.params.repoId)}/pullRequests/${encodeURIComponent(req.params.prId)}?api-version=7.1`,
          azureHeaders(conn.pat)
        );

        const filtered = (pr.workItemRefs ?? []).filter((r) => String(r.id) !== String(req.params.wiId));

        await fetchJsonWithInit(
          `${baseUrl}/${encodeURIComponent(req.params.project)}/_apis/git/repositories/${encodeURIComponent(req.params.repoId)}/pullRequests/${encodeURIComponent(req.params.prId)}?api-version=7.1`,
          { method: 'PATCH', headers: azureHeaders(conn.pat), body: JSON.stringify({ workItemRefs: filtered }) }
        );

        return reply.status(200).send({ data: { success: true } });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(502).send({ error: 'remote_error', message });
      }
    }
  );

  // ÔöÇÔöÇÔöÇ ADO: Get Pull Request diff (changed files + patches) ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  app.get<{
    Params: { connId: string; project: string; repoId: string; prId: string };
  }>(
    '/connections/:connId/azure/projects/:project/repos/:repoId/pull-requests/:prId/diff',
    async (req, reply) => {
      const conn = await getConnection(req.params.connId);
      if (!conn || conn.type !== 'azure-devops') {
        return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
      }

      try {
        const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';
        const { project, repoId, prId } = req.params;
        const repoEnc = encodeURIComponent(repoId);
        const projEnc = encodeURIComponent(project);

        // Get PR details to obtain source/target commit SHAs
        const pr = await fetchJson<{
          lastMergeSourceCommit?: { commitId: string };
          lastMergeTargetCommit?: { commitId: string };
          title?: string;
          description?: string;
        }>(
          `${baseUrl}/${projEnc}/_apis/git/repositories/${repoEnc}/pullRequests/${encodeURIComponent(prId)}?api-version=7.1`,
          azureHeaders(conn.pat)
        );

        // Get latest iteration to enumerate changed files
        const iterations = await fetchJson<{ value?: Array<{ id: number }> }>(
          `${baseUrl}/${projEnc}/_apis/git/repositories/${repoEnc}/pullRequests/${encodeURIComponent(prId)}/iterations?api-version=7.1`,
          azureHeaders(conn.pat)
        );
        const latestIteration = iterations.value?.at(-1);
        if (!latestIteration) {
          return { data: { files: [], prTitle: pr.title, prDescription: pr.description } };
        }

        const changes = await fetchJson<{
          changeEntries?: Array<{
            changeType: string;
            item?: { path?: string; gitObjectType?: string };
          }>;
        }>(
          `${baseUrl}/${projEnc}/_apis/git/repositories/${repoEnc}/pullRequests/${encodeURIComponent(prId)}/iterations/${latestIteration.id}/changes?$top=100&api-version=7.1`,
          azureHeaders(conn.pat)
        );

        const sourceCommit = pr.lastMergeSourceCommit?.commitId;
        const targetCommit = pr.lastMergeTargetCommit?.commitId;

        const fileEntries = (changes.changeEntries ?? []).filter(
          (c) => c.item?.gitObjectType === 'blob' && c.item?.path
        );

        // Fetch diff blocks for each file (up to 20 files)
        const fileDiffs = await Promise.all(
          fileEntries.slice(0, 20).map(async (entry) => {
            const filePath = entry.item!.path!;
            let patch: string | undefined;

            if (sourceCommit && targetCommit && entry.changeType !== 'delete') {
              try {
                const diffData = await fetchJson<{
                  blocks?: Array<{
                    changeType: number;
                    mModifiedStart: number;
                    mModifiedCount: number;
                    mOriginalStart: number;
                    mOriginalCount: number;
                    truncatedDiff: boolean;
                  }>;
                  modifiedFile?: { path: string };
                }>(
                  `${baseUrl}/${projEnc}/_apis/git/repositories/${repoEnc}/diffs/commits?baseVersionType=commit&baseVersion=${encodeURIComponent(targetCommit)}&targetVersionType=commit&targetVersion=${encodeURIComponent(sourceCommit)}&path=${encodeURIComponent(filePath)}&api-version=7.1`,
                  azureHeaders(conn.pat)
                );
                // Format as summary (blocks have no line content from this endpoint)
                if (diffData.blocks?.length) {
                  const adds = diffData.blocks.filter((b) => b.changeType === 2).reduce((s, b) => s + b.mModifiedCount, 0);
                  const dels = diffData.blocks.filter((b) => b.changeType === 3).reduce((s, b) => s + b.mOriginalCount, 0);
                  patch = `@@ +${adds} lines added, -${dels} lines removed @@`;
                }
              } catch {
                // non-fatal; diff summary is optional
              }
            }

            return { path: filePath, changeType: entry.changeType, patch };
          })
        );

        return {
          data: {
            files: fileDiffs,
            prTitle: pr.title,
            prDescription: pr.description,
            totalFiles: fileEntries.length,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(502).send({ error: 'remote_error', message });
      }
    }
  );

  // ÔöÇÔöÇÔöÇ GitHub: Get Pull Request diff (changed files + patches) ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  app.get<{
    Params: { connId: string; owner: string; repo: string; prId: string };
  }>(
    '/connections/:connId/github/repos/:owner/:repo/pull-requests/:prId/diff',
    async (req, reply) => {
      const conn = await getConnection(req.params.connId);
      if (!conn || conn.type !== 'github') {
        return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
      }

      try {
        // Get PR metadata (title, description)
        const prMeta = await fetchJson<{
          title?: string;
          body?: string;
          head?: { sha: string };
          base?: { sha: string };
        }>(
          `https://api.github.com/repos/${encodeURIComponent(req.params.owner)}/${encodeURIComponent(req.params.repo)}/pulls/${encodeURIComponent(req.params.prId)}`,
          githubHeaders(conn.pat)
        );

        // Get changed files (returns up to 300 files, paginate if needed)
        const files = await fetchJson<
          Array<{
            filename: string;
            status: string;
            additions: number;
            deletions: number;
            changes: number;
            patch?: string;
          }>
        >(
          `https://api.github.com/repos/${encodeURIComponent(req.params.owner)}/${encodeURIComponent(req.params.repo)}/pulls/${encodeURIComponent(req.params.prId)}/files?per_page=100`,
          githubHeaders(conn.pat)
        );

        const mapped = files.map((f) => ({
          path: f.filename,
          changeType: f.status, // 'added' | 'removed' | 'modified' | 'renamed'
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch ? f.patch.slice(0, 4000) : undefined, // cap patch size
        }));

        return {
          data: {
            files: mapped,
            prTitle: prMeta.title,
            prDescription: prMeta.body,
            totalFiles: files.length,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(502).send({ error: 'remote_error', message });
      }
    }
  );

  // ─── ADO: Push XLIFF as new branch + PR (composite) ──────────────────────
  app.post<{
    Params: { connId: string; project: string; repoId: string };
    Body: {
      xliffFileId: string;
      branchName: string;
      prTitle: string;
      targetBranch: string;
      prDescription?: string;
      commitMessage?: string;
    };
  }>(
    '/connections/:connId/azure/projects/:project/repos/:repoId/push-xliff',
    async (req, reply) => {
      const conn = await getConnection(req.params.connId);
      if (!conn || conn.type !== 'azure-devops') {
        return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
      }

      try {
        const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';
        const { xliffFileId, branchName, prTitle, targetBranch, prDescription, commitMessage } = req.body;

        // 1. Fetch XLIFF content from database
        const file = await prisma.xliffFile.findUnique({ where: { id: xliffFileId } });
        if (!file) {
          return reply.status(404).send({ error: 'not_found', message: 'XLIFF file not found' });
        }
        if (!file.remotePath) {
          return reply.status(400).send({ error: 'no_remote_path', message: 'File has no remote path configured' });
        }
        const translations = await prisma.translation.findMany({ where: { xliffFileId: file.id } });
        const xliffUpdates = new Map(
          translations.map((t) => [t.unitId, { target: t.target, state: t.state as TranslationState }])
        );
        const content = serializeXliff(file.originalXml, xliffUpdates);

        // 2. Get source branch ref SHA
        const refsData = await fetchJson(
          `${baseUrl}/${encodeURIComponent(req.params.project)}/_apis/git/repositories/${encodeURIComponent(req.params.repoId)}/refs?filter=heads/${encodeURIComponent(targetBranch)}&api-version=7.1`,
          azureHeaders(conn.pat)
        );
        const sourceRef = refsData.value?.[0];
        if (!sourceRef) {
          return reply.status(400).send({ error: 'branch_not_found', message: `Branch '${targetBranch}' not found` });
        }

        // 3. Create new branch from source branch
        await fetchJsonWithInit(
          `${baseUrl}/${encodeURIComponent(req.params.project)}/_apis/git/repositories/${encodeURIComponent(req.params.repoId)}/refs?api-version=7.1`,
          {
            method: 'POST',
            headers: azureHeaders(conn.pat),
            body: JSON.stringify([{
              name: `refs/heads/${branchName}`,
              oldObjectId: '0000000000000000000000000000000000000000',
              newObjectId: sourceRef.objectId,
            }]),
          }
        );

        // 4. Get new branch ref for commit (needed as oldObjectId)
        const newBranchRefs = await fetchJson(
          `${baseUrl}/${encodeURIComponent(req.params.project)}/_apis/git/repositories/${encodeURIComponent(req.params.repoId)}/refs?filter=heads/${encodeURIComponent(branchName)}&api-version=7.1`,
          azureHeaders(conn.pat)
        );
        const newBranchRef = newBranchRefs.value?.[0];
        if (!newBranchRef) {
          return reply.status(500).send({ error: 'branch_create_failed', message: 'Failed to find newly created branch' });
        }

        // 5. Commit XLIFF to new branch
        await fetchJsonWithInit(
          `${baseUrl}/${encodeURIComponent(req.params.project)}/_apis/git/repositories/${encodeURIComponent(req.params.repoId)}/pushes?api-version=7.1`,
          {
            method: 'POST',
            headers: azureHeaders(conn.pat),
            body: JSON.stringify({
              refUpdates: [{ name: `refs/heads/${branchName}`, oldObjectId: newBranchRef.objectId }],
              commits: [{
                comment: commitMessage ?? prTitle,
                changes: [{
                  changeType: 'edit',
                  item: { path: file.remotePath },
                  newContent: { content, contentType: 'rawtext' },
                }],
              }],
            }),
          }
        );

        // 6. Create PR
        const prResult = await fetchJsonWithInit<{
          pullRequestId: number;
          title: string;
          status: string;
          _links?: { web?: { href?: string } };
        }>(
          `${baseUrl}/${encodeURIComponent(req.params.project)}/_apis/git/repositories/${encodeURIComponent(req.params.repoId)}/pullrequests?api-version=7.1`,
          {
            method: 'POST',
            headers: azureHeaders(conn.pat),
            body: JSON.stringify({
              title: prTitle,
              description: prDescription ?? '',
              sourceRefName: `refs/heads/${branchName}`,
              targetRefName: `refs/heads/${targetBranch}`,
            }),
          }
        );

        return reply.status(201).send({
          data: { prId: prResult.pullRequestId, prUrl: prResult._links?.web?.href, branchName },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(502).send({ error: 'remote_error', message });
      }
    }
  );

  // ─── GitHub: Push XLIFF as new branch + PR (composite) ───────────────────
  app.post<{
    Params: { connId: string; owner: string; repo: string };
    Body: {
      xliffFileId: string;
      branchName: string;
      prTitle: string;
      targetBranch: string;
      prDescription?: string;
      commitMessage?: string;
    };
  }>(
    '/connections/:connId/github/repos/:owner/:repo/push-xliff',
    async (req, reply) => {
      const conn = await getConnection(req.params.connId);
      if (!conn || conn.type !== 'github') {
        return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
      }

      try {
        const { xliffFileId, branchName, prTitle, targetBranch, prDescription, commitMessage } = req.body;
        const { owner, repo } = req.params;

        // 1. Fetch XLIFF content from database
        const file = await prisma.xliffFile.findUnique({ where: { id: xliffFileId } });
        if (!file) {
          return reply.status(404).send({ error: 'not_found', message: 'XLIFF file not found' });
        }
        if (!file.remotePath) {
          return reply.status(400).send({ error: 'no_remote_path', message: 'File has no remote path configured' });
        }
        const translations = await prisma.translation.findMany({ where: { xliffFileId: file.id } });
        const xliffUpdates = new Map(
          translations.map((t) => [t.unitId, { target: t.target, state: t.state as TranslationState }])
        );
        const content = serializeXliff(file.originalXml, xliffUpdates);

        // 2. Get source branch SHA
        const refData = await fetchJson<{ object: { sha: string } }>(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(targetBranch)}`,
          githubHeaders(conn.pat)
        );
        const sourceSha = refData.object.sha;

        // 3. Create new branch
        await fetchJsonWithInit(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`,
          {
            method: 'POST',
            headers: githubHeaders(conn.pat),
            body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: sourceSha }),
          }
        );

        // 4. Get current file SHA (required for GitHub PUT to update an existing file)
        let fileSha: string | undefined;
        try {
          const fileData = await fetchJson<{ sha: string }>(
            `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${file.remotePath}?ref=${encodeURIComponent(branchName)}`,
            githubHeaders(conn.pat)
          );
          fileSha = fileData.sha;
        } catch {
          // File doesn't exist on the branch yet — omit sha to create it
        }

        // 5. Commit XLIFF to new branch
        await fetchJsonWithInit(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${file.remotePath}`,
          {
            method: 'PUT',
            headers: githubHeaders(conn.pat),
            body: JSON.stringify({
              message: commitMessage ?? prTitle,
              content: Buffer.from(content, 'utf-8').toString('base64'),
              sha: fileSha,
              branch: branchName,
            }),
          }
        );

        // 6. Create PR
        const prResult = await fetchJsonWithInit<{ number: number; title: string; state: string; html_url: string }>(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
          {
            method: 'POST',
            headers: githubHeaders(conn.pat),
            body: JSON.stringify({ title: prTitle, body: prDescription ?? '', head: branchName, base: targetBranch }),
          }
        );

        return reply.status(201).send({
          data: { prId: prResult.number, prUrl: prResult.html_url, branchName },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(502).send({ error: 'remote_error', message });
      }
    }
  );
}
