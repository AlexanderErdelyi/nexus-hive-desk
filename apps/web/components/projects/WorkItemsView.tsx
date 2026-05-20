'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle, BookOpen, Bug, CheckSquare, ChevronRight, ExternalLink,
  Filter, Loader2, Plus, RefreshCw, Search, Sparkles, Star, X, Zap, Info,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Request failed';
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface WorkItem {
  id: number;
  title: string;
  type: string;
  state: string;
  priority?: number;
  assignedTo?: string | null;
  description?: string | null;
  acceptanceCriteria?: string | null;
  tags?: string | null;
  areaPath?: string | null;
  iterationPath?: string | null;
  createdDate?: string;
  changedDate?: string;
  url?: string;
}

interface Agent {
  id: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  skills: Array<{ skill: { name: string; type: string; promptTemplate?: string } }>;
}

interface WorkItemType {
  name: string;
  color?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function typeIcon(type: string, size = 14) {
  switch (type.toLowerCase()) {
    case 'bug': return <Bug size={size} className="text-red-500" />;
    case 'user story': return <BookOpen size={size} className="text-blue-500" />;
    case 'task': return <CheckSquare size={size} className="text-green-500" />;
    case 'feature': return <Star size={size} className="text-purple-500" />;
    case 'epic': return <Zap size={size} className="text-orange-500" />;
    default: return <AlertCircle size={size} className="text-gray-400" />;
  }
}

function stateChip(state: string) {
  const s = state.toLowerCase();
  let cls = 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';
  if (s.includes('done') || s.includes('closed') || s.includes('resolved'))
    cls = 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400';
  else if (s.includes('progress') || s.includes('active') || s.includes('doing'))
    cls = 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400';
  else if (s.includes('review') || s.includes('test'))
    cls = 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400';
  return <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}>{state}</span>;
}

function priorityBadge(p?: number) {
  const map: Record<number, { label: string; cls: string }> = {
    1: { label: '⚡ Critical', cls: 'text-red-500' },
    2: { label: '🔴 High', cls: 'text-orange-500' },
    3: { label: '🟡 Medium', cls: 'text-yellow-600 dark:text-yellow-400' },
    4: { label: '🟢 Low', cls: 'text-gray-400' },
  };
  const entry = p ? map[p] : null;
  if (!entry) return null;
  return <span className={`text-xs font-medium ${entry.cls}`}>{entry.label}</span>;
}

// ── Detail side panel ─────────────────────────────────────────────────────────

