'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, ArrowRight, BookOpen, ChevronRight, CloudDownload, Download,
  FileCode2, GitCommit, Loader2, Settings2, Sparkles, Trash2, Upload, ClipboardList,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { ProjectMembers } from './ProjectMembers';
import { RemoteFileBrowser } from './RemoteFileBrowser';
import { ProjectRepositories, type ProjectRepo } from './ProjectRepositories';
import { ProjectADOAccess } from './ProjectADOAccess';
import { WorkItemsView } from './WorkItemsView';
import { formatDate } from '@/lib/utils';

type ProjectView = 'hub' | 'translations' | 'setup' | 'work-items' | 'documentation';

interface Customer {
  id: string;
  name: string;
}

interface Project {
  id: string;
  name: string;
  description?: string;
  customerId?: string | null;
  customer?: Customer | null;
  connectionId?: string | null;
  adoProjectName?: string | null;
  adoAccessScope?: string;
  adoRepoName?: string | null;
  defaultBranch?: string | null;
  sourceLanguage: string;
  targetLanguage: string;
  xliffFiles: Array<{
    id: string;
    filename: string;
    uploadedAt: string;
    sourceLanguage: string;
    targetLanguage: string;
    remoteConnectionId?: string;
    remotePath?: string;
    remoteBranch?: string;
    remoteRepo?: string;
  }>;
  repositories: ProjectRepo[];
  _count: { glossaryEntries: number };
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Request failed';
}

