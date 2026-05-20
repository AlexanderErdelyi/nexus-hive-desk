'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookOpen,
  ExternalLink,
  FilePlus2,
  Loader2,
  PencilLine,
  RefreshCw,
  Search,
  Settings2,
  Wifi,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';

interface DocumentationViewProps {
  projectId: string;
  customerId?: string | null;
}

interface McpConnection {
  id: string;
  name: string;
  type: string;
  baseUrl?: string;
  customerId?: string | null;
  projectId?: string | null;
}

interface WikiPageSummary {
  id?: string | number;
  path: string;
  title: string;
  description?: string;
  url?: string;
  locale?: string;
  updatedAt?: string;
}

interface WikiPage extends WikiPageSummary {
  found?: boolean;
  content: string;
  tags: string[];
}

interface WikiPageDraft {
  path: string;
  title: string;
  content: string;
  locale: string;
  description: string;
  tags: string;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Request failed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getString(value: Record<string, unknown>, keys: string[], fallback = '') {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return fallback;
}

function normalizeSearchResults(data: unknown): WikiPageSummary[] {
  if (Array.isArray(data)) {
    return data.filter(isRecord).map((item) => ({
      id: getString(item, ['id']),
      path: getString(item, ['path', 'slug']),
      title: getString(item, ['title', 'name'], getString(item, ['path', 'slug'])),
      description: getString(item, ['description']),
      url: getString(item, ['url']),
      locale: getString(item, ['locale']),
      updatedAt: getString(item, ['updatedAt']),
    })).filter((item) => item.path);
  }

  if (isRecord(data)) {
    const nested = data.results ?? data.pages ?? data.items;
    if (Array.isArray(nested)) return normalizeSearchResults(nested);
    if (typeof data.path === 'string') {
      return [{
        id: getString(data, ['id']),
        path: getString(data, ['path', 'slug']),
        title: getString(data, ['title', 'name'], getString(data, ['path', 'slug'])),
        description: getString(data, ['description']),
        url: getString(data, ['url']),
        locale: getString(data, ['locale']),
        updatedAt: getString(data, ['updatedAt']),
      }];
    }
  }

  return [];
}

function normalizePage(data: unknown): WikiPage | null {
  const record = Array.isArray(data) ? data.find(isRecord) : isRecord(data) ? data : null;
  if (!record) return null;

  const tagsValue = record.tags;
  const tags = Array.isArray(tagsValue)
    ? tagsValue.map((tag) => String(tag).trim()).filter(Boolean)
    : typeof tagsValue === 'string'
      ? tagsValue.split(',').map((tag) => tag.trim()).filter(Boolean)
      : [];

  return {
    id: record.id as string | number | undefined,
    path: getString(record, ['path', 'slug']),
    title: getString(record, ['title', 'name'], getString(record, ['path', 'slug'])),
    description: getString(record, ['description']),
    url: getString(record, ['url']),
    locale: getString(record, ['locale'], 'de'),
    updatedAt: getString(record, ['updatedAt']),
    content: getString(record, ['content', 'markdown', 'body']),
    found: typeof record.found === 'boolean' ? record.found : true,
    tags,
  };
}

function buildWikiPagesUrl(mcpId: string, params: Record<string, string>) {
  const search = new URLSearchParams(params);
  return `/api/mcp-connections/${mcpId}/wiki-pages?${search.toString()}`;
}

function rememberPage(list: WikiPageSummary[], page: WikiPageSummary) {
  const next = [page, ...list.filter((entry) => entry.path !== page.path)];
  return next.slice(0, 8);
}

export function DocumentationView({ projectId, customerId }: DocumentationViewProps) {
  const queryClient = useQueryClient();
  const [selectedMcpId, setSelectedMcpId] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedPath, setSelectedPath] = useState('');
  const [activeLocale, setActiveLocale] = useState<'de' | 'en'>('de');
  const [isEditing, setIsEditing] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [recentPages, setRecentPages] = useState<WikiPageSummary[]>([]);
  const [draft, setDraft] = useState<WikiPageDraft>({
    path: `projects/${projectId}`,
    title: '',
    content: '',
    locale: 'de',
    description: '',
    tags: '',
  });

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedSearch(searchTerm.trim()), 400);
    return () => window.clearTimeout(timeout);
  }, [searchTerm]);

  const connectionsQuery = useQuery({
    queryKey: ['mcp-connections', 'wiki-js'],
    queryFn: () => api.get<{ data: McpConnection[] }>('/api/mcp-connections?type=wiki_js'),
  });

  const wikiConnections = useMemo(() => {
    const connections = connectionsQuery.data?.data ?? [];
    const scoped = connections.filter((connection) => {
      if (connection.projectId && connection.projectId !== projectId) return false;
      if (connection.customerId && connection.customerId !== customerId) return false;
      return true;
    });
    return scoped.length > 0 ? scoped : connections;
  }, [connectionsQuery.data, customerId, projectId]);

  useEffect(() => {
    if (!selectedMcpId && wikiConnections[0]?.id) {
      setSelectedMcpId(wikiConnections[0].id);
    }
    if (selectedMcpId && !wikiConnections.some((connection) => connection.id === selectedMcpId)) {
      setSelectedMcpId(wikiConnections[0]?.id ?? '');
    }
  }, [selectedMcpId, wikiConnections]);

  const selectedConnection = wikiConnections.find((connection) => connection.id === selectedMcpId);

  const searchQuery = useQuery({
    queryKey: ['wiki-pages-search', selectedMcpId, debouncedSearch, activeLocale],
    enabled: Boolean(selectedMcpId && debouncedSearch),
    queryFn: () => api.get<{ data: unknown }>(buildWikiPagesUrl(selectedMcpId, { query: debouncedSearch, locale: activeLocale })),
  });

  const pageQuery = useQuery({
    queryKey: ['wiki-page', selectedMcpId, selectedPath, activeLocale],
    enabled: Boolean(selectedMcpId && selectedPath),
    queryFn: () => api.get<{ data: unknown }>(buildWikiPagesUrl(selectedMcpId, { path: selectedPath, locale: activeLocale })),
  });

  const currentPage = useMemo(() => normalizePage(pageQuery.data?.data), [pageQuery.data?.data]);

  useEffect(() => {
    if (!currentPage || isEditing || isCreating) return;
    setDraft({
      path: currentPage.path,
      title: currentPage.title,
      content: currentPage.content,
      locale: currentPage.locale || activeLocale,
      description: currentPage.description ?? '',
      tags: currentPage.tags.join(', '),
    });
    if (currentPage.locale === 'de' || currentPage.locale === 'en') {
      setActiveLocale(currentPage.locale);
    }
  }, [activeLocale, currentPage, isCreating, isEditing]);

  useEffect(() => {
    if (connectionsQuery.error) toast.error(getErrorMessage(connectionsQuery.error));
  }, [connectionsQuery.error]);

  useEffect(() => {
    if (searchQuery.error) toast.error(getErrorMessage(searchQuery.error));
  }, [searchQuery.error]);

  useEffect(() => {
    if (pageQuery.error) toast.error(getErrorMessage(pageQuery.error));
  }, [pageQuery.error]);

  const saveMutation = useMutation({
    mutationFn: (input: WikiPageDraft) => api.post<{ data: unknown }>(`/api/mcp-connections/${selectedMcpId}/wiki-pages`, {
      path: input.path.trim(),
      title: input.title.trim(),
      content: input.content,
      locale: input.locale,
      description: input.description.trim(),
      tags: input.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
    }),
    onSuccess: async (_result, input) => {
      const rememberedPage = {
        path: input.path.trim(),
        title: input.title.trim(),
        locale: input.locale,
      };
      setRecentPages((previous) => rememberPage(previous, rememberedPage));
      setSelectedPath(input.path.trim());
      setSearchTerm('');
      setDebouncedSearch('');
      setIsCreating(false);
      setIsEditing(false);
      await queryClient.invalidateQueries({ queryKey: ['wiki-pages-search', selectedMcpId] });
      await queryClient.invalidateQueries({ queryKey: ['wiki-page', selectedMcpId, input.path.trim(), input.locale] });
      toast.success('Page saved to Wiki.js');
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const searchResults = normalizeSearchResults(searchQuery.data?.data);
  const rootSuggestions = useMemo<WikiPageSummary[]>(() => ([
    { path: 'home', title: 'Home', description: 'Wiki.js home page', locale: activeLocale },
    { path: `projects/${projectId}`, title: 'Project root', description: 'Suggested project root path', locale: activeLocale },
    { path: `projects/${projectId}/runbooks`, title: 'Runbooks', description: 'Suggested runbook section', locale: activeLocale },
  ]), [activeLocale, projectId]);
  const browseItems = recentPages.length > 0 ? recentPages : rootSuggestions;
  const listItems = debouncedSearch ? searchResults : browseItems;

  function openPage(page: WikiPageSummary) {
    setSelectedPath(page.path);
    setActiveLocale(page.locale === 'en' ? 'en' : 'de');
    setIsCreating(false);
    setIsEditing(false);
    setRecentPages((previous) => rememberPage(previous, page));
  }

  function startNewPage() {
    setIsCreating(true);
    setIsEditing(true);
    setSelectedPath('');
    setDraft({
      path: `projects/${projectId}`,
      title: '',
      content: '',
      locale: activeLocale,
      description: '',
      tags: '',
    });
  }

  if (connectionsQuery.isLoading) {
    return <div className="py-12 text-center text-gray-400 dark:text-gray-600">Loading documentation…</div>;
  }

  if (wikiConnections.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-gray-200 bg-white p-10 text-center dark:border-gray-700 dark:bg-gray-900">
        <BookOpen size={40} className="mx-auto mb-4 text-emerald-400 dark:text-emerald-600" />
        <h3 className="mb-2 text-lg font-semibold text-gray-900 dark:text-white">No Wiki.js connection configured</h3>
        <p className="mx-auto max-w-md text-sm text-gray-500 dark:text-gray-400">
          Create a Wiki.js MCP connection in Agents settings, then come back here to browse and edit documentation.
        </p>
        <Link
          href="/agents"
          className="mt-6 inline-flex items-center gap-2 rounded-lg bg-indigo-50 px-4 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:text-indigo-300"
        >
          <Settings2 size={15} /> Open Agents Settings
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Documentation</h2>
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
              <Wifi size={12} /> Sync with Wiki
            </span>
          </div>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Browse, create and edit Wiki.js pages directly from NexusHiveDesk.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <select
            className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 focus:border-indigo-400 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-white"
            value={selectedMcpId}
            onChange={(event) => {
              setSelectedMcpId(event.target.value);
              setSelectedPath('');
              setIsCreating(false);
              setIsEditing(false);
            }}
          >
            {wikiConnections.map((connection) => (
              <option key={connection.id} value={connection.id}>{connection.name}</option>
            ))}
          </select>
          <button
            onClick={startNewPage}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            <FilePlus2 size={15} /> New Page
          </button>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <div className="mb-4 flex items-center justify-between gap-2">
            <div className="relative flex-1">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                className="w-full rounded-xl border border-gray-200 bg-gray-50 py-2 pl-9 pr-3 text-sm text-gray-900 placeholder-gray-400 focus:border-indigo-400 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-white dark:placeholder-gray-500"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search wiki pages..."
              />
            </div>
            <button
              onClick={() => {
                setSearchTerm('');
                setDebouncedSearch('');
              }}
              className="rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              Browse
            </button>
          </div>

          <div className="mb-4 flex items-center justify-between rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500 dark:border-gray-700 dark:bg-gray-800/70 dark:text-gray-400">
            <span>{selectedConnection?.name ?? 'Wiki.js connection'}</span>
            <select
              className="bg-transparent text-xs focus:outline-none"
              value={activeLocale}
              onChange={(event) => setActiveLocale(event.target.value as 'de' | 'en')}
            >
              <option value="de">DE</option>
              <option value="en">EN</option>
            </select>
          </div>

          <div className="space-y-2">
            {searchQuery.isFetching && debouncedSearch ? (
              <div className="flex items-center gap-2 rounded-xl border border-gray-200 px-3 py-3 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                <Loader2 size={14} className="animate-spin" /> Searching Wiki.js…
              </div>
            ) : listItems.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-200 px-3 py-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                No pages found for this search.
              </div>
            ) : (
              listItems.map((page) => (
                <button
                  key={`${page.path}-${page.locale ?? 'de'}`}
                  onClick={() => openPage(page)}
                  className={`w-full rounded-xl border px-3 py-3 text-left transition-colors ${
                    selectedPath === page.path
                      ? 'border-indigo-300 bg-indigo-50 dark:border-indigo-700 dark:bg-indigo-900/20'
                      : 'border-gray-200 hover:border-indigo-200 hover:bg-gray-50 dark:border-gray-700 dark:hover:border-indigo-800 dark:hover:bg-gray-800'
                  }`}
                >
                  <div className="truncate text-sm font-medium text-gray-900 dark:text-white">{page.title}</div>
                  <div className="mt-1 truncate text-xs text-gray-500 dark:text-gray-400">{page.path}</div>
                  {page.description && (
                    <div className="mt-2 line-clamp-2 text-xs text-gray-500 dark:text-gray-400">{page.description}</div>
                  )}
                </button>
              ))
            )}
          </div>
        </aside>

        <section className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
          {isCreating ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Create new page</h3>
                  <p className="text-sm text-gray-500 dark:text-gray-400">Write markdown and save it directly to Wiki.js.</p>
                </div>
                <button
                  onClick={() => {
                    setIsCreating(false);
                    setIsEditing(false);
                  }}
                  className="rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                  Cancel
                </button>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Path</label>
                  <input
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 focus:border-indigo-400 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                    value={draft.path}
                    onChange={(event) => setDraft((current) => ({ ...current, path: event.target.value }))}
                    placeholder={`projects/${projectId}/overview`}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Title</label>
                  <input
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 focus:border-indigo-400 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                    value={draft.title}
                    onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                    placeholder="Architecture overview"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Locale</label>
                  <select
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 focus:border-indigo-400 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                    value={draft.locale}
                    onChange={(event) => setDraft((current) => ({ ...current, locale: event.target.value }))}
                  >
                    <option value="de">de</option>
                    <option value="en">en</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Tags</label>
                  <input
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 focus:border-indigo-400 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                    value={draft.tags}
                    onChange={(event) => setDraft((current) => ({ ...current, tags: event.target.value }))}
                    placeholder="architecture, project"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Description</label>
                <input
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 focus:border-indigo-400 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                  value={draft.description}
                  onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
                  placeholder="Short summary shown in search results"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Content</label>
                <textarea
                  className="min-h-[320px] w-full rounded-2xl border border-gray-200 bg-gray-50 px-3 py-3 text-sm text-gray-900 focus:border-indigo-400 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                  value={draft.content}
                  onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))}
                  placeholder="# Overview"
                />
              </div>

              <button
                onClick={() => saveMutation.mutate(draft)}
                disabled={!draft.path.trim() || !draft.title.trim() || saveMutation.isPending}
                className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {saveMutation.isPending ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
                Save to Wiki
              </button>
            </div>
          ) : pageQuery.isLoading ? (
            <div className="flex min-h-[420px] items-center justify-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <Loader2 size={16} className="animate-spin" /> Loading page…
            </div>
          ) : currentPage ? (
            currentPage.found === false ? (
              <div className="flex min-h-[420px] flex-col items-center justify-center text-center">
                <BookOpen size={42} className="mb-4 text-amber-400 dark:text-amber-600" />
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Page not found</h3>
                <p className="mt-2 max-w-md text-sm text-gray-500 dark:text-gray-400">
                  The selected path does not exist in Wiki.js for locale {activeLocale}. You can create it as a new page.
                </p>
              </div>
            ) : (
            <div className="space-y-5">
              <div className="flex flex-col gap-3 border-b border-gray-100 pb-4 dark:border-gray-800 md:flex-row md:items-start md:justify-between">
                <div>
                  <h3 className="text-xl font-semibold text-gray-900 dark:text-white">{currentPage.title}</h3>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                    <span className="rounded-full bg-gray-100 px-2.5 py-1 dark:bg-gray-800">{currentPage.path}</span>
                    <span className="rounded-full bg-gray-100 px-2.5 py-1 dark:bg-gray-800">Locale: {currentPage.locale || activeLocale}</span>
                    {currentPage.updatedAt && (
                      <span className="rounded-full bg-gray-100 px-2.5 py-1 dark:bg-gray-800">Updated: {currentPage.updatedAt}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {currentPage.url && (
                    <a
                      href={currentPage.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    >
                      <ExternalLink size={14} /> Open Wiki
                    </a>
                  )}
                  <button
                    onClick={() => {
                      setDraft({
                        path: currentPage.path,
                        title: currentPage.title,
                        content: currentPage.content,
                        locale: currentPage.locale || activeLocale,
                        description: currentPage.description ?? '',
                        tags: currentPage.tags.join(', '),
                      });
                      setIsEditing(true);
                    }}
                    className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
                  >
                    <PencilLine size={15} /> Edit
                  </button>
                </div>
              </div>

              {isEditing ? (
                <div className="space-y-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Path</label>
                      <input
                        className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 focus:border-indigo-400 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                        value={draft.path}
                        onChange={(event) => setDraft((current) => ({ ...current, path: event.target.value }))}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Title</label>
                      <input
                        className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 focus:border-indigo-400 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                        value={draft.title}
                        onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Locale</label>
                      <select
                        className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 focus:border-indigo-400 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                        value={draft.locale}
                        onChange={(event) => setDraft((current) => ({ ...current, locale: event.target.value }))}
                      >
                        <option value="de">de</option>
                        <option value="en">en</option>
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Tags</label>
                      <input
                        className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 focus:border-indigo-400 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                        value={draft.tags}
                        onChange={(event) => setDraft((current) => ({ ...current, tags: event.target.value }))}
                      />
                    </div>
                  </div>

                  <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Description</label>
                    <input
                      className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 focus:border-indigo-400 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                      value={draft.description}
                      onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Content</label>
                    <textarea
                      className="min-h-[340px] w-full rounded-2xl border border-gray-200 bg-gray-50 px-3 py-3 text-sm text-gray-900 focus:border-indigo-400 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                      value={draft.content}
                      onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))}
                    />
                  </div>

                  <div className="flex flex-wrap gap-3">
                    <button
                      onClick={() => saveMutation.mutate(draft)}
                      disabled={!draft.path.trim() || !draft.title.trim() || saveMutation.isPending}
                      className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                    >
                      {saveMutation.isPending ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
                      Save to Wiki
                    </button>
                    <button
                      onClick={() => setIsEditing(false)}
                      className="rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {currentPage.description && (
                    <p className="text-sm text-gray-500 dark:text-gray-400">{currentPage.description}</p>
                  )}
                  <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-950/40">
                    <pre className="whitespace-pre-wrap break-words text-sm leading-6 text-gray-800 dark:text-gray-200">{currentPage.content || 'No content available.'}</pre>
                  </div>
                </>
              )}
            </div>
            )
          ) : (
            <div className="flex min-h-[420px] flex-col items-center justify-center text-center">
              <BookOpen size={42} className="mb-4 text-emerald-400 dark:text-emerald-600" />
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Select a page to get started</h3>
              <p className="mt-2 max-w-md text-sm text-gray-500 dark:text-gray-400">
                Search Wiki.js, browse your recent pages, or create a new page for this project.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
