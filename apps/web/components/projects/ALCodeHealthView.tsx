'use client';

import { useCallback, useRef, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight,
  Download, FileCode2, FolderOpen, Info, Loader2, X, Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

// ─── Types ──────────────────────────────────────────────────────────────────

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

// ─── AL parsing helpers ──────────────────────────────────────────────────────

const AL_OBJECT_RE = /^(tableextension|table|pagecustomization|pageextension|page|codeunit|reportextension|report|xmlport|query|enumextension|enum|profile|interface|permissionset)\s+\d+\s+["']?([^"'{\n]+?)["']?\s*[{(]/im;

const AL_OBJECT_TYPE_MAP: Record<string, string> = {
  table: 'Table', tableextension: 'TableExtension',
  page: 'Page', pageextension: 'PageExtension', pagecustomization: 'PageCustomization',
  codeunit: 'Codeunit', report: 'Report', reportextension: 'ReportExtension',
  xmlport: 'XMLPort', query: 'Query',
  enum: 'Enum', enumextension: 'EnumExtension',
  profile: 'Profile', interface: 'Interface', permissionset: 'PermissionSet',
};

/** Strip single-quoted string literals and line comments to avoid false matches */
function stripStringsAndComments(line: string): string {
  return line
    .replace(/'[^']*'/g, "''")        // single-quoted strings
    .replace(/\/\/.*$/, '');           // line comments
}

/** Parse all procedures/triggers from the AL file lines (1-indexed). */
function parseProcedures(lines: string[]): ProcInfo[] {
  const PROC_RE = /^\s*(local\s+|internal\s+|protected\s+)?(procedure|trigger)\s+"?([^"(\n]+?)"?\s*\(([^)]*)\)/i;
  const results: ProcInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = PROC_RE.exec(lines[i]);
    if (!m) continue;

    const name = m[3].trim();
    const paramStr = m[4] ?? '';
    const paramCount = paramStr.trim() === '' ? 0 : paramStr.split(';').length;
    const startLine = i + 1;

    // Walk forward to find the matching end; using begin/end depth tracking
    let depth = 0;
    let endLine = startLine;
    let foundBegin = false;

    for (let j = i; j < lines.length; j++) {
      const stripped = stripStringsAndComments(lines[j]).toLowerCase();
      const begins = (stripped.match(/\bbegin\b/g) ?? []).length;
      const ends = (stripped.match(/\bend\b/g) ?? []).length;

      if (!foundBegin && begins > 0) foundBegin = true;
      if (foundBegin) {
        depth += begins - ends;
        if (depth <= 0) {
          endLine = j + 1;
          break;
        }
      }
    }

    results.push({ name, startLine, endLine, lineCount: endLine - startLine + 1, paramCount });
  }

  return results;
}

/** Detect DB operations executed inside loops (repeat..until, while..do, for..do). */
function checkDbInLoops(lines: string[], procStart: number, procEnd: number, procName: string): HealthIssue[] {
  const issues: HealthIssue[] = [];
  // 0-indexed slice
  const start = procStart - 1;
  const end = Math.min(procEnd, lines.length);

  let loopDepth = 0;

  const DB_RE = /\.(findset|findfirst|findlast|find\s*\(|get\s*\()\b/i;
  const COMMIT_RE = /\bcommit\s*\(\s*\)/i;

  for (let i = start; i < end; i++) {
    const raw = lines[i];
    const stripped = stripStringsAndComments(raw).toLowerCase();

    // repeat starts a loop
    if (/\brepeat\b/.test(stripped)) loopDepth++;
    // while/for on their own line (simplified: if line contains "while" or "for " with "do" later)
    if (/\bwhile\b.+\bdo\b/.test(stripped) || /\bfor\b.+\bto\b.+\bdo\b/.test(stripped)) loopDepth++;
    // until closes a repeat loop
    if (/\buntil\b/.test(stripped) && loopDepth > 0) loopDepth--;

    if (loopDepth > 0) {
      if (DB_RE.test(raw)) {
        issues.push({
          severity: 'error',
          ruleId: 'AL0003',
          message: 'Database read operation inside loop',
          detail: raw.trim(),
          line: i + 1,
          procedure: procName,
        });
      }
      if (COMMIT_RE.test(raw)) {
        issues.push({
          severity: 'error',
          ruleId: 'AL0004',
          message: 'Commit() inside loop — severe performance issue',
          detail: raw.trim(),
          line: i + 1,
          procedure: procName,
        });
      }
    }
  }

  return issues;
}

/** Detect maximum indentation depth within a procedure. */
function checkDeepNesting(lines: string[], procStart: number, procEnd: number, procName: string): HealthIssue[] {
  const THRESHOLD = 6; // alert when indentation suggests > THRESHOLD nesting levels (approx 4 spaces each)
  let maxDepth = 0;
  let maxLine = -1;

  for (let i = procStart - 1; i < Math.min(procEnd, lines.length); i++) {
    const indent = lines[i].match(/^(\s*)/)?.[1].length ?? 0;
    const depth = Math.floor(indent / 4);
    if (depth > maxDepth) { maxDepth = depth; maxLine = i + 1; }
  }

  if (maxDepth >= THRESHOLD) {
    return [{
      severity: 'warning',
      ruleId: 'AL0005',
      message: `Deep nesting detected (≈${maxDepth} levels)`,
      detail: 'Consider refactoring into smaller sub-procedures.',
      line: maxLine,
      procedure: procName,
    }];
  }
  return [];
}

/** Find TODO/FIXME/HACK comments in the file. */
function checkTodoComments(lines: string[]): HealthIssue[] {
  const issues: HealthIssue[] = [];
  const RE = /\/\/\s*(TODO|FIXME|HACK|XXX)\b/i;
  for (let i = 0; i < lines.length; i++) {
    if (RE.test(lines[i])) {
      issues.push({
        severity: 'info',
        ruleId: 'AL0007',
        message: `Developer note: ${lines[i].trim()}`,
        line: i + 1,
      });
    }
  }
  return issues;
}

/** Main analysis entry point for a single AL file. */
function analyzeAlFile(content: string, filePath: string): ObjectResult | null {
  const m = AL_OBJECT_RE.exec(content);
  if (!m) return null;
  const bcType = AL_OBJECT_TYPE_MAP[m[1].toLowerCase()];
  if (!bcType) return null;
  const objectName = m[2].trim().replace(/^["']|["']$/g, '');

  const lines = content.split('\n');
  const lineCount = lines.length;
  const issues: HealthIssue[] = [];

  // AL0001 — large object
  if (lineCount > 2000) {
    issues.push({
      severity: 'warning',
      ruleId: 'AL0001',
      message: `Large object: ${lineCount} lines`,
      detail: 'Consider splitting into smaller objects or using extensions.',
    });
  }

  const procedures = parseProcedures(lines);

  for (const proc of procedures) {
    // AL0002 — long procedure
    if (proc.lineCount > 100) {
      issues.push({
        severity: proc.lineCount > 200 ? 'error' : 'warning',
        ruleId: 'AL0002',
        message: `Procedure "${proc.name}" is ${proc.lineCount} lines long`,
        detail: 'Long procedures are hard to maintain. Consider breaking it up.',
        line: proc.startLine,
        procedure: proc.name,
      });
    }

    // AL0003 + AL0004 — DB ops / Commit in loop
    issues.push(...checkDbInLoops(lines, proc.startLine, proc.endLine, proc.name));

    // AL0005 — deep nesting
    issues.push(...checkDeepNesting(lines, proc.startLine, proc.endLine, proc.name));

    // AL0006 — too many parameters
    if (proc.paramCount > 8) {
      issues.push({
        severity: 'warning',
        ruleId: 'AL0006',
        message: `Procedure "${proc.name}" has ${proc.paramCount} parameters`,
        detail: 'Many parameters often indicate the procedure is doing too much.',
        line: proc.startLine,
        procedure: proc.name,
      });
    }
  }

  // AL0007 — TODO/FIXME
  issues.push(...checkTodoComments(lines));

  return { objectType: bcType, objectName, filePath, lineCount, procedures, issues };
}

/** After all files are analysed, add cross-file duplicate procedure name issues. */
function addDuplicateIssues(results: ObjectResult[]): void {
  const nameMap = new Map<string, string[]>(); // procName → filePaths
  for (const r of results) {
    for (const p of r.procedures) {
      const key = p.name.toLowerCase();
      if (!nameMap.has(key)) nameMap.set(key, []);
      nameMap.get(key)!.push(`${r.objectType} ${r.objectName}`);
    }
  }
  for (const r of results) {
    for (const p of r.procedures) {
      const key = p.name.toLowerCase();
      const others = (nameMap.get(key) ?? []).filter((o) => o !== `${r.objectType} ${r.objectName}`);
      if (others.length > 0) {
        r.issues.push({
          severity: 'info',
          ruleId: 'AL0008',
          message: `Procedure "${p.name}" also exists in: ${others.slice(0, 3).join(', ')}${others.length > 3 ? ` +${others.length - 3} more` : ''}`,
          detail: 'Duplicate procedure names across objects can indicate copy-paste code.',
          line: p.startLine,
          procedure: p.name,
        });
      }
    }
  }
}

// ─── File reading (same as ALAnalyserView) ────────────────────────────────────

async function readEntryFiles(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    if (!entry.name.endsWith('.al')) return [];
    return new Promise<File[]>((res, rej) =>
      (entry as FileSystemFileEntry).file((f) => res([f]), rej)
    );
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const allEntries: FileSystemEntry[] = [];
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (batch.length === 0) break;
      allEntries.push(...batch);
    }
    const nested = await Promise.all(allEntries.map(readEntryFiles));
    return nested.flat();
  }
  return [];
}

// ─── Rule metadata ────────────────────────────────────────────────────────────

const RULES: Record<string, { label: string; description: string }> = {
  AL0001: { label: 'Large Object',             description: 'Object exceeds 2000 lines' },
  AL0002: { label: 'Long Procedure',           description: 'Procedure body exceeds 100 lines' },
  AL0003: { label: 'DB Read in Loop',          description: 'FindSet/FindFirst/Get inside a loop' },
  AL0004: { label: 'Commit in Loop',           description: 'Commit() inside a loop' },
  AL0005: { label: 'Deep Nesting',             description: 'Indentation depth ≥ 6 levels' },
  AL0006: { label: 'Too Many Parameters',      description: 'Procedure has > 8 parameters' },
  AL0007: { label: 'TODO Comment',             description: 'Unresolved developer note' },
  AL0008: { label: 'Duplicate Procedure Name', description: 'Same name appears in multiple objects' },
};

const SEV_CONFIG: Record<Severity, { label: string; color: string; icon: React.ReactNode }> = {
  error:   { label: 'Error',   color: 'text-red-600 bg-red-50 border-red-200 dark:text-red-400 dark:bg-red-900/30 dark:border-red-800',       icon: <AlertTriangle size={12} /> },
  warning: { label: 'Warning', color: 'text-amber-600 bg-amber-50 border-amber-200 dark:text-amber-400 dark:bg-amber-900/30 dark:border-amber-800', icon: <AlertTriangle size={12} /> },
  info:    { label: 'Info',    color: 'text-blue-600 bg-blue-50 border-blue-200 dark:text-blue-400 dark:bg-blue-900/30 dark:border-blue-800',    icon: <Info size={12} /> },
};

// ─── Component ───────────────────────────────────────────────────────────────

interface Props {
  projectId: string;
}

type FilterSev = 'all' | Severity;

export function ALCodeHealthView({ projectId: _projectId }: Props) {
  const [results, setResults] = useState<ObjectResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [filterSev, setFilterSev] = useState<FilterSev>('all');
  const [filterRule, setFilterRule] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const folderInputRef = useRef<HTMLInputElement>(null);

  // ── Run analysis ────────────────────────────────────────────────────────────

  const runAnalysis = useCallback(async (files: File[]) => {
    setLoading(true);
    try {
      const alFiles = files.filter((f) => f.name.endsWith('.al'));
      if (!alFiles.length) { toast.error('No .al files found in the dropped folder.'); return; }

      const analysed: ObjectResult[] = [];
      for (const file of alFiles) {
        const content = await file.text();
        const filePath: string = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        const result = analyzeAlFile(content, filePath);
        if (result) analysed.push(result);
      }

      addDuplicateIssues(analysed);
      setResults(analysed);
      setExpanded(new Set()); // collapse all on new load

      const totalIssues = analysed.reduce((s, r) => s + r.issues.length, 0);
      toast.success(`Analysed ${analysed.length} objects — ${totalIssues} issues found`);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleFolderInput = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    await runAnalysis(files);
    e.target.value = '';
  }, [runAnalysis]);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const entries: FileSystemEntry[] = [];
    for (let i = 0; i < e.dataTransfer.items.length; i++) {
      const entry = e.dataTransfer.items[i].webkitGetAsEntry();
      if (entry) entries.push(entry);
    }
    const files = (await Promise.all(entries.map(readEntryFiles))).flat();
    await runAnalysis(files);
  }, [runAnalysis]);

  // ── Derived stats ───────────────────────────────────────────────────────────

  const allIssues = results.flatMap((r) => r.issues.map((i) => ({ ...i, objectName: r.objectName, objectType: r.objectType })));
  const errorCount   = allIssues.filter((i) => i.severity === 'error').length;
  const warningCount = allIssues.filter((i) => i.severity === 'warning').length;
  const infoCount    = allIssues.filter((i) => i.severity === 'info').length;

  // Unique rule IDs present
  const presentRules = [...new Set(allIssues.map((i) => i.ruleId))].sort();

  // Filter results
  const filteredResults = results
    .map((r) => ({
      ...r,
      issues: r.issues.filter((i) => {
        if (filterSev !== 'all' && i.severity !== filterSev) return false;
        if (filterRule !== 'all' && i.ruleId !== filterRule) return false;
        if (search) {
          const q = search.toLowerCase();
          return (
            r.objectName.toLowerCase().includes(q) ||
            r.objectType.toLowerCase().includes(q) ||
            i.message.toLowerCase().includes(q) ||
            (i.procedure?.toLowerCase().includes(q) ?? false)
          );
        }
        return true;
      }),
    }))
    .filter((r) => r.issues.length > 0);

  // ── CSV export ──────────────────────────────────────────────────────────────

  function exportCsv() {
    const rows = [['Object', 'Type', 'Rule', 'Severity', 'Message', 'Procedure', 'Line', 'Detail']];
    for (const r of results) {
      for (const i of r.issues) {
        rows.push([r.objectName, r.objectType, i.ruleId, i.severity, i.message, i.procedure ?? '', String(i.line ?? ''), i.detail ?? '']);
      }
    }
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'al-code-health.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-gray-900 dark:text-white">
            <Zap size={20} className="text-amber-500" />
            AL Code Health
          </h2>
          <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
            Drop your AL source folder to detect performance issues, long procedures, DB operations in loops, and more.
          </p>
        </div>
        {results.length > 0 && (
          <div className="flex gap-2">
            <button
              onClick={() => { setResults([]); setExpanded(new Set()); }}
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
            >
              <X size={13} /> Clear
            </button>
            <button
              onClick={exportCsv}
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
            >
              <Download size={13} /> Export CSV
            </button>
          </div>
        )}
      </div>

      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={cn(
          'relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center transition-colors cursor-pointer',
          dragOver
            ? 'border-amber-400 bg-amber-50 dark:bg-amber-900/10'
            : 'border-gray-300 hover:border-amber-400 hover:bg-amber-50/30 dark:border-gray-600 dark:hover:border-amber-600'
        )}
        onClick={() => folderInputRef.current?.click()}
      >
        <input
          ref={folderInputRef}
          type="file"
          className="hidden"
          // @ts-ignore — webkitdirectory is non-standard
          webkitdirectory=""
          multiple
          onChange={handleFolderInput}
        />
        {loading ? (
          <div className="flex flex-col items-center gap-2">
            <Loader2 size={28} className="animate-spin text-amber-500" />
            <p className="text-sm text-gray-500 dark:text-gray-400">Analysing AL files…</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <FolderOpen size={32} className="text-amber-400" />
            <p className="font-medium text-gray-700 dark:text-gray-300">
              {dragOver ? 'Drop AL folder here' : 'Drop your AL source folder or click to browse'}
            </p>
            <p className="text-xs text-gray-400 dark:text-gray-600">
              Scans all .al files recursively for code quality issues
            </p>
          </div>
        )}
      </div>

      {/* Results */}
      {results.length > 0 && (
        <>
          {/* KPI summary */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: 'Objects Scanned', value: results.length, color: 'text-gray-700 dark:text-gray-200', bg: 'bg-gray-50 dark:bg-gray-800' },
              { label: 'Errors',   value: errorCount,   color: 'text-red-600 dark:text-red-400',   bg: 'bg-red-50 dark:bg-red-900/20' },
              { label: 'Warnings', value: warningCount, color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-900/20' },
              { label: 'Info',     value: infoCount,    color: 'text-blue-600 dark:text-blue-400',  bg: 'bg-blue-50 dark:bg-blue-900/20' },
            ].map((kpi) => (
              <div key={kpi.label} className={`${kpi.bg} rounded-xl border border-gray-100 p-4 dark:border-gray-800`}>
                <div className={`text-2xl font-bold ${kpi.color}`}>{kpi.value}</div>
                <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{kpi.label}</div>
              </div>
            ))}
          </div>

          {/* Rule distribution */}
          {presentRules.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {presentRules.map((ruleId) => {
                const count = allIssues.filter((i) => i.ruleId === ruleId).length;
                const sev = allIssues.find((i) => i.ruleId === ruleId)?.severity ?? 'info';
                const cfg = SEV_CONFIG[sev];
                return (
                  <button
                    key={ruleId}
                    onClick={() => setFilterRule(filterRule === ruleId ? 'all' : ruleId)}
                    className={cn(
                      'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-all',
                      cfg.color,
                      filterRule === ruleId && 'ring-2 ring-current ring-offset-1 ring-offset-white dark:ring-offset-gray-900'
                    )}
                    title={RULES[ruleId]?.description}
                  >
                    {cfg.icon} {ruleId}: {RULES[ruleId]?.label} ({count})
                  </button>
                );
              })}
            </div>
          )}

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
              {(['all', 'error', 'warning', 'info'] as FilterSev[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setFilterSev(s)}
                  className={cn(
                    'px-3 py-1.5 text-xs font-medium capitalize transition-colors',
                    filterSev === s
                      ? 'bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900'
                      : 'bg-white text-gray-500 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-400 dark:hover:bg-gray-800'
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search objects or issues…"
              className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm focus:border-amber-400 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
            />
            {(filterSev !== 'all' || filterRule !== 'all' || search) && (
              <button
                onClick={() => { setFilterSev('all'); setFilterRule('all'); setSearch(''); }}
                className="text-xs text-gray-400 hover:text-gray-600 dark:text-gray-600 dark:hover:text-gray-400"
              >
                Clear filters
              </button>
            )}
            <span className="ml-auto text-xs text-gray-400">
              {filteredResults.length} object{filteredResults.length !== 1 ? 's' : ''} with issues
            </span>
          </div>

          {/* Results list */}
          {filteredResults.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-gray-100 bg-gray-50 py-12 text-center dark:border-gray-800 dark:bg-gray-800/30">
              <CheckCircle2 size={28} className="text-green-500" />
              <p className="font-medium text-gray-700 dark:text-gray-300">No issues match the current filter</p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredResults.map((r) => {
                const key = `${r.objectType}:${r.objectName}`;
                const isExpanded = expanded.has(key);
                const rErrors = r.issues.filter((i) => i.severity === 'error').length;
                const rWarnings = r.issues.filter((i) => i.severity === 'warning').length;

                return (
                  <div key={key} className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
                    {/* Object header — click to expand */}
                    <button
                      className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50"
                      onClick={() => setExpanded((prev) => {
                        const next = new Set(prev);
                        next.has(key) ? next.delete(key) : next.add(key);
                        return next;
                      })}
                    >
                      {isExpanded ? <ChevronDown size={15} className="shrink-0 text-gray-400" /> : <ChevronRight size={15} className="shrink-0 text-gray-400" />}
                      <FileCode2 size={15} className="shrink-0 text-amber-500" />
                      <span className="inline-block rounded bg-amber-50 px-1.5 py-0.5 text-xs font-semibold text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                        {r.objectType}
                      </span>
                      <span className="font-medium text-gray-900 dark:text-white">{r.objectName}</span>
                      <span className="text-xs text-gray-400 dark:text-gray-600">{r.lineCount} lines · {r.procedures.length} procedures</span>
                      <div className="ml-auto flex items-center gap-1.5">
                        {rErrors > 0 && (
                          <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold text-red-700 dark:bg-red-900/40 dark:text-red-300">
                            {rErrors}E
                          </span>
                        )}
                        {rWarnings > 0 && (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                            {rWarnings}W
                          </span>
                        )}
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-bold text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                          {r.issues.length} total
                        </span>
                      </div>
                    </button>

                    {/* Issue rows */}
                    {isExpanded && (
                      <div className="border-t border-gray-100 divide-y divide-gray-100 dark:border-gray-800 dark:divide-gray-800">
                        {r.issues.map((issue, idx) => {
                          const cfg = SEV_CONFIG[issue.severity];
                          const ruleMeta = RULES[issue.ruleId];
                          return (
                            <div
                              key={idx}
                              className={cn(
                                'flex items-start gap-3 px-4 py-3 text-sm',
                                issue.severity === 'error'
                                  ? 'bg-red-50/40 dark:bg-red-900/10'
                                  : issue.severity === 'warning'
                                    ? 'bg-amber-50/40 dark:bg-amber-900/10'
                                    : ''
                              )}
                            >
                              <span className={cn('mt-0.5 flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold shrink-0', cfg.color)}>
                                {cfg.icon} {issue.ruleId}
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="font-medium text-gray-800 dark:text-gray-200">{issue.message}</span>
                                  {issue.procedure && (
                                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-mono text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                                      {issue.procedure}
                                    </span>
                                  )}
                                  {issue.line && (
                                    <span className="text-[10px] text-gray-400">line {issue.line}</span>
                                  )}
                                </div>
                                {issue.detail && (
                                  <p className="mt-0.5 truncate text-xs text-gray-400 dark:text-gray-600" title={issue.detail}>
                                    {issue.detail}
                                  </p>
                                )}
                                {ruleMeta && (
                                  <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-600">{ruleMeta.description}</p>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
