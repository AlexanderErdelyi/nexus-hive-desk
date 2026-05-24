'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertCircle, ExternalLink, GitPullRequest, Loader2, RefreshCw, User } from 'lucide-react';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';

interface PullRequest {
  id: string;
  title: string;
  author: string;
  status: string;
  sourceBranch: string;
  targetBranch: string;
  reviewers: string[];
  createdAt: string;
  url: string;
  repoLabel: string;
  provider: 'github' | 'azure-devops';
}

interface RepoError {
  repoLabel: string;
  error: string;
}

interface PRResponse {
  data: PullRequest[];
  errors?: RepoError[];
}

function StatusBadge({ status, provider }: { status: string; provider: 'github' | 'azure-devops' }) {
  const label = provider === 'azure-devops' ? status : status;
  const colors =
    status === 'active' || status === 'open'
      ? 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400'
      : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400';
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${colors}`}>{label}</span>
  );
}

function ReviewerBadge({ name }: { name: string }) {
  return (
    <span className="flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400">
      <User size={10} />
      {name}
    </span>
  );
}

function PRCard({ pr }: { pr: PullRequest }) {
  return (
    <div className="rounded-lg border border-gray-100 p-4 transition-colors hover:border-gray-200 hover:bg-gray-50/50 dark:border-gray-800 dark:hover:border-gray-700 dark:hover:bg-gray-800/30">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={pr.status} provider={pr.provider} />
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
                <ReviewerBadge key={r} name={r} />
              ))}
            </div>
          )}
        </div>

        <span className="shrink-0 rounded bg-indigo-50 px-1.5 py-0.5 text-xs font-mono text-indigo-500 dark:bg-indigo-900/30 dark:text-indigo-400">
          #{pr.id}
        </span>
      </div>
    </div>
  );
}

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
        <p className="text-sm text-red-600 dark:text-red-400">{error instanceof Error ? error.message : 'Failed to load pull requests'}</p>
        <button onClick={() => refetch()} className="mt-3 text-xs text-red-500 underline hover:no-underline">
          Retry
        </button>
      </div>
    );
  }

  const prs = data?.data ?? [];
  const repoErrors = data?.errors ?? [];

  // Group by repoLabel
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
                <PRCard pr={pr} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
