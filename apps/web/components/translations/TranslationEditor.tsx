'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, BarChart2, ChevronDown, ChevronLeft, ChevronRight, Download, ExternalLink, Filter, FolderOpen, GitCommit, GitPullRequest, Loader2, RotateCcw, Save, Search, Sparkles, Upload, X, Zap } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useDropzone } from 'react-dropzone';
import { toast } from 'sonner';
import type { TranslationState } from '@nexus/types';
import { api } from '@/lib/api';
import { cn, getStateColor, getStateLabel } from '@/lib/utils';
import { CommitModal } from '@/components/projects/CommitModal';

interface Translation {
  id: string;
  unitId: string;
  source: string;
  target: string;
  state: TranslationState;
  note?: string;
  developerNote?: string;
  qualityIssues?: string[];
  suppressedQualityIssues?: string[];
  qualityIssueMeta?: { inconsistentVariants?: Array<{ target: string; count: number }> };
  syncChangedAt?: string | null;
  syncChangeType?: 'added' | 'source-changed' | 'removed' | null;
}

interface XliffFileInfo {
  id: string;
  filename: string;
  sourceLanguage: string;
  targetLanguage: string;
  remoteConnectionId?: string;
  remotePath?: string;
  remoteBranch?: string;
  remoteRepo?: string;
  remotePrId?: string | null;
  remotePrUrl?: string | null;
  lastSyncAt?: string | null;
}

interface XliffNoteMeta {
  objectType: string;
  objectName: string;
  memberType?: string;
  memberName?: string;
  property?: string;
}

// BC object types that appear at the start of Xliff Generator notes
const BC_OBJECT_TYPES = [
  'Table', 'TableExtension', 'Page', 'PageExtension', 'PageCustomization',
  'Codeunit', 'Report', 'ReportExtension', 'XMLPort', 'Query', 'Enum',
  'EnumExtension', 'Profile', 'Interface', 'PermissionSet',
];

// ─── AL source file parsing ────────────────────────────────────────────────

interface AlObject { objectType: string; objectName: string }

/** Maps AL keyword → BC XLIFF object type string */
const AL_TYPE_MAP: Record<string, string> = {
  table: 'Table', tableextension: 'TableExtension',
  page: 'Page', pageextension: 'PageExtension', pagecustomization: 'PageCustomization',
  codeunit: 'Codeunit', report: 'Report', reportextension: 'ReportExtension',
  xmlport: 'XMLPort', query: 'Query',
  enum: 'Enum', enumextension: 'EnumExtension',
  profile: 'Profile', interface: 'Interface', permissionset: 'PermissionSet',
};

/** Matches the first object declaration in an AL file, e.g. `codeunit 50200 "My CU" {` */
const AL_OBJECT_RE = /^(tableextension|table|pagecustomization|pageextension|page|codeunit|reportextension|report|xmlport|query|enumextension|enum|profile|interface|permissionset)\s+\d+\s+["']?([^"'{\n]+?)["']?\s*[{(]/im;

function parseAlContent(text: string): AlObject | null {
  const m = AL_OBJECT_RE.exec(text);
  if (!m) return null;
  const bcType = AL_TYPE_MAP[m[1].toLowerCase()];
  if (!bcType) return null;
  return { objectType: bcType, objectName: m[2].trim().replace(/^["']|["']$/g, '') };
}

async function readEntryFiles(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    if (!entry.name.endsWith('.al')) return [];
    return new Promise<File[]>((res, rej) =>
      (entry as FileSystemFileEntry).file((f) => res([f]), rej)
    );
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries only returns up to 100 at a time — loop until exhausted
    const allEntries: FileSystemEntry[] = [];
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) =>
        reader.readEntries(res, rej)
      );
      if (batch.length === 0) break;
      allEntries.push(...batch);
    }
    const nested = await Promise.all(allEntries.map(readEntryFiles));
    return nested.flat();
  }
  return [];
}

async function extractAlObjectsFromDrop(dt: DataTransfer): Promise<AlObject[]> {
  const entries: FileSystemEntry[] = [];
  for (let i = 0; i < dt.items.length; i++) {
    const e = dt.items[i].webkitGetAsEntry();
    if (e) entries.push(e);
  }
  const files = (await Promise.all(entries.map(readEntryFiles))).flat();
  const seen = new Set<string>();
  const objects: AlObject[] = [];
  for (const file of files) {
    const obj = parseAlContent(await file.text());
    if (!obj) continue;
    const key = `${obj.objectType}:${obj.objectName}`;
    if (!seen.has(key)) { seen.add(key); objects.push(obj); }
  }
  return objects;
}

// ──────────────────────────────────────────────────────────────────────────

/** Parse a BC Xliff Generator note into structured metadata.
 *  Format: "{ObjectType} {ObjectName} - [{MemberType} {MemberName} -] {PropertyType} {PropertyName}"
 */
function parseXliffNote(note?: string): XliffNoteMeta | null {
  if (!note) return null;
  const parts = note.split(' - ');
  if (parts.length < 2) return null;

  const firstSpace = parts[0].indexOf(' ');
  if (firstSpace === -1) return null;

  const objectType = parts[0].substring(0, firstSpace);
  if (!BC_OBJECT_TYPES.includes(objectType)) return null;
  const objectName = parts[0].substring(firstSpace + 1);

  const lastPart = parts[parts.length - 1];
  const lastSpace = lastPart.indexOf(' ');
  const property = lastSpace !== -1 ? lastPart.substring(lastSpace + 1) : lastPart;

  let memberType: string | undefined;
  let memberName: string | undefined;
  if (parts.length >= 3) {
    const mid = parts[1];
    const midSpace = mid.indexOf(' ');
    if (midSpace !== -1) {
      memberType = mid.substring(0, midSpace);
      memberName = mid.substring(midSpace + 1);
    }
  }

  return { objectType, objectName, memberType, memberName, property };
}

const STATES: TranslationState[] = ['new', 'needs-translation', 'needs-review-translation', 'translated', 'final', 'signed-off'];
const PAGE_SIZE = 50;
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Request failed';
}

