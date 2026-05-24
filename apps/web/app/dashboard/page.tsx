'use client';

import { useQuery, useQueries } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  GitPullRequest,
  Languages,
  LayoutDashboard,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { ErrorBoundary } from '@/components/shared/ErrorBoundary';
import { EmptyState } from '@/components/shared/EmptyState';
import { CardSkeleton } from '@/components/shared/Skeleton';

interface TranslationStats {
  totalUnits: number;
  translatedUnits: number;
  percentComplete: number;
}

interface ALHealth {
  reviewedIssueCount: number;
}

interface ProjectCard {
  id: string;
  name: string;
  description: string | null;
  capabilities: string;
  userRole: string;
  customer: { id: string; name: string } | null;
  connectionType: string | null;
  connectionName: string | null;
  translationStats: TranslationStats | null;
  alHealth: ALHealth | null;
  openPrCount: number;
  lastActivityAt: string | null;
  updatedAt: string;
}

function ConnectionBadge({ type }: { type: string | null }) {
  if (!type) return null;
  const isAdo = type === 'azure-devops';
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        isAdo
          ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
          : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
      }`}
    >
      {isAdo ? 'ADO' : 'GitHub'}
    </span>
  );
}

function TranslationProgressBar({ stats }: { stats: TranslationStats }) {
  const pct = stats.percentComplete;
  const color =
    pct >= 90
      ? 'bg-green-500'
      : pct >= 50
        ? 'bg-yellow-500'
        : 'bg-red-400';

  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
        <span>
          {stats.translatedUnits}/{stats.totalUnits} units
        </span>
        <span className="font-medium">{pct}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
        <div
          className={`h-full rounded-full transition-all ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function CapabilityTags({ capabilities }: { capabilities: string }) {
  const caps = capabilities
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  const labels: Record<string, string> = {
    translation: 'Translation',
    'user-stories': 'User Stories',
    documentation: 'Docs',
    'al-health': 'AL Health',
  };
  return (
    <div className="flex flex-wrap gap-1">
      {caps.map((cap) => (
        <span
          key={cap}
          className="inline-flex items-center rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-300"
        >
          {labels[cap] ?? cap}
        </span>
      ))}
    </div>
  );
}

