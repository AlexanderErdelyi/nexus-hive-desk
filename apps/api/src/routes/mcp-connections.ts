import type { FastifyInstance } from 'fastify';
import { prisma } from '@nexus/db';
import { encryptToken, decryptToken } from '../lib/crypto';

const VALID_TYPES = ['wiki_js', 'azure_devops_wiki', 'github', 'azure_devops', 'custom', 'teams_recorder'] as const;

function stripCredentials(conn: any) {
  const { encryptedCredential, credentialIv, credentialTag, ...safe } = conn;
  return safe;
}

function parseCapabilities(capabilities?: string | null): Record<string, unknown> {
  if (!capabilities) return {};
  try {
    return JSON.parse(capabilities) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseMcpToolResponse(result: { content: Array<{ type: string; text?: string }>; isError?: boolean }) {
  if (result.isError) {
    throw new Error(result.content.find((entry) => entry.type === 'text')?.text ?? 'MCP tool call failed');
  }

  const text = result.content.find((entry) => entry.type === 'text')?.text;
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function getWikiJsConfig(connection: {
  baseUrl?: string | null;
  capabilities?: string | null;
}) {
  const caps = parseCapabilities(connection.capabilities);
  // wikiUrl may be in capabilities.wikiUrl, or fall back to baseUrl (legacy / direct URL storage)
  const wikiUrl = (
    (typeof caps.wikiUrl === 'string' && caps.wikiUrl.trim()) ||
    connection.baseUrl?.trim() ||
    ''
  ).replace(/\/$/, '') || undefined;

  return { wikiUrl };
}

async function wikiJsGraphQL(
  wikiUrl: string,
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${wikiUrl}/graphql`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Wiki.js GraphQL returned ${res.status}: ${errText}`);
  }
  const body = await res.json() as { data?: unknown; errors?: Array<{ extensions?: { code?: number } }> };
  // Code 6003 = PageNotFound — treat as null, not an error
  if (body.errors?.length) {
    const isPageNotFound = body.errors.every(e => e?.extensions?.code === 6003);
    if (!isPageNotFound) throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`);
  }
  return body.data;
}

export async function mcpConnectionRoutes(app: FastifyInstance) {
  // ─── List MCP connections ─────────────────────────────────────────────────
  app.get<{ Querystring: { customerId?: string; projectId?: string; type?: string } }>(
    '/',
    async (req) => {
      const where: Record<string, string> = {};
      if (req.query.customerId) where.customerId = req.query.customerId;
      if (req.query.projectId) where.projectId = req.query.projectId;
      if (req.query.type) where.type = req.query.type;

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
        const { wikiUrl } = getWikiJsConfig(connection);
        const directWikiUrl = wikiUrl;
        if (!directWikiUrl) {
          return { data: { status: 'error', message: 'No Wiki.js URL configured' } };
        }
        const res = await fetch(`${directWikiUrl}/graphql`, {
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

  // ─── Wiki.js pages via direct GraphQL ────────────────────────────────────
  app.get<{
    Params: { id: string };
    Querystring: { query?: string; path?: string; locale?: string };
  }>('/:id/wiki-pages', async (req, reply) => {
    const connection = await prisma.mCPConnection.findUnique({ where: { id: req.params.id } });
    if (!connection) return reply.status(404).send({ error: 'not_found', message: 'MCP connection not found' });
    if (connection.type !== 'wiki_js') return reply.status(400).send({ error: 'invalid_type', message: 'Only wiki_js MCPs support wiki pages' });

    if (!req.query.path?.trim() && !req.query.query?.trim()) return { data: [] };

    let credential: string | null = null;
    if (connection.encryptedCredential && connection.credentialIv && connection.credentialTag) {
      credential = decryptToken(connection.encryptedCredential, connection.credentialIv, connection.credentialTag);
    }
    if (!credential) return reply.status(400).send({ error: 'not_configured', message: 'Wiki.js API key not configured' });

    const { wikiUrl } = getWikiJsConfig(connection);
    if (!wikiUrl) return reply.status(400).send({ error: 'not_configured', message: 'Wiki.js URL not configured (set baseUrl to the wiki URL)' });

    const locale = req.query.locale?.trim() || 'de';

    try {
      if (req.query.path?.trim()) {
        const data = await wikiJsGraphQL(wikiUrl, credential, `
          query GetPage($path: String!, $locale: String!) {
            pages { singleByPath(path: $path, locale: $locale) {
              id path title description content tags { tag } updatedAt
            }}
          }`, { path: req.query.path.trim(), locale }) as Record<string, unknown>;
        const page = (data as any)?.pages?.singleByPath ?? null;
        return { data: page };
      } else {
        const data = await wikiJsGraphQL(wikiUrl, credential, `
          query SearchPages($query: String!, $locale: String!) {
            pages { search(query: $query, locale: $locale) {
              results { id path title description locale } totalHits
            }}
          }`, { query: req.query.query!.trim(), locale }) as Record<string, unknown>;
        const results = (data as any)?.pages?.search?.results ?? [];
        return { data: results };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(502).send({ error: 'wiki_error', message });
    }
  });

  app.post<{
    Params: { id: string };
    Body: { path: string; title: string; content: string; locale?: string; description?: string; tags?: string[] | string };
  }>('/:id/wiki-pages', async (req, reply) => {
    const connection = await prisma.mCPConnection.findUnique({ where: { id: req.params.id } });
    if (!connection) return reply.status(404).send({ error: 'not_found', message: 'MCP connection not found' });
    if (connection.type !== 'wiki_js') return reply.status(400).send({ error: 'invalid_type', message: 'Only wiki_js MCPs support wiki pages' });

    const pagePath = req.body.path?.trim();
    const title = req.body.title?.trim();
    if (!pagePath || !title) return reply.status(400).send({ error: 'validation', message: 'path and title are required' });

    let credential: string | null = null;
    if (connection.encryptedCredential && connection.credentialIv && connection.credentialTag) {
      credential = decryptToken(connection.encryptedCredential, connection.credentialIv, connection.credentialTag);
    }
    if (!credential) return reply.status(400).send({ error: 'not_configured', message: 'Wiki.js API key not configured' });

    const { wikiUrl } = getWikiJsConfig(connection);
    if (!wikiUrl) return reply.status(400).send({ error: 'not_configured', message: 'Wiki.js URL not configured' });

    const tags = Array.isArray(req.body.tags)
      ? req.body.tags.map(t => String(t).trim()).filter(Boolean)
      : typeof req.body.tags === 'string'
        ? req.body.tags.split(',').map(t => t.trim()).filter(Boolean)
        : [];
    const locale = req.body.locale?.trim() || 'de';
    const content = req.body.content ?? '';
    const description = req.body.description?.trim() ?? '';

    try {
      // Check if page exists first
      const existing = await wikiJsGraphQL(wikiUrl, credential, `
        query FindPage($path: String!, $locale: String!) {
          pages { singleByPath(path: $path, locale: $locale) { id } }
        }`, { path: pagePath, locale }) as Record<string, unknown>;
      const existingId = (existing as any)?.pages?.singleByPath?.id as number | undefined;

      let result: unknown;
      if (existingId) {
        result = await wikiJsGraphQL(wikiUrl, credential, `
          mutation UpdatePage($id: Int!, $title: String!, $content: String!, $description: String!, $editor: String!, $isPublished: Boolean!, $locale: String!, $path: String!, $tags: [String]!) {
            pages { update(id: $id, title: $title, content: $content, description: $description, editor: $editor, isPublished: $isPublished, locale: $locale, path: $path, tags: $tags) {
              responseResult { succeeded errorCode message } page { id path title }
            }}
          }`, { id: existingId, title, content, description, editor: 'markdown', isPublished: true, locale, path: pagePath, tags });
      } else {
        result = await wikiJsGraphQL(wikiUrl, credential, `
          mutation CreatePage($title: String!, $content: String!, $description: String!, $editor: String!, $isPublished: Boolean!, $isPrivate: Boolean!, $locale: String!, $path: String!, $tags: [String]!) {
            pages { create(title: $title, content: $content, description: $description, editor: $editor, isPublished: $isPublished, isPrivate: $isPrivate, locale: $locale, path: $path, tags: $tags) {
              responseResult { succeeded errorCode slug message } page { id path title }
            }}
          }`, { title, content, description, editor: 'markdown', isPublished: true, isPrivate: false, locale, path: pagePath, tags });
      }

      return { data: result };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(502).send({ error: 'wiki_error', message });
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

      // Auto-process configured recordings folder before listing
      let caps: Record<string, unknown> = {};
      try { caps = connection.capabilities ? JSON.parse(connection.capabilities) : {}; } catch { /* ignore */ }
      const recordingsFolder = caps.recordingsFolder as string | undefined;

      if (recordingsFolder?.trim()) {
        try {
          await callMcpTool('node', [mcpPath], env, 'process_recording_folder', { folder_path: recordingsFolder.trim() });
        } catch { /* non-fatal — still list what's cached */ }
      }

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