function ReviewBadge({
  result,
  onApply,
}: {
  result: { quality: string; suggestion?: string; reason?: string };
  onApply?: (suggestion: string) => void;
}) {
  const [open, setOpen] = useState(false);

  if (result.quality === 'good') {
    return (
      <span className="inline-flex items-center rounded-full bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/40 dark:text-green-300" title="Looks good">
        ✓
      </span>
    );
  }

  const isError = result.quality === 'error';
  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex items-center rounded-full px-1.5 py-0.5 text-xs font-medium',
          isError
            ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
            : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
        )}
        title={result.reason}
      >
        {isError ? '✗' : '⚠'}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 z-40 mt-1 w-72 rounded-lg border border-gray-200 bg-white p-3 shadow-xl dark:border-gray-700 dark:bg-gray-900">
            {result.reason && (
              <p className="mb-2 text-xs text-gray-600 dark:text-gray-400">{result.reason}</p>
            )}
            {result.suggestion && (
              <>
                <p className="mb-1 text-xs font-semibold text-gray-700 dark:text-gray-300">Suggested:</p>
                <p className="mb-2 rounded bg-gray-50 px-2 py-1 text-xs text-gray-800 italic dark:bg-gray-800 dark:text-gray-200">{result.suggestion}</p>
                {onApply && (
                  <button
                    type="button"
                    onClick={() => { onApply(result.suggestion!); setOpen(false); }}
                    className="w-full rounded-lg bg-indigo-600 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
                  >
                    Apply suggestion
                  </button>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const STATE_STYLES: Record<string, { badge: string; dot: string }> = {
  new:                        { badge: 'border-gray-400 bg-gray-100 text-gray-700 dark:border-gray-500 dark:bg-gray-700 dark:text-gray-200',          dot: 'bg-gray-400 dark:bg-gray-400' },
  'needs-translation':        { badge: 'border-red-400 bg-red-50 text-red-700 dark:border-red-500 dark:bg-red-900/60 dark:text-red-200',              dot: 'bg-red-500' },
  'needs-review-translation': { badge: 'border-amber-400 bg-amber-50 text-amber-700 dark:border-amber-500 dark:bg-amber-900/60 dark:text-amber-200', dot: 'bg-amber-400' },
  translated:                 { badge: 'border-blue-400 bg-blue-50 text-blue-700 dark:border-blue-500 dark:bg-blue-900/60 dark:text-blue-200',        dot: 'bg-blue-500' },
  final:                      { badge: 'border-green-400 bg-green-50 text-green-700 dark:border-green-500 dark:bg-green-900/60 dark:text-green-200',  dot: 'bg-green-500' },
  'signed-off':               { badge: 'border-emerald-400 bg-emerald-50 text-emerald-700 dark:border-emerald-500 dark:bg-emerald-900/60 dark:text-emerald-200', dot: 'bg-emerald-500' },
};

function StateDropdown({ value, onChange }: { value: TranslationState; onChange: (s: TranslationState) => void }) {
  const [open, setOpen] = useState(false);
  const styles = STATE_STYLES[value] ?? STATE_STYLES.new;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex w-full items-center justify-between gap-1.5 rounded-lg border px-2 py-1.5 text-xs font-semibold transition-opacity hover:opacity-90',
          styles.badge
        )}
      >
        <span className="truncate">{getStateLabel(value)}</span>
        <ChevronDown size={11} className="shrink-0 opacity-60" />
      </button>
      {open && (
        <>
          {/* backdrop to close */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 min-w-[155px] rounded-lg border border-gray-200 bg-white py-1 shadow-xl dark:border-gray-700 dark:bg-gray-850 dark:bg-gray-900">
            {STATES.map((s) => {
              const sc = STATE_STYLES[s] ?? STATE_STYLES.new;
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => { onChange(s); setOpen(false); }}
                  className={cn(
                    'flex w-full items-center gap-2.5 px-3 py-2 text-xs hover:bg-gray-50 dark:hover:bg-gray-800',
                    value === s ? 'font-semibold' : 'font-normal'
                  )}
                >
                  <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', sc.dot)} />
                  <span className="text-gray-800 dark:text-gray-100">{getStateLabel(s)}</span>
                  {value === s && <span className="ml-auto text-indigo-500">✓</span>}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export function TranslationEditor({ projectId, xliffFileId, initialObjectFilter, initialFilter }: { projectId: string; xliffFileId?: string; initialObjectFilter?: string; initialFilter?: string }) {
  const qc = useQueryClient();
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [searchIn, setSearchIn] = useState<'all' | 'source' | 'target' | 'objectName'>('all');
  const [filterState, setFilterState] = useState<TranslationState | 'all' | 'untranslated' | 'quality-issues' | 'since-last-sync'>(
    (initialFilter as TranslationState | 'all' | 'untranslated' | 'quality-issues' | 'since-last-sync') ?? 'untranslated'
  );
  const [showAcceptedIssues, setShowAcceptedIssues] = useState(false);
  const [expandedTmKey, setExpandedTmKey] = useState<string | null>(null);
  const [objectType, setObjectType] = useState('');
  const [folderObjects, setFolderObjects] = useState<AlObject[]>([]);
  const [folderDragOver, setFolderDragOver] = useState(false);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const bulkAbortControllerRef = useRef<AbortController | null>(null);
  const [page, setPage] = useState(1);
  const [edits, setEdits] = useState<Map<string, { target: string; state: TranslationState }>>(new Map());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [aiTranslating, setAiTranslating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [reviewResults, setReviewResults] = useState<Map<string, { quality: string; suggestion?: string; reason?: string }>>(new Map());
  const [reviewContext, setReviewContext] = useState('');
  const [showReviewPanel, setShowReviewPanel] = useState(false);
  const [aiReviewing, setAiReviewing] = useState(false);
  const [showCommitModal, setShowCommitModal] = useState(false);
  // ─── Push as PR state ──────────────────────────────────────────────────────
  const [showPushPrDialog, setShowPushPrDialog] = useState(false);
  const [pushPrBranchName, setPushPrBranchName] = useState('');
  const [pushPrTitle, setPushPrTitle] = useState('');
  const [pushPrTargetBranch, setPushPrTargetBranch] = useState('');
  const [pushPrDescription, setPushPrDescription] = useState('');
  const [pushPrLoading, setPushPrLoading] = useState(false);
  const [pushPrResult, setPushPrResult] = useState<{ prId: number; prUrl?: string; branchName: string } | null>(null);
  const [tmSuggestions, setTmSuggestions] = useState<Map<string, Array<{ target: string; score: number; usageCount: number; sourceText: string; projectId: string | null }>>>(new Map());
  const [tmLoadingIds, setTmLoadingIds] = useState<Set<string>>(new Set());
  const [singleAiIds, setSingleAiIds] = useState<Set<string>>(new Set());

  // ─── VS Code context menu ──────────────────────────────────────────────────
  const [vsCtxMenu, setVsCtxMenu] = useState<{ x: number; y: number; type: 'source' | 'xliff'; unitId: string; note?: string } | null>(null);

  function openVsCode(type: 'source' | 'xliff', unitId: string, note?: string) {
    if (!xliffFileId) return;
    const params = new URLSearchParams({ type, xliffFileId });
    if (type === 'xliff') params.set('unitId', unitId);
    if (type === 'source' && note) params.set('note', note);
    api.get<{ url: string; hint?: string }>(`/api/projects/${projectId}/vscode-link?${params}`)
      .then(({ url, hint }) => {
        if (hint) toast.info(hint);
        window.location.href = url;
      })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'VS Code navigation failed'));
    setVsCtxMenu(null);
  }

  // ─── Bulk translate state ──────────────────────────────────────────────────
  type BulkResult = { id: string; suggestedTarget: string; confidenceScore: number; confidence: string };
  const [showBulkPanel, setShowBulkPanel] = useState(false);
  const [bulkTranslating, setBulkTranslating] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [bulkResults, setBulkResults] = useState<BulkResult[]>([]);
  const [bulkDone, setBulkDone] = useState(false);

  const { data: projectData } = useQuery({
    queryKey: ['project-files', projectId],
    queryFn: () => api.get<{ data: { xliffFiles: XliffFileInfo[]; localWorkspacePath?: string | null } }>(`/api/projects/${projectId}`),
    staleTime: 60_000, // avoid refetch on every back-navigation
  });
  const currentFile = projectData?.data.xliffFiles.find((f) => f.id === xliffFileId);
  const localWorkspacePath = projectData?.data.localWorkspacePath;

  // Derive objectFilters: if an initialObjectFilter URL param was supplied (from AL Analyser),
  // use that as the single object filter (unless the user has also dropped a folder).
  const objectFilters = folderObjects.length > 0
    ? folderObjects.map((o) => `${o.objectType} ${o.objectName}`).join(',')
    : (initialObjectFilter ?? '');

  const queryParams = new URLSearchParams({
    projectId,
    ...(xliffFileId ? { xliffFileId } : {}),
    ...(filterState === 'untranslated'
      ? { untranslatedOnly: 'true' }
      : filterState === 'quality-issues'
        ? { qualityIssuesOnly: 'true' }
        : filterState === 'since-last-sync'
          ? { changesOnly: 'true' }
          : filterState !== 'all'
            ? { state: filterState }
            : {}),
    ...(search ? { search } : {}),
    ...(searchIn !== 'all' ? { searchIn } : {}),
    ...(objectType ? { objectType } : {}),
    ...(objectFilters ? { objectFilters } : {}),
    page: String(page),
    pageSize: String(PAGE_SIZE),
  });

  const { data, isLoading } = useQuery({
    queryKey: ['translations', projectId, xliffFileId, filterState, search, searchIn, objectType, objectFilters, page],
    queryFn: () =>
      api.get<{ data: Translation[]; meta: { total: number; totalPages: number } }>(`/api/translations?${queryParams}`),
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (edits.size === 0) return undefined;
      const updates = Array.from(edits.entries()).map(([id, value]) => ({ id, ...value }));
      return api.patch('/api/translations/bulk', { updates });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['translations', projectId] });
      setEdits(new Map());
      toast.success('Translations saved');
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const suppressIssueMutation = useMutation({
    mutationFn: ({ id, suppressedQualityIssues }: { id: string; suppressedQualityIssues: string[] }) =>
      api.patch(`/api/translations/${id}`, { suppressedQualityIssues }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['translations', projectId] }),
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const applyToSourceMutation = useMutation({
    mutationFn: ({ source, target }: { source: string; target: string }) =>
      api.post<{ updated: number }>('/api/translations/apply-to-source', {
        xliffFileId: currentFile?.id,
        projectId,
        source,
        target,
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['translations', projectId] });
      toast.success(`Applied to ${res.updated} translation${res.updated !== 1 ? 's' : ''} with the same source`);
      setExpandedTmKey(null);
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  // Fetch TM suggestions whenever visible translations change
  const translations = data?.data ?? [];

  useEffect(() => {
    if (!translations.length || !currentFile) return;
    const untranslated = translations.filter((t) => !t.target || t.state === 'needs-translation' || t.state === 'new');
    if (!untranslated.length) return;

    const sources = [...new Set(untranslated.map((t) => t.source))];
    api.post<{ data: Record<string, { target: string; score: number; projectId: string | null }> }>(
      '/api/translation-memory/lookup',
      {
        sources,
        sourceLanguage: currentFile.sourceLanguage,
        targetLanguage: currentFile.targetLanguage,
        projectId,
      }
    ).then((res) => {
      const map = new Map<string, Array<{ target: string; score: number; usageCount: number; sourceText: string; projectId: string | null }>>();
      for (const t of untranslated) {
        const hits = res.data[t.source];
        if (hits?.length) map.set(t.id, hits);
      }
      setTmSuggestions(map);
    }).catch(() => { /* silently ignore TM errors */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [translations.map((t) => t.id).join(','), currentFile?.id]);

  // Ctrl+S / Cmd+S global shortcut
  useEffect(() => {
    const handler = () => { if (edits.size > 0) saveMutation.mutate(); };
    window.addEventListener('nhd:save', handler);
    return () => window.removeEventListener('nhd:save', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edits.size]);

  function applyAllTmMatches() {
    const exact = Array.from(tmSuggestions.entries()).filter(([, v]) => v[0]?.score === 1);
    if (!exact.length) { toast.info('No exact TM matches to apply'); return; }
    setEdits((prev) => {
      const next = new Map(prev);
      for (const [id, suggestions] of exact) {
        next.set(id, { target: suggestions[0].target, state: 'translated' });
      }
      return next;
    });
    toast.success(`Applied ${exact.length} exact TM match${exact.length > 1 ? 'es' : ''}`);
  }

  // Fetch TM suggestion for a single row on focus (if not already cached)
  async function fetchTmForRow(translation: Translation) {
    if (!currentFile) return;
    if (tmSuggestions.has(translation.id) || tmLoadingIds.has(translation.id)) return;
    setTmLoadingIds((prev) => new Set(prev).add(translation.id));
    try {
      const res = await api.post<{ data: Record<string, Array<{ target: string; score: number; usageCount: number; sourceText: string; projectId: string | null }>> }>(
        '/api/translation-memory/lookup',
        { sources: [translation.source], sourceLanguage: currentFile.sourceLanguage, targetLanguage: currentFile.targetLanguage, projectId }
      );
      const hits = res.data[translation.source];
      if (hits?.length) {
        setTmSuggestions((prev) => new Map(prev).set(translation.id, hits));
      } else {
        // Mark as "checked, no match" with a sentinel so we don't re-fetch
        setTmSuggestions((prev) => new Map(prev).set(translation.id, []));
      }
    } catch { /* ignore */ } finally {
      setTmLoadingIds((prev) => { const s = new Set(prev); s.delete(translation.id); return s; });
    }
  }

  // Single-string AI quick translate for one row
  async function aiTranslateSingle(translation: Translation) {
    setSingleAiIds((prev) => new Set(prev).add(translation.id));
    try {
      const res = await api.post<{ data: { id: string; suggestedTarget: string }[] }>(
        '/api/ai/translate',
        { translationIds: [translation.id], projectId }
      );
      const suggestion = res.data[0];
      if (suggestion) {
        handleEdit(translation.id, 'target', suggestion.suggestedTarget);
        handleEdit(translation.id, 'state', 'needs-review-translation');
      }
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSingleAiIds((prev) => { const s = new Set(prev); s.delete(translation.id); return s; });
    }
  }

  const aiTranslate = useCallback(
    async (ids: string[]) => {
      if (!ids.length) return;
      setAiTranslating(true);
      try {
        const response = await api.post<{ data: { id: string; suggestedTarget: string }[]; meta: { translated: number } }>(
          '/api/ai/translate',
          { translationIds: ids, projectId }
        );
        // Put suggestions into edits Map as "needs-review-translation" → shows yellow for user review
        setEdits((prev) => {
          const next = new Map(prev);
          for (const s of response.data) {
            next.set(s.id, { target: s.suggestedTarget, state: 'needs-review-translation' });
          }
          return next;
        });
        setSelected(new Set());
        toast.success(`AI suggested ${response.meta.translated} translations — review highlighted rows, then Save`);
      } catch (error) {
        toast.error(getErrorMessage(error));
      } finally {
        setAiTranslating(false);
      }
    },
    [projectId]
  );

  const aiReview = useCallback(
    async (ids: string[]) => {
      if (!ids.length) return;
      setAiReviewing(true);
      try {
        const response = await api.post<{
          data: { id: string; quality: string; suggestion?: string; reason?: string }[];
          meta: { good: number; warnings: number; errors: number };
        }>('/api/ai/review', { translationIds: ids, projectId, additionalContext: reviewContext || undefined });

        setReviewResults((prev) => {
          const next = new Map(prev);
          for (const r of response.data) next.set(r.id, { quality: r.quality, suggestion: r.suggestion, reason: r.reason });
          return next;
        });
        const { good, warnings, errors } = response.meta;
        toast.success(`Review done: ${good} ✓ good, ${warnings} ⚠ suggestions, ${errors} ✗ errors`);
        setShowReviewPanel(false);
      } catch (error) {
        toast.error(getErrorMessage(error));
      } finally {
        setAiReviewing(false);
      }
    },
    [projectId, reviewContext]
  );

  // ─── Bulk translate via SSE streaming ─────────────────────────────────────
  const startBulkTranslate = useCallback(async () => {
    if (!xliffFileId) return;
    setBulkTranslating(true);
    setBulkResults([]);
    setBulkDone(false);
    setBulkProgress({ done: 0, total: 0 });

    const controller = new AbortController();
    bulkAbortControllerRef.current = controller;

    try {
      const res = await fetch(`${API_URL}/api/ai/translate-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, xliffFileId }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error('Failed to start bulk translation');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6)) as {
              type: string;
              total?: number;
              done?: number;
              results?: Array<{ id: string; suggestedTarget: string; confidenceScore: number; confidence: string }>;
              message?: string;
            };
            if (event.type === 'start') {
              setBulkProgress({ done: 0, total: event.total ?? 0 });
            } else if (event.type === 'progress') {
              setBulkProgress({ done: event.done ?? 0, total: event.total ?? 0 });
              setBulkResults((prev) => [...prev, ...(event.results ?? [])]);
            } else if (event.type === 'complete') {
              setBulkDone(true);
              setBulkProgress({ done: event.done ?? 0, total: event.total ?? 0 });
              toast.success(`Bulk translation complete — ${event.done} strings ready to review`);
            } else if (event.type === 'error') {
              toast.error(event.message ?? 'Bulk translation failed');
            }
          } catch { /* skip malformed SSE line */ }
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        toast.info('Bulk translation cancelled');
        setBulkDone(true);
      } else {
        toast.error(getErrorMessage(error));
      }
    } finally {
      bulkAbortControllerRef.current = null;
      setBulkTranslating(false);
    }
  }, [projectId, xliffFileId]);

  function cancelBulkTranslate() {
    bulkAbortControllerRef.current?.abort();
  }

  // ─── Push XLIFF as new branch + PR ────────────────────────────────────────
  async function doPushAsPr() {
    if (!currentFile || !xliffFileId) return;
    if (!pushPrBranchName.trim() || !pushPrTitle.trim() || !pushPrTargetBranch.trim()) {
      toast.error('Branch name, PR title, and target branch are required');
      return;
    }
    const repoParts = currentFile.remoteRepo!.split('/');
    const isAdo = repoParts.length >= 3;
    const connId = currentFile.remoteConnectionId!;
    setPushPrLoading(true);
    try {
      let result: { data: { prId: number; prUrl?: string; branchName: string } };
      if (isAdo) {
        const adoProject = repoParts[repoParts.length - 2];
        const repoId = repoParts[repoParts.length - 1];
        result = await api.post(
          `/api/remote/connections/${connId}/azure/projects/${encodeURIComponent(adoProject)}/repos/${encodeURIComponent(repoId)}/push-xliff`,
          { xliffFileId, branchName: pushPrBranchName.trim(), prTitle: pushPrTitle.trim(), targetBranch: pushPrTargetBranch.trim(), prDescription: pushPrDescription }
        );
      } else {
        const [owner, repo] = repoParts;
        result = await api.post(
          `/api/remote/connections/${connId}/github/repos/${owner}/${repo}/push-xliff`,
          { xliffFileId, branchName: pushPrBranchName.trim(), prTitle: pushPrTitle.trim(), targetBranch: pushPrTargetBranch.trim(), prDescription: pushPrDescription }
        );
      }
      setPushPrResult(result.data);
      toast.success(`PR #${result.data.prId} created!`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create PR');
    } finally {
      setPushPrLoading(false);
    }
  }

  /** Apply all bulk results as edits (staged for review, not yet saved) */
  function applyBulkResults(minScore = 0) {
    const toApply = bulkResults.filter((r) => r.confidenceScore >= minScore);
    if (!toApply.length) { toast.info('No results to apply'); return; }
    setEdits((prev) => {
      const next = new Map(prev);
      for (const r of toApply) {
        next.set(r.id, { target: r.suggestedTarget, state: 'needs-review-translation' });
      }
      return next;
    });
    toast.success(`Staged ${toApply.length} translations — review highlighted rows, then Save`);
    setShowBulkPanel(false);
    setBulkResults([]);
    setBulkDone(false);
  }

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
        qc.invalidateQueries({ queryKey: ['project-files', projectId] });
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

  const { getRootProps, getInputProps, open: openFilePicker } = useDropzone({
    onDrop,
    accept: { 'application/xml': ['.xlf', '.xliff'], 'text/xml': ['.xlf', '.xliff'] },
    multiple: false,
    noClick: true,
  });

  const total = data?.meta.total ?? 0;
  const totalPages = data?.meta.totalPages ?? 1;
  const hasEdits = edits.size > 0;
  const activeFilters = (search ? 1 : 0) + (objectType ? 1 : 0) + (filterState !== 'untranslated' ? 1 : 0) + (folderObjects.length > 0 ? 1 : 0);

  function handleEdit(id: string, field: 'target' | 'state', value: string) {
    setEdits((previous) => {
      const next = new Map(previous);
      const existing = next.get(id);
      const original = translations.find((t) => t.id === id);
      next.set(id, {
        target: field === 'target' ? value : (existing?.target ?? original?.target ?? ''),
        state: (field === 'state' ? value : (existing?.state ?? original?.state ?? 'translated')) as TranslationState,
      });
      return next;
    });
  }

  function toggleSelect(id: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((previous) =>
      previous.size === translations.length ? new Set() : new Set(translations.map((t) => t.id))
    );
  }

  function clearFilters() {
    setSearch('');
    setSearchIn('all');
    setObjectType('');
    setFilterState('untranslated');
    setFolderObjects([]);
    setPage(1);
  }

  const handleFolderDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setFolderDragOver(false);
    try {
      const objects = await extractAlObjectsFromDrop(e.dataTransfer);
      if (objects.length > 0) {
        setFolderObjects(objects);
        setPage(1);
        toast.success(`Loaded ${objects.length} AL objects from folder`);
      } else {
        toast.error('No .al files found — drop a BC source folder');
      }
    } catch {
      toast.error('Failed to read folder');
    }
  }, []);

  const handleFolderInput = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []).filter((f) => f.name.endsWith('.al'));
    const seen = new Set<string>();
    const objects: AlObject[] = [];
    for (const file of files) {
      const obj = parseAlContent(await file.text());
      if (!obj) continue;
      const key = `${obj.objectType}:${obj.objectName}`;
      if (!seen.has(key)) { seen.add(key); objects.push(obj); }
    }
    if (objects.length > 0) {
      setFolderObjects(objects);
      setPage(1);
      toast.success(`Loaded ${objects.length} AL objects`);
    }
    e.target.value = '';
  }, []);

  return (
    <>
    <div {...getRootProps()} onClick={undefined}>
      <input {...getInputProps()} />

      {/* Header */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link href={`/projects/${projectId}`} className="text-gray-400 hover:text-gray-600 dark:text-gray-600 dark:hover:text-gray-300">
            <ChevronLeft size={20} />
          </Link>
          <div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-white">
              {currentFile ? currentFile.filename : 'Translation Editor'}
            </h2>
            <p className="text-xs text-gray-400 dark:text-gray-600">
              {total} strings{activeFilters > 0 ? ' (filtered)' : ''}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={openFilePicker}
            disabled={uploading}
            className="flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            <Upload size={14} />
            {uploading ? 'Uploading...' : 'Upload XLIFF'}
          </button>
          {xliffFileId && (
            <a
              href={`${API_URL}/api/projects/${projectId}/xliff/${xliffFileId}/download`}
              download
              className="flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
            >
              <Download size={14} /> Download XLIFF
            </a>
          )}
          {currentFile?.remoteRepo && (
            <button
              onClick={() => setShowCommitModal(true)}
              className="flex items-center gap-2 rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100 dark:border-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300 dark:hover:bg-indigo-900/50"
            >
              <GitCommit size={14} /> Commit to Remote
            </button>
          )}
          {currentFile?.remoteRepo && currentFile.remoteConnectionId && (
            <button
              onClick={() => {
                const ts = Date.now();
                setPushPrBranchName(`translations/update-${ts}`);
                setPushPrTitle(`Update translations in ${currentFile.filename}`);
                setPushPrTargetBranch(currentFile.remoteBranch ?? 'main');
                setPushPrDescription('');
                setPushPrResult(null);
                setShowPushPrDialog(true);
              }}
              className="flex items-center gap-2 rounded-lg border border-green-300 bg-green-50 px-3 py-2 text-sm font-medium text-green-700 hover:bg-green-100 dark:border-green-700 dark:bg-green-900/30 dark:text-green-300 dark:hover:bg-green-900/50"
            >
              <GitPullRequest size={14} /> Push as PR
            </button>
          )}
          {/* TM apply button */}
          {tmSuggestions.size > 0 && (
            <button
              onClick={applyAllTmMatches}
              className="flex items-center gap-2 rounded-lg border border-teal-300 bg-teal-50 px-3 py-2 text-sm font-medium text-teal-700 hover:bg-teal-100 dark:border-teal-700 dark:bg-teal-900/30 dark:text-teal-300 dark:hover:bg-teal-900/50"
              title="Apply all exact (100%) translation memory matches"
            >
              <span className="text-xs font-bold">TM</span>
              {Array.from(tmSuggestions.values()).filter((v) => v[0]?.score === 1).length > 0
                ? `Apply exact (${Array.from(tmSuggestions.values()).filter((v) => v[0]?.score === 1).length})`
                : `${tmSuggestions.size} fuzzy matches`}
            </button>
          )}
          {selected.size > 0 && (
            <button
              onClick={() => aiTranslate(Array.from(selected))}
              disabled={aiTranslating}
              className="flex items-center gap-2 rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50"
            >
              <Sparkles size={15} />
              {aiTranslating ? 'Translating...' : `AI Translate (${selected.size})`}
            </button>
          )}
          {/* Bulk translate button — only when a file is loaded */}
          {xliffFileId && (
            <button
              onClick={() => { setShowBulkPanel((p) => !p); setShowReviewPanel(false); }}
              disabled={bulkTranslating}
              className={cn(
                'flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50',
                showBulkPanel || bulkResults.length > 0
                  ? 'border-orange-500 bg-orange-50 text-orange-700 dark:border-orange-500 dark:bg-orange-900/30 dark:text-orange-300'
                  : 'border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800'
              )}
            >
              <Zap size={14} />
              {bulkTranslating ? 'Translating…' : bulkDone ? `Bulk (${bulkResults.length} ready)` : 'Bulk Translate'}
            </button>
          )}
          {/* AI Review button — works on selected items, or all visible if none selected */}
          {translations.length > 0 && (
            <button
              onClick={() => setShowReviewPanel((p) => !p)}
              disabled={aiReviewing}
              className={cn(
                'flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50',
                showReviewPanel || reviewResults.size > 0
                  ? 'border-violet-500 bg-violet-50 text-violet-700 dark:border-violet-500 dark:bg-violet-900/30 dark:text-violet-300'
                  : 'border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800'
              )}
            >
              <Sparkles size={14} />
              {aiReviewing
                ? 'Reviewing...'
                : reviewResults.size > 0
                  ? `Review (${reviewResults.size} checked)`
                  : selected.size > 0
                    ? `Review (${selected.size})`
                    : 'Review Quality'}
            </button>
          )}
          {hasEdits && (
            <>
              <button
                onClick={() => setEdits(new Map())}
                className="flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
              >
                <RotateCcw size={14} /> Discard
              </button>
              <button
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending}
                title="Save translations (Ctrl+S)"
                className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                <Save size={15} /> {saveMutation.isPending ? 'Saving...' : `Save (${edits.size})`}
                <kbd className="hidden rounded border border-indigo-500 bg-indigo-700 px-1 py-0.5 text-[9px] font-mono text-indigo-200 sm:inline">Ctrl+S</kbd>
              </button>
            </>
          )}
        </div>
      </div>

      {/* AI Review Panel */}
      {showReviewPanel && (
        <div className="mb-4 rounded-xl border border-violet-200 bg-violet-50 p-4 dark:border-violet-800 dark:bg-violet-900/20">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles size={15} className="text-violet-600 dark:text-violet-400" />
              <span className="text-sm font-semibold text-violet-800 dark:text-violet-300">
                AI Quality Review
                {selected.size > 0 ? ` — ${selected.size} selected` : ` — ${translations.length} visible`}
              </span>
            </div>
            <button type="button" onClick={() => setShowReviewPanel(false)} className="text-violet-400 hover:text-violet-600 dark:hover:text-violet-300">
              <X size={16} />
            </button>
          </div>
          <p className="mb-3 text-xs text-violet-600 dark:text-violet-400">
            The AI will check Business Central terminology, placeholder correctness, grammar, and glossary compliance.
          </p>
          <textarea
            value={reviewContext}
            onChange={(e) => setReviewContext(e.target.value)}
            placeholder="Additional context (optional): e.g. 'Customer = Debitor (not Kunde)', 'this is a warehouse module', 'keep German formal Sie-form'..."
            rows={2}
            className="mb-3 w-full resize-none rounded-lg border border-violet-300 bg-white px-3 py-2 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-violet-400 dark:border-violet-700 dark:bg-gray-900 dark:text-gray-200 dark:placeholder-gray-600"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={aiReviewing}
              onClick={() => {
                const ids = selected.size > 0 ? Array.from(selected) : translations.map((t) => t.id);
                aiReview(ids);
              }}
              className="flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
            >
              <Sparkles size={14} />
              {aiReviewing ? 'Reviewing...' : `Start Review (${selected.size > 0 ? selected.size : translations.length} strings)`}
            </button>
            {reviewResults.size > 0 && (
              <button
                type="button"
                onClick={() => setReviewResults(new Map())}
                className="text-sm text-violet-500 hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-300"
              >
                Clear results
              </button>
            )}
          </div>
        </div>
      )}

      {/* Bulk Translate Panel */}
      {showBulkPanel && (
        <div className="mb-4 rounded-xl border border-orange-200 bg-orange-50 p-4 dark:border-orange-800 dark:bg-orange-900/20">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap size={15} className="text-orange-600 dark:text-orange-400" />
              <span className="text-sm font-semibold text-orange-800 dark:text-orange-300">
                Bulk AI Translate
              </span>
              {bulkProgress.total > 0 && (
                <span className="text-xs text-orange-600 dark:text-orange-400">
                  — all untranslated in file ({bulkProgress.total} strings)
                </span>
              )}
            </div>
            <button type="button" onClick={() => setShowBulkPanel(false)} className="text-orange-400 hover:text-orange-600 dark:hover:text-orange-300">
              <X size={16} />
            </button>
          </div>

          <p className="mb-3 text-xs text-orange-700 dark:text-orange-400">
            Translates every untranslated string in this file using AI + your glossary. Results are staged for review — nothing is saved until you click Save.
          </p>

          {/* Progress bar */}
          {(bulkTranslating || bulkProgress.total > 0) && (
            <div className="mb-3">
              <div className="mb-1 flex items-center justify-between text-xs text-orange-700 dark:text-orange-400">
                <span className="flex items-center gap-1.5">
                  {bulkTranslating && <Loader2 size={11} className="animate-spin" />}
                  {bulkDone ? 'Complete' : bulkTranslating ? 'Translating…' : ''}
                </span>
                <span className="font-mono">{bulkProgress.done} / {bulkProgress.total}</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-orange-200 dark:bg-orange-900/50">
                <div
                  className="h-full rounded-full bg-orange-500 transition-all duration-300"
                  style={{ width: bulkProgress.total ? `${(bulkProgress.done / bulkProgress.total) * 100}%` : '0%' }}
                />
              </div>
              {bulkTranslating && (
                <button
                  type="button"
                  onClick={cancelBulkTranslate}
                  className="mt-2 flex items-center gap-1.5 rounded-lg border border-orange-400 px-3 py-1 text-xs font-medium text-orange-700 hover:bg-orange-100 dark:text-orange-300 dark:hover:bg-orange-900/30"
                >
                  <X size={11} /> Cancel
                </button>
              )}
            </div>
          )}

          {/* Stats once done */}
          {bulkDone && bulkResults.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2 text-xs">
              {(() => {
                const high = bulkResults.filter((r) => r.confidenceScore >= 90).length;
                const med = bulkResults.filter((r) => r.confidenceScore >= 70 && r.confidenceScore < 90).length;
                const low = bulkResults.filter((r) => r.confidenceScore < 70).length;
                const skipped = bulkProgress.total > bulkResults.length ? bulkProgress.total - bulkResults.length : 0;
                return (
                  <>
                    <span className="rounded-full bg-green-100 px-2 py-0.5 font-semibold text-green-700 dark:bg-green-900/40 dark:text-green-300">
                      {high} high confidence (≥90%)
                    </span>
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                      {med} medium (70–89%)
                    </span>
                    {low > 0 && (
                      <span className="rounded-full bg-red-100 px-2 py-0.5 font-semibold text-red-700 dark:bg-red-900/40 dark:text-red-300">
                        {low} low (&lt;70%)
                      </span>
                    )}
                    {skipped > 0 && (
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 font-semibold text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                        {skipped} skipped
                      </span>
                    )}
                  </>
                );
              })()}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {!bulkTranslating && !bulkDone && (
              <button
                type="button"
                onClick={startBulkTranslate}
                className="flex items-center gap-2 rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-50"
              >
                <Zap size={14} /> Start Bulk Translate
              </button>
            )}
            {bulkDone && bulkResults.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => applyBulkResults(0)}
                  className="flex items-center gap-2 rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700"
                >
                  <Save size={14} /> Stage All ({bulkResults.length})
                </button>
                <button
                  type="button"
                  onClick={() => applyBulkResults(70)}
                  className="flex items-center gap-2 rounded-lg border border-orange-400 px-4 py-2 text-sm font-medium text-orange-700 hover:bg-orange-100 dark:text-orange-300 dark:hover:bg-orange-900/30"
                >
                  Stage High/Medium only (≥70%)
                </button>
                <button
                  type="button"
                  onClick={() => applyBulkResults(90)}
                  className="flex items-center gap-2 rounded-lg border border-green-400 px-3 py-2 text-sm font-medium text-green-700 hover:bg-green-50 dark:text-green-300 dark:hover:bg-green-900/30"
                >
                  Stage High only (≥90%)
                </button>
                <button
                  type="button"
                  onClick={() => { setBulkResults([]); setBulkDone(false); setBulkProgress({ done: 0, total: 0 }); }}
                  className="text-sm text-orange-500 hover:text-orange-700 dark:text-orange-400"
                >
                  Clear
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="mb-4 space-y-3 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
        {/* Row 1: search + search-in scope + object type */}
        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-48 flex-1">
            <Search size={15} className="absolute top-1/2 left-3 -translate-y-1/2 text-gray-400" />
            <input
              className="w-full rounded-lg border border-gray-300 py-2 pr-3 pl-9 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white dark:placeholder-gray-500"
              placeholder="Search..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            />
          </div>

          {/* Search scope */}
          <div className="flex items-center gap-1">
            <span className="text-xs text-gray-400 dark:text-gray-600 whitespace-nowrap">in:</span>
            <select
              value={searchIn}
              onChange={(e) => { setSearchIn(e.target.value as typeof searchIn); setPage(1); }}
              className="rounded-lg border border-gray-300 bg-white py-2 px-2 text-sm text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
            >
              <option value="all">All fields</option>
              <option value="source">Source text</option>
              <option value="target">Target text</option>
              <option value="objectName">Object name</option>
            </select>
          </div>

          {/* Object Type filter */}
          <div className="flex items-center gap-1">
            <Filter size={14} className="shrink-0 text-gray-400 dark:text-gray-600" />
            <select
              value={objectType}
              onChange={(e) => { setObjectType(e.target.value); setPage(1); }}
              className="rounded-lg border border-gray-300 bg-white py-2 px-2 text-sm text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
            >
              <option value="">All Types</option>
              {BC_OBJECT_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>

          {/* Folder drop zone */}
          <input
            ref={folderInputRef}
            type="file"
            // @ts-expect-error — webkitdirectory is non-standard but widely supported
            webkitdirectory=""
            multiple
            className="hidden"
            onChange={handleFolderInput}
          />
          <button
            type="button"
            onClick={() => folderInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setFolderDragOver(true); }}
            onDragLeave={() => setFolderDragOver(false)}
            onDrop={handleFolderDrop}
            title="Drop a BC source folder (.al files) to filter by those objects"
            className={cn(
              'flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors',
              folderDragOver
                ? 'border-indigo-400 bg-indigo-50 text-indigo-700 dark:border-indigo-500 dark:bg-indigo-900/30 dark:text-indigo-300'
                : folderObjects.length > 0
                  ? 'border-violet-400 bg-violet-50 text-violet-700 dark:border-violet-500 dark:bg-violet-900/30 dark:text-violet-300'
                  : 'border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800'
            )}
          >
            <FolderOpen size={14} />
            {folderObjects.length > 0 ? `${folderObjects.length} objects` : 'AL Folder'}
          </button>

          {activeFilters > 0 && (
            <button
              onClick={clearFilters}
              className="flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-500 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
              title="Clear all filters"
            >
              <X size={14} /> Clear
            </button>
          )}
        </div>

        {/* Row 2: State filter pills */}
        <div className="flex flex-wrap gap-1">
          {(['untranslated', 'all', ...STATES] as const).map((state) => (
            <button
              key={state}
              onClick={() => { setFilterState(state); setPage(1); }}
              className={cn(
                'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                filterState === state
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'
              )}
            >
              {state === 'untranslated' ? 'Untranslated' : state === 'all' ? 'All' : getStateLabel(state)}
            </button>
          ))}
          {/* Quality Issues special filter */}
          <button
            onClick={() => { setFilterState('quality-issues'); setPage(1); }}
            className={cn(
              'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
              filterState === 'quality-issues'
                ? 'bg-amber-500 text-white'
                : 'bg-amber-50 text-amber-700 hover:bg-amber-100 dark:bg-amber-900/20 dark:text-amber-400 dark:hover:bg-amber-900/40'
            )}
          >
            <AlertTriangle size={11} />
            Quality Issues
          </button>
          {/* Show accepted issues toggle — only visible in quality-issues mode */}
          {filterState === 'quality-issues' && (
            <button
              onClick={() => setShowAcceptedIssues((v) => !v)}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                showAcceptedIssues
                  ? 'bg-gray-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700'
              )}
            >
              👁 {showAcceptedIssues ? 'Hide accepted' : 'Show accepted'}
            </button>
          )}
          {/* Since last sync filter — only show if file has been synced */}
          {currentFile?.lastSyncAt && (
            <button
              onClick={() => { setFilterState('since-last-sync'); setPage(1); }}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                filterState === 'since-last-sync'
                  ? 'bg-teal-600 text-white'
                  : 'bg-teal-50 text-teal-700 hover:bg-teal-100 dark:bg-teal-900/20 dark:text-teal-400 dark:hover:bg-teal-900/40'
              )}
            >
              🔄 Since last sync
              <span className="ml-0.5 opacity-70 text-[10px]">
                {new Date(currentFile.lastSyncAt).toLocaleDateString()}
              </span>
            </button>
          )}
        </div>

        {/* Row 3: AL folder object chips (only when folder loaded) */}
        {folderObjects.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 border-t border-gray-100 pt-3 dark:border-gray-800">
            <span className="text-xs text-gray-400 dark:text-gray-600 shrink-0">Showing objects:</span>
            {folderObjects.slice(0, 20).map((o) => (
              <span
                key={`${o.objectType}:${o.objectName}`}
                className="inline-flex items-center gap-1 rounded-md bg-violet-50 px-2 py-0.5 text-xs text-violet-700 dark:bg-violet-900/30 dark:text-violet-300"
              >
                <span className="opacity-60">{o.objectType}:</span>
                <span className="font-medium truncate max-w-[160px]">{o.objectName}</span>
                <button
                  type="button"
                  onClick={() => { setFolderObjects((prev) => prev.filter((x) => !(x.objectType === o.objectType && x.objectName === o.objectName))); setPage(1); }}
                  className="ml-0.5 opacity-50 hover:opacity-100"
                >
                  <X size={10} />
                </button>
              </span>
            ))}
            {folderObjects.length > 20 && (
              <span className="text-xs text-gray-400 dark:text-gray-600">+{folderObjects.length - 20} more</span>
            )}
            <button
              type="button"
              onClick={() => { setFolderObjects([]); setPage(1); }}
              className="ml-1 text-xs text-gray-400 hover:text-red-500 dark:text-gray-600 dark:hover:text-red-400"
            >
              Clear all
            </button>
          </div>
        )}

        {/* Row 3b: AL Analyser deep-link filter banner */}
        {folderObjects.length === 0 && initialObjectFilter && (
          <div className="flex items-center gap-2 border-t border-teal-100 pt-3 dark:border-teal-900/40">
            <BarChart2 size={13} className="shrink-0 text-teal-500" />
            <span className="text-xs text-teal-700 dark:text-teal-300">
              Filtered to: <span className="font-semibold">{initialObjectFilter}</span>
            </span>
            <span className="text-xs text-gray-400 dark:text-gray-600">(from AL Analyser)</span>
          </div>
        )}
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col className="w-8" />
            <col className="w-[195px]" />
            <col className="w-[28%]" />
            <col className="w-[33%]" />
            <col className="w-[135px]" />
          </colgroup>
          <thead className="border-b border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800/50">
            <tr>
              <th className="w-8 p-3">
                <input
                  type="checkbox"
                  checked={selected.size === translations.length && translations.length > 0}
                  onChange={toggleSelectAll}
                  className="rounded"
                />
              </th>
              <th className="p-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Context</th>
              <th className="p-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Source</th>
              <th className="p-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Target</th>
              <th className="p-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">State</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {isLoading ? (
              <tr><td colSpan={5} className="py-12 text-center text-gray-400 dark:text-gray-600">Loading...</td></tr>
            ) : translations.length === 0 ? (
              <tr><td colSpan={5} className="py-12 text-center text-gray-400 dark:text-gray-600">No translations match your filter</td></tr>
            ) : (
              translations.map((translation) => {
                const edit = edits.get(translation.id);
                const currentTarget = edit?.target ?? translation.target;
                const currentState = edit?.state ?? translation.state;
                const isEdited = Boolean(edit);
                const reviewResult = reviewResults.get(translation.id);
                const meta = parseXliffNote(translation.note);

                // Compute quality issues from current row data (client-side additions on top of server annotations)
                const qualityIssues: string[] = translation.qualityIssues ? [...translation.qualityIssues] : [];
                if (!qualityIssues.includes('ai-review') && currentState === 'needs-review-translation') qualityIssues.push('ai-review');
                // same-as-source is now detected server-side with sibling awareness
                const phRegex = /\{[\w\d]+\}|%\d+|\{\{[\w]+\}\}/g;
                const srcPh = (translation.source.match(phRegex) ?? []).sort();
                const tgtPh = (currentTarget.match(phRegex) ?? []).sort();
                if (srcPh.length > 0 && (srcPh.length !== tgtPh.length || srcPh.join() !== tgtPh.join())) {
                  if (!qualityIssues.includes('placeholder-mismatch')) qualityIssues.push('placeholder-mismatch');
                }
                const suppressed = translation.suppressedQualityIssues ?? [];
                // In quality-issues mode, skip rows where all issues are suppressed (unless showAcceptedIssues)
                if (filterState === 'quality-issues' && !showAcceptedIssues && qualityIssues.length === 0 && suppressed.length > 0) {
                  return null;
                }

                return (
                  <tr
                    key={translation.id}
                    className={cn(
                      'group',
                      isEdited
                        ? 'bg-yellow-50 dark:bg-yellow-900/10'
                        : reviewResult?.quality === 'error'
                          ? 'bg-red-50/40 dark:bg-red-900/10'
                          : reviewResult?.quality === 'warning'
                            ? 'bg-amber-50/40 dark:bg-amber-900/10'
                            : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'
                    )}
                  >
                    <td className="p-3">
                      <input type="checkbox" checked={selected.has(translation.id)} onChange={() => toggleSelect(translation.id)} className="rounded" />
                    </td>

                    {/* Context column: parsed metadata */}
                    <td className="align-top p-3">
                      {meta ? (
                        <div className="space-y-1">
                          <span className="inline-block rounded bg-indigo-50 px-1.5 py-0.5 text-xs font-semibold text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400">
                            {meta.objectType}
                          </span>
                          <p className="text-xs font-medium text-gray-800 dark:text-gray-200 break-words">{meta.objectName}</p>
                          {meta.memberType && meta.memberName && (
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                              <span className="text-gray-400 dark:text-gray-600">{meta.memberType}</span> {meta.memberName}
                            </p>
                          )}
                          {meta.property && (
                            <p className="text-xs text-gray-400 italic dark:text-gray-600">{meta.property}</p>
                          )}
                        </div>
                      ) : (
                        <span className="block truncate font-mono text-xs text-gray-400 dark:text-gray-600" title={translation.unitId}>
                          {translation.unitId}
                        </span>
                      )}
                      {translation.developerNote && (
                        <p className="mt-1 truncate text-xs text-amber-600 italic dark:text-amber-500" title={translation.developerNote}>
                          💬 {translation.developerNote}
                        </p>
                      )}
                    </td>

                    <td className="align-top p-3"
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setVsCtxMenu({ x: e.clientX, y: e.clientY, type: 'source', unitId: translation.unitId, note: translation.note });
                      }}
                    >
                      <p className="break-words whitespace-pre-wrap text-gray-800 dark:text-gray-200">{translation.source}</p>
                      {/* Sync change badges */}
                      {translation.syncChangeType && (
                        <div className="mt-1 flex items-center gap-1.5">
                          {translation.syncChangeType === 'added' && (
                            <span className="rounded-full bg-teal-100 px-2 py-0.5 text-[10px] font-semibold text-teal-700 dark:bg-teal-900/40 dark:text-teal-300">
                              🆕 New from repo
                            </span>
                          )}
                          {translation.syncChangeType === 'source-changed' && (
                            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                              ✏ Source updated
                            </span>
                          )}
                          {translation.syncChangeType === 'removed' && (
                            <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700 dark:bg-red-900/40 dark:text-red-300">
                              🗑 Removed from repo
                            </span>
                          )}
                          {translation.syncChangedAt && (
                            <span className="text-[10px] text-gray-400 dark:text-gray-600">
                              {new Date(translation.syncChangedAt).toLocaleDateString()}
                            </span>
                          )}
                        </div>
                      )}
                      {/* Quality issue badges */}
                      {(qualityIssues.length > 0 || (showAcceptedIssues && suppressed.length > 0)) && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {qualityIssues.map((issue) => {
                            const cfg: Record<string, { label: string; color: string }> = {
                              'ai-review':                { label: '🤖 AI review', color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300' },
                              'same-as-source':           { label: '≡ Same as source', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
                              'inconsistent-translation': { label: '⇄ Inconsistent', color: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300' },
                              'placeholder-mismatch':     { label: '⚠ Placeholder mismatch', color: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
                              'length-anomaly':           { label: '📏 Length anomaly', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' },
                            };
                            const c = cfg[issue] ?? { label: issue, color: 'bg-gray-100 text-gray-600' };
                            const variants = issue === 'inconsistent-translation' ? translation.qualityIssueMeta?.inconsistentVariants : undefined;
                            const tooltipText = variants ? variants.map(v => `${v.target} (×${v.count})`).join('\n') : undefined;
                            return (
                              <span
                                key={issue}
                                className={`group/badge relative rounded-full px-2 py-0.5 text-[10px] font-medium ${c.color}`}
                                title={tooltipText}
                              >
                                {c.label}
                                {variants && (
                                  <span className="pointer-events-none absolute bottom-full left-0 z-10 mb-1.5 hidden min-w-[160px] max-w-[300px] rounded-lg bg-gray-900 px-2.5 py-1.5 text-[10px] text-white shadow-lg group-hover/badge:block dark:bg-gray-700">
                                    <span className="font-semibold block mb-0.5">Conflicting translations:</span>
                                    {variants.map((v) => <span key={v.target} className="block">{v.target} (×{v.count})</span>)}
                                  </span>
                                )}
                              </span>
                            );
                          })}
                          {/* Accept buttons per active issue */}
                          {qualityIssues.filter(i => i !== 'ai-review').map((issue) => (
                            <button
                              key={`accept-${issue}`}
                              onClick={() => {
                                const next = [...suppressed, issue];
                                suppressIssueMutation.mutate({ id: translation.id, suppressedQualityIssues: next });
                              }}
                              className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500 hover:bg-green-100 hover:text-green-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-green-900/40 dark:hover:text-green-300"
                              title={`Accept this "${issue}" issue — won't appear in quality issues list`}
                            >
                              ✓ Accept
                            </button>
                          ))}
                          {/* Quick fix: approve AI review */}
                          {qualityIssues.includes('ai-review') && (
                            <button
                              onClick={() => handleEdit(translation.id, 'state', 'translated')}
                              className="rounded-full bg-teal-100 px-2 py-0.5 text-[10px] font-medium text-teal-700 hover:bg-teal-200 dark:bg-teal-900/40 dark:text-teal-300 dark:hover:bg-teal-900/70"
                            >
                              ✓ Approve
                            </button>
                          )}
                          {/* Quick fix: mark same-as-source as needs-translation for manual fix */}
                          {qualityIssues.includes('same-as-source') && !qualityIssues.includes('ai-review') && (
                            <button
                              onClick={() => handleEdit(translation.id, 'state', 'needs-translation')}
                              className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:hover:bg-amber-900/70"
                            >
                              Flag for retranslation
                            </button>
                          )}
                          {/* Accepted (suppressed) issues — shown when "Show accepted" is on */}
                          {showAcceptedIssues && suppressed.map((issue) => {
                            const cfg: Record<string, string> = {
                              'same-as-source':           '≡ Same as source',
                              'inconsistent-translation': '⇄ Inconsistent',
                              'placeholder-mismatch':     '⚠ Placeholder mismatch',
                              'length-anomaly':           '📏 Length anomaly',
                            };
                            return (
                              <span key={`sup-${issue}`} className="flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-400 line-through dark:bg-gray-800 dark:text-gray-600">
                                {cfg[issue] ?? issue}
                                <button
                                  onClick={() => {
                                    const next = suppressed.filter((i) => i !== issue);
                                    suppressIssueMutation.mutate({ id: translation.id, suppressedQualityIssues: next });
                                  }}
                                  className="ml-0.5 no-underline text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                                  title="Restore this issue"
                                  style={{ textDecoration: 'none' }}
                                >
                                  ↺
                                </button>
                              </span>
                            );
                          })}
                        </div>
                      )}
                      {reviewResults.has(translation.id) && (
                        <div className="mt-1.5">
                          <ReviewBadge
                            result={reviewResults.get(translation.id)!}
                            onApply={(suggestion) => {
                              handleEdit(translation.id, 'target', suggestion);
                              handleEdit(translation.id, 'state', 'needs-review-translation');
                            }}
                          />
                        </div>
                      )}
                    </td>

                    <td className="align-top p-3"
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setVsCtxMenu({ x: e.clientX, y: e.clientY, type: 'xliff', unitId: translation.unitId });
                      }}
                    >
                      <textarea
                        className={cn(
                          'min-h-[72px] w-full resize-y rounded-lg border px-2.5 py-2 text-sm leading-relaxed focus:ring-2 focus:ring-indigo-300 focus:outline-none',
                          isEdited
                            ? 'border-yellow-400 bg-yellow-50 dark:border-yellow-600 dark:bg-yellow-900/20 dark:text-white'
                            : 'border-gray-200 bg-white hover:border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:hover:border-gray-600'
                        )}
                        value={currentTarget}
                        rows={Math.max(2, Math.ceil(translation.source.length / 60))}
                        onChange={(e) => handleEdit(translation.id, 'target', e.target.value)}
                        onFocus={() => fetchTmForRow(translation)}
                        onBlur={() => {
                          if (currentTarget && currentState === 'needs-translation') {
                            handleEdit(translation.id, 'state', 'translated');
                          }
                        }}
                      />
                      {/* TM / AI suggestions below textarea */}
                      {(() => {
                        const tm = tmSuggestions.get(translation.id);
                        const isLoading = tmLoadingIds.has(translation.id);
                        const isAiLoading = singleAiIds.has(translation.id);
                        const hasTm = tm && tm.length > 0 && tm[0].score > 0;

                        if (isLoading) {
                          return (
                            <div className="mt-1.5 flex items-center gap-2 rounded-lg bg-gray-50 px-2 py-1.5 dark:bg-gray-700/40">
                              <div className="h-3 w-8 animate-pulse rounded bg-gray-200 dark:bg-gray-600" />
                              <div className="h-3 flex-1 animate-pulse rounded bg-gray-200 dark:bg-gray-600" />
                            </div>
                          );
                        }

                        if (hasTm) {
                          return (
                            <div className="mt-1.5 space-y-1">
                              {tm.map((suggestion, i) => {
                                const tmKey = `${translation.id}-${i}`;
                                const isExpanded = expandedTmKey === tmKey;
                                return (
                                  <div key={i}>
                                    <div
                                      className={cn(
                                        'flex cursor-pointer items-center gap-2 rounded-lg border px-2 py-1.5 transition-colors',
                                        isExpanded
                                          ? 'border-teal-400 bg-teal-50 dark:border-teal-600 dark:bg-teal-900/30'
                                          : 'border-teal-100 bg-teal-50/60 hover:border-teal-300 hover:bg-teal-50 dark:border-teal-800/40 dark:bg-teal-900/20 dark:hover:border-teal-700'
                                      )}
                                      onClick={() => setExpandedTmKey(isExpanded ? null : tmKey)}
                                    >
                                      <span className={cn(
                                        'shrink-0 rounded px-1.5 py-0.5 text-xs font-bold',
                                        suggestion.score === 1
                                          ? 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300'
                                          : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                                      )}>
                                        TM {Math.round(suggestion.score * 100)}%
                                      </span>
                                      {suggestion.usageCount > 1 && (
                                        <span className="shrink-0 rounded bg-gray-100 px-1 py-0.5 text-xs text-gray-500 dark:bg-gray-700 dark:text-gray-400" title={`Used ${suggestion.usageCount} times`}>
                                          ×{suggestion.usageCount}
                                        </span>
                                      )}
                                      <span className="min-w-0 flex-1 truncate text-xs text-gray-600 dark:text-gray-300" title={suggestion.target}>
                                        {suggestion.target}
                                      </span>
                                      {suggestion.sourceText !== translation.source && (
                                        <span className="shrink-0 text-xs italic text-gray-400 dark:text-gray-500" title={`TM matched from: "${suggestion.sourceText}"`}>
                                          from: {suggestion.sourceText.length > 20 ? suggestion.sourceText.slice(0, 20) + '…' : suggestion.sourceText}
                                        </span>
                                      )}
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleEdit(translation.id, 'target', suggestion.target);
                                          handleEdit(translation.id, 'state', 'translated');
                                        }}
                                        className="shrink-0 rounded bg-teal-100 px-2 py-0.5 text-xs font-medium text-teal-700 hover:bg-teal-200 dark:bg-teal-900/40 dark:text-teal-300 dark:hover:bg-teal-900/70"
                                      >
                                        Apply
                                      </button>
                                    </div>
                                    {/* Expanded detail panel */}
                                    {isExpanded && (
                                      <div className="rounded-b-lg border border-t-0 border-teal-300 bg-white px-3 py-2.5 dark:border-teal-700 dark:bg-gray-800/80">
                                        <div className="mb-2 space-y-1.5 text-xs">
                                          {suggestion.sourceText !== translation.source && (
                                            <div>
                                              <span className="font-medium text-gray-500 dark:text-gray-400">Matched from source: </span>
                                              <span className="text-gray-700 dark:text-gray-300">{suggestion.sourceText}</span>
                                            </div>
                                          )}
                                          <div>
                                            <span className="font-medium text-gray-500 dark:text-gray-400">Full suggestion: </span>
                                            <span className="font-medium text-gray-800 dark:text-gray-200">{suggestion.target}</span>
                                          </div>
                                        </div>
                                        <div className="flex gap-2">
                                          <button
                                            onClick={() => {
                                              handleEdit(translation.id, 'target', suggestion.target);
                                              handleEdit(translation.id, 'state', 'translated');
                                              setExpandedTmKey(null);
                                            }}
                                            className="rounded bg-teal-100 px-2.5 py-1 text-xs font-medium text-teal-700 hover:bg-teal-200 dark:bg-teal-900/40 dark:text-teal-300 dark:hover:bg-teal-900/70"
                                          >
                                            Apply to this row
                                          </button>
                                          <button
                                            onClick={() => applyToSourceMutation.mutate({ source: translation.source, target: suggestion.target })}
                                            disabled={applyToSourceMutation.isPending}
                                            className="rounded bg-indigo-100 px-2.5 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-200 disabled:opacity-50 dark:bg-indigo-900/40 dark:text-indigo-300 dark:hover:bg-indigo-900/70"
                                          >
                                            {applyToSourceMutation.isPending ? 'Applying…' : `Apply to all with same source`}
                                          </button>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                              {/* Conflict variants not in TM — shown when row has inconsistent-translation issue */}
                              {(() => {
                                const variants = translation.qualityIssueMeta?.inconsistentVariants;
                                if (!variants || variants.length <= 1) return null;
                                const tmTargets = new Set(tm.map((s) => s.target));
                                const missing = variants.filter((v) => !tmTargets.has(v.target));
                                if (missing.length === 0) return null;
                                return (
                                  <>
                                    <div className="pt-0.5 text-[10px] font-medium text-orange-500 dark:text-orange-400">
                                      Also used for this source (not in TM):
                                    </div>
                                    {missing.map((v) => (
                                      <div key={v.target} className="flex items-center gap-2 rounded-lg border border-orange-200 bg-orange-50/60 px-2 py-1.5 dark:border-orange-800/40 dark:bg-orange-900/20">
                                        <span className="shrink-0 rounded bg-orange-100 px-1.5 py-0.5 text-xs font-bold text-orange-700 dark:bg-orange-900/40 dark:text-orange-300">
                                          ⇄ ×{v.count}
                                        </span>
                                        <span className="min-w-0 flex-1 truncate text-xs text-gray-600 dark:text-gray-300" title={v.target}>
                                          {v.target}
                                        </span>
                                        <button
                                          onClick={() => {
                                            handleEdit(translation.id, 'target', v.target);
                                            handleEdit(translation.id, 'state', 'translated');
                                          }}
                                          className="shrink-0 rounded bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700 hover:bg-orange-200 dark:bg-orange-900/40 dark:text-orange-300 dark:hover:bg-orange-900/60"
                                        >
                                          Use
                                        </button>
                                        <button
                                          onClick={() => applyToSourceMutation.mutate({ source: translation.source, target: v.target })}
                                          disabled={applyToSourceMutation.isPending}
                                          className="shrink-0 rounded bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700 hover:bg-indigo-200 disabled:opacity-50 dark:bg-indigo-900/40 dark:text-indigo-300"
                                          title="Apply this variant to all translations with the same source"
                                        >
                                          Use for all
                                        </button>
                                      </div>
                                    ))}
                                  </>
                                );
                              })()}
                            </div>
                          );
                        }

                        // No TM match — show conflict variants if available (inconsistent row not yet focused for TM)
                        {
                          const variants = translation.qualityIssueMeta?.inconsistentVariants;
                          if (variants && variants.length > 1) {
                            return (
                              <div className="mt-1.5 space-y-1">
                                <div className="text-[10px] font-medium text-orange-500 dark:text-orange-400">
                                  Conflicting variants used for this source:
                                </div>
                                {variants.map((v) => (
                                  <div key={v.target} className="flex items-center gap-2 rounded-lg border border-orange-200 bg-orange-50/60 px-2 py-1.5 dark:border-orange-800/40 dark:bg-orange-900/20">
                                    <span className="shrink-0 rounded bg-orange-100 px-1.5 py-0.5 text-xs font-bold text-orange-700 dark:bg-orange-900/40 dark:text-orange-300">
                                      ⇄ ×{v.count}
                                    </span>
                                    <span className="min-w-0 flex-1 truncate text-xs text-gray-600 dark:text-gray-300" title={v.target}>
                                      {v.target}
                                    </span>
                                    <button
                                      onClick={() => {
                                        handleEdit(translation.id, 'target', v.target);
                                        handleEdit(translation.id, 'state', 'translated');
                                      }}
                                      className="shrink-0 rounded bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700 hover:bg-orange-200 dark:bg-orange-900/40 dark:text-orange-300 dark:hover:bg-orange-900/60"
                                    >
                                      Use
                                    </button>
                                    <button
                                      onClick={() => applyToSourceMutation.mutate({ source: translation.source, target: v.target })}
                                      disabled={applyToSourceMutation.isPending}
                                      className="shrink-0 rounded bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700 hover:bg-indigo-200 disabled:opacity-50 dark:bg-indigo-900/40 dark:text-indigo-300"
                                      title="Apply this variant to all translations with the same source"
                                    >
                                      Use for all
                                    </button>
                                  </div>
                                ))}
                              </div>
                            );
                          }
                        }

                        // No TM match — show AI quick-translate button if untranslated
                        if (!currentTarget || currentState === 'needs-translation') {
                          return (
                            <button
                              onClick={() => aiTranslateSingle(translation)}
                              disabled={isAiLoading}
                              className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-lg border border-purple-200 bg-purple-50/60 px-2 py-1 text-xs font-medium text-purple-600 hover:bg-purple-100 disabled:opacity-50 dark:border-purple-800/40 dark:bg-purple-900/20 dark:text-purple-400 dark:hover:bg-purple-900/40"
                            >
                              <Sparkles size={11} />
                              {isAiLoading ? 'Translating…' : 'AI Translate'}
                            </button>
                          );
                        }

                        return null;
                      })()}
                    </td>

                    <td className="align-top p-3">
                      <StateDropdown
                        value={currentState}
                        onChange={(s) => handleEdit(translation.id, 'state', s)}
                      />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>

        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800/50">
            <span className="text-sm text-gray-500 dark:text-gray-400">
              Page {page} of {totalPages} ({total} total)
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((c) => Math.max(1, c - 1))}
                disabled={page === 1}
                className="rounded border border-gray-300 p-1.5 text-gray-600 hover:bg-white disabled:opacity-40 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
              >
                <ChevronLeft size={16} />
              </button>
              <button
                onClick={() => setPage((c) => Math.min(totalPages, c + 1))}
                disabled={page === totalPages}
                className="rounded border border-gray-300 p-1.5 text-gray-600 hover:bg-white disabled:opacity-40 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>

    {showCommitModal && currentFile?.remoteRepo && (
      (() => {
        const repoParts = currentFile.remoteRepo.split('/');
        const isAdo = repoParts.length >= 3;
        const adoProject = isAdo ? repoParts[repoParts.length - 2] : '';
        const repoId = repoParts[repoParts.length - 1];
        const githubOwner = !isAdo ? repoParts[0] : undefined;
        const githubRepo = !isAdo ? repoParts[1] : undefined;
        return (
          <CommitModal
            projectId={projectId}
            file={{
              id: currentFile.id,
              filename: currentFile.filename,
              remoteConnectionId: currentFile.remoteConnectionId,
              remotePath: currentFile.remotePath,
              remoteBranch: currentFile.remoteBranch,
              remoteRepo: currentFile.remoteRepo,
              remotePrId: currentFile.remotePrId ?? null,
              remotePrUrl: currentFile.remotePrUrl ?? null,
            }}
            adoProject={adoProject}
            repoId={repoId}
            isAdo={isAdo}
            githubOwner={githubOwner}
            githubRepo={githubRepo}
            onDone={() => { setShowCommitModal(false); }}
            onClose={() => setShowCommitModal(false)}
          />
        );
      })()
    )}
    {/* Push as PR dialog */}
    {showPushPrDialog && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900">
          <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4 dark:border-gray-800">
            <div className="flex items-center gap-2">
              <GitPullRequest size={16} className="text-green-600 dark:text-green-400" />
              <h2 className="font-semibold text-gray-900 dark:text-white">Push Translations as PR</h2>
            </div>
            <button onClick={() => setShowPushPrDialog(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
              <X size={18} />
            </button>
          </div>
          <div className="space-y-4 p-5">
            {pushPrResult ? (
              <div className="rounded-lg border border-green-200 bg-green-50 p-4 dark:border-green-800 dark:bg-green-900/20">
                <p className="mb-1 text-sm font-semibold text-green-800 dark:text-green-300">
                  ✓ PR #{pushPrResult.prId} created on branch <code className="rounded bg-green-100 px-1 dark:bg-green-900/40">{pushPrResult.branchName}</code>
                </p>
                {pushPrResult.prUrl && (
                  <a
                    href={pushPrResult.prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm text-green-700 hover:underline dark:text-green-400"
                  >
                    <ExternalLink size={13} /> Open Pull Request
                  </a>
                )}
              </div>
            ) : (
              <>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">New branch name</label>
                  <input
                    type="text"
                    value={pushPrBranchName}
                    onChange={(e) => setPushPrBranchName(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                    placeholder="translations/update-..."
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">PR title</label>
                  <input
                    type="text"
                    value={pushPrTitle}
                    onChange={(e) => setPushPrTitle(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                    placeholder="Update translations in..."
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">Target branch (merge into)</label>
                  <input
                    type="text"
                    value={pushPrTargetBranch}
                    onChange={(e) => setPushPrTargetBranch(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                    placeholder="main"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">PR description <span className="font-normal text-gray-400">(optional)</span></label>
                  <textarea
                    rows={2}
                    value={pushPrDescription}
                    onChange={(e) => setPushPrDescription(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                    placeholder="Automated translation update..."
                  />
                </div>
              </>
            )}
          </div>
          <div className="flex justify-end gap-2 border-t border-gray-100 px-5 py-4 dark:border-gray-800">
            <button
              onClick={() => setShowPushPrDialog(false)}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800"
            >
              {pushPrResult ? 'Close' : 'Cancel'}
            </button>
            {!pushPrResult && (
              <button
                onClick={doPushAsPr}
                disabled={pushPrLoading}
                className="flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
              >
                {pushPrLoading ? <><Loader2 size={14} className="animate-spin" /> Creating PR…</> : <><GitPullRequest size={14} /> Create PR</>}
              </button>
            )}
          </div>
        </div>
      </div>
    )}
    {/* VS Code context menu */}
    {vsCtxMenu && (
      <>
        <div className="fixed inset-0 z-40" onClick={() => setVsCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setVsCtxMenu(null); }} />
        <div
          className="fixed z-50 min-w-[220px] rounded-lg border border-gray-200 bg-white py-1 shadow-xl dark:border-gray-700 dark:bg-gray-900"
          style={{ top: vsCtxMenu.y, left: vsCtxMenu.x }}
        >
          <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-600">
            VS Code
          </div>
          {!localWorkspacePath ? (
            <div className="px-3 py-2">
              <p className="text-xs text-amber-600 dark:text-amber-400">⚙ No workspace path configured.</p>
              <a
                href={`/projects/${projectId}`}
                className="mt-1 block text-xs text-indigo-600 hover:underline dark:text-indigo-400"
                onClick={() => setVsCtxMenu(null)}
              >
                Go to Setup → VS Code Navigation
              </a>
            </div>
          ) : vsCtxMenu.type === 'source' ? (
            <button
              onClick={() => openVsCode('source', vsCtxMenu.unitId, vsCtxMenu.note)}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-indigo-50 hover:text-indigo-700 dark:text-gray-200 dark:hover:bg-indigo-900/30 dark:hover:text-indigo-300"
            >
              <span>🔍</span> Open Source in VS Code
            </button>
          ) : (
            <button
              onClick={() => openVsCode('xliff', vsCtxMenu.unitId)}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-indigo-50 hover:text-indigo-700 dark:text-gray-200 dark:hover:bg-indigo-900/30 dark:hover:text-indigo-300"
            >
              <span>📄</span> Open XLIFF in VS Code
            </button>
          )}
          <button
            onClick={() => setVsCtxMenu(null)}
            className="flex w-full items-center gap-2.5 border-t border-gray-100 px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-50 dark:border-gray-800 dark:text-gray-600 dark:hover:bg-gray-800"
          >
            Cancel
          </button>
        </div>
      </>
    )}
    </>
  );
}
