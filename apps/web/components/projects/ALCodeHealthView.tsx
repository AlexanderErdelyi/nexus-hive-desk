'use client';

import { useCallback, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, Brain, CheckCircle2, ChevronDown, ChevronRight,
  Clock, Code2, Download, EyeOff, FileCode2, FolderOpen, FolderTree, GitBranch,
  Info, List, Loader2, Plus, Sparkles, Ticket, Trash2, Wand2, X, Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { CreateBranchModal } from '@/components/shared/CreateBranchModal';
import { EmptyState } from '@/components/shared/EmptyState';
import { FindingRowSkeleton } from '@/components/shared/Skeleton';

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
  contentHash?: string;
  isNew?: boolean;
  isChanged?: boolean;
}

interface ProjectRepo {
  id: string;
  label?: string | null;
  connectionId: string;
  repoName: string;
  adoProjectName?: string | null;
  defaultBranch?: string | null;
}

interface SemanticFinding {
  type: 'duplicate' | 'naming' | 'pattern';
  severity: 'warning' | 'info';
  message: string;
  affectedObjects?: string[];
  affectedProcedures?: string[];
  suggestion?: string;
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

// ─── BC built-in triggers (excluded from duplicate detection) ─────────────────

const BC_BUILTIN_TRIGGERS = new Set([
  'onvalidate', 'onlookup', 'onformat', 'onafterlookup', 'onafterformat', 'onassistededit',
  'oninsert', 'onmodify', 'ondelete', 'onrename',
  'oninit', 'onopenpage', 'onclosepage', 'onaftergetrecord', 'onaftergetcurrrecord',
  'onnewrecord', 'oninsertrecord', 'onmodifyrecord', 'ondeleterecord',
  'onqueryclosepage', 'onfindrecord', 'onnextrecord', 'onaction', 'ondrilldown',
  'onprereport', 'onpostreport', 'onpredataitem', 'onpostdataitem', 'onpresection', 'onpostsection',
  'onrun', 'oninitxmlport', 'onbeforeinsertrecord', 'onafterinsertrecord',
  'onbeforemodifyrecord', 'onaftermodifyrecord', 'onbeforeopen',
]);

// ─── AL analysis (client-side) ────────────────────────────────────────────────

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
    const slice = lines.slice(p.startLine - 1, p.endLine);

    if (p.lineCount > 100) issues.push({ severity: p.lineCount > 200 ? 'error' : 'warning', ruleId: 'AL0002', message: `Procedure "${p.name}" is ${p.lineCount} lines`, line: p.startLine, procedure: p.name });

