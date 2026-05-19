'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CheckCircle,
  ChevronRight,
  File,
  Folder,
  GitBranch,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { CustomerMembers } from './CustomerMembers';

interface Connection {
  id: string;
  customerId: string;
  type: 'azure-devops' | 'github';
  name: string;
  baseUrl?: string;
  createdAt: string;
}

interface Customer {
  id: string;
  name: string;
  description?: string;
  connections: Connection[];
  projects: Array<{ id: string; name: string; sourceLanguage: string; targetLanguage: string }>;
}

interface RemoteProject {
  id: string;
  name: string;
  description?: string;
}

interface RemoteRepo {
  id: string;
  name: string;
  defaultBranch?: string;
}

interface RemoteBranch {
  name: string;
}

interface RemoteFile {
  path: string;
  name: string;
  type: 'file' | 'directory';
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Request failed';
}

// ─── Connection Form ──────────────────────────────────────────────────────────

function AddConnectionForm({
  customerId,
  onDone,
}: {
  customerId: string;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    type: 'azure-devops' as 'azure-devops' | 'github',
    name: '',
    baseUrl: '',
    pat: '',
  });

  const mutation = useMutation({
    mutationFn: () =>
      api.post(`/api/customers/${customerId}/connections`, {
        type: form.type,
        name: form.name,
        baseUrl: form.type === 'azure-devops' ? form.baseUrl : undefined,
        pat: form.pat,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customer', customerId] });
      toast.success('Connection added');
      onDone();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
      <h4 className="mb-3 font-semibold text-gray-900 dark:text-white">Add Connection</h4>
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Type</label>
          <select
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            value={form.type}
            onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as 'azure-devops' | 'github' }))}
          >
            <option value="azure-devops">Azure DevOps</option>
            <option value="github">GitHub</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Display Name *</label>
          <input
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder={form.type === 'azure-devops' ? 'My Azure Org' : 'GitHub Account'}
          />
        </div>
        {form.type === 'azure-devops' && (
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Organization URL *
            </label>
            <input
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
            value={form.pat}
            onChange={(e) => setForm((f) => ({ ...f, pat: e.target.value }))}
          />
        </div>
      </div>
      <div className="mt-4 flex gap-3">
        <button
          onClick={() => mutation.mutate()}
          disabled={!form.name || !form.pat || (form.type === 'azure-devops' && !form.baseUrl) || mutation.isPending}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {mutation.isPending ? 'Adding...' : 'Add Connection'}
        </button>
        <button
          onClick={onDone}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Remote Repository Browser ────────────────────────────────────────────────

function RemoteBrowser({
  connection,
  customerId,
  projects,
}: {
  connection: Connection;
  customerId: string;
  projects: Array<{ id: string; name: string; sourceLanguage: string; targetLanguage: string }>;
}) {
  const qc = useQueryClient();
  const isAzure = connection.type === 'azure-devops';

  // Navigation state
  const [selectedProject, setSelectedProject] = useState<RemoteProject | null>(null);
  const [selectedRepo, setSelectedRepo] = useState<RemoteRepo | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<string>('');
  const [currentPath, setCurrentPath] = useState<string>('');
  const [pathHistory, setPathHistory] = useState<string[]>([]);

  // Import state
  const [importing, setImporting] = useState(false);
  const [targetProjectId, setTargetProjectId] = useState<string>('');

  // Commit state
  const [committing, setCommitting] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');

  // New branch state
  const [showNewBranch, setShowNewBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [creatingBranch, setCreatingBranch] = useState(false);

  // ─── Azure DevOps queries ─────────────────────────────────────────────────
  const azureProjects = useQuery({
    queryKey: ['azure-projects', connection.id],
    queryFn: () => api.get<{ data: RemoteProject[] }>(`/api/remote/connections/${connection.id}/azure/projects`),
    enabled: isAzure,
  });

  const azureRepos = useQuery({
    queryKey: ['azure-repos', connection.id, selectedProject?.name],
    queryFn: () =>
      api.get<{ data: RemoteRepo[] }>(
        `/api/remote/connections/${connection.id}/azure/projects/${encodeURIComponent(selectedProject!.name)}/repos`
      ),
    enabled: isAzure && !!selectedProject,
  });

  const azureBranches = useQuery({
    queryKey: ['azure-branches', connection.id, selectedProject?.name, selectedRepo?.id],
    queryFn: () =>
      api.get<{ data: RemoteBranch[] }>(
        `/api/remote/connections/${connection.id}/azure/projects/${encodeURIComponent(selectedProject!.name)}/repos/${encodeURIComponent(selectedRepo!.id)}/branches`
      ),
    enabled: isAzure && !!selectedProject && !!selectedRepo,
  });

  const azureFiles = useQuery({
    queryKey: ['azure-files', connection.id, selectedProject?.name, selectedRepo?.id, selectedBranch, currentPath],
    queryFn: () => {
      const params = new URLSearchParams();
      if (selectedBranch) params.set('branch', selectedBranch);
      if (currentPath) params.set('path', currentPath);
      return api.get<{ data: RemoteFile[] }>(
        `/api/remote/connections/${connection.id}/azure/projects/${encodeURIComponent(selectedProject!.name)}/repos/${encodeURIComponent(selectedRepo!.id)}/files?${params}`
      );
    },
    enabled: isAzure && !!selectedProject && !!selectedRepo && !!selectedBranch,
  });

  // ─── GitHub queries ───────────────────────────────────────────────────────
  const githubRepos = useQuery({
    queryKey: ['github-repos', connection.id],
    queryFn: () => api.get<{ data: RemoteRepo[] }>(`/api/remote/connections/${connection.id}/github/repos`),
    enabled: !isAzure,
  });

  const repoOwner = selectedRepo?.name.split('/')[0] ?? '';
  const repoName = selectedRepo?.name.split('/')[1] ?? '';

  const githubBranches = useQuery({
    queryKey: ['github-branches', connection.id, selectedRepo?.name],
    queryFn: () =>
      api.get<{ data: RemoteBranch[] }>(
        `/api/remote/connections/${connection.id}/github/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/branches`
      ),
    enabled: !isAzure && !!selectedRepo,
  });

  const githubFiles = useQuery({
    queryKey: ['github-files', connection.id, selectedRepo?.name, selectedBranch, currentPath],
    queryFn: () => {
      const params = new URLSearchParams();
      if (selectedBranch) params.set('branch', selectedBranch);
      if (currentPath) params.set('path', currentPath);
      return api.get<{ data: RemoteFile[] }>(
        `/api/remote/connections/${connection.id}/github/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/files?${params}`
      );
    },
    enabled: !isAzure && !!selectedRepo && !!selectedBranch,
  });

  // ─── Derived data ─────────────────────────────────────────────────────────
  const remoteProjects = isAzure ? azureProjects.data?.data ?? [] : [];
  const repos = isAzure ? azureRepos.data?.data ?? [] : githubRepos.data?.data ?? [];
  const branches = isAzure ? azureBranches.data?.data ?? [] : githubBranches.data?.data ?? [];
  const files = isAzure ? azureFiles.data?.data ?? [] : githubFiles.data?.data ?? [];
  const isLoadingFiles = isAzure ? azureFiles.isLoading : githubFiles.isLoading;

  // ─── Navigation ───────────────────────────────────────────────────────────
  const navigateToDir = (path: string) => {
    setPathHistory((h) => [...h, currentPath]);
    setCurrentPath(path);
  };

  const navigateBack = () => {
    const prev = pathHistory[pathHistory.length - 1] ?? '';
    setPathHistory((h) => h.slice(0, -1));
    setCurrentPath(prev);
  };

  // ─── Import XLIFF from remote ─────────────────────────────────────────────
  const importXliff = async (filePath: string) => {
    if (!targetProjectId) {
      toast.error('Please select a target project first');
      return;
    }

    setImporting(true);
    try {
      // Fetch file content
      let fileContent: { content: string; sha?: string; objectId?: string };

      if (isAzure) {
        const params = new URLSearchParams({ path: filePath });
        if (selectedBranch) params.set('branch', selectedBranch);
        const res = await api.get<{ data: { content: string; objectId?: string } }>(
          `/api/remote/connections/${connection.id}/azure/projects/${encodeURIComponent(selectedProject!.name)}/repos/${encodeURIComponent(selectedRepo!.id)}/file-content?${params}`
        );
        fileContent = res.data;
      } else {
        const params = new URLSearchParams({ path: filePath });
        if (selectedBranch) params.set('branch', selectedBranch);
        const res = await api.get<{ data: { content: string; sha?: string } }>(
          `/api/remote/connections/${connection.id}/github/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/file-content?${params}`
        );
        fileContent = res.data;
      }

      // Upload to project as XLIFF
      const filename = filePath.split('/').pop() ?? filePath;
      const blob = new Blob([fileContent.content], { type: 'application/xml' });
      const formData = new FormData();
      formData.append('file', blob, filename);

      const result = await api.upload<{ data: { xliffFile: { id: string }; stats: { total: number } } }>(
        `/api/projects/${targetProjectId}/xliff`,
        formData
      );

      // Save remote source info so we can commit back later
      const remoteRepo = isAzure
        ? `${connection.name}/${selectedProject!.name}/${selectedRepo!.id}`
        : selectedRepo!.name;

      await api.patch(`/api/projects/${targetProjectId}/xliff/${result.data.xliffFile.id}/remote`, {
        remoteConnectionId: connection.id,
        remotePath: filePath,
        remoteBranch: selectedBranch,
        remoteRepo,
      });

      toast.success(`Imported ${filename} — ${result.data.stats.total} strings`);
      qc.invalidateQueries({ queryKey: ['project', targetProjectId] });
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setImporting(false);
    }
  };

  // ─── Create branch ────────────────────────────────────────────────────────
  const createBranch = async () => {
    if (!newBranchName || !selectedBranch) return;
    setCreatingBranch(true);
    try {
      if (isAzure) {
        await api.post(
          `/api/remote/connections/${connection.id}/azure/projects/${encodeURIComponent(selectedProject!.name)}/repos/${encodeURIComponent(selectedRepo!.id)}/branches`,
          { name: newBranchName, sourceBranch: selectedBranch }
        );
      } else {
        await api.post(
          `/api/remote/connections/${connection.id}/github/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/branches`,
          { name: newBranchName, sourceBranch: selectedBranch }
        );
      }

      toast.success(`Branch '${newBranchName}' created`);
      setSelectedBranch(newBranchName);
      setShowNewBranch(false);
      setNewBranchName('');

      // Refresh branches
      if (isAzure) {
        qc.invalidateQueries({ queryKey: ['azure-branches', connection.id] });
      } else {
        qc.invalidateQueries({ queryKey: ['github-branches', connection.id] });
      }
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setCreatingBranch(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Breadcrumb navigation */}
      <div className="flex flex-wrap items-center gap-1 text-sm text-gray-500 dark:text-gray-400">
        <span className="font-medium text-gray-700 dark:text-gray-300">{connection.name}</span>
        {isAzure && selectedProject && (
          <>
            <ChevronRight size={14} />
            <button
              onClick={() => {
                setSelectedRepo(null);
                setSelectedBranch('');
                setCurrentPath('');
                setPathHistory([]);
              }}
              className="hover:text-indigo-600 dark:hover:text-indigo-400"
            >
              {selectedProject.name}
            </button>
          </>
        )}
        {selectedRepo && (
          <>
            <ChevronRight size={14} />
            <button
              onClick={() => {
                setSelectedBranch('');
                setCurrentPath('');
                setPathHistory([]);
              }}
              className="hover:text-indigo-600 dark:hover:text-indigo-400"
            >
              {selectedRepo.name}
            </button>
          </>
        )}
        {selectedBranch && (
          <>
            <ChevronRight size={14} />
            <span className="flex items-center gap-1 text-indigo-600 dark:text-indigo-400">
              <GitBranch size={12} /> {selectedBranch}
            </span>
          </>
        )}
      </div>

      {/* Step 1: Azure DevOps - select project */}
      {isAzure && !selectedProject && (
        <div>
          <h4 className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">Select Project</h4>
          {azureProjects.isLoading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-gray-400">
              <Loader2 size={16} className="animate-spin" /> Loading projects...
            </div>
          ) : (
            <div className="space-y-1">
              {remoteProjects.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setSelectedProject(p)}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  <Folder size={16} className="text-blue-500" />
                  <span className="text-gray-900 dark:text-white">{p.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Step 2: Select repo */}
      {(isAzure ? !!selectedProject : true) && !selectedRepo && (
        <div>
          <h4 className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">Select Repository</h4>
          {(isAzure ? azureRepos.isLoading : githubRepos.isLoading) ? (
            <div className="flex items-center gap-2 py-4 text-sm text-gray-400">
              <Loader2 size={16} className="animate-spin" /> Loading repos...
            </div>
          ) : (
            <div className="space-y-1">
              {repos.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setSelectedRepo(r)}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  <GitBranch size={16} className="text-green-500" />
                  <span className="text-gray-900 dark:text-white">{r.name}</span>
                  {r.defaultBranch && (
                    <span className="text-xs text-gray-400">({r.defaultBranch})</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Step 3: Select branch */}
      {selectedRepo && !selectedBranch && (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">Select Branch</h4>
            <button
              onClick={() => setShowNewBranch(true)}
              className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
            >
              <Plus size={12} /> New Branch
            </button>
          </div>

          {showNewBranch && (
            <div className="mb-3 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800">
              <div className="space-y-2">
                <input
                  className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                  placeholder="new-branch-name"
                  value={newBranchName}
                  onChange={(e) => setNewBranchName(e.target.value)}
                />
                <p className="text-xs text-gray-500">
                  Will branch from: <strong>{selectedRepo.defaultBranch ?? 'main'}</strong>
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setSelectedBranch(selectedRepo.defaultBranch ?? 'main');
                      createBranch();
                    }}
                    disabled={!newBranchName || creatingBranch}
                    className="rounded bg-indigo-600 px-3 py-1 text-xs text-white hover:bg-indigo-700 disabled:opacity-50"
                  >
                    {creatingBranch ? 'Creating...' : 'Create'}
                  </button>
                  <button
                    onClick={() => setShowNewBranch(false)}
                    className="rounded border border-gray-300 px-3 py-1 text-xs dark:border-gray-600 dark:text-gray-300"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}

          {(isAzure ? azureBranches.isLoading : githubBranches.isLoading) ? (
            <div className="flex items-center gap-2 py-4 text-sm text-gray-400">
              <Loader2 size={16} className="animate-spin" /> Loading branches...
            </div>
          ) : (
            <div className="space-y-1">
              {branches.map((b) => (
                <button
                  key={b.name}
                  onClick={() => {
                    setSelectedBranch(b.name);
                    setCurrentPath('');
                    setPathHistory([]);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  <GitBranch size={14} className="text-purple-500" />
                  <span className="text-gray-900 dark:text-white">{b.name}</span>
                  {b.name === selectedRepo.defaultBranch && (
                    <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] text-green-700 dark:bg-green-900/30 dark:text-green-400">
                      default
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Step 4: Browse files */}
      {selectedBranch && (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Files {currentPath && <span className="font-mono text-xs text-gray-400">/{currentPath}</span>}
            </h4>
            <div className="flex items-center gap-2">
              {/* Target project selector */}
              <select
                className="rounded-lg border border-gray-300 px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                value={targetProjectId}
                onChange={(e) => setTargetProjectId(e.target.value)}
              >
                <option value="">Import to project...</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {currentPath && (
            <button
              onClick={navigateBack}
              className="mb-1 flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-800"
            >
              <ArrowLeft size={12} /> Back
            </button>
          )}

          {isLoadingFiles ? (
            <div className="flex items-center gap-2 py-4 text-sm text-gray-400">
              <Loader2 size={16} className="animate-spin" /> Loading files...
            </div>
          ) : (
            <div className="space-y-0.5">
              {/* Directories first, then files */}
              {[...files]
                .sort((a, b) => {
                  if (a.type === b.type) return a.name.localeCompare(b.name);
                  return a.type === 'directory' ? -1 : 1;
                })
                .map((f) => {
                  const isXliff = f.name.endsWith('.xlf') || f.name.endsWith('.xliff');
                  return (
                    <div
                      key={f.path}
                      className="flex items-center justify-between rounded-lg px-3 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-800"
                    >
                      <button
                        onClick={() => {
                          if (f.type === 'directory') {
                            navigateToDir(f.path);
                          }
                        }}
                        className={`flex items-center gap-2 text-sm ${
                          f.type === 'directory' ? 'cursor-pointer' : 'cursor-default'
                        }`}
                      >
                        {f.type === 'directory' ? (
                          <Folder size={14} className="text-blue-500" />
                        ) : (
                          <File size={14} className={isXliff ? 'text-amber-500' : 'text-gray-400'} />
                        )}
                        <span className={`text-gray-900 dark:text-white ${isXliff ? 'font-medium' : ''}`}>
                          {f.name}
                        </span>
                        {isXliff && (
                          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                            XLIFF
                          </span>
                        )}
                      </button>
                      {isXliff && (
                        <button
                          onClick={() => importXliff(f.path)}
                          disabled={importing || !targetProjectId}
                          className="flex items-center gap-1 rounded bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 dark:bg-indigo-900/30 dark:text-indigo-400 dark:hover:bg-indigo-900/50"
                        >
                          {importing ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <Upload size={12} />
                          )}
                          Import
                        </button>
                      )}
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Customer Detail Component ──────────────────────────────────────────

export function CustomerDetail({ customerId }: { customerId: string }) {
  const qc = useQueryClient();
  const [showAddConn, setShowAddConn] = useState(false);
  const [selectedConnId, setSelectedConnId] = useState<string | null>(null);
  const [testingConn, setTestingConn] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, 'ok' | 'fail'>>({});

  const { data, isLoading } = useQuery({
    queryKey: ['customer', customerId],
    queryFn: () => api.get<{ data: Customer }>(`/api/customers/${customerId}`),
  });

  const deleteConnMutation = useMutation({
    mutationFn: (connId: string) => api.delete(`/api/customers/${customerId}/connections/${connId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customer', customerId] });
      toast.success('Connection removed');
    },
  });

  const testConnection = async (connId: string) => {
    setTestingConn(connId);
    try {
      await api.post(`/api/customers/${customerId}/connections/${connId}/test`, {});
      setTestResults((r) => ({ ...r, [connId]: 'ok' }));
      toast.success('Connection successful!');
    } catch {
      setTestResults((r) => ({ ...r, [connId]: 'fail' }));
      toast.error('Connection failed');
    } finally {
      setTestingConn(null);
    }
  };

  const customer = data?.data;

  if (isLoading) return <div className="py-12 text-center text-gray-400">Loading...</div>;
  if (!customer) return <div className="py-12 text-center text-red-500">Customer not found</div>;

  const selectedConnection = customer.connections.find((c) => c.id === selectedConnId);

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <Link href="/customers" className="text-gray-400 hover:text-gray-600 dark:text-gray-600 dark:hover:text-gray-300">
          <ArrowLeft size={20} />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{customer.name}</h1>
          {customer.description && (
            <p className="text-sm text-gray-500 dark:text-gray-400">{customer.description}</p>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left: Connections */}
        <div className="space-y-4 lg:col-span-1">
          <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-semibold text-gray-900 dark:text-white">Connections</h3>
              <button
                onClick={() => setShowAddConn(true)}
                className="flex items-center gap-1 rounded-lg bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:text-indigo-400"
              >
                <Plus size={12} /> Add
              </button>
            </div>

            {customer.connections.length === 0 ? (
              <p className="py-4 text-center text-sm text-gray-400 dark:text-gray-600">
                No connections yet
              </p>
            ) : (
              <div className="space-y-2">
                {customer.connections.map((conn) => (
                  <div
                    key={conn.id}
                    className={`rounded-lg border p-3 transition-colors ${
                      selectedConnId === conn.id
                        ? 'border-indigo-300 bg-indigo-50 dark:border-indigo-500 dark:bg-indigo-900/20'
                        : 'border-gray-100 hover:border-gray-200 dark:border-gray-800 dark:hover:border-gray-700'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <button
                        onClick={() => setSelectedConnId(selectedConnId === conn.id ? null : conn.id)}
                        className="text-left"
                      >
                        <p className="text-sm font-medium text-gray-900 dark:text-white">{conn.name}</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          <span
                            className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${
                              conn.type === 'azure-devops'
                                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                                : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
                            }`}
                          >
                            {conn.type === 'azure-devops' ? 'Azure DevOps' : 'GitHub'}
                          </span>
                        </p>
                      </button>
                      <div className="flex items-center gap-1">
                        {/* Test status */}
                        {testResults[conn.id] === 'ok' && <CheckCircle size={14} className="text-green-500" />}
                        {testResults[conn.id] === 'fail' && <XCircle size={14} className="text-red-500" />}

                        <button
                          onClick={() => testConnection(conn.id)}
                          disabled={testingConn === conn.id}
                          className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
                          title="Test connection"
                        >
                          {testingConn === conn.id ? (
                            <Loader2 size={13} className="animate-spin" />
                          ) : (
                            <RefreshCw size={13} />
                          )}
                        </button>
                        <button
                          onClick={() => {
                            if (confirm('Remove this connection?')) {
                              if (selectedConnId === conn.id) setSelectedConnId(null);
                              deleteConnMutation.mutate(conn.id);
                            }
                          }}
                          className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-900/20 dark:hover:text-red-400"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {showAddConn && (
            <AddConnectionForm customerId={customerId} onDone={() => setShowAddConn(false)} />
          )}

          {/* Projects */}
          <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
            <h3 className="mb-2 font-semibold text-gray-900 dark:text-white">Projects</h3>
            {customer.projects.length === 0 ? (
              <p className="py-2 text-sm text-gray-400 dark:text-gray-600">No projects linked</p>
            ) : (
              <div className="space-y-1">
                {customer.projects.map((p) => (
                  <a
                    key={p.id}
                    href={`/projects/${p.id}`}
                    className="block rounded-lg px-3 py-2 text-sm text-gray-900 hover:bg-gray-50 dark:text-white dark:hover:bg-gray-800"
                  >
                    {p.name}
                    <span className="ml-2 text-xs text-gray-400">
                      {p.sourceLanguage} → {p.targetLanguage}
                    </span>
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right: Remote browser */}
        <div className="lg:col-span-2">
          <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
            <h3 className="mb-4 font-semibold text-gray-900 dark:text-white">
              {selectedConnection
                ? `Browse: ${selectedConnection.name}`
                : 'Remote Repository Browser'}
            </h3>

            {!selectedConnection ? (
              <p className="py-8 text-center text-sm text-gray-400 dark:text-gray-600">
                Select a connection on the left to browse remote repositories
              </p>
            ) : (
              <RemoteBrowser
                key={selectedConnection.id}
                connection={selectedConnection}
                customerId={customerId}
                projects={customer.projects}
              />
            )}
          </div>
        </div>
      </div>

      {/* Members Section */}
      <div className="mt-6">
        <CustomerMembers customerId={customerId} />
      </div>
    </div>
  );
}
