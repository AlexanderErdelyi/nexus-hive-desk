import type { FastifyInstance } from 'fastify';
import { prisma } from '@nexus/db';
import { requireAuth } from '../lib/auth';

// ─── Shared types ──────────────────────────────────────────────────────────────

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
  contentHash?: string;
  isNew?: boolean;
  isChanged?: boolean;
}

// ─── BC built-in triggers (excluded from duplicate detection) ──────────────────

const BC_BUILTIN_TRIGGERS = new Set([
  // Table record triggers
  'oninsert', 'onmodify', 'ondelete', 'onrename',
  // Field triggers
  'onvalidate', 'onlookup', 'onformat', 'onafterlookup', 'onafterformat',
  'onassistededit', 'oncontroladdins',
  // Page triggers
  'oninit', 'onopenpage', 'onclosepage',
  'onaftergetrecord', 'onaftergetcurrrecord', 'onnewrecord',
  'oninsertrecord', 'onmodifyrecord', 'ondeleterecord',
  'onqueryclosepage', 'onfindrecord', 'onnextrecord',
  'onaction', 'ondrilldildown', 'ondrilldown', 'onpagebackgroundtaskcompleted',
  'onpagebackgroundtaskerror',
  // Report triggers
  'onprereport', 'onpostreport', 'onpredataitem', 'onpostdataitem',
  'onpresection', 'onpostsection', 'onaftergetrecord',
  // Codeunit triggers
  'onrun',
  // XMLPort triggers
  'oninitxmlport', 'onbeforeinsertrecord', 'onafterinsertrecord',
  'onbeforemodifyrecord', 'onaftermodifyrecord',
  'onbeforepassvariable', 'onafterpassvariable',
  // Query triggers
  'onbeforeopen',
]);

// ─── Simple content hash ───────────────────────────────────────────────────────

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; }
  return (h >>> 0).toString(16);
}

// ─── AL parsing helpers ────────────────────────────────────────────────────────

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

// ─── Rule checks ───────────────────────────────────────────────────────────────

