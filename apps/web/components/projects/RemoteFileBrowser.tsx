'use client';

import { useState, useEffect } from 'react';
import { ChevronRight, Folder, FileCode2, Loader2, X, ArrowLeft } from 'lucide-react';
import { api } from '@/lib/api';
import { toast } from 'sonner';

interface Connection { id: string; name: string; type: string; baseUrl?: string }
interface ADOProject   { id: string; name: string }
interface Repo         { id: string; name: string; defaultBranch?: string }
interface Branch       { name: string }
interface FileEntry    { path: string; name: string; type: 'file' | 'directory' }

type Step = 'connection' | 'adoProject' | 'repo' | 'branch' | 'files';

interface Props {
  projectId: string;
  customerId?: string | null;
  /** Pre-configured values — when all four are set, skip straight to file browsing */
  preConnId?: string;
  preADOProject?: string;
  preRepo?: string;
  preBranch?: string;
  onImported: (xliffFileId: string, filename: string, total: number) => void;
  onClose: () => void;
}

export function RemoteFileBrowser({
  projectId, customerId,
  preConnId, preADOProject, preRepo, preBranch,
  onImported, onClose,
}: Props) {
  const allPreConfigured = !!(preConnId && preADOProject && preRepo && preBranch);

  const [step, setStep] = useState<Step>(allPreConfigured ? 'files' : 'connection');
  const [loading, setLoading] = useState(false);

  const [connections, setConnections] = useState<Connection[]>([]);
  const [adoProjects, setAdoProjects] = useState<ADOProject[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [files, setFiles] = useState<FileEntry[]>([]);

  const [selectedConn, setSelectedConn] = useState<Connection | null>(null);
  const [selectedADOProject, setSelectedADOProject] = useState<ADOProject | null>(
    preADOProject ? { id: preADOProject, name: preADOProject } : null
  );
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(
    preRepo ? { id: preRepo, name: preRepo } : null
  );
  const [selectedBranch, setSelectedBranch] = useState<string>(preBranch ?? '');
  const [currentPath, setCurrentPath] = useState('/');

  const [importing, setImporting] = useState(false);

  // ─── Mount: load connections or jump straight to file browsing ────────────
  useEffect(() => {
    if (allPreConfigured) {
      // Resolve the connection object, then browse immediately
      resolvePreConfiguredAndBrowse();
    } else {
      loadConnections();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function resolvePreConfiguredAndBrowse() {
    if (!customerId || !preConnId) return;
    setLoading(true);
    try {
      const res = await api.get<{ data: { connections: Connection[] } }>(`/api/customers/${customerId}`);
      const conn = (res.data.connections ?? []).find((c) => c.id === preConnId);
      if (!conn) {
        toast.error('Configured connection not found. Please reconfigure.');
        loadConnections();
        return;
      }
      setSelectedConn(conn);
      await browsePathWithContext(conn, preADOProject!, preRepo!, preBranch!, '/');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load pre-configured repo';
      const hint = msg.includes('not exist') || msg.includes('404')
        ? `${msg} — Check the ADO Project Name in your project settings (it must match the project that owns this repo).`
        : msg;
      toast.error(hint);
      loadConnections();
    } finally {
      setLoading(false);
    }
  }

  // ─── Step: Connections ──────────────────────────────────────────────────────
  async function loadConnections() {
    if (!customerId) {
      toast.error('This project has no customer. Link it to a customer with a DevOps connection first.');
      return;
    }
    setLoading(true);
    try {
      const res = await api.get<{ data: { connections: Connection[] } }>(`/api/customers/${customerId}`);
      const conns = res.data.connections ?? [];
      if (conns.length === 0) {
        toast.error('No DevOps connections found for this customer.');
        return;
      }
      setConnections(conns);
      setStep('connection');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load connections');
    } finally {
      setLoading(false);
    }
  }

  // ─── Step: ADO Projects ─────────────────────────────────────────────────────
  async function selectConnection(conn: Connection) {
    setSelectedConn(conn);
    setLoading(true);
    try {
      if (conn.type === 'azure-devops') {
        const res = await api.get<{ data: ADOProject[] }>(`/api/remote/connections/${conn.id}/azure/projects`);
        setAdoProjects(res.data);
        setStep('adoProject');
      } else {
        const res = await api.get<{ data: Repo[] }>(`/api/remote/connections/${conn.id}/github/repos`);
        setRepos(res.data);
        setStep('repo');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to connect');
    } finally {
      setLoading(false);
    }
  }

  // ─── Step: Repos ────────────────────────────────────────────────────────────
  async function selectADOProject(proj: ADOProject) {
    setSelectedADOProject(proj);
    setLoading(true);
    try {
      const res = await api.get<{ data: Repo[] }>(
        `/api/remote/connections/${selectedConn!.id}/azure/projects/${encodeURIComponent(proj.name)}/repos`
      );
      setRepos(res.data);
      setStep('repo');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load repos');
    } finally {
      setLoading(false);
    }
  }

  // ─── Step: Branches ─────────────────────────────────────────────────────────
  async function selectRepo(repo: Repo) {
    setSelectedRepo(repo);
    setLoading(true);
    try {
      const projPart = selectedADOProject ? encodeURIComponent(selectedADOProject.name) : '_';
      const res = await api.get<{ data: Branch[] }>(
        `/api/remote/connections/${selectedConn!.id}/azure/projects/${projPart}/repos/${encodeURIComponent(repo.name)}/branches`
      );
      setBranches(res.data);
      setSelectedBranch(repo.defaultBranch ?? res.data[0]?.name ?? 'main');
      setStep('branch');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load branches');
    } finally {
      setLoading(false);
    }
  }

  // ─── Step: Files ────────────────────────────────────────────────────────────
  /** Browse using explicit context (used when skipping steps with pre-configured values) */
  async function browsePathWithContext(
    conn: Connection, adoProject: string, repoName: string, branch: string, path = '/'
  ) {
    setLoading(true);
    setCurrentPath(path);
    try {
      const params = new URLSearchParams({ branch, path });
      const res = await api.get<{ data: FileEntry[] }>(
        `/api/remote/connections/${conn.id}/azure/projects/${encodeURIComponent(adoProject)}/repos/${encodeURIComponent(repoName)}/files?${params}`
      );
      setFiles(res.data);
      setSelectedBranch(branch);
      setStep('files');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to browse files');
    } finally {
      setLoading(false);
    }
  }

  async function browsePath(branch: string, path = '/') {
    setLoading(true);
    setCurrentPath(path);
    try {
      const projPart = selectedADOProject ? encodeURIComponent(selectedADOProject.name) : '_';
      // Prefer repo GUID (id) over name — GUIDs work across ADO projects and avoid name mismatch issues
      const repoRef = selectedRepo?.id && selectedRepo.id !== selectedRepo.name
        ? selectedRepo.id
        : encodeURIComponent(selectedRepo!.name);
      const params = new URLSearchParams({ branch, path });
      const res = await api.get<{ data: FileEntry[] }>(
        `/api/remote/connections/${selectedConn!.id}/azure/projects/${projPart}/repos/${repoRef}/files?${params}`
      );
      setFiles(res.data);
      setSelectedBranch(branch);
      setStep('files');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to browse files');
    } finally {
      setLoading(false);
    }
  }

  // ─── Import selected XLIFF ──────────────────────────────────────────────────
  async function importFile(entry: FileEntry) {
    if (!selectedConn || !selectedRepo) return;
    setImporting(true);
    try {
      const projPart = selectedADOProject ? encodeURIComponent(selectedADOProject.name) : '_';
      const repoRef = selectedRepo.id && selectedRepo.id !== selectedRepo.name
        ? selectedRepo.id
        : encodeURIComponent(selectedRepo.name);
      const params = new URLSearchParams({ branch: selectedBranch, path: entry.path });
      const contentRes = await api.get<{ data: { content: string } }>(
        `/api/remote/connections/${selectedConn.id}/azure/projects/${projPart}/repos/${repoRef}/file-content?${params}`
      );

      // Upload as a file using the existing XLIFF upload endpoint
      const blob = new Blob([contentRes.data.content], { type: 'application/xml' });
      const filename = entry.name;
      const fd = new FormData();
      fd.append('file', blob, filename);

      const uploadRes = await api.upload<{ data: { xliffFile: { id: string }; stats: { total: number } } }>(
        `/api/projects/${projectId}/xliff`,
        fd
      );

      const fileId = uploadRes.data.xliffFile.id;

      // Store remote metadata so "Commit back" works
      const repoKey = selectedADOProject
        ? `${selectedConn.baseUrl?.replace(/^https?:\/\//, '').replace(/\/$/, '')}/${selectedADOProject.name}/${selectedRepo.name}`
        : `${selectedRepo.name}`;

      await api.patch(`/api/projects/${projectId}/xliff/${fileId}/remote`, {
        remoteConnectionId: selectedConn.id,
        remotePath: entry.path,
        remoteBranch: selectedBranch,
        remoteRepo: repoKey,
      });

      onImported(fileId, filename, uploadRes.data.stats.total);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  }

  // ─── Navigation helpers ─────────────────────────────────────────────────────
  function goBack() {
    if (step === 'files') {
      // If pre-configured, there's nowhere to go back to — just close
      if (allPreConfigured && currentPath === '/') { onClose(); return; }
      if (currentPath !== '/') { browsePath(selectedBranch, currentPath.split('/').slice(0, -1).join('/') || '/'); return; }
      setStep('branch'); return;
    }
    if (step === 'branch')      { setStep('repo'); return; }
    if (step === 'repo')        { setStep(selectedConn?.type === 'azure-devops' ? 'adoProject' : 'connection'); return; }
    if (step === 'adoProject')  { setStep('connection'); return; }
  }

  const stepLabel: Record<Step, string> = {
    connection: 'Select Connection',
    adoProject: 'Select Project',
    repo:       'Select Repository',
    branch:     'Select Branch',
    files:      'Select File',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4 dark:border-gray-800">
          <div className="flex items-center gap-2">
            {step !== 'connection' && (
              <button onClick={goBack} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
                <ArrowLeft size={16} />
              </button>
            )}
            <h2 className="font-semibold text-gray-900 dark:text-white">{stepLabel[step]}</h2>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <X size={18} />
          </button>
        </div>

        {/* Breadcrumb */}
        {(selectedConn || selectedADOProject || selectedRepo) && (
          <div className="flex items-center gap-1 border-b border-gray-100 px-5 py-2 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
            {selectedConn && <span>{selectedConn.name}</span>}
            {selectedADOProject && <><ChevronRight size={12} /><span>{selectedADOProject.name}</span></>}
            {selectedRepo && <><ChevronRight size={12} /><span>{selectedRepo.name}</span></>}
            {step === 'files' && <><ChevronRight size={12} /><span className="font-mono">{selectedBranch}</span></>}
            {step === 'files' && currentPath !== '/' && <><ChevronRight size={12} /><span className="font-mono">{currentPath}</span></>}
          </div>
        )}

        {/* Body */}
        <div className="max-h-96 overflow-y-auto p-3">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-gray-400">
              <Loader2 size={24} className="animate-spin" />
            </div>
          ) : (
            <>
              {/* Connection list */}
              {step === 'connection' && (
                <ul className="space-y-1">
                  {connections.map((c) => (
                    <li key={c.id}>
                      <button
                        onClick={() => selectConnection(c)}
                        className="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800"
                      >
                        <span className="text-sm font-medium text-gray-900 dark:text-white">{c.name}</span>
                        <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-xs text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400">
                          {c.type === 'azure-devops' ? 'Azure DevOps' : 'GitHub'}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {/* ADO Project list */}
              {step === 'adoProject' && (
                <ul className="space-y-1">
                  {adoProjects.map((p) => (
                    <li key={p.id}>
                      <button
                        onClick={() => selectADOProject(p)}
                        className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800"
                      >
                        <Folder size={15} className="shrink-0 text-amber-500" />
                        <span className="text-sm text-gray-900 dark:text-white">{p.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {/* Repo list */}
              {step === 'repo' && (
                <ul className="space-y-1">
                  {repos.map((r) => (
                    <li key={r.id}>
                      <button
                        onClick={() => selectRepo(r)}
                        className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800"
                      >
                        <Folder size={15} className="shrink-0 text-amber-500" />
                        <div>
                          <p className="text-sm text-gray-900 dark:text-white">{r.name}</p>
                          {r.defaultBranch && (
                            <p className="text-xs text-gray-400">default: {r.defaultBranch}</p>
                          )}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {/* Branch list */}
              {step === 'branch' && (
                <ul className="space-y-1">
                  {branches.map((b) => (
                    <li key={b.name}>
                      <button
                        onClick={() => browsePath(b.name)}
                        className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800"
                      >
                        <span className="font-mono text-sm text-gray-900 dark:text-white">{b.name}</span>
                        {b.name === selectedRepo?.defaultBranch && (
                          <span className="rounded bg-green-50 px-1.5 py-0.5 text-xs text-green-600 dark:bg-green-900/30 dark:text-green-400">default</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {/* File browser */}
              {step === 'files' && (
                <ul className="space-y-0.5">
                  {currentPath !== '/' && (
                    <li>
                      <button
                        onClick={() => {
                          const parent = currentPath.split('/').slice(0, -1).join('/') || '/';
                          browsePath(selectedBranch, parent);
                        }}
                        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-800"
                      >
                        <span className="text-sm text-gray-400">..</span>
                      </button>
                    </li>
                  )}
                  {files.map((f) => {
                    const isXliff = f.type === 'file' && (f.name.endsWith('.xlf') || f.name.endsWith('.xliff'));
                    return (
                      <li key={f.path}>
                        <button
                          disabled={f.type === 'file' && !isXliff || importing}
                          onClick={() => {
                            if (f.type === 'directory') browsePath(selectedBranch, f.path);
                            else if (isXliff) importFile(f);
                          }}
                          className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors
                            ${f.type === 'directory' ? 'hover:bg-gray-50 dark:hover:bg-gray-800' : ''}
                            ${isXliff ? 'hover:bg-indigo-50 dark:hover:bg-indigo-900/20' : ''}
                            ${f.type === 'file' && !isXliff ? 'opacity-40 cursor-not-allowed' : ''}
                          `}
                        >
                          {importing && isXliff ? (
                            <Loader2 size={15} className="shrink-0 animate-spin text-indigo-500" />
                          ) : f.type === 'directory' ? (
                            <Folder size={15} className="shrink-0 text-amber-500" />
                          ) : (
                            <FileCode2 size={15} className={`shrink-0 ${isXliff ? 'text-indigo-500' : 'text-gray-300'}`} />
                          )}
                          <span className={`text-sm ${isXliff ? 'font-medium text-indigo-700 dark:text-indigo-300' : 'text-gray-700 dark:text-gray-300'}`}>
                            {f.name}
                          </span>
                          {isXliff && (
                            <span className="ml-auto text-xs text-indigo-400">click to import</span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                  {files.length === 0 && (
                    <p className="py-6 text-center text-sm text-gray-400">Empty folder</p>
                  )}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