function ProjectCardItem({ project }: { project: ProjectCard }) {
  const hasTranslation = project.capabilities.includes('translation');
  const hasAlHealth = project.capabilities.includes('al-health');

  // Fetch live PR count from the project's connected repositories
  const { data: prData, isLoading: prLoading } = useQuery({
    queryKey: ['project-pr-count', project.id],
    queryFn: () => api.get<{ data: { id: string }[]; errors?: unknown[] }>(`/api/projects/${project.id}/pull-requests`),
    staleTime: 2 * 60 * 1000,
    retry: false,
  });
  const livePrCount = prData?.data?.length ?? null;
  const openPrCount = livePrCount ?? project.openPrCount;

  return (
    <div className="flex flex-col rounded-xl border border-gray-200 bg-white p-5 shadow-sm transition-shadow hover:shadow-md dark:border-gray-800 dark:bg-gray-900">
      {/* Header */}
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-semibold text-gray-900 dark:text-white">
              {project.name}
            </h2>
            <ConnectionBadge type={project.connectionType} />
          </div>
          {project.customer && (
            <p className="mt-0.5 truncate text-xs text-gray-400 dark:text-gray-500">
              {project.customer.name}
            </p>
          )}
          {project.description && (
            <p className="mt-1 line-clamp-2 text-sm text-gray-500 dark:text-gray-400">
              {project.description}
            </p>
          )}
        </div>
        <CapabilityTags capabilities={project.capabilities} />
      </div>

      {/* Metrics */}
      <div className="mb-4 grid grid-cols-2 gap-3">
        {/* Translation progress */}
        {hasTranslation && (
          <div className="col-span-2 rounded-lg bg-gray-50 p-3 dark:bg-gray-800/60">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-gray-600 dark:text-gray-400">
              <Languages className="h-3.5 w-3.5" />
              Translation Progress
            </div>
            {project.translationStats && project.translationStats.totalUnits > 0 ? (
              <TranslationProgressBar stats={project.translationStats} />
            ) : (
              <p className="text-xs text-gray-400 dark:text-gray-500">No XLIFF files yet</p>
            )}
          </div>
        )}

        {/* Open PRs */}
        <div className="rounded-lg bg-gray-50 p-3 dark:bg-gray-800/60">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-gray-600 dark:text-gray-400">
            <GitPullRequest className="h-3.5 w-3.5" />
            Open PRs
          </div>
          {prLoading ? (
            <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
          ) : (
            <p
              className={`text-xl font-bold ${
                openPrCount > 0
                  ? 'text-indigo-600 dark:text-indigo-400'
                  : 'text-gray-400 dark:text-gray-500'
              }`}
            >
              {openPrCount}
            </p>
          )}
        </div>

        {/* AL Health */}
        {hasAlHealth ? (
          <div className="rounded-lg bg-gray-50 p-3 dark:bg-gray-800/60">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-gray-600 dark:text-gray-400">
              <ShieldCheck className="h-3.5 w-3.5" />
              AL Issues Reviewed
            </div>
            <p className="text-xl font-bold text-gray-700 dark:text-gray-300">
              {project.alHealth?.reviewedIssueCount ?? 0}
            </p>
          </div>
        ) : (
          /* Last activity for non-AL projects */
          <div className="rounded-lg bg-gray-50 p-3 dark:bg-gray-800/60">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-gray-600 dark:text-gray-400">
              <Activity className="h-3.5 w-3.5" />
              Last Activity
            </div>
            <p className="text-xs text-gray-600 dark:text-gray-300">
              {project.lastActivityAt ? formatDate(project.lastActivityAt) : 'No activity'}
            </p>
          </div>
        )}
      </div>

      {/* Quick actions */}
      <div className="mt-auto flex flex-wrap gap-2 border-t border-gray-100 pt-3 dark:border-gray-800">
        <Link
          href={`/projects/${project.id}`}
          className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
        >
          Open
          <ArrowRight className="h-3 w-3" />
        </Link>
        {hasTranslation && (
          <Link
            href={`/projects/${project.id}?view=translations`}
            className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            <Languages className="h-3 w-3" />
            Translations
          </Link>
        )}
        {openPrCount > 0 && (
          <Link
            href={`/projects/${project.id}?view=pull-requests`}
            className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            <GitPullRequest className="h-3 w-3" />
            PRs
          </Link>
        )}
        {hasAlHealth && (
          <Link
            href={`/projects/${project.id}?view=al-code-health`}
            className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            <ShieldCheck className="h-3 w-3" />
            AL Health
          </Link>
        )}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<{ data: ProjectCard[] }>('/api/dashboard'),
  });

  const projects = data?.data ?? [];
  const totalProjects = projects.length;
  const totalTranslated = projects.reduce(
    (sum, p) => sum + (p.translationStats?.translatedUnits ?? 0),
    0,
  );
  const totalUnits = projects.reduce(
    (sum, p) => sum + (p.translationStats?.totalUnits ?? 0),
    0,
  );
  const overallPct = totalUnits > 0 ? Math.round((totalTranslated / totalUnits) * 100) : 0;

  // Live PR counts are fetched per-project in parallel
  const prQueries = useQueries({
    queries: projects.map((p) => ({
      queryKey: ['project-pr-count', p.id],
      queryFn: () => api.get<{ data: { id: string }[] }>(`/api/projects/${p.id}/pull-requests`),
      staleTime: 2 * 60 * 1000,
      retry: false,
      enabled: !isLoading,
    })),
  });
  const totalOpenPrs = prQueries.reduce((sum, q) => sum + (q.data?.data?.length ?? 0), 0);

  return (
    <ErrorBoundary>
    <div>
      {/* Page header */}
      <div className="mb-6 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100 dark:bg-indigo-900/40">
          <LayoutDashboard className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Dashboard</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            At-a-glance overview of all your projects
          </p>
        </div>
      </div>

      {/* Summary stats */}
      {!isLoading && projects.length > 0 && (
        <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
              Projects
            </p>
            <p className="mt-1 text-3xl font-bold text-gray-900 dark:text-white">{totalProjects}</p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
              Overall Progress
            </p>
            <p className="mt-1 text-3xl font-bold text-indigo-600 dark:text-indigo-400">
              {overallPct}%
            </p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
              Total Units
            </p>
            <p className="mt-1 text-3xl font-bold text-gray-900 dark:text-white">
              {totalUnits.toLocaleString()}
            </p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
              Open PRs
            </p>
            <p
              className={`mt-1 text-3xl font-bold ${
                totalOpenPrs > 0
                  ? 'text-indigo-600 dark:text-indigo-400'
                  : 'text-gray-400 dark:text-gray-500'
              }`}
            >
              {totalOpenPrs}
            </p>
          </div>
        </div>
      )}

      {/* Content */}
      {isLoading && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[...Array(6)].map((_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      )}

      {isError && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 p-4 text-red-700 dark:border-red-900 dark:bg-red-900/20 dark:text-red-400">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Failed to load dashboard. Please refresh and try again.
        </div>
      )}

      {!isLoading && !isError && projects.length === 0 && (
        <EmptyState
          icon={LayoutDashboard}
          title="No projects yet"
          description="Create a project to see it here."
          action={{ label: 'Go to Projects', onClick: () => { window.location.href = '/projects'; } }}
        />
      )}

      {!isLoading && !isError && projects.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <ProjectCardItem key={project.id} project={project} />
          ))}
        </div>
      )}
    </div>
    </ErrorBoundary>
  );
}