function checkDbInLoops(lines: string[], p0: number, p1: number, proc: string): HealthIssue[] {
  const issues: HealthIssue[] = [];
  let ld = 0;
  for (let i = p0 - 1; i < Math.min(p1, lines.length); i++) {
    const s = stripStrings(lines[i]).toLowerCase();
    if (/\brepeat\b/.test(s)) ld++;
    if (/\bwhile\b.+\bdo\b/.test(s) || /\bfor\b.+\bto\b.+\bdo\b/.test(s)) ld++;
    if (/\buntil\b/.test(s) && ld > 0) ld--;
    if (ld > 0) {
      if (/\.(findset|findfirst|findlast|find\s*\(|get\s*\()\b/i.test(lines[i]))
        issues.push({ severity: 'error', ruleId: 'AL0003', message: 'Database read operation inside loop', detail: lines[i].trim(), line: i + 1, procedure: proc });
      if (/\bcommit\s*\(\s*\)/i.test(lines[i]))
        issues.push({ severity: 'error', ruleId: 'AL0004', message: 'Commit() inside loop — severe performance issue', detail: lines[i].trim(), line: i + 1, procedure: proc });
    }
  }
  return issues;
}

function checkDeepNesting(lines: string[], p0: number, p1: number, proc: string): HealthIssue[] {
  let maxDepth = 0, maxLine = -1;
  for (let i = p0 - 1; i < Math.min(p1, lines.length); i++) {
    const d = Math.floor((lines[i].match(/^(\s*)/)?.[1].length ?? 0) / 4);
    if (d > maxDepth) { maxDepth = d; maxLine = i + 1; }
  }
  if (maxDepth >= 6) return [{ severity: 'warning', ruleId: 'AL0005', message: `Deep nesting detected (≈${maxDepth} levels) — refactor into sub-procedures`, line: maxLine, procedure: proc }];
  return [];
}

/** AL0009 – Missing SetLoadFields before FindSet/FindFirst in a read-only traversal */
function checkMissingSetLoadFields(lines: string[], p0: number, p1: number, proc: string): HealthIssue[] {
  const slice = lines.slice(p0 - 1, p1);
  const hasLoadFields = slice.some((l) => /\.(setloadfields|setautocalcfields)\s*\(/i.test(l));
  if (hasLoadFields) return [];
  const hasModify  = slice.some((l) => /\.(modify|delete|insert)\s*\(/i.test(l));
  const findLine   = slice.findIndex((l) => /\.(findset|findfirst|findlast)\s*\(/i.test(l));
  if (findLine < 0 || hasModify) return [];
  return [{
    severity: 'warning', ruleId: 'AL0009',
    message: `SetLoadFields missing before FindSet/FindFirst in "${proc}" (read-only traversal loads all fields)`,
    detail: slice[findLine].trim(), line: p0 + findLine, procedure: proc,
  }];
}

/** AL0010 – CalcFields() called inside a loop */
function checkCalcFieldsInLoop(lines: string[], p0: number, p1: number, proc: string): HealthIssue[] {
  const issues: HealthIssue[] = [];
  let ld = 0;
  for (let i = p0 - 1; i < Math.min(p1, lines.length); i++) {
    const s = stripStrings(lines[i]).toLowerCase();
    if (/\brepeat\b/.test(s)) ld++;
    if (/\bwhile\b.+\bdo\b/.test(s) || /\bfor\b.+\bto\b.+\bdo\b/.test(s)) ld++;
    if (/\buntil\b/.test(s) && ld > 0) ld--;
    if (ld > 0 && /\.calcfields\s*\(/i.test(lines[i]))
      issues.push({ severity: 'warning', ruleId: 'AL0010', message: 'CalcFields() inside loop — use SetAutoCalcFields or move outside loop', detail: lines[i].trim(), line: i + 1, procedure: proc });
  }
  return issues;
}

// ─── Main analyser ────────────────────────────────────────────────────────────

function analyzeAlContent(content: string, filePath: string): ObjectResult | null {
  const m = AL_OBJECT_RE.exec(content);
  if (!m) return null;
  const bcType = AL_TYPE_MAP[m[1].toLowerCase()];
  if (!bcType) return null;
  const objectName = m[2].trim().replace(/^["']|["']$/g, '');
  const lines = content.split('\n');
  const issues: HealthIssue[] = [];

  if (lines.length > 2000) issues.push({ severity: 'warning', ruleId: 'AL0001', message: `Large object: ${lines.length} lines — consider splitting` });

  const procedures = parseProcedures(lines);
  for (const p of procedures) {
    if (p.lineCount > 100) issues.push({ severity: p.lineCount > 200 ? 'error' : 'warning', ruleId: 'AL0002', message: `Procedure "${p.name}" is ${p.lineCount} lines long`, line: p.startLine, procedure: p.name });
    issues.push(...checkDbInLoops(lines, p.startLine, p.endLine, p.name));
    issues.push(...checkDeepNesting(lines, p.startLine, p.endLine, p.name));
    issues.push(...checkMissingSetLoadFields(lines, p.startLine, p.endLine, p.name));
    issues.push(...checkCalcFieldsInLoop(lines, p.startLine, p.endLine, p.name));
    if (p.paramCount > 8) issues.push({ severity: 'warning', ruleId: 'AL0006', message: `Procedure "${p.name}" has ${p.paramCount} parameters`, line: p.startLine, procedure: p.name });
  }

  for (let i = 0; i < lines.length; i++) {
    if (/\/\/\s*(TODO|FIXME|HACK|XXX)\b/i.test(lines[i])) issues.push({ severity: 'info', ruleId: 'AL0007', message: `Developer note: ${lines[i].trim()}`, line: i + 1 });
    // AL0011 – WITH statement (deprecated in modern AL)
    if (/^\s*with\s+[\w.]+\s+do\b/i.test(lines[i]) && !/^\s*\/\//.test(lines[i]))
      issues.push({ severity: 'warning', ruleId: 'AL0011', message: 'WITH statement is deprecated in modern AL — use explicit record variable', detail: lines[i].trim(), line: i + 1 });
  }

  return { objectType: bcType, objectName, filePath, lineCount: lines.length, procedures, issues, contentHash: simpleHash(content) };
}

function addDuplicateIssues(results: ObjectResult[]): void {
  const nameMap = new Map<string, string[]>();
  for (const r of results) for (const p of r.procedures) {
    if (BC_BUILTIN_TRIGGERS.has(p.name.toLowerCase())) continue;
    const k = p.name.toLowerCase();
    if (!nameMap.has(k)) nameMap.set(k, []);
    nameMap.get(k)!.push(`${r.objectType} ${r.objectName}`);
  }
  for (const r of results) for (const p of r.procedures) {
    if (BC_BUILTIN_TRIGGERS.has(p.name.toLowerCase())) continue;
    const others = (nameMap.get(p.name.toLowerCase()) ?? []).filter((o) => o !== `${r.objectType} ${r.objectName}`);
    if (others.length > 0) r.issues.push({ severity: 'info', ruleId: 'AL0008', message: `"${p.name}" also found in: ${others.slice(0, 3).join(', ')}${others.length > 3 ? ` +${others.length - 3} more` : ''}`, line: p.startLine, procedure: p.name });
  }
}

// ─── ADO / GitHub helpers ─────────────────────────────────────────────────────

async function fetchAdoAlFiles(baseUrl: string, adoProject: string, repoName: string, branch: string, pat: string): Promise<{ path: string; content: string }[]> {
  const auth = Buffer.from(`:${pat}`).toString('base64');
  const headers = { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' };
  const treeUrl = `${baseUrl}/${encodeURIComponent(adoProject)}/_apis/git/repositories/${encodeURIComponent(repoName)}/items?recursionLevel=Full&versionDescriptor.version=${encodeURIComponent(branch)}&versionDescriptor.versionType=branch&api-version=7.1`;
  const treeRes = await fetch(treeUrl, { headers });
  if (!treeRes.ok) throw new Error(`ADO tree fetch failed: ${treeRes.status} ${await treeRes.text().catch(() => '')}`);
  const treeData = await treeRes.json() as { value?: Array<{ path: string; gitObjectType: string }> };
  const alFiles = (treeData.value ?? []).filter((i) => i.gitObjectType === 'blob' && i.path.endsWith('.al')).slice(0, 500);
  const results: { path: string; content: string }[] = [];
  for (let i = 0; i < alFiles.length; i += 20) {
    const batch = alFiles.slice(i, i + 20);
    const fetched = await Promise.all(batch.map(async (f) => {
      const url = `${baseUrl}/${encodeURIComponent(adoProject)}/_apis/git/repositories/${encodeURIComponent(repoName)}/items?path=${encodeURIComponent(f.path)}&versionDescriptor.version=${encodeURIComponent(branch)}&versionDescriptor.versionType=branch&$format=text&api-version=7.1`;
      const r = await fetch(url, { headers });
      if (!r.ok) return null;
      return { path: f.path, content: await r.text() };
    }));
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
    const fetched = await Promise.all(batch.map(async (f) => {
      const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(f.path)}?ref=${encodeURIComponent(branch)}`, {
        headers: { ...headers, Accept: 'application/vnd.github.raw+json' },
      });
      if (!r.ok) return null;
      return { path: f.path, content: await r.text() };
    }));
    results.push(...fetched.filter((x): x is { path: string; content: string } => x !== null));
  }
  return results;
}

// ─── Routes ────────────────────────────────────────────────────────────────────

export async function alHealthRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireAuth(app));

  // GET reviews
  app.get<{ Params: { projectId: string } }>('/:projectId/al-health/reviews', async (req) => {
    const reviews = await prisma.aLHealthReview.findMany({
      where: { projectId: req.params.projectId },
      select: { issueKey: true, note: true, createdAt: true },
    });
    return { data: reviews };
  });

  // POST review
  app.post<{ Params: { projectId: string }; Body: { issueKey: string; note?: string } }>(
    '/:projectId/al-health/reviews', async (req, reply) => {
      const { issueKey, note } = req.body;
      if (!issueKey) return reply.status(400).send({ error: 'validation', message: 'issueKey required' });
      const review = await prisma.aLHealthReview.upsert({
        where: { projectId_issueKey: { projectId: req.params.projectId, issueKey } },
        update: { note: note ?? null },
        create: { projectId: req.params.projectId, issueKey, note: note ?? null },
      });
      return reply.status(201).send({ data: review });
    }
  );

  // DELETE review
  app.delete<{ Params: { projectId: string; issueKey: string } }>(
    '/:projectId/al-health/reviews/:issueKey', async (req, reply) => {
      await prisma.aLHealthReview.deleteMany({ where: { projectId: req.params.projectId, issueKey: decodeURIComponent(req.params.issueKey) } });
      return reply.status(204).send();
    }
  );

  // POST fetch-analyse (with optional baseline for diff detection)
  app.post<{
    Params: { projectId: string };
    Body: { repositoryId: string; branch?: string; baseline?: Record<string, string> };
  }>('/:projectId/al-health/fetch-analyse', async (req, reply) => {
    const { repositoryId, branch, baseline = {} } = req.body;
    const repo = await prisma.projectRepository.findUnique({ where: { id: repositoryId } });
    if (!repo) return reply.status(404).send({ error: 'not_found', message: 'Repository not found' });
    const conn = await prisma.customerConnection.findUnique({ where: { id: repo.connectionId } });
    if (!conn) return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });

    const targetBranch = branch ?? repo.defaultBranch ?? 'main';
    let files: { path: string; content: string }[];

    if (conn.type === 'github') {
      const [owner, repoName] = repo.repoName.split('/');
      if (!owner || !repoName) return reply.status(400).send({ error: 'validation', message: 'GitHub repoName must be "owner/repo"' });
      files = await fetchGitHubAlFiles(owner, repoName, targetBranch, conn.pat);
    } else {
      const baseUrl = conn.baseUrl ?? '';
      const adoProject = repo.adoProjectName ?? '';
      if (!baseUrl || !adoProject) return reply.status(400).send({ error: 'validation', message: 'ADO connection missing baseUrl or adoProjectName' });
      files = await fetchAdoAlFiles(baseUrl, adoProject, repo.repoName, targetBranch, conn.pat);
    }

    const analysed: ObjectResult[] = [];
    for (const f of files) {
      const result = analyzeAlContent(f.content, f.path);
      if (!result) continue;
      const hash = result.contentHash!;
      const prevHash = baseline[f.path];
      result.isNew = prevHash === undefined;
      result.isChanged = prevHash !== undefined && prevHash !== hash;
      analysed.push(result);
    }
    addDuplicateIssues(analysed);

    const newBaseline: Record<string, string> = {};
    for (const r of analysed) newBaseline[r.filePath] = r.contentHash!;

    const totalIssues = analysed.reduce((s, r) => s + r.issues.length, 0);
    return {
      data: analysed,
      meta: { filesScanned: files.length, objectsFound: analysed.length, totalIssues, branch: targetBranch },
      newBaseline,
    };
  });

  // POST ai-explain (single issue)
  app.post<{
    Params: { projectId: string };
    Body: { ruleId: string; message: string; detail?: string; procedure?: string; objectType: string; objectName: string; codeSnippet?: string };
  }>('/:projectId/al-health/ai-explain', async (req, reply) => {
    const { ruleId, message, detail, procedure, objectType, objectName, codeSnippet } = req.body;
    const token = process.env.GITHUB_TOKEN;
    const model = process.env.AI_MODEL ?? 'gpt-4o-mini';
    if (!token) return reply.status(503).send({ error: 'no_ai_token', message: 'AI token not configured' });

    const userPrompt = `An AL code health analyser detected this issue in a Business Central extension:

Object: ${objectType} "${objectName}"
Rule: ${ruleId}
Issue: ${message}
${procedure ? `Procedure: ${procedure}` : ''}
${detail ? `Code fragment: ${detail}` : ''}
${codeSnippet ? `\nContext:\n${codeSnippet}` : ''}

Return JSON: { "explanation": "...", "impact": "...", "suggestion": "...", "example": "..." }`;

    const aiRes = await fetch('https://models.inference.ai.azure.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: 'You are an expert Business Central AL developer. Respond with valid JSON only.' }, { role: 'user', content: userPrompt }],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      }),
    });
    if (!aiRes.ok) return reply.status(502).send({ error: 'ai_error', message: `AI call failed: ${aiRes.status}` });
    const aiData = await aiRes.json() as { choices?: Array<{ message: { content: string } }> };
    const raw = aiData.choices?.[0]?.message?.content ?? '{}';
    try {
      return { data: JSON.parse(raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim()) };
    } catch { return reply.status(502).send({ error: 'parse_error', message: 'AI returned invalid JSON' }); }
  });

  // POST ai-semantic (detect semantic duplicates / patterns across objects)
  app.post<{
    Params: { projectId: string };
    Body: { objects: Array<{ objectType: string; objectName: string; filePath: string; procedures: Array<{ name: string; lineCount: number; paramCount: number }> }> };
  }>('/:projectId/al-health/ai-semantic', async (req, reply) => {
    const { objects } = req.body;
    const token = process.env.GITHUB_TOKEN;
    const model = process.env.AI_MODEL ?? 'gpt-4o-mini';
    if (!token) return reply.status(503).send({ error: 'no_ai_token', message: 'AI token not configured' });
    if (!objects?.length) return reply.status(400).send({ error: 'validation', message: 'objects array required' });

    const summary = objects.map((o) => `${o.objectType} "${o.objectName}": [${o.procedures.map((p) => `${p.name}(${p.paramCount}p,${p.lineCount}L)`).join(', ')}]`).join('\n');

    const userPrompt = `You are reviewing Business Central AL extension code. Below are objects and their procedure signatures.
Identify: (1) procedures that likely have duplicate/overlapping logic across objects, (2) naming inconsistencies for the same operation, (3) suspicious patterns.
Do NOT flag standard BC triggers (OnValidate, OnInsert, OnModify, OnDelete, OnAction, OnAfterGetRecord, etc.).

Objects:
${summary}

Return JSON: {
  "findings": [
    {
      "type": "duplicate" | "naming" | "pattern",
      "severity": "warning" | "info",
      "message": "...",
      "affectedObjects": ["ObjectType \\"Name\\""],
      "affectedProcedures": ["ProcName"],
      "suggestion": "..."
    }
  ]
}`;

    const aiRes = await fetch('https://models.inference.ai.azure.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: 'You are an expert Business Central AL code reviewer. Respond with valid JSON only.' }, { role: 'user', content: userPrompt }],
        temperature: 0.2,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
      }),
    });
    if (!aiRes.ok) return reply.status(502).send({ error: 'ai_error', message: `AI call failed: ${aiRes.status}` });
    const aiData = await aiRes.json() as { choices?: Array<{ message: { content: string } }> };
    const raw = aiData.choices?.[0]?.message?.content ?? '{}';
    try {
      return { data: JSON.parse(raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim()) };
    } catch { return reply.status(502).send({ error: 'parse_error', message: 'AI returned invalid JSON' }); }
  });
}

