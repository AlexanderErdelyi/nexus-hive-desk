'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle, BookOpen, Bot, Bug, CheckCircle2, CheckSquare, ChevronRight, ExternalLink,
  Filter, Loader2, Plus, RefreshCw, Search, Sparkles, Star, X, Zap,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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

interface ChatMessage {
  role: 'user' | 'agent' | 'log';
  content: string;
  timestamp: Date;
}

interface GeneratedWorkItem {
  title?: string;
  description?: string;
  acceptanceCriteria?: string;
  type?: string;
  priority?: number | string;
  tags?: string;
  areaPath?: string;
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

function markdownToHtml(content: string) {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    areaPath: '',
  });
  const [prompt, setPrompt] = useState('');
  const [aiMode, setAiMode] = useState<'direct' | 'agent'>('direct');
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiGenerated, setAiGenerated] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [descriptionTab, setDescriptionTab] = useState<'edit' | 'preview'>('edit');
  const [acceptanceTab, setAcceptanceTab] = useState<'edit' | 'preview'>('edit');
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selectedAgentId && agents[0]?.id) setSelectedAgentId(agents[0].id);
  }, [agents, selectedAgentId]);

  useEffect(() => {
    if (!form.type && defaultType) {
      setForm((prev) => ({ ...prev, type: defaultType }));
    }
  }, [defaultType, form.type]);

  useEffect(() => {
    if (!chatRef.current) return;
    chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [chatMessages]);

  const createMutation = useMutation({
    mutationFn: () => api.post(`/api/projects/${projectId}/work-items`, form),
    onSuccess: () => {
      toast.success('Work item created in Azure DevOps ✔');
      onSuccess();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId);
  const isc = 'w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-indigo-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-gray-700 dark:bg-gray-800/60 dark:text-white dark:placeholder-gray-500 dark:focus:border-indigo-500 dark:focus:bg-gray-800 dark:focus:ring-indigo-900/40';
  const lastLogIndex = chatMessages.reduce((last, message, index) => (message.role === 'log' ? index : last), -1);

  function addChatMessage(role: ChatMessage['role'], content: string) {
    setChatMessages((prev) => [...prev, { role, content, timestamp: new Date() }]);
  }

  function applyGenerated(data: GeneratedWorkItem) {
    const parsedPriority = typeof data.priority === 'number'
      ? data.priority
      : typeof data.priority === 'string' && !Number.isNaN(Number(data.priority))
        ? Number(data.priority)
        : undefined;

    const nextTitle = data.title ? String(data.title) : '';

    setForm((prev) => ({
      ...prev,
      title: nextTitle || prev.title,
      description: data.description !== undefined ? String(data.description) : prev.description,
      acceptanceCriteria: data.acceptanceCriteria !== undefined ? String(data.acceptanceCriteria) : prev.acceptanceCriteria,
      type: data.type ? String(data.type) : prev.type,
      priority: parsedPriority ?? prev.priority,
      tags: data.tags !== undefined ? String(data.tags) : prev.tags,
      areaPath: data.areaPath !== undefined ? String(data.areaPath) : prev.areaPath,
    }));

    setAiGenerated(true);
    addChatMessage('agent', nextTitle
      ? `Draft ready: **${nextTitle}**. Review the generated fields below and adjust anything you need.`
      : 'I generated a draft work item. Review the fields below and adjust anything you need.');
    toast.success('Fields pre-filled by AI — review and adjust ✨');
  }

  async function generateStreaming(agentId: string, description: string) {
    const token = localStorage.getItem('nexus_auth_token');
    const response = await fetch(`/api/projects/${projectId}/work-items/generate-stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ agentId, description, workItemType: form.type }),
    });

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => response.statusText);
      throw new Error(text || 'Streaming request failed');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        let eventType = 'message';
        let data = '';

        for (const line of part.split('\n')) {
          if (line.startsWith('event: ')) eventType = line.slice(7).trim();
          if (line.startsWith('data: ')) data += line.slice(6).trim();
        }

        if (!data) continue;
        const parsed = JSON.parse(data) as GeneratedWorkItem & { message?: string };

        if (eventType === 'log' && parsed.message) addChatMessage('log', parsed.message);
        if (eventType === 'result') applyGenerated(parsed);
        if (eventType === 'error') throw new Error(parsed.message ?? 'Streaming generation failed');
        if (eventType === 'done') return;
      }
    }
  }

  async function generateDirect(description: string) {
    addChatMessage('log', 'Analyzing request...');
    await sleep(500);
    addChatMessage('log', 'Generating work item content...');
    await sleep(500);

    const res = await api.post<{ data: GeneratedWorkItem }>('/api/ai/generate', {
      type: 'work-item',
      description,
      workItemType: form.type,
    });

    applyGenerated(res.data);
  }

  async function handleGenerate() {
    const description = prompt.trim();
    if (!description) {
      toast.error('Describe what you want to create');
      return;
    }

    if (aiMode === 'agent' && !selectedAgentId) {
      toast.error('Select an agent first');
      return;
    }

    addChatMessage('user', description);
    setPrompt('');
    setAiLoading(true);

    try {
      if (aiMode === 'agent') {
        await generateStreaming(selectedAgentId, description);
      } else {
        await generateDirect(description);
      }
    } catch (error) {
      const message = getErrorMessage(error);
      addChatMessage('log', `Generation failed: ${message}`);
      toast.error(message);
    } finally {
      setAiLoading(false);
    }
  }

  const previewBoxClassName = 'min-h-[9rem] rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200';

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-gray-900 dark:text-white">New Work Item</h3>
          <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-600">Create directly in Azure DevOps</p>
        </div>
        <button onClick={onClose} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800">
          <X size={15} />
        </button>
      </div>

      <div className="rounded-2xl border border-indigo-200 bg-gradient-to-br from-indigo-50/90 via-white to-violet-50/90 p-4 shadow-sm dark:border-indigo-900/60 dark:from-indigo-950/40 dark:via-gray-950 dark:to-violet-950/30">
        <div className="rounded-2xl border border-indigo-200/80 bg-white/90 p-4 shadow-inner dark:border-indigo-900/70 dark:bg-gray-950/80">
          <div className="mb-4 flex items-start gap-3">
            <div className="rounded-xl bg-indigo-100 p-2 text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-300">
              <Sparkles size={18} />
            </div>
            <div className="flex-1">
              <h4 className="text-sm font-semibold text-gray-900 dark:text-white">Describe what you want to create</h4>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Use direct AI for quick drafts or an agent for step-by-step generation with skills and project context.</p>
            </div>
          </div>

          {agents.length > 0 && (
            <div className="mb-4 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex rounded-xl border border-indigo-200 bg-indigo-50 p-1 text-xs dark:border-indigo-900/70 dark:bg-indigo-950/50">
                  <button
                    type="button"
                    onClick={() => setAiMode('direct')}
                    className={`rounded-lg px-3 py-1.5 font-medium transition ${aiMode === 'direct' ? 'bg-indigo-600 text-white shadow-sm' : 'text-indigo-700 hover:bg-white dark:text-indigo-300 dark:hover:bg-gray-900'}`}
                  >
                    Direct AI
                  </button>
                  <button
                    type="button"
                    onClick={() => setAiMode('agent')}
                    className={`rounded-lg px-3 py-1.5 font-medium transition ${aiMode === 'agent' ? 'bg-indigo-600 text-white shadow-sm' : 'text-indigo-700 hover:bg-white dark:text-indigo-300 dark:hover:bg-gray-900'}`}
                  >
                    Agent
                  </button>
                </div>
                {aiMode === 'agent' && (
                  <select
                    value={selectedAgentId}
                    onChange={(e) => setSelectedAgentId(e.target.value)}
                    className="min-w-[13rem] rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:focus:ring-indigo-900/40"
                  >
                    <option value="">Select an agent…</option>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>{agent.name}</option>
                    ))}
                  </select>
                )}
              </div>

              {aiMode === 'agent' && selectedAgent && (
                <div className="rounded-xl border border-indigo-100 bg-indigo-50/80 p-3 text-xs text-indigo-900 dark:border-indigo-900/60 dark:bg-indigo-950/40 dark:text-indigo-100">
                  <div className="flex items-center gap-2 font-medium">
                    <Bot size={13} /> {selectedAgent.name}
                  </div>
                  {selectedAgent.description && (
                    <p className="mt-1 text-indigo-700 dark:text-indigo-200/80">{selectedAgent.description}</p>
                  )}
                  <p className="mt-2 text-indigo-700 dark:text-indigo-200/80">
                    Skills: {selectedAgent.skills.length > 0 ? selectedAgent.skills.map((entry) => entry.skill.name).join(', ') : 'No skills attached'}
                  </p>
                </div>
              )}
            </div>
          )}

          <div className="rounded-2xl border border-gray-200 bg-gray-50/80 p-3 dark:border-gray-800 dark:bg-gray-900/60">
            <div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-gray-400 dark:text-gray-500">Message history</div>
            <div ref={chatRef} className="max-h-72 space-y-3 overflow-y-auto pr-1">
              {chatMessages.length === 0 ? (
                <div className="rounded-xl border border-dashed border-gray-200 bg-white/80 px-4 py-6 text-sm text-gray-400 dark:border-gray-800 dark:bg-gray-950/40 dark:text-gray-500">
                  Ask for a bug, task, user story, or feature. The agent will show each step as it works.
                </div>
              ) : chatMessages.map((message, index) => {
                if (message.role === 'log') {
                  const pending = aiLoading && index === lastLogIndex;
                  return (
                    <div key={`${message.timestamp.toISOString()}-${index}`} className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                      {pending ? (
                        <Loader2 size={12} className="shrink-0 animate-spin text-indigo-500" />
                      ) : (
                        <CheckCircle2 size={12} className="shrink-0 text-emerald-500" />
                      )}
                      <span>{message.content}</span>
                    </div>
                  );
                }

                if (message.role === 'user') {
                  return (
                    <div key={`${message.timestamp.toISOString()}-${index}`} className="flex justify-end">
                      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-indigo-600 px-4 py-3 text-sm text-white shadow-sm">
                        {message.content}
                      </div>
                    </div>
                  );
                }

                return (
                  <div key={`${message.timestamp.toISOString()}-${index}`} className="flex items-start gap-3">
                    <div className="mt-1 rounded-xl bg-violet-100 p-2 text-violet-600 dark:bg-violet-900/40 dark:text-violet-300">
                      <Bot size={14} />
                    </div>
                    <div className="max-w-[85%] rounded-2xl rounded-tl-md border border-violet-100 bg-violet-50 px-4 py-3 text-sm text-violet-950 shadow-sm dark:border-violet-900/50 dark:bg-violet-950/40 dark:text-violet-100">
                      <div dangerouslySetInnerHTML={{ __html: markdownToHtml(message.content) }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="mt-4 space-y-3">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void handleGenerate();
              }}
              rows={4}
              className="w-full rounded-xl border border-gray-200 bg-white px-3.5 py-3 text-sm text-gray-900 placeholder-gray-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder-gray-500 dark:focus:border-indigo-500 dark:focus:ring-indigo-900/40"
              placeholder={`What do you want to create? Describe the ${form.type || 'work item'} in plain language… (Ctrl+Enter)`}
            />
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {aiGenerated ? 'Latest draft applied below — keep editing before you create it.' : 'The generated draft stays fully editable.'}
              </div>
              <button
                type="button"
                onClick={handleGenerate}
                disabled={aiLoading || !prompt.trim()}
                className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {aiLoading ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
                {aiLoading ? 'Generating…' : 'Generate'}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between border-b border-gray-100 pb-2 dark:border-gray-800">
          <h4 className="text-sm font-semibold text-gray-900 dark:text-white">Generated Fields</h4>
          {form.areaPath && (
            <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-200">
              Area: {form.areaPath}
            </span>
          )}
        </div>

        <div className="flex gap-3">
          <div className="flex-1">
            <label className="mb-1.5 block text-xs font-semibold text-gray-500 dark:text-gray-400">Type</label>
            <select value={form.type} onChange={(e) => setForm((prev) => ({ ...prev, type: e.target.value }))} className={isc}>
              {(workItemTypes.length > 0 ? workItemTypes : [
                { name: 'User Story' }, { name: 'Bug' }, { name: 'Task' }, { name: 'Feature' }, { name: 'Epic' },
              ]).map((type) => (
                <option key={type.name} value={type.name}>{type.name}</option>
              ))}
            </select>
          </div>
          <div className="w-32">
            <label className="mb-1.5 block text-xs font-semibold text-gray-500 dark:text-gray-400">Priority</label>
            <select value={form.priority} onChange={(e) => setForm((prev) => ({ ...prev, priority: Number(e.target.value) }))} className={isc}>
              <option value={1}>Critical</option>
              <option value={2}>High</option>
              <option value={3}>Medium</option>
              <option value={4}>Low</option>
            </select>
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-semibold text-gray-500 dark:text-gray-400">Title <span className="text-red-400">*</span></label>
          <input
            value={form.title}
            onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
            className={isc}
            placeholder="Short, actionable title"
          />
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <label className="text-xs font-semibold text-gray-500 dark:text-gray-400">Description</label>
            <div className="inline-flex rounded-lg border border-gray-200 bg-white p-1 text-xs dark:border-gray-700 dark:bg-gray-900">
              <button
                type="button"
                onClick={() => setDescriptionTab('edit')}
                className={`rounded-md px-2.5 py-1 font-medium ${descriptionTab === 'edit' ? 'bg-indigo-600 text-white' : 'text-gray-500 dark:text-gray-400'}`}
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => setDescriptionTab('preview')}
                className={`rounded-md px-2.5 py-1 font-medium ${descriptionTab === 'preview' ? 'bg-indigo-600 text-white' : 'text-gray-500 dark:text-gray-400'}`}
              >
                Preview
              </button>
            </div>
          </div>

          {descriptionTab === 'edit' ? (
            <textarea
              value={form.description}
              onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
              rows={6}
              className={isc}
              placeholder="Context, background, technical details…"
            />
          ) : form.description ? (
            <div className={previewBoxClassName}>
              <div
                className="prose prose-sm max-w-none dark:prose-invert"
                dangerouslySetInnerHTML={{ __html: markdownToHtml(form.description) }}
              />
            </div>
          ) : (
            <div className={`${previewBoxClassName} flex items-center text-gray-400 dark:text-gray-500`}>
              Nothing to preview yet.
            </div>
          )}
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <label className="text-xs font-semibold text-gray-500 dark:text-gray-400">Acceptance Criteria</label>
            <div className="inline-flex rounded-lg border border-gray-200 bg-white p-1 text-xs dark:border-gray-700 dark:bg-gray-900">
              <button
                type="button"
                onClick={() => setAcceptanceTab('edit')}
                className={`rounded-md px-2.5 py-1 font-medium ${acceptanceTab === 'edit' ? 'bg-indigo-600 text-white' : 'text-gray-500 dark:text-gray-400'}`}
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => setAcceptanceTab('preview')}
                className={`rounded-md px-2.5 py-1 font-medium ${acceptanceTab === 'preview' ? 'bg-indigo-600 text-white' : 'text-gray-500 dark:text-gray-400'}`}
              >
                Preview
              </button>
            </div>
          </div>

          {acceptanceTab === 'edit' ? (
            <textarea
              value={form.acceptanceCriteria}
              onChange={(e) => setForm((prev) => ({ ...prev, acceptanceCriteria: e.target.value }))}
              rows={6}
              className={isc}
              placeholder={['user story', 'feature'].includes(form.type.toLowerCase()) ? 'Given / When / Then…' : 'Definition of done, repro steps, or validation notes…'}
            />
          ) : form.acceptanceCriteria ? (
            <div className={previewBoxClassName}>
              <div
                className="prose prose-sm max-w-none dark:prose-invert"
                dangerouslySetInnerHTML={{ __html: markdownToHtml(form.acceptanceCriteria) }}
              />
            </div>
          ) : (
            <div className={`${previewBoxClassName} flex items-center text-gray-400 dark:text-gray-500`}>
              Nothing to preview yet.
            </div>
          )}
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-semibold text-gray-500 dark:text-gray-400">Tags <span className="font-normal text-gray-400">(semicolon-separated)</span></label>
          <input
            value={form.tags}
            onChange={(e) => setForm((prev) => ({ ...prev, tags: e.target.value }))}
            className={isc}
            placeholder="BC; translation; sprint-12"
          />
        </div>
      </div>

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
