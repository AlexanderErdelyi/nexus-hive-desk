'use client';

import { useState, useEffect } from 'react';
import { GitBranch, Loader2, Pencil, Plus, Save, Trash2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { toast } from 'sonner';

interface Connection { id: string; name: string; type: string }
interface ADOProject  { id: string; name: string }
interface Repo        { id: string; name: string; defaultBranch?: string }
interface Branch      { name: string }

export interface ProjectRepo {
  id: string;
  label: string | null;
  connectionId: string;
  adoProjectName: string | null;
  repoName: string;
  defaultBranch: string | null;
}

interface Props {
  projectId: string;
  customerId?: string | null;
  repos: ProjectRepo[];
  onChanged: () => void;
}

interface RepoFormState {
  label: string;
  connectionId: string;
  adoProjectName: string;
  repoName: string;
  defaultBranch: string;
}

const EMPTY_FORM: RepoFormState = { label: '', connectionId: '', adoProjectName: '', repoName: '', defaultBranch: '' };

function RepoModal({
  open,
  title,
  projectId,
  customerId,
  initial,
  onClose,
  onSaved,
}: {
  open: boolean;
  title: string;
  projectId: string;
  customerId?: string | null;
  initial: RepoFormState & { id?: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<RepoFormState>(initial);
  const [saving, setSaving] = useState(false);

  const [connections, setConnections] = useState<Connection[]>([]);
  const [adoProjects, setAdoProjects] = useState<ADOProject[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);

  const [loadingAdoProjects, setLoadingAdoProjects] = useState(false);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [loadingBranches, setLoadingBranches] = useState(false);

  // Reset form when opened
  useEffect(() => {
    if (open) setForm(initial);
  }, [open]);

  // Load connections on open
  useEffect(() => {
    if (!open || !customerId) return;
    api.get<{ data: { connections: Connection[] } }>(`/api/customers/${customerId}`)
      .then(r => setConnections(r.data.connections ?? []))
      .catch(() => toast.error('Failed to load connections'));
  }, [open, customerId]);

  // Load ADO projects when connection changes
  useEffect(() => {
    if (!form.connectionId || !open) return;
    const conn = connections.find(c => c.id === form.connectionId);
    if (!conn || conn.type !== 'azure-devops') return;
    setLoadingAdoProjects(true);
    setAdoProjects([]); setRepos([]); setBranches([]);
    api.get<{ data: ADOProject[] }>(`/api/remote/connections/${form.connectionId}/azure/projects`)
      .then(r => setAdoProjects(r.data))
      .catch(() => toast.error('Failed to load ADO projects'))
      .finally(() => setLoadingAdoProjects(false));
  }, [form.connectionId, connections, open]);

  // Load repos when ADO project changes
  useEffect(() => {
    if (!form.connectionId || !form.adoProjectName || !open) return;
    setLoadingRepos(true); setRepos([]); setBranches([]);
    api.get<{ data: Repo[] }>(`/api/remote/connections/${form.connectionId}/azure/projects/${encodeURIComponent(form.adoProjectName)}/repos`)
      .then(r => setRepos(r.data))
      .catch(() => toast.error('Failed to load repos'))
      .finally(() => setLoadingRepos(false));
  }, [form.adoProjectName, form.connectionId, open]);

  // Load branches when repo changes
  useEffect(() => {
    if (!form.connectionId || !form.adoProjectName || !form.repoName || !open) return;
    setLoadingBranches(true); setBranches([]);
    api.get<{ data: Branch[] }>(`/api/remote/connections/${form.connectionId}/azure/projects/${encodeURIComponent(form.adoProjectName)}/repos/${encodeURIComponent(form.repoName)}/branches`)
      .then(r => {
        setBranches(r.data);
        if (!form.defaultBranch && r.data.length > 0) {
          const repoObj = repos.find(rr => rr.name === form.repoName);
          setForm(f => ({ ...f, defaultBranch: repoObj?.defaultBranch ?? r.data[0]?.name ?? 'main' }));
        }
      })
      .catch(() => toast.error('Failed to load branches'))
      .finally(() => setLoadingBranches(false));
  }, [form.repoName, form.adoProjectName, form.connectionId, open]);

  async function save() {
    if (!form.connectionId || !form.repoName) {
      toast.error('Connection and repository are required');
      return;
    }
    setSaving(true);
    try {
      const body = {
        label: form.label || null,
        connectionId: form.connectionId,
        adoProjectName: form.adoProjectName || null,
        repoName: form.repoName,
        defaultBranch: form.defaultBranch || null,
      };
      if (initial.id) {
        await api.patch(`/api/projects/${projectId}/repositories/${initial.id}`, body);
      } else {
        await api.post(`/api/projects/${projectId}/repositories`, body);
      }
      onSaved();
      onClose();
      toast.success(initial.id ? 'Repository updated' : 'Repository added');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  const selectedConn = connections.find(c => c.id === form.connectionId);
  const isADO = selectedConn?.type === 'azure-devops';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900">
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4 dark:border-gray-800">
          <h2 className="font-semibold text-gray-900 dark:text-white">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        <div className="space-y-4 p-5">
          {/* Label */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-gray-700 dark:text-gray-300">Label <span className="font-normal text-gray-400">(optional)</span></label>
            <input
              value={form.label}
              onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
              placeholder="e.g. Main Repo, Plugin Repo"
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            />
          </div>

          {/* Connection */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-gray-700 dark:text-gray-300">Connection</label>
            <select
              value={form.connectionId}
              onChange={e => setForm(f => ({ ...f, connectionId: e.target.value, adoProjectName: '', repoName: '', defaultBranch: '' }))}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            >
              <option value="">— select connection —</option>
              {connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {!customerId && <p className="mt-1 text-xs text-amber-500">Link project to a customer to see connections.</p>}
          </div>

          {/* ADO Project (only for Azure DevOps) */}
          {form.connectionId && isADO && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-gray-700 dark:text-gray-300">
                Azure DevOps Project {loadingAdoProjects && <Loader2 size={11} className="inline animate-spin" />}
              </label>
              <select
                value={form.adoProjectName}
                onChange={e => setForm(f => ({ ...f, adoProjectName: e.target.value, repoName: '', defaultBranch: '' }))}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                disabled={loadingAdoProjects}
              >
                <option value="">— select ADO project —</option>
                {adoProjects.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
              </select>
            </div>
          )}

          {/* Repo */}
          {(form.adoProjectName || (form.connectionId && !isADO)) && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-gray-700 dark:text-gray-300">
                Repository {loadingRepos && <Loader2 size={11} className="inline animate-spin" />}
              </label>
              <select
                value={form.repoName}
                onChange={e => setForm(f => ({ ...f, repoName: e.target.value, defaultBranch: '' }))}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                disabled={loadingRepos}
              >
                <option value="">— select repo —</option>
                {repos.map(r => <option key={r.id} value={r.name}>{r.name}</option>)}
              </select>
            </div>
          )}

          {/* Branch */}
          {form.repoName && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-gray-700 dark:text-gray-300">
                Default Branch {loadingBranches && <Loader2 size={11} className="inline animate-spin" />}
              </label>
              <select
                value={form.defaultBranch}
                onChange={e => setForm(f => ({ ...f, defaultBranch: e.target.value }))}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                disabled={loadingBranches}
              >
                <option value="">— select branch —</option>
                {branches.map(b => <option key={b.name} value={b.name}>{b.name}</option>)}
              </select>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-gray-100 px-5 py-4 dark:border-gray-800">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-800">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {initial.id ? 'Update' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ProjectRepositories({ projectId, customerId, repos, onChanged }: Props) {
  const [showModal, setShowModal] = useState(false);
  const [editTarget, setEditTarget] = useState<(RepoFormState & { id?: string }) | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  function openAdd() {
    setEditTarget({ ...EMPTY_FORM });
    setShowModal(true);
  }

  function openEdit(r: ProjectRepo) {
    setEditTarget({
      id: r.id,
      label: r.label ?? '',
      connectionId: r.connectionId,
      adoProjectName: r.adoProjectName ?? '',
      repoName: r.repoName,
      defaultBranch: r.defaultBranch ?? '',
    });
    setShowModal(true);
  }

  async function deleteRepo(id: string) {
    if (!confirm('Remove this repository? This will not affect XLIFF files already linked to it.')) return;
    setDeletingId(id);
    try {
      await api.delete(`/api/projects/${projectId}/repositories/${id}`);
      onChanged();
      toast.success('Repository removed');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 font-semibold text-gray-900 dark:text-white">
          <GitBranch size={16} className="text-indigo-500" /> Repositories
        </h3>
        <button
          onClick={openAdd}
          className="flex items-center gap-1 rounded-lg bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:text-indigo-400 dark:hover:bg-indigo-900/50"
        >
          <Plus size={13} /> Add Repo
        </button>
      </div>

      {repos.length === 0 ? (
        <p className="py-4 text-center text-sm text-gray-400 dark:text-gray-600">
          {customerId ? 'No repositories configured yet.' : 'Link project to a customer first.'}
        </p>
      ) : (
        <div className="space-y-2">
          {repos.map(r => (
            <div key={r.id} className="flex items-center justify-between rounded-lg border border-gray-100 p-3 dark:border-gray-800">
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-white">
                  {r.label || r.repoName}
                </p>
                <p className="text-xs text-gray-400 dark:text-gray-500">
                  {r.adoProjectName && <span>{r.adoProjectName} / </span>}
                  {r.repoName}
                  {r.defaultBranch && (
                    <span className="ml-1.5 rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs dark:bg-gray-800">
                      {r.defaultBranch}
                    </span>
                  )}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  onClick={() => openEdit(r)}
                  className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-300"
                >
                  <Pencil size={13} />
                </button>
                <button
                  onClick={() => deleteRepo(r.id)}
                  disabled={deletingId === r.id}
                  className="rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40 dark:hover:bg-red-900/20 dark:hover:text-red-400"
                >
                  {deletingId === r.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showModal && editTarget && (
        <RepoModal
          open={showModal}
          title={editTarget.id ? 'Edit Repository' : 'Add Repository'}
          projectId={projectId}
          customerId={customerId}
          initial={editTarget}
          onClose={() => setShowModal(false)}
          onSaved={onChanged}
        />
      )}
    </div>
  );
}
