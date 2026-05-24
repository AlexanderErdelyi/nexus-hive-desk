'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Check, ChevronLeft, Download, Plus, Search, Sparkles, Trash2, Upload, X } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { api } from '@/lib/api';

interface GlossaryEntry {
  id: string;
  sourceTerm: string;
  targetTerm: string;
  sourceLanguage: string;
  targetLanguage: string;
  description?: string;
  caseSensitive: boolean;
}

interface AISuggestion {
  sourceTerm: string;
  targetTerm: string;
  description: string;
  confidence: 'high' | 'medium' | 'low';
  // local UI state
  _accepted?: boolean;
  _editedTarget?: string;
  _editedDesc?: string;
}

/** A row parsed from a CSV or Excel import file before the user confirms. */
interface ImportPreviewRow {
  sourceTerm: string;
  targetTerm: string;
  description?: string;
  /** Whether the row is a duplicate of an existing glossary entry. */
  isDuplicate: boolean;
  /** Whether this row is selected for import (default true). */
  selected: boolean;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Request failed';
}

const CONFIDENCE_STYLES = {
  high: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  low: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
};

// ─── CSV helpers ──────────────────────────────────────────────────────────────

/** Escape a cell value for CSV — wraps in quotes and escapes embedded quotes. */
function csvCell(value: string | undefined): string {
  const v = value ?? '';
  if (v.includes(',') || v.includes('"') || v.includes('\n')) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

/** Build a CSV string from glossary entries. */
function buildCsv(entries: GlossaryEntry[]): string {
  const header = 'source,target,language,notes';
  const rows = entries.map((e) =>
    [
      csvCell(e.sourceTerm),
      csvCell(e.targetTerm),
      csvCell(`${e.sourceLanguage} → ${e.targetLanguage}`),
      csvCell(e.description),
    ].join(',')
  );
  return [header, ...rows].join('\n');
}

/** Trigger a browser file download with the given content. */
function downloadFile(filename: string, content: string | Uint8Array<ArrayBuffer>, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Parse a CSV text into rows of {sourceTerm, targetTerm, description}.
 * Accepts header row with any casing of "source", "target", "notes"/"description".
 * Falls back to positional (col 0 = source, col 1 = target, col 2 = notes).
 */
function parseCsvText(text: string): Array<{ sourceTerm: string; targetTerm: string; description?: string }> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];

  const splitCsv = (line: string): string[] => {
    const result: string[] = [];
    let inQuote = false;
    let cell = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuote = !inQuote;
        }
      } else if (ch === ',' && !inQuote) {
        result.push(cell);
        cell = '';
      } else {
        cell += ch;
      }
    }
    result.push(cell);
    return result;
  };

  const header = splitCsv(lines[0]).map((h) => h.trim().toLowerCase());
  const srcIdx = header.findIndex((h) => h === 'source') ?? 0;
  const tgtIdx = header.findIndex((h) => h === 'target') ?? 1;
  const notesIdx = header.findIndex((h) => h === 'notes' || h === 'description');

  return lines.slice(1).flatMap((line) => {
    const cols = splitCsv(line);
    const source = cols[srcIdx >= 0 ? srcIdx : 0]?.trim() ?? '';
    const target = cols[tgtIdx >= 0 ? tgtIdx : 1]?.trim() ?? '';
    if (!source || !target) return [];
    return [{ sourceTerm: source, targetTerm: target, description: notesIdx >= 0 ? cols[notesIdx]?.trim() : undefined }];
  });
}

