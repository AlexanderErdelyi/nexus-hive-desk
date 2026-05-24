'use client';

import { useCallback, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle, ArrowUpDown, CheckCircle2, ChevronLeft, Download,
  FileCode2, FolderOpen, Loader2, RefreshCw, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

// ─── AL object parsing (same regex as TranslationEditor) ──────────────────────

interface AlObject {
  objectType: string;
  objectName: string;
  filePath: string;
  labelCount: number;
}

const AL_OBJECT_TYPES: Record<string, string> = {
  table: 'Table', tableextension: 'TableExtension',
  page: 'Page', pageextension: 'PageExtension', pagecustomization: 'PageCustomization',
  codeunit: 'Codeunit', report: 'Report', reportextension: 'ReportExtension',
  xmlport: 'XMLPort', query: 'Query',
  enum: 'Enum', enumextension: 'EnumExtension',
  profile: 'Profile', interface: 'Interface', permissionset: 'PermissionSet',
};

const AL_OBJECT_RE = /^(tableextension|table|pagecustomization|pageextension|page|codeunit|reportextension|report|xmlport|query|enumextension|enum|profile|interface|permissionset)\s+\d+\s+["']?([^"'{\n]+?)["']?\s*[{(]/im;

// Count Caption/ToolTip labels in an AL file
const AL_LABEL_RE = /(?:Caption|ToolTip)\s*=\s*'[^']+'/gi;

function parseAlFile(content: string, filePath: string): AlObject | null {
  const m = AL_OBJECT_RE.exec(content);
  if (!m) return null;
  const bcType = AL_OBJECT_TYPES[m[1].toLowerCase()];
  if (!bcType) return null;
  const objectName = m[2].trim().replace(/^["']|["']$/g, '');
  const labels = content.match(AL_LABEL_RE) ?? [];
  return { objectType: bcType, objectName, filePath, labelCount: labels.length };
}

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

// ─── Types ────────────────────────────────────────────────────────────────────

interface ObjectCoverage {
  objectType: string;
  objectName: string;
  total: number;
  translated: number;
  needsReview: number;
  untranslated: number;
  coveragePct: number;
}

interface CoverageSummary {
  totalObjects: number;
  totalStrings: number;
  translated: number;
  untranslated: number;
  coveragePct: number;
}

interface XliffFile {
  id: string;
  filename: string;
}

type SortField = 'coveragePct' | 'objectType' | 'objectName' | 'total';
type SortDir = 'asc' | 'desc';

// ─── Coverage bar ──────────────────────────────────────────────────────────────

function CoverageBar({ pct }: { pct: number }) {
  const color = pct >= 90 ? 'bg-green-500' : pct >= 60 ? 'bg-amber-400' : pct >= 30 ? 'bg-orange-400' : 'bg-red-500';
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
        <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-10 text-right text-xs tabular-nums text-gray-600 dark:text-gray-400">{pct}%</span>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ALAnalyserView({
  projectId,
  xliffFiles,
  onOpenTranslations,
}: {
  projectId: string;
  xliffFiles: XliffFile[];
  /** Called when user clicks "Open in Translations" with the object filter key */
  onOpenTranslations?: (xliffFileId: string, objectFilter: string) => void;
}) {
  const [selectedFileId, setSelectedFileId] = useState<string>(xliffFiles[0]?.id ?? '');
  const [sortField, setSortField] = useState<SortField>('coveragePct');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [filterType, setFilterType] = useState('');
  const [search, setSearch] = useState('');
  const [alObjects, setAlObjects] = useState<AlObject[] | null>(null);
  const [loadingAl, setLoadingAl] = useState(false);
  const [folderDragOver, setFolderDragOver] = useState(false);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['al-coverage', projectId, selectedFileId],
    queryFn: () =>
      api.get<{ data: { objects: ObjectCoverage[]; summary: CoverageSummary } }>(
        `/api/projects/${projectId}/al-coverage${selectedFileId ? `?xliffFileId=${selectedFileId}` : ''}`
      ),
    enabled: !!projectId,
  });

  const coverage = data?.data;
  const summary = coverage?.summary;

  // Sort + filter
  let rows = coverage?.objects ?? [];
  if (filterType) rows = rows.filter((r) => r.objectType === filterType);
  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter((r) => r.objectName.toLowerCase().includes(q) || r.objectType.toLowerCase().includes(q));
  }
  rows = [...rows].sort((a, b) => {
    let cmp = 0;
    if (sortField === 'coveragePct') cmp = a.coveragePct - b.coveragePct;
    else if (sortField === 'total') cmp = a.total - b.total;
    else if (sortField === 'objectType') cmp = a.objectType.localeCompare(b.objectType);
    else cmp = a.objectName.localeCompare(b.objectName);
    return sortDir === 'asc' ? cmp : -cmp;
  });

  function toggleSort(field: SortField) {
    if (sortField === field) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortField(field); setSortDir('asc'); }
  }

  // AL folder drop / input
  const loadAlFolder = useCallback(async (files: File[]) => {
    setLoadingAl(true);
    try {
      const seen = new Set<string>();
      const objects: AlObject[] = [];
      for (const file of files) {
        if (!file.name.endsWith('.al')) continue;
        const content = await file.text();
        const filePath: string = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        const obj = parseAlFile(content, filePath);
        if (!obj) continue;
        const key = `${obj.objectType}:${obj.objectName}`;
        if (!seen.has(key)) { seen.add(key); objects.push(obj); }
      }
      if (objects.length) {
        setAlObjects(objects);
        toast.success(`Loaded ${objects.length} AL objects from folder`);
      } else {
        toast.error('No parseable .al files found');
      }
    } finally {
      setLoadingAl(false);
    }
  }, []);

  const handleFolderInput = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []).filter((f) => f.name.endsWith('.al'));
    await loadAlFolder(files);
    e.target.value = '';
  }, [loadAlFolder]);

  const handleFolderDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setFolderDragOver(false);
    const entries: FileSystemEntry[] = [];
    for (let i = 0; i < e.dataTransfer.items.length; i++) {
      const entry = e.dataTransfer.items[i].webkitGetAsEntry();
      if (entry) entries.push(entry);
    }
    const files = (await Promise.all(entries.map(readEntryFiles))).flat();
    await loadAlFolder(files);
  }, [loadAlFolder]);

  // Compute AL cross-reference
  const alCoverage = alObjects
    ? alObjects.map((alObj) => {
        const xliffObj = coverage?.objects.find(
          (o) => o.objectType === alObj.objectType && o.objectName === alObj.objectName
        );
        return {
          ...alObj,
          inXliff: !!xliffObj,
          xliffCoverage: xliffObj ?? null,
        };
      })
    : null;

  const alMissing = alCoverage?.filter((o) => !o.inXliff) ?? [];
  const alPartial = alCoverage?.filter((o) => o.inXliff && (o.xliffCoverage?.coveragePct ?? 0) < 100) ?? [];

  // Export CSV
  function exportCsv() {
    const header = 'Object Type,Object Name,Total,Translated,Needs Review,Untranslated,Coverage %';
    const lines = rows.map(
      (r) => `"${r.objectType}","${r.objectName}",${r.total},${r.translated},${r.needsReview},${r.untranslated},${r.coveragePct}`
    );
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'al-coverage.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  const uniqueTypes = [...new Set((coverage?.objects ?? []).map((o) => o.objectType))].sort();

  return (
    <div>
      {/* Header bar */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <FileCode2 size={20} className="text-teal-500" />
            AL Coverage Analyser
          </h2>
          <p className="text-xs text-gray-400 dark:text-gray-600 mt-0.5">
            Translation coverage per AL object, derived from XLIFF notes
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {xliffFiles.length > 1 && (
            <select
              value={selectedFileId}
              onChange={(e) => setSelectedFileId(e.target.value)}
              className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
            >
              {xliffFiles.map((f) => (
                <option key={f.id} value={f.id}>{f.filename}</option>
              ))}
            </select>
          )}
          <button
            onClick={() => refetch()}
            className="flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            <RefreshCw size={13} /> Refresh
          </button>
          <button
            onClick={exportCsv}
            disabled={!rows.length}
            className="flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-40 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            <Download size={13} /> Export CSV
          </button>
        </div>
      </div>

      {/* Summary KPI cards */}
      {summary && (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
            <p className="text-xs text-gray-500 dark:text-gray-400">AL Objects</p>
            <p className="text-2xl font-bold text-gray-900 dark:text-white">{summary.totalObjects}</p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
            <p className="text-xs text-gray-500 dark:text-gray-400">Total Strings</p>
            <p className="text-2xl font-bold text-gray-900 dark:text-white">{summary.totalStrings}</p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
            <p className="text-xs text-gray-500 dark:text-gray-400">Translated</p>
            <p className="text-2xl font-bold text-green-600 dark:text-green-400">{summary.translated}</p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
            <p className="text-xs text-gray-500 dark:text-gray-400">Overall Coverage</p>
            <p className={cn(
              'text-2xl font-bold',
              summary.coveragePct >= 90 ? 'text-green-600 dark:text-green-400'
              : summary.coveragePct >= 60 ? 'text-amber-500'
              : 'text-red-500'
            )}>
              {summary.coveragePct}%
            </p>
          </div>
        </div>
      )}

      {/* AL folder cross-reference section */}
      <div className="mb-5 rounded-xl border border-teal-200 bg-teal-50 p-4 dark:border-teal-800 dark:bg-teal-900/20">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FolderOpen size={15} className="text-teal-600 dark:text-teal-400" />
            <span className="text-sm font-semibold text-teal-800 dark:text-teal-300">
              AL Source Cross-Reference
            </span>
            {alObjects && (
              <span className="rounded-full bg-teal-100 px-2 py-0.5 text-xs font-medium text-teal-700 dark:bg-teal-900/50 dark:text-teal-300">
                {alObjects.length} objects loaded
              </span>
            )}
          </div>
          {alObjects && (
            <button
              type="button"
              onClick={() => setAlObjects(null)}
              className="text-teal-400 hover:text-teal-600 dark:hover:text-teal-300"
            >
              <X size={15} />
            </button>
          )}
        </div>

        {!alObjects ? (
          <>
            <p className="mb-3 text-xs text-teal-700 dark:text-teal-400">
              Drop your BC source folder to cross-reference AL objects with the XLIFF — finds objects with <em>no XLIFF entries at all</em>.
            </p>
            <div className="flex items-center gap-2">
              <input
                ref={folderInputRef}
                type="file"
                // @ts-expect-error — non-standard
                webkitdirectory=""
                multiple
                className="hidden"
                onChange={handleFolderInput}
              />
              <button
                type="button"
                disabled={loadingAl}
                onClick={() => folderInputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setFolderDragOver(true); }}
                onDragLeave={() => setFolderDragOver(false)}
                onDrop={handleFolderDrop}
                className={cn(
                  'flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors',
                  folderDragOver
                    ? 'border-teal-400 bg-teal-100 text-teal-700 dark:bg-teal-800/40 dark:text-teal-300'
                    : 'border-teal-400 bg-white text-teal-700 hover:bg-teal-50 dark:border-teal-600 dark:bg-transparent dark:text-teal-300 dark:hover:bg-teal-900/30'
                )}
              >
                {loadingAl ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}
                {loadingAl ? 'Parsing…' : folderDragOver ? 'Drop folder here' : 'Upload AL Source Folder'}
              </button>
              <span className="text-xs text-teal-600 dark:text-teal-500">or drag & drop your BC source folder</span>
            </div>
          </>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-lg bg-white p-3 dark:bg-gray-900">
              <p className="text-xs text-gray-500 dark:text-gray-400">AL Objects Found</p>
              <p className="text-xl font-bold text-gray-900 dark:text-white">{alObjects.length}</p>
            </div>
            <div className="rounded-lg bg-white p-3 dark:bg-gray-900">
              <p className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1">
                <AlertTriangle size={11} className="text-red-500" /> Missing from XLIFF
              </p>
              <p className="text-xl font-bold text-red-600 dark:text-red-400">{alMissing.length}</p>
            </div>
            <div className="rounded-lg bg-white p-3 dark:bg-gray-900">
              <p className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1">
                <CheckCircle2 size={11} className="text-green-500" /> Partially/fully covered
              </p>
              <p className="text-xl font-bold text-green-600 dark:text-green-400">{alObjects.length - alMissing.length}</p>
            </div>
          </div>
        )}

        {/* Missing objects list */}
        {alMissing.length > 0 && (
          <div className="mt-3">
            <p className="mb-1.5 text-xs font-semibold text-red-700 dark:text-red-400">
              Objects in AL source with no XLIFF entries:
            </p>
            <div className="flex max-h-28 flex-col gap-1 overflow-y-auto">
              {alMissing.map((o) => (
                <div key={`${o.objectType}:${o.objectName}`} className="flex items-center gap-2 rounded bg-red-50 px-2 py-1 text-xs dark:bg-red-900/20">
                  <span className="shrink-0 rounded bg-red-100 px-1.5 py-0.5 font-mono text-red-600 dark:bg-red-900/40 dark:text-red-400">{o.objectType}</span>
                  <span className="font-medium text-red-800 dark:text-red-300">{o.objectName}</span>
                  <span className="ml-auto text-red-500 dark:text-red-500">{o.labelCount} labels in AL</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search object name…"
          className="min-w-44 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-white"
        />
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
          className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
        >
          <option value="">All Types</option>
          {uniqueTypes.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        {(search || filterType) && (
          <button onClick={() => { setSearch(''); setFilterType(''); }} className="text-sm text-gray-500 hover:text-red-500">
            <X size={14} />
          </button>
        )}
        <span className="ml-auto text-xs text-gray-400 dark:text-gray-600">
          {rows.length} object{rows.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Coverage table */}
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-gray-400 dark:text-gray-600">
            <Loader2 size={16} className="animate-spin" /> Loading coverage data…
          </div>
        ) : rows.length === 0 ? (
          <div className="py-12 text-center text-gray-400 dark:text-gray-600">
            {!selectedFileId
              ? 'No XLIFF file selected — upload one first'
              : 'No objects found — make sure the XLIFF was generated with BC Xliff Generator'}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-xs dark:border-gray-700 dark:bg-gray-800/50">
              <tr>
                <th className="px-4 py-3 text-left">
                  <button className="flex items-center gap-1 font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200" onClick={() => toggleSort('objectType')}>
                    Type <ArrowUpDown size={11} />
                  </button>
                </th>
                <th className="px-4 py-3 text-left">
                  <button className="flex items-center gap-1 font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200" onClick={() => toggleSort('objectName')}>
                    Object Name <ArrowUpDown size={11} />
                  </button>
                </th>
                <th className="px-4 py-3 text-right">
                  <button className="flex items-center gap-1 font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200" onClick={() => toggleSort('total')}>
                    Strings <ArrowUpDown size={11} />
                  </button>
                </th>
                <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Done</th>
                <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Review</th>
                <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Pending</th>
                <th className="px-4 py-3 text-left">
                  <button className="flex items-center gap-1 font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200" onClick={() => toggleSort('coveragePct')}>
                    Coverage <ArrowUpDown size={11} />
                  </button>
                </th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {rows.map((row) => {
                const isInAl = alObjects
                  ? alObjects.some((o) => o.objectType === row.objectType && o.objectName === row.objectName)
                  : null;
                return (
                  <tr
                    key={`${row.objectType}|${row.objectName}`}
                    className={cn(
                      'group hover:bg-gray-50 dark:hover:bg-gray-800/50',
                      isInAl === false && 'bg-red-50/30 dark:bg-red-900/5'
                    )}
                  >
                    <td className="px-4 py-2.5">
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                        {row.objectType}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-medium text-gray-900 dark:text-white">
                      {row.objectName}
                    </td>
                    <td className="px-4 py-2.5 text-right text-gray-600 dark:text-gray-400 tabular-nums">{row.total}</td>
                    <td className="px-4 py-2.5 text-right text-green-600 dark:text-green-400 tabular-nums">{row.translated}</td>
                    <td className="px-4 py-2.5 text-right text-amber-500 tabular-nums">{row.needsReview}</td>
                    <td className="px-4 py-2.5 text-right text-red-500 tabular-nums">{row.untranslated}</td>
                    <td className="px-4 py-2.5">
                      <CoverageBar pct={row.coveragePct} />
                    </td>
                    <td className="px-4 py-2.5">
                      {onOpenTranslations && selectedFileId && row.untranslated > 0 && (
                        <button
                          type="button"
                          onClick={() => onOpenTranslations(selectedFileId, `${row.objectType} ${row.objectName}`)}
                          className="invisible rounded bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-100 group-hover:visible dark:bg-indigo-900/30 dark:text-indigo-400 dark:hover:bg-indigo-900/50"
                        >
                          Open in Translator
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* AL partial coverage list */}
      {alPartial.length > 0 && (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-900/20">
          <p className="mb-2 text-xs font-semibold text-amber-700 dark:text-amber-400">
            Objects in AL source that are partially translated:
          </p>
          <div className="flex flex-wrap gap-2">
            {alPartial.map((o) => (
              <span
                key={`${o.objectType}:${o.objectName}`}
                className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
              >
                {o.objectType}: {o.objectName}
                <span className="opacity-70">({o.xliffCoverage?.coveragePct ?? 0}%)</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