    // AL0003 / AL0004 – DB read / Commit in loop
    let ld = 0;
    for (let i = p.startLine - 1; i < Math.min(p.endLine, lines.length); i++) {
      const s = stripStrings(lines[i]).toLowerCase();
      if (/\brepeat\b/.test(s)) ld++;
      if (/\bwhile\b.+\bdo\b/.test(s) || /\bfor\b.+\bto\b.+\bdo\b/.test(s)) ld++;
      if (/\buntil\b/.test(s) && ld > 0) ld--;
      if (ld > 0) {
        if (/\.(findset|findfirst|findlast|find\s*\(|get\s*\()\b/i.test(lines[i])) issues.push({ severity: 'error', ruleId: 'AL0003', message: 'DB read inside loop', detail: lines[i].trim(), line: i + 1, procedure: p.name });
        if (/\bcommit\s*\(\s*\)/i.test(lines[i])) issues.push({ severity: 'error', ruleId: 'AL0004', message: 'Commit() inside loop', detail: lines[i].trim(), line: i + 1, procedure: p.name });
        // AL0010 – CalcFields in loop
        if (/\.calcfields\s*\(/i.test(lines[i])) issues.push({ severity: 'warning', ruleId: 'AL0010', message: 'CalcFields() inside loop — use SetAutoCalcFields or move outside loop', detail: lines[i].trim(), line: i + 1, procedure: p.name });
      }
    }

    // AL0005 – deep nesting
    let maxD = 0, maxL = -1;
    for (let i = p.startLine - 1; i < Math.min(p.endLine, lines.length); i++) {
      const d = Math.floor((lines[i].match(/^(\s*)/)?.[1].length ?? 0) / 4);
      if (d > maxD) { maxD = d; maxL = i + 1; }
    }
    if (maxD >= 6) issues.push({ severity: 'warning', ruleId: 'AL0005', message: `Deep nesting ≈${maxD} levels`, line: maxL, procedure: p.name });

    // AL0006 – too many params
    if (p.paramCount > 8) issues.push({ severity: 'warning', ruleId: 'AL0006', message: `Procedure "${p.name}" has ${p.paramCount} params`, line: p.startLine, procedure: p.name });

    // AL0009 – missing SetLoadFields in read-only traversal
    const hasLoadFields = slice.some((l) => /\.(setloadfields|setautocalcfields)\s*\(/i.test(l));
    if (!hasLoadFields) {
      const hasModify = slice.some((l) => /\.(modify|delete|insert)\s*\(/i.test(l));
      const findIdx = slice.findIndex((l) => /\.(findset|findfirst|findlast)\s*\(/i.test(l));
      if (findIdx >= 0 && !hasModify)
        issues.push({ severity: 'warning', ruleId: 'AL0009', message: `SetLoadFields missing before FindSet/FindFirst in "${p.name}" (read-only — all fields loaded)`, detail: slice[findIdx].trim(), line: p.startLine + findIdx, procedure: p.name });
    }
  }

  for (let i = 0; i < lines.length; i++) {
    if (/\/\/\s*(TODO|FIXME|HACK|XXX)\b/i.test(lines[i])) issues.push({ severity: 'info', ruleId: 'AL0007', message: `Dev note: ${lines[i].trim()}`, line: i + 1 });
    // AL0011 – WITH statement (deprecated in modern AL)
    if (/^\s*with\s+[\w.]+\s+do\b/i.test(lines[i]) && !/^\s*\/\//.test(lines[i]))
      issues.push({ severity: 'warning', ruleId: 'AL0011', message: 'WITH statement is deprecated in modern AL — use explicit record variable', detail: lines[i].trim(), line: i + 1 });
  }

  return { objectType: bcType, objectName, filePath, lineCount: lines.length, procedures, issues };
}

function addDuplicateIssues(results: ObjectResult[]) {
  const nm = new Map<string, string[]>();
  for (const r of results) for (const p of r.procedures) {
    if (BC_BUILTIN_TRIGGERS.has(p.name.toLowerCase())) continue;
    const k = p.name.toLowerCase(); if (!nm.has(k)) nm.set(k, []); nm.get(k)!.push(`${r.objectType} ${r.objectName}`);
  }
  for (const r of results) for (const p of r.procedures) {
    if (BC_BUILTIN_TRIGGERS.has(p.name.toLowerCase())) continue;
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
  AL0001: { label: 'Large Object',           description: 'Object > 2000 lines' },
  AL0002: { label: 'Long Procedure',         description: 'Procedure > 100 lines' },
  AL0003: { label: 'DB Read in Loop',        description: 'FindSet/FindFirst/Get inside loop' },
  AL0004: { label: 'Commit in Loop',         description: 'Commit() inside a loop' },
  AL0005: { label: 'Deep Nesting',           description: 'Indentation ≥ 6 levels' },
  AL0006: { label: 'Too Many Params',        description: 'Procedure has > 8 parameters' },
  AL0007: { label: 'TODO Comment',           description: 'Unresolved developer note' },
  AL0008: { label: 'Duplicate Proc Name',    description: 'Same name in multiple objects (non-BC-built-in)' },
  AL0009: { label: 'Missing SetLoadFields',  description: 'FindSet/FindFirst without SetLoadFields in read-only loop' },
  AL0010: { label: 'CalcFields in Loop',     description: 'CalcFields() called inside a loop' },
  AL0011: { label: 'WITH Deprecated',        description: 'WITH statement is deprecated in modern AL' },
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
            {issue.detail && <div className="mt-1 font-mono text-xs text-gray-500 dark:text-gray-500 truncate">{typeof issue.detail === 'string' ? issue.detail : JSON.stringify(issue.detail)}</div>}
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
  const detailStr = issue.detail ? (typeof issue.detail === 'string' ? issue.detail : JSON.stringify(issue.detail)) : '';
  const [desc, setDesc] = useState(`## AL Code Health Issue\n\n**Rule:** ${issue.ruleId} — ${RULES[issue.ruleId]?.label ?? ''}\n**Object:** ${object.objectType} "${object.objectName}"\n${issue.procedure ? `**Procedure:** ${issue.procedure}\n` : ''}${issue.line ? `**Line:** ${issue.line}\n` : ''}\n**Issue:** ${issue.message}\n${detailStr ? `\n\`\`\`al\n${detailStr}\n\`\`\`` : ''}\n\n## Steps to Fix\n\n1. Open the file: \`${object.filePath}\`\n2. Review the ${issue.procedure ? `\`${issue.procedure}\` procedure` : 'object'}\n3. Apply the fix as described`);
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

// ─── AI Refactor Modal ────────────────────────────────────────────────────────

function AiRefactorModal({ issue, object, projectId, onClose }: {
  issue: HealthIssue; object: ObjectResult; projectId: string; onClose: () => void;
}) {
  const [result, setResult] = useState<{ before?: string; after?: string; explanation?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function refactor() {
    setLoading(true); setError('');
    try {
      const res = await api.post<{ data: { before?: string; after?: string; explanation?: string } }>(
        `/api/projects/${projectId}/al-health/ai-refactor`,
        { ruleId: issue.ruleId, message: issue.message, detail: typeof issue.detail === 'string' ? issue.detail : undefined, procedure: issue.procedure, objectType: object.objectType, objectName: object.objectName }
      );
      setResult(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'AI call failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-2xl rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900">
        <div className="flex items-center justify-between border-b border-gray-100 p-4 dark:border-gray-800">
          <div className="flex items-center gap-2">
            <Code2 size={16} className="text-emerald-500" />
            <span className="font-semibold text-gray-900 dark:text-white">AI Refactor Suggestion</span>
          </div>
          <button onClick={onClose} className="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"><X size={16} /></button>
        </div>
        <div className="p-4 space-y-3">
          <div className="rounded-lg bg-gray-50 p-3 dark:bg-gray-800">
            <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">{issue.ruleId} · {object.objectType} {object.objectName}{issue.procedure ? ` · ${issue.procedure}` : ''}</div>
            <div className="text-sm text-gray-800 dark:text-gray-200">{issue.message}</div>
          </div>
          {!result && !loading && !error && (
            <button onClick={refactor} className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 py-2 text-sm font-medium text-white hover:bg-emerald-700">
              <Code2 size={14} /> Generate Refactored Code
            </button>
          )}
          {loading && <div className="flex items-center justify-center gap-2 py-4 text-sm text-gray-500"><Loader2 size={16} className="animate-spin" /> Generating…</div>}
          {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}
          {result && (
            <div className="space-y-3">
              {result.explanation && (
                <div className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-200">{result.explanation}</div>
              )}
              {result.before && (
                <div>
                  <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-red-600 dark:text-red-400">❌ Before</div>
                  <pre className="overflow-x-auto rounded-lg bg-red-950 p-3 text-xs text-red-200 whitespace-pre-wrap">{result.before}</pre>
                </div>
              )}
              {result.after && (
                <div>
                  <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-green-600 dark:text-green-400">✅ After</div>
                  <pre className="overflow-x-auto rounded-lg bg-gray-900 p-3 text-xs text-green-300 whitespace-pre-wrap">{result.after}</pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Code View Modal ──────────────────────────────────────────────────────────

function CodeViewModal({ object, issue, repoId, branch, projectId, onClose }: {
  object: ObjectResult; issue?: HealthIssue; repoId: string; branch: string; projectId: string; onClose: () => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['al-file-content', repoId, object.filePath, branch],
    queryFn: () => api.get<{ data: string }>(`/api/projects/${projectId}/al-health/repos/${repoId}/file?path=${encodeURIComponent(object.filePath)}&branch=${encodeURIComponent(branch)}`),
    staleTime: 120_000,
  });

  const content = data?.data ?? '';
  const lines = content.split('\n');
  const targetLine = issue?.line ?? 1;
  const start = Math.max(0, targetLine - 15);
  const end = Math.min(lines.length, targetLine + 15);
  const snippet = lines.slice(start, end);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex w-full max-w-3xl flex-col rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900" style={{ maxHeight: '85vh' }}>
        <div className="flex items-center justify-between border-b border-gray-100 p-4 dark:border-gray-800">
          <div className="flex items-center gap-2">
            <FileCode2 size={16} className="text-amber-500" />
            <span className="font-semibold text-gray-900 dark:text-white truncate">{object.filePath.split('/').pop()}</span>
            {issue?.line && <span className="text-xs text-gray-400">:{issue.line}</span>}
          </div>
          <button onClick={onClose} className="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"><X size={16} /></button>
        </div>
        <div className="overflow-auto flex-1 p-4">
          {isLoading && <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 size={16} className="animate-spin" /> Loading file…</div>}
          {error && <div className="text-sm text-red-500">Failed to load file content</div>}
          {content && (
            <pre className="text-xs font-mono text-gray-800 dark:text-gray-200 whitespace-pre leading-5">
              {snippet.map((line, i) => {
                const lineNo = start + i + 1;
                const isTarget = lineNo === targetLine;
                return (
                  <div key={lineNo} className={cn('flex gap-3 px-2 rounded', isTarget ? 'bg-amber-100 dark:bg-amber-900/30' : 'hover:bg-gray-50 dark:hover:bg-gray-800/30')}>
                    <span className="shrink-0 w-8 text-right text-gray-400 select-none">{lineNo}</span>
                    <span className={isTarget ? 'text-amber-800 dark:text-amber-200 font-semibold' : ''}>{line}</span>
                  </div>
                );
              })}
            </pre>
          )}
        </div>
        <div className="border-t border-gray-100 p-3 dark:border-gray-800 text-xs text-gray-400 font-mono truncate">{object.filePath}</div>
      </div>
    </div>
  );
}

// ─── Work Item Queue Modal ────────────────────────────────────────────────────

interface QueuedIssue { issue: HealthIssue; object: ObjectResult; key: string }

function WorkItemQueueModal({ queued, projectId, onClose, onClear }: {
  queued: QueuedIssue[]; projectId: string; onClose: () => void; onClear: () => void;
}) {
  const [type, setType] = useState('Task');
  const [title, setTitle] = useState(`[AL Health] ${queued.length} issues queued for review`);
  const [createMode, setCreateMode] = useState<'combined' | 'per-finding' | 'per-file'>('combined');
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const desc = `## AL Code Health Issues\n\n${queued.map((q, i) =>
    `### ${i + 1}. ${q.issue.ruleId}: ${q.object.objectType} "${q.object.objectName}"${q.issue.procedure ? ` · ${q.issue.procedure}` : ''}\n**Issue:** ${q.issue.message}${q.issue.line ? ` (line ${q.issue.line})` : ''}\n\`${q.object.filePath}\``
  ).join('\n\n')}`;

  async function createCombined() {
    setSaving(true);
    try {
      await api.post(`/api/projects/${projectId}/work-items`, { type, title, description: desc });
      toast.success('Work item created with all queued issues');
      onClear(); onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create work item');
    } finally { setSaving(false); }
  }

  async function createAll() {
    let items: Array<{ title: string; description: string }> = [];
    if (createMode === 'per-finding') {
      items = queued.map((q) => ({
        title: `[AL ${q.issue.ruleId}] ${q.object.objectType} "${q.object.objectName}"${q.issue.procedure ? ` · ${q.issue.procedure}` : ''}`,
        description: `## AL Code Health Finding\n\n**Rule:** ${q.issue.ruleId}\n**Object:** ${q.object.objectType} "${q.object.objectName}"\n**Issue:** ${q.issue.message}${q.issue.line ? ` (line ${q.issue.line})` : ''}${q.issue.detail ? `\n**Detail:** ${q.issue.detail}` : ''}\n\`${q.object.filePath}\``,
      }));
    } else {
      const byFile = new Map<string, QueuedIssue[]>();
      for (const q of queued) { if (!byFile.has(q.object.filePath)) byFile.set(q.object.filePath, []); byFile.get(q.object.filePath)!.push(q); }
      items = [...byFile.entries()].map(([filePath, qs]) => ({
        title: `[AL Health] ${filePath.split('/').pop()} — ${qs.length} issue${qs.length === 1 ? '' : 's'}`,
        description: `## AL Code Health Issues in \`${filePath}\`\n\n${qs.map((q, i) => `### ${i + 1}. ${q.issue.ruleId}: ${q.object.objectType} "${q.object.objectName}"${q.issue.procedure ? ` · ${q.issue.procedure}` : ''}\n**Issue:** ${q.issue.message}${q.issue.line ? ` (line ${q.issue.line})` : ''}`).join('\n\n')}`,
      }));
    }
    setSaving(true);
    setProgress({ done: 0, total: items.length });
    let successCount = 0; let failCount = 0;
    for (const item of items) {
      try {
        await api.post(`/api/projects/${projectId}/work-items`, { type, title: item.title, description: item.description });
        successCount++;
      } catch { failCount++; }
      setProgress({ done: successCount + failCount, total: items.length });
    }
    setProgress(null); setSaving(false);
    if (failCount === 0) toast.success(`${successCount} work item${successCount === 1 ? '' : 's'} created`);
    else toast.warning(`${successCount} created, ${failCount} failed`);
    if (successCount > 0) { onClear(); onClose(); }
  }

  const uniqueFiles = new Set(queued.map((q) => q.object.filePath)).size;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex w-full max-w-2xl flex-col rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900" style={{ maxHeight: '85vh' }}>
        <div className="flex items-center justify-between border-b border-gray-100 p-4 dark:border-gray-800">
          <div className="flex items-center gap-2">
            <Ticket size={16} className="text-sky-500" />
            <span className="font-semibold text-gray-900 dark:text-white">Create Work Item from Queue</span>
            <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-bold text-sky-700 dark:bg-sky-900/30 dark:text-sky-300">{queued.length}</span>
          </div>
          <button onClick={onClose} className="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"><X size={16} /></button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <div className="divide-y divide-gray-100 dark:divide-gray-800 max-h-48 overflow-y-auto">
            {queued.map((q) => (
              <div key={q.key} className="flex items-start gap-2 px-4 py-2 text-xs">
                <span className="shrink-0 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 font-semibold text-amber-700 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-400">{q.issue.ruleId}</span>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-gray-800 dark:text-gray-200 truncate">{q.object.objectType} &ldquo;{q.object.objectName}&rdquo;{q.issue.procedure ? ` · ${q.issue.procedure}` : ''}</div>
                  <div className="text-gray-500 dark:text-gray-400 truncate">{q.issue.message}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="space-y-3 p-4 border-t border-gray-100 dark:border-gray-800">
            {/* Create mode */}
            <div>
              <label className="mb-1.5 block text-xs font-semibold text-gray-500">Create Mode</label>
              <div className="flex gap-2 flex-wrap">
                {([
                  { id: 'combined', label: '1 work item (all issues)' },
                  { id: 'per-finding', label: `${queued.length} items (per finding)` },
                  { id: 'per-file', label: `${uniqueFiles} items (per file)` },
                ] as const).map((m) => (
                  <button key={m.id} onClick={() => setCreateMode(m.id)}
                    className={cn('rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors', createMode === m.id ? 'border-sky-400 bg-sky-50 text-sky-700 dark:border-sky-600 dark:bg-sky-900/30 dark:text-sky-300' : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400')}>
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-3">
              <div className="w-32">
                <label className="mb-1 block text-xs font-semibold text-gray-500">Type</label>
                <select value={type} onChange={(e) => setType(e.target.value)} className="w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white">
                  <option>Task</option><option>Bug</option><option>User Story</option>
                </select>
              </div>
              {createMode === 'combined' && (
                <div className="flex-1">
                  <label className="mb-1 block text-xs font-semibold text-gray-500">Title</label>
                  <input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm focus:border-sky-400 focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
                </div>
              )}
            </div>
            {/* Progress */}
            {progress && (
              <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 dark:border-sky-800 dark:bg-sky-900/20">
                <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-sky-700 dark:text-sky-300">
                  <span className="flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> Creating work items…</span>
                  <span>{progress.done} / {progress.total}</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-sky-200 dark:bg-sky-800">
                  <div className="h-full rounded-full bg-sky-500 transition-all duration-300" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="flex justify-between border-t border-gray-100 p-4 dark:border-gray-800">
          <button onClick={onClear} className="flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400">
            <Trash2 size={13} /> Clear Queue
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300">Cancel</button>
            {createMode === 'combined' ? (
              <button onClick={createCombined} disabled={saving} className="flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Ticket size={14} />} Create Work Item
              </button>
            ) : (
              <button onClick={createAll} disabled={saving} className="flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Ticket size={14} />} Create All
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── AI Semantic Modal ────────────────────────────────────────────────────────

interface ProcMatch { object: ObjectResult; proc: ProcInfo; vsUrl: string | null; }

function findProcMatches(results: ObjectResult[], affObjs: string[], affProcs: string[], wsPath?: string): ProcMatch[] {
  // Strip AI-added suffixes like "(2p,20L)" and quotes
  const cleanName = (s: string) => s.replace(/\s*\(\d+p,\d+L\)$/, '').trim().replace(/^["']|["']$/g, '');

  // Parse affected object names: "Codeunit \"BC OnPrem File Functions\"" → "BC OnPrem File Functions"
  const objNames = affObjs.map((o) => {
    const m = o.match(/"([^"]+)"/);
    return m ? m[1].toLowerCase() : o.toLowerCase();
  });

  const matches: ProcMatch[] = [];
  for (const rawProc of affProcs) {
    const procName = cleanName(rawProc).toLowerCase();
    // Search in affected objects first, then all results
    const searchIn = objNames.length > 0
      ? results.filter((r) => objNames.some((n) => r.objectName.toLowerCase().includes(n) || n.includes(r.objectName.toLowerCase())))
      : results;
    const candidates = searchIn.length > 0 ? searchIn : results;
    for (const r of candidates) {
      const proc = r.procedures.find((p) => p.name.toLowerCase() === procName);
      if (proc) {
        const vsUrl = wsPath && proc.startLine
          ? `vscode://file/${[wsPath, r.filePath].join('/').replace(/\\/g, '/').replace(/\/+/g, '/')}:${proc.startLine}`
          : null;
        matches.push({ object: r, proc, vsUrl });
        break;
      }
    }
  }
  return matches;
}

function ProcComparePanel({ matches }: { matches: ProcMatch[] }) {
  if (matches.length === 0) return null;
  return (
    <div className="mt-3 rounded-xl border border-violet-200 bg-violet-50/50 dark:border-violet-800 dark:bg-violet-900/10">
      <div className="flex items-center gap-2 border-b border-violet-200 px-3 py-2 dark:border-violet-800">
        <FileCode2 size={12} className="text-violet-500" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-violet-600 dark:text-violet-400">Procedure Comparison</span>
      </div>
      <div className="grid gap-2 p-3" style={{ gridTemplateColumns: `repeat(${Math.min(matches.length, 3)}, 1fr)` }}>
        {matches.map((m, i) => (
          <div key={i} className="flex flex-col gap-1.5 rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
            <div className="font-mono text-xs font-bold text-gray-800 dark:text-gray-100 truncate" title={m.proc.name}>{m.proc.name}</div>
            <div className="text-[10px] text-gray-500 dark:text-gray-400 truncate">{m.object.objectType} &ldquo;{m.object.objectName}&rdquo;</div>
            <div className="text-[10px] font-mono text-gray-400 truncate" title={m.object.filePath}>{m.object.filePath.split('/').pop()}</div>
            <div className="mt-0.5 flex flex-wrap gap-2 text-[10px] text-gray-500">
              <span className="flex items-center gap-0.5">📏 {m.proc.lineCount} lines</span>
              <span className="flex items-center gap-0.5">🔢 {m.proc.paramCount} params</span>
              <span className="flex items-center gap-0.5">📍 :{m.proc.startLine}</span>
            </div>
            {m.vsUrl ? (
              <a href={m.vsUrl} title="Open in VS Code" className="mt-1 flex items-center justify-center gap-1.5 rounded border border-blue-200 bg-blue-50 px-2 py-1 text-[10px] font-medium text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-400">
                <Code2 size={10} /> Open in VS Code
              </a>
            ) : (
              <span className="mt-1 rounded border border-gray-100 px-2 py-1 text-center text-[10px] text-gray-300 dark:border-gray-800 dark:text-gray-600">Set workspace path for VS Code link</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function AiSemanticModal({ results, projectId, localWorkspacePath, lastFetchedRepoId, lastFetchedBranch, onClose, onAddToQueue }: {
  results: ObjectResult[];
  projectId: string;
  localWorkspacePath?: string;
  lastFetchedRepoId?: string;
  lastFetchedBranch?: string;
  onClose: () => void;
  onAddToQueue?: (issue: HealthIssue, object: ObjectResult, key: string) => void;
}) {
  const [findings, setFindings] = useState<SemanticFinding[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'all' | 'custom'>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [listView, setListView] = useState<'flat' | 'tree'>('flat');
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set());
  const [expandedFinding, setExpandedFinding] = useState<number | null>(null);
  const [selectedModel, setSelectedModel] = useState('gpt-4o');
  // Local sub-modal state (self-contained)
  const [localRefactor, setLocalRefactor] = useState<{ issue: HealthIssue; object: ObjectResult } | null>(null);
  const [localCode, setLocalCode] = useState<{ issue: HealthIssue; object: ObjectResult } | null>(null);
  const [localWi, setLocalWi] = useState<{ issue: HealthIssue; object: ObjectResult } | null>(null);

  const MODELS = [
    { value: 'gpt-4o',       label: 'GPT-4o (Recommended)' },
    { value: 'gpt-4o-mini',  label: 'GPT-4o Mini (Fast)' },
    { value: 'gpt-4.1',      label: 'GPT-4.1' },
    { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
    { value: 'o3-mini',      label: 'o3-mini (Deep reasoning)' },
  ];

  const targets = mode === 'all' ? results : results.filter((r) => selected.has(`${r.objectType}|${r.objectName}`));

  async function scan() {
    setLoading(true); setError(''); setExpandedFinding(null);
    try {
      const res = await api.post<{ data: { findings: SemanticFinding[] } }>(`/api/projects/${projectId}/al-health/ai-semantic`, {
        objects: targets.map((o) => ({ objectType: o.objectType, objectName: o.objectName, filePath: o.filePath, procedures: o.procedures })),
        model: selectedModel,
      });
      setFindings(res.data.findings ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : 'AI scan failed'); } finally { setLoading(false); }
  }

  function toggle(key: string) { setSelected((p) => { const n = new Set(p); n.has(key) ? n.delete(key) : n.add(key); return n; }); }
  function toggleType(t: string) { setExpandedTypes((p) => { const n = new Set(p); n.has(t) ? n.delete(t) : n.add(t); return n; }); }

  /** Convert a SemanticFinding to a HealthIssue for use in action modals */
  function findingToIssue(f: SemanticFinding): HealthIssue {
    return {
      severity: f.severity === 'info' ? 'info' : 'warning',
      ruleId: `semantic-${f.type}`,
      message: f.message,
      detail: f.suggestion,
    };
  }

  /** Find the first ObjectResult that matches one of the finding's affectedObjects */
  function findingToObject(f: SemanticFinding): ObjectResult | null {
    if (!f.affectedObjects?.length) return results[0] ?? null;
    const cleanName = (s: string) => { const m = s.match(/"([^"]+)"/); return (m ? m[1] : s).toLowerCase(); };
    for (const ao of f.affectedObjects) {
      const name = cleanName(ao);
      const match = results.find((r) => r.objectName.toLowerCase() === name || r.objectName.toLowerCase().includes(name) || name.includes(r.objectName.toLowerCase()));
      if (match) return match;
    }
    return results[0] ?? null;
  }

  // Group objects by objectType for tree view
  const objectsByType = results.reduce<Record<string, ObjectResult[]>>((acc, r) => {
    if (!acc[r.objectType]) acc[r.objectType] = [];
    acc[r.objectType].push(r);
    return acc;
  }, {});

  function renderObjectItem(r: ObjectResult) {
    const k = `${r.objectType}|${r.objectName}`;
    const checked = mode === 'all' || selected.has(k);
    return (
      <label key={k} className={cn('flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs', mode === 'custom' && selected.has(k) ? 'bg-violet-50 dark:bg-violet-900/20' : 'hover:bg-gray-50 dark:hover:bg-gray-800')}>
        <input type="checkbox" disabled={mode === 'all'} checked={checked} onChange={() => toggle(k)} className="accent-violet-500" />
        <span className="truncate text-gray-700 dark:text-gray-300" title={r.objectName}>{r.objectName}</span>
      </label>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex h-[85vh] w-full max-w-4xl flex-col rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-100 p-4 dark:border-gray-800">
          <div className="flex items-center gap-2">
            <Brain size={16} className="text-violet-500" />
            <span className="font-semibold text-gray-900 dark:text-white">AI Semantic Analysis</span>
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-800">{targets.length} objects</span>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs text-gray-600 focus:border-violet-400 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
              title="AI Model"
            >
              {MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
            <button onClick={onClose} className="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"><X size={16} /></button>
          </div>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Left: object selector */}
          <div className="flex w-60 shrink-0 flex-col border-r border-gray-100 dark:border-gray-800">
            {/* Mode + view toggles */}
            <div className="space-y-1 border-b border-gray-100 p-2 dark:border-gray-800">
              <div className="flex gap-1">
                <button onClick={() => setMode('all')} className={cn('flex-1 rounded py-1 text-xs font-medium', mode === 'all' ? 'bg-violet-600 text-white' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800')}>All</button>
                <button onClick={() => setMode('custom')} className={cn('flex-1 rounded py-1 text-xs font-medium', mode === 'custom' ? 'bg-violet-600 text-white' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800')}>Select</button>
              </div>
              <div className="flex gap-1">
                <button onClick={() => setListView('flat')} title="Flat list" className={cn('flex flex-1 items-center justify-center gap-1 rounded py-1 text-xs', listView === 'flat' ? 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200' : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800')}>
                  <List size={11} /> Flat
                </button>
                <button onClick={() => { setListView('tree'); setExpandedTypes(new Set(Object.keys(objectsByType))); }} title="Tree view" className={cn('flex flex-1 items-center justify-center gap-1 rounded py-1 text-xs', listView === 'tree' ? 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200' : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800')}>
                  <FolderTree size={11} /> Tree
                </button>
              </div>
            </div>

            {/* Object list */}
            <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
              {listView === 'flat'
                ? results.map((r) => renderObjectItem(r))
                : Object.entries(objectsByType).sort().map(([type, objs]) => (
                    <div key={type}>
                      <button
                        onClick={() => toggleType(type)}
                        className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs font-semibold text-gray-500 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-800"
                      >
                        {expandedTypes.has(type) ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                        <span className="rounded bg-amber-50 px-1 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400">{type}</span>
                        <span className="ml-auto text-[10px] text-gray-400">{objs.length}</span>
                      </button>
                      {expandedTypes.has(type) && (
                        <div className="ml-3 space-y-0.5">{objs.map((r) => renderObjectItem(r))}</div>
                      )}
                    </div>
                  ))
              }
            </div>
          </div>

          {/* Right: findings */}
          <div className="flex flex-1 flex-col overflow-hidden">
            {findings.length === 0 && !loading && !error && (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
                <Brain size={36} className="text-gray-300 dark:text-gray-600" />
                <p className="text-sm text-gray-500">Scan {targets.length} objects to detect semantic duplicates, naming inconsistencies, and patterns that static rules can&apos;t find.</p>
                <p className="text-xs text-gray-400">Model: <span className="font-medium text-violet-500">{MODELS.find((m) => m.value === selectedModel)?.label ?? selectedModel}</span></p>
                <button onClick={scan} disabled={targets.length === 0} className="flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50">
                  <Brain size={14} /> Scan {targets.length} Objects
                </button>
              </div>
            )}
            {loading && <div className="flex flex-1 items-center justify-center gap-2 text-sm text-gray-500"><Loader2 size={18} className="animate-spin" /> AI is analysing…</div>}
            {error && <div className="p-4 text-sm text-red-600 dark:text-red-400">{error} <button onClick={scan} className="underline">Retry</button></div>}
            {findings.length > 0 && (
              <div className="flex flex-1 flex-col overflow-hidden">
                <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2 dark:border-gray-800">
                  <span className="text-xs text-gray-500">{findings.length} finding{findings.length !== 1 ? 's' : ''}</span>
                  <button onClick={scan} className="flex items-center gap-1 text-xs text-violet-600 hover:underline"><Brain size={12} /> Re-scan</button>
                </div>
                <div className="flex-1 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-800">
                  {findings.map((f, i) => {
                    const isExpandable = (f.affectedProcedures?.length ?? 0) > 0;
                    const isExpanded = expandedFinding === i;
                    const procMatches = isExpanded
                      ? findProcMatches(results, f.affectedObjects ?? [], f.affectedProcedures ?? [], localWorkspacePath)
                      : [];

                    return (
                      <div key={i} className={cn('px-4 py-3 space-y-2', isExpandable && 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50')}
                        onClick={() => isExpandable && setExpandedFinding(isExpanded ? null : i)}>
                        <div className="flex items-start gap-2">
                          <span className={cn('mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase', f.type === 'duplicate' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' : f.type === 'naming' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300')}>{f.type}</span>
                          <span className="flex-1 text-sm font-medium text-gray-800 dark:text-gray-200">{f.message}</span>
                          {isExpandable && (
                            <span className="ml-auto shrink-0 text-[10px] text-violet-500">{isExpanded ? '▲ hide' : '▼ compare'}</span>
                          )}
                        </div>

                        {/* Affected objects */}
                        {f.affectedObjects && f.affectedObjects.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {f.affectedObjects.map((o, j) => (
                              <span key={j} className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] dark:bg-gray-800 dark:text-gray-400">{o}</span>
                            ))}
                          </div>
                        )}

                        {/* Affected procedures */}
                        {f.affectedProcedures && f.affectedProcedures.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {f.affectedProcedures.map((p, j) => (
                              <span key={j} className="rounded bg-violet-50 px-1.5 py-0.5 font-mono text-[10px] text-violet-700 dark:bg-violet-900/20 dark:text-violet-300">{p}</span>
                            ))}
                          </div>
                        )}

                        {f.suggestion && <p className="text-xs text-gray-500 dark:text-gray-400">{f.suggestion}</p>}

                        {/* Action buttons — always rendered */}
                        {(() => {
                          const issue = findingToIssue(f);
                          const obj = findingToObject(f);
                          if (!obj) return null;
                          const qKey = `semantic:${f.type}:${f.message.slice(0, 60)}`;
                          return (
                            <div className="flex flex-wrap gap-1.5 pt-1" onClick={(e) => e.stopPropagation()}>
                              <button
                                title="AI Refactor suggestion"
                                onClick={() => setLocalRefactor({ issue, object: obj })}
                                className="flex items-center gap-1 rounded border border-orange-200 bg-orange-50 px-2 py-0.5 text-[10px] font-medium text-orange-700 hover:bg-orange-100 dark:border-orange-800 dark:bg-orange-900/20 dark:text-orange-300"
                              >
                                <Wand2 size={10} /> AI Refactor
                              </button>
                              {lastFetchedRepoId && (
                                <button
                                  title="View source code"
                                  onClick={() => setLocalCode({ issue, object: obj })}
                                  className="flex items-center gap-1 rounded border border-teal-200 bg-teal-50 px-2 py-0.5 text-[10px] font-medium text-teal-700 hover:bg-teal-100 dark:border-teal-800 dark:bg-teal-900/20 dark:text-teal-300"
                                >
                                  <Code2 size={10} /> View Code
                                </button>
                              )}
                              <button
                                title="Create Work Item"
                                onClick={() => setLocalWi({ issue, object: obj })}
                                className="flex items-center gap-1 rounded border border-sky-200 bg-sky-50 px-2 py-0.5 text-[10px] font-medium text-sky-700 hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-900/20 dark:text-sky-300"
                              >
                                <Ticket size={10} /> Work Item
                              </button>
                              <button
                                title="Add to work item queue"
                                onClick={() => {
                                  onAddToQueue?.(issue, obj, qKey);
                                  toast.success('Added to queue');
                                }}
                                className="flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300"
                              >
                                <Plus size={10} /> Add to Queue
                              </button>
                            </div>
                          );
                        })()}

                        {/* Comparison panel (inline, shown when expanded) */}
                        {isExpanded && <ProcComparePanel matches={procMatches} />}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Self-contained sub-modals stacked over the semantic modal */}
      {localRefactor && (
        <AiRefactorModal issue={localRefactor.issue} object={localRefactor.object} projectId={projectId} onClose={() => setLocalRefactor(null)} />
      )}
      {localCode && lastFetchedRepoId && (
        <CodeViewModal object={localCode.object} issue={localCode.issue} repoId={lastFetchedRepoId} branch={lastFetchedBranch ?? ''} projectId={projectId} onClose={() => setLocalCode(null)} />
      )}
      {localWi && (
        <WorkItemModal issue={localWi.issue} object={localWi.object} projectId={projectId} onClose={() => setLocalWi(null)} />
      )}
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
  const [showNew, setShowNew] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('flat');
  const [aiModal, setAiModal] = useState<{ issue: HealthIssue; object: ObjectResult } | null>(null);
  const [refactorModal, setRefactorModal] = useState<{ issue: HealthIssue; object: ObjectResult } | null>(null);
  const [codeModal, setCodeModal] = useState<{ issue: HealthIssue; object: ObjectResult } | null>(null);
  const [wiModal, setWiModal] = useState<{ issue: HealthIssue; object: ObjectResult } | null>(null);
  const [semanticModal, setSemanticModal] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState('');
  const [repoBranch, setRepoBranch] = useState('');
  const [repoBranchOptions, setRepoBranchOptions] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [fetchingRepo, setFetchingRepo] = useState(false);
  const [lastFetchedRepoId, setLastFetchedRepoId] = useState('');
  const [lastFetchedBranch, setLastFetchedBranch] = useState('');
  const [queuedIssues, setQueuedIssues] = useState<QueuedIssue[]>([]);
  const [queueModal, setQueueModal] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [loadingChangedFiles, setLoadingChangedFiles] = useState(false);
  const [changedFiles, setChangedFiles] = useState<string[]>([]);
  const [selectedChangedFiles, setSelectedChangedFiles] = useState<Set<string>>(new Set());
  const [showChangedPicker, setShowChangedPicker] = useState(false);
  const [showCreateBranch, setShowCreateBranch] = useState(false);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // ── Project data (repos + localWorkspacePath) ─────────────────────────────
  const { data: projectData } = useQuery({
    queryKey: ['project-repos', projectId],
    queryFn: () => api.get<{ data: { repositories: ProjectRepo[]; localWorkspacePath?: string } }>(`/api/projects/${projectId}`),
    staleTime: 60_000,
  });
  const repos = projectData?.data.repositories ?? [];
  const localWorkspacePath = projectData?.data.localWorkspacePath;

  // ── Baseline (localStorage) ────────────────────────────────────────────────
  function loadBaseline(repoId: string): Record<string, string> {
    try { return JSON.parse(localStorage.getItem(`nhd-al-baseline-${projectId}-${repoId}`) ?? '{}'); } catch { return {}; }
  }
  function saveBaseline(repoId: string, baseline: Record<string, string>) {
    try { localStorage.setItem(`nhd-al-baseline-${projectId}-${repoId}`, JSON.stringify(baseline)); } catch { /* noop */ }
  }

  // ── Branch loading ─────────────────────────────────────────────────────────
  async function loadBranches(repoId: string) {
    setBranchesLoading(true);
    setRepoBranchOptions([]);
    try {
      const res = await api.get<{ data: string[] }>(`/api/projects/${projectId}/al-health/repos/${repoId}/branches`);
      setRepoBranchOptions(res.data ?? []);
    } catch {
      setRepoBranchOptions([]);
    } finally {
      setBranchesLoading(false);
    }
  }

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

  // ── Dismissed findings (Issue #35) ────────────────────────────────────────
  const { data: dismissedData } = useQuery({
    queryKey: ['al-health-dismissed', projectId, lastFetchedRepoId],
    queryFn: () => api.get<{ data: Array<{ findingHash: string; filePath: string; repoId: string }> }>(
      `/api/projects/${projectId}/al-health/dismissed?repoId=${lastFetchedRepoId}`
    ),
    enabled: !!lastFetchedRepoId,
    staleTime: 30_000,
  });
  const dismissedHashes = new Set((dismissedData?.data ?? []).map((d) => d.findingHash));

  const dismissMutation = useMutation({
    mutationFn: ({ findingHash, filePath, remove }: { findingHash: string; filePath: string; remove?: boolean }) =>
      remove
        ? api.delete(`/api/projects/${projectId}/al-health/dismissed/${encodeURIComponent(findingHash)}?repoId=${lastFetchedRepoId}`)
        : api.post(`/api/projects/${projectId}/al-health/dismissed`, { repoId: lastFetchedRepoId, filePath, findingHash }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['al-health-dismissed', projectId, lastFetchedRepoId] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed to update dismissal'),
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
  async function fetchFromRepo(changedOnly = false, filePaths?: string[]) {
    if (!selectedRepo) { toast.error('Select a repository first'); return; }
    setFetchingRepo(true);
    try {
      const baseline = loadBaseline(selectedRepo);
      const hasBaseline = Object.keys(baseline).length > 0;
      const body: Record<string, unknown> = { repositoryId: selectedRepo, baseline };
      if (repoBranch) body.branch = repoBranch;
      if (filePaths && filePaths.length > 0) body.filePaths = filePaths;
      const res = await api.post<{ data: ObjectResult[]; meta: { filesScanned: number; objectsFound: number; totalIssues: number; branch: string }; newBaseline: Record<string, string> }>(
        `/api/projects/${projectId}/al-health/fetch-analyse`, body
      );
      setResults(res.data);
      setExpanded(new Set());
      setLastFetchedRepoId(selectedRepo);
      setLastFetchedBranch(res.meta.branch);
      if (!filePaths) saveBaseline(selectedRepo, res.newBaseline ?? {});
      const newCount = res.data.filter((r) => r.isNew).length;
      const changedCount = res.data.filter((r) => r.isChanged).length;
      const diffMsg = hasBaseline && (newCount || changedCount) ? ` · ${newCount} new, ${changedCount} changed` : hasBaseline ? ' · no structural changes' : '';
      toast.success(`Fetched ${res.meta.filesScanned} files from ${res.meta.branch} — ${res.meta.totalIssues} issues${diffMsg}`);
      if (changedOnly && hasBaseline) setShowNew(true);
      setShowChangedPicker(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Fetch failed');
    } finally { setFetchingRepo(false); }
  }

  // ── Load recently changed files (Issue #33) ────────────────────────────────
  async function loadChangedFiles() {
    if (!selectedRepo) { toast.error('Select a repository first'); return; }
    setLoadingChangedFiles(true);
    try {
      const params = new URLSearchParams();
      if (repoBranch) params.set('branch', repoBranch);
      const res = await api.get<{ data: string[] }>(`/api/projects/${projectId}/al-health/repos/${selectedRepo}/changed-files?${params}`);
      const files = res.data ?? [];
      setChangedFiles(files);
      setSelectedChangedFiles(new Set(files));
      setShowChangedPicker(true);
      if (!files.length) toast.info('No recently changed .al files found');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load changed files');
    } finally { setLoadingChangedFiles(false); }
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
  const dismissedCount = allIssues.filter((_, idx) => {
    const r = results.find((o) => o.issues.includes(allIssues[idx]))!;
    return r && dismissedHashes.has(makeIssueKey(r, allIssues[idx]));
  }).length;
  const presentRules = [...new Set(allIssues.map((i) => i.ruleId))].sort();

  const filteredResults = results
    .filter((r) => !showNew || r.isNew || r.isChanged)
    .map((r) => ({
    ...r,
    issues: r.issues.filter((i) => {
      const key = makeIssueKey(r, i);
      if (!showReviewed && reviewedKeys.has(key)) return false;
      if (!showDismissed && dismissedHashes.has(key)) return false;
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
    const dismissed = dismissedHashes.has(key);
    const cfg = SEV[issue.severity];

    // VS Code link: combine workspace path + file path + line number
    const vsCodeUrl = localWorkspacePath && issue.line
      ? `vscode://file/${[localWorkspacePath, r.filePath].join('/').replace(/\\/g, '/').replace(/\/+/g, '/')}:${issue.line}`
      : null;

    return (
      <div key={key} className={cn('flex items-start gap-3 px-4 py-3 text-sm border-b border-gray-100 dark:border-gray-800 last:border-0', reviewed ? 'opacity-50' : dismissed ? 'opacity-40' : issue.severity === 'error' ? 'bg-red-50/30 dark:bg-red-900/10' : issue.severity === 'warning' ? 'bg-amber-50/30 dark:bg-amber-900/10' : '')}>
        <span className={cn('mt-0.5 flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold', cfg.color)}>{cfg.icon} {issue.ruleId}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-gray-800 dark:text-gray-200">{issue.message}</span>
            {issue.procedure && <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-mono dark:bg-gray-800 dark:text-gray-400">{issue.procedure}</span>}
            {issue.line && <span className="text-[10px] text-gray-400">:{issue.line}</span>}
            {reviewed && <span className="text-[10px] text-green-600 dark:text-green-400">✓ Reviewed</span>}
            {dismissed && <span className="text-[10px] text-orange-500 dark:text-orange-400">Dismissed</span>}
          </div>
          {issue.detail && <p className="mt-0.5 truncate text-xs text-gray-400 dark:text-gray-600" title={typeof issue.detail === 'string' ? issue.detail : JSON.stringify(issue.detail)}>{typeof issue.detail === 'string' ? issue.detail : JSON.stringify(issue.detail)}</p>}
        </div>
        {/* Actions */}
        <div className="flex shrink-0 items-center gap-1">
          {vsCodeUrl ? (
            <a href={vsCodeUrl} title={`Open in VS Code :${issue.line}`} className="rounded p-1.5 text-gray-400 hover:bg-blue-50 hover:text-blue-600 dark:hover:bg-blue-900/30">
              <Code2 size={14} />
            </a>
          ) : localWorkspacePath ? null : (
            <span title="Set local workspace path in Setup to enable VS Code navigation" className="cursor-help rounded p-1.5 text-gray-200 dark:text-gray-700">
              <Code2 size={14} />
            </span>
          )}
          <button
            title={reviewed ? 'Unmark reviewed' : 'Mark as reviewed'}
            onClick={() => reviewMutation.mutate({ issueKey: key, remove: reviewed })}
            className={cn('rounded p-1.5 text-xs transition-colors', reviewed ? 'text-green-600 hover:bg-green-50 dark:hover:bg-green-900/30' : 'text-gray-400 hover:bg-green-50 hover:text-green-600 dark:hover:bg-green-900/30')}
          >
            <CheckCircle2 size={14} />
          </button>
          {lastFetchedRepoId && (
            <button
              title={dismissed ? 'Undismiss finding' : 'Dismiss finding'}
              onClick={() => dismissMutation.mutate({ findingHash: key, filePath: r.filePath, remove: dismissed })}
              className={cn('rounded p-1.5 text-xs transition-colors', dismissed ? 'text-orange-500 hover:bg-orange-50 dark:hover:bg-orange-900/30' : 'text-gray-400 hover:bg-orange-50 hover:text-orange-500 dark:hover:bg-orange-900/30')}
            >
              <EyeOff size={14} />
            </button>
          )}
          <button title="AI Explain" onClick={() => setAiModal({ issue, object: r })} className="rounded p-1.5 text-gray-400 hover:bg-purple-50 hover:text-purple-600 dark:hover:bg-purple-900/30">
            <Sparkles size={14} />
          </button>
          <button title="AI Refactor suggestion" onClick={() => setRefactorModal({ issue, object: r })} className="rounded p-1.5 text-gray-400 hover:bg-orange-50 hover:text-orange-600 dark:hover:bg-orange-900/30">
            <Wand2 size={14} />
          </button>
          {lastFetchedRepoId && issue.line != null && (
            <button title="View source code" onClick={() => setCodeModal({ issue, object: r })} className="rounded p-1.5 text-gray-400 hover:bg-teal-50 hover:text-teal-600 dark:hover:bg-teal-900/30">
              <Code2 size={14} />
            </button>
          )}
          <button title="Create Work Item" onClick={() => setWiModal({ issue, object: r })} className="rounded p-1.5 text-gray-400 hover:bg-sky-50 hover:text-sky-600 dark:hover:bg-sky-900/30">
            <Ticket size={14} />
          </button>
          {(() => {
            const qKey = `${r.objectType}:${r.objectName}:${issue.ruleId}:${issue.line ?? 0}`;
            const inQueue = queuedIssues.some((q) => q.key === qKey);
            return (
              <button
                title={inQueue ? 'Remove from queue' : 'Add to work item queue'}
                onClick={() => setQueuedIssues((p) => inQueue ? p.filter((q) => q.key !== qKey) : [...p, { issue, object: r, key: qKey }])}
                className={cn('rounded p-1.5 transition-colors', inQueue ? 'text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/30' : 'text-gray-400 hover:bg-amber-50 hover:text-amber-600 dark:hover:bg-amber-900/30')}
              >
                <Plus size={14} />
              </button>
            );
          })()}
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
            {r.isNew && <span className="rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-bold text-green-700 dark:bg-green-900/30 dark:text-green-300">NEW</span>}
            {r.isChanged && <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-bold text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">CHANGED</span>}
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
          <div className="flex gap-2 flex-wrap">
            <button onClick={() => setSemanticModal(true)} className="flex items-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-3 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-100 dark:border-violet-800 dark:bg-violet-900/20 dark:text-violet-300"><Brain size={13} /> AI Semantic</button>
            {queuedIssues.length > 0 && (
              <button onClick={() => setQueueModal(true)} className="flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
                <Ticket size={13} /> Queue ({queuedIssues.length})
              </button>
            )}
            <button onClick={() => { setResults([]); setExpanded(new Set()); }} className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"><X size={13} /> Clear</button>
            <button onClick={exportCsv} className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"><Download size={13} /> CSV</button>
          </div>
        )}
        {repos.length > 0 && (
          <button
            onClick={() => setShowCreateBranch(true)}
            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700"
          >
            <GitBranch size={13} /> Create Branch
          </button>
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
              <select
                value={selectedRepo}
                onChange={(e) => {
                  const val = e.target.value;
                  setSelectedRepo(val);
                  const r = repos.find((r) => r.id === val);
                  if (r) setRepoBranch(r.defaultBranch ?? '');
                  if (val) loadBranches(val);
                  else setRepoBranchOptions([]);
                }}
                className="w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              >
                <option value="">Select repository…</option>
                {repos.map((r) => <option key={r.id} value={r.id}>{r.label ?? r.repoName}</option>)}
              </select>
              {repoBranchOptions.length > 0 ? (
                <select
                  value={repoBranch}
                  onChange={(e) => setRepoBranch(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                >
                  <option value="">Default branch</option>
                  {repoBranchOptions.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              ) : (
                <input
                  value={repoBranch}
                  onChange={(e) => setRepoBranch(e.target.value)}
                  placeholder={branchesLoading ? 'Loading branches…' : 'Branch (default: main)'}
                  disabled={branchesLoading}
                  className="w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white disabled:opacity-60"
                />
              )}
              <button onClick={() => fetchFromRepo()} disabled={!selectedRepo || fetchingRepo} className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                {fetchingRepo ? <><Loader2 size={14} className="animate-spin" /> Fetching…</> : <><GitBranch size={14} /> Fetch & Analyse</>}
              </button>
              <button onClick={loadChangedFiles} disabled={!selectedRepo || loadingChangedFiles || fetchingRepo} className="flex w-full items-center justify-center gap-2 rounded-lg border border-indigo-300 py-1.5 text-xs font-medium text-indigo-600 hover:bg-indigo-50 dark:border-indigo-700 dark:text-indigo-400 dark:hover:bg-indigo-900/20 disabled:opacity-50">
                {loadingChangedFiles ? <><Loader2 size={12} className="animate-spin" /> Loading…</> : <><Clock size={12} /> Recently Changed Files</>}
              </button>
              {/* Recently changed file picker (Issue #33) */}
              {showChangedPicker && changedFiles.length > 0 && (
                <div className="rounded-lg border border-indigo-200 bg-indigo-50/50 p-3 dark:border-indigo-800 dark:bg-indigo-900/10">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-semibold text-indigo-700 dark:text-indigo-300">{changedFiles.length} changed .al file{changedFiles.length === 1 ? '' : 's'}</span>
                    <div className="flex gap-2 text-xs">
                      <button onClick={() => setSelectedChangedFiles(new Set(changedFiles))} className="text-indigo-600 hover:underline dark:text-indigo-400">All</button>
                      <button onClick={() => setSelectedChangedFiles(new Set())} className="text-indigo-600 hover:underline dark:text-indigo-400">None</button>
                    </div>
                  </div>
                  <div className="max-h-36 space-y-0.5 overflow-y-auto">
                    {changedFiles.map((f) => (
                      <label key={f} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-indigo-100 dark:hover:bg-indigo-900/30">
                        <input type="checkbox" checked={selectedChangedFiles.has(f)} onChange={(e) => setSelectedChangedFiles((p) => { const n = new Set(p); e.target.checked ? n.add(f) : n.delete(f); return n; })} className="accent-indigo-600" />
                        <span className="truncate font-mono text-gray-700 dark:text-gray-300" title={f}>{f.split('/').pop()}</span>
                      </label>
                    ))}
                  </div>
                  <button
                    onClick={() => fetchFromRepo(false, [...selectedChangedFiles])}
                    disabled={selectedChangedFiles.size === 0 || fetchingRepo}
                    className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-indigo-600 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                  >
                    {fetchingRepo ? <Loader2 size={11} className="animate-spin" /> : <GitBranch size={11} />}
                    Analyse {selectedChangedFiles.size} selected
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Skeleton while fetching from repo */}
      {fetchingRepo && results.length === 0 && (
        <div className="space-y-2">
          {[...Array(6)].map((_, i) => <FindingRowSkeleton key={i} />)}
        </div>
      )}

      {/* Results */}
      {results.length > 0 && (
        <>
          {/* KPI */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
            {[
              { label: 'Scanned', value: results.length, bg: 'bg-gray-50 dark:bg-gray-800', color: 'text-gray-700 dark:text-gray-200' },
              { label: 'Errors',   value: errorCount,     bg: 'bg-red-50 dark:bg-red-900/20',     color: 'text-red-600 dark:text-red-400' },
              { label: 'Warnings', value: warnCount,      bg: 'bg-amber-50 dark:bg-amber-900/20', color: 'text-amber-600 dark:text-amber-400' },
              { label: 'Info',     value: infoCount,      bg: 'bg-blue-50 dark:bg-blue-900/20',   color: 'text-blue-600 dark:text-blue-400' },
              { label: 'Reviewed', value: reviewedCount,  bg: 'bg-green-50 dark:bg-green-900/20', color: 'text-green-600 dark:text-green-400' },
              { label: 'Dismissed', value: dismissedCount, bg: 'bg-orange-50 dark:bg-orange-900/20', color: 'text-orange-600 dark:text-orange-400' },
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
            {lastFetchedRepoId && dismissedCount > 0 && (
              <button onClick={() => setShowDismissed((v) => !v)} className={cn('flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors', showDismissed ? 'border-orange-300 bg-orange-50 text-orange-700 dark:border-orange-700 dark:bg-orange-900/30 dark:text-orange-300' : 'border-gray-200 bg-white text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400')}>
                <EyeOff size={12} /> {showDismissed ? 'Hiding dismissed' : `Show dismissed (${dismissedCount})`}
              </button>
            )}
            {results.some((r) => r.isNew || r.isChanged) && (
              <button onClick={() => setShowNew((v) => !v)} className={cn('flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors', showNew ? 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : 'border-gray-200 bg-white text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400')}>
                <GitBranch size={12} /> {showNew ? 'New/Changed only' : 'All objects'}
              </button>
            )}
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
            <EmptyState
              icon={CheckCircle2}
              title="No issues match the current filter"
              description="All clear! Try changing filters or uploading more AL files."
              className="border-gray-100 dark:border-gray-800"
            />
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

      {/* AI Semantic modal */}
      {semanticModal && (
        <AiSemanticModal
          results={results}
          projectId={projectId}
          localWorkspacePath={localWorkspacePath}
          lastFetchedRepoId={lastFetchedRepoId}
          lastFetchedBranch={lastFetchedBranch || repoBranch}
          onClose={() => setSemanticModal(false)}
          onAddToQueue={(issue, obj, key) => {
            setQueuedIssues((p) => p.some((q) => q.key === key) ? p : [...p, { issue, object: obj, key }]);
          }}
        />
      )}

      {/* AI Explain modal */}
      {aiModal && <AiExplainModal issue={aiModal.issue} object={aiModal.object} projectId={projectId} onClose={() => setAiModal(null)} />}

      {/* AI Refactor modal */}
      {refactorModal && <AiRefactorModal issue={refactorModal.issue} object={refactorModal.object} projectId={projectId} onClose={() => setRefactorModal(null)} />}

      {/* Code View modal */}
      {codeModal && lastFetchedRepoId && (
        <CodeViewModal
          object={codeModal.object}
          issue={codeModal.issue}
          repoId={lastFetchedRepoId}
          branch={lastFetchedBranch || repoBranch}
          projectId={projectId}
          onClose={() => setCodeModal(null)}
        />
      )}

      {/* Work Item Queue modal */}
      {queueModal && (
        <WorkItemQueueModal
          queued={queuedIssues}
          projectId={projectId}
          onClose={() => setQueueModal(false)}
          onClear={() => { setQueuedIssues([]); setQueueModal(false); }}
        />
      )}

      {/* Work Item modal */}
      {wiModal && <WorkItemModal issue={wiModal.issue} object={wiModal.object} projectId={projectId} onClose={() => setWiModal(null)} />}

      {/* Create Branch modal */}
      {showCreateBranch && repos.length > 0 && (
        <CreateBranchModal
          repos={repos}
          suggestedBranchName={repoBranch ? undefined : undefined}
          onClose={() => setShowCreateBranch(false)}
        />
      )}
    </div>
  );
}

