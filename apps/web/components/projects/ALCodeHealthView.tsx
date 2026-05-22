'use client';

import { useCallback, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight,
  Download, FileCode2, FolderOpen, FolderTree, GitBranch,
  Info, List, Loader2, Sparkles, Ticket, X, Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

// ─── Types ────────────────────────────────────────────────────────────────────

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

interface ProjectRepo {
  id: string;
  label?: string | null;
  repoName: string;
  adoProjectName?: string | null;
  defaultBranch?: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeIssueKey(r: ObjectResult, i: HealthIssue) {
  return `${r.objectType}|${r.objectName}|${i.ruleId}|${i.line ?? 0}`;
}

function getDirectory(filePath: string): string {
  const norm = filePath.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx > 0 ? norm.substring(0, idx) : '/';
}

// ─── AL analysis (client-side, mirrors ALCodeHealthView logic) ────────────────

const AL_OBJECT_RE = /^(tableextension|table|pagecustomization|pageextension|page|codeunit|reportextension|report|xmlport|query|enumextension|enum|profile|interface|permissionset)\s+\d+\s+["']?([^"'{\n]+?)["']?\s*[{(]/im;
const AL_TYPE_MAP: Record<string, string> = {
  table: 'Table', tableextension: 'TableExtension',
  page: 'Page', pageextension: 'PageExtension', pagecustomization: 'PageCustomization',
  codeunit: 'Codeunit', report: 'Report', reportextension: 'ReportExtension',
  xmlport: 'XMLPort', query: 'Query',
  enum: 'Enum', enumextension: 'EnumExtension',
  profile: 'Profile', interface: 'Interface', permissionset: 'PermissionSet',
};

function stripStrings(line: string) { return line.replace(/'[^']*'/g, "''").replace(/\/\/.*$/, ''); }

function parseProcedures(lines: string[]): ProcInfo[] {
  const PROC_RE = /^\s*(local\s+|internal\s+|protected\s+)?(procedure|trigger)\s+"?([^"(\n]+?)"?\s*\(([^)]*)\)/i;
  const results: ProcInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = PROC_RE.exec(lines[i]);
    if (!m) continue;
    const paramCount = (m[4] ?? '').trim() === '' ? 0 : m[4].split(';').length;
    let depth = 0, found = false, end = i + 1;
    for (let j = i; j < lines.length; j++) {
      const s = stripStrings(lines[j]).toLowerCase();
      const b = (s.match(/\bbegin\b/g) ?? []).length;
      const e = (s.match(/\bend\b/g) ?? []).length;
      if (!found && b > 0) found = true;
      if (found) { depth += b - e; if (depth <= 0) { end = j + 1; break; } }
    }
    results.push({ name: m[3].trim(), startLine: i + 1, endLine: end, lineCount: end - i, paramCount });
  }
  return results;
}

function analyzeAlFile(content: string, filePath: string): ObjectResult | null {
  const m = AL_OBJECT_RE.exec(content);
  if (!m) return null;
  const bcType = AL_TYPE_MAP[m[1].toLowerCase()];
  if (!bcType) return null;
  const objectName = m[2].trim().replace(/^["']|["']$/g, '');
  const lines = content.split('\n');
  const issues: HealthIssue[] = [];

  if (lines.length > 2000) issues.push({ severity: 'warning', ruleId: 'AL0001', message: `Large object: ${lines.length} lines` });

  const procedures = parseProcedures(lines);
  for (const p of procedures) {
    if (p.lineCount > 100) issues.push({ severity: p.lineCount > 200 ? 'error' : 'warning', ruleId: 'AL0002', message: `Procedure "${p.name}" is ${p.lineCount} lines`, line: p.startLine, procedure: p.name });

    let ld = 0;
    for (let i = p.startLine - 1; i < Math.min(p.endLine, lines.length); i++) {
      const s = stripStrings(lines[i]).toLowerCase();
      if (/\brepeat\b/.test(s)) ld++;
      if (/\bwhile\b.+\bdo\b/.test(s) || /\bfor\b.+\bto\b.+\bdo\b/.test(s)) ld++;
      if (/\buntil\b/.test(s) && ld > 0) ld--;
      if (ld > 0) {
        if (/\.(findset|findfirst|findlast|find\s*\(|get\s*\()\b/i.test(lines[i])) issues.push({ severity: 'error', ruleId: 'AL0003', message: 'DB read inside loop', detail: lines[i].trim(), line: i + 1, procedure: p.name });
        if (/\bcommit\s*\(\s*\)/i.test(lines[i])) issues.push({ severity: 'error', ruleId: 'AL0004', message: 'Commit() inside loop', detail: lines[i].trim(), line: i + 1, procedure: p.name });
      }
    }

    let maxD = 0, maxL = -1;
    for (let i = p.startLine - 1; i < Math.min(p.endLine, lines.length); i++) {
      const d = Math.floor((lines[i].match(/^(\s*)/)?.[1].length ?? 0) / 4);
      if (d > maxD) { maxD = d; maxL = i + 1; }
    }
    if (maxD >= 6) issues.push({ severity: 'warning', ruleId: 'AL0005', message: `Deep nesting ≈${maxD} levels`, line: maxL, procedure: p.name });

    if (p.paramCount > 8) issues.push({ severity: 'warning', ruleId: 'AL0006', message: `Procedure "${p.name}" has ${p.paramCount} params`, line: p.startLine, procedure: p.name });
  }

  for (let i = 0; i < lines.length; i++) {
    if (/\/\/\s*(TODO|FIXME|HACK|XXX)\b/i.test(lines[i])) issues.push({ severity: 'info', ruleId: 'AL0007', message: `Dev note: ${lines[i].trim()}`, line: i + 1 });
  }

  return { objectType: bcType, objectName, filePath, lineCount: lines.length, procedures, issues };
}

function addDuplicateIssues(results: ObjectResult[]) {
  const nm = new Map<string, string[]>();
  for (const r of results) for (const p of r.procedures) { const k = p.name.toLowerCase(); if (!nm.has(k)) nm.set(k, []); nm.get(k)!.push(`${r.objectType} ${r.objectName}`); }
  for (const r of results) for (const p of r.procedures) {
    const others = (nm.get(p.name.toLowerCase()) ?? []).filter((o) => o !== `${r.objectType} ${r.objectName}`);
    if (others.length > 0) r.issues.push({ severity: 'info', ruleId: 'AL0008', message: `"${p.name}" also in: ${others.slice(0, 3).join(', ')}${others.length > 3 ? ` +${others.length - 3}` : ''}`, line: p.startLine, procedure: p.name });
  }
}

async function readEntryFiles(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) { if (!entry.name.endsWith('.al')) return []; return new Promise<File[]>((res, rej) => (entry as FileSystemFileEntry).file((f) => res([f]), rej)); }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const all: FileSystemEntry[] = [];
    for (;;) { const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej)); if (!batch.length) break; all.push(...batch); }
    return (await Promise.all(all.map(readEntryFiles))).flat();
  }
  return [];
}

// ─── Rule metadata ────────────────────────────────────────────────────────────

const RULES: Record<string, { label: string; description: string }> = {
  AL0001: { label: 'Large Object',             description: 'Object > 2000 lines' },
  AL0002: { label: 'Long Procedure',           description: 'Procedure > 100 lines' },
  AL0003: { label: 'DB Read in Loop',          description: 'FindSet/FindFirst/Get inside loop' },
  AL0004: { label: 'Commit in Loop',           description: 'Commit() inside a loop' },
  AL0005: { label: 'Deep Nesting',             description: 'Indentation ≥ 6 levels' },
  AL0006: { label: 'Too Many Params',          description: 'Procedure has > 8 parameters' },
  AL0007: { label: 'TODO Comment',             description: 'Unresolved developer note' },
  AL0008: { label: 'Duplicate Proc Name',      description: 'Same name in multiple objects' },
};

const SEV: Record<Severity, { color: string; icon: React.ReactNode }> = {
  error:   { color: 'text-red-600 bg-red-50 border-red-200 dark:text-red-400 dark:bg-red-900/30 dark:border-red-800',         icon: <AlertTriangle size={11} /> },
  warning: { color: 'text-amber-600 bg-amber-50 border-amber-200 dark:text-amber-400 dark:bg-amber-900/30 dark:border-amber-800', icon: <AlertTriangle size={11} /> },
  info:    { color: 'text-blue-600 bg-blue-50 border-blue-200 dark:text-blue-400 dark:bg-blue-900/30 dark:border-blue-800',    icon: <Info size={11} /> },
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function AiExplainModal({ issue, object, projectId, onClose }: {
  issue: HealthIssue; object: ObjectResult; projectId: string; onClose: () => void;
}) {
  const [result, setResult] = useState<Record<string, string> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function explain() {
    setLoading(true); setError('');
    try {
      const res = await api.post<{ data: Record<string, string> }>(`/api/projects/${projectId}/al-health/ai-explain`, {
        ruleId: issue.ruleId, message: issue.message, detail: issue.detail,
        procedure: issue.procedure, objectType: object.objectType, objectName: object.objectName,
      });
      setResult(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'AI call failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-xl rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900">
        <div className="flex items-center justify-between border-b border-gray-100 p-4 dark:border-gray-800">
          <div className="flex items-center gap-2">
            <Sparkles size={16} className="text-purple-500" />
            <span className="font-semibold text-gray-900 dark:text-white">AI Explanation</span>
          </div>
          <button onClick={onClose} className="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"><X size={16} /></button>
        </div>
        <div className="p-4 space-y-3">
          <div className="rounded-lg bg-gray-50 p-3 dark:bg-gray-800">
            <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">{issue.ruleId} · {object.objectType} {object.objectName}{issue.procedure ? ` · ${issue.procedure}` : ''}</div>
            <div className="text-sm text-gray-800 dark:text-gray-200">{issue.message}</div>
            {issue.detail && <div className="mt-1 font-mono text-xs text-gray-500 dark:text-gray-500 truncate">{issue.detail}</div>}
          </div>

          {!result && !loading && !error && (
            <button onClick={explain} className="flex w-full items-center justify-center gap-2 rounded-lg bg-purple-600 py-2 text-sm font-medium text-white hover:bg-purple-700">
              <Sparkles size={14} /> Explain with AI
            </button>
          )}
          {loading && <div className="flex items-center justify-center gap-2 py-4 text-sm text-gray-500"><Loader2 size={16} className="animate-spin" /> Thinking…</div>}
          {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}
          {result && (
            <div className="space-y-3">
              {[['explanation', '📋 Why this is a problem'], ['impact', '⚡ Impact'], ['suggestion', '✅ Suggested fix'], ['example', '💡 Example']] .map(([key, label]) => result[key] ? (
                <div key={key}>
                  <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">{label}</div>
                  <div className={cn('rounded-lg p-3 text-sm', key === 'example' ? 'bg-gray-900 font-mono text-green-400 text-xs whitespace-pre-wrap' : 'bg-gray-50 text-gray-800 dark:bg-gray-800 dark:text-gray-200')}>
                    {result[key]}
                  </div>
                </div>
              ) : null)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function WorkItemModal({ issue, object, projectId, onClose }: {
  issue: HealthIssue; object: ObjectResult; projectId: string; onClose: () => void;
}) {
  const [type, setType] = useState('Task');
  const [title, setTitle] = useState(`[AL Health] ${issue.ruleId}: ${object.objectType} "${object.objectName}"${issue.procedure ? ` - ${issue.procedure}` : ''}`);
  const [desc, setDesc] = useState(`## AL Code Health Issue\n\n**Rule:** ${issue.ruleId} — ${RULES[issue.ruleId]?.label ?? ''}\n**Object:** ${object.objectType} "${object.objectName}"\n${issue.procedure ? `**Procedure:** ${issue.procedure}\n` : ''}${issue.line ? `**Line:** ${issue.line}\n` : ''}\n**Issue:** ${issue.message}\n${issue.detail ? `\n\`\`\`al\n${issue.detail}\n\`\`\`` : ''}\n\n## Steps to Fix\n\n1. Open the file: \`${object.filePath}\`\n2. Review the ${issue.procedure ? `\`${issue.procedure}\` procedure` : 'object'}\n3. Apply the fix as described`);
  const [saving, setSaving] = useState(false);

  async function create() {
    setSaving(true);
    try {
      await api.post(`/api/projects/${projectId}/work-items`, { type, title, description: desc });
      toast.success('Work item created');
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create work item');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-2xl rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900">
        <div className="flex items-center justify-between border-b border-gray-100 p-4 dark:border-gray-800">
          <div className="flex items-center gap-2">
            <Ticket size={16} className="text-sky-500" />
            <span className="font-semibold text-gray-900 dark:text-white">Create Work Item</span>
          </div>
          <button onClick={onClose} className="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"><X size={16} /></button>
        </div>
        <div className="space-y-4 p-4">
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="mb-1 block text-xs font-semibold text-gray-500">Type</label>
              <select value={type} onChange={(e) => setType(e.target.value)} className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white">
                <option>Task</option><option>Bug</option><option>User Story</option>
              </select>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-500">Title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-sky-400 focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-500">Description</label>
            <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={10} className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-xs focus:border-sky-400 focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300" />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300">Cancel</button>
            <button onClick={create} disabled={saving} className="flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Ticket size={14} />} Create
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface Props { projectId: string; }
type ViewMode = 'flat' | 'tree';
type FilterSev = 'all' | Severity;

export function ALCodeHealthView({ projectId }: Props) {
  const qc = useQueryClient();
  const [results, setResults] = useState<ObjectResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [filterSev, setFilterSev] = useState<FilterSev>('all');
  const [filterRule, setFilterRule] = useState('all');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [showReviewed, setShowReviewed] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('flat');
  const [aiModal, setAiModal] = useState<{ issue: HealthIssue; object: ObjectResult } | null>(null);
  const [wiModal, setWiModal] = useState<{ issue: HealthIssue; object: ObjectResult } | null>(null);
  const [showRepoPanel, setShowRepoPanel] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState('');
  const [repoBranch, setRepoBranch] = useState('');
  const [fetchingRepo, setFetchingRepo] = useState(false);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // ── Project repos ──────────────────────────────────────────────────────────
  const { data: projectData } = useQuery({
    queryKey: ['project-repos', projectId],
    queryFn: () => api.get<{ data: { repositories: ProjectRepo[] } }>(`/api/projects/${projectId}`),
    staleTime: 60_000,
  });
  const repos = projectData?.data.repositories ?? [];

  // ── Reviews ────────────────────────────────────────────────────────────────
  const { data: reviewsData } = useQuery({
    queryKey: ['al-health-reviews', projectId],
    queryFn: () => api.get<{ data: Array<{ issueKey: string; note?: string }> }>(`/api/projects/${projectId}/al-health/reviews`),
    staleTime: 30_000,
  });
  const reviewedKeys = new Set((reviewsData?.data ?? []).map((r) => r.issueKey));

  const reviewMutation = useMutation({
    mutationFn: ({ issueKey, remove }: { issueKey: string; remove?: boolean }) =>
      remove
        ? api.delete(`/api/projects/${projectId}/al-health/reviews/${encodeURIComponent(issueKey)}`)
        : api.post(`/api/projects/${projectId}/al-health/reviews`, { issueKey }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['al-health-reviews', projectId] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed to update review'),
  });

  // ── Local folder analysis ──────────────────────────────────────────────────
  const runLocalAnalysis = useCallback(async (files: File[]) => {
    setLoading(true);
    try {
      const al = files.filter((f) => f.name.endsWith('.al'));
      if (!al.length) { toast.error('No .al files found.'); return; }
      const analysed: ObjectResult[] = [];
      for (const file of al) {
        const content = await file.text();
        const fp: string = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        const r = analyzeAlFile(content, fp);
        if (r) analysed.push(r);
      }
      addDuplicateIssues(analysed);
      setResults(analysed);
      setExpanded(new Set());
      toast.success(`Analysed ${analysed.length} objects`);
    } finally { setLoading(false); }
  }, []);

  const handleFolderInput = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    await runLocalAnalysis(Array.from(e.target.files ?? [])); e.target.value = '';
  }, [runLocalAnalysis]);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const entries: FileSystemEntry[] = [];
    for (let i = 0; i < e.dataTransfer.items.length; i++) { const en = e.dataTransfer.items[i].webkitGetAsEntry(); if (en) entries.push(en); }
    await runLocalAnalysis((await Promise.all(entries.map(readEntryFiles))).flat());
  }, [runLocalAnalysis]);

  // ── Repo fetch analysis ────────────────────────────────────────────────────
  async function fetchFromRepo() {
    if (!selectedRepo) { toast.error('Select a repository first'); return; }
    setFetchingRepo(true);
    try {
      const body: Record<string, string> = { repositoryId: selectedRepo };
      if (repoBranch) body.branch = repoBranch;
      const res = await api.post<{ data: ObjectResult[]; meta: { filesScanned: number; objectsFound: number; totalIssues: number; branch: string } }>(
        `/api/projects/${projectId}/al-health/fetch-analyse`, body
      );
      setResults(res.data);
      setExpanded(new Set());
      setShowRepoPanel(false);
      toast.success(`Fetched ${res.meta.filesScanned} files from ${res.meta.branch} — ${res.meta.totalIssues} issues`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Fetch failed');
    } finally { setFetchingRepo(false); }
  }

  // ── CSV export ─────────────────────────────────────────────────────────────
  function exportCsv() {
    const rows = [['Object', 'Type', 'Rule', 'Severity', 'Message', 'Procedure', 'Line', 'Detail', 'Reviewed']];
    for (const r of results) for (const i of r.issues) {
      const key = makeIssueKey(r, i);
      rows.push([r.objectName, r.objectType, i.ruleId, i.severity, i.message, i.procedure ?? '', String(i.line ?? ''), i.detail ?? '', reviewedKeys.has(key) ? 'Yes' : 'No']);
    }
    const csv = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: 'al-code-health.csv' });
    a.click(); URL.revokeObjectURL(a.href);
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  const allIssues = results.flatMap((r) => r.issues);
  const errorCount = allIssues.filter((i) => i.severity === 'error').length;
  const warnCount  = allIssues.filter((i) => i.severity === 'warning').length;
  const infoCount  = allIssues.filter((i) => i.severity === 'info').length;
  const reviewedCount = allIssues.filter((_, idx) => {
    const r = results.find((o) => o.issues.includes(allIssues[idx]))!;
    return r && reviewedKeys.has(makeIssueKey(r, allIssues[idx]));
  }).length;
  const presentRules = [...new Set(allIssues.map((i) => i.ruleId))].sort();

  const filteredResults = results.map((r) => ({
    ...r,
    issues: r.issues.filter((i) => {
      const key = makeIssueKey(r, i);
      if (!showReviewed && reviewedKeys.has(key)) return false;
      if (filterSev !== 'all' && i.severity !== filterSev) return false;
      if (filterRule !== 'all' && i.ruleId !== filterRule) return false;
      if (search) { const q = search.toLowerCase(); return r.objectName.toLowerCase().includes(q) || i.message.toLowerCase().includes(q) || (i.procedure?.toLowerCase().includes(q) ?? false); }
      return true;
    }),
  })).filter((r) => r.issues.length > 0);

  // ── Issue row renderer ────────────────────────────────────────────────────
  function renderIssueRow(r: ObjectResult, issue: HealthIssue) {
    const key = makeIssueKey(r, issue);
    const reviewed = reviewedKeys.has(key);
    const cfg = SEV[issue.severity];
    return (
      <div key={key} className={cn('flex items-start gap-3 px-4 py-3 text-sm border-b border-gray-100 dark:border-gray-800 last:border-0', reviewed ? 'opacity-50' : issue.severity === 'error' ? 'bg-red-50/30 dark:bg-red-900/10' : issue.severity === 'warning' ? 'bg-amber-50/30 dark:bg-amber-900/10' : '')}>
        <span className={cn('mt-0.5 flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold', cfg.color)}>{cfg.icon} {issue.ruleId}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-gray-800 dark:text-gray-200">{issue.message}</span>
            {issue.procedure && <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-mono dark:bg-gray-800 dark:text-gray-400">{issue.procedure}</span>}
            {issue.line && <span className="text-[10px] text-gray-400">:{issue.line}</span>}
            {reviewed && <span className="text-[10px] text-green-600 dark:text-green-400">✓ Reviewed</span>}
          </div>
          {issue.detail && <p className="mt-0.5 truncate text-xs text-gray-400 dark:text-gray-600" title={issue.detail}>{issue.detail}</p>}
        </div>
        {/* Actions */}
        <div className="flex shrink-0 items-center gap-1">
          <button
            title={reviewed ? 'Unmark reviewed' : 'Mark as reviewed'}
            onClick={() => reviewMutation.mutate({ issueKey: key, remove: reviewed })}
            className={cn('rounded p-1.5 text-xs transition-colors', reviewed ? 'text-green-600 hover:bg-green-50 dark:hover:bg-green-900/30' : 'text-gray-400 hover:bg-green-50 hover:text-green-600 dark:hover:bg-green-900/30')}
          >
            <CheckCircle2 size={14} />
          </button>
          <button title="AI Explain" onClick={() => setAiModal({ issue, object: r })} className="rounded p-1.5 text-gray-400 hover:bg-purple-50 hover:text-purple-600 dark:hover:bg-purple-900/30">
            <Sparkles size={14} />
          </button>
          <button title="Create Work Item" onClick={() => setWiModal({ issue, object: r })} className="rounded p-1.5 text-gray-400 hover:bg-sky-50 hover:text-sky-600 dark:hover:bg-sky-900/30">
            <Ticket size={14} />
          </button>
        </div>
      </div>
    );
  }

  // ── Object card renderer ──────────────────────────────────────────────────
  function renderObjectCard(r: ObjectResult) {
    const key = `${r.objectType}:${r.objectName}`;
    const isExp = expanded.has(key);
    const e = r.issues.filter((i) => i.severity === 'error').length;
    const w = r.issues.filter((i) => i.severity === 'warning').length;
    return (
      <div key={key} className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        <button className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50"
          onClick={() => setExpanded((p) => { const n = new Set(p); n.has(key) ? n.delete(key) : n.add(key); return n; })}>
          {isExp ? <ChevronDown size={14} className="shrink-0 text-gray-400" /> : <ChevronRight size={14} className="shrink-0 text-gray-400" />}
          <FileCode2 size={14} className="shrink-0 text-amber-500" />
          <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs font-semibold text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">{r.objectType}</span>
          <span className="font-medium text-gray-900 dark:text-white">{r.objectName}</span>
          <span className="text-xs text-gray-400">{r.lineCount} lines · {r.procedures.length} procs</span>
          <div className="ml-auto flex items-center gap-1">
            {e > 0 && <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold text-red-700 dark:bg-red-900/40 dark:text-red-300">{e}E</span>}
            {w > 0 && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">{w}W</span>}
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-bold text-gray-600 dark:bg-gray-800 dark:text-gray-400">{r.issues.length}</span>
          </div>
        </button>
        {isExp && <div className="border-t border-gray-100 dark:border-gray-800">{r.issues.map((i) => renderIssueRow(r, i))}</div>}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-gray-900 dark:text-white"><Zap size={20} className="text-amber-500" /> AL Code Health</h2>
          <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">Detect performance issues, long procedures, DB operations in loops, and more.</p>
        </div>
        {results.length > 0 && (
          <div className="flex gap-2">
            <button onClick={() => { setResults([]); setExpanded(new Set()); }} className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"><X size={13} /> Clear</button>
            <button onClick={exportCsv} className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"><Download size={13} /> CSV</button>
          </div>
        )}
      </div>

      {/* Source selection */}
      <div className="grid gap-3 sm:grid-cols-2">
        {/* Drop folder */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => folderInputRef.current?.click()}
          className={cn('flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 text-center transition-colors', dragOver ? 'border-amber-400 bg-amber-50 dark:bg-amber-900/10' : 'border-gray-300 hover:border-amber-400 hover:bg-amber-50/30 dark:border-gray-600 dark:hover:border-amber-600')}
        >
          <input ref={folderInputRef} type="file" className="hidden"
            // @ts-ignore
            webkitdirectory="" multiple onChange={handleFolderInput} />
          {loading ? <><Loader2 size={24} className="animate-spin text-amber-500" /><p className="mt-2 text-sm text-gray-500">Analysing…</p></> : <><FolderOpen size={28} className="text-amber-400" /><p className="mt-2 font-medium text-sm text-gray-700 dark:text-gray-300">Drop local AL folder</p><p className="text-xs text-gray-400">or click to browse</p></>}
        </div>

        {/* Fetch from repo */}
        <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <div className="flex items-center gap-2 mb-3">
            <GitBranch size={16} className="text-indigo-500" />
            <span className="font-semibold text-sm text-gray-900 dark:text-white">Fetch from Repo</span>
          </div>
          {repos.length === 0 ? (
            <p className="text-xs text-gray-400 dark:text-gray-600">No repositories configured. Add one in Project Setup.</p>
          ) : (
            <div className="space-y-2">
              <select value={selectedRepo} onChange={(e) => { setSelectedRepo(e.target.value); const r = repos.find((r) => r.id === e.target.value); if (r) setRepoBranch(r.defaultBranch ?? ''); }} className="w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white">
                <option value="">Select repository…</option>
                {repos.map((r) => <option key={r.id} value={r.id}>{r.label ?? r.repoName}</option>)}
              </select>
              <input value={repoBranch} onChange={(e) => setRepoBranch(e.target.value)} placeholder="Branch (default: main)" className="w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
              <button onClick={fetchFromRepo} disabled={!selectedRepo || fetchingRepo} className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                {fetchingRepo ? <><Loader2 size={14} className="animate-spin" /> Fetching…</> : <><GitBranch size={14} /> Fetch & Analyse</>}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Results */}
      {results.length > 0 && (
        <>
          {/* KPI */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {[
              { label: 'Scanned', value: results.length, bg: 'bg-gray-50 dark:bg-gray-800', color: 'text-gray-700 dark:text-gray-200' },
              { label: 'Errors',   value: errorCount,     bg: 'bg-red-50 dark:bg-red-900/20',     color: 'text-red-600 dark:text-red-400' },
              { label: 'Warnings', value: warnCount,      bg: 'bg-amber-50 dark:bg-amber-900/20', color: 'text-amber-600 dark:text-amber-400' },
              { label: 'Info',     value: infoCount,      bg: 'bg-blue-50 dark:bg-blue-900/20',   color: 'text-blue-600 dark:text-blue-400' },
              { label: 'Reviewed', value: reviewedCount,  bg: 'bg-green-50 dark:bg-green-900/20', color: 'text-green-600 dark:text-green-400' },
            ].map((k) => (
              <div key={k.label} className={`${k.bg} rounded-xl border border-gray-100 p-3 dark:border-gray-800`}>
                <div className={`text-2xl font-bold ${k.color}`}>{k.value}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">{k.label}</div>
              </div>
            ))}
          </div>

          {/* Rule pills */}
          <div className="flex flex-wrap gap-2">
            {presentRules.map((ruleId) => {
              const count = allIssues.filter((i) => i.ruleId === ruleId).length;
              const sev = allIssues.find((i) => i.ruleId === ruleId)?.severity ?? 'info';
              const cfg = SEV[sev];
              return (
                <button key={ruleId} onClick={() => setFilterRule(filterRule === ruleId ? 'all' : ruleId)}
                  className={cn('flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-all', cfg.color, filterRule === ruleId && 'ring-2 ring-current ring-offset-1 ring-offset-white dark:ring-offset-gray-900')}
                  title={RULES[ruleId]?.description}>
                  {cfg.icon} {ruleId}: {RULES[ruleId]?.label} ({count})
                </button>
              );
            })}
          </div>

          {/* Filters toolbar */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
              {(['all', 'error', 'warning', 'info'] as FilterSev[]).map((s) => (
                <button key={s} onClick={() => setFilterSev(s)} className={cn('px-3 py-1.5 text-xs font-medium capitalize transition-colors', filterSev === s ? 'bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900' : 'bg-white text-gray-500 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-400 dark:hover:bg-gray-800')}>{s}</button>
              ))}
            </div>
            <button onClick={() => setShowReviewed((v) => !v)} className={cn('flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors', showReviewed ? 'border-green-300 bg-green-50 text-green-700 dark:border-green-700 dark:bg-green-900/30 dark:text-green-300' : 'border-gray-200 bg-white text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400')}>
              <CheckCircle2 size={12} /> {showReviewed ? 'Hiding reviewed' : 'Show reviewed'}
            </button>
            <button onClick={() => setViewMode((v) => v === 'flat' ? 'tree' : 'flat')} className={cn('flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors', viewMode === 'tree' ? 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300' : 'border-gray-200 bg-white text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400')}>
              {viewMode === 'tree' ? <FolderTree size={12} /> : <List size={12} />} {viewMode === 'tree' ? 'Tree' : 'Flat'}
            </button>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…" className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm focus:border-amber-400 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />
            {(filterSev !== 'all' || filterRule !== 'all' || search) && (
              <button onClick={() => { setFilterSev('all'); setFilterRule('all'); setSearch(''); }} className="text-xs text-gray-400 hover:text-gray-600">Clear</button>
            )}
            <span className="ml-auto text-xs text-gray-400">{filteredResults.length} objects with issues</span>
          </div>

          {/* Results */}
          {filteredResults.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-gray-100 bg-gray-50 py-12 text-center dark:border-gray-800 dark:bg-gray-800/30">
              <CheckCircle2 size={28} className="text-green-500" />
              <p className="font-medium text-gray-700 dark:text-gray-300">No issues match the current filter</p>
            </div>
          ) : viewMode === 'flat' ? (
            <div className="space-y-3">{filteredResults.map((r) => renderObjectCard(r))}</div>
          ) : (
            // Tree view grouped by directory
            <div className="space-y-2">
              {(() => {
                const byDir = new Map<string, ObjectResult[]>();
                for (const r of filteredResults) { const d = getDirectory(r.filePath); if (!byDir.has(d)) byDir.set(d, []); byDir.get(d)!.push(r); }
                return [...byDir.entries()].map(([dir, objs]) => {
                  const isDirExp = expandedDirs.has(dir);
                  const totalIssues = objs.reduce((s, o) => s + o.issues.length, 0);
                  return (
                    <div key={dir} className="rounded-xl border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/50">
                      <button
                        className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-gray-100 dark:hover:bg-gray-800/50"
                        onClick={() => setExpandedDirs((p) => { const n = new Set(p); n.has(dir) ? n.delete(dir) : n.add(dir); return n; })}
                      >
                        {isDirExp ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
                        <FolderOpen size={15} className="text-amber-400 shrink-0" />
                        <span className="font-mono text-sm text-gray-600 dark:text-gray-300">{dir}</span>
                        <span className="ml-auto text-xs text-gray-400">{objs.length} objects · {totalIssues} issues</span>
                      </button>
                      {isDirExp && <div className="space-y-2 border-t border-gray-200 p-2 dark:border-gray-800">{objs.map((r) => renderObjectCard(r))}</div>}
                    </div>
                  );
                });
              })()}
            </div>
          )}
        </>
      )}

      {/* AI Explain modal */}
      {aiModal && <AiExplainModal issue={aiModal.issue} object={aiModal.object} projectId={projectId} onClose={() => setAiModal(null)} />}

      {/* Work Item modal */}
      {wiModal && <WorkItemModal issue={wiModal.issue} object={wiModal.object} projectId={projectId} onClose={() => setWiModal(null)} />}
    </div>
  );
}

