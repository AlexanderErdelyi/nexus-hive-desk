'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookMarked, Check, ChevronLeft, ChevronRight, Download, Edit2, Globe, Plus,
  RefreshCw, Search, Trash2, Upload, X,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';

interface TmEntry {
  id: string;
  source: string;
  target: string;
  sourceLanguage: string;
  targetLanguage: string;
  projectId: string | null;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

interface Props {
  projectId: string;
}

const PAGE_SIZE = 50;

// ─── CSV export helpers ───────────────────────────────────────────────────────

function escapeCsv(v: string) {
  if (v.includes(',') || v.includes('"') || v.includes('\n')) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function downloadCsv(entries: TmEntry[]) {
  const header = 'source,target,sourceLanguage,targetLanguage,scope,usageCount';
  const rows = entries.map((e) =>
    [escapeCsv(e.source), escapeCsv(e.target), e.sourceLanguage, e.targetLanguage, e.projectId ? 'project' : 'global', e.usageCount].join(',')
  );
  const blob = new Blob([header + '\n' + rows.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'translation-memory.csv'; a.click();
  URL.revokeObjectURL(url);
}

function downloadTmx(entries: TmEntry[]) {
  const units = entries.map((e) => `  <tu>
    <tuv xml:lang="${e.sourceLanguage}"><seg>${e.source.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</seg></tuv>
    <tuv xml:lang="${e.targetLanguage}"><seg>${e.target.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</seg></tuv>
  </tu>`).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<tmx version="1.4">\n  <header creationtool="NexusHiveDesk" datatype="plaintext" segtype="sentence" adminlang="en" srclang="*all*" o-tmf="ABCTransMem"/>\n  <body>\n${units}\n  </body>\n</tmx>`;
  const blob = new Blob([xml], { type: 'application/xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'translation-memory.tmx'; a.click();
  URL.revokeObjectURL(url);
}

// ─── TMX/CSV parser ───────────────────────────────────────────────────────────

function parseCsvImport(text: string): Array<{ source: string; target: string; sourceLanguage: string; targetLanguage: string }> {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  // detect header
  const firstLower = lines[0].toLowerCase();
  const hasHeader = firstLower.includes('source') || firstLower.includes('srclang');
  const dataLines = hasHeader ? lines.slice(1) : lines;
  return dataLines.map((line) => {
    const cols = line.split(',').map((c) => c.replace(/^"|"$/g, '').trim());
    return { source: cols[0] ?? '', target: cols[1] ?? '', sourceLanguage: cols[2] ?? 'en', targetLanguage: cols[3] ?? 'de' };
  }).filter((e) => e.source && e.target);
}

function parseTmxImport(text: string): Array<{ source: string; target: string; sourceLanguage: string; targetLanguage: string }> {
  const tuRegex = /<tu>([\s\S]*?)<\/tu>/gi;
  const tuvRegex = /<tuv[^>]*xml:lang="([^"]+)"[^>]*>[\s\S]*?<seg>([\s\S]*?)<\/seg>/gi;
  const entries: Array<{ source: string; target: string; sourceLanguage: string; targetLanguage: string }> = [];
  let tuMatch: RegExpExecArray | null;
  while ((tuMatch = tuRegex.exec(text)) !== null) {
    const tuvs: Array<{ lang: string; seg: string }> = [];
    let tuvMatch: RegExpExecArray | null;
    const tuvRegexLocal = /<tuv[^>]*xml:lang="([^"]+)"[^>]*>[\s\S]*?<seg>([\s\S]*?)<\/seg>/gi;
    while ((tuvMatch = tuvRegexLocal.exec(tuMatch[1])) !== null) {
      tuvs.push({ lang: tuvMatch[1], seg: tuvMatch[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') });
    }
    if (tuvs.length >= 2) {
      entries.push({ source: tuvs[0].seg, target: tuvs[1].seg, sourceLanguage: tuvs[0].lang, targetLanguage: tuvs[1].lang });
    }
  }
  return entries;
}

// ─── Add/Edit row modal ───────────────────────────────────────────────────────

function AddEntryModal({ projectId, onClose, onSaved }: { projectId: string; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ source: '', target: '', sourceLanguage: 'en', targetLanguage: 'de', scope: 'project' });
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!form.source.trim() || !form.target.trim()) { toast.error('Source and target are required'); return; }
    setSaving(true);
    try {
      await api.post('/api/translation-memory/upsert', {
        source: form.source.trim(),
        target: form.target.trim(),
        sourceLanguage: form.sourceLanguage,
        targetLanguage: form.targetLanguage,
        ...(form.scope === 'project' ? { projectId } : {}),
      });
      toast.success('TM entry saved');
      onSaved();
      onClose();
    } catch { toast.error('Failed to save entry'); }
    finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl dark:bg-gray-900">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Add TM Entry</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"><X size={18} /></button>
        </div>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">Source language</label>
              <input value={form.sourceLanguage} onChange={(e) => setForm((f) => ({ ...f, sourceLanguage: e.target.value }))}
                className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">Target language</label>
              <input value={form.targetLanguage} onChange={(e) => setForm((f) => ({ ...f, targetLanguage: e.target.value }))}
                className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">Source text</label>
            <textarea rows={3} value={form.source} onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))}
              className="w-full resize-none rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">Target text</label>
            <textarea rows={3} value={form.target} onChange={(e) => setForm((f) => ({ ...f, target: e.target.value }))}
              className="w-full resize-none rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">Scope</label>
            <select value={form.scope} onChange={(e) => setForm((f) => ({ ...f, scope: e.target.value }))}
              className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100">
              <option value="project">Project-scoped</option>
              <option value="global">Global</option>
            </select>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">Cancel</button>
          <button onClick={handleSave} disabled={saving} className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save Entry'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Populate modal ───────────────────────────────────────────────────────────

type PopulateConflict = { key: string; source: string; sourceLanguage: string; targetLanguage: string; options: string[] };
type PreviewResult = { dryRun: true; conflicts: PopulateConflict[]; willCreate: number; willUpdate: number; skipped: number };
type ApplyResult = { success: true; created: number; updated: number; skipped: number };

function PopulateModal({ projectId, onClose, onDone }: { projectId: string; onClose: () => void; onDone: () => void }) {
  const [scope, setScope] = useState<'project' | 'global'>('project');
  const [states, setStates] = useState<string[]>(['translated', 'final']);
  const [step, setStep] = useState<'configure' | 'preview' | 'done'>('configure');
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);

  function toggleState(s: string) {
    setStates((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]);
  }

  async function analyse() {
    if (!states.length) { toast.error('Select at least one state'); return; }
    setLoading(true);
    try {
      const res = await api.post<PreviewResult>('/api/translation-memory/populate', { projectId, scope, states, dryRun: true });
      setPreview(res);
      setResolutions({});
      setStep('preview');
    } catch { toast.error('Analysis failed — check server logs'); }
    finally { setLoading(false); }
  }

  async function apply() {
    if (!preview) return;
    const unresolvedCount = preview.conflicts.filter((c) => !resolutions[c.key]).length;
    if (unresolvedCount > 0) { toast.error(`Resolve all ${unresolvedCount} conflicts first`); return; }
    setLoading(true);
    try {
      const res = await api.post<ApplyResult>('/api/translation-memory/populate', { projectId, scope, states, dryRun: false, resolutions });
      setApplyResult(res);
      setStep('done');
      onDone();
    } catch { toast.error('Apply failed — check server logs'); }
    finally { setLoading(false); }
  }

  const unresolvedCount = preview ? preview.conflicts.filter((c) => !resolutions[c.key]).length : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl dark:bg-gray-900 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-start justify-between p-6 pb-4 shrink-0">
          <div>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Populate from Translations</h2>
            <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">
              {step === 'configure' && 'Harvest confirmed strings from this project into the TM library'}
              {step === 'preview' && `${(preview?.willCreate ?? 0) + (preview?.willUpdate ?? 0)} changes${preview?.conflicts.length ? ` · ${preview.conflicts.length} conflict${preview.conflicts.length > 1 ? 's' : ''} to resolve` : ' ready to apply'}`}
              {step === 'done' && 'TM populated successfully'}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 shrink-0 ml-3"><X size={18} /></button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto px-6 pb-6 grow">

          {/* ── Step 1: Configure ── */}
          {step === 'configure' && (
            <div className="space-y-4">
              <div>
                <label className="mb-2 block text-xs font-medium text-gray-500 dark:text-gray-400">Include translation states</label>
                <div className="flex flex-wrap gap-2">
                  {['translated', 'final', 'needs-review-translation'].map((s) => (
                    <button key={s} onClick={() => toggleState(s)}
                      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${states.includes(s) ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300' : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700'}`}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="mb-2 block text-xs font-medium text-gray-500 dark:text-gray-400">Store as</label>
                <div className="flex gap-2">
                  {(['project', 'global'] as const).map((s) => (
                    <button key={s} onClick={() => setScope(s)}
                      className={`flex-1 rounded-lg border py-2 text-sm font-medium transition-colors ${scope === s ? 'border-indigo-400 bg-indigo-50 text-indigo-700 dark:border-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-300' : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800'}`}>
                      {s === 'project' ? '🏷 Project-scoped' : '🌐 Global'}
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-xs text-gray-400 dark:text-gray-500">
                  {scope === 'project' ? 'Entries will only be suggested for this project.' : 'Entries will be suggested across all projects.'}
                </p>
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button onClick={onClose} className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">Cancel</button>
                <button onClick={analyse} disabled={loading || !states.length} className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                  <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
                  {loading ? 'Analysing…' : 'Analyse'}
                </button>
              </div>
            </div>
          )}

          {/* ── Step 2: Preview + conflict resolution ── */}
          {step === 'preview' && preview && (
            <div className="space-y-4">
              {/* Stats */}
              <div className="grid grid-cols-3 gap-3 text-center">
                {[
                  { label: 'Will create', value: preview.willCreate, color: 'text-teal-600 dark:text-teal-400' },
                  { label: 'Will update', value: preview.willUpdate, color: 'text-indigo-600 dark:text-indigo-400' },
                  { label: 'Unchanged', value: preview.skipped, color: 'text-gray-400' },
                ].map((s) => (
                  <div key={s.label} className="rounded-xl border border-gray-200 bg-gray-50 py-3 dark:border-gray-700 dark:bg-gray-800">
                    <div className={`text-xl font-bold ${s.color}`}>{s.value.toLocaleString()}</div>
                    <div className="text-xs text-gray-400 dark:text-gray-500">{s.label}</div>
                  </div>
                ))}
              </div>

              {/* Conflicts */}
              {preview.conflicts.length > 0 && (
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-semibold text-amber-600 dark:text-amber-400">
                      ⚠ {preview.conflicts.length} conflict{preview.conflicts.length > 1 ? 's' : ''} — same source, different translations
                    </span>
                    {unresolvedCount > 0 && (
                      <span className="text-xs text-gray-400">{unresolvedCount} unresolved</span>
                    )}
                  </div>
                  <div className="space-y-3 rounded-xl border border-amber-200 bg-amber-50/50 p-3 dark:border-amber-800/30 dark:bg-amber-900/10">
                    {preview.conflicts.map((conflict) => (
                      <div key={conflict.key} className="space-y-1.5">
                        <p className="text-xs font-medium text-gray-700 dark:text-gray-300 line-clamp-2" title={conflict.source}>
                          <span className="mr-1.5 text-[10px] text-gray-400">{conflict.sourceLanguage}→{conflict.targetLanguage}</span>
                          {conflict.source}
                        </p>
                        <div className="flex flex-col gap-1">
                          {conflict.options.map((opt) => (
                            <button
                              key={opt}
                              onClick={() => setResolutions((r) => ({ ...r, [conflict.key]: opt }))}
                              className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs transition-colors ${resolutions[conflict.key] === opt ? 'border-teal-400 bg-teal-50 text-teal-800 dark:border-teal-600 dark:bg-teal-900/30 dark:text-teal-200' : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700'}`}
                            >
                              <span className={`shrink-0 h-3.5 w-3.5 rounded-full border-2 flex items-center justify-center ${resolutions[conflict.key] === opt ? 'border-teal-500 bg-teal-500' : 'border-gray-300 dark:border-gray-600'}`}>
                                {resolutions[conflict.key] === opt && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                              </span>
                              <span className="flex-1 truncate">{opt}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {preview.conflicts.length === 0 && (
                <p className="text-center text-xs text-gray-400 dark:text-gray-500">✓ No conflicts — ready to apply</p>
              )}

              <div className="flex justify-between gap-2 pt-1">
                <button onClick={() => setStep('configure')} className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">Back</button>
                <button onClick={apply} disabled={loading || unresolvedCount > 0} className="flex items-center gap-2 rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50">
                  <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
                  {loading ? 'Applying…' : unresolvedCount > 0 ? `Resolve ${unresolvedCount} conflict${unresolvedCount > 1 ? 's' : ''}` : 'Apply to TM'}
                </button>
              </div>
            </div>
          )}

          {/* ── Step 3: Done ── */}
          {step === 'done' && applyResult && (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-3 text-center">
                {[
                  { label: 'Created', value: applyResult.created, color: 'text-teal-600 dark:text-teal-400' },
                  { label: 'Updated', value: applyResult.updated, color: 'text-indigo-600 dark:text-indigo-400' },
                  { label: 'Unchanged', value: applyResult.skipped, color: 'text-gray-400' },
                ].map((s) => (
                  <div key={s.label} className="rounded-xl border border-gray-200 bg-gray-50 py-3 dark:border-gray-700 dark:bg-gray-800">
                    <div className={`text-2xl font-bold ${s.color}`}>{s.value.toLocaleString()}</div>
                    <div className="text-xs text-gray-400 dark:text-gray-500">{s.label}</div>
                  </div>
                ))}
              </div>
              <p className="text-center text-xs text-gray-400 dark:text-gray-500">TM populated successfully!</p>
              <div className="flex justify-end">
                <button onClick={onClose} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">Done</button>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function TranslationMemoryView({ projectId }: Props) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [showPopulate, setShowPopulate] = useState(false);
  const [confirmDeleteIds, setConfirmDeleteIds] = useState<string[] | null>(null);
  const [importing, setImporting] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const queryKey = ['tm', projectId, debouncedSearch, page];

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () =>
      api.get<{ data: TmEntry[]; meta: { total: number; page: number; pageSize: number } }>(
        `/api/translation-memory?projectId=${projectId}&page=${page}&pageSize=${PAGE_SIZE}${debouncedSearch ? `&search=${encodeURIComponent(debouncedSearch)}` : ''}`
      ),
  });

  const entries = data?.data ?? [];
  const total = data?.meta.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // language pair stats (from current page — good enough for overview)
  const langPairs = [...new Set(entries.map((e) => `${e.sourceLanguage}→${e.targetLanguage}`))];

  const deleteMut = useMutation({
    mutationFn: (ids: string[]) =>
      ids.length === 1
        ? api.delete(`/api/translation-memory/${ids[0]}`)
        : api.post('/api/translation-memory/bulk-delete', { ids }),
    onSuccess: (_r, ids) => {
      toast.success(`Deleted ${ids.length} entr${ids.length === 1 ? 'y' : 'ies'}`);
      setSelected(new Set());
      setConfirmDeleteIds(null);
      qc.invalidateQueries({ queryKey: ['tm', projectId] });
    },
    onError: () => toast.error('Delete failed'),
  });

  const patchMut = useMutation({
    mutationFn: ({ id, target }: { id: string; target: string }) =>
      api.patch(`/api/translation-memory/${id}`, { target }),
    onSuccess: () => {
      toast.success('Entry updated');
      setEditingId(null);
      qc.invalidateQueries({ queryKey: ['tm', projectId] });
    },
    onError: () => toast.error('Update failed'),
  });

  function handleSearchChange(v: string) {
    setSearch(v);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => { setDebouncedSearch(v); setPage(1); }, 300);
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === entries.length) setSelected(new Set());
    else setSelected(new Set(entries.map((e) => e.id)));
  }

  function startEdit(entry: TmEntry) { setEditingId(entry.id); setEditTarget(entry.target); }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    try {
      const text = await file.text();
      const parsed = file.name.endsWith('.tmx') ? parseTmxImport(text) : parseCsvImport(text);
      if (!parsed.length) { toast.error('No entries found in file'); return; }
      const res = await api.post<{ created: number; updated: number }>('/api/translation-memory/import', { entries: parsed, projectId });
      toast.success(`Imported: ${res.created} new, ${res.updated} updated`);
      qc.invalidateQueries({ queryKey: ['tm', projectId] });
    } catch { toast.error('Import failed'); }
    finally { setImporting(false); if (importRef.current) importRef.current.value = ''; }
  }

  async function handleExport(format: 'csv' | 'tmx') {
    // fetch all entries (no pagination) for export
    try {
      const res = await api.get<{ data: TmEntry[] }>(`/api/translation-memory?projectId=${projectId}&pageSize=10000`);
      format === 'csv' ? downloadCsv(res.data) : downloadTmx(res.data);
      toast.success(`Exported ${res.data.length} entries as ${format.toUpperCase()}`);
    } catch { toast.error('Export failed'); }
  }

  const scopeColor = (e: TmEntry) => e.projectId
    ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300'
    : 'bg-teal-50 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300';

  return (
    <div className="space-y-5">
      {/* Stats bar */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { label: 'Total entries', value: total.toLocaleString(), icon: <BookMarked size={18} className="text-indigo-500" /> },
          { label: 'Language pairs', value: langPairs.length || '—', icon: <Globe size={18} className="text-teal-500" /> },
          { label: 'Project-scoped', value: entries.filter((e) => e.projectId).length, icon: <BookMarked size={18} className="text-violet-500" /> },
          { label: 'Global', value: entries.filter((e) => !e.projectId).length, icon: <Globe size={18} className="text-amber-500" /> },
        ].map((s) => (
          <div key={s.label} className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
            {s.icon}
            <div>
              <div className="text-xl font-bold text-gray-900 dark:text-gray-100">{s.value}</div>
              <div className="text-xs text-gray-400 dark:text-gray-500">{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search source or target…"
            className="w-full rounded-lg border border-gray-200 bg-white py-2 pl-9 pr-3 text-sm focus:border-indigo-400 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500"
          />
        </div>

        {selected.size > 0 && (
          <button
            onClick={() => setConfirmDeleteIds([...selected])}
            className="flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-100 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400"
          >
            <Trash2 size={14} />
            Delete {selected.size}
          </button>
        )}

        <button
          onClick={() => setShowPopulate(true)}
          className="flex items-center gap-1.5 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-sm font-medium text-teal-700 hover:bg-teal-100 dark:border-teal-800/40 dark:bg-teal-900/20 dark:text-teal-400 dark:hover:bg-teal-900/40"
        >
          <RefreshCw size={14} /> Populate from Translations
        </button>

        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          <Plus size={14} /> Add Entry
        </button>

        <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">
          <Upload size={14} />
          {importing ? 'Importing…' : 'Import'}
          <input ref={importRef} type="file" accept=".csv,.tmx" className="hidden" onChange={handleImport} disabled={importing} />
        </label>

        <div className="relative group">
          <button className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">
            <Download size={14} /> Export
          </button>
          <div className="absolute right-0 top-full z-20 hidden w-32 rounded-lg border border-gray-200 bg-white shadow-lg group-hover:block dark:border-gray-700 dark:bg-gray-900">
            <button onClick={() => handleExport('csv')} className="block w-full px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800 dark:text-gray-300">CSV</button>
            <button onClick={() => handleExport('tmx')} className="block w-full px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800 dark:text-gray-300">TMX</button>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col className="w-9" />
            <col className="w-[32%]" />
            <col className="w-[32%]" />
            <col className="w-[110px]" />
            <col className="w-[100px]" />
            <col className="w-[60px]" />
            <col className="w-[72px]" />
          </colgroup>
          <thead className="border-b border-gray-200 bg-gray-50 text-xs font-medium text-gray-500 dark:border-gray-700 dark:bg-gray-800/50 dark:text-gray-400">
            <tr>
              <th className="px-3 py-3">
                <input type="checkbox" checked={selected.size === entries.length && entries.length > 0} onChange={toggleAll}
                  className="rounded border-gray-300 text-indigo-600 dark:border-gray-600" />
              </th>
              <th className="px-3 py-3 text-left">Source</th>
              <th className="px-3 py-3 text-left">Target</th>
              <th className="px-3 py-3 text-left">Languages</th>
              <th className="px-3 py-3 text-left">Scope</th>
              <th className="px-3 py-3 text-center">Used</th>
              <th className="px-3 py-3 text-center">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {isLoading ? (
              <tr><td colSpan={7} className="py-12 text-center text-gray-400">Loading…</td></tr>
            ) : entries.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-16 text-center">
                  <BookMarked size={32} className="mx-auto mb-3 text-gray-200 dark:text-gray-700" />
                  <p className="text-sm text-gray-400 dark:text-gray-500">
                    {debouncedSearch ? 'No entries match your search' : 'No TM entries yet — they are auto-populated as you translate'}
                  </p>
                </td>
              </tr>
            ) : entries.map((entry) => (
              <tr key={entry.id} className={`group transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/50 ${selected.has(entry.id) ? 'bg-indigo-50/40 dark:bg-indigo-900/10' : ''}`}>
                <td className="px-3 py-3">
                  <input type="checkbox" checked={selected.has(entry.id)} onChange={() => toggleSelect(entry.id)}
                    className="rounded border-gray-300 text-indigo-600 dark:border-gray-600" />
                </td>
                <td className="px-3 py-3">
                  <span className="line-clamp-2 text-gray-700 dark:text-gray-300">{entry.source}</span>
                </td>
                <td className="px-3 py-3">
                  {editingId === entry.id ? (
                    <div className="flex items-start gap-1">
                      <textarea
                        rows={2}
                        value={editTarget}
                        onChange={(e) => setEditTarget(e.target.value)}
                        autoFocus
                        className="w-full resize-none rounded border border-indigo-400 bg-white px-2 py-1 text-sm focus:outline-none dark:bg-gray-800 dark:text-gray-100"
                      />
                      <div className="flex flex-col gap-1 pt-0.5">
                        <button onClick={() => patchMut.mutate({ id: entry.id, target: editTarget.trim() })}
                          className="rounded bg-indigo-600 p-1 text-white hover:bg-indigo-700" title="Save">
                          <Check size={12} />
                        </button>
                        <button onClick={() => setEditingId(null)}
                          className="rounded border border-gray-200 p-1 text-gray-500 hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-700" title="Cancel">
                          <X size={12} />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <span className="line-clamp-2 text-gray-700 dark:text-gray-300">{entry.target}</span>
                  )}
                </td>
                <td className="px-3 py-3 text-xs text-gray-500 dark:text-gray-400">{entry.sourceLanguage} → {entry.targetLanguage}</td>
                <td className="px-3 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${scopeColor(entry)}`}>
                    {entry.projectId ? 'project' : 'global'}
                  </span>
                </td>
                <td className="px-3 py-3 text-center text-xs text-gray-500 dark:text-gray-400">{entry.usageCount}</td>
                <td className="px-3 py-3">
                  <div className="flex items-center justify-center gap-1 opacity-0 group-hover:opacity-100">
                    <button onClick={() => startEdit(entry)} title="Edit target"
                      className="rounded p-1 text-gray-400 hover:bg-indigo-50 hover:text-indigo-600 dark:hover:bg-indigo-900/30 dark:hover:text-indigo-300">
                      <Edit2 size={13} />
                    </button>
                    <button onClick={() => setConfirmDeleteIds([entry.id])} title="Delete"
                      className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-900/20 dark:hover:text-red-400">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-gray-500 dark:text-gray-400">
          <span>{total.toLocaleString()} entries</span>
          <div className="flex items-center gap-1">
            <button disabled={page === 1} onClick={() => setPage((p) => p - 1)}
              className="rounded p-1 hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-gray-800"><ChevronLeft size={16} /></button>
            <span className="px-2">Page {page} / {totalPages}</span>
            <button disabled={page === totalPages} onClick={() => setPage((p) => p + 1)}
              className="rounded p-1 hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-gray-800"><ChevronRight size={16} /></button>
          </div>
        </div>
      )}

      {/* Add entry modal */}
      {showAdd && (
        <AddEntryModal
          projectId={projectId}
          onClose={() => setShowAdd(false)}
          onSaved={() => qc.invalidateQueries({ queryKey: ['tm', projectId] })}
        />
      )}

      {showPopulate && (
        <PopulateModal
          projectId={projectId}
          onClose={() => setShowPopulate(false)}
          onDone={() => qc.invalidateQueries({ queryKey: ['tm', projectId] })}
        />
      )}

      {/* Delete confirm */}
      {confirmDeleteIds && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl dark:bg-gray-900">
            <h2 className="mb-2 text-base font-semibold text-gray-900 dark:text-gray-100">Delete {confirmDeleteIds.length} entr{confirmDeleteIds.length === 1 ? 'y' : 'ies'}?</h2>
            <p className="mb-5 text-sm text-gray-500 dark:text-gray-400">This cannot be undone.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmDeleteIds(null)}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">Cancel</button>
              <button onClick={() => deleteMut.mutate(confirmDeleteIds)} disabled={deleteMut.isPending}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">
                {deleteMut.isPending ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
