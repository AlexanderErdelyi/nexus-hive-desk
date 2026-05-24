'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  ExternalLink,
  FileCode,
  GitBranch,
  GitPullRequest,
  Info,
  Lightbulb,
  Link2,
  Link2Off,
  Loader2,
  MessageSquare,
  RefreshCw,
  Search,
  ThumbsDown,
  ThumbsUp,
  User,
  X,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { diffLines } from 'diff';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { CreateBranchModal } from '@/components/shared/CreateBranchModal';
import type { ProjectRepo } from '@/components/shared/CreateBranchModal';
import { PRCardSkeleton } from '@/components/shared/Skeleton';
import { EmptyState } from '@/components/shared/EmptyState';
import { ApiErrorBanner } from '@/components/shared/ApiErrorBanner';

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

interface WorkItem {
  id: number;
  title: string;
  state: string;
  type: string;
  url: string;
}

interface WorkItemSearchResult {
  id: number;
  title: string;
  state: string;
  type: string;
  workItemType: string;
}

interface PRResponse {
  data: PullRequest[];
  errors?: RepoError[];
}

interface DiffFile {
  path: string;
  changeType?: string;
  patch?: string;
  additions?: number;
  deletions?: number;
}

interface DiffResponse {
  files: DiffFile[];
  prTitle?: string;
  prDescription?: string;
  totalFiles?: number;
  sourceCommit?: string;
  targetCommit?: string;
}

interface AISuggestion {
  file: string;
  line?: number | null;
  severity: 'info' | 'warning' | 'error';
  comment: string;
  codeSnippet?: string | null;
  suggestion?: string | null;
}

interface AIReviewResponse {
  suggestions: AISuggestion[];
  summary: string;
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
    return `/api/remote/connections/${pr.connectionId}${path}`;
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

// ── Work items panel (ADO only) ────────────────────────────────────────────────

function workItemTypeCls(type: string): string {
  const t = type.toLowerCase();
  if (t === 'bug') return 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400';
  if (t === 'task') return 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400';
  if (t === 'feature' || t === 'epic') return 'bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400';
  if (t.includes('story') || t === 'user story') return 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400';
  return 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';
}

function WorkItemsPanel({ pr, projectId }: { pr: PullRequest; projectId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [searchText, setSearchText] = useState('');
  const qc = useQueryClient();

  const { data: wiData, isLoading: wiLoading } = useQuery({
    queryKey: ['pr-work-items', pr.connectionId, pr.adoProjectName, pr.repoSlug, pr.id],
    queryFn: () =>
      api.get<{ data: WorkItem[] }>(
        `/api/remote/connections/${pr.connectionId}/azure/projects/${encodeURIComponent(pr.adoProjectName!)}/repos/${encodeURIComponent(pr.repoSlug)}/pull-requests/${pr.id}/work-items`
      ),
    enabled: expanded,
  });

  const { data: searchData, isLoading: searchLoading } = useQuery({
    queryKey: ['wi-search', pr.connectionId, pr.adoProjectName, searchText],
    queryFn: () =>
      api.get<{ data: WorkItemSearchResult[] }>(
        `/api/remote/connections/${pr.connectionId}/azure/projects/${encodeURIComponent(pr.adoProjectName!)}/work-items/search?q=${encodeURIComponent(searchText)}`
      ),
    enabled: expanded && searchText.trim().length >= 2,
  });

  const linkMutation = useMutation({
    mutationFn: (workItemId: number) =>
      api.post(
        `/api/remote/connections/${pr.connectionId}/azure/projects/${encodeURIComponent(pr.adoProjectName!)}/repos/${encodeURIComponent(pr.repoSlug)}/pull-requests/${pr.id}/work-items`,
        { workItemId }
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['pr-work-items', pr.connectionId, pr.adoProjectName, pr.repoSlug, pr.id] });
      setSearchText('');
      toast.success('Work item linked');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed to link work item'),
  });

  const unlinkMutation = useMutation({
    mutationFn: (wiId: number) =>
      api.delete(
        `/api/remote/connections/${pr.connectionId}/azure/projects/${encodeURIComponent(pr.adoProjectName!)}/repos/${encodeURIComponent(pr.repoSlug)}/pull-requests/${pr.id}/work-items/${wiId}`
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['pr-work-items', pr.connectionId, pr.adoProjectName, pr.repoSlug, pr.id] });
      toast.success('Work item unlinked');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed to unlink work item'),
  });

