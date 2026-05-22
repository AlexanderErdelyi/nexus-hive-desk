import type { FastifyInstance } from 'fastify';
import { prisma } from '@nexus/db';
import { requireAuth } from '../lib/auth';

// ─── AL analysis logic (mirrors ALCodeHealthView.tsx) ─────────────────────────

type Severity = 'error' | 'warning' | 'info';

interface HealthIssue {
  severity: Severity;
  ruleId: string;
  message: string;
  detail?: string;
  line?: number;
  procedure?: string;
}

interface ProcInfo {
  name: string;
  startLine: number;
  endLine: number;
  lineCount: number;
  paramCount: number;
}

interface ObjectResult {
  objectType: string;
  objectName: string;
  filePath: string;
  lineCount: number;
  procedures: ProcInfo[];
  issues: HealthIssue[];
}

const AL_OBJECT_RE = /^(tableextension|table|pagecustomization|pageextension|page|codeunit|reportextension|report|xmlport|query|enumextension|enum|profile|interface|permissionset)\s+\d+\s+["']?([^"'{\n]+?)["']?\s*[{(]/im;

const AL_TYPE_MAP: Record<string, string> = {
  table: 'Table', tableextension: 'TableExtension',
  page: 'Page', pageextension: 'PageExtension', pagecustomization: 'PageCustomization',
  codeunit: 'Codeunit', report: 'Report', reportextension: 'ReportExtension',
  xmlport: 'XMLPort', query: 'Query',
  enum: 'Enum', enumextension: 'EnumExtension',
  profile: 'Profile', interface: 'Interface', permissionset: 'PermissionSet',
};

function stripStrings(line: string): string {
  return line.replace(/'[^']*'/g, "''").replace(/\/\/.*$/, '');
}

function parseProcedures(lines: string[]): ProcInfo[] {
  const PROC_RE = /^\s*(local\s+|internal\s+|protected\s+)?(procedure|trigger)\s+"?([^"(\n]+?)"?\s*\(([^)]*)\)/i;
  const results: ProcInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = PROC_RE.exec(lines[i]);
    if (!m) continue;
    const name = m[3].trim();
    const paramStr = m[4] ?? '';
    const paramCount = paramStr.trim() === '' ? 0 : paramStr.split(';').length;
    let depth = 0, foundBegin = false, endLine = i + 1;
    for (let j = i; j < lines.length; j++) {
      const s = stripStrings(lines[j]).toLowerCase();
      const b = (s.match(/\bbegin\b/g) ?? []).length;
      const e = (s.match(/\bend\b/g) ?? []).length;
      if (!foundBegin && b > 0) foundBegin = true;
      if (foundBegin) { depth += b - e; if (depth <= 0) { endLine = j + 1; break; } }
    }
    results.push({ name, startLine: i + 1, endLine, lineCount: endLine - i, paramCount });
  }
  return results;
}

