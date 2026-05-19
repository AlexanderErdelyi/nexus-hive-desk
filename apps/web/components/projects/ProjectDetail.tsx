'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, GitCommit, Loader2, Sparkles, Trash2, Upload } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { ProjectMembers } from './ProjectMembers';
import { formatDate } from '@/lib/utils';

interface Project {
  id: string;
  name: string;
  description?: string;
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
  const [commitMsg, setCommitMsg] = useState('');
  const [showCommitDialog, setShowCommitDialog] = useState<string | null>(null);

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
      if (!commitMsg.trim()) {
        toast.error('Please enter a commit message');
        return;
      }

      setCommittingFile(file.id);
      try {
        // Get the current XLIFF content with all translations applied
        const contentRes = await api.get<{ data: { content: string } }>(
          `/api/projects/${projectId}/xliff/${file.id}/content`
        );

        const connId = file.remoteConnectionId;
        const repo = file.remoteRepo;

        // Determine if Azure DevOps or GitHub based on repo format
        // Azure DevOps: "org/project/repo", GitHub: "owner/repo"
        const repoParts = repo.split('/');

        if (repoParts.length === 3) {
          // Azure DevOps
          const [, azProject, repoId] = repoParts;
          await api.post(
            `/api/remote/connections/${connId}/azure/projects/${encodeURIComponent(azProject)}/repos/${encodeURIComponent(repoId)}/commit`,
            {
              branch: file.remoteBranch,
              path: file.remotePath,
              content: contentRes.data.content,
              message: commitMsg,
            }
          );
        } else {
          // GitHub
          const [owner, repoName] = repoParts;
          // Need to get the current SHA first
          const params = new URLSearchParams({ path: file.remotePath, branch: file.remoteBranch });
          const fileInfo = await api.get<{ data: { sha: string } }>(
            `/api/remote/connections/${connId}/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/file-content?${params}`
          );

          await api.post(
            `/api/remote/connections/${connId}/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/commit`,
            {
              branch: file.remoteBranch,
              path: file.remotePath,
              content: contentRes.data.content,
              message: commitMsg,
              sha: fileInfo.data.sha,
            }
          );
        }

        toast.success(`Committed to ${file.remoteBranch}`);
        setShowCommitDialog(null);
        setCommitMsg('');
      } catch (error) {
        toast.error(getErrorMessage(error));
      } finally {
        setCommittingFile(null);
      }
    },
    [projectId, commitMsg]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'application/xml': ['.xlf', '.xliff'], 'text/xml': ['.xlf', '.xliff'] },
    multiple: false,
  });

  const project = data?.data;

  if (isLoading) return <div className="py-12 text-center text-gray-400 dark:text-gray-600">Loading...</div>;
  if (!project) return <div className="py-12 text-center text-red-500">Project not found</div>;

  return (
    <div>
      <div className="mb-6 flex items-center gap-3">
        <Link href="/projects" className="text-gray-400 hover:text-gray-600 dark:text-gray-600 dark:hover:text-gray-300">
          <ArrowLeft size={20} />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{project.name}</h1>
          {project.description && <p className="text-sm text-gray-500 dark:text-gray-400">{project.description}</p>}
        </div>
      </div>

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
          </div>

          <div className="mt-4 rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
            <h3 className="mb-2 font-semibold text-gray-900 dark:text-white">Settings</h3>
            <div className="space-y-1 text-sm text-gray-600 dark:text-gray-400">
              <div className="flex justify-between">
                <span>Source</span>
                <span className="font-mono text-gray-900 dark:text-gray-200">{project.sourceLanguage}</span>
              </div>
              <div className="flex justify-between">
                <span>Target</span>
                <span className="font-mono text-gray-900 dark:text-gray-200">{project.targetLanguage}</span>
              </div>
              <div className="flex justify-between">
                <span>Glossary terms</span>
                <span className="text-gray-900 dark:text-gray-200">{project._count.glossaryEntries}</span>
              </div>
            </div>
            <div className="mt-3">
              <a
                href={`/projects/${project.id}/glossary`}
                className="rounded-lg bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                Manage Glossary
              </a>
            </div>
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
                  <div
                    key={file.id}
                    className="rounded-lg border border-gray-100 p-3 hover:border-gray-200 dark:border-gray-800 dark:hover:border-gray-700"
                  >
                    <div className="flex items-center justify-between">
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
                      <div className="flex gap-2">
                        <a
                          href={`/projects/${project.id}/translations?fileId=${file.id}`}
                          className="flex items-center gap-1 rounded-lg bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:text-indigo-400 dark:hover:bg-indigo-900/50"
                        >
                          <Sparkles size={13} /> Translate
                        </a>
                        {file.remoteRepo && (
                          <button
                            onClick={() => {
                              setShowCommitDialog(file.id);
                              setCommitMsg(`Update translations in ${file.filename}`);
                            }}
                            className="flex items-center gap-1 rounded-lg bg-green-50 px-3 py-1.5 text-xs font-medium text-green-700 hover:bg-green-100 dark:bg-green-900/30 dark:text-green-400 dark:hover:bg-green-900/50"
                          >
                            <GitCommit size={13} /> Commit
                          </button>
                        )}
                        <a
                          href={`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'}/api/projects/${project.id}/xliff/${file.id}/download`}
                          className="flex items-center gap-1 rounded-lg bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
                          download
                        >
                          <Download size={13} /> Download
                        </a>
                        <button
                          onClick={() => {
                            if (confirm(`Delete "${file.filename}"? This cannot be undone.`)) {
                              deleteFileMutation.mutate(file.id);
                            }
                          }}
                          disabled={deleteFileMutation.isPending}
                          className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40 dark:text-gray-600 dark:hover:bg-red-900/20 dark:hover:text-red-400"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>

                    {/* Commit dialog */}
                    {showCommitDialog === file.id && (
                      <div className="mt-3 rounded-lg border border-green-200 bg-green-50 p-3 dark:border-green-800 dark:bg-green-900/20">
                        <p className="mb-2 text-xs font-medium text-green-800 dark:text-green-300">
                          Commit to: {file.remoteRepo} ({file.remoteBranch})
                        </p>
                        <input
                          className="mb-2 w-full rounded border border-green-300 px-2 py-1.5 text-sm dark:border-green-700 dark:bg-gray-800 dark:text-white"
                          value={commitMsg}
                          onChange={(e) => setCommitMsg(e.target.value)}
                          placeholder="Commit message"
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={() => commitToRemote(file)}
                            disabled={committingFile === file.id || !commitMsg.trim()}
                            className="flex items-center gap-1 rounded bg-green-600 px-3 py-1 text-xs text-white hover:bg-green-700 disabled:opacity-50"
                          >
                            {committingFile === file.id ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <GitCommit size={12} />
                            )}
                            {committingFile === file.id ? 'Committing...' : 'Commit'}
                          </button>
                          <button
                            onClick={() => setShowCommitDialog(null)}
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

      {/* Members Section */}
      <div className="mt-6">
        <ProjectMembers projectId={projectId} />
      </div>
    </div>
  );
}
