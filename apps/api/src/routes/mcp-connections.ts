import type { FastifyInstance } from 'fastify';
import { prisma } from '@nexus/db';
import { encryptToken, decryptToken } from '../lib/crypto';

const VALID_TYPES = ['wiki_js', 'azure_devops_wiki', 'github', 'azure_devops', 'custom', 'teams_recorder'] as const;

function stripCredentials(conn: any) {
  const { encryptedCredential, credentialIv, credentialTag, ...safe } = conn;
  return safe;
}

export async function mcpConnectionRoutes(app: FastifyInstance) {
  // ─── List MCP connections ─────────────────────────────────────────────────
  app.get<{ Querystring: { customerId?: string; projectId?: string } }>(
    '/',
    async (req) => {
      const where: Record<string, string> = {};
      if (req.query.customerId) where.customerId = req.query.customerId;
      if (req.query.projectId) where.projectId = req.query.projectId;

      const connections = await prisma.mCPConnection.findMany({
        where,
        orderBy: { createdAt: 'desc' },
      });
      return { data: connections.map(stripCredentials) };
    }
  );

  // ─── Get MCP connection ───────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const connection = await prisma.mCPConnection.findUnique({
      where: { id: req.params.id },
    });

    if (!connection) {
      return reply.status(404).send({ error: 'not_found', message: 'MCP connection not found' });
    }

    return { data: stripCredentials(connection) };
  });

  // ─── Create MCP connection ────────────────────────────────────────────────
  app.post<{
    Body: {
      name: string;
      type: string;
      customerId?: string;
      projectId?: string;
      baseUrl?: string;
      authType?: string;
      credential?: string;
      capabilities?: string;
    };
  }>('/', async (req, reply) => {
    const { name, type, customerId, projectId, baseUrl, authType, credential, capabilities } =
      req.body;

    if (!name) {
      return reply.status(400).send({ error: 'validation', message: 'name is required' });
    }

    if (!type) {
      return reply.status(400).send({ error: 'validation', message: 'type is required' });
    }

    if (!VALID_TYPES.includes(type as (typeof VALID_TYPES)[number])) {
      return reply.status(400).send({
        error: 'validation',
        message: `type must be one of: ${VALID_TYPES.join(', ')}`,
      });
    }

    let encryptedCredential: string | undefined;
    let credentialIv: string | undefined;
    let credentialTag: string | undefined;
    if (credential) {
      const enc = encryptToken(credential);
      encryptedCredential = enc.encrypted;
      credentialIv = enc.iv;
      credentialTag = enc.tag;
    }

    const connection = await prisma.mCPConnection.create({
      data: {
        name,
        type,
        customerId,
        projectId,
        baseUrl: baseUrl?.trim(),
        authType,
        encryptedCredential,
        credentialIv,
        credentialTag,
        capabilities,
      },
    });

    return reply.status(201).send({ data: stripCredentials(connection) });
  });

  // ─── Update MCP connection ────────────────────────────────────────────────
  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      type?: string;
      customerId?: string;
      projectId?: string;
      baseUrl?: string;
      authType?: string;
      credential?: string;
      capabilities?: string;
    };
  }>('/:id', async (req, reply) => {
    const { credential, ...rest } = req.body;

    if (rest.type && !VALID_TYPES.includes(rest.type as (typeof VALID_TYPES)[number])) {
      return reply.status(400).send({
        error: 'validation',
        message: `type must be one of: ${VALID_TYPES.join(', ')}`,
      });
    }

    const data: Record<string, unknown> = { ...rest, ...(rest.baseUrl !== undefined && { baseUrl: rest.baseUrl.trim() }) };
    if (credential !== undefined) {
      const enc = encryptToken(credential);
      data.encryptedCredential = enc.encrypted;
      data.credentialIv = enc.iv;
      data.credentialTag = enc.tag;
    }

    const connection = await prisma.mCPConnection.update({
      where: { id: req.params.id },
      data,
    });

    return { data: stripCredentials(connection) };
  });

  // ─── Delete MCP connection ────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    await prisma.mCPConnection.delete({ where: { id: req.params.id } });
    return reply.status(204).send();
  });

  // ─── Test MCP connection ──────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/:id/test', async (req, reply) => {
    const connection = await prisma.mCPConnection.findUnique({
      where: { id: req.params.id },
    });

    if (!connection) {
      return reply.status(404).send({ error: 'not_found', message: 'MCP connection not found' });
    }

    try {
      let credential: string | null = null;
      if (connection.encryptedCredential && connection.credentialIv && connection.credentialTag) {
        credential = decryptToken(connection.encryptedCredential, connection.credentialIv, connection.credentialTag);
      }

      if (connection.type === 'teams_recorder') {
        const mcpPath = connection.baseUrl;
        if (!mcpPath) {
          return { data: { status: 'error', message: 'baseUrl (MCP dist/index.js path) not configured' } };
        }
        try {
          const { listMcpTools } = await import('../lib/mcp-client.js');
          const env: Record<string, string> = {};
          if (credential) env.GITHUB_TOKEN = credential;
          const tools = await listMcpTools('node', [mcpPath], env);
          return { data: { status: 'ok', message: `Connected — ${tools.length} tool(s) available: ${tools.map(t => t.name).join(', ')}` } };
        } catch (err) {
          return { data: { status: 'error', message: err instanceof Error ? err.message : 'Failed to connect to MCP' } };
        }
      }

      if (!credential) {
        return reply.status(400).send({ data: { status: 'error', message: 'No credential configured' } });
      }

      if (connection.type === 'github') {
        const res = await fetch('https://api.github.com/user', {
          headers: { Authorization: `Bearer ${credential}`, Accept: 'application/vnd.github+json' },
        });
        if (!res.ok) {
          const errText = await res.text();
          return { data: { status: 'error', message: `GitHub API returned ${res.status}: ${errText}` } };
        }
        const user = (await res.json()) as { login?: string };
        return { data: { status: 'ok', message: `Connected as ${user.login ?? 'unknown'}` } };
      }

      if (connection.type === 'azure_devops_wiki' || connection.type === 'azure_devops') {
        const baseUrl = connection.baseUrl?.replace(/\/$/, '');
        if (!baseUrl) {
          return { data: { status: 'error', message: 'No baseUrl configured' } };
        }
        const res = await fetch(`${baseUrl}/_apis/projects?api-version=7.1`, {
          headers: {
            Authorization: `Basic ${Buffer.from(':' + credential).toString('base64')}`,
            Accept: 'application/json',
          },
        });
        if (!res.ok) {
          const errText = await res.text();
          return { data: { status: 'error', message: `Azure DevOps API returned ${res.status}: ${errText}` } };
        }
        const body = (await res.json()) as { count?: number };
        return { data: { status: 'ok', message: `Connected — ${body.count ?? 0} project(s) found` } };
      }

      if (connection.type === 'wiki_js') {
        const baseUrl = connection.baseUrl?.replace(/\/$/, '');
        if (!baseUrl) {
          return { data: { status: 'error', message: 'No baseUrl configured' } };
        }
        const res = await fetch(`${baseUrl}/graphql`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${credential}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query: '{ site { title } }' }),
        });
        if (!res.ok) {
          const errText = await res.text();
          return { data: { status: 'error', message: `Wiki.js API returned ${res.status}: ${errText}` } };
        }
        return { data: { status: 'ok', message: 'Connected to Wiki.js' } };
      }

      return { data: { status: 'ok', message: `Connection type '${connection.type}' stored — no adapter test available` } };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { data: { status: 'error', message } };
    }
  });

  // ─── List recordings via MCP ──────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/:id/recordings', async (req, reply) => {
    const connection = await prisma.mCPConnection.findUnique({ where: { id: req.params.id } });
    if (!connection) {
      return reply.status(404).send({ error: 'not_found', message: 'MCP connection not found' });
    }
    if (connection.type !== 'teams_recorder') {
      return reply.status(400).send({ error: 'invalid_type', message: 'Only teams_recorder MCPs support recordings' });
    }

    try {
      let credential: string | null = null;
      if (connection.encryptedCredential && connection.credentialIv && connection.credentialTag) {
        credential = decryptToken(connection.encryptedCredential, connection.credentialIv, connection.credentialTag);
      }

      const mcpPath = connection.baseUrl;
      if (!mcpPath) {
        return reply.status(400).send({ error: 'not_configured', message: 'MCP path not configured (set baseUrl to path of dist/index.js)' });
      }

      const { callMcpTool } = await import('../lib/mcp-client.js');
      const env: Record<string, string> = {};
      if (credential) env.GITHUB_TOKEN = credential;

      const result = await callMcpTool('node', [mcpPath], env, 'list_recordings', {});
      const text = result.content.find(c => c.type === 'text')?.text ?? '[]';

      let recordings: unknown[] = [];
      try { recordings = JSON.parse(text); } catch { recordings = []; }

      return { data: recordings };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(502).send({ error: 'mcp_error', message });
    }
  });
}
