'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Wrench, Plug, Plus, Trash2, Play, Zap, Shield, Sparkles, Loader2, RefreshCw, Download, Tag, FlaskConical, Pencil, Upload, ChevronDown, X, BookOpen } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';

// ── Types ──────────────────────────────────────────────────────────────────────

interface Agent {
  id: string;
  name: string;
  description?: string;
  modelProvider: string;
  model?: string;
  systemPrompt?: string;
  triggerType: string;
  tools?: string;       // JSON array string
  argumentHint?: string;
  createdAt: string;
  skills?: Array<{ id: string; skill: Skill }>;
  mcpConnections?: Array<{ id: string; mcpConnection: McpConnection }>;
  _count?: { runs: number };
}

interface Skill {
  id: string;
  name: string;
  description?: string;
  type: 'prompt' | 'code' | 'mcp-tool';
  builtIn: boolean;
  promptTemplate?: string;
  createdAt: string;
}

interface McpConnection {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  authType: string;
  capabilities?: string;
  createdAt: string;
}

type Tab = 'agents' | 'skills' | 'mcp';

// ── Export helper ──────────────────────────────────────────────────────────────

function exportAgentAsInstructions(agent: Agent) {
  let tools: string[] = [];
  try { tools = agent.tools ? JSON.parse(agent.tools) as string[] : []; } catch { tools = []; }

  const frontmatter = [
    '---',
    `description: ${JSON.stringify(agent.description ?? '')}`,
    `name: ${JSON.stringify(agent.name)}`,
    tools.length > 0 ? `tools: [${tools.join(', ')}]` : 'tools: []',
    `model: ${JSON.stringify(agent.model ?? agent.modelProvider)}`,
    agent.argumentHint ? `argument-hint: ${JSON.stringify(agent.argumentHint)}` : null,
    '---',
  ].filter(Boolean).join('\n');

  const content = `${frontmatter}\n\n${agent.systemPrompt ?? ''}`;
  const blob = new Blob([content], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${agent.name.replace(/\s+/g, '-').toLowerCase()}.instructions.md`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Import helper ──────────────────────────────────────────────────────────────

function parseInstructionsMd(content: string): Partial<Agent> | null {
  try {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;
    const fm = fmMatch[1];
    const body = content.slice(fmMatch[0].length).trim();
    const get = (key: string) => { const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm')); return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined; };
    const toolsMatch = fm.match(/^tools:\s*\[([^\]]*)\]/m);
    const tools: string[] = toolsMatch?.[1] ? toolsMatch[1].split(',').map(t => t.trim()).filter(Boolean) : [];
    return {
      name: get('name') ?? 'Imported Agent',
      description: get('description'),
      model: get('model'),
      argumentHint: get('argument-hint'),
      systemPrompt: body,
      tools: JSON.stringify(tools),
      modelProvider: 'openai',
      triggerType: 'manual',
    };
  } catch { return null; }
}

function parseAgentsJson(content: string): Partial<Agent>[] {
  try {
    const parsed = JSON.parse(content) as unknown;
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr.map((a: Record<string, unknown>) => ({
      name: String(a.name ?? 'Imported Agent'),
      description: a.description ? String(a.description) : undefined,
      model: a.model ? String(a.model) : undefined,
      systemPrompt: a.systemPrompt ? String(a.systemPrompt) : undefined,
      argumentHint: a.argumentHint ? String(a.argumentHint) : undefined,
      tools: a.tools ? (typeof a.tools === 'string' ? a.tools : JSON.stringify(a.tools)) : '[]',
      modelProvider: a.modelProvider ? String(a.modelProvider) : 'openai',
      triggerType: a.triggerType ? String(a.triggerType) : 'manual',
    }));
  } catch { return []; }
}

function parseSkillsJson(content: string): Partial<Skill>[] {
  try {
    const parsed = JSON.parse(content) as unknown;
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr.map((s: Record<string, unknown>) => ({
      name: String(s.name ?? 'Imported Skill'),
      description: s.description ? String(s.description) : undefined,
      type: (['prompt', 'code', 'mcp-tool'].includes(String(s.type)) ? String(s.type) : 'prompt') as Skill['type'],
      promptTemplate: s.promptTemplate ? String(s.promptTemplate) : s.content ? String(s.content) : undefined,
    }));
  } catch { return []; }
}

function parseSkillInstructionsMd(content: string): Partial<Skill> | null {
  try {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    const body = fmMatch ? content.slice(fmMatch[0].length).trim() : content.trim();
    const fm = fmMatch?.[1] ?? '';
    const get = (key: string) => { const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm')); return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined; };
    const rawType = get('type') ?? 'prompt';
    return {
      name: get('name') ?? 'Imported Skill',
      description: get('description'),
      type: (['prompt', 'code', 'mcp-tool'].includes(rawType) ? rawType : 'prompt') as Skill['type'],
      promptTemplate: body || undefined,
    };
  } catch { return null; }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Request failed';
}

const inputClass =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white';
const labelClass = 'mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300';
const primaryBtn =
  'rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50';
const secondaryBtn =
  'rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800';
const cardClass =
  'rounded-xl border border-gray-200 bg-white p-5 transition-colors hover:border-indigo-300 dark:border-gray-700 dark:bg-gray-900 dark:hover:border-indigo-500';
const formCardClass =
  'mb-6 rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-900';

// ── AI Generate Panel ──────────────────────────────────────────────────────────

interface AIGeneratePanelProps {
  type: 'agent' | 'skill' | 'mcp';
  placeholder: string;
  onGenerated: (data: Record<string, unknown>) => void;
  onClose: () => void;
}

function AIGeneratePanel({ type, placeholder, onGenerated, onClose }: AIGeneratePanelProps) {
  const [prompt, setPrompt] = useState('');
  const [generating, setGenerating] = useState(false);

  async function generate() {
    if (!prompt.trim()) return;
    setGenerating(true);
    try {
      const res = await api.post<{ data: Record<string, unknown> }>('/api/ai/generate', { type, description: prompt.trim() });
      onGenerated(res.data);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'AI generation failed');
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="mb-4 rounded-xl border border-indigo-200 bg-gradient-to-br from-indigo-50 to-purple-50 p-4 dark:border-indigo-800 dark:from-indigo-950/40 dark:to-purple-950/40">
      <div className="mb-3 flex items-center gap-2">
        <Sparkles size={16} className="text-indigo-500" />
        <span className="text-sm font-semibold text-indigo-900 dark:text-indigo-300">Generate with AI</span>
        <span className="ml-auto text-xs text-indigo-400 dark:text-indigo-500">Describe what you want → AI fills the form</span>
      </div>
      <textarea
        className="mb-3 w-full rounded-lg border border-indigo-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-indigo-400 focus:outline-none dark:border-indigo-700 dark:bg-gray-800 dark:text-white dark:placeholder-gray-500"
        rows={3}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={placeholder}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) generate(); }}
      />
      <div className="flex items-center gap-2">
        <button
          onClick={generate}
          disabled={!prompt.trim() || generating}
          className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {generating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {generating ? 'Generating…' : 'Generate'}
        </button>
        <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-gray-500 hover:bg-indigo-100 dark:hover:bg-indigo-900/30">
          Cancel
        </button>
        <span className="ml-auto text-xs text-indigo-400 dark:text-indigo-500">Ctrl+Enter to generate</span>
      </div>
    </div>
  );
}

// ── Component ──────────────────────────────────────────────────────────────────

export function AgentsList() {
  const [activeTab, setActiveTab] = useState<Tab>('agents');

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'agents', label: 'Agents', icon: <Bot size={16} /> },
    { key: 'skills', label: 'Skills', icon: <Wrench size={16} /> },
    { key: 'mcp', label: 'MCP Connections', icon: <Plug size={16} /> },
  ];

  return (
    <div>
      <div className="mb-6 flex gap-1 rounded-lg border border-gray-200 bg-gray-50 p-1 dark:border-gray-700 dark:bg-gray-800">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === t.key
                ? 'bg-white text-indigo-600 shadow-sm dark:bg-gray-900 dark:text-indigo-400'
                : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200'
            }`}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'agents' && <AgentsTab />}
      {activeTab === 'skills' && <SkillsTab />}
      {activeTab === 'mcp' && <McpTab />}
    </div>
  );
}