function WorkItemDetail({ item, onClose }: { item: WorkItem; onClose: () => void }) {
  return (
    <div className="flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          {typeIcon(item.type)}
          <span className="font-medium">{item.type}</span>
          <span className="text-gray-300 dark:text-gray-700">·</span>
          <span>#{item.id}</span>
        </div>
        <button onClick={onClose} className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800">
          <X size={15} />
        </button>
      </div>

      <h2 className="text-base font-semibold leading-snug text-gray-900 dark:text-white">{item.title}</h2>

      {/* Meta chips */}
      <div className="flex flex-wrap items-center gap-2">
        {stateChip(item.state)}
        {priorityBadge(item.priority)}
        {item.url && (
          <a href={item.url} target="_blank" rel="noopener noreferrer"
            className="ml-auto flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1 text-xs text-gray-500 hover:border-indigo-300 hover:text-indigo-600 dark:border-gray-700 dark:text-gray-400 dark:hover:text-indigo-400">
            <ExternalLink size={11} /> Open in ADO
          </a>
        )}
      </div>

      {item.assignedTo && (
        <p className="text-xs text-gray-500 dark:text-gray-400">Assigned to: <span className="font-medium text-gray-700 dark:text-gray-300">{item.assignedTo}</span></p>
      )}

      {/* Description */}
      {item.description && (
        <section>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-600">Description</h4>
          <div className="prose prose-sm max-w-none rounded-lg bg-gray-50 p-3 text-gray-700 dark:bg-gray-800/50 dark:prose-invert dark:text-gray-300"
            dangerouslySetInnerHTML={{ __html: item.description }} />
        </section>
      )}

      {/* Acceptance Criteria */}
      {item.acceptanceCriteria && (
        <section>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-600">Acceptance Criteria</h4>
          <div className="prose prose-sm max-w-none rounded-lg bg-blue-50 p-3 text-gray-700 dark:bg-blue-900/10 dark:prose-invert dark:text-gray-300"
            dangerouslySetInnerHTML={{ __html: item.acceptanceCriteria }} />
        </section>
      )}

      {/* Meta info */}
      <div className="border-t border-gray-100 pt-3 dark:border-gray-800">
        {item.iterationPath && (
          <p className="mb-1 text-xs text-gray-400">Sprint: <span className="text-gray-600 dark:text-gray-300">{item.iterationPath.split('\\').pop()}</span></p>
        )}
        {item.tags && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {item.tags.split(';').filter(Boolean).map((tag) => (
              <span key={tag} className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                {tag.trim()}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Create Form ────────────────────────────────────────────────────────────────

function WorkItemForm({
  projectId,
  agents,
  workItemTypes,
  onSuccess,
  onClose,
}: {
  projectId: string;
  agents: Agent[];
  workItemTypes: WorkItemType[];
  onSuccess: () => void;
  onClose: () => void;
}) {
  const defaultType = workItemTypes[0]?.name ?? 'User Story';
  const [form, setForm] = useState({
    type: defaultType,
    title: '',
    description: '',
    acceptanceCriteria: '',
    priority: 2,
    tags: '',
  });
  const [aiDesc, setAiDesc] = useState('');
  const [aiMode, setAiMode] = useState<'direct' | 'agent'>('direct');
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiGenerated, setAiGenerated] = useState(false);

  const createMutation = useMutation({
    mutationFn: () => api.post(`/api/projects/${projectId}/work-items`, form),
    onSuccess: () => {
      toast.success('Work item created in Azure DevOps ✔');
      onSuccess();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  function applyGenerated(data: Record<string, string | number>) {
    setForm((prev) => ({
      ...prev,
      title: String(data.title ?? prev.title),
      description: String(data.description ?? prev.description),
      acceptanceCriteria: String(data.acceptanceCriteria ?? prev.acceptanceCriteria),
      type: data.type ? String(data.type) : prev.type,
      priority: typeof data.priority === 'number' ? data.priority : prev.priority,
      tags: String(data.tags ?? prev.tags),
    }));
    setAiGenerated(true);
    toast.success('Fields pre-filled by AI — review and adjust ✨');
  }

  async function generateWithAI() {
    if (!aiDesc.trim()) { toast.error('Describe what you want to create'); return; }
    setAiLoading(true);
    try {
      if (aiMode === 'direct') {
        const res = await api.post<{ data: Record<string, string | number> }>('/api/ai/generate', {
          type: 'work-item', description: aiDesc, workItemType: form.type,
        });
        applyGenerated(res.data);
      } else {
        if (!selectedAgentId) { toast.error('Select an agent first'); return; }
        const res = await api.post<{ data: Record<string, string | number> }>(
          `/api/projects/${projectId}/work-items/agent-generate`,
          { agentId: selectedAgentId, description: aiDesc, workItemType: form.type }
        );
        applyGenerated(res.data);
        const agent = agents.find((a) => a.id === selectedAgentId);
        toast.success(`Generated via "${agent?.name}" using ${agent?.skills.length ?? 0} skill(s) ✨`);
      }
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setAiLoading(false);
    }
  }

  const selectedAgent = agents.find((a) => a.id === selectedAgentId);
  const isc = 'w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-indigo-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-gray-700 dark:bg-gray-800/60 dark:text-white dark:placeholder-gray-500 dark:focus:border-indigo-500 dark:focus:bg-gray-800 dark:focus:ring-indigo-900/40';

  return (
    <div className="flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-gray-900 dark:text-white">New Work Item</h3>
          <p className="text-xs text-gray-400 dark:text-gray-600 mt-0.5">Create directly in Azure DevOps</p>
        </div>
        <button onClick={onClose} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800">
          <X size={15} />
        </button>
      </div>

      {/* AI Generation box */}
      <div className="rounded-xl border border-indigo-200 bg-gradient-to-br from-indigo-50/80 to-violet-50/80 p-4 dark:border-indigo-800/50 dark:from-indigo-900/20 dark:to-violet-900/20">
        <div className="mb-3 flex items-center gap-2">
          <Sparkles size={15} className="text-indigo-500" />
          <span className="text-sm font-semibold text-indigo-700 dark:text-indigo-300">Generate with AI</span>
          {agents.length > 0 && (
            <div className="ml-auto flex rounded-lg border border-indigo-200 bg-white/60 text-xs dark:border-indigo-800 dark:bg-gray-900/40">
              <button
                onClick={() => setAiMode('direct')}
                className={`rounded-l-lg px-2.5 py-1 font-medium transition-colors ${aiMode === 'direct' ? 'bg-indigo-600 text-white' : 'text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-900/30'}`}
              >
                Direct AI
              </button>
              <button
                onClick={() => setAiMode('agent')}
                className={`flex items-center gap-1 rounded-r-lg px-2.5 py-1 font-medium transition-colors ${aiMode === 'agent' ? 'bg-indigo-600 text-white' : 'text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-900/30'}`}
              >
                <Zap size={10} /> Agent
              </button>
            </div>
          )}
        </div>

        {/* Agent picker */}
        {aiMode === 'agent' && (
          <div className="mb-3">
            <select
              value={selectedAgentId}
              onChange={(e) => setSelectedAgentId(e.target.value)}
              className="w-full rounded-lg border border-indigo-200 bg-white px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-indigo-800 dark:bg-gray-800 dark:text-gray-200"
            >
              <option value="">Select an agent…</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            {selectedAgent && (
              <div className="mt-2 rounded-lg bg-white/80 p-2.5 text-xs dark:bg-gray-900/50">
                {selectedAgent.description && (
                  <p className="text-gray-500 dark:text-gray-400 mb-1">{selectedAgent.description}</p>
                )}
                {selectedAgent.skills.length > 0 ? (
                  <p className="text-indigo-600 dark:text-indigo-400">
                    Skills: {selectedAgent.skills.map((s) => s.skill.name).join(', ')}
                  </p>
                ) : (
                  <p className="flex items-center gap-1 text-amber-500"><Info size={10} /> No skills attached — will use system prompt only</p>
                )}
              </div>
            )}
          </div>
        )}

        <textarea
          value={aiDesc}
          onChange={(e) => setAiDesc(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void generateWithAI(); }}
          rows={2}
          className="w-full rounded-lg border border-indigo-200 bg-white/80 px-3 py-2 text-sm text-gray-700 placeholder-gray-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-indigo-800 dark:bg-gray-800/60 dark:text-gray-200 dark:placeholder-gray-500"
          placeholder={`Describe the ${form.type} you want to create… (Ctrl+Enter)`}
        />

        <div className="mt-2 flex items-center justify-between">
          {aiGenerated && (
            <span className="text-xs text-emerald-600 dark:text-emerald-400">✔ Fields pre-filled — review below</span>
          )}
          <button
            onClick={generateWithAI}
            disabled={aiLoading || !aiDesc.trim()}
            className="ml-auto flex items-center gap-2 rounded-lg bg-indigo-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {aiLoading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            {aiLoading ? 'Generating…' : 'Generate'}
          </button>
        </div>
      </div>

      {/* Form fields */}
      <div className="flex gap-3">
        <div className="flex-1">
          <label className="mb-1.5 block text-xs font-semibold text-gray-500 dark:text-gray-400">Type</label>
          <select value={form.type} onChange={(e) => setForm((p) => ({ ...p, type: e.target.value }))} className={isc}>
            {(workItemTypes.length > 0 ? workItemTypes : [
              { name: 'User Story' }, { name: 'Bug' }, { name: 'Task' }, { name: 'Feature' }, { name: 'Epic' }
            ]).map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
          </select>
        </div>
        <div className="w-32">
          <label className="mb-1.5 block text-xs font-semibold text-gray-500 dark:text-gray-400">Priority</label>
          <select value={form.priority} onChange={(e) => setForm((p) => ({ ...p, priority: Number(e.target.value) }))} className={isc}>
            <option value={1}>Critical</option>
            <option value={2}>High</option>
            <option value={3}>Medium</option>
            <option value={4}>Low</option>
          </select>
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-semibold text-gray-500 dark:text-gray-400">Title <span className="text-red-400">*</span></label>
        <input value={form.title} onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))} className={isc} placeholder="Short, actionable title" />
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-semibold text-gray-500 dark:text-gray-400">Description</label>
        <textarea value={form.description} onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
          rows={5} className={isc} placeholder="Context, background, technical details…" />
      </div>

      {['user story', 'feature'].includes(form.type.toLowerCase()) && (
        <div>
          <label className="mb-1.5 block text-xs font-semibold text-gray-500 dark:text-gray-400">Acceptance Criteria</label>
          <textarea value={form.acceptanceCriteria} onChange={(e) => setForm((p) => ({ ...p, acceptanceCriteria: e.target.value }))}
            rows={5} className={isc} placeholder="Given / When / Then…" />
        </div>
      )}

      <div>
        <label className="mb-1.5 block text-xs font-semibold text-gray-500 dark:text-gray-400">Tags <span className="text-gray-400 font-normal">(semicolon-separated)</span></label>
        <input value={form.tags} onChange={(e) => setForm((p) => ({ ...p, tags: e.target.value }))} className={isc} placeholder="BC; translation; sprint-12" />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 border-t border-gray-100 pt-3 dark:border-gray-800">
        <button
          onClick={onClose}
          className="rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
        >
          Cancel
        </button>
        <button
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending || !form.title.trim()}
          className="ml-auto flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {createMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          Create Work Item
        </button>
      </div>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export function WorkItemsView({ projectId, customerId }: { projectId: string; customerId?: string | null }) {
  const qc = useQueryClient();
  const [typeFilter, setTypeFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [search, setSearch] = useState('');
  const [selectedItem, setSelectedItem] = useState<WorkItem | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['work-items', projectId, typeFilter, stateFilter],
    queryFn: () => {
      const params = new URLSearchParams({ top: '100' });
      if (typeFilter) params.set('type', typeFilter);
      if (stateFilter) params.set('state', stateFilter);
      return api.get<{ data: WorkItem[]; meta: { total: number } }>(
        `/api/projects/${projectId}/work-items?${params}`
      );
    },
  });

  const { data: typesData } = useQuery({
    queryKey: ['work-item-types', projectId],
    queryFn: () => api.get<{ data: WorkItemType[] }>(`/api/projects/${projectId}/work-item-types`),
    staleTime: 10 * 60 * 1000,
  });

  const { data: agentsData } = useQuery({
    queryKey: ['agents-for-wi'],
    queryFn: () => api.get<{ data: Agent[] }>('/api/agents'),
    staleTime: 60 * 1000,
  });

  const items = data?.data ?? [];
  const agents = agentsData?.data ?? [];
  const workItemTypes = typesData?.data ?? [];
  const uniqueStates = [...new Set(items.map((wi) => wi.state))].sort();
  const uniqueTypes = [...new Set(items.map((wi) => wi.type))].sort();

  const filtered = items.filter((wi) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return wi.title.toLowerCase().includes(q) || String(wi.id).includes(q) || (wi.tags?.toLowerCase().includes(q) ?? false);
  });

  const panelOpen = selectedItem !== null || showCreate;

  return (
    <div className="flex gap-5">
      {/* ── List column ── */}
      <div className={`min-w-0 flex-1 ${panelOpen ? 'hidden lg:block' : ''}`}>
        {/* Toolbar */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search title, ID or tag…"
              className="w-full rounded-xl border border-gray-200 bg-white py-2 pl-9 pr-3 text-sm placeholder-gray-400 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder-gray-600 dark:focus:ring-indigo-900/40"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <Filter size={13} className="shrink-0 text-gray-400" />
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}
              className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-white">
              <option value="">All types</option>
              {uniqueTypes.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}
              className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-white">
              <option value="">All states</option>
              {uniqueStates.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <button onClick={() => void refetch()} disabled={isFetching}
            className="rounded-xl border border-gray-200 bg-white p-2 text-gray-500 hover:bg-gray-50 disabled:opacity-40 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400 dark:hover:bg-gray-800">
            <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => { setShowCreate(true); setSelectedItem(null); }}
            className="flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 active:bg-indigo-800"
          >
            <Plus size={14} /> New Work Item
          </button>
        </div>

        {/* Items list */}
        {isLoading ? (
          <div className="flex items-center justify-center py-24 text-gray-400">
            <Loader2 size={28} className="animate-spin" />
          </div>
        ) : error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-8 text-center dark:border-red-900/50 dark:bg-red-900/10">
            <AlertCircle size={24} className="mx-auto mb-3 text-red-500" />
            <p className="text-sm font-medium text-red-700 dark:text-red-400">Could not load work items</p>
            <p className="mt-1 text-xs text-red-500 dark:text-red-500">{getErrorMessage(error)}</p>
            <p className="mt-2 text-xs text-gray-500">Make sure the ADO connection and project are configured in Setup.</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-2xl border-2 border-dashed border-gray-200 py-16 text-center dark:border-gray-800">
            <p className="text-gray-400 dark:text-gray-600">
              {items.length === 0 ? 'No work items found. Create your first one!' : 'No items match the current filter.'}
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {filtered.map((wi) => (
              <button
                key={wi.id}
                onClick={() => { setSelectedItem(wi); setShowCreate(false); }}
                className={`group w-full rounded-xl border p-3.5 text-left transition-all hover:shadow-sm
                  ${selectedItem?.id === wi.id
                    ? 'border-indigo-300 bg-indigo-50 shadow-sm dark:border-indigo-700 dark:bg-indigo-900/20'
                    : 'border-gray-200 bg-white hover:border-gray-300 dark:border-gray-800 dark:bg-gray-900 dark:hover:border-gray-700'
                  }`}
              >
                <div className="flex items-center gap-2.5">
                  <span className="shrink-0">{typeIcon(wi.type)}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-gray-900 dark:text-white">{wi.title}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span className="text-xs text-gray-400">#{wi.id}</span>
                      {stateChip(wi.state)}
                      {priorityBadge(wi.priority)}
                      {wi.assignedTo && (
                        <span className="text-xs text-gray-400 dark:text-gray-600">→ {wi.assignedTo}</span>
                      )}
                    </div>
                  </div>
                  <ChevronRight size={14} className="shrink-0 text-gray-300 transition group-hover:translate-x-0.5 group-hover:text-indigo-400 dark:text-gray-700" />
                </div>
              </button>
            ))}
          </div>
        )}

        {filtered.length > 0 && (
          <p className="mt-3 text-xs text-gray-400 dark:text-gray-600">
            {filtered.length}{filtered.length < items.length ? ` / ${items.length}` : ''} work item{items.length !== 1 ? 's' : ''}
            {(typeFilter || stateFilter) ? ' (filtered)' : ''}
          </p>
        )}
      </div>

      {/* ── Right panel ── */}
      {panelOpen && (
        <div className="w-full shrink-0 lg:w-[26rem]">
          {/* Back button on mobile */}
          <button onClick={() => { setSelectedItem(null); setShowCreate(false); }}
            className="mb-3 flex items-center gap-1 text-xs text-indigo-500 lg:hidden">
            ← Back to list
          </button>
          <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-900 overflow-y-auto max-h-[calc(100vh-180px)]">
            {showCreate ? (
              <WorkItemForm
                projectId={projectId}
                agents={agents}
                workItemTypes={workItemTypes}
                onSuccess={() => {
                  setShowCreate(false);
                  qc.invalidateQueries({ queryKey: ['work-items', projectId] });
                }}
                onClose={() => setShowCreate(false)}
              />
            ) : selectedItem ? (
              <WorkItemDetail item={selectedItem} onClose={() => setSelectedItem(null)} />
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
