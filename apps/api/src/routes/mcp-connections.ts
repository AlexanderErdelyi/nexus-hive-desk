import type { FastifyInstance } from 'fastify';
import { prisma } from '@nexus/db';
import { encryptToken, decryptToken } from '../lib/crypto';
import https from 'https';
import axios from 'axios';

// Allow self-signed / internal CA certificates for on-premise services (Wiki.js, etc.)
const tlsAgent = new https.Agent({ rejectUnauthorized: false });

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
  const capUrl = typeof caps.wikiUrl === 'string' ? caps.wikiUrl.trim() : '';
  const baseUrl = connection.baseUrl?.trim() ?? '';

  // Prefer caps.wikiUrl only when it is a valid HTTP URL; otherwise fall back to baseUrl
  const rawUrl = (
    (/^https?:\/\//i.test(capUrl) ? capUrl : '') ||
    (/^https?:\/\//i.test(baseUrl) ? baseUrl : '') ||
    capUrl ||
    baseUrl
  ).replace(/\/$/, '');

  // Only accept URLs that start with http:// or https://
  const wikiUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : undefined;
  const invalidUrl = rawUrl && !wikiUrl ? rawUrl : undefined; // store the bad value for error messages

  const scriptPath = typeof caps.scriptPath === 'string' && caps.scriptPath.trim() ? caps.scriptPath.trim() : undefined;
  const pythonPath = typeof caps.pythonPath === 'string' && caps.pythonPath.trim() ? caps.pythonPath.trim() : 'python';

  return { wikiUrl, scriptPath, pythonPath, invalidUrl };
}

type WikiJsSource = 'mcp' | 'direct';

interface WikiJsMcpConfig {
  pythonPath: string;
  scriptPath: string;
  wikiUrl: string;
  apiKey: string;
}

async function callWikiJsMcp(cfg: WikiJsMcpConfig, toolName: string, toolArgs: Record<string, unknown>): Promise<unknown> {
  const { callMcpTool } = await import('../lib/mcp-client.js');
  const result = await callMcpTool(
    cfg.pythonPath,
    [cfg.scriptPath],
    { WIKIJS_URL: cfg.wikiUrl, WIKIJS_API_KEY: cfg.apiKey },
    toolName,
    toolArgs,
  );
  return parseMcpToolResponse(result);
}

async function tryWikiJs<T>(
  mcpCfg: WikiJsMcpConfig | null,
  toolName: string,
  mcpArgs: Record<string, unknown>,
  directFallback: () => Promise<T>,
): Promise<{ data: T; source: WikiJsSource; mcpError?: string }> {
  if (mcpCfg) {
    try {
      const data = await callWikiJsMcp(mcpCfg, toolName, mcpArgs) as T;
      return { data, source: 'mcp' };
    } catch (err) {
      const mcpError = err instanceof Error ? err.message : 'MCP call failed';
      console.warn(`[wiki-js] MCP call '${toolName}' failed, falling back to direct GraphQL: ${mcpError}`);
      const data = await directFallback();
      return { data, source: 'direct', mcpError };
    }
  }
  const data = await directFallback();
  return { data, source: 'direct' };
}

async function wikiJsGraphQL(
  wikiUrl: string,
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const res = await axios.post(
    `${wikiUrl}/graphql`,
    { query, variables },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      httpsAgent: tlsAgent,
      validateStatus: null, // handle status manually
    },
  );
  if (res.status < 200 || res.status >= 300) {
    const errText = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    throw new Error(`Wiki.js GraphQL returned ${res.status}: ${errText}`);
  }
  const body = res.data as { data?: unknown; errors?: Array<{ message?: string; extensions?: { code?: number | string; exception?: { stack?: string } } }> };
  // PageNotFound (6003) — treat as null, not an error.
  // Wiki.js returns extensions.code = "INTERNAL_SERVER_ERROR" with the real 6003 buried in the stack.
  if (body.errors?.length) {
    const isPageNotFound = body.errors.every((e) => {
      const msg = (e?.message ?? '').toLowerCase();
      const stack = (e?.extensions?.exception?.stack ?? '').toLowerCase();
      return msg.includes('page does not exist') || msg.includes('not found') || stack.includes('pagenotfound') || stack.includes('6003');
    });
    if (!isPageNotFound) throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`);
  }
  return body.data;
}

type WikiPageSummary = {
  id: number | string;
  path: string;
  title: string;
  description?: string;
  locale?: string;
  updatedAt?: string;
};

type ChatModelMessage = { role: 'system' | 'user' | 'assistant'; content: string };

type ProjectRepositoryWithConnection = {
  id: string;
  label: string | null;
  connectionId: string;
  adoProjectName: string | null;
  repoName: string;
  defaultBranch: string | null;
};

const WIKI_TREE_TTL_MS = 30_000;
const wikiTreeCache = new Map<string, { expiresAt: number; data: WikiPageSummary[] }>();

function getWikiTreeCacheKey(connectionId: string, locale: string) {
  return `${connectionId}:${locale}`;
}

function readWikiTreeCache(connectionId: string, locale: string) {
  const key = getWikiTreeCacheKey(connectionId, locale);
  const cached = wikiTreeCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt < Date.now()) {
    wikiTreeCache.delete(key);
    return null;
  }
  return cached.data;
}

function writeWikiTreeCache(connectionId: string, locale: string, data: WikiPageSummary[]) {
  wikiTreeCache.set(getWikiTreeCacheKey(connectionId, locale), {
    expiresAt: Date.now() + WIKI_TREE_TTL_MS,
    data,
  });
}

function clearWikiTreeCache(connectionId: string) {
  for (const key of wikiTreeCache.keys()) {
    if (key.startsWith(`${connectionId}:`)) wikiTreeCache.delete(key);
  }
}

function azureHeaders(pat: string): Record<string, string> {
  return {
    Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`,
    'Content-Type': 'application/json',
  };
}

