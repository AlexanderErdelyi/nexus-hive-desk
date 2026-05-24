'use client';

import { useEffect, useState } from 'react';
import { GitBranch, Loader2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { toast } from 'sonner';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProjectRepo {
  id: string;
  label?: string | null;
  connectionId: string;
  adoProjectName?: string | null;
  repoName: string;
  defaultBranch?: string | null;
}

interface Props {
  repos: ProjectRepo[];
  suggestedBranchName?: string;
  onClose: () => void;
  onCreated?: (repoId: string, branchName: string) => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function branchListUrl(repo: ProjectRepo): string {
  const { connectionId, adoProjectName, repoName } = repo;
  if (adoProjectName) {
    return `/api/remote/connections/${connectionId}/azure/projects/${encodeURIComponent(adoProjectName)}/repos/${encodeURIComponent(repoName)}/branches`;
  }
  const [owner, repoSlug] = repoName.split('/');
  return `/api/remote/connections/${connectionId}/github/repos/${owner}/${repoSlug}/branches`;
}

function branchCreateUrl(repo: ProjectRepo): string {
  return branchListUrl(repo); // same endpoint, POST vs GET
}

// ─── Component ───────────────────────────────────────────────────────────────

export function CreateBranchModal({ repos, suggestedBranchName, onClose, onCreated }: Props) {
  const [selectedRepoId, setSelectedRepoId] = useState(repos[0]?.id ?? '');
  const [sourceBranch, setSourceBranch] = useState('');
  const [branchName, setBranchName] = useState(suggestedBranchName ?? '');
  const [branches, setBranches] = useState<string[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [creating, setCreating] = useState(false);

  const selectedRepo = repos.find((r) => r.id === selectedRepoId) ?? repos[0];

  useEffect(() => {
    if (!selectedRepo) return;
    setLoadingBranches(true);
    setBranches([]);
    api
      .get<{ data: Array<{ name: string }> }>(branchListUrl(selectedRepo))
      .then((res) => {
        const names = res.data.map((b) => b.name);
        setBranches(names);
        const def = selectedRepo.defaultBranch ?? names[0] ?? '';
        setSourceBranch(def);
      })
      .catch(() => {
        toast.error('Could not load branches');
      })
      .finally(() => setLoadingBranches(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRepoId]);

  async function handleCreate() {
    const name = branchName.trim();
    if (!name) { toast.error('Branch name is required'); return; }
    if (!sourceBranch) { toast.error('Select a source branch'); return; }
    if (!selectedRepo) return;

    setCreating(true);
    try {
      await api.post(branchCreateUrl(selectedRepo), { name, sourceBranch });
      toast.success(`Branch "${name}" created`);
      onCreated?.(selectedRepo.id, name);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create branch');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-xl dark:bg-gray-900">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4 dark:border-gray-800">
          <div className="flex items-center gap-2">
            <GitBranch size={18} className="text-indigo-500" />
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Create Branch</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="space-y-4 px-5 py-4">
          {/* Repository selector (only shown when multiple repos) */}
          {repos.length > 1 && (
            <div className="space-y-1">
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">Repository</label>
              <select
                value={selectedRepoId}
                onChange={(e) => setSelectedRepoId(e.target.value)}
                className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-gray-700 dark:bg-gray-800 dark:text-white dark:focus:ring-indigo-900/40"
              >
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label ?? r.repoName}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Source branch */}
          <div className="space-y-1">
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">Source branch</label>
            {loadingBranches ? (
              <div className="flex items-center gap-2 rounded-xl border border-gray-200 px-3 py-2 dark:border-gray-700">
                <Loader2 size={14} className="animate-spin text-gray-400" />
                <span className="text-sm text-gray-400">Loading branches…</span>
              </div>
            ) : (
              <select
                value={sourceBranch}
                onChange={(e) => setSourceBranch(e.target.value)}
                className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-gray-700 dark:bg-gray-800 dark:text-white dark:focus:ring-indigo-900/40"
              >
                {branches.length === 0 && (
                  <option value="" disabled>No branches found</option>
                )}
                {branches.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            )}
          </div>

          {/* New branch name */}
          <div className="space-y-1">
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">New branch name</label>
            <input
              type="text"
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void handleCreate()}
              placeholder="e.g. feature/my-feature"
              className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm placeholder-gray-400 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-gray-700 dark:bg-gray-800 dark:text-white dark:placeholder-gray-600 dark:focus:ring-indigo-900/40"
              autoFocus
            />
            {branchName && branchName !== slugify(branchName) && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Suggestion: <button className="underline" onClick={() => setBranchName(slugify(branchName))}>{slugify(branchName)}</button>
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-gray-100 px-5 py-4 dark:border-gray-800">
          <button
            onClick={onClose}
            className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleCreate()}
            disabled={creating || !branchName.trim() || !sourceBranch}
            className="flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 active:bg-indigo-800"
          >
            {creating ? <Loader2 size={14} className="animate-spin" /> : <GitBranch size={14} />}
            Create Branch
          </button>
        </div>
      </div>
    </div>
  );
}
