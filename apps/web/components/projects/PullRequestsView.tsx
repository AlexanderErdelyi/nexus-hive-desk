'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  Check,
  ExternalLink,
  GitPullRequest,
  Loader2,
  MessageSquare,
  RefreshCw,
  ThumbsDown,
  ThumbsUp,
  User,
  X,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';

interface Reviewer {
  name: string;
  vote: number; // ADO: 10/5/0/-5/-10 | GitHub: always 0 (pending)
}

interface PullRequest {
  id: string;
  title: string;
  author: string;
  status: string;
  sourceBranch: string;
  targetBranch: string;
  reviewers: Reviewer[];
  createdAt: string;
  url: string;
  repoLabel: string;
  provider: 'github' | 'azure-devops';
  connectionId: string;
  adoProjectName?: string;
  repoSlug: string;
}

interface RepoError {
  repoLabel: string;
  error: string;
}

interface PRResponse {
  data: PullRequest[];
  errors?: RepoError[];
}

// ── Vote helpers ───────────────────────────────────────────────────────────────

function voteLabel(vote: number): string {
  if (vote === 10) return 'Approved';
  if (vote === 5) return 'Approved with suggestions';
  if (vote === -5) return 'Waiting for author';
  if (vote === -10) return 'Rejected';
  return 'No vote';
}

function voteCls(vote: number): string {
  if (vote === 10) return 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400';
  if (vote === 5) return 'bg-teal-50 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400';
  if (vote === -5) return 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
  if (vote === -10) return 'bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-400';
  return 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400';
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const colors =
    status === 'active' || status === 'open'
      ? 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400'
      : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400';
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${colors}`}>{status}</span>
  );
}

function ReviewerBadge({ reviewer, provider }: { reviewer: Reviewer; provider: 'github' | 'azure-devops' }) {
  const showVote = provider === 'azure-devops' && reviewer.vote !== 0;
  return (
    <span
      className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${showVote ? voteCls(reviewer.vote) : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'}`}
      title={showVote ? voteLabel(reviewer.vote) : reviewer.name}
    >
      <User size={10} />
      {reviewer.name}
      {showVote && reviewer.vote === 10 && <Check size={10} />}
      {showVote && reviewer.vote === -10 && <X size={10} />}
    </span>
  );
}

// ── Comment dialog ─────────────────────────────────────────────────────────────

interface CommentDialogProps {
  pr: PullRequest;
  onClose: () => void;
  onSubmit: (content: string) => Promise<void>;
}

function CommentDialog({ pr, onClose, onSubmit }: CommentDialogProps) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  async function handleSubmit() {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await onSubmit(text.trim());
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800/50">
      <p className="mb-2 text-xs font-medium text-gray-600 dark:text-gray-400">
        Comment on <span className="font-semibold">{pr.title}</span>
      </p>
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoFocus
        rows={3}
        placeholder="Leave a comment…"
        className="w-full resize-none rounded border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-indigo-400 focus:outline-none dark:border-gray-600 dark:bg-gray-900 dark:text-white dark:placeholder-gray-500"
      />
      <div className="mt-2 flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={!text.trim() || busy}
          className="flex items-center gap-1.5 rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <MessageSquare size={12} />}
          Submit
        </button>
      </div>
    </div>
  );
}

// ── PR action buttons ──────────────────────────────────────────────────────────

interface PRActionsProps {
  pr: PullRequest;
  projectId: string;
}

