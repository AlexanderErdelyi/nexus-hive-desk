'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import {
  Key,
  Plus,
  Trash2,
  Pencil,
  AlertTriangle,
  CheckCircle,
  X,
  Loader2,
  Shield,
} from 'lucide-react';

interface UserToken {
  id: string;
  provider: 'github' | 'azuredevops';
  scopeType: 'global' | 'customer' | 'project';
  scopeId: string | null;
  label: string;
  baseUrl: string | null;
  maskedToken: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Customer {
  id: string;
  name: string;
}

interface Project {
  id: string;
  name: string;
}

function getExpiryStatus(expiresAt: string | null): 'ok' | 'warning' | 'expired' | 'none' {
  if (!expiresAt) return 'none';
  const exp = new Date(expiresAt);
  const now = new Date();
  if (exp <= now) return 'expired';
  const daysLeft = (exp.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
  if (daysLeft <= 14) return 'warning';
  return 'ok';
}

function ExpiryBadge({ expiresAt }: { expiresAt: string | null }) {
  const status = getExpiryStatus(expiresAt);
  if (status === 'none') return null;
  if (status === 'expired') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400">
        <AlertTriangle size={10} /> Expired
      </span>
    );
  }
  if (status === 'warning') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-2 py-0.5 text-[10px] font-medium text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">
        <AlertTriangle size={10} /> Expiring soon
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
      <CheckCircle size={10} /> Valid
    </span>
  );
}

