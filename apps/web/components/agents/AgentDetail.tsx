'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Bot, Play, Save, Clock, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { ModelSelector } from './ModelSelector';

// ── Types ──────────────────────────────────────────────────────────────────────

interface Skill {
  id: string;
  name: string;
  description?: string;
  type: 'prompt' | 'instructions' | 'code';
  builtIn: boolean;
}

interface McpConnection {
  id: string;
  name: string;
  type: string;
  baseUrl?: string;
}

interface Agent {
  id: string;
  name: string;
  description?: string;
  modelProvider: string;
  model?: string;
  systemPrompt?: string;
  triggerType: string;
  createdAt: string;
  skills?: Array<{ id: string; skill: Skill }>;
  mcpConnections?: Array<{ id: string; mcpConnection: McpConnection }>;
  _count?: { runs: number };
}

interface AgentRun {
  id: string;
  status: string;
  input?: string;
  output?: string;
  logs?: string;
  error?: string;
  startedAt?: string;
  endedAt?: string;
  createdAt: string;
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

function statusBadge(status: string) {
  const map: Record<string, string> = {
    pending: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
    running: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    completed: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  };
  return map[status] ?? 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
}

function statusIcon(status: string) {
  if (status === 'completed') return <CheckCircle2 size={14} />;
  if (status === 'failed') return <XCircle size={14} />;
  if (status === 'running') return <Loader2 size={14} className="animate-spin" />;
  return <Clock size={14} />;
}

type Tab = 'edit' | 'runs';

// ── Component ──────────────────────────────────────────────────────────────────

export function AgentDetail({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<Tab>('edit');
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const { data: agentData, isLoading } = useQuery({
    queryKey: ['agent', agentId],
    queryFn: () => api.get<{ data: Agent }>(`/api/agents/${agentId}`),
  });

  const { data: skillsData } = useQuery({
    queryKey: ['skills'],
    queryFn: () => api.get<{ data: Skill[] }>('/api/skills'),
  });

  const { data: mcpData } = useQuery({
    queryKey: ['mcp-connections'],
    queryFn: () => api.get<{ data: McpConnection[] }>('/api/mcp-connections'),
  });

  const { data: runsData, refetch: refetchRuns } = useQuery({
    queryKey: ['agent-runs', agentId],
    queryFn: () => api.get<{ data: AgentRun[] }>(`/api/agents/${agentId}/runs?limit=50`),
    enabled: activeTab === 'runs',
  });

  const agent = agentData?.data;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="py-20 text-center text-gray-500 dark:text-gray-400">
        Agent not found
      </div>
    );
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'edit', label: 'Edit' },
    { key: 'runs', label: `Run History${agent._count?.runs ? ` (${agent._count.runs})` : ''}` },
  ];

  return (
    <div>
      <div className="mb-6 flex items-center gap-3">
        <Link
          href="/agents"
          className="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
        >
          <ArrowLeft size={20} />
        </Link>
        <Bot size={24} className="text-indigo-600" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{agent.name}</h1>
      </div>

      <div className="mb-6 flex gap-1 rounded-lg border border-gray-200 bg-gray-50 p-1 dark:border-gray-700 dark:bg-gray-800">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === t.key
                ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-white'
                : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'edit' && (
        <EditTab
          agent={agent}
          allSkills={skillsData?.data ?? []}
          allMcpConnections={mcpData?.data ?? []}
          onSaved={() => qc.invalidateQueries({ queryKey: ['agent', agentId] })}
        />
      )}

      {activeTab === 'runs' && (
        <RunsTab
          agentId={agentId}
          runs={runsData?.data ?? []}
          selectedRunId={selectedRunId}
          onSelectRun={setSelectedRunId}
          onRefresh={() => void refetchRuns()}
        />
      )}
    </div>
  );
}

// ── Edit Tab ────────────────────────────────────────────────────────────────────

