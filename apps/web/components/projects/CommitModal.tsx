'use client';

import { useState, useEffect, useRef } from 'react';
import {
  X, GitBranch, GitCommit, GitPullRequest, Search, Plus, Loader2,
  CheckCircle2, XCircle, Clock, ExternalLink, Sparkles, ChevronRight,
} from 'lucide-react';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

// ─── Types ───────────────────────────────────────────────────────────────────

interface WorkItem {
  id: number;
  title: string;
  state: string;
  type: string;
}

interface PrStatus {
  prId: number;
  title: string;
  status: 'active' | 'completed' | 'abandoned' | 'open' | 'closed';
  createdBy?: string;
  createdAt?: string;
  closedAt?: string;
  webUrl?: string;
}

interface XliffFile {
  id: string;
  filename: string;
  remoteConnectionId?: string;
  remotePath?: string;
  remoteBranch?: string;
  remoteRepo?: string;
  remotePrId?: string | null;
  remotePrUrl?: string | null;
}

type Step = 'commit' | 'workitem' | 'pr' | 'done';

interface Props {
  projectId: string;
  file: XliffFile;
  /** ADO project name extracted from file.remoteRepo (last -2 part) */
  adoProject: string;
  /** Repo identifier (last part of remoteRepo, or GUID) */
  repoId: string;
  /** Is this an ADO connection? (determines work item / PR availability) */
  isAdo: boolean;
  /** For GitHub: owner/repo */
  githubOwner?: string;
  githubRepo?: string;
  onDone: (updatedFile?: Partial<XliffFile>) => void;
  onClose: () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function PrStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; icon: React.ReactNode; cls: string }> = {
    active:    { label: 'Open',     icon: <Clock size={11} />,        cls: 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' },
    open:      { label: 'Open',     icon: <Clock size={11} />,        cls: 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' },
    completed: { label: 'Merged',   icon: <CheckCircle2 size={11} />, cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' },
    closed:    { label: 'Closed',   icon: <XCircle size={11} />,      cls: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300' },
    abandoned: { label: 'Abandoned',icon: <XCircle size={11} />,      cls: 'bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-300' },
  };
  const s = map[status] ?? map.active;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', s.cls)}>
      {s.icon} {s.label}
    </span>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function CommitModal({
  projectId, file, adoProject, repoId, isAdo, githubOwner, githubRepo, onDone, onClose,
}: Props) {
  const connId = file.remoteConnectionId!;

  // ── Step ────────────────────────────────────────────────────────────────────
  const [step, setStep] = useState<Step>('commit');

  // ── Commit step ─────────────────────────────────────────────────────────────
  const [commitMsg, setCommitMsg] = useState(`Update translations in ${file.filename}`);
  const [createBranch, setCreateBranch] = useState(false);
  const [branchName, setBranchName] = useState(`translations/${new Date().toISOString().slice(0, 10)}`);
  const [committing, setCommitting] = useState(false);
  const [committedBranch, setCommittedBranch] = useState('');

  // ── Work item step ───────────────────────────────────────────────────────────
  const [wiSearch, setWiSearch] = useState('');
  const [wiResults, setWiResults] = useState<WorkItem[]>([]);
  const [wiLoading, setWiLoading] = useState(false);
  const [selectedWi, setSelectedWi] = useState<WorkItem | null>(null);
  const [creatingWi, setCreatingWi] = useState(false);
  const [newWiTitle, setNewWiTitle] = useState('');
  const [newWiDesc, setNewWiDesc] = useState('');
  const [aiSuggesting, setAiSuggesting] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── PR step ──────────────────────────────────────────────────────────────────
  const [prTitle, setPrTitle] = useState('');
  const [prDesc, setPrDesc] = useState('');
  const [targetBranch, setTargetBranch] = useState(file.remoteBranch ?? 'main');
  const [creatingPr, setCreatingPr] = useState(false);
  const [prInfo, setPrInfo] = useState<PrStatus | null>(null);

  // ── Existing PR status ───────────────────────────────────────────────────────
  const [prStatus, setPrStatus] = useState<PrStatus | null>(null);
  const [loadingPrStatus, setLoadingPrStatus] = useState(false);

  // Load existing PR status on mount if there's a stored PR
  useEffect(() => {
    if (file.remotePrId) fetchPrStatus(file.remotePrId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-search work items when step becomes workitem
  useEffect(() => {
    if (step === 'workitem' && isAdo) searchWorkItems('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Suggest PR title based on committed branch / work item
  useEffect(() => {
    if (step === 'pr') {
      const base = selectedWi ? `#${selectedWi.id}: ${selectedWi.title}` : `Translations update: ${committedBranch}`;
      setPrTitle(base);
      setTargetBranch(file.remoteBranch ?? 'main');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // ── Work items ──────────────────────────────────────────────────────────────

  async function searchWorkItems(q: string) {
    setWiLoading(true);
    try {
      const params = new URLSearchParams({ q, top: '20' });
      const res = await api.get<{ data: WorkItem[] }>(
        `/api/remote/connections/${connId}/azure/projects/${encodeURIComponent(adoProject)}/work-items/search?${params}`
      );
      setWiResults(res.data);
    } catch {
      // swallow — show empty list
    } finally {
      setWiLoading(false);
    }
  }

  function onWiSearchChange(v: string) {
    setWiSearch(v);
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => searchWorkItems(v), 350);
  }

  async function suggestWiWithAI() {
    setAiSuggesting(true);
    try {
      const res = await api.post<{ data: { title?: string; description?: string } }>(
        '/api/ai/quick-suggest',
        {
          prompt: `Suggest a short Azure DevOps work item title and brief description for a translation update task on file "${file.filename}" (branch: "${committedBranch || branchName}"). Keep title under 80 chars. Respond in JSON: {"title":"...", "description":"..."}`,
        }
      );
      if (res.data.title) setNewWiTitle(res.data.title);
      if (res.data.description) setNewWiDesc(res.data.description);
      setShowCreateForm(true);
    } catch {
      toast.error('AI suggestion failed — fill in manually');
      setShowCreateForm(true);
    } finally {
      setAiSuggesting(false);
    }
  }

  async function createWorkItem() {
    if (!newWiTitle.trim()) { toast.error('Title is required'); return; }
    setCreatingWi(true);
    try {
      const res = await api.post<{ data: WorkItem }>(
        `/api/remote/connections/${connId}/azure/projects/${encodeURIComponent(adoProject)}/work-items/Task`,
        { title: newWiTitle.trim(), description: newWiDesc.trim() || undefined }
      );
      setSelectedWi(res.data);
      toast.success(`Work item #${res.data.id} created`);
      setShowCreateForm(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create work item');
    } finally {
      setCreatingWi(false);
    }
  }

  // ── Commit ──────────────────────────────────────────────────────────────────

  async function doCommit() {
    if (!commitMsg.trim()) { toast.error('Commit message is required'); return; }
    if (createBranch && !branchName.trim()) { toast.error('Branch name is required'); return; }

    setCommitting(true);
    try {
      const targetBr = createBranch ? branchName.trim() : (file.remoteBranch ?? 'main');
      const contentRes = await api.get<{ data: { content: string } }>(
        `/api/projects/${projectId}/xliff/${file.id}/content`
      );

      if (isAdo) {
        if (createBranch) {
          await api.post(
            `/api/remote/connections/${connId}/azure/projects/${encodeURIComponent(adoProject)}/repos/${encodeURIComponent(repoId)}/branches`,
            { name: branchName.trim(), sourceBranch: file.remoteBranch }
          );
        }
        await api.post(
          `/api/remote/connections/${connId}/azure/projects/${encodeURIComponent(adoProject)}/repos/${encodeURIComponent(repoId)}/commit`,
          { branch: targetBr, path: file.remotePath, content: contentRes.data.content, message: commitMsg }
        );
      } else {
        // GitHub
        if (createBranch) {
          await api.post(
            `/api/remote/connections/${connId}/github/repos/${githubOwner}/${githubRepo}/branches`,
            { name: branchName.trim(), sourceBranch: file.remoteBranch }
          );
        }
        const params = new URLSearchParams({ path: file.remotePath!, branch: targetBr });
        const fileInfo = await api.get<{ data: { sha: string } }>(
          `/api/remote/connections/${connId}/github/repos/${githubOwner}/${githubRepo}/file-content?${params}`
        );
        await api.post(
          `/api/remote/connections/${connId}/github/repos/${githubOwner}/${githubRepo}/commit`,
          { branch: targetBr, path: file.remotePath, content: contentRes.data.content, message: commitMsg, sha: fileInfo.data.sha }
        );
      }

      // Update stored branch if switched
      if (createBranch) {
        await api.patch(`/api/projects/${projectId}/xliff/${file.id}/remote`, {
          remoteConnectionId: file.remoteConnectionId,
          remotePath: file.remotePath,
          remoteBranch: targetBr,
          remoteRepo: file.remoteRepo,
        });
      }

      setCommittedBranch(targetBr);
      toast.success(`Committed to ${targetBr}`);

      if (createBranch && isAdo) {
        setStep('workitem');
      } else {
        setStep('pr');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Commit failed');
    } finally {
      setCommitting(false);
    }
  }

  // ── Create PR ───────────────────────────────────────────────────────────────

  async function doCreatePr() {
    if (!prTitle.trim()) { toast.error('PR title is required'); return; }
    setCreatingPr(true);
    try {
      const workItemIds = selectedWi ? [selectedWi.id] : [];
      const sourceBranch = committedBranch || (createBranch ? branchName : file.remoteBranch ?? '');

      let prRes: PrStatus;
      if (isAdo) {
        const res = await api.post<{ data: PrStatus }>(
          `/api/remote/connections/${connId}/azure/projects/${encodeURIComponent(adoProject)}/repos/${encodeURIComponent(repoId)}/pull-requests`,
          { title: prTitle, description: prDesc, sourceBranch, targetBranch, workItemIds }
        );
        prRes = res.data;
      } else {
        const res = await api.post<{ data: PrStatus }>(
          `/api/remote/connections/${connId}/github/repos/${githubOwner}/${githubRepo}/pull-requests`,
          { title: prTitle, description: prDesc, sourceBranch, targetBranch }
        );
        prRes = res.data;
      }

      // Persist PR info
      await api.patch(`/api/projects/${projectId}/xliff/${file.id}/remote`, {
        remotePrId: String(prRes.prId),
        remotePrUrl: prRes.webUrl ?? null,
      });

      setPrInfo(prRes);
      toast.success(`PR #${prRes.prId} created`);
      setStep('done');
      onDone({ remotePrId: String(prRes.prId), remotePrUrl: prRes.webUrl ?? null, remoteBranch: committedBranch || file.remoteBranch });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create PR');
    } finally {
      setCreatingPr(false);
    }
  }

  // ── Fetch existing PR status ─────────────────────────────────────────────────

  async function fetchPrStatus(prId: string) {
    setLoadingPrStatus(true);
    try {
      let res: { data: PrStatus };
      if (isAdo) {
        res = await api.get(`/api/remote/connections/${connId}/azure/projects/${encodeURIComponent(adoProject)}/repos/${encodeURIComponent(repoId)}/pull-requests/${prId}`);
      } else {
        res = await api.get(`/api/remote/connections/${connId}/github/repos/${githubOwner}/${githubRepo}/pull-requests/${prId}`);
      }
      setPrStatus(res.data);
    } catch {
      // silently fail — PR might have been deleted
    } finally {
      setLoadingPrStatus(false);
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────────────

  const stepTitles: Record<Step, string> = {
    commit:   'Commit to Remote',
    workitem: 'Link Work Item',
    pr:       'Create Pull Request',
    done:     'Done',
  };

  const steps: Step[] = isAdo ? ['commit', 'workitem', 'pr', 'done'] : ['commit', 'pr', 'done'];
  const stepIdx = steps.indexOf(step);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900">

        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4 dark:border-gray-800">
          <h2 className="font-semibold text-gray-900 dark:text-white">{stepTitles[step]}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <X size={18} />
          </button>
        </div>

        {/* Progress pills */}
        <div className="flex items-center gap-1 border-b border-gray-100 px-5 py-2.5 dark:border-gray-800">
          {steps.filter((s) => s !== 'done').map((s, i) => (
            <div key={s} className="flex items-center gap-1">
              {i > 0 && <ChevronRight size={12} className="text-gray-300 dark:text-gray-700" />}
              <span className={cn(
                'rounded-full px-2.5 py-0.5 text-xs font-medium',
                i < stepIdx
                  ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                  : i === stepIdx
                    ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300'
                    : 'bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-600'
              )}>
                {{ commit: 'Commit', workitem: 'Work Item', pr: 'Pull Request' }[s]}
              </span>
            </div>
          ))}
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-5">

          {/* ── COMMIT STEP ────────────────────────────────────────────────── */}
          {step === 'commit' && (
            <div className="space-y-3">
              {/* Existing PR badge */}
              {file.remotePrId && (
                <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-800">
                  <div className="flex items-center gap-2 text-sm">
                    <GitPullRequest size={14} className="text-gray-400" />
                    {loadingPrStatus
                      ? <span className="text-gray-400 text-xs">Loading PR…</span>
                      : prStatus
                        ? <>
                            <span className="text-gray-600 dark:text-gray-400">PR #{prStatus.prId}</span>
                            <PrStatusBadge status={prStatus.status} />
                          </>
                        : <span className="text-gray-500 dark:text-gray-400 text-xs">PR #{file.remotePrId}</span>
                    }
                  </div>
                  {(prStatus?.webUrl ?? file.remotePrUrl) && (
                    <a
                      href={prStatus?.webUrl ?? file.remotePrUrl!}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-indigo-500 hover:text-indigo-700"
                    >
                      <ExternalLink size={13} />
                    </a>
                  )}
                </div>
              )}

              <p className="text-xs text-gray-500 dark:text-gray-400">
                File: <span className="font-mono">{file.remoteRepo}</span> / <span className="font-mono">{file.remoteBranch}</span>
              </p>

              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">Commit message</label>
                <input
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                  value={commitMsg}
                  onChange={(e) => setCommitMsg(e.target.value)}
                  placeholder="Commit message"
                />
              </div>

              <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={createBranch}
                  onChange={(e) => setCreateBranch(e.target.checked)}
                  className="rounded"
                />
                <GitBranch size={14} /> Create new branch
              </label>

              {createBranch ? (
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">New branch name</label>
                  <input
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                    value={branchName}
                    onChange={(e) => setBranchName(e.target.value)}
                    placeholder="feature/my-branch"
                  />
                  <p className="mt-1 text-xs text-gray-400">Based on: <span className="font-mono">{file.remoteBranch}</span></p>
                </div>
              ) : (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  → Committing to: <span className="rounded bg-gray-100 px-1.5 font-mono dark:bg-gray-800">{file.remoteBranch}</span>
                </p>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  onClick={doCommit}
                  disabled={committing || !commitMsg.trim()}
                  className="flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
                >
                  {committing ? <Loader2 size={14} className="animate-spin" /> : <GitCommit size={14} />}
                  {committing ? 'Committing…' : createBranch ? 'Create Branch & Commit' : 'Commit'}
                </button>
                <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-400">
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* ── WORK ITEM STEP ─────────────────────────────────────────────── */}
          {step === 'workitem' && isAdo && (
            <div className="space-y-3">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Committed to <span className="font-mono text-indigo-600 dark:text-indigo-400">{committedBranch}</span>.
                Link a work item to this branch (optional).
              </p>

              {selectedWi ? (
                <div className="flex items-center justify-between rounded-lg border border-green-200 bg-green-50 px-3 py-2.5 dark:border-green-800 dark:bg-green-900/20">
                  <div>
                    <p className="text-xs font-semibold text-green-700 dark:text-green-300">#{selectedWi.id} · {selectedWi.type}</p>
                    <p className="text-sm text-green-800 dark:text-green-200">{selectedWi.title}</p>
                  </div>
                  <button onClick={() => setSelectedWi(null)} className="text-green-400 hover:text-green-600">
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <>
                  {/* Search */}
                  <div className="relative">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input
                      className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                      placeholder="Search by title or ID…"
                      value={wiSearch}
                      onChange={(e) => onWiSearchChange(e.target.value)}
                    />
                  </div>

                  {/* Results */}
                  <div className="max-h-44 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700">
                    {wiLoading ? (
                      <div className="flex items-center justify-center py-6">
                        <Loader2 size={18} className="animate-spin text-gray-400" />
                      </div>
                    ) : wiResults.length === 0 ? (
                      <p className="py-4 text-center text-xs text-gray-400">No work items found</p>
                    ) : (
                      <ul>
                        {wiResults.map((wi) => (
                          <li key={wi.id}>
                            <button
                              onClick={() => setSelectedWi(wi)}
                              className="flex w-full items-start gap-2 border-b border-gray-100 px-3 py-2 text-left last:border-0 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800"
                            >
                              <span className="mt-0.5 shrink-0 rounded bg-gray-100 px-1 font-mono text-xs text-gray-500 dark:bg-gray-800 dark:text-gray-400">#{wi.id}</span>
                              <div className="min-w-0">
                                <p className="truncate text-sm text-gray-900 dark:text-white">{wi.title}</p>
                                <p className="text-xs text-gray-400">{wi.type} · {wi.state}</p>
                              </div>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </>
              )}

              {/* Create new work item */}
              {!selectedWi && (
                <div>
                  {showCreateForm ? (
                    <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 dark:border-indigo-800 dark:bg-indigo-900/20 space-y-2">
                      <p className="text-xs font-semibold text-indigo-700 dark:text-indigo-300">New Work Item (Task)</p>
                      <input
                        className="w-full rounded border border-indigo-300 px-2 py-1.5 text-sm dark:border-indigo-700 dark:bg-gray-800 dark:text-white"
                        placeholder="Title*"
                        value={newWiTitle}
                        onChange={(e) => setNewWiTitle(e.target.value)}
                      />
                      <textarea
                        className="w-full resize-none rounded border border-indigo-300 px-2 py-1.5 text-sm dark:border-indigo-700 dark:bg-gray-800 dark:text-white"
                        placeholder="Description (optional)"
                        rows={2}
                        value={newWiDesc}
                        onChange={(e) => setNewWiDesc(e.target.value)}
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={createWorkItem}
                          disabled={creatingWi || !newWiTitle.trim()}
                          className="flex items-center gap-1 rounded bg-indigo-600 px-3 py-1 text-xs text-white hover:bg-indigo-700 disabled:opacity-50"
                        >
                          {creatingWi ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
                          Create
                        </button>
                        <button onClick={() => setShowCreateForm(false)} className="rounded border border-indigo-300 px-3 py-1 text-xs text-indigo-700 dark:text-indigo-400">
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <button
                        onClick={() => setShowCreateForm(true)}
                        className="flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
                      >
                        <Plus size={12} /> Create new
                      </button>
                      <button
                        onClick={suggestWiWithAI}
                        disabled={aiSuggesting}
                        className="flex items-center gap-1 rounded-lg border border-purple-300 bg-purple-50 px-3 py-1.5 text-xs text-purple-700 hover:bg-purple-100 disabled:opacity-50 dark:border-purple-700 dark:bg-purple-900/20 dark:text-purple-300"
                      >
                        {aiSuggesting ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                        AI Suggest
                      </button>
                    </div>
                  )}
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => setStep('pr')}
                  className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
                >
                  <GitPullRequest size={14} />
                  {selectedWi ? 'Continue to PR' : 'Skip — Create PR'}
                </button>
                <button
                  onClick={() => { onDone({ remoteBranch: committedBranch || file.remoteBranch }); onClose(); }}
                  className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-400"
                >
                  Done (no PR)
                </button>
              </div>
            </div>
          )}

          {/* ── PR STEP ────────────────────────────────────────────────────── */}
          {step === 'pr' && (
            <div className="space-y-3">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Create a Pull Request to merge <span className="font-mono text-indigo-600 dark:text-indigo-400">{committedBranch}</span> into your target branch.
              </p>

              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">PR Title</label>
                <input
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                  value={prTitle}
                  onChange={(e) => setPrTitle(e.target.value)}
                  placeholder="Pull request title"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">Target branch</label>
                <input
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                  value={targetBranch}
                  onChange={(e) => setTargetBranch(e.target.value)}
                  placeholder="main"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">Description (optional)</label>
                <textarea
                  className="w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                  rows={3}
                  value={prDesc}
                  onChange={(e) => setPrDesc(e.target.value)}
                  placeholder="Describe what was changed and why…"
                />
              </div>

              {selectedWi && (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  🔗 Linked to work item #{selectedWi.id}: {selectedWi.title}
                </p>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  onClick={doCreatePr}
                  disabled={creatingPr || !prTitle.trim()}
                  className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  {creatingPr ? <Loader2 size={14} className="animate-spin" /> : <GitPullRequest size={14} />}
                  {creatingPr ? 'Creating…' : 'Create PR'}
                </button>
                <button
                  onClick={() => { onDone({ remoteBranch: committedBranch || file.remoteBranch }); onClose(); }}
                  className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-400"
                >
                  Skip PR
                </button>
              </div>
            </div>
          )}

          {/* ── DONE ──────────────────────────────────────────────────────── */}
          {step === 'done' && (
            <div className="space-y-4 text-center">
              <CheckCircle2 size={40} className="mx-auto text-green-500" />
              <p className="font-semibold text-gray-900 dark:text-white">All done!</p>
              {prInfo && (
                <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-left dark:border-green-800 dark:bg-green-900/20">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-semibold text-green-700 dark:text-green-300">PR #{prInfo.prId} created</p>
                      <p className="text-sm text-green-800 dark:text-green-200">{prInfo.title}</p>
                    </div>
                    {prInfo.webUrl && (
                      <a href={prInfo.webUrl} target="_blank" rel="noopener noreferrer" className="text-green-600 hover:text-green-800 dark:text-green-400">
                        <ExternalLink size={16} />
                      </a>
                    )}
                  </div>
                </div>
              )}
              <button
                onClick={onClose}
                className="rounded-lg bg-indigo-600 px-6 py-2 text-sm font-medium text-white hover:bg-indigo-700"
              >
                Close
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