// ── Agents Tab ─────────────────────────────────────────────────────────────────

function AgentsTab() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [showAIPanel, setShowAIPanel] = useState(false);
  const [importing, setImporting] = useState(false);
  const importFileRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState({
    name: '',
    description: '',
    modelProvider: 'github-models',
    model: '',
    systemPrompt: '',
    triggerType: 'manual',
    tools: '',
    argumentHint: '',
  });

  const { data, isLoading } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<{ data: Agent[] }>('/api/agents'),
  });

  const createMutation = useMutation({
    mutationFn: (input: typeof form) => api.post('/api/agents', {
      ...input,
      tools: input.tools ? input.tools : undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] });
      setShowCreate(false);
      setForm({ name: '', description: '', modelProvider: 'github-models', model: '', systemPrompt: '', triggerType: 'manual', tools: '', argumentHint: '' });
      toast.success('Agent created');
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/agents/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] });
      toast.success('Agent deleted');
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const agents = data?.data ?? [];

  function applyAIGenerated(data: Record<string, unknown>) {
    // tools may come back as array or string
    let toolsStr = '';
    if (Array.isArray(data.tools)) toolsStr = JSON.stringify(data.tools);
    else if (typeof data.tools === 'string') toolsStr = data.tools;

    setForm({
      name: String(data.name ?? ''),
      description: String(data.description ?? ''),
      modelProvider: String(data.modelProvider ?? 'github-models'),
      model: String(data.model ?? ''),
      systemPrompt: String(data.systemPrompt ?? ''),
      triggerType: String(data.triggerType ?? 'manual'),
      tools: toolsStr,
      argumentHint: String(data.argumentHint ?? ''),
    });
    setShowAIPanel(false);
    setShowCreate(true);
    toast.success('Form pre-filled by AI — review and save');
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    setImporting(true);
    let imported = 0; let failed = 0;
    for (const file of files) {
      const text = await file.text();
      const agents: Partial<Agent>[] = file.name.endsWith('.json')
        ? parseAgentsJson(text)
        : file.name.endsWith('.md') ? [parseInstructionsMd(text) as Partial<Agent>].filter(Boolean) : [];
      for (const agent of agents) {
        if (!agent?.name) { failed++; continue; }
        try {
          await api.post('/api/agents', { modelProvider: 'openai', triggerType: 'manual', ...agent });
          imported++;
        } catch { failed++; }
      }
    }
    qc.invalidateQueries({ queryKey: ['agents'] });
    setImporting(false);
    if (imported > 0) toast.success(`Imported ${imported} agent${imported > 1 ? 's' : ''}`);
    if (failed > 0) toast.error(`${failed} item${failed > 1 ? 's' : ''} could not be imported`);
    if (importFileRef.current) importFileRef.current.value = '';
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Agents</h2>
        <div className="flex gap-2">
          <input ref={importFileRef} type="file" accept=".md,.json" multiple className="hidden" onChange={handleImportFile} />
          <button
            onClick={() => importFileRef.current?.click()}
            disabled={importing}
            className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-600 hover:border-gray-300 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            {importing ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} Import
          </button>
          <button
            onClick={() => { setShowAIPanel(true); setShowCreate(false); }}
            className="flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100 dark:border-indigo-800 dark:bg-indigo-900/20 dark:text-indigo-300 dark:hover:bg-indigo-900/40"
          >
            <Sparkles size={16} /> Generate with AI
          </button>
          <button onClick={() => { setShowCreate(true); setShowAIPanel(false); }} className={`flex items-center gap-2 ${primaryBtn}`}>
            <Plus size={16} /> New Agent
          </button>
        </div>
      </div>

      {showAIPanel && (
        <AIGeneratePanel
          type="agent"
          placeholder="e.g. An agent that automatically translates XLIFF files from English to German, uses the project glossary, and commits the result to a new branch in Azure DevOps."
          onGenerated={applyAIGenerated}
          onClose={() => setShowAIPanel(false)}
        />
      )}

      {showCreate && (
        <div className={formCardClass}>
          <div className="mb-4 flex items-center justify-between">
            <h3 className="font-semibold text-gray-900 dark:text-white">Create Agent</h3>
            <button
              onClick={() => { setShowAIPanel(true); setShowCreate(false); }}
              className="flex items-center gap-1 text-xs text-indigo-500 hover:text-indigo-700"
            >
              <RefreshCw size={12} /> Re-generate
            </button>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className={labelClass}>Name *</label>
              <input
                className={inputClass}
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="TranslationOrchestrator"
              />
            </div>
            <div>
              <label className={labelClass}>Model Provider</label>
              <select
                className={inputClass}
                value={form.modelProvider}
                onChange={(e) => setForm((f) => ({ ...f, modelProvider: e.target.value }))}
              >
                <option value="github-models">GitHub Models</option>
                <option value="openai">OpenAI</option>
                <option value="azure-openai">Azure OpenAI</option>
                <option value="ollama">Ollama</option>
              </select>
            </div>
            <div>
              <label className={labelClass}>Model <span className="text-gray-400 font-normal text-xs">(specific, e.g. gpt-4o)</span></label>
              <input
                className={inputClass}
                value={form.model}
                onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                placeholder="gpt-4o"
              />
            </div>
            <div>
              <label className={labelClass}>Trigger Type</label>
              <select
                className={inputClass}
                value={form.triggerType}
                onChange={(e) => setForm((f) => ({ ...f, triggerType: e.target.value }))}
              >
                <option value="manual">Manual</option>
                <option value="scheduled">Scheduled</option>
                <option value="event-driven">Event-driven</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className={labelClass}>Description <span className="text-gray-400 font-normal text-xs">"Use when: ..." with trigger phrases</span></label>
              <textarea
                className={`${inputClass} min-h-[60px]`}
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder='Use when: start translation, run XLIFF pipeline, translate file to German. Coordinates the translation workflow from XLIFF extraction to commit.'
              />
            </div>
            <div className="sm:col-span-2">
              <label className={labelClass}>Argument Hint <span className="text-gray-400 font-normal text-xs">shown in picker</span></label>
              <input
                className={inputClass}
                value={form.argumentHint}
                onChange={(e) => setForm((f) => ({ ...f, argumentHint: e.target.value }))}
                placeholder="XLIFF file path or translation unit ID"
              />
            </div>
            <div className="sm:col-span-2">
              <label className={labelClass}>Tools <span className="text-gray-400 font-normal text-xs">JSON array, e.g. ["read","search","azure-devops"]</span></label>
              <input
                className={inputClass}
                value={form.tools}
                onChange={(e) => setForm((f) => ({ ...f, tools: e.target.value }))}
                placeholder='["read", "search", "azure-devops", "execute"]'
              />
            </div>
            <div className="sm:col-span-2">
              <label className={labelClass}>System Prompt</label>
              <textarea
                className={`${inputClass} min-h-[320px] resize-y font-mono text-xs`}
                value={form.systemPrompt}
                onChange={(e) => setForm((f) => ({ ...f, systemPrompt: e.target.value }))}
                placeholder="You are a helpful agent. Your role is to..."
              />
            </div>
          </div>
          <div className="mt-4 flex gap-3">
            <button
              onClick={() => createMutation.mutate(form)}
              disabled={!form.name || createMutation.isPending}
              className={primaryBtn}
            >
              {createMutation.isPending ? 'Creating...' : 'Create'}
            </button>
            <button onClick={() => setShowCreate(false)} className={secondaryBtn}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="py-12 text-center text-gray-400">Loading...</div>
      ) : agents.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white py-12 text-center dark:border-gray-700 dark:bg-gray-900">
          <Bot size={40} className="mx-auto mb-3 text-gray-300 dark:text-gray-600" />
          <p className="text-gray-500 dark:text-gray-400">No agents yet. Create your first AI agent.</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((a) => (
            <div key={a.id} className={cardClass}>
              <div className="flex items-start justify-between">
                <div className="min-w-0 flex-1">
                  <a
                    href={`/agents/${a.id}`}
                    className="block truncate font-semibold text-gray-900 hover:text-indigo-600 dark:text-white dark:hover:text-indigo-400"
                  >
                    {a.name}
                  </a>
                  {a.description && (
                    <p className="mt-1 line-clamp-2 text-xs text-gray-500 dark:text-gray-400">{a.description}</p>
                  )}
                </div>
                <div className="ml-2 flex shrink-0 gap-1">
                  <button
                    onClick={() => exportAgentAsInstructions(a)}
                    title="Export as .instructions.md"
                    className="text-gray-400 hover:text-indigo-500 dark:text-gray-600 dark:hover:text-indigo-400"
                  >
                    <Download size={14} />
                  </button>
                  <button
                    onClick={() => {
                      if (confirm('Delete this agent?')) deleteMutation.mutate(a.id);
                    }}
                    className="text-gray-400 hover:text-red-500 dark:text-gray-600 dark:hover:text-red-400"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400">
                  <Shield size={10} /> {a.model ?? a.modelProvider}
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                  <Zap size={10} /> {a.triggerType}
                </span>
              </div>
              {/* Tools chips */}
              {a.tools && (() => {
                let t: string[] = [];
                try { t = JSON.parse(a.tools) as string[]; } catch { t = []; }
                return t.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {t.slice(0, 5).map((tool) => (
                      <span key={tool} className="inline-flex items-center gap-0.5 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                        <Tag size={8} /> {tool}
                      </span>
                    ))}
                    {t.length > 5 && <span className="text-xs text-gray-400">+{t.length - 5}</span>}
                  </div>
                ) : null;
              })()}
              <div className="mt-3 flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
                <span className="flex items-center gap-1"><Wrench size={12} /> {a.skills?.length ?? 0} skill(s)</span>
                <span className="flex items-center gap-1"><Plug size={12} /> {a.mcpConnections?.length ?? 0} MCP</span>
                <span className="flex items-center gap-1"><Play size={12} /> {a._count?.runs ?? 0} run(s)</span>
              </div>
              <div className="mt-2 text-xs text-gray-400 dark:text-gray-600">{formatDate(a.createdAt)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Skills Tab ─────────────────────────────────────────────────────────────────

function SkillsTab() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [showAIPanel, setShowAIPanel] = useState(false);
  const [importing, setImporting] = useState(false);
  const importFileRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState({ name: '', description: '', type: 'prompt' as string, promptTemplate: '' });

  const { data, isLoading } = useQuery({
    queryKey: ['skills'],
    queryFn: () => api.get<{ data: Skill[] }>('/api/skills'),
  });

  const createMutation = useMutation({
    mutationFn: (input: typeof form) => api.post('/api/skills', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] });
      setShowCreate(false);
      setForm({ name: '', description: '', type: 'prompt', promptTemplate: '' });
      toast.success('Skill created');
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/skills/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] });
      toast.success('Skill deleted');
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const seedMutation = useMutation({
    mutationFn: () => api.post('/api/skills/seed-built-in', {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] });
      toast.success('Built-in skills seeded');
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const skills = data?.data ?? [];
  const builtInSkills = skills.filter((s) => s.builtIn);
  const customSkills = skills.filter((s) => !s.builtIn);

  function applyAIGenerated(data: Record<string, unknown>) {
    setForm({
      name: String(data.name ?? ''),
      description: String(data.description ?? ''),
      type: String(data.type ?? 'prompt'),
      promptTemplate: String(data.promptTemplate ?? ''),
    });
    setShowAIPanel(false);
    setShowCreate(true);
    toast.success('Form pre-filled by AI — review and save');
  }

  async function handleImportSkillFile(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    setImporting(true);
    let imported = 0; let failed = 0;
    for (const file of files) {
      const text = await file.text();
      const skills: Partial<Skill>[] = file.name.endsWith('.json')
        ? parseSkillsJson(text)
        : file.name.endsWith('.md') ? [parseSkillInstructionsMd(text) as Partial<Skill>].filter(Boolean) : [];
      for (const skill of skills) {
        if (!skill?.name) { failed++; continue; }
        try {
          await api.post('/api/skills', { type: 'prompt', ...skill });
          imported++;
        } catch { failed++; }
      }
    }
    qc.invalidateQueries({ queryKey: ['skills'] });
    setImporting(false);
    if (imported > 0) toast.success(`Imported ${imported} skill${imported > 1 ? 's' : ''}`);
    if (failed > 0) toast.error(`${failed} item${failed > 1 ? 's' : ''} could not be imported`);
    if (importFileRef.current) importFileRef.current.value = '';
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Skills</h2>
        <div className="flex gap-2">
          <input ref={importFileRef} type="file" accept=".md,.json" multiple className="hidden" onChange={handleImportSkillFile} />
          <button
            onClick={() => importFileRef.current?.click()}
            disabled={importing}
            className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-600 hover:border-gray-300 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            {importing ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} Import
          </button>
          <button
            onClick={() => seedMutation.mutate()}
            disabled={seedMutation.isPending}
            className={`flex items-center gap-2 ${secondaryBtn}`}
          >
            <Zap size={16} /> {seedMutation.isPending ? 'Seeding...' : 'Seed Built-in Skills'}
          </button>
          <button
            onClick={() => { setShowAIPanel(true); setShowCreate(false); }}
            className="flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100 dark:border-indigo-800 dark:bg-indigo-900/20 dark:text-indigo-300 dark:hover:bg-indigo-900/40"
          >
            <Sparkles size={16} /> Generate with AI
          </button>
          <button onClick={() => { setShowCreate(true); setShowAIPanel(false); }} className={`flex items-center gap-2 ${primaryBtn}`}>
            <Plus size={16} /> New Skill
          </button>
        </div>
      </div>

      {showAIPanel && (
        <AIGeneratePanel
          type="skill"
          placeholder="e.g. A skill that reviews a translation for correctness, tone, and glossary compliance, then returns a quality score and improvement suggestions."
          onGenerated={applyAIGenerated}
          onClose={() => setShowAIPanel(false)}
        />
      )}

      {showCreate && (
        <div className={formCardClass}>
          <div className="mb-4 flex items-center justify-between">
            <h3 className="font-semibold text-gray-900 dark:text-white">Create Skill</h3>
            <button
              onClick={() => { setShowAIPanel(true); setShowCreate(false); }}
              className="flex items-center gap-1 text-xs text-indigo-500 hover:text-indigo-700"
            >
              <RefreshCw size={12} /> Re-generate
            </button>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className={labelClass}>Name *</label>
              <input
                className={inputClass}
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Translate Text"
              />
            </div>
            <div>
              <label className={labelClass}>Type</label>
              <select
                className={inputClass}
                value={form.type}
                onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
              >
                <option value="prompt">Prompt</option>
                <option value="code">Code</option>
                <option value="mcp-tool">MCP Tool</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className={labelClass}>Description</label>
              <input
                className={inputClass}
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Translates text between languages"
              />
            </div>
            {form.type === 'prompt' && (
              <div className="sm:col-span-2">
                <label className={labelClass}>Prompt Template</label>
                <textarea
                  className={`${inputClass} min-h-[80px]`}
                  value={form.promptTemplate}
                  onChange={(e) => setForm((f) => ({ ...f, promptTemplate: e.target.value }))}
                  placeholder="Translate the following text to {{targetLanguage}}:&#10;{{sourceText}}"
                />
              </div>
            )}
          </div>
          <div className="mt-4 flex gap-3">
            <button
              onClick={() => createMutation.mutate(form)}
              disabled={!form.name || createMutation.isPending}
              className={primaryBtn}
            >
              {createMutation.isPending ? 'Creating...' : 'Create'}
            </button>
            <button onClick={() => setShowCreate(false)} className={secondaryBtn}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="py-12 text-center text-gray-400">Loading...</div>
      ) : skills.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white py-12 text-center dark:border-gray-700 dark:bg-gray-900">
          <Wrench size={40} className="mx-auto mb-3 text-gray-300 dark:text-gray-600" />
          <p className="text-gray-500 dark:text-gray-400">No skills yet. Seed built-in skills or create a custom one.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {builtInSkills.length > 0 && (
            <div>
              <h3 className="mb-3 text-sm font-medium text-gray-500 dark:text-gray-400">Built-in Skills</h3>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {builtInSkills.map((s) => (
                  <SkillCard key={s.id} skill={s} onDelete={() => {}} canDelete={false} />
                ))}
              </div>
            </div>
          )}
          {customSkills.length > 0 && (
            <div>
              <h3 className="mb-3 text-sm font-medium text-gray-500 dark:text-gray-400">Custom Skills</h3>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {customSkills.map((s) => (
                  <SkillCard
                    key={s.id}
                    skill={s}
                    onDelete={() => {
                      if (confirm('Delete this skill?')) deleteMutation.mutate(s.id);
                    }}
                    canDelete
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SkillModal({ skill, onClose, onSaved }: { skill: Skill; onClose: () => void; onSaved: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: skill.name,
    description: skill.description ?? '',
    type: skill.type,
    promptTemplate: skill.promptTemplate ?? '',
  });
  const [saving, setSaving] = useState(false);
  const readOnly = skill.builtIn;

  const typeColors: Record<string, string> = {
    prompt: 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    code: 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    'mcp-tool': 'bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  };

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/api/skills/${skill.id}`, form);
      qc.invalidateQueries({ queryKey: ['skills'] });
      toast.success('Skill saved');
      onSaved();
    } catch (e) { toast.error(getErrorMessage(e)); }
    finally { setSaving(false); }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-950"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-gray-100 px-6 py-4 dark:border-gray-800">
          <Wrench size={18} className="shrink-0 text-indigo-500" />
          <div className="flex-1 min-w-0">
            {readOnly ? (
              <h2 className="truncate text-lg font-bold text-gray-900 dark:text-white">{skill.name}</h2>
            ) : (
              <input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className="w-full bg-transparent text-lg font-bold text-gray-900 focus:outline-none dark:text-white"
              />
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${typeColors[form.type] ?? ''}`}>
              {form.type}
            </span>
            {skill.builtIn && (
              <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                <Shield size={10} /> built-in
              </span>
            )}
            <button onClick={onClose} className="rounded-full p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800">
              <X size={15} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {/* Description */}
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-400">Description</label>
            {readOnly ? (
              <p className="text-sm text-gray-700 dark:text-gray-300">{skill.description || <span className="italic text-gray-400">—</span>}</p>
            ) : (
              <input
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="What does this skill do?"
                className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800 focus:border-indigo-400 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-white"
              />
            )}
          </div>

          {/* Type selector (edit only) */}
          {!readOnly && (
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-400">Type</label>
              <select
                value={form.type}
                onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as Skill['type'] }))}
                className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800 focus:border-indigo-400 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-white"
              >
                <option value="prompt">Prompt</option>
                <option value="code">Code</option>
                <option value="mcp-tool">MCP Tool</option>
              </select>
            </div>
          )}

          {/* Prompt template / code */}
          <div className="flex-1">
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-400">
              {form.type === 'code' ? 'Code' : 'Prompt Template'}
            </label>
            {readOnly ? (
              <pre className="min-h-[180px] rounded-xl border border-gray-100 bg-gray-50 p-4 font-mono text-sm leading-relaxed text-gray-700 whitespace-pre-wrap break-words dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300">
                {skill.promptTemplate || <span className="italic text-gray-400">No template defined.</span>}
              </pre>
            ) : (
              <textarea
                rows={12}
                value={form.promptTemplate}
                onChange={(e) => setForm((f) => ({ ...f, promptTemplate: e.target.value }))}
                placeholder={form.type === 'code' ? 'Write your code here...' : 'Translate the following text to {{targetLanguage}}:\n\n{{sourceText}}'}
                className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 font-mono text-sm leading-relaxed text-gray-800 focus:border-indigo-400 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-white"
              />
            )}
          </div>
        </div>

        {/* Footer */}
        {!readOnly && (
          <div className="flex items-center justify-end gap-3 border-t border-gray-100 px-6 py-4 dark:border-gray-800">
            <button onClick={onClose} className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800">
              Cancel
            </button>
            <button
              onClick={save}
              disabled={!form.name || saving}
              className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : null}
              Save changes
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

function SkillCard({ skill, onDelete, canDelete }: { skill: Skill; onDelete: () => void; canDelete: boolean }) {
  const [modalOpen, setModalOpen] = useState(false);

  const typeColors: Record<string, string> = {
    prompt: 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    code: 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    'mcp-tool': 'bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  };

  return (
    <>
      {modalOpen && (
        <SkillModal
          skill={skill}
          onClose={() => setModalOpen(false)}
          onSaved={() => setModalOpen(false)}
        />
      )}
      <div
        className={`${cardClass} flex cursor-pointer flex-col`}
        onClick={() => setModalOpen(true)}
      >
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="min-w-0 flex-1">
            <span className="block truncate font-semibold text-gray-900 dark:text-white">{skill.name}</span>
            {skill.description && (
              <p className="mt-1 line-clamp-2 text-sm text-gray-500 dark:text-gray-400">{skill.description}</p>
            )}
          </div>
          <div className="ml-2 flex shrink-0 items-center gap-1">
            <button
              title={skill.builtIn ? 'View skill' : 'Edit skill'}
              className="text-gray-400 hover:text-indigo-500 dark:text-gray-600 dark:hover:text-indigo-400"
              onClick={(e) => { e.stopPropagation(); setModalOpen(true); }}
            >
              {skill.builtIn ? <BookOpen size={14} /> : <Pencil size={14} />}
            </button>
            {canDelete && (
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                className="text-gray-400 hover:text-red-500 dark:text-gray-600 dark:hover:text-red-400"
              >
                <Trash2 size={15} />
              </button>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="mt-3 flex items-center gap-2">
          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${typeColors[skill.type] ?? ''}`}>
            {skill.type}
          </span>
          {skill.builtIn && (
            <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400">
              <Shield size={10} /> built-in
            </span>
          )}
          {skill.promptTemplate && (
            <span className="ml-auto text-xs text-gray-400">has template</span>
          )}
        </div>
        <div className="mt-2 text-xs text-gray-400 dark:text-gray-600">{formatDate(skill.createdAt)}</div>
      </div>
    </>
  );
}

// ── MCP Connections Tab ────────────────────────────────────────────────────────

function McpTab() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [showAIPanel, setShowAIPanel] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: '',
    type: 'custom',
    baseUrl: '',
    authType: 'pat',
    credential: '',
    recordingsFolder: '',
    wikiUrl: '',
    scriptPath: '',
    pythonPath: '',
  });

  const { data, isLoading } = useQuery({
    queryKey: ['mcp-connections'],
    queryFn: () => api.get<{ data: McpConnection[] }>('/api/mcp-connections'),
  });

  const emptyForm = {
    name: '',
    type: 'custom',
    baseUrl: '',
    authType: 'pat',
    credential: '',
    recordingsFolder: '',
    wikiUrl: '',
    scriptPath: '',
    pythonPath: '',
  };

  function buildPayload(input: typeof form) {
    const { recordingsFolder, wikiUrl, scriptPath, pythonPath, ...rest } = input;
    const caps: Record<string, string> = {};
    if (input.type === 'teams_recorder' && recordingsFolder.trim()) caps.recordingsFolder = recordingsFolder.trim();
    if (input.type === 'wiki_js') {
      if (wikiUrl.trim()) caps.wikiUrl = wikiUrl.trim();
      if (scriptPath.trim()) caps.scriptPath = scriptPath.trim();
      if (pythonPath.trim()) caps.pythonPath = pythonPath.trim();
    }
    // For typed connections always send capabilities (even empty {}) so old stale values get overwritten
    const shouldSendCaps = input.type === 'wiki_js' || input.type === 'teams_recorder';
    const capabilities = (Object.keys(caps).length > 0 || shouldSendCaps) ? JSON.stringify(caps) : undefined;
    return { ...rest, ...(capabilities !== undefined ? { capabilities } : {}) };
  }

  const createMutation = useMutation({
    mutationFn: (input: typeof form) => api.post('/api/mcp-connections', buildPayload(input)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mcp-connections'] });
      setShowCreate(false);
      setEditingId(null);
      setForm(emptyForm);
      toast.success('MCP connection created');
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: typeof form }) =>
      api.patch(`/api/mcp-connections/${id}`, buildPayload(input)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mcp-connections'] });
      qc.invalidateQueries({ queryKey: ['wiki-status'] });
      setShowCreate(false);
      setEditingId(null);
      setForm(emptyForm);
      toast.success('MCP connection updated');
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/mcp-connections/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mcp-connections'] });
      toast.success('MCP connection deleted');
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const testMutation = useMutation({
    mutationFn: (id: string) => api.post<{ data: { status: string; message: string } }>(`/api/mcp-connections/${id}/test`, {}),
    onSuccess: (result) => {
      const { status, message } = result.data;
      if (status === 'ok') toast.success(`Test passed: ${message}`);
      else toast.error(`Test failed: ${message}`);
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const connections = data?.data ?? [];

  function openEdit(c: McpConnection) {
    const caps = (() => { try { return JSON.parse(c.capabilities ?? '{}'); } catch { return {}; } })();
    setForm({
      name: c.name,
      type: c.type,
      baseUrl: c.baseUrl ?? '',
      authType: c.authType ?? 'pat',
      credential: '', // never pre-fill credentials
      recordingsFolder: String(caps.recordingsFolder ?? ''),
      wikiUrl: String(caps.wikiUrl ?? ''),
      scriptPath: String(caps.scriptPath ?? ''),
      pythonPath: String(caps.pythonPath ?? ''),
    });
    setEditingId(c.id);
    setShowCreate(true);
    setShowAIPanel(false);
  }

  function applyAIGenerated(data: Record<string, unknown>) {
    setForm({
      name: String(data.name ?? ''),
      type: String(data.type ?? 'custom'),
      baseUrl: String(data.baseUrl ?? ''),
      authType: String(data.authType ?? 'pat'),
      credential: '',
      recordingsFolder: String(data.recordingsFolder ?? ''),
      wikiUrl: String(data.wikiUrl ?? ''),
      scriptPath: String(data.scriptPath ?? ''),
      pythonPath: String(data.pythonPath ?? ''),
    });
    setEditingId(null);
    setShowAIPanel(false);
    setShowCreate(true);
    toast.success('Form pre-filled by AI — review and save');
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">MCP Connections</h2>
        <div className="flex gap-2">
          <button
            onClick={() => { setShowAIPanel(true); setShowCreate(false); }}
            className="flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100 dark:border-indigo-800 dark:bg-indigo-900/20 dark:text-indigo-300 dark:hover:bg-indigo-900/40"
          >
            <Sparkles size={16} /> Generate with AI
          </button>
          <button onClick={() => { setShowCreate(true); setShowAIPanel(false); }} className={`flex items-center gap-2 ${primaryBtn}`}>
            <Plus size={16} /> New Connection
          </button>
        </div>
      </div>

      {showAIPanel && (
        <AIGeneratePanel
          type="mcp"
          placeholder="e.g. Connect to our Wiki.js documentation portal at wiki.company.com to read and update project documentation pages."
          onGenerated={applyAIGenerated}
          onClose={() => setShowAIPanel(false)}
        />
      )}

      {showCreate && (
        <div className={formCardClass}>
          <div className="mb-4 flex items-center justify-between">
            <h3 className="font-semibold text-gray-900 dark:text-white">
              {editingId ? 'Edit MCP Connection' : 'Create MCP Connection'}
            </h3>
            {!editingId && (
              <button
                onClick={() => { setShowAIPanel(true); setShowCreate(false); }}
                className="flex items-center gap-1 text-xs text-indigo-500 hover:text-indigo-700"
              >
                <RefreshCw size={12} /> Re-generate
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className={labelClass}>Name *</label>
              <input
                className={inputClass}
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Wiki.js Production"
              />
            </div>
            <div>
              <label className={labelClass}>Type</label>
              <select
                className={inputClass}
                value={form.type}
                onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
              >
                <option value="wiki_js">Wiki.js</option>
                <option value="azure_devops_wiki">Azure DevOps Wiki</option>
                <option value="github">GitHub</option>
                <option value="azure_devops">Azure DevOps</option>
                <option value="teams_recorder">Teams Recorder (Local MCP)</option>
                <option value="custom">Custom</option>
              </select>
            </div>
            <div>
              <label className={labelClass}>{form.type === 'wiki_js' ? 'Wiki.js URL *' : 'Base URL *'}</label>
              <input
                className={inputClass}
                value={form.baseUrl}
                onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                placeholder={form.type === 'teams_recorder'
                  ? 'C:/VSCodeProjects/GitHub/mcp-teams-recorder/dist/index.js'
                  : form.type === 'wiki_js'
                    ? 'https://wiki.nobilis-group.com'
                    : 'https://example.com'}
              />
              {form.type === 'teams_recorder' && (
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  For Teams Recorder, baseUrl is the local path to the MCP server dist/index.js file.
                </p>
              )}
              {form.type === 'wiki_js' && (
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  The full URL of your Wiki.js instance (e.g. https://wiki.nobilis-group.com). The API key goes in the Credential field.
                </p>
              )}
            </div>
            <div>
              <label className={labelClass}>Auth Type</label>
              <select
                className={inputClass}
                value={form.authType}
                onChange={(e) => setForm((f) => ({ ...f, authType: e.target.value }))}
              >
                <option value="pat">PAT</option>
                <option value="oauth">OAuth</option>
                <option value="api_key">API Key</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className={labelClass}>
                {form.type === 'teams_recorder' ? 'GitHub Token (GITHUB_TOKEN)' : 'Credential / Token'}
              </label>
              <input
                className={inputClass}
                type="password"
                value={form.credential}
                onChange={(e) => setForm((f) => ({ ...f, credential: e.target.value }))}
                placeholder={form.type === 'teams_recorder' ? 'ghp_... (required for AI analysis)' : 'PAT or API key'}
              />
              {form.type === 'teams_recorder' && (
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  GitHub token with Copilot/models access. Required for AI analysis; list_recordings works without it.
                </p>
              )}
            </div>
            {form.type === 'teams_recorder' && (
              <div className="sm:col-span-2">
                <label className={labelClass}>Recordings Folder</label>
                <input
                  className={inputClass}
                  value={form.recordingsFolder}
                  onChange={(e) => setForm((f) => ({ ...f, recordingsFolder: e.target.value }))}
                  placeholder="C:/Temp/nexus (folder containing .mp4 and .vtt files)"
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Local folder where Teams recordings (.mp4 / .vtt) are stored. The folder will be scanned automatically each time recordings are fetched.
                </p>
              </div>
            )}
            {form.type === 'wiki_js' && (
              <>
                <div className="sm:col-span-2">
                  <label className={labelClass}>MCP Server Script (optional)</label>
                  <input
                    className={inputClass}
                    value={form.scriptPath}
                    onChange={(e) => setForm((f) => ({ ...f, scriptPath: e.target.value }))}
                    placeholder="C:/VSCodeProjects/GitHub/mcp-wikijs-server/server.py"
                  />
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    Path to the Wiki.js MCP <code>server.py</code>. If set, operations go through the MCP first with direct GraphQL as fallback.
                  </p>
                </div>
                <div className="sm:col-span-2">
                  <label className={labelClass}>Python Executable (optional)</label>
                  <input
                    className={inputClass}
                    value={form.pythonPath}
                    onChange={(e) => setForm((f) => ({ ...f, pythonPath: e.target.value }))}
                    placeholder="C:/VSCodeProjects/GitHub/mcp-wikijs-server/.venv/Scripts/python.exe"
                  />
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    Python executable for the MCP venv. Defaults to <code>python</code> if left blank.
                  </p>
                </div>
              </>
            )}
          </div>
          <div className="mt-4 flex gap-3">
            <button
              onClick={() => {
                if (editingId) updateMutation.mutate({ id: editingId, input: form });
                else createMutation.mutate(form);
              }}
              disabled={
                !form.name
                || !form.baseUrl
                || createMutation.isPending
                || updateMutation.isPending
              }
              className={primaryBtn}
            >
              {(createMutation.isPending || updateMutation.isPending)
                ? (editingId ? 'Saving...' : 'Creating...')
                : (editingId ? 'Save Changes' : 'Create')}
            </button>
            <button
              onClick={() => { setShowCreate(false); setEditingId(null); setForm(emptyForm); }}
              className={secondaryBtn}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="py-12 text-center text-gray-400">Loading...</div>
      ) : connections.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white py-12 text-center dark:border-gray-700 dark:bg-gray-900">
          <Plug size={40} className="mx-auto mb-3 text-gray-300 dark:text-gray-600" />
          <p className="text-gray-500 dark:text-gray-400">No MCP connections yet. Create your first connection.</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {connections.map((c) => (
            <div key={c.id} className={cardClass}>
              <div className="flex items-start justify-between">
                <div className="min-w-0 flex-1">
                  <span className="block truncate font-semibold text-gray-900 dark:text-white">{c.name}</span>
                  <p className="mt-1 truncate text-sm text-gray-500 dark:text-gray-400">{c.baseUrl}</p>
                </div>
                <div className="ml-2 flex flex-shrink-0 gap-1">
                  <button
                    onClick={() => openEdit(c)}
                    className="text-gray-400 hover:text-indigo-500 dark:text-gray-600 dark:hover:text-indigo-400"
                    title="Edit connection"
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    onClick={() => testMutation.mutate(c.id)}
                    disabled={testMutation.isPending}
                    className="text-gray-400 hover:text-green-500 dark:text-gray-600 dark:hover:text-green-400"
                    title="Test connection"
                  >
                    <FlaskConical size={15} />
                  </button>
                  <button
                    onClick={() => {
                      if (confirm('Delete this connection?')) deleteMutation.mutate(c.id);
                    }}
                    className="text-gray-400 hover:text-red-500 dark:text-gray-600 dark:hover:text-red-400"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                  {c.type}
                </span>
                <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                  {c.authType}
                </span>
              </div>
              <div className="mt-2 text-xs text-gray-400 dark:text-gray-600">{formatDate(c.createdAt)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
