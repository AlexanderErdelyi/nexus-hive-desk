'use client';

import { useCallback, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, ChevronRight, Download, Filter, FolderOpen, RotateCcw, Save, Search, Sparkles, Upload, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useDropzone } from 'react-dropzone';
import { toast } from 'sonner';
import type { TranslationState } from '@nexus/types';
import { api } from '@/lib/api';
import { cn, getStateColor, getStateLabel } from '@/lib/utils';

interface Translation {
  id: string;
  unitId: string;
  source: string;
  target: string;
  state: TranslationState;
  note?: string;
  developerNote?: string;
}

interface XliffFileInfo {
  id: string;
  filename: string;
  sourceLanguage: string;
  targetLanguage: string;
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

export function TranslationEditor({ projectId, xliffFileId }: { projectId: string; xliffFileId?: string }) {
  const qc = useQueryClient();
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [searchIn, setSearchIn] = useState<'all' | 'source' | 'target' | 'objectName'>('all');
  const [filterState, setFilterState] = useState<TranslationState | 'all' | 'untranslated'>('untranslated');
  const [objectType, setObjectType] = useState('');
  const [folderObjects, setFolderObjects] = useState<AlObject[]>([]);
  const [folderDragOver, setFolderDragOver] = useState(false);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [page, setPage] = useState(1);
  const [edits, setEdits] = useState<Map<string, { target: string; state: TranslationState }>>(new Map());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [aiTranslating, setAiTranslating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [reviewResults, setReviewResults] = useState<Map<string, { quality: string; suggestion?: string; reason?: string }>>(new Map());
  const [reviewContext, setReviewContext] = useState('');
  const [showReviewPanel, setShowReviewPanel] = useState(false);
  const [aiReviewing, setAiReviewing] = useState(false);

  const { data: projectData } = useQuery({
    queryKey: ['project-files', projectId],
    queryFn: () => api.get<{ data: { xliffFiles: XliffFileInfo[] } }>(`/api/projects/${projectId}`),
  });
  const currentFile = projectData?.data.xliffFiles.find((f) => f.id === xliffFileId);

  const objectFilters = folderObjects.map((o) => `${o.objectType} ${o.objectName}`).join(',');

  const queryParams = new URLSearchParams({
    projectId,
    ...(xliffFileId ? { xliffFileId } : {}),
    ...(filterState === 'untranslated'
      ? { untranslatedOnly: 'true' }
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

  const translations = data?.data ?? [];
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
                className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                <Save size={15} /> {saveMutation.isPending ? 'Saving...' : `Save (${edits.size})`}
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

                    <td className="align-top p-3">
                      <p className="break-words whitespace-pre-wrap text-gray-800 dark:text-gray-200">{translation.source}</p>
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

                    <td className="align-top p-3">
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
                        onBlur={() => {
                          if (currentTarget && currentState === 'needs-translation') {
                            handleEdit(translation.id, 'state', 'translated');
                          }
                        }}
                      />
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
  );
}
