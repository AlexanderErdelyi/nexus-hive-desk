'use client';

import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import {
  ArrowLeft,
  GitCompare,
  Plus,
  Minus,
  RefreshCw,
  Minus as Unchanged,
  Search,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';

interface XliffFile {
  id: string;
  filename: string;
  remoteBranch?: string | null;
  remoteRepo?: string | null;
  uploadedAt: string;
  lastSyncAt?: string | null;
}

interface DiffRow {
  unitId: string;
  changeType: 'added' | 'removed' | 'changed' | 'unchanged';
  source: string;
  targetA: string;
  targetB: string;
  stateA: string;
  stateB: string;
  note?: string | null;
}

interface CompareResult {
  data: DiffRow[];
  summary: { added: number; removed: number; changed: number; unchanged: number; total: number };
  meta: { total: number; page: number; pageSize: number; totalPages: number };
}

interface Props {
  projectId: string;
  files: XliffFile[];
  onBack: () => void;
}

const CHANGE_COLORS: Record<string, string> = {
  added: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/30',
  removed: 'text-red-400 bg-red-400/10 border-red-400/30',
  changed: 'text-amber-400 bg-amber-400/10 border-amber-400/30',
  unchanged: 'text-slate-400 bg-slate-400/10 border-slate-400/20',
};

const CHANGE_ICONS: Record<string, React.ReactNode> = {
  added: <Plus size={12} />,
  removed: <Minus size={12} />,
  changed: <RefreshCw size={12} />,
  unchanged: <Unchanged size={12} />,
};

const CHANGE_LABELS: Record<string, string> = {
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
  unchanged: 'Unchanged',
};

function fileLabel(f: XliffFile) {
  const branch = f.remoteBranch ?? 'local';
  const repo = f.remoteRepo ? f.remoteRepo.split('/').pop() : '';
  return `${branch}${repo ? ` (${repo})` : ''}`;
}

export default function XliffCompareView({ projectId, files, onBack }: Props) {
  const [fileA, setFileA] = useState<string>(files[0]?.id ?? '');
  const [fileB, setFileB] = useState<string>(files[1]?.id ?? '');
  const [changeTypeFilter, setChangeTypeFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 50;

  const queryEnabled = !!fileA && !!fileB && fileA !== fileB;

  const { data, isLoading, error } = useQuery<CompareResult>({
    queryKey: ['xliff-compare', projectId, fileA, fileB, changeTypeFilter, search, page],
    queryFn: () => {
      const params = new URLSearchParams({
        fileA,
        fileB,
        page: String(page),
        pageSize: String(PAGE_SIZE),
      });
      if (changeTypeFilter !== 'all') params.set('changeType', changeTypeFilter);
      if (search) params.set('search', search);
      return api.get<CompareResult>(`/api/projects/${projectId}/xliff/compare?${params}`);
    },
    enabled: queryEnabled,
  });

  const handleFilterChange = useCallback((ct: string) => {
    setChangeTypeFilter(ct);
    setPage(1);
  }, []);

  const handleSearch = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSearch(e.target.value);
    setPage(1);
  }, []);

  const summary = data?.summary;
  const rows = data?.data ?? [];
  const meta = data?.meta;

  const fileAObj = files.find((f) => f.id === fileA);
  const fileBObj = files.find((f) => f.id === fileB);

  return (
    <div className="flex flex-col h-full gap-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200 transition-colors"
        >
          <ArrowLeft size={16} />
          Back
        </button>
        <div className="flex items-center gap-2 text-slate-200 font-semibold text-lg">
          <GitCompare size={20} className="text-blue-400" />
          Branch Comparison
        </div>
      </div>

      {/* File pickers */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-3">
          <div className="text-xs text-slate-400 mb-1.5 font-medium uppercase tracking-wide">Base (A)</div>
          <select
            className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
            value={fileA}
            onChange={(e) => { setFileA(e.target.value); setPage(1); }}
          >
            {files.map((f) => (
              <option key={f.id} value={f.id}>{fileLabel(f)} — {f.filename}</option>
            ))}
          </select>
          {fileAObj && (
            <div className="text-xs text-slate-500 mt-1">
              {fileAObj.remoteBranch && <span className="font-mono text-blue-400">{fileAObj.remoteBranch}</span>}
              {fileAObj.lastSyncAt && <span className="ml-2">synced {new Date(fileAObj.lastSyncAt).toLocaleDateString()}</span>}
            </div>
          )}
        </div>
        <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-3">
          <div className="text-xs text-slate-400 mb-1.5 font-medium uppercase tracking-wide">Compare (B)</div>
          <select
            className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
            value={fileB}
            onChange={(e) => { setFileB(e.target.value); setPage(1); }}
          >
            {files.map((f) => (
              <option key={f.id} value={f.id}>{fileLabel(f)} — {f.filename}</option>
            ))}
          </select>
          {fileBObj && (
            <div className="text-xs text-slate-500 mt-1">
              {fileBObj.remoteBranch && <span className="font-mono text-blue-400">{fileBObj.remoteBranch}</span>}
              {fileBObj.lastSyncAt && <span className="ml-2">synced {new Date(fileBObj.lastSyncAt).toLocaleDateString()}</span>}
            </div>
          )}
        </div>
      </div>

      {fileA === fileB && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-3 text-sm text-amber-300">
          Select two different files to compare.
        </div>
      )}

      {queryEnabled && (
        <>
          {/* Summary pills */}
          {summary && (
            <div className="flex flex-wrap gap-2">
              {(['all', 'changed', 'added', 'removed', 'unchanged'] as const).map((ct) => {
                const count = ct === 'all' ? summary.total : summary[ct as keyof typeof summary] as number;
                const active = changeTypeFilter === ct;
                const color = ct === 'all' ? 'text-slate-300 bg-slate-700 border-slate-600' : CHANGE_COLORS[ct];
                return (
                  <button
                    key={ct}
                    onClick={() => handleFilterChange(ct)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium transition-all ${color} ${active ? 'ring-2 ring-offset-1 ring-offset-slate-900 ring-current' : 'opacity-70 hover:opacity-100'}`}
                  >
                    {ct !== 'all' && CHANGE_ICONS[ct]}
                    {ct === 'all' ? 'All' : CHANGE_LABELS[ct]}: {count}
                  </button>
                );
              })}
              {/* Search */}
              <div className="ml-auto flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5">
                <Search size={14} className="text-slate-400" />
                <input
                  value={search}
                  onChange={handleSearch}
                  placeholder="Search…"
                  className="bg-transparent text-sm text-slate-200 placeholder-slate-500 focus:outline-none w-40"
                />
              </div>
            </div>
          )}

          {/* Table */}
          {isLoading ? (
            <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">Loading diff…</div>
          ) : error ? (
            <div className="text-red-400 text-sm">{String(error)}</div>
          ) : rows.length === 0 ? (
            <div className="text-slate-500 text-sm py-8 text-center">No differences found.</div>
          ) : (
            <div className="flex-1 overflow-auto rounded-lg border border-slate-700">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-900 border-b border-slate-700">
                  <tr>
                    <th className="text-left px-3 py-2 text-slate-400 font-medium w-16">Type</th>
                    <th className="text-left px-3 py-2 text-slate-400 font-medium w-1/4">Source</th>
                    <th className="text-left px-3 py-2 text-slate-400 font-medium">Target A (base)</th>
                    <th className="text-left px-3 py-2 text-slate-400 font-medium">Target B (compare)</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const col = CHANGE_COLORS[row.changeType];
                    const isChanged = row.changeType === 'changed';
                    return (
                      <tr
                        key={row.unitId}
                        className={`border-b border-slate-800 hover:bg-slate-800/40 ${row.changeType === 'added' ? 'bg-emerald-950/20' : row.changeType === 'removed' ? 'bg-red-950/20' : row.changeType === 'changed' ? 'bg-amber-950/20' : ''}`}
                      >
                        <td className="px-3 py-2">
                          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium ${col}`}>
                            {CHANGE_ICONS[row.changeType]}
                            {CHANGE_LABELS[row.changeType]}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-slate-300 max-w-xs">
                          <div className="truncate" title={row.source}>{row.source || <span className="text-slate-600 italic">—</span>}</div>
                          {row.note && <div className="text-slate-500 truncate mt-0.5" title={row.note}>{row.note}</div>}
                        </td>
                        <td className={`px-3 py-2 max-w-xs ${row.changeType === 'removed' ? 'text-red-300' : 'text-slate-400'}`}>
                          {row.targetA ? (
                            <div className={`truncate ${isChanged && row.targetA !== row.targetB ? 'line-through opacity-50' : ''}`} title={row.targetA}>
                              {row.targetA}
                            </div>
                          ) : <span className="text-slate-600 italic">—</span>}
                        </td>
                        <td className={`px-3 py-2 max-w-xs ${row.changeType === 'added' ? 'text-emerald-300' : row.changeType === 'changed' && row.targetA !== row.targetB ? 'text-amber-300' : 'text-slate-300'}`}>
                          {row.targetB ? (
                            <div className="truncate" title={row.targetB}>{row.targetB}</div>
                          ) : <span className="text-slate-600 italic">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {meta && meta.totalPages > 1 && (
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>{meta.total} rows</span>
              <div className="flex items-center gap-2">
                <button
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                  className="p-1 rounded hover:bg-slate-700 disabled:opacity-40"
                >
                  <ChevronLeft size={14} />
                </button>
                <span>Page {meta.page} / {meta.totalPages}</span>
                <button
                  disabled={page >= meta.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                  className="p-1 rounded hover:bg-slate-700 disabled:opacity-40"
                >
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
