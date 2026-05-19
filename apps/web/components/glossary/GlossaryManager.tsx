'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Check, ChevronLeft, Plus, Search, Sparkles, Trash2, X } from 'lucide-react';
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

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Request failed';
}

const CONFIDENCE_STYLES = {
  high: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  low: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
};

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
      api.post('/api/glossary/import', {
        projectId,
        entries: entriesToImport,
        sourceLanguage: project?.sourceLanguage ?? 'en-US',
        targetLanguage: project?.targetLanguage ?? 'de-DE',
      }),
    onSuccess: (res: { meta?: { imported?: number } }) => {
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
    </div>
  );
}