export function ProjectDetail({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const router = useRouter();
  const [uploading, setUploading] = useState(false);
  const [committingFile, setCommittingFile] = useState<string | null>(null);
  const [syncingFile, setSyncingFile] = useState<string | null>(null);
  const [commitMsg, setCommitMsg] = useState('');
  const [commitNewBranch, setCommitNewBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [showRemoteBrowser, setShowRemoteBrowser] = useState(false);
  const [showCommitDialog, setShowCommitDialog] = useState<string | null>(null);
  const [remoteConfig, setRemoteConfig] = useState<{ connectionId?: string | null; adoProjectName?: string | null; adoRepoName?: string | null; defaultBranch?: string | null }>({});
  const [adoAccessConfig, setAdoAccessConfig] = useState<{ connectionId?: string | null; adoProjectName?: string | null; adoAccessScope?: string }>({});
  const [view, setView] = useState<ProjectView>('hub');

  const { data, isLoading } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.get<{ data: Project }>(`/api/projects/${projectId}`),
  });

  const deleteFileMutation = useMutation({
    mutationFn: (fileId: string) => api.delete(`/api/projects/${projectId}/xliff/${fileId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project', projectId] });
      toast.success('File deleted');
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const onDrop = useCallback(
    async (files: File[]) => {
      const file = files[0];
      if (!file) return;
      setUploading(true);
      try {
        const fd = new FormData();
        fd.append('file', file);
        const result = await api.upload<{ data: { xliffFile: { id: string }; stats: { total: number } } }>(
          `/api/projects/${projectId}/xliff`,
          fd
        );
        qc.invalidateQueries({ queryKey: ['project', projectId] });
        toast.success(`${file.name} uploaded — ${result.data.stats.total} strings`);
        router.push(`/projects/${projectId}/translations?fileId=${result.data.xliffFile.id}`);
      } catch (error) {
        toast.error(getErrorMessage(error));
      } finally {
        setUploading(false);
      }
    },
    [projectId, qc, router]
  );

  const commitToRemote = useCallback(
    async (file: Project['xliffFiles'][0]) => {
      if (!file.remoteConnectionId || !file.remotePath || !file.remoteBranch || !file.remoteRepo) return;
      if (!commitMsg.trim()) { toast.error('Please enter a commit message'); return; }
      if (commitNewBranch && !newBranchName.trim()) { toast.error('Please enter a branch name'); return; }

      setCommittingFile(file.id);
      try {
        const contentRes = await api.get<{ data: { content: string } }>(
          `/api/projects/${projectId}/xliff/${file.id}/content`
        );

        const connId = file.remoteConnectionId;
        const repo = file.remoteRepo;
        const repoParts = repo.split('/');
        const targetBranch = commitNewBranch ? newBranchName.trim() : file.remoteBranch;

        // Azure DevOps repos are stored as "domain/org/project/repo" (4 parts)
        // or "org/project/repo" (3 parts, legacy). GitHub is "owner/repo" (2 parts).
        // Always use last two parts as [adoProject, repoId] for ADO.
        if (repoParts.length >= 3) {
          // Azure DevOps
          const azProject = repoParts[repoParts.length - 2];
          const repoId = repoParts[repoParts.length - 1];

          // Create new branch first if requested
          if (commitNewBranch) {
            await api.post(
              `/api/remote/connections/${connId}/azure/projects/${encodeURIComponent(azProject)}/repos/${encodeURIComponent(repoId)}/branches`,
              { name: newBranchName.trim(), sourceBranch: file.remoteBranch }
            );
          }

          await api.post(
            `/api/remote/connections/${connId}/azure/projects/${encodeURIComponent(azProject)}/repos/${encodeURIComponent(repoId)}/commit`,
            { branch: targetBranch, path: file.remotePath, content: contentRes.data.content, message: commitMsg }
          );
        } else {
          // GitHub: "owner/repo"
          const [owner, repoName] = repoParts;

          if (commitNewBranch) {
            await api.post(
              `/api/remote/connections/${connId}/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/branches`,
              { name: newBranchName.trim(), sourceBranch: file.remoteBranch }
            );
          }

          const params = new URLSearchParams({ path: file.remotePath, branch: targetBranch });
          const fileInfo = await api.get<{ data: { sha: string } }>(
            `/api/remote/connections/${connId}/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/file-content?${params}`
          );
          await api.post(
            `/api/remote/connections/${connId}/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/commit`,
            { branch: targetBranch, path: file.remotePath, content: contentRes.data.content, message: commitMsg, sha: fileInfo.data.sha }
          );
        }

        // Update stored branch if committed to new branch
        if (commitNewBranch) {
          await api.patch(`/api/projects/${projectId}/xliff/${file.id}/remote`, {
            remoteConnectionId: file.remoteConnectionId,
            remotePath: file.remotePath,
            remoteBranch: targetBranch,
            remoteRepo: file.remoteRepo,
          });
          qc.invalidateQueries({ queryKey: ['project', projectId] });
        }

        toast.success(`Committed to ${targetBranch}`);
        setShowCommitDialog(null);
        setCommitMsg('');
        setCommitNewBranch(false);
        setNewBranchName('');
      } catch (error) {
        toast.error(getErrorMessage(error));
      } finally {
        setCommittingFile(null);
      }
    },
    [projectId, commitMsg, commitNewBranch, newBranchName, qc]
  );

  const syncFromRemote = useCallback(
    async (file: Project['xliffFiles'][0]) => {
      if (!file.remoteConnectionId) return;
      setSyncingFile(file.id);
      try {
        const res = await api.post<{ data: { added: number; updated: number; obsolete: number; total: number } }>(
          `/api/projects/${projectId}/xliff/${file.id}/sync-from-remote`,
          {}
        );
        qc.invalidateQueries({ queryKey: ['project', projectId] });
        const { added, updated, obsolete } = res.data;
        toast.success(`Synced — ${added} new, ${updated} updated, ${obsolete} obsolete`);
      } catch (error) {
        toast.error(getErrorMessage(error));
      } finally {
        setSyncingFile(null);
      }
    },
    [projectId, qc]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'application/xml': ['.xlf', '.xliff'], 'text/xml': ['.xlf', '.xliff'] },
    multiple: false,
  });

  const project = data?.data;

  // Sync remote config from project data on load
  const effectiveRemoteConfig = {
    connectionId: remoteConfig.connectionId !== undefined ? remoteConfig.connectionId : project?.connectionId,
    adoProjectName: remoteConfig.adoProjectName !== undefined ? remoteConfig.adoProjectName : project?.adoProjectName,
    adoRepoName: remoteConfig.adoRepoName !== undefined ? remoteConfig.adoRepoName : project?.adoRepoName,
    defaultBranch: remoteConfig.defaultBranch !== undefined ? remoteConfig.defaultBranch : project?.defaultBranch,
  };

  if (isLoading) return <div className="py-12 text-center text-gray-400 dark:text-gray-600">Loading...</div>;
  if (!project) return <div className="py-12 text-center text-red-500">Project not found</div>;

  const hasRemoteConfig = !!(effectiveRemoteConfig.connectionId && effectiveRemoteConfig.adoRepoName);

  // ─── Shared header ──────────────────────────────────────────────────────────
  const header = (
    <div className="mb-6 flex items-center gap-3">
      {view === 'hub' ? (
        <Link href="/projects" className="text-gray-400 hover:text-gray-600 dark:text-gray-600 dark:hover:text-gray-300">
          <ArrowLeft size={20} />
        </Link>
      ) : (
        <button onClick={() => setView('hub')} className="text-gray-400 hover:text-gray-600 dark:text-gray-600 dark:hover:text-gray-300">
          <ArrowLeft size={20} />
        </button>
      )}
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{project.name}</h1>
          {view !== 'hub' && (
            <span className="flex items-center gap-1 text-sm text-gray-400 dark:text-gray-500">
              <ChevronRight size={14} />
              {{translations:'Translations', setup:'Setup', 'work-items':'Work Items', documentation:'Documentation'}[view]}
            </span>
          )}
        </div>
        {project.description && <p className="text-sm text-gray-500 dark:text-gray-400">{project.description}</p>}
        {project.customer && (
          <a href={`/customers/${project.customer.id}`}
            className="mt-1 inline-block rounded bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:text-indigo-400">
            {project.customer.name}
          </a>
        )}
      </div>
    </div>
  );

  // ─── Hub view ───────────────────────────────────────────────────────────────
  if (view === 'hub') {
    const cards = [
      {
        key: 'translations' as ProjectView,
        icon: <FileCode2 size={28} className="text-indigo-500" />,
        title: 'Translations',
        description: 'Upload, load and edit XLIFF translation files. Use AI to auto-translate and commit back to your repo.',
        badge: project.xliffFiles.length > 0
          ? `${project.xliffFiles.length} file${project.xliffFiles.length > 1 ? 's' : ''}`
          : 'No files yet',
        badgeColor: project.xliffFiles.length > 0 ? 'text-indigo-600 bg-indigo-50 dark:bg-indigo-900/30 dark:text-indigo-400' : 'text-gray-400 bg-gray-100 dark:bg-gray-800',
        available: true,
      },
      {
        key: 'setup' as ProjectView,
        icon: <Settings2 size={28} className="text-amber-500" />,
        title: 'Setup',
        description: 'Configure remote repository, glossary, and project connections to Azure DevOps or GitHub.',
        badge: hasRemoteConfig ? 'Configured' : 'Not configured',
        badgeColor: hasRemoteConfig ? 'text-green-600 bg-green-50 dark:bg-green-900/30 dark:text-green-400' : 'text-gray-400 bg-gray-100 dark:bg-gray-800',
        available: true,
      },
      {
        key: 'work-items' as ProjectView,
        icon: <ClipboardList size={28} className="text-sky-500" />,
        title: 'Work Items',
        description: 'Browse, create and manage Azure DevOps work items. Use AI agents and skills to generate user stories, bugs and tasks.',
        badge: project.connectionId && project.adoProjectName ? 'Ready' : 'Needs ADO setup',
        badgeColor: project.connectionId && project.adoProjectName ? 'text-sky-600 bg-sky-50 dark:bg-sky-900/30 dark:text-sky-400' : 'text-gray-400 bg-gray-100 dark:bg-gray-800',
        available: true,
      },
      {
        key: 'documentation' as ProjectView,
        icon: <BookOpen size={28} className="text-emerald-500" />,
        title: 'Documentation',
        description: 'Create and manage project documentation. Sync with wikis and generate docs from your codebase.',
        badge: 'Coming soon',
        badgeColor: 'text-gray-400 bg-gray-100 dark:bg-gray-800',
        available: false,
        comingSoon: true,
      },
    ];

    return (
      <div>
        {header}
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
          {cards.map((card) => (
            <button
              key={card.key}
              onClick={() => card.available && setView(card.key)}
              disabled={!card.available}
              className={`group relative flex flex-col rounded-xl border bg-white p-6 text-left transition-all dark:bg-gray-900
                ${card.available
                  ? 'cursor-pointer border-gray-200 hover:border-indigo-300 hover:shadow-md dark:border-gray-700 dark:hover:border-indigo-600'
                  : 'cursor-default border-gray-200 opacity-60 dark:border-gray-800'
                }`}
            >
              <div className="mb-4">{card.icon}</div>
              <div className="mb-1 flex items-center justify-between">
                <h3 className="font-semibold text-gray-900 dark:text-white">{card.title}</h3>
                {card.available && (
                  <ArrowRight size={16} className="text-gray-300 transition-transform group-hover:translate-x-1 group-hover:text-indigo-500 dark:text-gray-700" />
                )}
              </div>
              <p className="mb-4 flex-1 text-sm text-gray-500 dark:text-gray-400">{card.description}</p>
              <div className="flex items-center justify-between">
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${card.badgeColor}`}>
                  {card.badge}
                </span>
                {card.comingSoon && (
                  <span className="text-xs text-gray-400 dark:text-gray-600">Planned</span>
                )}
              </div>
            </button>
          ))}
        </div>

        {/* Quick stats row */}
        <div className="mt-6 flex flex-wrap gap-4 text-sm text-gray-500 dark:text-gray-400">
          <span>{project._count.glossaryEntries} glossary term{project._count.glossaryEntries !== 1 ? 's' : ''}</span>
          {hasRemoteConfig && (
            <span className="flex items-center gap-1">
              <GitCommit size={13} />
              {effectiveRemoteConfig.adoProjectName} / {effectiveRemoteConfig.adoRepoName}
              <span className="rounded bg-gray-100 px-1.5 dark:bg-gray-800">{effectiveRemoteConfig.defaultBranch}</span>
            </span>
          )}
        </div>
      </div>
    );
  }

  // ─── Translations view ──────────────────────────────────────────────────────
  if (view === 'translations') {
    return (
      <div>
        {header}
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Upload panel */}
          <div className="lg:col-span-1">
            <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
              <h3 className="mb-3 flex items-center gap-2 font-semibold text-gray-900 dark:text-white">
                <Upload size={16} /> Upload XLIFF
              </h3>
              <div
                {...getRootProps()}
                className={`cursor-pointer rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
                  isDragActive
                    ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-900/20'
                    : 'border-gray-300 hover:border-indigo-300 dark:border-gray-600 dark:hover:border-indigo-500'
                }`}
              >
                <input {...getInputProps()} />
                {uploading ? (
                  <p className="text-sm text-indigo-600 dark:text-indigo-400">Uploading...</p>
                ) : (
                  <>
                    <Upload size={24} className="mx-auto mb-2 text-gray-300 dark:text-gray-600" />
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {isDragActive ? 'Drop here' : 'Drag & drop or click'}
                    </p>
                    <p className="mt-1 text-xs text-gray-400 dark:text-gray-600">.xlf / .xliff</p>
                  </>
                )}
              </div>
              {project.customerId && (
                <button
                  onClick={() => setShowRemoteBrowser(true)}
                  className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100 dark:border-indigo-800 dark:bg-indigo-900/20 dark:text-indigo-300 dark:hover:bg-indigo-900/40"
                >
                  <CloudDownload size={15} /> Load from Remote
                </button>
              )}
            </div>
          </div>

          {/* Files list */}
          <div className="lg:col-span-2">
            <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
              <h3 className="mb-4 font-semibold text-gray-900 dark:text-white">XLIFF Files</h3>
              {project.xliffFiles.length === 0 ? (
                <p className="py-8 text-center text-sm text-gray-400 dark:text-gray-600">
                  No files yet. Upload an XLIFF file to start.
                </p>
              ) : (
                <div className="space-y-2">
                  {project.xliffFiles.map((file) => (
                    <div key={file.id} className="rounded-lg border border-gray-100 dark:border-gray-800">
                      {/* Clickable main row */}
                      <a
                        href={`/projects/${project.id}/translations?fileId=${file.id}`}
                        className="flex items-center justify-between rounded-t-lg p-3 hover:bg-gray-50 dark:hover:bg-gray-800/50"
                      >
                        <div>
                          <p className="text-sm font-medium text-gray-900 dark:text-white">{file.filename}</p>
                          <p className="text-xs text-gray-400 dark:text-gray-600">{formatDate(file.uploadedAt)}</p>
                          {file.remoteRepo && (
                            <p className="mt-0.5 flex items-center gap-1 text-xs text-indigo-500 dark:text-indigo-400">
                              <GitCommit size={11} />
                              {file.remoteRepo} / {file.remoteBranch}
                            </p>
                          )}
                        </div>
                        <ArrowRight size={15} className="shrink-0 text-gray-300 dark:text-gray-700" />
                      </a>

                      {/* Action buttons row */}
                      <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 px-3 py-2 dark:border-gray-800">
                        <a
                          href={`/projects/${project.id}/translations?fileId=${file.id}`}
                          className="flex items-center gap-1 rounded-lg bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:text-indigo-400 dark:hover:bg-indigo-900/50"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Sparkles size={13} /> Translate
                        </a>
                        {file.remoteRepo && (
                          <>
                            <button
                              onClick={() => syncFromRemote(file)}
                              disabled={syncingFile === file.id}
                              className="flex items-center gap-1 rounded-lg bg-sky-50 px-3 py-1.5 text-xs font-medium text-sky-700 hover:bg-sky-100 disabled:opacity-50 dark:bg-sky-900/30 dark:text-sky-400 dark:hover:bg-sky-900/50"
                              title="Fetch latest from remote and merge"
                            >
                              {syncingFile === file.id ? <Loader2 size={13} className="animate-spin" /> : <CloudDownload size={13} />}
                              {syncingFile === file.id ? 'Fetching...' : 'Fetch'}
                            </button>
                            <button
                              onClick={() => {
                                setShowCommitDialog(file.id);
                                setCommitMsg(`Update translations in ${file.filename}`);
                                setCommitNewBranch(false);
                                setNewBranchName(`translations/${new Date().toISOString().slice(0, 10)}`);
                              }}
                              className="flex items-center gap-1 rounded-lg bg-green-50 px-3 py-1.5 text-xs font-medium text-green-700 hover:bg-green-100 dark:bg-green-900/30 dark:text-green-400 dark:hover:bg-green-900/50"
                            >
                              <GitCommit size={13} /> Commit
                            </button>
                          </>
                        )}
                        <a
                          href={`/api/projects/${project.id}/xliff/${file.id}/download`}
                          className="flex items-center gap-1 rounded-lg bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
                          download
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Download size={13} /> Download
                        </a>
                        <button
                          onClick={() => { if (confirm(`Delete "${file.filename}"? This cannot be undone.`)) deleteFileMutation.mutate(file.id); }}
                          disabled={deleteFileMutation.isPending}
                          className="ml-auto flex items-center gap-1 rounded-lg px-2 py-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40 dark:text-gray-600 dark:hover:bg-red-900/20 dark:hover:text-red-400"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>

                      {/* Commit dialog */}
                      {showCommitDialog === file.id && (
                        <div className="rounded-b-lg border-t border-green-200 bg-green-50 p-3 dark:border-green-800 dark:bg-green-900/20">
                          <p className="mb-2 text-xs font-medium text-green-800 dark:text-green-300">
                            Committing: {file.remoteRepo}
                          </p>
                          <input
                            className="mb-2 w-full rounded border border-green-300 px-2 py-1.5 text-sm dark:border-green-700 dark:bg-gray-800 dark:text-white"
                            value={commitMsg}
                            onChange={(e) => setCommitMsg(e.target.value)}
                            placeholder="Commit message"
                          />

                          {/* New branch toggle */}
                          <label className="mb-2 flex cursor-pointer items-center gap-2 text-xs text-green-800 dark:text-green-300">
                            <input
                              type="checkbox"
                              checked={commitNewBranch}
                              onChange={(e) => setCommitNewBranch(e.target.checked)}
                              className="rounded"
                            />
                            Create new branch
                          </label>
                          {commitNewBranch ? (
                            <input
                              className="mb-2 w-full rounded border border-green-300 px-2 py-1.5 text-sm dark:border-green-700 dark:bg-gray-800 dark:text-white"
                              value={newBranchName}
                              onChange={(e) => setNewBranchName(e.target.value)}
                              placeholder="New branch name"
                            />
                          ) : (
                            <p className="mb-2 text-xs text-green-700 dark:text-green-400">
                              → Committing to: <span className="rounded bg-green-100 px-1 font-mono dark:bg-green-900/40">{file.remoteBranch}</span>
                            </p>
                          )}

                          <div className="flex gap-2">
                            <button
                              onClick={() => commitToRemote(file)}
                              disabled={committingFile === file.id || !commitMsg.trim()}
                              className="flex items-center gap-1 rounded bg-green-600 px-3 py-1 text-xs text-white hover:bg-green-700 disabled:opacity-50"
                            >
                              {committingFile === file.id ? <Loader2 size={12} className="animate-spin" /> : <GitCommit size={12} />}
                              {committingFile === file.id ? 'Committing...' : commitNewBranch ? 'Create & Commit' : 'Commit'}
                            </button>
                            <button
                              onClick={() => { setShowCommitDialog(null); setCommitNewBranch(false); }}
                              className="rounded border border-green-300 px-3 py-1 text-xs text-green-700 dark:border-green-700 dark:text-green-400"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Remote file browser modal */}
        {showRemoteBrowser && (
          <RemoteFileBrowser
            projectId={projectId}
            customerId={project.customerId}
            preConnId={effectiveRemoteConfig.connectionId ?? undefined}
            preADOProject={effectiveRemoteConfig.adoProjectName ?? undefined}
            preRepo={effectiveRemoteConfig.adoRepoName ?? undefined}
            preBranch={effectiveRemoteConfig.defaultBranch ?? undefined}
            onClose={() => setShowRemoteBrowser(false)}
            onImported={(fileId, filename, total) => {
              setShowRemoteBrowser(false);
              qc.invalidateQueries({ queryKey: ['project', projectId] });
              toast.success(`${filename} imported — ${total} strings`);
              router.push(`/projects/${projectId}/translations?fileId=${fileId}`);
            }}
          />
        )}
      </div>
    );
  }

  // ─── Setup view ─────────────────────────────────────────────────────────────
  if (view === 'setup') {
    const adoCurrent = {
      connectionId: adoAccessConfig.connectionId !== undefined ? adoAccessConfig.connectionId : project.connectionId,
      adoProjectName: adoAccessConfig.adoProjectName !== undefined ? adoAccessConfig.adoProjectName : project.adoProjectName,
      adoAccessScope: adoAccessConfig.adoAccessScope ?? project.adoAccessScope ?? 'org',
    };
    return (
      <div>
        {header}
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Repositories — full width */}
          <div className="lg:col-span-2">
            <ProjectRepositories
              projectId={projectId}
              customerId={project.customerId}
              repos={project.repositories ?? []}
              onChanged={() => qc.invalidateQueries({ queryKey: ['project', projectId] })}
            />
          </div>

          {/* ADO Access */}
          <ProjectADOAccess
            projectId={projectId}
            customerId={project.customerId}
            current={adoCurrent}
            onSaved={(cfg) => setAdoAccessConfig(cfg)}
          />

          {/* Glossary */}
          <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
            <h3 className="mb-3 font-semibold text-gray-900 dark:text-white">Glossary</h3>
            <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
              {project._count.glossaryEntries} term{project._count.glossaryEntries !== 1 ? 's' : ''} defined. Glossary terms guide AI translations to use the correct terminology.
            </p>
            <a
              href={`/projects/${project.id}/glossary`}
              className="inline-flex items-center gap-1.5 rounded-lg bg-gray-50 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              Manage Glossary <ArrowRight size={14} />
            </a>
          </div>

          {/* Members — full width */}
          <div className="lg:col-span-2">
            <ProjectMembers projectId={projectId} />
          </div>
        </div>
      </div>
    );
  }

  // ─── Work Items view ────────────────────────────────────────────────────────
  if (view === 'work-items') {
    const hasADO = !!(project.connectionId && project.adoProjectName);
    return (
      <div>
        {header}
        {!hasADO ? (
          <div className="rounded-xl border border-dashed border-gray-200 bg-white p-12 text-center dark:border-gray-700 dark:bg-gray-900">
            <ClipboardList size={40} className="mx-auto mb-4 text-sky-400 dark:text-sky-600" />
            <h3 className="mb-2 text-lg font-semibold text-gray-900 dark:text-white">ADO Connection Required</h3>
            <p className="mx-auto max-w-md text-sm text-gray-500 dark:text-gray-400">
              Configure an Azure DevOps connection and project in Setup to browse and create work items.
            </p>
            <button
              onClick={() => setView('setup')}
              className="mt-6 inline-flex items-center gap-2 rounded-lg bg-sky-50 px-4 py-2 text-sm font-medium text-sky-700 hover:bg-sky-100 dark:bg-sky-900/30 dark:text-sky-300"
            >
              <Settings2 size={15} /> Go to Setup
            </button>
          </div>
        ) : (
          <WorkItemsView projectId={projectId} />
        )}
      </div>
    );
  }

  // ─── Documentation view (coming soon) ───────────────────────────────────────
  return (
    <div>
      {header}
      <div className="rounded-xl border border-dashed border-gray-200 bg-white p-12 text-center dark:border-gray-700 dark:bg-gray-900">
        <BookOpen size={40} className="mx-auto mb-4 text-emerald-400 dark:text-emerald-600" />
        <h3 className="mb-2 text-lg font-semibold text-gray-900 dark:text-white">Documentation — Coming Soon</h3>
        <p className="mx-auto max-w-md text-sm text-gray-500 dark:text-gray-400">
          Create and manage project documentation, sync with wiki platforms, and generate docs from your codebase using AI agents.
        </p>
      </div>
    </div>
  );
}