function EditTab({
  agent,
  allSkills,
  allMcpConnections,
  onSaved,
}: {
  agent: Agent;
  allSkills: Skill[];
  allMcpConnections: McpConnection[];
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: agent.name,
    description: agent.description || '',
    modelProvider: agent.modelProvider,
    model: agent.model || '',
    systemPrompt: agent.systemPrompt || '',
    triggerType: agent.triggerType,
  });

  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>(
    agent.skills?.map((s) => s.skill.id) ?? [],
  );

  const [selectedMcpIds, setSelectedMcpIds] = useState<string[]>(
    agent.mcpConnections?.map((m) => m.mcpConnection.id) ?? [],
  );

  // Reset form when agent changes
  useEffect(() => {
    setForm({
      name: agent.name,
      description: agent.description || '',
      modelProvider: agent.modelProvider,
      model: agent.model || '',
      systemPrompt: agent.systemPrompt || '',
      triggerType: agent.triggerType,
    });
    setSelectedSkillIds(agent.skills?.map((s) => s.skill.id) ?? []);
    setSelectedMcpIds(agent.mcpConnections?.map((m) => m.mcpConnection.id) ?? []);
  }, [agent]);

  const updateMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api.patch(`/api/agents/${agent.id}`, payload),
    onSuccess: () => {
      onSaved();
      toast.success('Agent updated');
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const runMutation = useMutation({
    mutationFn: () => api.post(`/api/agents/${agent.id}/run`, {}),
    onSuccess: () => toast.success('Agent run started'),
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const handleSave = () => {
    updateMutation.mutate({
      ...form,
      skillIds: selectedSkillIds,
      mcpConnectionIds: selectedMcpIds,
    });
  };

  const toggleSkill = (id: string) => {
    setSelectedSkillIds((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id],
    );
  };

  const toggleMcp = (id: string) => {
    setSelectedMcpIds((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id],
    );
  };

  return (
    <div className="space-y-6">
      {/* Agent form */}
      <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-900">
        <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">Agent Settings</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className={labelClass}>Name</label>
            <input
              className={inputClass}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>Trigger Type</label>
            <select
              className={inputClass}
              value={form.triggerType}
              onChange={(e) => setForm({ ...form, triggerType: e.target.value })}
            >
              <option value="manual">Manual</option>
              <option value="scheduled">Scheduled</option>
              <option value="event-driven">Event-driven</option>
            </select>
          </div>
          <ModelSelector
            model={form.model}
            inputClass={inputClass}
            labelClass={labelClass}
            onModelChange={(m, p) => setForm({ ...form, model: m, modelProvider: p })}
          />
          <div className="sm:col-span-2">
            <label className={labelClass}>System Prompt</label>
            <textarea
              className={inputClass}
              rows={3}
              value={form.systemPrompt}
              onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
            />
          </div>
        </div>
      </div>

      {/* Skills */}
      <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-900">
        <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">Skills</h3>
        {allSkills.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No skills available. Create skills first.</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {allSkills.map((skill) => (
              <label
                key={skill.id}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                  selectedSkillIds.includes(skill.id)
                    ? 'border-indigo-400 bg-indigo-50 dark:border-indigo-500 dark:bg-indigo-900/20'
                    : 'border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600'
                }`}
              >
                <input
                  type="checkbox"
                  checked={selectedSkillIds.includes(skill.id)}
                  onChange={() => toggleSkill(skill.id)}
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-gray-900 dark:text-white">
                    {skill.name}
                  </span>
                  {skill.description && (
                    <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                      {skill.description}
                    </span>
                  )}
                  <span className="mt-1 inline-block rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                    {skill.builtIn ? 'built-in' : skill.type}
                  </span>
                </div>
              </label>
            ))}
          </div>
        )}
      </div>

      {/* MCP Connections */}
      <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-900">
        <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">MCP Connections</h3>
        {allMcpConnections.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No MCP connections available.</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {allMcpConnections.map((mcp) => (
              <label
                key={mcp.id}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                  selectedMcpIds.includes(mcp.id)
                    ? 'border-indigo-400 bg-indigo-50 dark:border-indigo-500 dark:bg-indigo-900/20'
                    : 'border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600'
                }`}
              >
                <input
                  type="checkbox"
                  checked={selectedMcpIds.includes(mcp.id)}
                  onChange={() => toggleMcp(mcp.id)}
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-gray-900 dark:text-white">
                    {mcp.name}
                  </span>
                  {mcp.baseUrl && (
                    <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                      {mcp.baseUrl}
                    </span>
                  )}
                  <span className="mt-1 inline-block rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                    {mcp.type}
                  </span>
                </div>
              </label>
            ))}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-3">
        <button onClick={handleSave} disabled={updateMutation.isPending} className={primaryBtn}>
          <span className="flex items-center gap-2">
            <Save size={16} /> {updateMutation.isPending ? 'Saving…' : 'Save Changes'}
          </span>
        </button>
        <button onClick={() => runMutation.mutate()} disabled={runMutation.isPending} className={secondaryBtn}>
          <span className="flex items-center gap-2">
            <Play size={16} /> {runMutation.isPending ? 'Starting…' : 'Run Agent'}
          </span>
        </button>
      </div>
    </div>
  );
}

// ── Runs Tab ────────────────────────────────────────────────────────────────────

function RunsTab({
  agentId,
  runs,
  selectedRunId,
  onSelectRun,
  onRefresh,
}: {
  agentId: string;
  runs: AgentRun[];
  selectedRunId: string | null;
  onSelectRun: (id: string | null) => void;
  onRefresh: () => void;
}) {
  const runMutation = useMutation({
    mutationFn: () => api.post(`/api/agents/${agentId}/run`, {}),
    onSuccess: () => {
      toast.success('Agent run started');
      onRefresh();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const selectedRun = runs.find((r) => r.id === selectedRunId);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Run History</h3>
        <div className="flex gap-2">
          <button onClick={onRefresh} className={secondaryBtn}>
            Refresh
          </button>
          <button onClick={() => runMutation.mutate()} disabled={runMutation.isPending} className={primaryBtn}>
            <span className="flex items-center gap-2">
              <Play size={16} /> Run Now
            </span>
          </button>
        </div>
      </div>

      {runs.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white p-10 text-center dark:border-gray-700 dark:bg-gray-900">
          <p className="text-gray-500 dark:text-gray-400">No runs yet. Trigger a manual run to get started.</p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Run list */}
          <div className="space-y-2">
            {runs.map((run) => (
              <button
                key={run.id}
                onClick={() => onSelectRun(run.id === selectedRunId ? null : run.id)}
                className={`w-full rounded-lg border p-4 text-left transition-colors ${
                  run.id === selectedRunId
                    ? 'border-indigo-400 bg-indigo-50 dark:border-indigo-500 dark:bg-indigo-900/20'
                    : 'border-gray-200 bg-white hover:border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:hover:border-gray-600'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${statusBadge(run.status)}`}>
                    {statusIcon(run.status)} {run.status}
                  </span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {formatDate(run.createdAt)}
                  </span>
                </div>
                {run.endedAt && run.startedAt && (
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    Duration: {Math.round((new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)}s
                  </p>
                )}
                {run.error && (
                  <p className="mt-1 truncate text-xs text-red-600 dark:text-red-400">{run.error}</p>
                )}
              </button>
            ))}
          </div>

          {/* Run detail */}
          {selectedRun && (
            <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-900">
              <h4 className="mb-4 font-semibold text-gray-900 dark:text-white">Run Detail</h4>

              <div className="space-y-4">
                <div>
                  <span className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Status</span>
                  <p className={`mt-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${statusBadge(selectedRun.status)}`}>
                    {statusIcon(selectedRun.status)} {selectedRun.status}
                  </p>
                </div>

                {selectedRun.error && (
                  <div>
                    <span className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Error</span>
                    <pre className="mt-1 overflow-auto rounded-lg bg-red-50 p-3 text-xs text-red-800 dark:bg-red-900/20 dark:text-red-300">
                      {selectedRun.error}
                    </pre>
                  </div>
                )}

                {selectedRun.input && (
                  <div>
                    <span className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Input</span>
                    <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-gray-50 p-3 text-xs text-gray-800 dark:bg-gray-800 dark:text-gray-200">
                      {formatJSON(selectedRun.input)}
                    </pre>
                  </div>
                )}

                {selectedRun.output && (
                  <div>
                    <span className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Output</span>
                    <pre className="mt-1 max-h-60 overflow-auto rounded-lg bg-gray-50 p-3 text-xs text-gray-800 dark:bg-gray-800 dark:text-gray-200">
                      {formatJSON(selectedRun.output)}
                    </pre>
                  </div>
                )}

                {selectedRun.logs && (
                  <div>
                    <span className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Logs</span>
                    <pre className="mt-1 max-h-60 overflow-auto rounded-lg bg-gray-50 p-3 text-xs text-gray-800 dark:bg-gray-800 dark:text-gray-200">
                      {formatJSON(selectedRun.logs)}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatJSON(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}
