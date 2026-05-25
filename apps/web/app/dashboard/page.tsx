'use client';

import { useQuery, useQueries, useMutation } from '@tanstack/react-query';
import {
  Activity,
  ArrowRight,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  ExternalLink,
  FileClock,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Languages,
  LayoutDashboard,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Upload,
  UserPlus,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { ErrorBoundary } from '@/components/shared/ErrorBoundary';
import { EmptyState } from '@/components/shared/EmptyState';
import { CardSkeleton } from '@/components/shared/Skeleton';
import { toast } from 'sonner';

const LS_KEY = 'dashboard_last_read';

// ─── Types ──────────────────────────────────────────────────────────────────

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

interface ActivityItem {
  id: string;
  type: string;
  projectId: string;
  projectName: string;
  label: string;
  detail: string | null;
  occurredAt: string;
}

interface AiInsight {
  priority: 'high' | 'medium' | 'low';
  projectName: string | null;
  action: string;
  reason: string;
}

// ─── Small helpers ────────────────────────────────────────────────────────────

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

// ─── DevOps Activity types ─────────────────────────────────────────────────────

interface DevopsItem {
  id: string;
  type: string;
  projectId: string;
  projectName: string;
  label: string;
  detail: string | null;
  occurredAt: string;
  internalUrl: string | null;
  externalUrl: string | null;
}

// ─── Activity Feed ─────────────────────────────────────────────────────────

const activityIcon: Record<string, React.ReactNode> = {
  xliff_upload: <Upload size={13} className="text-indigo-500" />,
  xliff_sync: <RefreshCw size={13} className="text-blue-500" />,
  translation_change: <Languages size={13} className="text-yellow-500" />,
  al_review: <ShieldCheck size={13} className="text-green-500" />,
  member_added: <UserPlus size={13} className="text-purple-500" />,
};

const activityViewParam: Record<string, string> = {
  xliff_upload: 'translations',
  xliff_sync: 'translations',
  translation_change: 'translations',
  al_review: 'al-code-health',
  member_added: '',
};

function activityHref(item: ActivityItem): string {
  const view = activityViewParam[item.type];
  return view
    ? `/projects/${item.projectId}?view=${view}`
    : `/projects/${item.projectId}`;
}

const LS_DISMISSED_KEY = 'dashboard_dismissed_items';

function loadDismissed(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(LS_DISMISSED_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function saveDismissed(ids: Set<string>) {
  // Keep only the most recent 200 to avoid unbounded growth
  const arr = [...ids].slice(-200);
  localStorage.setItem(LS_DISMISSED_KEY, JSON.stringify(arr));
}

// ─── AI Insights Panel ────────────────────────────────────────────────────────

const devopsIcon: Record<string, React.ReactNode> = {
  pr_review_requested: <GitPullRequest size={13} className="text-orange-500" />,
  pr_created: <GitPullRequest size={13} className="text-indigo-500" />,
  pr_approved: <GitMerge size={13} className="text-green-500" />,
  pr_rejected: <GitPullRequestClosed size={13} className="text-red-500" />,
  work_item_assigned: <CheckCircle2 size={13} className="text-blue-500" />,
  issue_assigned: <Circle size={13} className="text-purple-500" />,
};

const LS_DISMISSED_DEVOPS_KEY = 'dashboard_dismissed_devops';

function loadDismissedDevops(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(LS_DISMISSED_DEVOPS_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function DevopsActivityFeed() {
  const [since] = useState(() => new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
  const [collapsed, setCollapsed] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissedDevops);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['dashboard-devops-activity', since],
    queryFn: () => api.get<{ data: DevopsItem[] }>(`/api/dashboard/devops-activity?since=${encodeURIComponent(since)}`),
    staleTime: 2 * 60_000,
    retry: false,
  });

  const allItems = data?.data ?? [];
  const items = allItems.filter((it) => !dismissed.has(it.id));

  function dismissItem(id: string) {
    const next = new Set([...dismissed, id]);
    setDismissed(next);
    const arr = [...next].slice(-200);
    localStorage.setItem(LS_DISMISSED_DEVOPS_KEY, JSON.stringify(arr));
  }

  return (
    <div className="flex-1">
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2 dark:border-gray-800">
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
          DevOps activity (last 7 days)
        </span>
        <button
          onClick={() => refetch()}
          className="rounded p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          title="Refresh"
        >
          <RefreshCw size={11} />
        </button>
      </div>
      {collapsed ? null : (
        <div className="max-h-72 overflow-y-auto">
          {isLoading && (
            <div className="flex items-center gap-2 p-4 text-xs text-gray-400">
              <Loader2 size={13} className="animate-spin" /> Loading DevOps activity…
            </div>
          )}
          {!isLoading && items.length === 0 && (
            <div className="flex items-center gap-2 p-4 text-xs text-gray-400">
              <CheckCircle2 size={13} className="text-green-400" />
              {allItems.length === 0 ? 'No DevOps activity found. Make sure your projects have connected repositories.' : 'All caught up — nothing new in the last 7 days.'}
            </div>
          )}
          {items.map((item) => (
            <div
              key={item.id}
              className="group flex items-start gap-3 border-b border-gray-50 px-4 py-2.5 last:border-0 dark:border-gray-800/60"
            >
              <span className="mt-0.5 shrink-0">
                {devopsIcon[item.type] ?? <Circle size={13} className="text-gray-400" />}
              </span>
              <div className="min-w-0 flex-1">
                {item.internalUrl ? (
                  <Link href={item.internalUrl} className="hover:opacity-80">
                    <p className="truncate text-xs text-gray-700 dark:text-gray-300">
                      <span className="font-medium">{item.projectName}</span>
                      {' — '}
                      {item.label}
                      {item.detail && <span className="text-gray-400"> · {item.detail}</span>}
                    </p>
                  </Link>
                ) : (
                  <p className="truncate text-xs text-gray-700 dark:text-gray-300">
                    <span className="font-medium">{item.projectName}</span>
                    {' — '}
                    {item.label}
                    {item.detail && <span className="text-gray-400"> · {item.detail}</span>}
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <p className="text-[10px] text-gray-400">{formatDate(item.occurredAt)}</p>
                  {item.externalUrl && (
                    <a
                      href={item.externalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-0.5 text-[10px] text-indigo-400 hover:text-indigo-600"
                    >
                      <ExternalLink size={9} />
                      Open
                    </a>
                  )}
                </div>
              </div>
              <button
                onClick={() => dismissItem(item.id)}
                className="shrink-0 rounded p-0.5 text-gray-200 opacity-0 transition-opacity hover:text-gray-500 group-hover:opacity-100 dark:text-gray-700 dark:hover:text-gray-400"
                title="Dismiss"
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full py-1 text-[10px] text-gray-400 hover:text-gray-600"
      >
        {collapsed ? 'Show ↓' : 'Collapse ↑'}
      </button>
    </div>
  );
}

/** Combined activity section with DevOps | App tabs */
function ActivitySection({ projectIds }: { projectIds: string[] }) {
  const [tab, setTab] = useState<'devops' | 'app'>('devops');
  const [collapsed, setCollapsed] = useState(false);

  // App feed state (lifted so it doesn't remount on tab switch)
  const [since, setSince] = useState<string>(() => {
    if (typeof window === 'undefined') return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    return localStorage.getItem(LS_KEY) ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  });
  const [appDismissed, setAppDismissed] = useState<Set<string>>(loadDismissed);

  const { data: appData, isLoading: appLoading, refetch: appRefetch } = useQuery({
    queryKey: ['dashboard-activity', since],
    queryFn: () => api.get<{ data: ActivityItem[] }>(`/api/dashboard/activity?since=${encodeURIComponent(since)}`),
    enabled: projectIds.length > 0 && tab === 'app',
    staleTime: 60_000,
  });
  const allAppItems = appData?.data ?? [];
  const appItems = allAppItems.filter((it) => !appDismissed.has(it.id));

  function dismissAppItem(id: string) {
    const next = new Set([...appDismissed, id]);
    setAppDismissed(next);
    saveDismissed(next);
  }

  function markAllRead() {
    const now = new Date().toISOString();
    localStorage.setItem(LS_KEY, now);
    const empty = new Set<string>();
    setAppDismissed(empty);
    saveDismissed(empty);
    setSince(now);
    appRefetch();
  }

  const sinceLabel = (() => {
    const d = new Date(since);
    const diffDays = Math.round((Date.now() - d.getTime()) / 86_400_000);
    if (diffDays <= 1) return 'since yesterday';
    if (diffDays <= 7) return `last ${diffDays} days`;
    return `since ${d.toLocaleDateString()}`;
  })();

  return (
    <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
      {/* Header with tabs */}
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-800">
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white"
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          <FileClock size={15} className="text-indigo-500" />
          What&apos;s new
        </button>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setTab('devops')}
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
              tab === 'devops'
                ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300'
                : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'
            }`}
          >
            DevOps
          </button>
          <button
            onClick={() => setTab('app')}
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
              tab === 'app'
                ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300'
                : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'
            }`}
          >
            App
          </button>
          {tab === 'app' && appItems.length > 0 && (
            <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-indigo-100 px-1.5 text-[10px] font-semibold text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-300">
              {appItems.length}
            </span>
          )}
          {tab === 'app' && allAppItems.length > 0 && (
            <button
              onClick={markAllRead}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-gray-400 hover:bg-gray-50 hover:text-gray-700 dark:hover:bg-gray-800"
            >
              <CheckCircle2 size={11} />
              Mark all read
            </button>
          )}
        </div>
      </div>

      {!collapsed && (
        <>
          {tab === 'devops' && <DevopsActivityFeed />}

          {tab === 'app' && (
            <div className="max-h-72 overflow-y-auto">
              <div className="px-4 py-1.5 text-[10px] text-gray-400">App events ({sinceLabel})</div>
              {appLoading && (
                <div className="flex items-center gap-2 p-4 text-xs text-gray-400">
                  <Loader2 size={13} className="animate-spin" /> Loading activity…
                </div>
              )}
              {!appLoading && appItems.length === 0 && (
                <div className="flex items-center gap-2 p-4 text-xs text-gray-400">
                  <CheckCircle2 size={13} className="text-green-400" />
                  All caught up — nothing new {sinceLabel}.
                </div>
              )}
              {appItems.map((item) => (
                <div
                  key={item.id}
                  className="group flex items-start gap-3 border-b border-gray-50 px-4 py-2.5 last:border-0 dark:border-gray-800/60"
                >
                  <span className="mt-0.5 shrink-0">
                    {activityIcon[item.type] ?? <Circle size={13} className="text-gray-400" />}
                  </span>
                  <Link href={activityHref(item)} className="min-w-0 flex-1 hover:opacity-80">
                    <p className="truncate text-xs text-gray-700 dark:text-gray-300">
                      <span className="font-medium">{item.projectName}</span>
                      {' — '}
                      {item.label}
                      {item.detail && <span className="text-gray-400"> · {item.detail}</span>}
                    </p>
                    <p className="text-[10px] text-gray-400">{formatDate(item.occurredAt)}</p>
                  </Link>
                  <button
                    onClick={() => dismissAppItem(item.id)}
                    className="shrink-0 rounded p-0.5 text-gray-200 opacity-0 transition-opacity hover:text-gray-500 group-hover:opacity-100 dark:text-gray-700 dark:hover:text-gray-400"
                    title="Dismiss"
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const priorityConfig = {
  high: { color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-900/20', label: 'High' },
  medium: { color: 'text-yellow-600 dark:text-yellow-400', bg: 'bg-yellow-50 dark:bg-yellow-900/20', label: 'Medium' },
  low: { color: 'text-gray-500 dark:text-gray-400', bg: 'bg-gray-50 dark:bg-gray-800/50', label: 'Low' },
};

function AiInsightsPanel({ projects, livePrCounts }: {
  projects: ProjectCard[];
  livePrCounts: Record<string, number>;
}) {
  const [insights, setInsights] = useState<AiInsight[] | null>(null);
  const [summary, setSummary] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());

  const devopsSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: devopsData } = useQuery({
    queryKey: ['dashboard-devops-activity-ai', devopsSince],
    queryFn: () => api.get<{ data: DevopsItem[] }>(`/api/dashboard/devops-activity?since=${encodeURIComponent(devopsSince)}`),
    staleTime: 2 * 60_000,
    retry: false,
  });

  const { mutate: analyze, isPending } = useMutation({
    mutationFn: () =>
      api.post<{ data: { insights: AiInsight[]; summary: string } }>('/api/ai/dashboard-insights', {
        projects: projects.map((p) => ({
          name: p.name,
          capabilities: p.capabilities,
          openPrs: livePrCounts[p.id] ?? p.openPrCount,
          translationPct: p.translationStats?.percentComplete ?? null,
          alReviewed: p.alHealth?.reviewedIssueCount ?? 0,
          recentActivity: 0,
        })),
        devopsEvents: (devopsData?.data ?? []).slice(0, 20).map((e) => ({
          type: e.type,
          projectName: e.projectName,
          label: e.label,
          detail: e.detail,
        })),
      }),
    onSuccess: (res) => {
      setInsights(res.data.insights as AiInsight[]);
      setSummary(res.data.summary);
      setDismissed(new Set());
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'AI analysis failed'),
  });

  // Derive a navigation href from the insight's action text and project name
  function insightHref(item: AiInsight): string | null {
    const project = projects.find((p) => p.name === item.projectName);
    if (!project) return null;
    const text = (item.action + ' ' + item.reason).toLowerCase();
    if (text.includes('pull request') || text.includes(' pr ') || text.includes('review') || text.includes('merge')) {
      return `/projects/${project.id}?view=pull-requests`;
    }
    if (text.includes('translat') || text.includes('xliff')) {
      return `/projects/${project.id}?view=translations`;
    }
    if (text.includes('al health') || text.includes('al-health') || text.includes('code health') || text.includes('health issue')) {
      return `/projects/${project.id}?view=al-code-health`;
    }
    return `/projects/${project.id}`;
  }

  const visible = insights?.filter((_, i) => !dismissed.has(i)) ?? [];

  return (
    <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-800">
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white"
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          <Sparkles size={15} className="text-indigo-500" />
          What to do next
        </button>
        <button
          onClick={() => analyze()}
          disabled={isPending}
          className="flex items-center gap-1.5 rounded-full bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-100 disabled:opacity-60 dark:bg-indigo-900/20 dark:text-indigo-400 dark:hover:bg-indigo-900/40"
        >
          {isPending ? <Loader2 size={11} className="animate-spin" /> : <Bot size={11} />}
          {isPending ? 'Analyzing…' : insights ? 'Re-analyze' : 'Analyze'}
        </button>
      </div>

      {!collapsed && (
        <div className="p-4">
          {!insights && !isPending && (
            <div className="flex flex-col items-center gap-2 py-4 text-center">
              <Sparkles size={24} className="text-indigo-300" />
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Click <strong>Analyze</strong> to get AI-powered priorities based on your current project state.
              </p>
            </div>
          )}
          {isPending && (
            <div className="flex items-center gap-2 py-4 text-xs text-gray-400">
              <Loader2 size={13} className="animate-spin" /> Analyzing your projects…
            </div>
          )}
          {insights && !isPending && (
            <div className="space-y-2">
              {summary && (
                <p className="mb-3 rounded-lg bg-indigo-50 px-3 py-2 text-xs text-indigo-700 dark:bg-indigo-900/20 dark:text-indigo-300">
                  {summary}
                </p>
              )}
              {visible.length === 0 && (
                <p className="text-xs text-gray-400">All suggestions dismissed — re-analyze for fresh ideas.</p>
              )}
              {insights.map((item, i) => {
                if (dismissed.has(i)) return null;
                const cfg = priorityConfig[item.priority] ?? priorityConfig.low;
                const href = insightHref(item);
                const content = (
                  <>
                    <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${cfg.color} bg-white/60 dark:bg-black/20`}>
                      {cfg.label}
                    </span>
                    <div className="min-w-0 flex-1">
                      {item.projectName && (
                        <p className="text-[10px] font-medium text-gray-400">{item.projectName}</p>
                      )}
                      <p className="text-xs font-semibold text-gray-800 dark:text-gray-100">{item.action}</p>
                      <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">{item.reason}</p>
                    </div>
                  </>
                );
                return (
                  <div key={i} className={`group flex items-start gap-3 rounded-lg px-3 py-2.5 ${cfg.bg}`}>
                    {href ? (
                      <Link href={href} className="flex min-w-0 flex-1 items-start gap-3 hover:opacity-80">
                        {content}
                      </Link>
                    ) : (
                      <div className="flex min-w-0 flex-1 items-start gap-3">{content}</div>
                    )}
                    <button
                      onClick={() => setDismissed((prev) => new Set([...prev, i]))}
                      className="shrink-0 rounded p-0.5 text-gray-300 opacity-0 transition-opacity hover:text-gray-500 group-hover:opacity-100 dark:text-gray-600 dark:hover:text-gray-400"
                      title="Dismiss"
                    >
                      <X size={11} />
                    </button>
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

// ─── Project card ─────────────────────────────────────────────────────────────

function ProjectCardItem({ project }: { project: ProjectCard }) {
  const hasTranslation = project.capabilities.includes('translation');
  const hasAlHealth = project.capabilities.includes('al-health');

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

      <div className="mb-4 grid grid-cols-2 gap-3">
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

// ─── Page ──────────────────────────────────────────────────────────────────────

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
  const livePrCounts = Object.fromEntries(
    projects.map((p, i) => [p.id, prQueries[i]?.data?.data?.length ?? p.openPrCount]),
  );

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

      {/* Activity + AI insights row */}
      {!isLoading && projects.length > 0 && (
        <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ActivitySection projectIds={projects.map((p) => p.id)} />
          <AiInsightsPanel projects={projects} livePrCounts={livePrCounts} />
        </div>
      )}

      {/* Project cards */}
      {isLoading && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[...Array(6)].map((_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      )}

      {isError && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 p-4 text-red-700 dark:border-red-900 dark:bg-red-900/20 dark:text-red-400">
          <Activity className="h-4 w-4 shrink-0" />
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