async function fetchJsonWithInit<T = unknown>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

function formatWorkItemContext(item: Record<string, unknown>) {
  const fields = (item.fields ?? {}) as Record<string, unknown>;
  return [
    `## Azure DevOps Work Item`,
    `- ID: ${String(item.id ?? '')}`,
    `- Title: ${String(fields['System.Title'] ?? '')}`,
    `- Type: ${String(fields['System.WorkItemType'] ?? '')}`,
    `- State: ${String(fields['System.State'] ?? '')}`,
    fields['System.Description'] ? `\n### Description\n${String(fields['System.Description'])}` : '',
    fields['Microsoft.VSTS.Common.AcceptanceCriteria'] ? `\n### Acceptance Criteria\n${String(fields['Microsoft.VSTS.Common.AcceptanceCriteria'])}` : '',
    fields['System.History'] ? `\n### History\n${String(fields['System.History'])}` : '',
    fields['System.Tags'] ? `\n### Tags\n${String(fields['System.Tags'])}` : '',
  ].filter(Boolean).join('\n');
}

async function fetchAzureRepoFileContent(
  repo: ProjectRepositoryWithConnection,
  conn: { baseUrl: string | null; pat: string },
  filePath: string,
) {
  const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';
  const branch = repo.defaultBranch ?? 'main';
  const adoProject = encodeURIComponent(repo.adoProjectName ?? '');
  const contentUrl = `${baseUrl}/${adoProject}/_apis/git/repositories/${encodeURIComponent(repo.repoName)}/items?path=${encodeURIComponent(filePath)}&versionDescriptor.version=${encodeURIComponent(branch)}&versionDescriptor.versionType=branch&api-version=7.1`;
  const res = await fetch(contentUrl, { headers: azureHeaders(conn.pat) });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Failed to read ${filePath}: ${text}`);
  }
  return res.text();
}

async function findRepoMatches(
  projectId: string,
  terms: string[],
  sendLog: (message: string) => void,
): Promise<string> {
  const cleanedTerms = [...new Set(terms.map((term) => term.trim()).filter(Boolean))];
  if (cleanedTerms.length === 0) return '';

  const repos = await prisma.projectRepository.findMany({ where: { projectId } });
  if (repos.length === 0) {
    sendLog('No repositories configured for repo context');
    return '';
  }

  const contextSections: string[] = [];

  for (const repo of repos.slice(0, 3)) {
    const conn = await prisma.customerConnection.findUnique({ where: { id: repo.connectionId } });
    if (!conn || conn.type !== 'azure-devops') continue;
    if (!repo.adoProjectName) continue;

    const baseUrl = conn.baseUrl?.replace(/\/$/, '') ?? '';
    const branch = repo.defaultBranch ?? 'main';
    sendLog(`Scanning repo ${repo.label ?? repo.repoName} (${branch})...`);

    const treeUrl = `${baseUrl}/${encodeURIComponent(repo.adoProjectName)}/_apis/git/repositories/${encodeURIComponent(repo.repoName)}/items?recursionLevel=Full&versionDescriptor.version=${encodeURIComponent(branch)}&versionDescriptor.versionType=branch&api-version=7.1`;
    const treeData = await fetchJsonWithInit<{ value?: Array<{ path: string; gitObjectType?: string }> }>(
      treeUrl,
      { method: 'GET', headers: azureHeaders(conn.pat) },
    );

    const allFiles = (treeData.value ?? [])
      .filter((item) => item.gitObjectType === 'blob')
      .map((item) => item.path)
      .filter(Boolean);

    const matchedPaths = new Set<string>();
    for (const term of cleanedTerms) {
      const normalized = term.toLowerCase();
      const exact = allFiles.find((file) => file.toLowerCase() === normalized || file.toLowerCase().endsWith(normalized));
      if (exact) {
        matchedPaths.add(exact);
        continue;
      }

      for (const file of allFiles) {
        if (file.toLowerCase().includes(normalized)) matchedPaths.add(file);
        if (matchedPaths.size >= 5) break;
      }
      if (matchedPaths.size >= 5) break;
    }

    if (matchedPaths.size === 0) continue;

    const repoParts: string[] = [`## Repository: ${repo.label ?? repo.repoName}`];
    for (const filePath of [...matchedPaths].slice(0, 5)) {
      sendLog(`Reading repo file ${filePath}...`);
      try {
        const content = await fetchAzureRepoFileContent(repo, conn, filePath);
        repoParts.push(`### ${filePath}\n\n\`\`\`\n${content.slice(0, 6000)}\n\`\`\``);
      } catch (error) {
        repoParts.push(`### ${filePath}\nUnavailable: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }

    contextSections.push(repoParts.join('\n\n'));
  }

  return contextSections.join('\n\n---\n\n');
}

async function streamJsonCompletion(
  token: string,
  model: string,
  messages: ChatModelMessage[],
  onChunk: (chunk: string) => void,
): Promise<string> {
  const response = await fetch('https://models.inference.ai.azure.com/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.4,
      response_format: { type: 'json_object' },
      stream: true,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`AI API error: ${text}`);
  }

  if (!response.body) {
    const fallback = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return fallback.choices?.[0]?.message?.content ?? '{}';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let collected = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (!payload || payload === '[DONE]') continue;
        const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
        const chunk = parsed.choices?.[0]?.delta?.content ?? '';
        if (!chunk) continue;
        collected += chunk;
        onChunk(chunk);
      }
    }
  }

  return collected;
}

function extractJsonObject(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return {} as Record<string, unknown>;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
    }
    throw new Error('AI response did not contain valid JSON');
  }
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
        const { wikiUrl, scriptPath, pythonPath } = getWikiJsConfig(connection);
        if (!wikiUrl) {
          return { data: { status: 'error', message: 'No Wiki.js URL configured' } };
        }
        // Test direct GraphQL
        try {
          const testRes = await axios.post(
            `${wikiUrl}/graphql`,
            { query: '{ __typename }' },
            { headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }, httpsAgent: tlsAgent, validateStatus: null },
          );
          if (testRes.status < 200 || testRes.status >= 300) {
            return { data: { status: 'error', message: `Wiki.js API returned ${testRes.status}: ${JSON.stringify(testRes.data)}` } };
          }
        } catch (fetchErr) {
          return { data: { status: 'error', message: `Wiki.js unreachable: ${fetchErr instanceof Error ? fetchErr.message : 'unknown'}` } };
        }
        const directMsg = 'Direct GraphQL: connected';
        if (!scriptPath) {
          return { data: { status: 'ok', message: `${directMsg} (no MCP script configured)` } };
        }
        // Also test MCP if configured
        try {
          const { listMcpTools } = await import('../lib/mcp-client.js');
          const tools = await listMcpTools(pythonPath, [scriptPath], { WIKIJS_URL: wikiUrl, WIKIJS_API_KEY: credential });
          return { data: { status: 'ok', message: `${directMsg} + MCP: ${tools.length} tool(s) (${tools.map(t => t.name).join(', ')})` } };
        } catch (mcpErr) {
          const mcpMsg = mcpErr instanceof Error ? mcpErr.message : 'MCP failed';
          return { data: { status: 'ok', message: `${directMsg} | MCP unavailable: ${mcpMsg}` } };
        }
      }

      return { data: { status: 'ok', message: `Connection type '${connection.type}' stored — no adapter test available` } };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { data: { status: 'error', message } };
    }
  });

  // ─── Wiki.js MCP + direct status ─────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/:id/wiki-status', async (req, reply) => {
    const connection = await prisma.mCPConnection.findUnique({ where: { id: req.params.id } });
    if (!connection) return reply.status(404).send({ error: 'not_found', message: 'Not found' });
    if (connection.type !== 'wiki_js') return reply.status(400).send({ error: 'invalid_type', message: 'Only wiki_js MCPs' });

    let credential: string | null = null;
    if (connection.encryptedCredential && connection.credentialIv && connection.credentialTag) {
      credential = decryptToken(connection.encryptedCredential, connection.credentialIv, connection.credentialTag);
    }

    const { wikiUrl, scriptPath, pythonPath, invalidUrl } = getWikiJsConfig(connection);

    // Test direct GraphQL
    let directAvailable = false;
    let directError: string | undefined;
    if (invalidUrl) {
      directError = `Invalid Wiki.js URL: "${invalidUrl}" — must start with https://`;
    } else {
      try {
        if (wikiUrl && credential) {
          const checkRes = await axios.post(
            `${wikiUrl}/graphql`,
            { query: '{ __typename }' },
            { headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }, httpsAgent: tlsAgent, validateStatus: null },
          );
          directAvailable = checkRes.status >= 200 && checkRes.status < 300;
          if (!directAvailable) directError = `HTTP ${checkRes.status}`;
        } else {
          directError = !wikiUrl ? 'Wiki.js URL not configured' : 'API key not configured';
        }
      } catch (err) {
        directError = err instanceof Error ? err.message : 'Direct GraphQL failed';
      }
    }

    // Test MCP (only if scriptPath configured)
    let mcpConfigured = Boolean(scriptPath);
    let mcpAvailable = false;
    let mcpError: string | undefined;
    if (scriptPath && wikiUrl && credential) {
      try {
        const { listMcpTools } = await import('../lib/mcp-client.js');
        const tools = await listMcpTools(pythonPath, [scriptPath], { WIKIJS_URL: wikiUrl, WIKIJS_API_KEY: credential });
        mcpAvailable = true;
        mcpError = undefined;
        return { data: { directAvailable, directError, mcpConfigured, mcpAvailable, mcpTools: tools.map(t => t.name), activeSource: 'mcp' as WikiJsSource } };
      } catch (err) {
        mcpError = err instanceof Error ? err.message : 'MCP failed';
      }
    }

    const activeSource: WikiJsSource = (mcpAvailable ? 'mcp' : 'direct');
    return { data: { directAvailable, directError, mcpConfigured, mcpAvailable, mcpError, activeSource } };
  });

  // ─── Wiki.js pages ────────────────────────────────────────────────────────
  app.get<{
    Params: { id: string };
    Querystring: { locale?: string };
  }>('/:id/wiki-tree', async (req, reply) => {
    const connection = await prisma.mCPConnection.findUnique({ where: { id: req.params.id } });
    if (!connection) return reply.status(404).send({ error: 'not_found', message: 'MCP connection not found' });
    if (connection.type !== 'wiki_js') return reply.status(400).send({ error: 'invalid_type', message: 'Only wiki_js MCPs support wiki pages' });

    let credential: string | null = null;
    if (connection.encryptedCredential && connection.credentialIv && connection.credentialTag) {
      credential = decryptToken(connection.encryptedCredential, connection.credentialIv, connection.credentialTag);
    }
    if (!credential) return reply.status(400).send({ error: 'not_configured', message: 'Wiki.js API key not configured' });

    const { wikiUrl, invalidUrl } = getWikiJsConfig(connection);
    if (invalidUrl) return reply.status(400).send({ error: 'invalid_url', message: `Wiki.js URL "${invalidUrl}" is invalid — it must start with https://. Update the connection's Base URL field.` });
    if (!wikiUrl) return reply.status(400).send({ error: 'not_configured', message: 'Wiki.js URL not configured (set baseUrl to the wiki URL, e.g. https://wiki.example.com)' });

    const locale = req.query.locale?.trim() || 'de';
    const cached = readWikiTreeCache(connection.id, locale);
    if (cached) return { data: cached, source: 'direct' };

    // Tree/list has no MCP tool — always use direct GraphQL
    try {
      const data = await wikiJsGraphQL(wikiUrl, credential, `
        query ListPages($locale: String!) {
          pages {
            list(locale: $locale, orderBy: PATH) {
              id path title description locale updatedAt
            }
          }
        }`, { locale }) as { pages?: { list?: WikiPageSummary[] } };
      const pages = (data.pages?.list ?? []).filter((page) => page?.path);
      writeWikiTreeCache(connection.id, locale, pages);
      return { data: pages, source: 'direct' };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(502).send({ error: 'wiki_error', message });
    }
  });

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

    const { wikiUrl, scriptPath, pythonPath, invalidUrl } = getWikiJsConfig(connection);
    // If no MCP configured, we need a valid URL for direct GraphQL
    const mcpCfg: WikiJsMcpConfig | null = scriptPath && credential ? { pythonPath, scriptPath, wikiUrl: wikiUrl ?? '', apiKey: credential } : null;
    if (!mcpCfg && invalidUrl) return reply.status(400).send({ error: 'invalid_url', message: `Wiki.js URL "${invalidUrl}" is invalid — must start with https://` });
    if (!mcpCfg && !wikiUrl) return reply.status(400).send({ error: 'not_configured', message: 'Wiki.js URL not configured (set baseUrl to the wiki URL, e.g. https://wiki.example.com)' });

    const locale = req.query.locale?.trim() || 'de';

    try {
      if (req.query.path?.trim()) {
        const path = req.query.path.trim();
        const { data, source, mcpError } = await tryWikiJs(
          mcpCfg,
          'wikijs_get_page',
          { path, locale },
          async () => {
            const gqlData = await wikiJsGraphQL(wikiUrl, credential!, `
              query GetPage($path: String!, $locale: String!) {
                pages { singleByPath(path: $path, locale: $locale) {
                  id path title description content tags { tag } updatedAt
                }}
              }`, { path, locale }) as Record<string, unknown>;
            return (gqlData as any)?.pages?.singleByPath ?? null;
          },
        );
        return { data, source, ...(mcpError && { mcpError }) };
      } else {
        const query = req.query.query!.trim();
        const { data, source, mcpError } = await tryWikiJs(
          mcpCfg,
          'wikijs_search_pages',
          { query, locale },
          async () => {
            const gqlData = await wikiJsGraphQL(wikiUrl, credential!, `
              query SearchPages($query: String!, $locale: String!) {
                pages { search(query: $query, locale: $locale) {
                  results { id path title description locale } totalHits
                }}
              }`, { query, locale }) as Record<string, unknown>;
            return (gqlData as any)?.pages?.search?.results ?? [];
          },
        );
        // normalize MCP search result (returns { results: [...], totalHits: N })
        const results = Array.isArray(data) ? data : ((data as any)?.results ?? []);
        return { data: results, source, ...(mcpError && { mcpError }) };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(502).send({ error: 'wiki_error', message });
    }
  });

  app.post<{
    Params: { id: string };
    Body: { path: string; title: string; content: string; locale?: string; description?: string; tags?: string[] | string; editor?: string };
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

    const { wikiUrl, scriptPath, pythonPath } = getWikiJsConfig(connection);
    if (!wikiUrl) return reply.status(400).send({ error: 'not_configured', message: 'Wiki.js URL not configured' });

    const tags = Array.isArray(req.body.tags)
      ? req.body.tags.map(t => String(t).trim()).filter(Boolean)
      : typeof req.body.tags === 'string'
        ? req.body.tags.split(',').map(t => t.trim()).filter(Boolean)
        : [];
    const locale = req.body.locale?.trim() || 'de';
    const content = req.body.content ?? '';
    const description = req.body.description?.trim() ?? '';
    const editor = (req.body.editor === 'html' ? 'wysiwyg' : 'markdown') as 'wysiwyg' | 'markdown';
    const mcpCfg: WikiJsMcpConfig | null = scriptPath ? { pythonPath, scriptPath, wikiUrl, apiKey: credential } : null;

    try {
      const { data, source, mcpError } = await tryWikiJs(
        mcpCfg,
        'wikijs_upsert_page',
        { path: pagePath, title, content, description, tags, locale, editor },
        async () => {
          // Direct GraphQL: check if page exists first, then create or update
          const existing = await wikiJsGraphQL(wikiUrl, credential!, `
            query FindPage($path: String!, $locale: String!) {
              pages { singleByPath(path: $path, locale: $locale) { id } }
            }`, { path: pagePath, locale }) as Record<string, unknown>;
          const existingId = (existing as any)?.pages?.singleByPath?.id as number | undefined;
          if (existingId) {
            return wikiJsGraphQL(wikiUrl, credential!, `
              mutation UpdatePage($id: Int!, $title: String!, $content: String!, $description: String!, $editor: String!, $isPublished: Boolean!, $locale: String!, $path: String!, $tags: [String]!) {
                pages { update(id: $id, title: $title, content: $content, description: $description, editor: $editor, isPublished: $isPublished, locale: $locale, path: $path, tags: $tags) {
                  responseResult { succeeded errorCode message } page { id path title }
                }}
              }`, { id: existingId, title, content, description, editor, isPublished: true, locale, path: pagePath, tags });
          }
          return wikiJsGraphQL(wikiUrl, credential!, `
            mutation CreatePage($title: String!, $content: String!, $description: String!, $editor: String!, $isPublished: Boolean!, $isPrivate: Boolean!, $locale: String!, $path: String!, $tags: [String]!) {
              pages { create(title: $title, content: $content, description: $description, editor: $editor, isPublished: $isPublished, isPrivate: $isPrivate, locale: $locale, path: $path, tags: $tags) {
                responseResult { succeeded errorCode slug message } page { id path title }
              }}
            }`, { title, content, description, editor, isPublished: true, isPrivate: false, locale, path: pagePath, tags });
        },
      );
      clearWikiTreeCache(connection.id);
      return { data, source, ...(mcpError && { mcpError }) };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(502).send({ error: 'wiki_error', message });
    }
  });

  app.post<{
    Params: { id: string };
    Body: {
      projectId: string;
      path: string;
      title?: string;
      locale?: string;
      format?: 'markdown' | 'html';
      sources?: {
        workItemId?: number;
        workItemContent?: string;
        recordingId?: string;
        mcpTeamsId?: string;
        repoFiles?: string[];
        repoContent?: string;
        customPrompt?: string;
      };
    };
  }>('/:id/generate-wiki-page', async (req, reply) => {
    reply.hijack();
    reply.raw.statusCode = 200;
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.flushHeaders?.();

    const sendEvent = (type: string, payload: Record<string, unknown>) => {
      reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    const sendLog = (message: string) => sendEvent('log', { message });
    const endStream = () => {
      if (!reply.raw.writableEnded) reply.raw.end();
    };

    try {
      const connection = await prisma.mCPConnection.findUnique({ where: { id: req.params.id } });
      if (!connection) throw new Error('MCP connection not found');
      if (connection.type !== 'wiki_js') throw new Error('Only wiki_js MCPs support wiki generation');

      const projectId = req.body.projectId?.trim();
      const suggestedPath = req.body.path?.trim();
      const suggestedTitle = req.body.title?.trim();
      const locale = req.body.locale?.trim() || 'de';
      const format = req.body.format === 'html' ? 'html' : 'markdown';
      const sources = req.body.sources ?? {};

      if (!projectId) throw new Error('projectId is required');
      if (!suggestedPath) throw new Error('path is required');

      const token = process.env.GITHUB_TOKEN;
      if (!token) throw new Error('AI provider token not configured');
      const model = process.env.AI_MODEL ?? 'gpt-4o-mini';

      const project = await prisma.project.findUnique({ where: { id: projectId } });
      if (!project) throw new Error('Project not found');

      // Extract Wiki.js URL + credential for screenshot uploads
      let credential: string | null = null;
      if (connection.encryptedCredential && connection.credentialIv && connection.credentialTag) {
        credential = decryptToken(connection.encryptedCredential, connection.credentialIv, connection.credentialTag);
      }
      const { wikiUrl } = getWikiJsConfig(connection);

      const contextParts: string[] = [
        `## Wiki Page Target`,
        `- Locale: ${locale}`,
        `- Suggested path: ${suggestedPath}`,
        suggestedTitle ? `- Suggested title: ${suggestedTitle}` : '',
      ].filter(Boolean);

      sendLog('Loading generation context...');

      if (sources.workItemContent?.trim()) {
        contextParts.push(`## Azure DevOps Work Item\n${sources.workItemContent.trim()}`);
        sendLog('Using provided work item content');
      } else if (typeof sources.workItemId === 'number') {
        if (!project.connectionId || !project.adoProjectName) {
          throw new Error('Project does not have an Azure DevOps connection for work item lookup');
        }

        sendLog(`Loading work item ${sources.workItemId}...`);
        const adoConnection = await prisma.customerConnection.findUnique({ where: { id: project.connectionId } });
        if (!adoConnection || adoConnection.type !== 'azure-devops') {
          throw new Error('Azure DevOps connection not found');
        }

        const workItem = await fetchJsonWithInit<Record<string, unknown>>(
          `${adoConnection.baseUrl?.replace(/\/$/, '')}/_apis/wit/workitems/${sources.workItemId}?fields=System.Id,System.Title,System.WorkItemType,System.State,System.Description,Microsoft.VSTS.Common.AcceptanceCriteria,System.Tags,System.History&api-version=7.1`,
          { method: 'GET', headers: azureHeaders(adoConnection.pat) },
        );
        contextParts.push(formatWorkItemContext(workItem));
        sendLog('Work item context loaded');
      }

      if (sources.recordingId?.trim() && sources.mcpTeamsId?.trim()) {
        sendLog('Loading Teams recording transcript...');
        const teamsConnection = await prisma.mCPConnection.findUnique({ where: { id: sources.mcpTeamsId.trim() } });
        if (teamsConnection?.type === 'teams_recorder' && teamsConnection.baseUrl) {
          let mcpCredential: string | null = null;
          if (teamsConnection.encryptedCredential && teamsConnection.credentialIv && teamsConnection.credentialTag) {
            mcpCredential = decryptToken(teamsConnection.encryptedCredential, teamsConnection.credentialIv, teamsConnection.credentialTag);
          }

          const { callMcpTool } = await import('../lib/mcp-client.js');
          const env: Record<string, string> = {};
          if (mcpCredential) env.GITHUB_TOKEN = mcpCredential;

          // Load transcript
          const transcriptResult = await callMcpTool('node', [teamsConnection.baseUrl], env, 'get_full_transcript', {
            recording_id: sources.recordingId.trim(),
          });
          const transcriptData = parseMcpToolResponse(transcriptResult);
          const transcriptText = typeof transcriptData === 'string'
            ? transcriptData
            : JSON.stringify(transcriptData, null, 2);
          contextParts.push(`## Teams Recording Transcript\n${transcriptText.slice(0, 12000)}`);
          sendLog('Teams recording transcript loaded');

          // Load screenshots from analysis and upload relevant ones to Wiki.js
          try {
            sendLog('Loading recording screenshots...');
            const analysisResult = await callMcpTool('node', [teamsConnection.baseUrl], env, 'get_recording_analysis', {
              recording_id: sources.recordingId.trim(),
            });
            const analysisData = parseMcpToolResponse(analysisResult);
            type ScreenshotMeta = { id: string; filePath: string; description: string; relevanceScore: number; tags: string[] };
            const screenshots: ScreenshotMeta[] = Array.isArray(analysisData?.screenshots)
              ? (analysisData.screenshots as ScreenshotMeta[])
              : [];

            if (screenshots.length > 0 && wikiUrl && credential) {
              // Pick the top-N most relevant screenshots
              const relevant = screenshots
                .filter((s) => s.filePath && s.relevanceScore >= 0.4)
                .sort((a, b) => b.relevanceScore - a.relevanceScore)
                .slice(0, 5);

              sendLog(`Uploading ${relevant.length} screenshot(s) to Wiki.js...`);
              const uploadedScreenshots: { url: string; description: string }[] = [];

              const { readFile } = await import('fs/promises');
              for (const shot of relevant) {
                try {
                  const imageBytes = await readFile(shot.filePath);
                  const filename = `recording-${sources.recordingId?.trim().slice(0, 8)}-${shot.id}.png`;

                  // Upload via Wiki.js REST upload endpoint using axios (supports TLS bypass for internal CAs)
                  const uploadForm = new FormData();
                  uploadForm.append('mediaUpload', new Blob([JSON.stringify({ folderId: 2 })], { type: 'application/json' }));
                  uploadForm.append('mediaUpload', new Blob([imageBytes], { type: 'image/png' }), filename);

                  const uploadRes = await axios.post(`${wikiUrl}/u`, uploadForm, {
                    headers: { Authorization: `Bearer ${credential}` },
                    httpsAgent: tlsAgent,
                    validateStatus: null,
                  });
                  if (uploadRes.status >= 200 && uploadRes.status < 300) {
                    const assetUrl = `${wikiUrl}/${filename}`;
                    uploadedScreenshots.push({ url: assetUrl, description: shot.description });
                    sendLog(`Uploaded: ${filename}`);
                  } else {
                    sendLog(`Upload skipped (HTTP ${uploadRes.status}): ${filename}`);
                  }
                } catch (uploadErr) {
                  sendLog(`Screenshot ${shot.id} skipped: ${uploadErr instanceof Error ? uploadErr.message : 'unknown'}`);
                }
              }

              if (uploadedScreenshots.length > 0) {
                const screenshotContext = uploadedScreenshots
                  .map((s, i) => `### Screenshot ${i + 1}\n- URL: ${s.url}\n- Description: ${s.description}`)
                  .join('\n\n');
                contextParts.push(
                  `## Recording Screenshots\nThe following screenshots have been uploaded to Wiki.js. Embed them in the page content using their URLs.\n\n${screenshotContext}`
                );
                sendLog(`${uploadedScreenshots.length} screenshot(s) ready for embedding`);
              }
            } else if (screenshots.length === 0) {
              sendLog('No screenshots found in recording analysis');
            }
          } catch (screenshotErr) {
            sendLog(`Screenshot loading skipped: ${screenshotErr instanceof Error ? screenshotErr.message : 'unknown'}`);
          }
        }
      }

      if (sources.repoContent?.trim()) {
        contextParts.push(`## Repository Content\n${sources.repoContent.trim().slice(0, 12000)}`);
        sendLog('Using provided repository content');
      } else if (Array.isArray(sources.repoFiles) && sources.repoFiles.length > 0) {
        const repoContext = await findRepoMatches(projectId, sources.repoFiles, sendLog);
        if (repoContext) {
          contextParts.push(repoContext);
          sendLog('Repository context loaded');
        } else {
          sendLog('No matching repository files found');
        }
      }

      if (sources.customPrompt?.trim()) {
        contextParts.push(`## User Instructions\n${sources.customPrompt.trim()}`);
        sendLog('Custom instructions added');
      }

      const hasScreenshots = contextParts.some((p) => p.startsWith('## Recording Screenshots'));
      const screenshotInstruction = hasScreenshots
        ? 'Screenshots from the recording have been uploaded to Wiki.js. IMPORTANT: embed ALL provided screenshot URLs in the content at relevant sections using the proper format for the output type (img tags for HTML, ![desc](url) for Markdown). Place each screenshot near the section it illustrates.'
        : '';

      sendLog(`Generating ${format === 'html' ? 'HTML' : 'Markdown'} wiki page draft...`);
      const langInstruction = locale === 'de'
        ? 'Write the title and full page content in German.'
        : 'Write the title and full page content in English.';

      const systemPrompt = format === 'html'
        ? [
            'You are a technical documentation designer for a Wiki.js knowledge base.',
            langInstruction,
            'Generate a visually rich HTML page using only inline CSS (no external stylesheets, no <script>, no <link> tags).',
            'The HTML will be stored in Wiki.js using its HTML editor — it must render beautifully inside Wiki.js.',
            screenshotInstruction,
            'Style guidelines:',
            '- Dark-friendly neutral colors (#1C1C1A text, #8A8985 secondary, white cards with box-shadow)',
            '- Hero/banner section at top: full-width colored div with bold white title and subtitle',
            '- Navigation tabs row for sub-pages (styled as pill buttons in a flex row)',
            '- Feature/function cards in a responsive grid (3 columns, each with icon area, bold heading, description, and link list)',
            '- For screenshots: use <figure> with <img style="max-width:100%;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.12)"> and <figcaption> for the description',
            '- Use <div> based layout with inline flex/grid styles',
            '- Section headings with bottom border, font-weight 600',
            '- Breadcrumb navigation at top using <a> tags with muted color and › separators',
            '- No external fonts — use: font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
            'Return ONLY valid JSON: { "title": string, "content": string, "path": string }',
            'The "content" value must be the complete HTML string (escaped for JSON).',
            'Do not invent unsupported facts. Clearly mark placeholders where information is missing.',
            `Prefer this path unless a better nested path is clearly justified: ${suggestedPath}`,
            contextParts.join('\n\n'),
          ].filter(Boolean).join('\n\n')
        : [
            'You are a technical documentation writer for a Wiki.js knowledge base.',
            langInstruction,
            screenshotInstruction,
            'Use the provided sources to generate a polished wiki page in Markdown.',
            'Return ONLY valid JSON with this shape: { "title": string, "content": string, "path": string }.',
            'The content should include a concise introduction, well-structured headings, bullet points where useful, and implementation details grounded in the source material.',
            'Do not invent unsupported facts. If the sources are incomplete, write sensible placeholders or clearly marked assumptions.',
            `Prefer this path unless a better nested path is clearly justified: ${suggestedPath}`,
            contextParts.join('\n\n'),
          ].filter(Boolean).join('\n\n');

      const streamedJson = await streamJsonCompletion(
        token,
        model,
        [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `Generate a complete wiki page draft for ${suggestedPath}.${suggestedTitle ? ` Suggested title: ${suggestedTitle}.` : ''} Format: ${format.toUpperCase()}.`,
          },
        ],
        (chunk) => sendEvent('chunk', { content: chunk }),
      );

      const generated = extractJsonObject(streamedJson);
      sendEvent('result', {
        title: String(generated.title ?? suggestedTitle ?? ''),
        content: String(generated.content ?? ''),
        path: String(generated.path ?? suggestedPath),
        format,
      });
      sendEvent('done', { ok: true });
      endStream();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      sendEvent('error', { message });
      endStream();
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
