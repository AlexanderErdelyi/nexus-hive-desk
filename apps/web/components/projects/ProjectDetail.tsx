'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, ArrowRight, BarChart2, BookOpen, Brain, ChevronRight, CloudDownload, Download,
  FileCode2, GitCommit, GitCompare, GitPullRequest, Loader2, Settings2, Sparkles, Trash2, Upload, ClipboardList,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useProjectRole } from '@/lib/use-project-role';
import { ProjectMembers } from './ProjectMembers';
import { RemoteFileBrowser } from './RemoteFileBrowser';
import { CommitModal } from './CommitModal';
import { ProjectRepositories, type ProjectRepo } from './ProjectRepositories';
import { ProjectADOAccess } from './ProjectADOAccess';
import { WorkItemsView } from './WorkItemsView';
import { DocumentationView } from './DocumentationView';
import { ALAnalyserView } from './ALAnalyserView';
import { TranslationMemoryView } from './TranslationMemoryView';
import XliffCompareView from './XliffCompareView';
import { formatDate } from '@/lib/utils';

type ProjectView = 'hub' | 'translations' | 'setup' | 'work-items' | 'documentation' | 'al-analysis' | 'translation-memory' | 'compare';

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
  capabilities?: string | null;
  connectionId?: string | null;
  adoProjectName?: string | null;
  adoAccessScope?: string;
  adoRepoName?: string | null;
  defaultBranch?: string | null;
  localWorkspacePath?: string | null;
  sourceLanguage?: string | null;
  targetLanguage?: string | null;
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
    remotePrId?: string | null;
    remotePrUrl?: string | null;
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
  const [syncingFile, setSyncingFile] = useState<string | null>(null);
  const [showCommitModal, setShowCommitModal] = useState<string | null>(null);
  const [showRemoteBrowser, setShowRemoteBrowser] = useState(false);
  const [remoteConfig, setRemoteConfig] = useState<{ connectionId?: string | null; adoProjectName?: string | null; adoRepoName?: string | null; defaultBranch?: string | null }>({});
  const [adoAccessConfig, setAdoAccessConfig] = useState<{ connectionId?: string | null; adoProjectName?: string | null; adoAccessScope?: string }>({});
  const [view, setView] = useState<ProjectView>('hub');
  const [savingCaps, setSavingCaps] = useState(false);
  const [savingWorkspacePath, setSavingWorkspacePath] = useState(false);
  const [workspacePath, setWorkspacePath] = useState<string | undefined>(undefined);

  const { role: myRole, hasRole } = useProjectRole(projectId);

  const { data, isLoading } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.get<{ data: Project }>(`/api/projects/${projectId}`),
    staleTime: 60_000,
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

  const syncFromRemote = useCallback(
    async (file: Project['xliffFiles'][0]) => {
      if (!file.remoteConnectionId) return;
      setSyncingFile(file.id);
      try {
        const res = await api.post<{ data: { added: number; updated: number; obsolete: number; total: number; syncAt: string } }>(
          `/api/projects/${projectId}/xliff/${file.id}/sync-from-remote`,
          {}
        );
        qc.invalidateQueries({ queryKey: ['project', projectId] });
        qc.invalidateQueries({ queryKey: ['project-files', projectId] });
        const { added, updated, obsolete } = res.data;
        if (added > 0 || updated > 0) {
          toast.success(`Synced — ${added} new, ${updated} source changes, ${obsolete} obsolete`, {
            action: {
              label: 'View changes',
              onClick: () => router.push(`/projects/${projectId}/translations/${file.id}?filter=since-last-sync`),
            },
            duration: 8000,
          });
        } else {
          toast.success(`Synced — no changes (${obsolete} obsolete)`);
        }
      } catch (error) {
        toast.error(getErrorMessage(error));
      } finally {
        setSyncingFile(null);
      }
    },
    [projectId, qc, router]
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
          {myRole && (
            <span className={`rounded px-2 py-0.5 text-xs font-medium ${
              myRole === 'admin' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
              myRole === 'editor' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' :
              myRole === 'translator' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
              'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
            }`}>
              {myRole}
            </span>
          )}
          {view !== 'hub' && (
            <span className="flex items-center gap-1 text-sm text-gray-400 dark:text-gray-500">
              <ChevronRight size={14} />
                {{translations:'Translations', setup:'Setup', 'work-items':'Work Items', documentation:'Documentation', 'al-analysis':'AL Analysis', 'translation-memory':'TM Library', compare:'Compare'}[view]}
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
    const caps = (project.capabilities ?? 'translation').split(',').map((c) => c.trim());
    const hasTranslation = caps.includes('translation');
    const hasUserStories = caps.includes('user-stories');
    const hasDocs = caps.includes('documentation');

    const cards = [
      {
        key: 'translations' as ProjectView,
        icon: <FileCode2 size={28} className={hasTranslation ? 'text-indigo-500' : 'text-gray-300 dark:text-gray-600'} />,
        title: 'Translations',
        description: 'Upload, load and edit XLIFF translation files. Use AI to auto-translate and commit back to your repo.',
        badge: !hasTranslation ? 'Not enabled' : project.xliffFiles.length > 0
          ? `${project.xliffFiles.length} file${project.xliffFiles.length > 1 ? 's' : ''}`
          : 'No files yet',
        badgeColor: !hasTranslation ? 'text-gray-400 bg-gray-100 dark:bg-gray-800' : project.xliffFiles.length > 0 ? 'text-indigo-600 bg-indigo-50 dark:bg-indigo-900/30 dark:text-indigo-400' : 'text-gray-400 bg-gray-100 dark:bg-gray-800',
        available: true,
        dataTour: 'tab-translations',
      },
      {
        key: 'setup' as ProjectView,
        icon: <Settings2 size={28} className="text-amber-500" />,
        title: 'Setup',
        description: 'Configure remote repository, glossary, capabilities, and project connections to Azure DevOps or GitHub.',
        badge: hasRemoteConfig ? 'Configured' : 'Not configured',
        badgeColor: hasRemoteConfig ? 'text-green-600 bg-green-50 dark:bg-green-900/30 dark:text-green-400' : 'text-gray-400 bg-gray-100 dark:bg-gray-800',
        available: myRole === null || hasRole('editor'),
      },
      {
        key: 'work-items' as ProjectView,
        icon: <ClipboardList size={28} className={hasUserStories ? 'text-sky-500' : 'text-gray-300 dark:text-gray-600'} />,
        title: 'Work Items',
        description: 'Browse, create and manage Azure DevOps work items. Use AI agents and skills to generate user stories, bugs and tasks.',
        badge: !hasUserStories ? 'Not enabled' : project.connectionId && project.adoProjectName ? 'Ready' : 'Needs ADO setup',
        badgeColor: !hasUserStories ? 'text-gray-400 bg-gray-100 dark:bg-gray-800' : project.connectionId && project.adoProjectName ? 'text-sky-600 bg-sky-50 dark:bg-sky-900/30 dark:text-sky-400' : 'text-gray-400 bg-gray-100 dark:bg-gray-800',
        available: true,
        dataTour: 'tab-workitems',
      },
      {
        key: 'documentation' as ProjectView,
        icon: <BookOpen size={28} className={hasDocs ? 'text-emerald-500' : 'text-gray-300 dark:text-gray-600'} />,
        title: 'Documentation',
        description: 'Create and manage project documentation. Sync with wikis and generate docs from your codebase.',
        badge: !hasDocs ? 'Not enabled' : 'Wiki.js ready',
        badgeColor: !hasDocs ? 'text-gray-400 bg-gray-100 dark:bg-gray-800' : 'text-emerald-600 bg-emerald-50 dark:bg-emerald-900/30 dark:text-emerald-400',
        available: true,
        comingSoon: false,
        dataTour: 'tab-wiki',
      },
      {
        key: 'al-analysis' as ProjectView,
        icon: <BarChart2 size={28} className={hasTranslation && project.xliffFiles.length > 0 ? 'text-teal-500' : 'text-gray-300 dark:text-gray-600'} />,
        title: 'AL Analysis',
        description: 'Translation coverage per AL object. Upload your AL source folder to find objects missing from XLIFF.',
        badge: !hasTranslation ? 'Not enabled' : project.xliffFiles.length > 0 ? `${project.xliffFiles.length} file${project.xliffFiles.length > 1 ? 's' : ''}` : 'No XLIFF yet',
        badgeColor: !hasTranslation || !project.xliffFiles.length ? 'text-gray-400 bg-gray-100 dark:bg-gray-800' : 'text-teal-600 bg-teal-50 dark:bg-teal-900/30 dark:text-teal-400',
        available: hasTranslation && project.xliffFiles.length > 0,
        comingSoon: false,
      },
      {
        key: 'translation-memory' as ProjectView,
        icon: <Brain size={28} className={hasTranslation ? 'text-violet-500' : 'text-gray-300 dark:text-gray-600'} />,
        title: 'TM Library',
        description: 'Browse, edit, import and export Translation Memory entries. Auto-populated as you translate.',
        badge: hasTranslation ? 'Active' : 'Not enabled',
        badgeColor: hasTranslation ? 'text-violet-600 bg-violet-50 dark:bg-violet-900/30 dark:text-violet-400' : 'text-gray-400 bg-gray-100 dark:bg-gray-800',
        available: hasTranslation,
        comingSoon: false,
      },
    ];

    return (
      <div>
        {header}
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
          {cards.map((card) => (
            <button
              key={card.key}
              data-tour={card.dataTour}
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
              <span data-tour="branch-selector" className="rounded bg-gray-100 px-1.5 dark:bg-gray-800">{effectiveRemoteConfig.defaultBranch}</span>
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
                  {project.xliffFiles.map((file) => {
                    const prStatus = file.remotePrId
                      ? { id: file.remotePrId, url: file.remotePrUrl }
                      : null;
                    return (
                      <div key={file.id} className="rounded-lg border border-gray-100 dark:border-gray-800">
                        {/* Clickable main row */}
                        <a
                          href={`/projects/${project.id}/translations?fileId=${file.id}`}
                          className="flex items-center justify-between rounded-t-lg p-3 hover:bg-gray-50 dark:hover:bg-gray-800/50"
                        >
                          <div>
                            <p className="text-sm font-medium text-gray-900 dark:text-white">{file.filename}</p>
                            <p className="text-xs text-gray-400 dark:text-gray-600">{formatDate(file.uploadedAt)}</p>
                            <div className="mt-0.5 flex flex-wrap items-center gap-2">
                              {file.remoteRepo && (
                                <p className="flex items-center gap-1 text-xs text-indigo-500 dark:text-indigo-400">
                                  <GitCommit size={11} />
                                  {file.remoteRepo} / {file.remoteBranch}
                                </p>
                              )}
                              {prStatus && (
                                <span className="flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-600 dark:bg-blue-900/30 dark:text-blue-300">
                                  <GitPullRequest size={10} /> PR #{prStatus.id}
                                </span>
                              )}
                            </div>
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
                                onClick={() => setShowCommitModal(file.id)}
                                className="flex items-center gap-1 rounded-lg bg-green-50 px-3 py-1.5 text-xs font-medium text-green-700 hover:bg-green-100 dark:bg-green-900/30 dark:text-green-400 dark:hover:bg-green-900/50"
                              >
                                <GitCommit size={13} /> Commit
                              </button>
                              {prStatus?.url && (
                                <a
                                  href={prStatus.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-1 rounded-lg bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-400 dark:hover:bg-blue-900/50"
                                >
                                  <GitPullRequest size={13} /> View PR
                                </a>
                              )}
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
                      </div>
                    );
                  })}
                </div>
              )}
              {/* Compare button — shown when 2+ files are loaded */}
              {project.xliffFiles.length >= 2 && (
                <div className="mt-4 border-t border-gray-100 pt-4 dark:border-gray-800">
                  <button
                    onClick={() => setView('compare')}
                    className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-300 dark:hover:bg-blue-900/40"
                  >
                    <GitCompare size={15} /> Compare Files
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Commit modal */}
        {showCommitModal && (() => {
          const file = project.xliffFiles.find((f) => f.id === showCommitModal);
          if (!file?.remoteRepo || !file.remoteConnectionId) return null;
          const repoParts = file.remoteRepo.split('/');
          const isAdo = repoParts.length >= 3;
          const adoProject = isAdo ? repoParts[repoParts.length - 2] : '';
          const repoId = repoParts[repoParts.length - 1];
          const githubOwner = !isAdo ? repoParts[0] : undefined;
          const githubRepo = !isAdo ? repoParts[1] : undefined;
          return (
            <CommitModal
              key={file.id}
              projectId={projectId}
              file={file}
              adoProject={adoProject}
              repoId={repoId}
              isAdo={isAdo}
              githubOwner={githubOwner}
              githubRepo={githubRepo}
              onDone={() => qc.invalidateQueries({ queryKey: ['project', projectId] })}
              onClose={() => setShowCommitModal(null)}
            />
          );
        })()}

        {/* Remote file browser modal */}
        {showRemoteBrowser && (
          <RemoteFileBrowser
            projectId={projectId}
            customerId={project.customerId}
            configuredRepos={project.repositories ?? []}
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

          {/* Capabilities */}
          {(() => {
            const currentCaps = (project.capabilities ?? 'translation').split(',').map((c) => c.trim()).filter(Boolean);
            const allCaps = [
              { id: 'translation', label: 'Translation', description: 'XLIFF file management and AI translation' },
              { id: 'user-stories', label: 'Work Items', description: 'Azure DevOps work item management' },
              { id: 'documentation', label: 'Documentation', description: 'Wiki and documentation generation' },
            ];
            async function saveCaps(caps: string[]) {
              setSavingCaps(true);
              try {
                await api.patch(`/api/projects/${projectId}`, { capabilities: caps.join(',') });
                qc.invalidateQueries({ queryKey: ['project', projectId] });
                toast.success('Capabilities updated');
              } catch (e) {
                toast.error(e instanceof Error ? e.message : 'Failed to save');
              } finally {
                setSavingCaps(false);
              }
            }
            function toggleCap(capId: string) {
              const next = currentCaps.includes(capId)
                ? currentCaps.filter((c) => c !== capId)
                : [...currentCaps, capId];
              saveCaps(next);
            }
            return (
              <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
                <h3 className="mb-1 font-semibold text-gray-900 dark:text-white">Capabilities</h3>
                <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">Enable or disable features for this project. Disabled capabilities are hidden from the hub.</p>
                <div className="space-y-3">
                  {allCaps.map((cap) => (
                    <label key={cap.id} className="flex cursor-pointer items-start gap-3">
                      <input
                        type="checkbox"
                        className="mt-0.5 h-4 w-4 rounded border-gray-300 text-indigo-600 dark:border-gray-600"
                        checked={currentCaps.includes(cap.id)}
                        onChange={() => toggleCap(cap.id)}
                        disabled={savingCaps}
                      />
                      <div>
                        <div className="text-sm font-medium text-gray-900 dark:text-white">{cap.label}</div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">{cap.description}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* Members — full width */}
          <div className="lg:col-span-2">
            <ProjectMembers projectId={projectId} />
          </div>

          {/* VS Code local workspace path */}
          <div className="lg:col-span-2 rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
            <h3 className="mb-1 font-semibold text-gray-900 dark:text-white flex items-center gap-2">
              <span className="text-lg">🖥</span> VS Code Navigation
            </h3>
            <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
              Set your local workspace root path (e.g. <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">C:\Projects\MyBCProject</code>).
              This enables right-click → "Open in VS Code" on any translation row to jump directly to the XLIFF file or AL source.
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="C:\Projects\MyBCProject"
                value={workspacePath ?? (project.localWorkspacePath ?? '')}
                onChange={(e) => setWorkspacePath(e.target.value)}
                className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-mono focus:border-indigo-400 focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
              />
              <button
                onClick={async () => {
                  const val = (workspacePath ?? project.localWorkspacePath ?? '').trim();
                  setSavingWorkspacePath(true);
                  try {
                    await api.patch(`/api/projects/${projectId}`, { localWorkspacePath: val || null });
                    qc.invalidateQueries({ queryKey: ['project', projectId] });
                    toast.success('Workspace path saved');
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : 'Failed to save');
                  } finally {
                    setSavingWorkspacePath(false);
                  }
                }}
                disabled={savingWorkspacePath}
                className="rounded-lg bg-indigo-50 px-4 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 dark:bg-indigo-900/30 dark:text-indigo-300"
              >
                {savingWorkspacePath ? 'Saving…' : 'Save'}
              </button>
            </div>
            {project.localWorkspacePath && (
              <p className="mt-2 text-xs text-green-600 dark:text-green-400">✓ Configured: <span className="font-mono">{project.localWorkspacePath}</span></p>
            )}
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
          <WorkItemsView projectId={projectId} customerId={project.customerId} />
        )}
      </div>
    );
  }

  // ─── AL Analysis view ───────────────────────────────────────────────────────
  if (view === 'al-analysis') {
    return (
      <div>
        {header}
        <ALAnalyserView
          projectId={projectId}
          xliffFiles={project.xliffFiles.map((f) => ({ id: f.id, filename: f.filename }))}
          onOpenTranslations={(xliffFileId, objectFilter) => {
            // Navigate to translations with the object filter applied via URL
            router.push(`/projects/${projectId}/translations?fileId=${xliffFileId}&objectFilter=${encodeURIComponent(objectFilter)}`);
          }}
        />
      </div>
    );
  }

  // ─── Translation Memory view ─────────────────────────────────────────────────
  if (view === 'translation-memory') {
    return (
      <div>
        {header}
        <TranslationMemoryView projectId={projectId} />
      </div>
    );
  }

  // ─── Compare view ────────────────────────────────────────────────────────────
  if (view === 'compare') {
    return (
      <div className="h-[calc(100vh-8rem)] flex flex-col">
        {header}
        <div className="flex-1 overflow-auto">
          <XliffCompareView
            projectId={projectId}
            files={project.xliffFiles.map((f) => ({
              id: f.id,
              filename: f.filename,
              remoteBranch: f.remoteBranch,
              remoteRepo: f.remoteRepo,
              uploadedAt: f.uploadedAt,
              lastSyncAt: null,
            }))}
            onBack={() => setView('translations')}
          />
        </div>
      </div>
    );
  }

  // ─── Documentation view ─────────────────────────────────────────────────────
  return (
    <div>
      {header}
      <DocumentationView projectId={projectId} customerId={project.customerId} />
    </div>
  );
}