  const linkedIds = new Set((wiData?.data ?? []).map((w) => w.id));
  const searchResults = (searchData?.data ?? []).filter((r) => !linkedIds.has(r.id));

  return (
    <div className="mt-2">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
      >
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Link2 size={12} />
        Work items
        {wiData && wiData.data.length > 0 && (
          <span className="ml-1 rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-400">
            {wiData.data.length}
          </span>
        )}
      </button>

      {expanded && (
        <div className="mt-2 space-y-2">
          {wiLoading ? (
            <div className="flex items-center gap-1 text-xs text-gray-400">
              <Loader2 size={12} className="animate-spin" /> Loading…
            </div>
          ) : (wiData?.data ?? []).length === 0 ? (
            <p className="text-xs text-gray-400 dark:text-gray-600">No work items linked yet.</p>
          ) : (
            <ul className="space-y-1">
              {(wiData?.data ?? []).map((wi) => (
                <li key={wi.id} className="flex items-center gap-2 text-xs">
                  <span className={`rounded px-1.5 py-0.5 font-medium ${workItemTypeCls(wi.type)}`}>{wi.type}</span>
                  <a
                    href={wi.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-w-0 flex-1 truncate text-gray-700 hover:text-indigo-600 dark:text-gray-300 dark:hover:text-indigo-400"
                  >
                    #{wi.id} {wi.title}
                  </a>
                  <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                    {wi.state}
                  </span>
                  <button
                    onClick={() => unlinkMutation.mutate(wi.id)}
                    disabled={unlinkMutation.isPending}
                    title="Unlink"
                    className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-900/20"
                  >
                    <Link2Off size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Search work items to link…"
              className="w-full rounded border border-gray-200 py-1.5 pl-7 pr-3 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:placeholder-gray-500"
            />
          </div>

          {searchLoading && (
            <div className="flex items-center gap-1 text-xs text-gray-400">
              <Loader2 size={12} className="animate-spin" /> Searching…
            </div>
          )}

          {!searchLoading && searchText.length >= 2 && searchResults.length === 0 && (
            <p className="text-xs text-gray-400">No results.</p>
          )}

          {searchResults.length > 0 && (
            <ul className="space-y-1 rounded border border-gray-100 p-1 dark:border-gray-800">
              {searchResults.map((r) => (
                <li key={r.id} className="flex items-center gap-2 text-xs">
                  <span className={`rounded px-1.5 py-0.5 font-medium ${workItemTypeCls(r.workItemType ?? r.type)}`}>
                    {r.workItemType ?? r.type}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-300">
                    #{r.id} {r.title}
                  </span>
                  <button
                    onClick={() => linkMutation.mutate(r.id)}
                    disabled={linkMutation.isPending}
                    title="Link"
                    className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-green-50 hover:text-green-600 dark:hover:bg-green-900/20"
                  >
                    <Link2 size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ── Diff + AI review panel ─────────────────────────────────────────────────────

function changeTypeBadge(changeType?: string) {
  const t = changeType?.toLowerCase() ?? '';
  if (t === 'add' || t === 'added') return <span className="rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-700 dark:bg-green-900/30 dark:text-green-400">+added</span>;
  if (t === 'delete' || t === 'removed') return <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-700 dark:bg-red-900/30 dark:text-red-400">-removed</span>;
  if (t === 'renamed') return <span className="rounded bg-purple-100 px-1.5 py-0.5 text-xs text-purple-700 dark:bg-purple-900/30 dark:text-purple-400">renamed</span>;
  return <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">modified</span>;
}

function severityIcon(severity: AISuggestion['severity']) {
  if (severity === 'error') return <AlertCircle size={12} className="text-red-500" />;
  if (severity === 'warning') return <AlertTriangle size={12} className="text-amber-500" />;
  return <Info size={12} className="text-blue-500" />;
}

// ── Side-by-side diff helpers ──────────────────────────────────────────────────

const DIFF_CONTEXT = 3;

interface DiffRow {
  type: 'context' | 'add' | 'delete' | 'change' | 'collapsed';
  left: { no: number; text: string } | null;
  right: { no: number; text: string } | null;
  collapsedCount?: number;
}

function splitLines(s: string): string[] {
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function computeDiffRows(before: string, after: string): DiffRow[] {
  const changes = diffLines(before, after);
  type Seg = { kind: 'change'; rows: DiffRow[] } | { kind: 'ctx'; lines: string[]; l0: number; r0: number };
  const segs: Seg[] = [];
  let ln = 1, rn = 1, i = 0;

  while (i < changes.length) {
    const c = changes[i];
    if (!c.added && !c.removed) {
      const lines = splitLines(c.value);
      segs.push({ kind: 'ctx', lines, l0: ln, r0: rn });
      ln += lines.length; rn += lines.length; i++;
    } else if (c.removed) {
      const rem = splitLines(c.value);
      const rows: DiffRow[] = [];
      if (i + 1 < changes.length && changes[i + 1].added) {
        const add = splitLines(changes[i + 1].value);
        const mx = Math.max(rem.length, add.length);
        for (let j = 0; j < mx; j++)
          rows.push({ type: 'change', left: j < rem.length ? { no: ln++, text: rem[j] } : null, right: j < add.length ? { no: rn++, text: add[j] } : null });
        i += 2;
      } else {
        for (const l of rem) rows.push({ type: 'delete', left: { no: ln++, text: l }, right: null });
        i++;
      }
      segs.push({ kind: 'change', rows });
    } else {
      const lines = splitLines(c.value);
      segs.push({ kind: 'change', rows: lines.map(l => ({ type: 'add' as const, left: null, right: { no: rn++, text: l } })) });
      i++;
    }
  }

  const result: DiffRow[] = [];
  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si];
    if (seg.kind === 'change') { result.push(...seg.rows); continue; }
    const { lines, l0, r0 } = seg;
    const hasPrev = si > 0;
    const hasNext = si < segs.length - 1;
    const showStart = hasPrev ? Math.min(DIFF_CONTEXT, lines.length) : 0;
    const showEnd = hasNext ? Math.min(DIFF_CONTEXT, lines.length - showStart) : 0;
    const hidden = lines.length - showStart - showEnd;
    for (let j = 0; j < showStart; j++)
      result.push({ type: 'context', left: { no: l0 + j, text: lines[j] }, right: { no: r0 + j, text: lines[j] } });
    if (hidden > 0)
      result.push({ type: 'collapsed', left: null, right: null, collapsedCount: hidden });
    for (let j = lines.length - showEnd; j < lines.length; j++)
      result.push({ type: 'context', left: { no: l0 + j, text: lines[j] }, right: { no: r0 + j, text: lines[j] } });
  }
  return result;
}

function SideBySideDiff({ before, after }: { before: string; after: string }) {
  const rows = computeDiffRows(before, after);
  if (rows.length === 0) return <p className="p-3 text-xs text-gray-400">No changes detected.</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[600px] border-collapse font-mono text-xs">
        <thead>
          <tr className="border-b border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800">
            <th className="w-9 py-1 text-center text-[10px] font-normal text-gray-400" colSpan={2}>Before</th>
            <th className="w-px bg-gray-200 dark:bg-gray-700" />
            <th className="w-9 py-1 text-center text-[10px] font-normal text-gray-400" colSpan={2}>After</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => {
            if (row.type === 'collapsed')
              return (
                <tr key={idx} className="bg-gray-50/80 dark:bg-gray-800/50">
                  <td colSpan={5} className="py-0.5 text-center text-[10px] text-gray-400 dark:text-gray-600">
                    ··· {row.collapsedCount} unchanged lines ···
                  </td>
                </tr>
              );

            const leftBg =
              row.type === 'delete' || (row.type === 'change' && row.left)
                ? 'bg-red-50 dark:bg-red-900/20'
                : row.type === 'context'
                ? ''
                : 'bg-gray-50/50 dark:bg-gray-800/20';
            const rightBg =
              row.type === 'add' || (row.type === 'change' && row.right)
                ? 'bg-green-50 dark:bg-green-900/20'
                : row.type === 'context'
                ? ''
                : 'bg-gray-50/50 dark:bg-gray-800/20';

            return (
              <tr key={idx} className="group">
                <td className={`w-8 select-none border-r border-gray-100 pr-2 text-right text-[10px] text-gray-300 dark:border-gray-800 dark:text-gray-600 ${leftBg}`}>
                  {row.left?.no}
                </td>
                <td className={`whitespace-pre px-2 py-px ${leftBg}`}>
                  {row.left ? (
                    <>{row.type !== 'context' && row.left && <span className="select-none text-red-400 dark:text-red-500">-</span>}{row.left.text}</>
                  ) : null}
                </td>
                <td className="w-px bg-gray-200 dark:bg-gray-700" />
                <td className={`w-8 select-none border-l border-r border-gray-100 pr-2 text-right text-[10px] text-gray-300 dark:border-gray-800 dark:text-gray-600 ${rightBg}`}>
                  {row.right?.no}
                </td>
                <td className={`whitespace-pre px-2 py-px ${rightBg}`}>
                  {row.right ? (
                    <>{row.type !== 'context' && row.right && <span className="select-none text-green-500">+</span>}{row.right.text}</>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ExpandableFileDiff({
  file, pr, sourceCommit, targetCommit,
}: {
  file: DiffFile; pr: PullRequest; sourceCommit?: string; targetCommit?: string;
}) {
  const [open, setOpen] = useState(false);

  const { data: contentData, isLoading: contentLoading } = useQuery({
    queryKey: ['file-content', pr.connectionId, pr.adoProjectName, pr.repoSlug, file.path, targetCommit, sourceCommit],
    queryFn: () => {
      const params = new URLSearchParams({ path: file.path });
      if (targetCommit) params.set('before', targetCommit);
      if (sourceCommit) params.set('after', sourceCommit);
      return api.get<{ data: { beforeContent: string; afterContent: string } }>(
        `/api/remote/connections/${pr.connectionId}/azure/projects/${encodeURIComponent(pr.adoProjectName ?? '')}/repos/${encodeURIComponent(pr.repoSlug)}/file-diff-content?${params}`
      );
    },
    enabled: open && pr.provider === 'azure-devops' && !!sourceCommit && !!targetCommit,
  });

  const content = contentData?.data;

  return (
    <li className="overflow-hidden rounded border border-gray-100 dark:border-gray-800">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 bg-gray-50 px-2 py-1.5 text-left text-xs hover:bg-gray-100 dark:bg-gray-800/60 dark:hover:bg-gray-800"
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <FileCode size={11} className="shrink-0 text-gray-400" />
        <span className="flex-1 truncate font-mono text-gray-700 dark:text-gray-300">{file.path}</span>
        {changeTypeBadge(file.changeType)}
      </button>

      {open && (
        <div className="border-t border-gray-100 dark:border-gray-800">
          {contentLoading && (
            <div className="flex items-center gap-2 p-3 text-xs text-gray-400">
              <Loader2 size={12} className="animate-spin" /> Loading diff…
            </div>
          )}
          {content && (
            <SideBySideDiff before={content.beforeContent} after={content.afterContent} />
          )}
          {!contentLoading && !content && file.patch && (
            <pre className="overflow-x-auto whitespace-pre p-2 text-[11px] text-gray-600 dark:text-gray-400">{file.patch}</pre>
          )}
          {!contentLoading && !content && !file.patch && pr.provider !== 'azure-devops' && (
            <p className="p-3 text-xs text-gray-400">Diff view not available for this provider.</p>
          )}
        </div>
      )}
    </li>
  );
}

// ── AI suggestion card ─────────────────────────────────────────────────────────

function SuggestionCard({
  s, idx, pr, onPost, isPosting,
}: {
  s: AISuggestion; idx: number; pr: PullRequest;
  onPost: (s: AISuggestion, idx: number) => void; isPosting: boolean;
}) {
  const [showCode, setShowCode] = useState(false);

  return (
    <div className="rounded-lg border border-gray-100 bg-white dark:border-gray-700 dark:bg-gray-900">
      <div className="flex items-start gap-2 p-2.5">
        <span className="mt-0.5 shrink-0">{severityIcon(s.severity)}</span>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-xs text-indigo-600 dark:text-indigo-400">{s.file}</p>
          <p className="mt-0.5 text-xs text-gray-700 dark:text-gray-300">{s.comment}</p>
          {(s.codeSnippet || s.suggestion) && (
            <button
              onClick={() => setShowCode((v) => !v)}
              className="mt-1 flex items-center gap-1 text-[10px] text-gray-400 hover:text-indigo-500"
            >
              <Code2 size={10} />
              {showCode ? 'Hide code' : 'Show code'}
            </button>
          )}
        </div>
        <button
          onClick={() => onPost(s, idx)}
          disabled={isPosting}
          title="Post as PR comment"
          className="shrink-0 rounded p-1 text-gray-400 hover:bg-indigo-50 hover:text-indigo-600 disabled:opacity-50 dark:hover:bg-indigo-900/20"
        >
          {isPosting ? <Loader2 size={12} className="animate-spin" /> : <MessageSquare size={12} />}
        </button>
      </div>
      {showCode && (
        <div className="border-t border-gray-100 px-2.5 pb-2.5 pt-2 dark:border-gray-700">
          {s.codeSnippet && (
            <div className="mb-2">
              <p className="mb-1 text-[10px] font-medium text-gray-400">Problematic code</p>
              <pre className="overflow-x-auto rounded bg-red-50 px-3 py-2 text-[11px] text-red-800 dark:bg-red-900/20 dark:text-red-300">{s.codeSnippet}</pre>
            </div>
          )}
          {s.suggestion && (
            <div>
              <p className="mb-1 text-[10px] font-medium text-gray-400">Suggested fix</p>
              <pre className="overflow-x-auto rounded bg-green-50 px-3 py-2 text-[11px] text-green-800 dark:bg-green-900/20 dark:text-green-300">{s.suggestion}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DiffPanel({ pr, projectId }: { pr: PullRequest; projectId: string }) {
  const [open, setOpen] = useState(false);
  const [aiReview, setAiReview] = useState<AIReviewResponse | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [postingIdx, setPostingIdx] = useState<number | null>(null);
  const [showInfo, setShowInfo] = useState(false);

  const diffApiPath =
    pr.provider === 'azure-devops'
      ? `/api/remote/connections/${pr.connectionId}/azure/projects/${encodeURIComponent(pr.adoProjectName ?? '')}/repos/${encodeURIComponent(pr.repoSlug)}/pull-requests/${pr.id}/diff`
      : `/api/remote/connections/${pr.connectionId}/github/repos/${encodeURIComponent(pr.repoSlug.split('/')[0])}/${encodeURIComponent(pr.repoSlug.split('/')[1])}/pull-requests/${pr.id}/diff`;

  const { data: diffData, isLoading: diffLoading } = useQuery({
    queryKey: ['pr-diff', pr.connectionId, pr.id],
    queryFn: () => api.get<{ data: DiffResponse }>(diffApiPath),
    enabled: open,
  });

  const diff = diffData?.data;

  async function runAiReview() {
    if (!diff?.files?.length) return;
    setAiReview(null);
    setReviewing(true);
    try {
      const result = await api.post<{ data: AIReviewResponse }>('/api/ai/pr-review', {
        prTitle: diff.prTitle ?? pr.title,
        prDescription: diff.prDescription,
        files: diff.files,
      });
      setAiReview(result.data);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'AI review failed');
    } finally {
      setReviewing(false);
    }
  }

  async function postSuggestion(suggestion: AISuggestion, idx: number) {
    setPostingIdx(idx);
    try {
      const comment = `**AI Review** (${suggestion.severity}): ${suggestion.comment}${suggestion.line ? `\n\n*File: \`${suggestion.file}\`, line ${suggestion.line}*` : `\n\n*File: \`${suggestion.file}\`*`}`;
      if (pr.provider === 'azure-devops') {
        await api.post(
          `/api/remote/connections/${pr.connectionId}/azure/projects/${encodeURIComponent(pr.adoProjectName ?? '')}/repos/${encodeURIComponent(pr.repoSlug)}/pull-requests/${pr.id}/threads`,
          { content: comment }
        );
      } else {
        const [owner, repo] = pr.repoSlug.split('/');
        await api.post(
          `/api/remote/connections/${pr.connectionId}/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pull-requests/${pr.id}/review`,
          { event: 'COMMENT', body: comment }
        );
      }
      toast.success('Comment posted');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to post comment');
    } finally {
      setPostingIdx(null);
    }
  }

  const criticalSuggestions = aiReview?.suggestions.filter((s) => s.severity !== 'info') ?? [];
  const infoSuggestions = aiReview?.suggestions.filter((s) => s.severity === 'info') ?? [];

  return (
    <div className="mt-2 border-t border-gray-100 dark:border-gray-800">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 py-2 text-left text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Code2 size={13} />
        <span>Diff &amp; AI Review</span>
      </button>

      {open && (
        <div className="pb-3">
          {diffLoading && (
            <div className="flex items-center gap-2 py-4 text-xs text-gray-400">
              <Loader2 size={13} className="animate-spin" />
              Loading diff…
            </div>
          )}

          {diff && (
            <>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {diff.totalFiles ?? diff.files.length} file{diff.files.length !== 1 ? 's' : ''} changed
                  {(diff.totalFiles ?? 0) > diff.files.length ? ` (showing ${diff.files.length})` : ''}
                </span>
                <button
                  onClick={runAiReview}
                  disabled={reviewing}
                  className="flex items-center gap-1 rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-100 disabled:opacity-50 dark:bg-indigo-900/20 dark:text-indigo-400 dark:hover:bg-indigo-900/40"
                >
                  {reviewing ? <Loader2 size={11} className="animate-spin" /> : <Bot size={11} />}
                  {reviewing ? 'Analyzing…' : 'AI Review'}
                </button>
              </div>

              <ul className="mb-3 space-y-1">
                {diff.files.map((f) => (
                  <ExpandableFileDiff
                    key={f.path}
                    file={f}
                    pr={pr}
                    sourceCommit={diff.sourceCommit}
                    targetCommit={diff.targetCommit}
                  />
                ))}
              </ul>

              {aiReview && (
                <div className="space-y-2">
                  {aiReview.summary && (
                    <p className="rounded-lg bg-indigo-50 px-3 py-2 text-xs text-indigo-700 dark:bg-indigo-900/20 dark:text-indigo-300">
                      <span className="font-medium">Summary: </span>
                      {aiReview.summary}
                    </p>
                  )}

                  {criticalSuggestions.length === 0 && infoSuggestions.length === 0 && (
                    <p className="text-xs text-gray-400">No issues found — looks good!</p>
                  )}

                  {criticalSuggestions.map((s, i) => (
                    <SuggestionCard
                      key={`crit-${i}`}
                      s={s}
                      idx={aiReview.suggestions.indexOf(s)}
                      pr={pr}
                      onPost={postSuggestion}
                      isPosting={postingIdx === aiReview.suggestions.indexOf(s)}
                    />
                  ))}

                  {infoSuggestions.length > 0 && (
                    <div>
                      <button
                        onClick={() => setShowInfo((v) => !v)}
                        className="flex items-center gap-1.5 text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                      >
                        <Lightbulb size={11} />
                        {showInfo ? 'Hide' : 'Show'} {infoSuggestions.length} informational suggestion{infoSuggestions.length !== 1 ? 's' : ''}
                        {showInfo ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                      </button>
                      {showInfo && (
                        <div className="mt-2 space-y-2">
                          {infoSuggestions.map((s, i) => (
                            <SuggestionCard
                              key={`info-${i}`}
                              s={s}
                              idx={aiReview.suggestions.indexOf(s)}
                              pr={pr}
                              onPost={postSuggestion}
                              isPosting={postingIdx === aiReview.suggestions.indexOf(s)}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
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
          {pr.provider === 'azure-devops' && pr.adoProjectName && (
            <WorkItemsPanel pr={pr} projectId={projectId} />
          )}
          <DiffPanel pr={pr} projectId={projectId} />
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

  const [showCreateBranch, setShowCreateBranch] = useState(false);
  const { data: projectData } = useQuery({
    queryKey: ['project-repos', projectId],
    queryFn: () => api.get<{ data: { repositories: ProjectRepo[] } }>(`/api/projects/${projectId}`),
    enabled: hasRepositories,
    staleTime: 60_000,
  });
  const repos = projectData?.data.repositories ?? [];

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
      <div className="space-y-3">
        {[...Array(3)].map((_, i) => (
          <PRCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <ApiErrorBanner
        message={error instanceof Error ? error.message : 'Failed to load pull requests'}
        onRetry={() => refetch()}
      />
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
        {repos.length > 0 && (
          <button
            onClick={() => setShowCreateBranch(true)}
            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700"
          >
            <GitBranch size={13} /> New Branch
          </button>
        )}
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
        <EmptyState
          icon={GitPullRequest}
          title="No open pull requests"
          description="All clear! No open PRs across your repositories."
        />
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

      {showCreateBranch && repos.length > 0 && (
        <CreateBranchModal repos={repos} onClose={() => setShowCreateBranch(false)} />
      )}
    </div>
  );
}