export function GlossaryManager({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ sourceTerm: '', targetTerm: '', description: '' });

  // AI panel state
  const [aiMode, setAiMode] = useState<'none' | 'generate' | 'prompt'>('none');
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<AISuggestion[]>([]);

  // Import state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importPreview, setImportPreview] = useState<ImportPreviewRow[] | null>(null);
  const [importLoading, setImportLoading] = useState(false);

  const { data: projectData } = useQuery({
    queryKey: ['project-info', projectId],
    queryFn: () =>
      api.get<{ data: { name: string; sourceLanguage: string; targetLanguage: string; xliffFiles?: { id: string }[] } }>(
        `/api/projects/${projectId}`
      ),
  });

  const { data, isLoading } = useQuery({
    queryKey: ['glossary', projectId, search],
    queryFn: () =>
      api.get<{ data: GlossaryEntry[] }>(
        `/api/glossary?projectId=${projectId}${search ? `&search=${encodeURIComponent(search)}` : ''}`
      ),
  });

  const project = projectData?.data;
  const entries = data?.data ?? [];

  const addMutation = useMutation({
    mutationFn: () =>
      api.post('/api/glossary', {
        ...form,
        projectId,
        sourceLanguage: project?.sourceLanguage ?? 'en-US',
        targetLanguage: project?.targetLanguage ?? 'de-DE',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['glossary', projectId] });
      setShowAdd(false);
      setForm({ sourceTerm: '', targetTerm: '', description: '' });
      toast.success('Glossary entry added');
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/glossary/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['glossary', projectId] });
      toast.success('Entry removed');
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const importMutation = useMutation({
    mutationFn: (entriesToImport: Array<{ sourceTerm: string; targetTerm: string; description?: string }>) =>
      api.post<{ data: unknown[]; meta?: { imported?: number } }>('/api/glossary/import', {
        projectId,
        entries: entriesToImport,
        sourceLanguage: project?.sourceLanguage ?? 'en-US',
        targetLanguage: project?.targetLanguage ?? 'de-DE',
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['glossary', projectId] });
      toast.success(`${res.meta?.imported ?? 0} terms added to glossary`);
      setSuggestions([]);
      setAiMode('none');
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  async function runAiGenerate() {
    setAiLoading(true);
    try {
      const xliffFileId = project?.xliffFiles?.[0]?.id;
      const res = await api.post<{ data: AISuggestion[] }>('/api/glossary/ai-generate', {
        projectId,
        ...(xliffFileId ? { xliffFileId } : {}),
      });
      setSuggestions(res.data.map((s) => ({ ...s, _accepted: true })));
      toast.success(`AI found ${res.data.length} glossary suggestions`);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setAiLoading(false);
    }
  }

  async function runAiPrompt() {
    if (!aiPrompt.trim()) return;
    setAiLoading(true);
    try {
      const res = await api.post<{ data: AISuggestion[] }>('/api/glossary/ai-suggest', {
        projectId,
        prompt: aiPrompt,
      });
      setSuggestions((prev) => {
        const existing = new Set(prev.map((s) => s.sourceTerm.toLowerCase()));
        const newOnes = res.data
          .filter((s) => !existing.has(s.sourceTerm.toLowerCase()))
          .map((s) => ({ ...s, _accepted: true }));
        return [...prev, ...newOnes];
      });
      toast.success(`AI suggested ${res.data.length} terms`);
      setAiPrompt('');
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setAiLoading(false);
    }
  }

  function updateSuggestion(index: number, patch: Partial<AISuggestion>) {
    setSuggestions((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  function acceptAll() {
    setSuggestions((prev) => prev.map((s) => ({ ...s, _accepted: true })));
  }

  function rejectAll() {
    setSuggestions((prev) => prev.map((s) => ({ ...s, _accepted: false })));
  }

  function importAccepted() {
    const toImport = suggestions
      .filter((s) => s._accepted)
      .map((s) => ({
        sourceTerm: s.sourceTerm,
        targetTerm: s._editedTarget ?? s.targetTerm,
        description: s._editedDesc ?? s.description,
      }));
    if (!toImport.length) {
      toast.error('No entries selected');
      return;
    }
    importMutation.mutate(toImport);
  }

  const acceptedCount = suggestions.filter((s) => s._accepted).length;

  // ─── Export handlers ───────────────────────────────────────────────────────

  function exportCsv() {
    if (!entries.length) { toast.error('No entries to export'); return; }
    downloadFile('glossary.csv', buildCsv(entries), 'text/csv;charset=utf-8;');
    toast.success('Glossary exported as CSV');
  }

  async function exportExcel() {
    if (!entries.length) { toast.error('No entries to export'); return; }
    const xlsx = await import('xlsx');
    const ws = xlsx.utils.json_to_sheet(
      entries.map((e) => ({
        source: e.sourceTerm,
        target: e.targetTerm,
        language: `${e.sourceLanguage} → ${e.targetLanguage}`,
        notes: e.description ?? '',
      }))
    );
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Glossary');
    const buf = xlsx.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array<ArrayBuffer>;
    downloadFile('glossary.xlsx', buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    toast.success('Glossary exported as Excel');
  }

  // ─── Import handlers ───────────────────────────────────────────────────────

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset so the same file can be re-selected
    e.target.value = '';
    setImportLoading(true);
    try {
      const existingTerms = new Set((entries ?? []).map((en) => en.sourceTerm.toLowerCase()));
      let rows: Array<{ sourceTerm: string; targetTerm: string; description?: string }> = [];

      if (file.name.endsWith('.csv') || file.type === 'text/csv') {
        const text = await file.text();
        rows = parseCsvText(text);
      } else {
        // Excel (.xlsx / .xls)
        const xlsx = await import('xlsx');
        const buf = await file.arrayBuffer();
        const wb = xlsx.read(buf, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const raw = xlsx.utils.sheet_to_json<Record<string, string>>(ws, { defval: '' });
        rows = raw.flatMap((row) => {
          // Flexible column name detection (case-insensitive)
          const keys = Object.keys(row);
          const srcKey = keys.find((k) => k.toLowerCase() === 'source') ?? keys[0];
          const tgtKey = keys.find((k) => k.toLowerCase() === 'target') ?? keys[1];
          const notesKey = keys.find((k) => k.toLowerCase() === 'notes' || k.toLowerCase() === 'description');
          const source = row[srcKey]?.trim() ?? '';
          const target = row[tgtKey]?.trim() ?? '';
          if (!source || !target) return [];
          return [{ sourceTerm: source, targetTerm: target, description: notesKey ? row[notesKey]?.trim() : undefined }];
        });
      }

      if (!rows.length) { toast.error('No valid rows found in file'); return; }

      setImportPreview(
        rows.map((r) => ({
          ...r,
          isDuplicate: existingTerms.has(r.sourceTerm.toLowerCase()),
          selected: true,
        }))
      );
    } catch (err) {
      toast.error(`Failed to parse file: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setImportLoading(false);
    }
  }

  function confirmImport() {
    const toImport = (importPreview ?? [])
      .filter((r) => r.selected)
      .map(({ sourceTerm, targetTerm, description }) => ({ sourceTerm, targetTerm, description }));
    if (!toImport.length) { toast.error('No rows selected'); return; }
    importMutation.mutate(toImport, {
      onSuccess: () => setImportPreview(null),
    });
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <Link href={`/projects/${projectId}`} className="text-gray-400 hover:text-gray-600 dark:text-gray-600 dark:hover:text-gray-300">
          <ChevronLeft size={20} />
        </Link>
        <div className="flex-1">
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">Glossary</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">Define how specific terms should always be translated</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Export buttons */}
          <button
            onClick={exportCsv}
            className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
            title="Export as CSV"
          >
            <Download size={14} /> CSV
          </button>
          <button
            onClick={exportExcel}
            className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
            title="Export as Excel"
          >
            <Download size={14} /> Excel
          </button>
          {/* Import button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={importLoading}
            className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
            title="Import CSV or Excel"
          >
            <Upload size={14} /> {importLoading ? 'Reading…' : 'Import'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            className="hidden"
            onChange={handleFileSelect}
          />
          <button
            onClick={() => { setAiMode(aiMode === 'generate' ? 'none' : 'generate'); setSuggestions([]); }}
            className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              aiMode === 'generate'
                ? 'bg-violet-600 text-white'
                : 'border border-violet-300 text-violet-700 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-400 dark:hover:bg-violet-900/20'
            }`}
          >
            <Sparkles size={14} /> Auto-Generate
          </button>
          <button
            onClick={() => { setAiMode(aiMode === 'prompt' ? 'none' : 'prompt'); if (aiMode !== 'prompt') setSuggestions([]); }}
            className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              aiMode === 'prompt'
                ? 'bg-violet-600 text-white'
                : 'border border-violet-300 text-violet-700 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-400 dark:hover:bg-violet-900/20'
            }`}
          >
            <Bot size={14} /> AI Prompt
          </button>
          <button
            onClick={() => setShowAdd((v) => !v)}
            className="flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            <Plus size={14} /> Add Term
          </button>
        </div>
      </div>

      {project && (
        <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm text-gray-600 dark:border-blue-900/50 dark:bg-blue-900/20 dark:text-gray-300">
          💡 <strong>Tip:</strong> AI uses this glossary on every translation. E.g. &quot;Customer&quot; → &quot;Debitor&quot; (not &quot;Kunde&quot;) for{' '}
          <span className="font-mono">{project.sourceLanguage} → {project.targetLanguage}</span>.
        </div>
      )}

      {/* AI Auto-Generate Panel */}
      {aiMode === 'generate' && (
        <div className="mb-4 rounded-xl border border-violet-200 bg-violet-50 p-4 dark:border-violet-800 dark:bg-violet-900/20">
          <div className="mb-3 flex items-center gap-2">
            <Sparkles size={15} className="text-violet-600 dark:text-violet-400" />
            <span className="text-sm font-semibold text-violet-800 dark:text-violet-300">AI Auto-Generate Glossary</span>
          </div>
          <p className="mb-3 text-xs text-violet-600 dark:text-violet-400">
            AI will analyze your uploaded XLIFF translations and identify BC-specific terms that should be in the glossary.
          </p>
          <button
            disabled={aiLoading}
            onClick={runAiGenerate}
            className="flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
          >
            <Sparkles size={14} />
            {aiLoading ? 'Analyzing translations...' : 'Analyze & Generate Suggestions'}
          </button>
        </div>
      )}

      {/* AI Prompt Panel */}
      {aiMode === 'prompt' && (
        <div className="mb-4 rounded-xl border border-violet-200 bg-violet-50 p-4 dark:border-violet-800 dark:bg-violet-900/20">
          <div className="mb-3 flex items-center gap-2">
            <Bot size={15} className="text-violet-600 dark:text-violet-400" />
            <span className="text-sm font-semibold text-violet-800 dark:text-violet-300">Generate from Prompt</span>
          </div>
          <p className="mb-2 text-xs text-violet-600 dark:text-violet-400">
            Describe the terms you want. E.g. <em>"Customer=Debitor, Vendor=Kreditor, all warehouse and finance terms for BC"</em>
          </p>
          <div className="flex gap-2">
            <input
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runAiPrompt()}
              placeholder="e.g. Customer should be Debitor, all financial posting terms, Sales module..."
              className="flex-1 rounded-lg border border-violet-300 bg-white px-3 py-2 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-violet-400 dark:border-violet-700 dark:bg-gray-900 dark:text-gray-200 dark:placeholder-gray-600"
            />
            <button
              disabled={aiLoading || !aiPrompt.trim()}
              onClick={runAiPrompt}
              className="flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
            >
              {aiLoading ? 'Generating...' : 'Generate'}
            </button>
          </div>
        </div>
      )}

      {/* AI Suggestions Review Table */}
      {suggestions.length > 0 && (
        <div className="mb-4 overflow-hidden rounded-xl border border-violet-200 bg-white dark:border-violet-800 dark:bg-gray-900">
          <div className="flex items-center justify-between border-b border-violet-100 bg-violet-50 px-4 py-3 dark:border-violet-900 dark:bg-violet-900/20">
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold text-violet-800 dark:text-violet-300">
                AI Suggestions — {acceptedCount} / {suggestions.length} selected
              </span>
              <button onClick={acceptAll} className="text-xs text-violet-600 hover:underline dark:text-violet-400">Accept all</button>
              <button onClick={rejectAll} className="text-xs text-violet-600 hover:underline dark:text-violet-400">Reject all</button>
            </div>
            <div className="flex items-center gap-2">
              <button
                disabled={acceptedCount === 0 || importMutation.isPending}
                onClick={importAccepted}
                className="flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                <Check size={14} />
                {importMutation.isPending ? 'Saving...' : `Add ${acceptedCount} to Glossary`}
              </button>
              <button onClick={() => setSuggestions([])} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
                <X size={16} />
              </button>
            </div>
          </div>
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50 dark:border-gray-800 dark:bg-gray-800/50">
              <tr>
                <th className="w-10 p-2"></th>
                <th className="p-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Source</th>
                <th className="p-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Target</th>
                <th className="p-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Description</th>
                <th className="w-20 p-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Confidence</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {suggestions.map((s, i) => (
                <tr
                  key={i}
                  className={`transition-colors ${
                    s._accepted
                      ? 'bg-white dark:bg-gray-900'
                      : 'bg-gray-50/80 opacity-50 dark:bg-gray-800/30'
                  }`}
                >
                  <td className="p-2 text-center">
                    <input
                      type="checkbox"
                      checked={s._accepted ?? true}
                      onChange={(e) => updateSuggestion(i, { _accepted: e.target.checked })}
                      className="h-4 w-4 rounded border-gray-300 accent-indigo-600"
                    />
                  </td>
                  <td className="p-2 font-medium text-gray-900 dark:text-white">{s.sourceTerm}</td>
                  <td className="p-2">
                    <input
                      value={s._editedTarget ?? s.targetTerm}
                      onChange={(e) => updateSuggestion(i, { _editedTarget: e.target.value })}
                      className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 font-medium text-indigo-700 focus:border-indigo-300 focus:bg-white focus:outline-none dark:text-indigo-400 dark:focus:bg-gray-800"
                    />
                  </td>
                  <td className="p-2">
                    <input
                      value={s._editedDesc ?? s.description}
                      onChange={(e) => updateSuggestion(i, { _editedDesc: e.target.value })}
                      className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-xs text-gray-500 focus:border-gray-300 focus:bg-white focus:outline-none dark:text-gray-400 dark:focus:bg-gray-800"
                    />
                  </td>
                  <td className="p-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${CONFIDENCE_STYLES[s.confidence]}`}>
                      {s.confidence}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {aiMode === 'prompt' && (
            <div className="border-t border-violet-100 bg-violet-50/50 p-3 dark:border-violet-900 dark:bg-violet-900/10">
              <p className="text-xs text-violet-600 dark:text-violet-400">
                💡 You can keep generating more terms — new ones will be added to this list. Then click &quot;Add to Glossary&quot; when done.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Search + manual add */}
      <div className="mb-4 flex gap-3">
        <div className="relative flex-1">
          <Search size={15} className="absolute top-1/2 left-3 -translate-y-1/2 text-gray-400" />
          <input
            className="w-full rounded-lg border border-gray-300 py-2 pr-3 pl-9 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white dark:placeholder-gray-500"
            placeholder="Search terms..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Manual Add Form */}
      {showAdd && (
        <div className="mb-4 rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
          <h3 className="mb-4 font-semibold text-gray-900 dark:text-white">Add Glossary Entry</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Source Term *</label>
              <input
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white dark:placeholder-gray-500"
                placeholder="e.g. Customer"
                value={form.sourceTerm}
                onChange={(e) => setForm((c) => ({ ...c, sourceTerm: e.target.value }))}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Target Term *</label>
              <input
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white dark:placeholder-gray-500"
                placeholder="e.g. Debitor"
                value={form.targetTerm}
                onChange={(e) => setForm((c) => ({ ...c, targetTerm: e.target.value }))}
              />
            </div>
            <div className="col-span-2">
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Description (optional)</label>
              <input
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white dark:placeholder-gray-500"
                placeholder="e.g. BC-specific: always use Debitor not Kunde"
                value={form.description}
                onChange={(e) => setForm((c) => ({ ...c, description: e.target.value }))}
              />
            </div>
          </div>
          <div className="mt-4 flex gap-3">
            <button
              onClick={() => addMutation.mutate()}
              disabled={!form.sourceTerm || !form.targetTerm || addMutation.isPending}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {addMutation.isPending ? 'Adding...' : 'Add Entry'}
            </button>
            <button
              onClick={() => setShowAdd(false)}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Glossary Table */}
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        {isLoading ? (
          <div className="py-12 text-center text-gray-400 dark:text-gray-600">Loading...</div>
        ) : entries.length === 0 ? (
          <div className="py-12 text-center text-gray-400 dark:text-gray-600">
            <p>No glossary entries yet.</p>
            <p className="mt-1 text-sm">Use AI Auto-Generate or add terms manually.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800/50">
              <tr>
                <th className="p-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Source Term</th>
                <th className="p-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Target Term</th>
                <th className="p-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Description</th>
                <th className="w-12 p-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {entries.map((entry) => (
                <tr key={entry.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                  <td className="p-3 font-medium text-gray-900 dark:text-white">{entry.sourceTerm}</td>
                  <td className="p-3 font-medium text-indigo-700 dark:text-indigo-400">{entry.targetTerm}</td>
                  <td className="p-3 text-xs text-gray-500 dark:text-gray-400">{entry.description}</td>
                  <td className="p-3">
                    <button
                      onClick={() => deleteMutation.mutate(entry.id)}
                      className="text-gray-400 hover:text-red-500 dark:text-gray-600 dark:hover:text-red-400"
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Import Preview Modal */}
      {importPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl dark:bg-gray-900">
            {/* Modal header */}
            <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4 dark:border-gray-700">
              <div>
                <h3 className="font-semibold text-gray-900 dark:text-white">Import Preview</h3>
                <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  {importPreview.filter((r) => r.selected).length} of {importPreview.length} rows selected.
                  {importPreview.some((r) => r.isDuplicate) && (
                    <span className="ml-1 text-amber-600 dark:text-amber-400">
                      ⚠ Yellow rows are duplicates and will be updated.
                    </span>
                  )}
                </p>
              </div>
              <button onClick={() => setImportPreview(null)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
                <X size={18} />
              </button>
            </div>

            {/* Table */}
            <div className="flex-1 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 border-b border-gray-100 bg-gray-50 dark:border-gray-800 dark:bg-gray-800">
                  <tr>
                    <th className="w-10 p-2">
                      <input
                        type="checkbox"
                        checked={importPreview.every((r) => r.selected)}
                        onChange={(e) =>
                          setImportPreview((prev) => prev!.map((r) => ({ ...r, selected: e.target.checked })))
                        }
                        className="h-4 w-4 rounded border-gray-300 accent-indigo-600"
                      />
                    </th>
                    <th className="p-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Source</th>
                    <th className="p-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Target</th>
                    <th className="p-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {importPreview.map((row, i) => (
                    <tr
                      key={i}
                      className={`${
                        row.isDuplicate ? 'bg-amber-50 dark:bg-amber-900/10' : ''
                      } ${!row.selected ? 'opacity-40' : ''}`}
                    >
                      <td className="p-2 text-center">
                        <input
                          type="checkbox"
                          checked={row.selected}
                          onChange={(e) =>
                            setImportPreview((prev) =>
                              prev!.map((r, j) => (j === i ? { ...r, selected: e.target.checked } : r))
                            )
                          }
                          className="h-4 w-4 rounded border-gray-300 accent-indigo-600"
                        />
                      </td>
                      <td className="p-2 font-medium text-gray-900 dark:text-white">{row.sourceTerm}</td>
                      <td className="p-2 text-indigo-700 dark:text-indigo-400">{row.targetTerm}</td>
                      <td className="p-2 text-xs text-gray-500 dark:text-gray-400">{row.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Modal footer */}
            <div className="flex items-center justify-end gap-3 border-t border-gray-200 px-5 py-4 dark:border-gray-700">
              <button
                onClick={() => setImportPreview(null)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                Cancel
              </button>
              <button
                onClick={confirmImport}
                disabled={importMutation.isPending || !importPreview.some((r) => r.selected)}
                className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                <Check size={14} />
                {importMutation.isPending ? 'Importing…' : `Import ${importPreview.filter((r) => r.selected).length} terms`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
