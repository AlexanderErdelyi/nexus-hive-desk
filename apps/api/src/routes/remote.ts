import type { FastifyInstance } from 'fastify';
import { prisma } from '@nexus/db';

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

async function fetchJson(url: string, headers: Record<string, string>) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

async function fetchJsonWithInit(url: string, init: RequestInit) {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function remoteRoutes(app: FastifyInstance) {
  // ─── Azure DevOps: List projects in organization ──────────────────────────
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

  // ─── Azure DevOps: List repos in project ──────────────────────────────────
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

  // ─── Azure DevOps: List branches ──────────────────────────────────────────
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

  // ─── Azure DevOps: List files (tree) ──────────────────────────────────────
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

  // ─── Azure DevOps: Get file content ───────────────────────────────────────
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

        let url = `${baseUrl}/${encodeURIComponent(req.params.project)}/_apis/git/repositories/${encodeURIComponent(req.params.repoId)}/items?path=${encodeURIComponent(filePath)}&api-version=7.1`;
        if (branch) url += `&versionDescriptor.version=${encodeURIComponent(branch)}&versionDescriptor.versionType=branch`;

        // Get as text
        const res = await fetch(url, { headers: azureHeaders(conn.pat) });
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

  // ─── Azure DevOps: Commit file ────────────────────────────────────────────
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

  // ─── Azure DevOps: Create branch ──────────────────────────────────────────
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

  // ═══════════════════════════════════════════════════════════════════════════
  // GitHub Routes
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── GitHub: List repos for authenticated user ────────────────────────────
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

  // ─── GitHub: List orgs ────────────────────────────────────────────────────
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

  // ─── GitHub: List branches ────────────────────────────────────────────────
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

  // ─── GitHub: List files (tree) ────────────────────────────────────────────
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

  // ─── GitHub: Get file content ─────────────────────────────────────────────
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

  // ─── GitHub: Commit file ──────────────────────────────────────────────────
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

  // ─── GitHub: Create branch ────────────────────────────────────────────────
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
}