function ProviderBadge({ provider }: { provider: string }) {
  const isGitHub = provider === 'github';
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${
        isGitHub
          ? 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
          : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
      }`}
    >
      {isGitHub ? 'GitHub' : 'Azure DevOps'}
    </span>
  );
}

function ScopeBadge({ scopeType, scopeId }: { scopeType: string; scopeId: string | null }) {
  return (
    <span className="inline-block rounded bg-purple-100 px-1.5 py-0.5 text-[10px] font-medium text-purple-700 dark:bg-purple-900/30 dark:text-purple-400">
      {scopeType === 'global' ? 'Global' : scopeType === 'customer' ? 'Customer' : 'Project'}
      {scopeId && ` • ${scopeId.slice(0, 8)}…`}
    </span>
  );
}

// ─── Add Token Form ──────────────────────────────────────────────────────────
function AddTokenForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    provider: 'github' as 'github' | 'azuredevops',
    scopeType: 'global' as 'global' | 'customer' | 'project',
    scopeId: '',
    token: '',
    label: '',
    baseUrl: '',
    expiresAt: '',
  });

  // Fetch customers and projects for scope selection
  const { data: customersData } = useQuery({
    queryKey: ['customers'],
    queryFn: () => api.get<{ data: Customer[] }>('/api/customers'),
    enabled: form.scopeType === 'customer',
  });

  const { data: projectsData } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<{ data: Project[] }>('/api/projects'),
    enabled: form.scopeType === 'project',
  });

  const mutation = useMutation({
    mutationFn: () =>
      api.post('/api/user/tokens', {
        provider: form.provider,
        scopeType: form.scopeType,
        scopeId: form.scopeType !== 'global' ? form.scopeId : undefined,
        token: form.token,
        label: form.label,
        baseUrl: form.provider === 'azuredevops' ? form.baseUrl : undefined,
        expiresAt: form.expiresAt || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-tokens'] });
      toast.success('Token saved');
      onDone();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Failed to save token'),
  });

  const isValid =
    form.label.trim() &&
    form.token.trim() &&
    (form.scopeType === 'global' || form.scopeId.trim()) &&
    (form.provider !== 'azuredevops' || form.baseUrl.trim());

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="font-semibold text-gray-900 dark:text-white">Add Token</h4>
        <button onClick={onDone} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
          <X size={16} />
        </button>
      </div>
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
            Provider
          </label>
          <select
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            value={form.provider}
            onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value as 'github' | 'azuredevops' }))}
          >
            <option value="github">GitHub</option>
            <option value="azuredevops">Azure DevOps</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
            Label *
          </label>
          <input
            type="text"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            value={form.label}
            onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
            placeholder="e.g. My GitHub (Nobilis)"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
            Scope
          </label>
          <select
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            value={form.scopeType}
            onChange={(e) =>
              setForm((f) => ({ ...f, scopeType: e.target.value as 'global' | 'customer' | 'project', scopeId: '' }))
            }
          >
            <option value="global">Global</option>
            <option value="customer">Customer</option>
            <option value="project">Project</option>
          </select>
        </div>
        {form.scopeType === 'customer' && (
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Customer *
            </label>
            <select
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              value={form.scopeId}
              onChange={(e) => setForm((f) => ({ ...f, scopeId: e.target.value }))}
            >
              <option value="">Select customer…</option>
              {customersData?.data?.map((c: Customer) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {form.scopeType === 'project' && (
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Project *
            </label>
            <select
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              value={form.scopeId}
              onChange={(e) => setForm((f) => ({ ...f, scopeId: e.target.value }))}
            >
              <option value="">Select project…</option>
              {projectsData?.data?.map((p: Project) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {form.provider === 'azuredevops' && (
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Organization URL *
            </label>
            <input
              type="text"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              value={form.baseUrl}
              onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
              placeholder="https://dev.azure.com/myorg"
            />
          </div>
        )}
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
            Personal Access Token *
          </label>
          <input
            type="password"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            value={form.token}
            onChange={(e) => setForm((f) => ({ ...f, token: e.target.value }))}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {form.provider === 'github'
              ? 'Required scopes: repo, workflow'
              : 'Required scopes: Code (Read & Write), Work Items (Read)'}
          </p>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
            Expiry date (optional)
          </label>
          <input
            type="date"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            value={form.expiresAt}
            onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value }))}
          />
        </div>
        <button
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending || !isValid}
          className="w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {mutation.isPending ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" /> Validating & Saving…
            </span>
          ) : (
            'Save Token'
          )}
        </button>
      </div>
    </div>
  );
}

// ─── Edit Token Form ─────────────────────────────────────────────────────────
function EditTokenForm({ token, onDone }: { token: UserToken; onDone: () => void }) {
  const qc = useQueryClient();
  const [label, setLabel] = useState(token.label);
  const [expiresAt, setExpiresAt] = useState(
    token.expiresAt ? new Date(token.expiresAt).toISOString().slice(0, 10) : ''
  );

  const mutation = useMutation({
    mutationFn: () =>
      api.patch(`/api/user/tokens/${token.id}`, {
        label,
        expiresAt: expiresAt || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-tokens'] });
      toast.success('Token updated');
      onDone();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Failed to update token'),
  });

  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-800 dark:bg-indigo-950/30">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-white">Edit Token</h4>
        <button onClick={onDone} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
          <X size={14} />
        </button>
      </div>
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Label</label>
          <input
            type="text"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
            Expiry date
          </label>
          <input
            type="date"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !label.trim()}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {mutation.isPending ? <Loader2 size={14} className="animate-spin" /> : 'Save'}
          </button>
          <button
            onClick={onDone}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────
export function UserTokens() {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['user-tokens'],
    queryFn: () => api.get<{ data: UserToken[] }>('/api/user/tokens'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/user/tokens/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-tokens'] });
      toast.success('Token deleted');
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Failed to delete'),
  });

  const tokens = data?.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-100 dark:bg-indigo-900/30">
            <Shield size={20} className="text-indigo-600 dark:text-indigo-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              Personal Access Tokens
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Manage your tokens for GitHub and Azure DevOps
            </p>
          </div>
        </div>
        {!showAdd && (
          <button
            onClick={() => setShowAdd(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            <Plus size={14} /> Add Token
          </button>
        )}
      </div>

      {showAdd && <AddTokenForm onDone={() => setShowAdd(false)} />}

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={24} className="animate-spin text-gray-400" />
        </div>
      ) : tokens.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 px-6 py-12 text-center dark:border-gray-700 dark:bg-gray-900">
          <Key size={32} className="mx-auto mb-3 text-gray-400" />
          <p className="text-sm font-medium text-gray-600 dark:text-gray-400">No tokens saved yet</p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-500">
            Add a Personal Access Token to connect to GitHub or Azure DevOps
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {tokens.map((token) => (
            <div key={token.id}>
              {editingId === token.id ? (
                <EditTokenForm token={token} onDone={() => setEditingId(null)} />
              ) : (
                <div className="flex items-center justify-between rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-gray-900 dark:text-white">{token.label}</p>
                      <ProviderBadge provider={token.provider} />
                      <ScopeBadge scopeType={token.scopeType} scopeId={token.scopeId} />
                      <ExpiryBadge expiresAt={token.expiresAt} />
                    </div>
                    <p className="mt-1 font-mono text-xs text-gray-500 dark:text-gray-400">
                      {token.maskedToken}
                    </p>
                    {token.baseUrl && (
                      <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">{token.baseUrl}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setEditingId(token.id)}
                      className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
                      title="Edit"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => {
                        if (confirm('Delete this token? This cannot be undone.')) {
                          deleteMutation.mutate(token.id);
                        }
                      }}
                      disabled={deleteMutation.isPending}
                      className="rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-400"
                      title="Delete"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 dark:border-yellow-900/50 dark:bg-yellow-900/10">
        <div className="flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5 text-yellow-600 dark:text-yellow-400" />
          <div className="text-xs text-yellow-700 dark:text-yellow-300">
            <p className="font-medium">Security</p>
            <p className="mt-1">
              Tokens are encrypted at rest (AES-256-GCM). They are never displayed in full after saving.
              When multiple tokens match a provider, the most specific scope wins (project → customer → global).
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
