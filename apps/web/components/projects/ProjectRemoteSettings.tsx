'use client';

import { useState, useEffect } from 'react';
import { ChevronRight, GitBranch, Loader2, Save, Settings2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { toast } from 'sonner';

interface Connection { id: string; name: string; type: string }
interface ADOProject  { id: string; name: string }
interface Repo        { id: string; name: string; defaultBranch?: string }
interface Branch      { name: string }

interface RemoteConfig {
  connectionId?: string | null;
  adoProjectName?: string | null;
  adoRepoName?: string | null;
  defaultBranch?: string | null;
}

interface Props {
  projectId: string;
  customerId?: string | null;
  current: RemoteConfig;
  onSaved: (config: RemoteConfig) => void;
}

export function ProjectRemoteSettings({ projectId, customerId, current, onSaved }: Props) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const [connections, setConnections] = useState<Connection[]>([]);
  const [adoProjects, setAdoProjects] = useState<ADOProject[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);

  const [selectedConnId, setSelectedConnId] = useState(current.connectionId ?? '');
  const [selectedADOProject, setSelectedADOProject] = useState(current.adoProjectName ?? '');
  const [selectedRepo, setSelectedRepo] = useState(current.adoRepoName ?? '');
  const [selectedBranch, setSelectedBranch] = useState(current.defaultBranch ?? '');

  const [loadingAdoProjects, setLoadingAdoProjects] = useState(false);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [loadingBranches, setLoadingBranches] = useState(false);

  // Load connections when panel opens
  useEffect(() => {
    if (!open || !customerId) return;
    api.get<{ data: { connections: Connection[] } }>(`/api/customers/${customerId}`)
      .then(r => setConnections(r.data.connections ?? []))
      .catch(() => toast.error('Failed to load connections'));
  }, [open, customerId]);

  // Load ADO projects when connection changes
  useEffect(() => {
    if (!selectedConnId || !open) return;
    const conn = connections.find(c => c.id === selectedConnId);
    if (!conn || conn.type !== 'azure-devops') return;
    setLoadingAdoProjects(true);
    setAdoProjects([]);
    setRepos([]);
    setBranches([]);
    api.get<{ data: ADOProject[] }>(`/api/remote/connections/${selectedConnId}/azure/projects`)
      .then(r => setAdoProjects(r.data))
      .catch(() => toast.error('Failed to load ADO projects'))
      .finally(() => setLoadingAdoProjects(false));
  }, [selectedConnId, connections, open]);

  // Load repos when ADO project changes
  useEffect(() => {
    if (!selectedConnId || !selectedADOProject || !open) return;
    setLoadingRepos(true);
    setRepos([]);
    setBranches([]);
    api.get<{ data: Repo[] }>(`/api/remote/connections/${selectedConnId}/azure/projects/${encodeURIComponent(selectedADOProject)}/repos`)
      .then(r => setRepos(r.data))
      .catch(() => toast.error('Failed to load repos'))
      .finally(() => setLoadingRepos(false));
  }, [selectedADOProject, selectedConnId, open]);

  // Load branches when repo changes
  useEffect(() => {
    if (!selectedConnId || !selectedADOProject || !selectedRepo || !open) return;
    setLoadingBranches(true);
    setBranches([]);
    api.get<{ data: Branch[] }>(`/api/remote/connections/${selectedConnId}/azure/projects/${encodeURIComponent(selectedADOProject)}/repos/${encodeURIComponent(selectedRepo)}/branches`)
      .then(r => {
        setBranches(r.data);
        // Auto-select default branch if not already set
        if (!selectedBranch && r.data.length > 0) {
          const repo = repos.find(r => r.name === selectedRepo);
          setSelectedBranch(repo?.defaultBranch ?? r.data[0]?.name ?? 'main');
        }
      })
      .catch(() => toast.error('Failed to load branches'))
      .finally(() => setLoadingBranches(false));
  }, [selectedRepo, selectedADOProject, selectedConnId, open]);

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/api/projects/${projectId}`, {
        connectionId: selectedConnId || null,
        adoProjectName: selectedADOProject || null,
        adoRepoName: selectedRepo || null,
        defaultBranch: selectedBranch || null,
      });
      onSaved({
        connectionId: selectedConnId || null,
        adoProjectName: selectedADOProject || null,
        adoRepoName: selectedRepo || null,
        defaultBranch: selectedBranch || null,
      });
      toast.success('Remote settings saved');
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  function clear() {
    setSelectedConnId('');
    setSelectedADOProject('');
    setSelectedRepo('');
    setSelectedBranch('');
  }

  const isConfigured = !!(current.connectionId && current.adoProjectName && current.adoRepoName);

  return (
    <>
      {/* Summary + edit button */}
      <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
            <GitBranch size={14} /> Remote Repository
          </h3>
          <button
            onClick={() => setOpen(true)}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-900/20"
          >
            <Settings2 size={12} /> Configure
          </button>
        </div>

        {isConfigured ? (
          <div className="space-y-1 text-xs text-gray-600 dark:text-gray-400">
            <div className="flex items-center gap-1">
              <ChevronRight size={11} className="text-gray-300" />
              <span className="font-medium text-gray-800 dark:text-gray-200">{current.adoProjectName}</span>
            </div>
            <div className="flex items-center gap-1">
              <ChevronRight size={11} className="text-gray-300" />
              <span>{current.adoRepoName}</span>
              {current.defaultBranch && (
                <span className="ml-1 rounded bg-green-50 px-1.5 py-0.5 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                  {current.defaultBranch}
                </span>
              )}
            </div>
          </div>
        ) : (
          <p className="text-xs text-gray-400 dark:text-gray-600">
            {customerId ? 'No repo configured — click Configure to pin a repository.' : 'Link project to a customer first.'}
          </p>
        )}
      </div>

      {/* Settings modal */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900">
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4 dark:border-gray-800">
              <h2 className="font-semibold text-gray-900 dark:text-white">Remote Repository Settings</h2>
              <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>

            <div className="space-y-4 p-5">
              {/* Connection */}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-gray-700 dark:text-gray-300">Connection</label>
                <select
                  value={selectedConnId}
                  onChange={e => { setSelectedConnId(e.target.value); setSelectedADOProject(''); setSelectedRepo(''); setSelectedBranch(''); }}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                >
                  <option value="">— select connection —</option>
                  {connections.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                {!customerId && <p className="mt-1 text-xs text-amber-500">Link this project to a customer to see connections.</p>}
              </div>

              {/* ADO Project */}
              {selectedConnId && (
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-gray-700 dark:text-gray-300">
                    Azure DevOps Project {loadingAdoProjects && <Loader2 size={11} className="inline animate-spin" />}
                  </label>
                  <select
                    value={selectedADOProject}
                    onChange={e => { setSelectedADOProject(e.target.value); setSelectedRepo(''); setSelectedBranch(''); }}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                    disabled={loadingAdoProjects}
                  >
                    <option value="">— select ADO project —</option>
                    {adoProjects.map(p => (
                      <option key={p.id} value={p.name}>{p.name}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Repo */}
              {selectedADOProject && (
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-gray-700 dark:text-gray-300">
                    Repository {loadingRepos && <Loader2 size={11} className="inline animate-spin" />}
                  </label>
                  <select
                    value={selectedRepo}
                    onChange={e => { setSelectedRepo(e.target.value); setSelectedBranch(''); }}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                    disabled={loadingRepos}
                  >
                    <option value="">— select repo —</option>
                    {repos.map(r => (
                      <option key={r.id} value={r.name}>{r.name}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Branch */}
              {selectedRepo && (
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-gray-700 dark:text-gray-300">
                    Default Branch {loadingBranches && <Loader2 size={11} className="inline animate-spin" />}
                  </label>
                  <select
                    value={selectedBranch}
                    onChange={e => setSelectedBranch(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                    disabled={loadingBranches}
                  >
                    <option value="">— select branch —</option>
                    {branches.map(b => (
                      <option key={b.name} value={b.name}>{b.name}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <div className="flex justify-between border-t border-gray-100 px-5 py-4 dark:border-gray-800">
              <button
                onClick={clear}
                className="text-xs text-gray-400 hover:text-red-500"
              >
                Clear settings
              </button>
              <div className="flex gap-2">
                <button onClick={() => setOpen(false)} className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-800">
                  Cancel
                </button>
                <button
                  onClick={save}
                  disabled={saving}
                  className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
