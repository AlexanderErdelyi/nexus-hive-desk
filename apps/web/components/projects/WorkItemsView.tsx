'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle, BookOpen, Bot, Bug, CheckCircle2, CheckSquare, ChevronDown, ChevronRight, ExternalLink,
  Filter, Loader2, Plus, RefreshCw, Search, Sparkles, Star, X, Zap,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  mcpConnections?: Array<{
    mcpConnection: {
      id: string;
      name: string;
      type: string;
    };
  }>;
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
  technicalSpec?: string;
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
  const [technicalSpec, setTechnicalSpec] = useState('');
  const [technicalSpecOpen, setTechnicalSpecOpen] = useState(false);
  const [recordings, setRecordings] = useState<Array<{ id: string; title?: string; processedAt?: string; duration?: number }>>([]);
  const [selectedRecordingId, setSelectedRecordingId] = useState('');
  const [recordingsLoading, setRecordingsLoading] = useState(false);
  const [recordingsFolder, setRecordingsFolder] = useState('');
  const [recordingsMcpId, setRecordingsMcpId] = useState('');
  const [portalReady, setPortalReady] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);

  const technicalSpecSeparator = '\n\n---\n**Technical Spec:**\n';
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId);

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

  useEffect(() => {
    if (!selectedAgent) return;
    const teamsMcp = selectedAgent.mcpConnections?.find((m) => m.mcpConnection.type === 'teams_recorder');
    if (!teamsMcp) {
      setRecordings([]);
      setSelectedRecordingId('');
      setRecordingsMcpId('');
      return;
    }

    setRecordingsMcpId(teamsMcp.mcpConnection.id);
    setRecordingsLoading(true);
    setSelectedRecordingId('');
    api.get(`/api/mcp-connections/${teamsMcp.mcpConnection.id}/recordings`)
      .then((res: any) => setRecordings(Array.isArray(res?.data) ? res.data : []))
      .catch(() => setRecordings([]))
      .finally(() => setRecordingsLoading(false));
  }, [selectedAgent]);

  function scanRecordingsFolder() {
    if (!recordingsMcpId || !recordingsFolder.trim()) return;
    setRecordingsLoading(true);
    // Save folder to MCP connection capabilities, then refresh
    api.patch(`/api/mcp-connections/${recordingsMcpId}`, {
      capabilities: JSON.stringify({ recordingsFolder: recordingsFolder.trim() }),
    })
      .then(() => api.get(`/api/mcp-connections/${recordingsMcpId}/recordings`))
      .then((res: any) => setRecordings(Array.isArray(res?.data) ? res.data : []))
      .catch(() => {})
      .finally(() => setRecordingsLoading(false));
  }

  useEffect(() => {
    setPortalReady(true);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
      setPortalReady(false);
    };
  }, [onClose]);

  function stripTechnicalSpecSection(value: string) {
    const markerIndex = value.indexOf(technicalSpecSeparator);
    return markerIndex === -1 ? value : value.slice(0, markerIndex);
  }

  function mergeDescriptionWithTechnicalSpec(value: string, spec: string) {
    const baseDescription = stripTechnicalSpecSection(value).trimEnd();
    const trimmedSpec = spec.trim();
    if (!trimmedSpec) return baseDescription;
    return baseDescription
      ? `${baseDescription}${technicalSpecSeparator}${trimmedSpec}`
      : `**Technical Spec:**\n${trimmedSpec}`;
  }

  const createMutation = useMutation({
    mutationFn: () => api.post(`/api/projects/${projectId}/work-items`, {
      ...form,
      description: mergeDescriptionWithTechnicalSpec(form.description, technicalSpec),
    }),
    onSuccess: () => {
      toast.success('Work item created in Azure DevOps ✔');
      onSuccess();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

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
    const nextTechnicalSpec = data.technicalSpec ? String(data.technicalSpec).trim() : '';

    setForm((prev) => {
      const nextDescription = data.description !== undefined
        ? mergeDescriptionWithTechnicalSpec(String(data.description), nextTechnicalSpec)
        : nextTechnicalSpec
          ? mergeDescriptionWithTechnicalSpec(prev.description, nextTechnicalSpec)
          : prev.description;

      return {
        ...prev,
        title: nextTitle || prev.title,
        description: nextDescription,
        acceptanceCriteria: data.acceptanceCriteria !== undefined ? String(data.acceptanceCriteria) : prev.acceptanceCriteria,
        type: data.type ? String(data.type) : prev.type,
        priority: parsedPriority ?? prev.priority,
        tags: data.tags !== undefined ? String(data.tags) : prev.tags,
        areaPath: data.areaPath !== undefined ? String(data.areaPath) : prev.areaPath,
      };
    });

    setTechnicalSpec(nextTechnicalSpec);
    setTechnicalSpecOpen(Boolean(nextTechnicalSpec));
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
      body: JSON.stringify({ agentId, description, workItemType: form.type, recordingId: selectedRecordingId || undefined, includeRepoContext: true }),
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

  if (!portalReady) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/70 px-4 py-6 backdrop-blur-sm" onClick={onClose}>
      <div className="mx-auto flex h-full max-w-6xl items-center justify-center">
        <div
          className="relative flex h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-3xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-950"
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={onClose}
            className="absolute right-5 top-5 z-10 rounded-full border border-gray-200 bg-white/90 p-2 text-gray-500 shadow-sm transition hover:text-gray-700 dark:border-gray-700 dark:bg-gray-900/90 dark:text-gray-400 dark:hover:text-white"
            aria-label="Close create work item modal"
          >
            <X size={16} />
          </button>

          <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <div className="flex min-h-0 flex-col border-b border-gray-200 bg-gradient-to-br from-violet-950 via-indigo-950 to-slate-950 text-white lg:border-b-0 lg:border-r lg:border-r-violet-900/70">
              <div className="border-b border-white/10 px-6 py-6">
                <div className="flex items-start gap-3">
                  <div className="rounded-2xl bg-white/10 p-3 text-violet-200">
                    <Sparkles size={20} />
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold text-white">Generate with AI</h2>
                    <p className="mt-1 text-sm text-violet-100/75">Draft a work item with direct AI or an agent using project and repository context.</p>
                  </div>
                </div>

                <div className="mt-5 space-y-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="inline-flex rounded-xl border border-white/10 bg-white/5 p-1 text-xs">
                      <button
                        type="button"
                        onClick={() => setAiMode('direct')}
                        className={`rounded-lg px-3 py-1.5 font-medium transition ${aiMode === 'direct' ? 'bg-violet-500 text-white shadow-sm' : 'text-violet-100/80 hover:bg-white/10'}`}
                      >
                        Direct AI
                      </button>
                      <button
                        type="button"
                        onClick={() => setAiMode('agent')}
                        className={`rounded-lg px-3 py-1.5 font-medium transition ${aiMode === 'agent' ? 'bg-violet-500 text-white shadow-sm' : 'text-violet-100/80 hover:bg-white/10'}`}
                      >
                        Agent
                      </button>
                    </div>
                    {aiMode === 'agent' && (
                      <select
                        value={selectedAgentId}
                        onChange={(event) => setSelectedAgentId(event.target.value)}
                        className="min-w-[13rem] rounded-xl border border-white/10 bg-slate-900/80 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-violet-400"
                      >
                        <option value="">Select an agent…</option>
                        {agents.map((agent) => (
                          <option key={agent.id} value={agent.id}>{agent.name}</option>
                        ))}
                      </select>
                    )}
                  </div>

                  {aiMode === 'agent' && selectedAgent && (
                    <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-violet-50">
                      <div className="flex items-center gap-2 font-medium text-white">
                        <Bot size={15} />
                        <span>{selectedAgent.name}</span>
                      </div>
                      {selectedAgent.description && (
                        <p className="mt-2 text-sm text-violet-100/80">{selectedAgent.description}</p>
                      )}
                      <div className="mt-3 space-y-2">
                        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-200/70">Skills</div>
                        <div className="flex flex-wrap gap-2">
                          {selectedAgent.skills.length > 0 ? selectedAgent.skills.map((entry) => (
                            <span key={entry.skill.name} className="rounded-full border border-violet-400/30 bg-violet-500/10 px-2.5 py-1 text-xs text-violet-100">
                              {entry.skill.name}
                            </span>
                          )) : (
                            <span className="text-xs text-violet-100/70">No skills attached</span>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex min-h-0 flex-1 flex-col px-6 py-6">
                {(recordingsLoading || recordings.length > 0 || recordingsMcpId) && (
                  <div className="mb-4 rounded-xl border border-gray-200 dark:border-gray-700 p-3 bg-gray-50 dark:bg-gray-800/50">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">📹 Teams Recordings</span>
                      {recordingsLoading && <Loader2 size={12} className="animate-spin text-gray-400" />}
                    </div>
                    {/* Folder input */}
                    <div className="flex gap-1.5 mb-2">
                      <input
                        className="flex-1 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 px-2.5 py-1.5 text-xs text-gray-700 dark:text-gray-300 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                        value={recordingsFolder}
                        onChange={(e) => setRecordingsFolder(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') scanRecordingsFolder(); }}
                        placeholder="C:/Temp/nexus (folder with .mp4 / .vtt)"
                      />
                      <button
                        onClick={scanRecordingsFolder}
                        disabled={!recordingsFolder.trim() || recordingsLoading}
                        className="rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
                      >
                        Scan
                      </button>
                    </div>
                    {recordings.length === 0 && !recordingsLoading && (
                      <p className="text-xs text-gray-400">No recordings in cache yet — enter a folder path and click Scan</p>
                    )}
                    {recordings.map((rec) => (
                      <button
                        key={rec.id}
                        onClick={() => setSelectedRecordingId((prev) => prev === rec.id ? '' : rec.id)}
                        className={`w-full text-left px-2.5 py-2 rounded-lg text-xs mb-1 transition-colors ${
                          selectedRecordingId === rec.id
                            ? 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 font-medium'
                            : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400'
                        }`}
                      >
                        <div className="font-medium truncate">{rec.title ?? rec.id}</div>
                        {rec.processedAt && (
                          <div className="text-gray-400 text-[10px]">{new Date(rec.processedAt).toLocaleString()}</div>
                        )}
                      </button>
                    ))}
                    {selectedRecordingId && (
                      <p className="text-[11px] text-indigo-500 mt-1">✓ Recording attached — agent will use meeting context</p>
                    )}
                  </div>
                )}
                <div className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-violet-200/70">Chat history</div>
                <div ref={chatRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
                  {chatMessages.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-white/15 bg-white/5 px-4 py-6 text-sm text-violet-100/70">
                      Ask for a bug, task, user story, feature, or a technical specification. Streaming steps will appear here.
                    </div>
                  ) : chatMessages.map((message, index) => {
                    if (message.role === 'log') {
                      const pending = aiLoading && index === lastLogIndex;
                      return (
                        <div key={`${message.timestamp.toISOString()}-${index}`} className="flex items-center gap-2 text-xs font-mono text-slate-300">
                          {pending ? (
                            <Loader2 size={12} className="shrink-0 animate-spin text-violet-300" />
                          ) : (
                            <CheckCircle2 size={12} className="shrink-0 text-emerald-400" />
                          )}
                          <span>{message.content}</span>
                        </div>
                      );
                    }

                    if (message.role === 'user') {
                      return (
                        <div key={`${message.timestamp.toISOString()}-${index}`} className="flex justify-end">
                          <div className="max-w-[88%] rounded-2xl rounded-br-md bg-violet-600 px-4 py-3 text-sm text-white shadow-lg shadow-violet-950/30">
                            {message.content}
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div key={`${message.timestamp.toISOString()}-${index}`} className="flex items-start gap-3">
                        <div className="mt-1 rounded-xl bg-white/10 p-2 text-violet-200">
                          <Bot size={14} />
                        </div>
                        <div className="max-w-[88%] rounded-2xl rounded-tl-md border border-white/10 bg-slate-900/90 px-4 py-3 text-sm text-slate-100 shadow-lg shadow-black/20">
                          <div dangerouslySetInnerHTML={{ __html: markdownToHtml(message.content) }} />
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="mt-5 border-t border-white/10 pt-4">
                  <textarea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void handleGenerate();
                    }}
                    rows={5}
                    className="w-full rounded-2xl border border-white/10 bg-slate-950/80 px-4 py-3 text-sm text-white placeholder:text-slate-400 focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
                    placeholder={`What do you want to create? Describe the ${form.type || 'work item'} in plain language… (Ctrl+Enter)`}
                  />
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <div className="text-xs text-violet-100/70">
                      {aiGenerated ? 'Latest draft applied on the right — review before creating it.' : 'Generated drafts stay fully editable.'}
                    </div>
                    <button
                      type="button"
                      onClick={handleGenerate}
                      disabled={aiLoading || !prompt.trim()}
                      className="inline-flex items-center gap-2 rounded-xl bg-violet-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-violet-950/30 transition hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {aiLoading ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
                      {aiLoading ? 'Sending…' : 'Send'}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex min-h-0 flex-col bg-white dark:bg-gray-950">
              <div className="border-b border-gray-200 px-6 py-6 dark:border-gray-800">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Work Item Details</h2>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Review the generated draft and create it in Azure DevOps.</p>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
                <div className="space-y-5">
                  <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_9rem]">
                    <div>
                      <label className="mb-1.5 block text-xs font-semibold text-gray-500 dark:text-gray-400">Type</label>
                      <select value={form.type} onChange={(event) => setForm((prev) => ({ ...prev, type: event.target.value }))} className={isc}>
                        {(workItemTypes.length > 0 ? workItemTypes : [
                          { name: 'User Story' }, { name: 'Bug' }, { name: 'Task' }, { name: 'Feature' }, { name: 'Epic' },
                        ]).map((type) => (
                          <option key={type.name} value={type.name}>{type.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="mb-1.5 block text-xs font-semibold text-gray-500 dark:text-gray-400">Priority</label>
                      <select value={form.priority} onChange={(event) => setForm((prev) => ({ ...prev, priority: Number(event.target.value) }))} className={isc}>
                        <option value={1}>1 - Critical</option>
                        <option value={2}>2 - High</option>
                        <option value={3}>3 - Medium</option>
                        <option value={4}>4 - Low</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-xs font-semibold text-gray-500 dark:text-gray-400">Title <span className="text-red-400">*</span></label>
                    <input
                      value={form.title}
                      onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))}
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
                        onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
                        rows={8}
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
                        onChange={(event) => setForm((prev) => ({ ...prev, acceptanceCriteria: event.target.value }))}
                        rows={7}
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

                  <div className="rounded-2xl border border-gray-200 bg-gray-50/70 dark:border-gray-800 dark:bg-gray-900/40">
                    <button
                      type="button"
                      onClick={() => setTechnicalSpecOpen((prev) => !prev)}
                      className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                    >
                      <div>
                        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">Technical Spec</div>
                        <div className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                          {technicalSpec ? 'Repository-based technical details included in the generated draft.' : 'No technical spec generated yet.'}
                        </div>
                      </div>
                      <ChevronDown size={16} className={`shrink-0 text-gray-400 transition-transform ${technicalSpecOpen ? 'rotate-180' : ''}`} />
                    </button>
                    {technicalSpecOpen && (
                      <div className="border-t border-gray-200 px-4 pb-4 pt-3 dark:border-gray-800">
                        <textarea
                          value={technicalSpec}
                          readOnly
                          rows={8}
                          className={`${isc} resize-y bg-white dark:bg-gray-950`}
                          placeholder="Technical specification details will appear here when requested."
                        />
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="mb-1.5 block text-xs font-semibold text-gray-500 dark:text-gray-400">Tags <span className="font-normal text-gray-400">(semicolon-separated)</span></label>
                    <input
                      value={form.tags}
                      onChange={(event) => setForm((prev) => ({ ...prev, tags: event.target.value }))}
                      className={isc}
                      placeholder="BC; translation; sprint-12"
                    />
                  </div>

                  <div>
                    <label className="mb-1.5 block text-xs font-semibold text-gray-500 dark:text-gray-400">Area Path</label>
                    <input
                      value={form.areaPath}
                      onChange={(event) => setForm((prev) => ({ ...prev, areaPath: event.target.value }))}
                      className={isc}
                      placeholder="Project\Area\Subarea"
                    />
                  </div>
                </div>
              </div>

              <div className="border-t border-gray-200 px-6 py-4 dark:border-gray-800">
                <div className="flex items-center justify-end gap-3">
                  <button
                    onClick={onClose}
                    className="rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-600 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-900"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => createMutation.mutate()}
                    disabled={createMutation.isPending || aiLoading || !form.title.trim()}
                    className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {createMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                    Create in Azure DevOps
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export function WorkItemsView({ projectId, customerId }: { projectId: string; customerId?: string | null }) {
  const qc = useQueryClient();
  const [typeFilter, setTypeFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [search, setSearch] = useState('');
  const [selectedItem, setSelectedItem] = useState<WorkItem | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

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

  const panelOpen = selectedItem !== null;

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
            onClick={() => { setShowCreateModal(true); setSelectedItem(null); }}
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
                onClick={() => { setSelectedItem(wi); setShowCreateModal(false); }}
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
          <button onClick={() => setSelectedItem(null)}
            className="mb-3 flex items-center gap-1 text-xs text-indigo-500 lg:hidden">
            ← Back to list
          </button>
          <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-900 overflow-y-auto max-h-[calc(100vh-180px)]">
            {selectedItem ? (
              <WorkItemDetail item={selectedItem} onClose={() => setSelectedItem(null)} />
            ) : null}
          </div>
        </div>
      )}

      {showCreateModal && (
        <WorkItemForm
          projectId={projectId}
          agents={agents}
          workItemTypes={workItemTypes}
          onSuccess={() => {
            setShowCreateModal(false);
            void qc.invalidateQueries({ queryKey: ['work-items', projectId] });
            void refetch();
          }}
          onClose={() => setShowCreateModal(false)}
        />
      )}
    </div>
  );
}