function checkDbInLoops(lines: string[], procStart: number, procEnd: number, procName: string): HealthIssue[] {
  const issues: HealthIssue[] = [];
  let loopDepth = 0;
  const DB_RE = /\.(findset|findfirst|findlast|find\s*\(|get\s*\()\b/i;
  const COMMIT_RE = /\bcommit\s*\(\s*\)/i;
  for (let i = procStart - 1; i < Math.min(procEnd, lines.length); i++) {
    const s = stripStrings(lines[i]).toLowerCase();
    if (/\brepeat\b/.test(s)) loopDepth++;
    if (/\bwhile\b.+\bdo\b/.test(s) || /\bfor\b.+\bto\b.+\bdo\b/.test(s)) loopDepth++;
    if (/\buntil\b/.test(s) && loopDepth > 0) loopDepth--;
    if (loopDepth > 0) {
      if (DB_RE.test(lines[i])) issues.push({ severity: 'error', ruleId: 'AL0003', message: 'Database read operation inside loop', detail: lines[i].trim(), line: i + 1, procedure: procName });
      if (COMMIT_RE.test(lines[i])) issues.push({ severity: 'error', ruleId: 'AL0004', message: 'Commit() inside loop — severe performance issue', detail: lines[i].trim(), line: i + 1, procedure: procName });
    }
  }
  return issues;
}

function checkDeepNesting(lines: string[], procStart: number, procEnd: number, procName: string): HealthIssue[] {
  const THRESHOLD = 6;
  let maxDepth = 0, maxLine = -1;
  for (let i = procStart - 1; i < Math.min(procEnd, lines.length); i++) {
    const indent = lines[i].match(/^(\s*)/)?.[1].length ?? 0;
    const depth = Math.floor(indent / 4);
    if (depth > maxDepth) { maxDepth = depth; maxLine = i + 1; }
  }
  if (maxDepth >= THRESHOLD) return [{ severity: 'warning', ruleId: 'AL0005', message: `Deep nesting detected (≈${maxDepth} levels)`, detail: 'Consider refactoring into smaller sub-procedures.', line: maxLine, procedure: procName }];
  return [];
}

function analyzeAlContent(content: string, filePath: string): ObjectResult | null {
  const m = AL_OBJECT_RE.exec(content);
  if (!m) return null;
  const bcType = AL_TYPE_MAP[m[1].toLowerCase()];
  if (!bcType) return null;
  const objectName = m[2].trim().replace(/^["']|["']$/g, '');
  const lines = content.split('\n');
  const issues: HealthIssue[] = [];

  if (lines.length > 2000) issues.push({ severity: 'warning', ruleId: 'AL0001', message: `Large object: ${lines.length} lines`, detail: 'Consider splitting into smaller objects.' });

  const procedures = parseProcedures(lines);
  for (const p of procedures) {
    if (p.lineCount > 100) issues.push({ severity: p.lineCount > 200 ? 'error' : 'warning', ruleId: 'AL0002', message: `Procedure "${p.name}" is ${p.lineCount} lines long`, line: p.startLine, procedure: p.name });
    issues.push(...checkDbInLoops(lines, p.startLine, p.endLine, p.name));
    issues.push(...checkDeepNesting(lines, p.startLine, p.endLine, p.name));
    if (p.paramCount > 8) issues.push({ severity: 'warning', ruleId: 'AL0006', message: `Procedure "${p.name}" has ${p.paramCount} parameters`, line: p.startLine, procedure: p.name });
  }

  for (let i = 0; i < lines.length; i++) {
    if (/\/\/\s*(TODO|FIXME|HACK|XXX)\b/i.test(lines[i])) issues.push({ severity: 'info', ruleId: 'AL0007', message: `Developer note: ${lines[i].trim()}`, line: i + 1 });
  }

  return { objectType: bcType, objectName, filePath, lineCount: lines.length, procedures, issues };
}

function addDuplicateIssues(results: ObjectResult[]): void {
  const nameMap = new Map<string, string[]>();
  for (const r of results) for (const p of r.procedures) {
    const k = p.name.toLowerCase();
    if (!nameMap.has(k)) nameMap.set(k, []);
    nameMap.get(k)!.push(`${r.objectType} ${r.objectName}`);
  }
  for (const r of results) for (const p of r.procedures) {
    const others = (nameMap.get(p.name.toLowerCase()) ?? []).filter((o) => o !== `${r.objectType} ${r.objectName}`);
    if (others.length > 0) r.issues.push({ severity: 'info', ruleId: 'AL0008', message: `Procedure "${p.name}" also in: ${others.slice(0, 3).join(', ')}${others.length > 3 ? ` +${others.length - 3} more` : ''}`, line: p.startLine, procedure: p.name });
  }
}

// ─── ADO / GitHub helpers ─────────────────────────────────────────────────────

async function fetchAdoAlFiles(baseUrl: string, adoProject: string, repoName: string, branch: string, pat: string): Promise<{ path: string; content: string }[]> {
  const auth = Buffer.from(`:${pat}`).toString('base64');
  const headers = { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' };

  // Get file tree
  const treeUrl = `${baseUrl}/${encodeURIComponent(adoProject)}/_apis/git/repositories/${encodeURIComponent(repoName)}/items?recursionLevel=Full&versionDescriptor.version=${encodeURIComponent(branch)}&versionDescriptor.versionType=branch&api-version=7.1`;
  const treeRes = await fetch(treeUrl, { headers });
  if (!treeRes.ok) throw new Error(`ADO tree fetch failed: ${treeRes.status} ${await treeRes.text().catch(() => '')}`);

  const treeData = await treeRes.json() as { value?: Array<{ path: string; gitObjectType: string }> };
  const alFiles = (treeData.value ?? []).filter((i) => i.gitObjectType === 'blob' && i.path.endsWith('.al')).slice(0, 500);

  // Fetch each file in batches of 20
  const results: { path: string; content: string }[] = [];
  for (let i = 0; i < alFiles.length; i += 20) {
    const batch = alFiles.slice(i, i + 20);
    const fetched = await Promise.all(
      batch.map(async (f) => {
        const url = `${baseUrl}/${encodeURIComponent(adoProject)}/_apis/git/repositories/${encodeURIComponent(repoName)}/items?path=${encodeURIComponent(f.path)}&versionDescriptor.version=${encodeURIComponent(branch)}&versionDescriptor.versionType=branch&$format=text&api-version=7.1`;
        const r = await fetch(url, { headers });
        if (!r.ok) return null;
        return { path: f.path, content: await r.text() };
      })
    );
    results.push(...fetched.filter((x): x is { path: string; content: string } => x !== null));
  }
  return results;
}

async function fetchGitHubAlFiles(owner: string, repo: string, branch: string, pat: string): Promise<{ path: string; content: string }[]> {
  const headers = { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json' };

  const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, { headers });
  if (!treeRes.ok) throw new Error(`GitHub tree fetch failed: ${treeRes.status}`);

  const treeData = await treeRes.json() as { tree?: Array<{ path: string; type: string }> };
  const alFiles = (treeData.tree ?? []).filter((f) => f.type === 'blob' && f.path.endsWith('.al')).slice(0, 500);

  const results: { path: string; content: string }[] = [];
  for (let i = 0; i < alFiles.length; i += 20) {
    const batch = alFiles.slice(i, i + 20);
    const fetched = await Promise.all(
      batch.map(async (f) => {
        const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(f.path)}?ref=${encodeURIComponent(branch)}`, {
          headers: { ...headers, Accept: 'application/vnd.github.raw+json' },
        });
        if (!r.ok) return null;
        return { path: f.path, content: await r.text() };
      })
    );
    results.push(...fetched.filter((x): x is { path: string; content: string } => x !== null));
  }
  return results;
}

// ─── Route handler ─────────────────────────────────────────────────────────────

export async function alHealthRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireAuth(app));

  // ── GET reviews ─────────────────────────────────────────────────────────────
  app.get<{ Params: { projectId: string } }>('/:projectId/al-health/reviews', async (req, reply) => {
    const reviews = await prisma.aLHealthReview.findMany({
      where: { projectId: req.params.projectId },
      select: { issueKey: true, note: true, createdAt: true },
    });
    return { data: reviews };
  });

  // ── POST review (mark as reviewed) ─────────────────────────────────────────
  app.post<{
    Params: { projectId: string };
    Body: { issueKey: string; note?: string };
  }>('/:projectId/al-health/reviews', async (req, reply) => {
    const { issueKey, note } = req.body;
    if (!issueKey) return reply.status(400).send({ error: 'validation', message: 'issueKey is required' });

    const review = await prisma.aLHealthReview.upsert({
      where: { projectId_issueKey: { projectId: req.params.projectId, issueKey } },
      update: { note: note ?? null },
      create: { projectId: req.params.projectId, issueKey, note: note ?? null },
    });
    return reply.status(201).send({ data: review });
  });

  // ── DELETE review (un-mark) ─────────────────────────────────────────────────
  app.delete<{ Params: { projectId: string; issueKey: string } }>('/:projectId/al-health/reviews/:issueKey', async (req, reply) => {
    const key = decodeURIComponent(req.params.issueKey);
    await prisma.aLHealthReview.deleteMany({ where: { projectId: req.params.projectId, issueKey: key } });
    return reply.status(204).send();
  });

  // ── POST fetch-analyse (fetch .al files from repo + run analysis) ────────────
  app.post<{
    Params: { projectId: string };
    Body: { repositoryId: string; branch?: string };
  }>('/:projectId/al-health/fetch-analyse', async (req, reply) => {
    const { repositoryId, branch } = req.body;

    const repo = await prisma.projectRepository.findUnique({ where: { id: repositoryId } });
    if (!repo) return reply.status(404).send({ error: 'not_found', message: 'Repository not found' });

    const conn = await prisma.customerConnection.findUnique({ where: { id: repo.connectionId } });
    if (!conn) return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });

    const targetBranch = branch ?? repo.defaultBranch ?? 'main';
    let files: { path: string; content: string }[];

    if (conn.type === 'github') {
      // GitHub: repoName is "owner/repo"
      const [owner, repoName] = repo.repoName.split('/');
      if (!owner || !repoName) return reply.status(400).send({ error: 'validation', message: 'GitHub repo name must be "owner/repo"' });
      files = await fetchGitHubAlFiles(owner, repoName, targetBranch, conn.pat);
    } else {
      // Azure DevOps
      const baseUrl = conn.baseUrl ?? '';
      const adoProject = repo.adoProjectName ?? '';
      if (!baseUrl || !adoProject) return reply.status(400).send({ error: 'validation', message: 'ADO connection missing baseUrl or adoProjectName' });
      files = await fetchAdoAlFiles(baseUrl, adoProject, repo.repoName, targetBranch, conn.pat);
    }

    const analysed: ObjectResult[] = [];
    for (const f of files) {
      const result = analyzeAlContent(f.content, f.path);
      if (result) analysed.push(result);
    }
    addDuplicateIssues(analysed);

    const totalIssues = analysed.reduce((s, r) => s + r.issues.length, 0);
    return {
      data: analysed,
      meta: { filesScanned: files.length, objectsFound: analysed.length, totalIssues, branch: targetBranch },
    };
  });

  // ── POST ai-explain ────────────────────────────────────────────────────────
  app.post<{
    Params: { projectId: string };
    Body: {
      ruleId: string;
      message: string;
      detail?: string;
      procedure?: string;
      objectType: string;
      objectName: string;
      codeSnippet?: string;
    };
  }>('/:projectId/al-health/ai-explain', async (req, reply) => {
    const { ruleId, message, detail, procedure, objectType, objectName, codeSnippet } = req.body;

    const token = process.env.GITHUB_TOKEN;
    const model = process.env.AI_MODEL ?? 'gpt-4o-mini';
    if (!token) return reply.status(503).send({ error: 'no_ai_token', message: 'AI token not configured' });

    const systemPrompt = `You are an expert Business Central AL developer. You provide clear, actionable code quality feedback. Always respond with valid JSON only.`;

    const userPrompt = `An AL code health analyser detected this issue:

Object: ${objectType} "${objectName}"
Rule: ${ruleId}
Issue: ${message}
${procedure ? `Procedure: ${procedure}` : ''}
${detail ? `Code fragment: ${detail}` : ''}
${codeSnippet ? `\nContext:\n${codeSnippet}` : ''}

Provide a JSON response with this exact shape:
{
  "explanation": "2-3 sentence explanation of why this is a problem in BC AL",
  "impact": "Brief description of the real-world impact (performance, maintenance, etc.)",
  "suggestion": "A concrete refactoring suggestion or fix approach",
  "example": "Optional: a short AL code example showing the correct pattern (or null if not applicable)"
}`;

    const aiRes = await fetch('https://models.inference.ai.azure.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      }),
    });

    if (!aiRes.ok) return reply.status(502).send({ error: 'ai_error', message: `AI call failed: ${aiRes.status}` });
    const aiData = await aiRes.json() as { choices?: Array<{ message: { content: string } }> };
    const content = aiData.choices?.[0]?.message?.content ?? '{}';

    let parsed: Record<string, unknown>;
    try {
      const stripped = content.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
      parsed = JSON.parse(stripped) as Record<string, unknown>;
    } catch {
      return reply.status(502).send({ error: 'parse_error', message: 'AI returned invalid JSON' });
    }

    return { data: parsed };
  });
}
