'use client';

import { useState, useEffect } from 'react';
import { Building2, Loader2, Save, Settings2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { toast } from 'sonner';

interface Connection { id: string; name: string; type: string }
interface ADOProject  { id: string; name: string }

interface ADOAccessConfig {
  connectionId?: string | null;
  adoProjectName?: string | null;
  adoAccessScope?: string; // 'org' | 'project'
}

interface Props {
  projectId: string;
  customerId?: string | null;
  current: ADOAccessConfig;
  onSaved: (config: ADOAccessConfig) => void;
}

export function ProjectADOAccess({ projectId, customerId, current, onSaved }: Props) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const [connections, setConnections] = useState<Connection[]>([]);
  const [adoProjects, setAdoProjects] = useState<ADOProject[]>([]);
  const [loadingAdoProjects, setLoadingAdoProjects] = useState(false);

  const [selectedConnId, setSelectedConnId] = useState(current.connectionId ?? '');
  const [accessScope, setAccessScope] = useState<'org' | 'project'>(
    (current.adoAccessScope as 'org' | 'project') ?? 'org'
  );
  const [selectedProject, setSelectedProject] = useState(current.adoProjectName ?? '');

  // Re-sync when current changes
  useEffect(() => {
    setSelectedConnId(current.connectionId ?? '');
    setAccessScope((current.adoAccessScope as 'org' | 'project') ?? 'org');
    setSelectedProject(current.adoProjectName ?? '');
  }, [current.connectionId, current.adoAccessScope, current.adoProjectName]);

  // Load connections
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
    api.get<{ data: ADOProject[] }>(`/api/remote/connections/${selectedConnId}/azure/projects`)
      .then(r => setAdoProjects(r.data))
      .catch(() => toast.error('Failed to load ADO projects'))
      .finally(() => setLoadingAdoProjects(false));
  }, [selectedConnId, connections, open]);

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/api/projects/${projectId}/ado-access`, {
        connectionId: selectedConnId || null,
        adoProjectName: accessScope === 'project' ? (selectedProject || null) : null,
        adoAccessScope: accessScope,
      });
      const cfg: ADOAccessConfig = {
        connectionId: selectedConnId || null,
        adoProjectName: accessScope === 'project' ? (selectedProject || null) : null,
        adoAccessScope: accessScope,
      };
      onSaved(cfg);
      toast.success('DevOps access settings saved');
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  function clear() {
    setSelectedConnId('');
    setAccessScope('org');
    setSelectedProject('');
  }

  const isConfigured = !!(current.connectionId);
  const connName = connections.find(c => c.id === current.connectionId)?.name;

  return (
    <>
      <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 font-semibold text-gray-900 dark:text-white">
            <Building2 size={16} className="text-sky-500" /> Azure DevOps Access
          </h3>
          <button
            onClick={() => setOpen(true)}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-900/20"
          >
            <Settings2 size={12} /> Configure
          </button>
        </div>

        <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
          Configure the DevOps connection used for Work Items, CI/CD, and other project-level features.
        </p>

        {isConfigured ? (
          <div className="space-y-1.5 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-gray-500 dark:text-gray-400">Connection:</span>
              <span className="font-medium text-gray-900 dark:text-white">{connName ?? current.connectionId}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-gray-500 dark:text-gray-400">Scope:</span>
              {current.adoAccessScope === 'project' && current.adoProjectName ? (
                <span className="rounded bg-sky-50 px-2 py-0.5 font-medium text-sky-700 dark:bg-sky-900/30 dark:text-sky-400">
                  Project: {current.adoProjectName}
                </span>
              ) : (
                <span className="rounded bg-gray-100 px-2 py-0.5 text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                  Entire organisation
                </span>
              )}
            </div>
          </div>
        ) : (
          <p className="text-xs text-gray-400 dark:text-gray-600">
            {customerId ? 'Not configured — click Configure to set up.' : 'Link project to a customer first.'}
          </p>
        )}
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900">
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4 dark:border-gray-800">
              <h2 className="font-semibold text-gray-900 dark:text-white">Azure DevOps Access</h2>
              <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
            </div>

            <div className="space-y-5 p-5">
              {/* Connection */}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-gray-700 dark:text-gray-300">Connection</label>
                <select
                  value={selectedConnId}
                  onChange={e => { setSelectedConnId(e.target.value); setSelectedProject(''); }}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                >
                  <option value="">— select connection —</option>
                  {connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                {!customerId && <p className="mt-1 text-xs text-amber-500">Link project to a customer to see connections.</p>}
              </div>

              {/* Access scope */}
              {selectedConnId && (
                <div>
                  <label className="mb-2 block text-xs font-medium text-gray-700 dark:text-gray-300">Access Scope</label>
                  <div className="space-y-2">
                    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-gray-200 p-3 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800">
                      <input
                        type="radio"
                        name="accessScope"
                        value="org"
                        checked={accessScope === 'org'}
                        onChange={() => { setAccessScope('org'); setSelectedProject(''); }}
                        className="mt-0.5"
                      />
                      <div>
                        <p className="text-sm font-medium text-gray-900 dark:text-white">Entire organisation</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">Access all projects within the connected Azure DevOps organisation.</p>
                      </div>
                    </label>
                    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-gray-200 p-3 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800">
                      <input
                        type="radio"
                        name="accessScope"
                        value="project"
                        checked={accessScope === 'project'}
                        onChange={() => setAccessScope('project')}
                        className="mt-0.5"
                      />
                      <div>
                        <p className="text-sm font-medium text-gray-900 dark:text-white">Specific project</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">Restrict access to one Azure DevOps project only.</p>
                      </div>
                    </label>
                  </div>
                </div>
              )}

              {/* ADO Project picker (only for 'project' scope) */}
              {selectedConnId && accessScope === 'project' && (
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-gray-700 dark:text-gray-300">
                    Azure DevOps Project {loadingAdoProjects && <Loader2 size={11} className="inline animate-spin" />}
                  </label>
                  <select
                    value={selectedProject}
                    onChange={e => setSelectedProject(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                    disabled={loadingAdoProjects}
                  >
                    <option value="">— select project —</option>
                    {adoProjects.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
                  </select>
                </div>
              )}
            </div>

            <div className="flex justify-between border-t border-gray-100 px-5 py-4 dark:border-gray-800">
              <button onClick={clear} className="text-xs text-gray-400 hover:text-red-500">Clear settings</button>
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