function PRActions({ pr, projectId }: PRActionsProps) {
  const qc = useQueryClient();
  const [showComment, setShowComment] = useState(false);

  function buildUrl(path: string) {
    return `/connections/${pr.connectionId}${path}`;
  }

  const onSuccess = () => qc.invalidateQueries({ queryKey: ['project-prs', projectId] });

  const adoVoteMutation = useMutation({
    mutationFn: (vote: number) =>
      api.put(
        buildUrl(`/azure/projects/${encodeURIComponent(pr.adoProjectName ?? '')}/repos/${encodeURIComponent(pr.repoSlug)}/pull-requests/${pr.id}/vote`),
        { vote }
      ),
    onSuccess: (_, vote) => {
      toast.success(voteLabel(vote));
      onSuccess();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed to submit vote'),
  });

  const githubReviewMutation = useMutation({
    mutationFn: (payload: { event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'; body?: string }) => {
      const [owner, repo] = pr.repoSlug.split('/');
      return api.post(
        buildUrl(`/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pull-requests/${pr.id}/review`),
        payload
      );
    },
    onSuccess: (_, { event }) => {
      toast.success(event === 'APPROVE' ? 'Approved' : event === 'REQUEST_CHANGES' ? 'Requested changes' : 'Comment posted');
      onSuccess();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed to submit review'),
  });

  const commentMutation = useMutation({
    mutationFn: (content: string) => {
      if (pr.provider === 'azure-devops') {
        return api.post(
          buildUrl(`/azure/projects/${encodeURIComponent(pr.adoProjectName ?? '')}/repos/${encodeURIComponent(pr.repoSlug)}/pull-requests/${pr.id}/threads`),
          { content }
        );
      }
      const [owner, repo] = pr.repoSlug.split('/');
      return api.post(
        buildUrl(`/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pull-requests/${pr.id}/review`),
        { event: 'COMMENT', body: content }
      );
    },
    onSuccess: () => {
      toast.success('Comment posted');
      onSuccess();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed to post comment'),
  });

  const busy = adoVoteMutation.isPending || githubReviewMutation.isPending || commentMutation.isPending;

  return (
    <div className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-800">
      <div className="flex flex-wrap items-center gap-1.5">
        {pr.provider === 'azure-devops' ? (
          <>
            <ActionBtn
              icon={<ThumbsUp size={12} />}
              label="Approve"
              busy={busy}
              onClick={() => adoVoteMutation.mutate(10)}
              variant="green"
            />
            <ActionBtn
              icon={<Check size={12} />}
              label="Approve w/ suggestions"
              busy={busy}
              onClick={() => adoVoteMutation.mutate(5)}
              variant="teal"
            />
            <ActionBtn
              icon={<ThumbsDown size={12} />}
              label="Request changes"
              busy={busy}
              onClick={() => adoVoteMutation.mutate(-10)}
              variant="red"
            />
          </>
        ) : (
          <>
            <ActionBtn
              icon={<ThumbsUp size={12} />}
              label="Approve"
              busy={busy}
              onClick={() => githubReviewMutation.mutate({ event: 'APPROVE' })}
              variant="green"
            />
            <ActionBtn
              icon={<ThumbsDown size={12} />}
              label="Request changes"
              busy={busy}
              onClick={() => githubReviewMutation.mutate({ event: 'REQUEST_CHANGES', body: '' })}
              variant="red"
            />
          </>
        )}
        <ActionBtn
          icon={<MessageSquare size={12} />}
          label="Comment"
          busy={busy}
          onClick={() => setShowComment((v) => !v)}
          variant="gray"
          active={showComment}
        />
      </div>

      {showComment && (
        <CommentDialog
          pr={pr}
          onClose={() => setShowComment(false)}
          onSubmit={async (content) => { await commentMutation.mutateAsync(content); }}
        />
      )}
    </div>
  );
}

interface ActionBtnProps {
  icon: React.ReactNode;
  label: string;
  busy: boolean;
  onClick: () => void;
  variant: 'green' | 'teal' | 'red' | 'gray';
  active?: boolean;
}

function ActionBtn({ icon, label, busy, onClick, variant, active }: ActionBtnProps) {
  const cls = {
    green: 'text-green-700 bg-green-50 hover:bg-green-100 dark:text-green-400 dark:bg-green-900/20 dark:hover:bg-green-900/40',
    teal: 'text-teal-700 bg-teal-50 hover:bg-teal-100 dark:text-teal-400 dark:bg-teal-900/20 dark:hover:bg-teal-900/40',
    red: 'text-red-600 bg-red-50 hover:bg-red-100 dark:text-red-400 dark:bg-red-900/20 dark:hover:bg-red-900/40',
    gray: 'text-gray-600 bg-gray-100 hover:bg-gray-200 dark:text-gray-400 dark:bg-gray-800 dark:hover:bg-gray-700',
  }[variant];

  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${cls} ${active ? 'ring-1 ring-current ring-offset-1' : ''}`}
    >
      {busy ? <Loader2 size={12} className="animate-spin" /> : icon}
      {label}
    </button>
  );
}

// ── PR card ────────────────────────────────────────────────────────────────────

function PRCard({ pr, projectId }: { pr: PullRequest; projectId: string }) {
  return (
    <div className="rounded-lg border border-gray-100 p-4 transition-colors hover:border-gray-200 hover:bg-gray-50/50 dark:border-gray-800 dark:hover:border-gray-700 dark:hover:bg-gray-800/30">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={pr.status} />
            <a
              href={pr.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-sm font-medium text-gray-900 hover:text-indigo-600 dark:text-white dark:hover:text-indigo-400"
            >
              {pr.title}
              <ExternalLink size={12} className="shrink-0 text-gray-400" />
            </a>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
            <span className="flex items-center gap-1">
              <User size={11} />
              {pr.author}
            </span>
            <span>
              <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono dark:bg-gray-800">{pr.sourceBranch}</span>
              <span className="mx-1">→</span>
              <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono dark:bg-gray-800">{pr.targetBranch}</span>
            </span>
            <span>{formatDate(pr.createdAt)}</span>
          </div>

          {pr.reviewers.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {pr.reviewers.map((r) => (
                <ReviewerBadge key={r.name} reviewer={r} provider={pr.provider} />
              ))}
            </div>
          )}

          <PRActions pr={pr} projectId={projectId} />
        </div>

        <span className="shrink-0 rounded bg-indigo-50 px-1.5 py-0.5 text-xs font-mono text-indigo-500 dark:bg-indigo-900/30 dark:text-indigo-400">
          #{pr.id}
        </span>
      </div>
    </div>
  );
}

// ── Main view ──────────────────────────────────────────────────────────────────

export function PullRequestsView({ projectId, hasRepositories }: { projectId: string; hasRepositories: boolean }) {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['project-prs', projectId],
    queryFn: () => api.get<PRResponse>(`/api/projects/${projectId}/pull-requests`),
    enabled: hasRepositories,
  });

  if (!hasRepositories) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-200 py-16 text-center dark:border-gray-700">
        <GitPullRequest size={32} className="mb-3 text-gray-300 dark:text-gray-600" />
        <p className="text-sm font-medium text-gray-500 dark:text-gray-400">No repositories configured</p>
        <p className="mt-1 text-xs text-gray-400 dark:text-gray-600">
          Add repositories in the Setup tab to view pull requests.
        </p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 size={24} className="animate-spin text-gray-400 dark:text-gray-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-red-100 bg-red-50 py-12 text-center dark:border-red-900/30 dark:bg-red-900/10">
        <AlertCircle size={24} className="mb-2 text-red-400" />
        <p className="text-sm text-red-600 dark:text-red-400">
          {error instanceof Error ? error.message : 'Failed to load pull requests'}
        </p>
        <button onClick={() => refetch()} className="mt-3 text-xs text-red-500 underline hover:no-underline">
          Retry
        </button>
      </div>
    );
  }

  const prs = data?.data ?? [];
  const repoErrors = data?.errors ?? [];

  const grouped = prs.reduce<Record<string, PullRequest[]>>((acc, pr) => {
    (acc[pr.repoLabel] ??= []).push(pr);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {prs.length === 0
            ? 'No open pull requests'
            : `${prs.length} open pull request${prs.length !== 1 ? 's' : ''}`}
        </p>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800"
        >
          <RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {repoErrors.map((e) => (
        <div
          key={e.repoLabel}
          className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm dark:border-amber-800/40 dark:bg-amber-900/10"
        >
          <AlertCircle size={15} className="mt-0.5 shrink-0 text-amber-500" />
          <span className="text-amber-700 dark:text-amber-400">
            <span className="font-medium">{e.repoLabel}:</span> {e.error}
          </span>
        </div>
      ))}

      {prs.length === 0 && repoErrors.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-200 py-16 text-center dark:border-gray-700">
          <GitPullRequest size={32} className="mb-3 text-gray-300 dark:text-gray-600" />
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400">No open pull requests</p>
          <p className="mt-1 text-xs text-gray-400 dark:text-gray-600">All clear! No open PRs across your repositories.</p>
        </div>
      )}

      {Object.entries(grouped).map(([repoLabel, repoPrs]) => (
        <div key={repoLabel} className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
          <div className="flex items-center gap-2 border-b border-gray-100 px-5 py-3 dark:border-gray-800">
            <GitPullRequest size={15} className="text-indigo-500" />
            <span className="text-sm font-semibold text-gray-900 dark:text-white">{repoLabel}</span>
            <span className="ml-auto rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400">
              {repoPrs.length}
            </span>
          </div>
          <div className="divide-y divide-gray-50 p-3 dark:divide-gray-800">
            {repoPrs.map((pr) => (
              <div key={`${pr.repoLabel}-${pr.id}`} className="py-1 first:pt-0 last:pb-0">
                <PRCard pr={pr} projectId={projectId} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
