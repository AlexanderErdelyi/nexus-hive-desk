'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  BookOpen,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FilePlus2,
  Loader2,
  PencilLine,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Wifi,
  Zap,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
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
  locale: 'de' | 'en';
  description: string;
  tags: string;
}

interface TreeNode {
  path: string;
  fragment: string;
  title: string;
  description?: string;
  children: TreeNode[];
  hasChildren: boolean;
  page?: WikiPageSummary;
  isPage: boolean;
}

interface RecordingItem {
  id: string;
  title?: string;
  processedAt?: string;
}

interface WorkItemSource {
  id: number;
  title: string;
  type: string;
  state: string;
  description?: string | null;
  acceptanceCriteria?: string | null;
}

interface GeneratedWikiPage {
  title?: string;
  content?: string;
  path?: string;
  message?: string;
  format?: 'markdown' | 'html';
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
    return data
      .filter(isRecord)
      .map((item) => ({
        id: getString(item, ['id']),
        path: getString(item, ['path', 'slug']),
        title: getString(item, ['title', 'name'], getString(item, ['path', 'slug'])),
        description: getString(item, ['description']),
        url: getString(item, ['url']),
        locale: getString(item, ['locale']),
        updatedAt: getString(item, ['updatedAt']),
      }))
      .filter((item) => item.path);
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
    ? tagsValue
      .map((tag) => (isRecord(tag) ? getString(tag, ['tag']) : String(tag)).trim())
      .filter(Boolean)
    : typeof tagsValue === 'string'
      ? tagsValue.split(',').map((tag) => tag.trim()).filter(Boolean)
      : [];

  return {
    id: record.id as string | number | undefined,
    path: getString(record, ['path', 'slug']),
    title: getString(record, ['title', 'name'], getString(record, ['path', 'slug'])),
    description: getString(record, ['description']),
    url: getString(record, ['url']),
    locale: (getString(record, ['locale'], 'de') === 'en' ? 'en' : 'de'),
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

function buildWikiTreeUrl(mcpId: string, locale: 'de' | 'en') {
  return `/api/mcp-connections/${mcpId}/wiki-tree?locale=${locale}`;
}

function toDraft(page: WikiPage, fallbackLocale: 'de' | 'en'): WikiPageDraft {
  const locale = page.locale === 'en' ? 'en' : fallbackLocale;
  return {
    path: page.path,
    title: page.title,
    content: page.content,
    locale,
    description: page.description ?? '',
    tags: page.tags.join(', '),
  };
}

function parseListInput(value: string) {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatWorkItemContent(workItem: WorkItemSource) {
  return [
    `Work item #${workItem.id}`,
    `Title: ${workItem.title}`,
    `Type: ${workItem.type}`,
    `State: ${workItem.state}`,
    workItem.description ? `Description:\n${workItem.description}` : '',
    workItem.acceptanceCriteria ? `Acceptance Criteria:\n${workItem.acceptanceCriteria}` : '',
  ].filter(Boolean).join('\n\n');
}

function buildTree(pages: WikiPageSummary[]): TreeNode[] {
  const nodeMap = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  const getOrCreateNode = (path: string, fragment: string) => {
    const existing = nodeMap.get(path);
    if (existing) return existing;
    const node: TreeNode = {
      path,
      fragment,
      title: fragment,
      children: [],
      hasChildren: false,
      isPage: false,
    };
    nodeMap.set(path, node);
    return node;
  };

  for (const page of [...pages].sort((a, b) => a.path.localeCompare(b.path))) {
    const segments = page.path.split('/').filter(Boolean);
    let parent: TreeNode | null = null;

    segments.forEach((segment, index) => {
      const path = segments.slice(0, index + 1).join('/');
      const node = getOrCreateNode(path, segment);

      if (!parent) {
        if (!roots.includes(node)) roots.push(node);
      } else if (!parent.children.includes(node)) {
        parent.children.push(node);
        parent.hasChildren = true;
      }

      if (index === segments.length - 1) {
        node.title = page.title || segment;
        node.description = page.description;
        node.page = page;
        node.isPage = true;
      }

      parent = node;
    });
  }

  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => a.path.localeCompare(b.path));
    nodes.forEach((node) => {
      node.hasChildren = node.children.length > 0;
      if (node.children.length > 0) sortNodes(node.children);
    });
  };

  sortNodes(roots);
  return roots;
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
  const [expandedPaths, setExpandedPaths] = useState<string[] | null>(null);
  const [draft, setDraft] = useState<WikiPageDraft>({
    path: `projects/${projectId}`,
    title: '',
    content: '',
    locale: 'de',
    description: '',
    tags: '',
  });
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [aiMode, setAiMode] = useState<'generate' | 'refine'>('generate');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiLogs, setAiLogs] = useState<string[]>([]);
  const [aiStreamText, setAiStreamText] = useState('');
  const refineInputRef = useRef<HTMLTextAreaElement>(null);
  const [chatHistory, setChatHistory] = useState<Array<{ role: 'user' | 'assistant'; content: string; ts: number }>>([]);
  const [editorFormat, setEditorFormat] = useState<'markdown' | 'html'>('markdown');
  const [htmlViewMode, setHtmlViewMode] = useState<'edit' | 'preview'>('edit');
  const [workItemInput, setWorkItemInput] = useState('');
  const [workItemSearchOpen, setWorkItemSearchOpen] = useState(false);
  const [debouncedWorkItemSearch, setDebouncedWorkItemSearch] = useState('');
  const [loadedWorkItem, setLoadedWorkItem] = useState<WorkItemSource | null>(null);
  const [selectedRecordingId, setSelectedRecordingId] = useState('');
  const [repoQueryInput, setRepoQueryInput] = useState('');
  const [selectedRepoId, setSelectedRepoId] = useState('');
  const [repoBrowserOpen, setRepoBrowserOpen] = useState(false);
  const [repoBrowsePath, setRepoBrowsePath] = useState('/');
  const [customInstructions, setCustomInstructions] = useState('');
  const [selectedStyleSkillId, setSelectedStyleSkillId] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [debugLogOpen, setDebugLogOpen] = useState(false);
  const [debugLog, setDebugLog] = useState<Array<{ ts: number; op: string; source: string; ok: boolean; detail?: string }>>([]);
  const aiLogRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const contentSectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedSearch(searchTerm.trim()), 400);
    return () => window.clearTimeout(timeout);
  }, [searchTerm]);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedWorkItemSearch(workItemInput.trim()), 350);
    return () => window.clearTimeout(timeout);
  }, [workItemInput]);

  useEffect(() => {
    if (!aiLogRef.current) return;
    aiLogRef.current.scrollTop = aiLogRef.current.scrollHeight;
  }, [aiLogs, aiStreamText]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory]);

  useEffect(() => {
    contentSectionRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [selectedPath]);

  const connectionsQuery = useQuery({
    queryKey: ['mcp-connections', 'wiki-js'],
    queryFn: () => api.get<{ data: McpConnection[] }>('/api/mcp-connections?type=wiki_js'),
  });

  const teamsConnectionsQuery = useQuery({
    queryKey: ['mcp-connections', 'teams-recorder'],
    queryFn: () => api.get<{ data: McpConnection[] }>('/api/mcp-connections?type=teams_recorder'),
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

  const teamsConnections = useMemo(() => {
    const connections = teamsConnectionsQuery.data?.data ?? [];
    const scoped = connections.filter((connection) => {
      if (connection.projectId && connection.projectId !== projectId) return false;
      if (connection.customerId && connection.customerId !== customerId) return false;
      return true;
    });
    return scoped.length > 0 ? scoped : connections;
  }, [teamsConnectionsQuery.data, customerId, projectId]);

  const activeMcpId = wikiConnections.some((connection) => connection.id === selectedMcpId)
    ? selectedMcpId
    : (wikiConnections[0]?.id ?? '');
  const activeTeamsMcpId = teamsConnections[0]?.id ?? '';

  const selectedConnection = wikiConnections.find((connection) => connection.id === activeMcpId);

  const searchQuery = useQuery({
    queryKey: ['wiki-pages-search', activeMcpId, debouncedSearch, activeLocale],
    enabled: Boolean(activeMcpId && debouncedSearch),
    queryFn: () => api.get<{ data: unknown }>(buildWikiPagesUrl(activeMcpId, { query: debouncedSearch, locale: activeLocale })),
  });

  const treeQuery = useQuery({
    queryKey: ['wiki-tree', activeMcpId, activeLocale],
    enabled: Boolean(activeMcpId),
    queryFn: () => api.get<{ data: WikiPageSummary[] }>(buildWikiTreeUrl(activeMcpId, activeLocale)),
  });

  const recordingsQuery = useQuery({
    queryKey: ['mcp-recordings', activeTeamsMcpId],
    enabled: Boolean(activeTeamsMcpId),
    queryFn: () => api.get<{ data: RecordingItem[] }>(`/api/mcp-connections/${activeTeamsMcpId}/recordings`),
  });

  const reposQuery = useQuery({
    queryKey: ['repos', projectId],
    queryFn: () => api.get<{ data: Array<{ id: string; label?: string; repoName: string; defaultBranch?: string }> }>(`/api/projects/${projectId}/repositories`),
    enabled: !!projectId,
  });

  const wikiStylesQuery = useQuery({
    queryKey: ['wiki-styles'],
    queryFn: () => api.get<{ data: Array<{ id: string; name: string; description?: string; builtIn: boolean }> }>('/api/skills/wiki-styles'),
    staleTime: 60_000,
  });

  const agentsQuery = useQuery({
    queryKey: ['agents', projectId],
    queryFn: () => api.get<{ data: Array<{ id: string; name: string; description?: string; model?: string; modelProvider: string; systemPrompt?: string }> }>(`/api/agents?projectId=${projectId}`),
    enabled: !!projectId,
    staleTime: 60_000,
  });

  const promptSkillsQuery = useQuery({
    queryKey: ['prompt-skills'],
    queryFn: () => api.get<{ data: Array<{ id: string; name: string; description?: string; builtIn: boolean }> }>('/api/skills?type=prompt'),
    staleTime: 60_000,
  });

  const repoTreeQuery = useQuery({
    queryKey: ['repo-tree', projectId, selectedRepoId, repoBrowsePath],
    queryFn: () => api.get<{ data: Array<{ name: string; path: string; type: string }> }>(
      `/api/projects/${projectId}/repositories/${selectedRepoId}/tree?path=${encodeURIComponent(repoBrowsePath)}`
    ),
    enabled: !!selectedRepoId && repoBrowserOpen,
  });

  const workItemSearchQuery = useQuery({
    queryKey: ['work-items-search', projectId, debouncedWorkItemSearch],
    queryFn: () => api.get<{ data: Array<{ id: number; title: unknown; type: unknown; state: unknown }> }>(
      `/api/projects/${projectId}/work-items?search=${encodeURIComponent(debouncedWorkItemSearch)}&top=10`
    ),
    enabled: !!projectId && debouncedWorkItemSearch.length >= 2,
  });

  const pageQuery = useQuery({
    queryKey: ['wiki-page', activeMcpId, selectedPath, activeLocale],
    enabled: Boolean(activeMcpId && selectedPath && !isCreating),
    queryFn: () => api.get<{ data: unknown; source?: string; mcpError?: string }>(buildWikiPagesUrl(activeMcpId, { path: selectedPath, locale: activeLocale })),
  });

  const wikiStatusQuery = useQuery({
    queryKey: ['wiki-status', activeMcpId],
    enabled: Boolean(activeMcpId),
    staleTime: 30_000,
    queryFn: () => api.get<{ data: { directAvailable: boolean; directError?: string; mcpConfigured: boolean; mcpAvailable: boolean; mcpError?: string; activeSource: 'mcp' | 'direct' } }>(`/api/mcp-connections/${activeMcpId}/wiki-status`),
  });

  const currentPage = useMemo(() => normalizePage(pageQuery.data?.data), [pageQuery.data?.data]);
  const searchResults = useMemo(() => normalizeSearchResults(searchQuery.data?.data), [searchQuery.data?.data]);
  const treeNodes = useMemo(() => buildTree(treeQuery.data?.data ?? []), [treeQuery.data?.data]);
  const recordings = recordingsQuery.data?.data ?? [];
  const projectRepos = reposQuery.data?.data ?? [];
  const wikiStyles = wikiStylesQuery.data?.data ?? [];
  const projectAgents = agentsQuery.data?.data ?? [];
  const promptSkills = (promptSkillsQuery.data?.data ?? []).filter((s) => s.builtIn === false);
  const treeItems = repoTreeQuery.data?.data ?? [];
  const selectedRepoEntries = useMemo(() => new Set(parseListInput(repoQueryInput)), [repoQueryInput]);
  const defaultExpandedPaths = useMemo(() => treeNodes.slice(0, 6).map((node) => node.path), [treeNodes]);
  const expandedSet = useMemo(() => new Set(expandedPaths ?? defaultExpandedPaths), [defaultExpandedPaths, expandedPaths]);

  useEffect(() => {
    if (connectionsQuery.error) toast.error(getErrorMessage(connectionsQuery.error));
  }, [connectionsQuery.error]);

  useEffect(() => {
    if (teamsConnectionsQuery.error) toast.error(getErrorMessage(teamsConnectionsQuery.error));
  }, [teamsConnectionsQuery.error]);

  useEffect(() => {
    if (searchQuery.error) toast.error(getErrorMessage(searchQuery.error));
  }, [searchQuery.error]);

  useEffect(() => {
    // Suppress tree error toast when we already know direct GraphQL is unavailable —
    // the inline "tree unavailable" state in the sidebar handles it.
    if (treeQuery.error && wikiStatusQuery.data?.data?.directAvailable !== false) {
      toast.error(getErrorMessage(treeQuery.error));
    }
  }, [treeQuery.error, wikiStatusQuery.data?.data?.directAvailable]);

  useEffect(() => {
    if (recordingsQuery.error) toast.error(getErrorMessage(recordingsQuery.error));
  }, [recordingsQuery.error]);

  useEffect(() => {
    if (reposQuery.error) toast.error(getErrorMessage(reposQuery.error));
  }, [reposQuery.error]);

  useEffect(() => {
    if (repoTreeQuery.error) toast.error(getErrorMessage(repoTreeQuery.error));
  }, [repoTreeQuery.error]);

  useEffect(() => {
    if (selectedRepoId && !projectRepos.some((repo) => repo.id === selectedRepoId)) {
      setSelectedRepoId('');
      setRepoBrowserOpen(false);
      setRepoBrowsePath('/');
    }
  }, [projectRepos, selectedRepoId]);

  useEffect(() => {
    if (pageQuery.error) {
      const msg = getErrorMessage(pageQuery.error);
      if (!msg.toLowerCase().includes('not found') && !msg.includes('6003')) toast.error(msg);
    }
  }, [pageQuery.error]);

  const saveMutation = useMutation({
    mutationFn: (input: WikiPageDraft & { editorFormat?: 'markdown' | 'html' }) => api.post<{ data: unknown }>(`/api/mcp-connections/${activeMcpId}/wiki-pages`, {
      path: input.path.trim(),
      title: input.title.trim(),
      content: input.content,
      locale: input.locale,
      description: input.description.trim(),
      tags: input.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      editor: input.editorFormat === 'html' ? 'html' : 'markdown',
    }),
    onSuccess: async (result, input) => {
      setSelectedPath(input.path.trim());
      setActiveLocale(input.locale);
      setIsCreating(false);
      setIsEditing(false);
      setAiPanelOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['wiki-pages-search', activeMcpId] });
      await queryClient.invalidateQueries({ queryKey: ['wiki-page', activeMcpId, input.path.trim(), input.locale] });
      await queryClient.invalidateQueries({ queryKey: ['wiki-tree', activeMcpId] });
      await queryClient.invalidateQueries({ queryKey: ['wiki-status', activeMcpId] });
      const source = (result as any)?.source as string | undefined;
      const mcpError = (result as any)?.mcpError as string | undefined;
      const logEntry = { ts: Date.now(), op: `Save: ${input.path.trim()}`, source: source ?? 'unknown', ok: true, detail: mcpError ? `MCP failed → direct: ${mcpError}` : undefined };
      setDebugLog((l) => [logEntry, ...l].slice(0, 50));
      if (source === 'mcp') {
        toast.success('Page saved via MCP');
      } else if (mcpError) {
        toast.warning(`Page saved (MCP failed, used direct GraphQL: ${mcpError})`);
      } else {
        toast.success('Page saved to Wiki.js');
      }
    },
    onError: (error) => {
      setDebugLog((l) => [{ ts: Date.now(), op: 'Save', source: '?', ok: false, detail: getErrorMessage(error) }, ...l].slice(0, 50));
      toast.error(getErrorMessage(error));
    },
  });

  const loadWorkItemMutation = useMutation({
    mutationFn: (workItemId: number) => api.get<{ data: WorkItemSource }>(`/api/projects/${projectId}/work-items/${workItemId}`),
    onSuccess: (result) => {
      setLoadedWorkItem(result.data);
      toast.success('Work item loaded');
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const testWriteMutation = useMutation({
    mutationFn: () => api.post<{ httpStatus?: number; error?: string; rawResponse?: unknown; bodyByteLength?: number; approach?: string }>(
      `/api/mcp-connections/${activeMcpId}/wiki-test-write`, {}
    ),
    onSuccess: (result) => {
      const rr = (result?.rawResponse as any)?.data?.pages?.create?.responseResult;
      let msg = '';
      let ok = false;
      if (result.httpStatus === 403) {
        msg = `WAF blocked (HTTP 403) — ${result.bodyByteLength}B via ${result.approach}`;
        toast.error(`WAF blocked write test (HTTP 403). Body was ${result.bodyByteLength} bytes as ${result.approach}.`);
      } else if (rr?.succeeded === false) {
        msg = `GraphQL error ${rr.errorCode}: ${rr.message}`;
        toast.error(`Write test: GraphQL error ${rr.errorCode}: ${rr.message}`);
      } else if (rr?.succeeded === true) {
        ok = true;
        msg = `OK — page id=${((result?.rawResponse as any)?.data?.pages?.create?.page?.id) ?? '?'} via direct GraphQL`;
        toast.success(`Write test succeeded. Direct GraphQL works!`);
      } else {
        msg = `HTTP ${result.httpStatus} — ${JSON.stringify(result.rawResponse).slice(0, 120)}`;
        toast.info(msg);
      }
      setDebugLog((l) => [{ ts: Date.now(), op: 'Test Write', source: 'direct', ok, detail: msg }, ...l].slice(0, 50));
    },
    onError: (error) => {
      const msg = getErrorMessage(error);
      setDebugLog((l) => [{ ts: Date.now(), op: 'Test Write', source: '?', ok: false, detail: msg }, ...l].slice(0, 50));
      toast.error(`Write test error: ${msg}`);
    },
  });

  function updateExpanded(path: string, expanded?: boolean) {
    setExpandedPaths((current) => {
      const next = new Set(current ?? defaultExpandedPaths);
      const shouldExpand = expanded ?? !next.has(path);
      if (shouldExpand) next.add(path);
      else next.delete(path);
      return [...next];
    });
  }

  function expandAncestors(path: string) {
    const parts = path.split('/').filter(Boolean);
    setExpandedPaths((current) => {
      const next = new Set(current ?? defaultExpandedPaths);
      parts.reduce((acc, part) => {
        const nextPath = acc ? `${acc}/${part}` : part;
        next.add(nextPath);
        return nextPath;
      }, '');
      return [...next];
    });
  }

  function openPage(page: WikiPageSummary) {
    if (!page.path) return;
    setSelectedPath(page.path);
    setActiveLocale(page.locale === 'en' ? 'en' : 'de');
    setIsCreating(false);
    setIsEditing(false);
    setAiPanelOpen(false);
    expandAncestors(page.path);
  }

  function startNewPage(pathPrefix?: string, asChild = true) {
    const normalizedPrefix = pathPrefix?.trim().replace(/\/+$/, '');
    setIsCreating(true);
    setIsEditing(true);
    setAiPanelOpen(false);
    setSelectedPath('');
    setDraft({
      path: normalizedPrefix ? (asChild ? `${normalizedPrefix}/` : normalizedPrefix) : `projects/${projectId}`,
      title: '',
      content: '',
      locale: activeLocale,
      description: '',
      tags: '',
    });
    if (normalizedPrefix) expandAncestors(normalizedPrefix);
  }

  function startEditPage(page?: WikiPageSummary) {
    const source = page ?? currentPage ?? undefined;
    if (!source) return;
    const sourceLocale = source.locale === 'en' ? 'en' : 'de';

    setSelectedPath(source.path);
    setActiveLocale(sourceLocale);
    setIsCreating(false);
    setIsEditing(true);
    setAiPanelOpen(false);
    expandAncestors(source.path);

    if (currentPage && currentPage.path === source.path) {
      setDraft(toDraft(currentPage, sourceLocale));
      return;
    }

    setDraft({
      path: source.path,
      title: source.title,
      content: '',
      locale: sourceLocale,
      description: source.description ?? '',
      tags: '',
    });

    if (!activeMcpId) return;
    void api.get<{ data: unknown }>(buildWikiPagesUrl(activeMcpId, { path: source.path, locale: sourceLocale }))
      .then((result) => {
        const loadedPage = normalizePage(result.data);
        if (loadedPage?.path === source.path) setDraft(toDraft(loadedPage, sourceLocale));
      })
      .catch(() => undefined);
  }

  function toggleAiPanel() {
    if (!isCreating && !isEditing) {
      if (currentPage && currentPage.found !== false) {
        startEditPage(currentPage);
      } else {
        startNewPage(selectedPath || undefined, false);
      }
      setAiPanelOpen(true);
      return;
    }

    setAiPanelOpen((current) => !current);
  }

  async function handleGenerate() {
    if (!activeMcpId) {
      toast.error('Select a Wiki.js connection first');
      return;
    }
    if (!draft.path.trim()) {
      toast.error('Enter a page path first');
      return;
    }

    setAiLoading(true);
    setAiLogs(['Preparing AI generation...']);
    setAiStreamText('');

    try {
      const token = localStorage.getItem('nexus_auth_token');
      const response = await fetch(`/api/mcp-connections/${activeMcpId}/generate-wiki-page`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          projectId,
          path: draft.path.trim(),
          title: draft.title.trim() || undefined,
          locale: draft.locale,
          format: editorFormat,
          styleSkillId: selectedStyleSkillId || undefined,
          model: selectedAgentId ? undefined : (selectedModel || undefined),
          agentId: selectedAgentId || undefined,
          skillIds: selectedSkillIds.length > 0 ? selectedSkillIds : undefined,
          sources: {
            workItemId: loadedWorkItem?.id,
            workItemContent: loadedWorkItem ? formatWorkItemContent(loadedWorkItem) : undefined,
            recordingId: selectedRecordingId || undefined,
            mcpTeamsId: selectedRecordingId ? activeTeamsMcpId || undefined : undefined,
            repoFiles: parseListInput(repoQueryInput),
            customPrompt: customInstructions.trim() || undefined,
          },
        }),
      });

      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => response.statusText);
        throw new Error(text || 'Streaming request failed');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';

        for (const part of parts) {
          let eventType = 'message';
          let data = '';

          for (const line of part.split('\n')) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim();
            if (line.startsWith('data: ')) data += line.slice(6).trim();
          }

          if (!data) continue;
          const parsed = JSON.parse(data) as GeneratedWikiPage;

          if (eventType === 'log' && parsed.message) {
            setAiLogs((current) => [...current, parsed.message as string]);
          }
          if (eventType === 'chunk') {
            setAiStreamText((current) => current + String(parsed.content ?? ''));
          }
          if (eventType === 'result') {
            const newContent = String(parsed.content ?? '');
            setDraft((current) => ({
              ...current,
              path: parsed.path ? String(parsed.path) : current.path,
              title: current.title.trim() ? current.title : String(parsed.title ?? current.title),
              content: newContent,
            }));
            if (parsed.format === 'html' || parsed.format === 'markdown') {
              setEditorFormat(parsed.format as 'html' | 'markdown');
            }
            // Switch to refine mode so user can iterate before publishing
            setChatHistory([]);
            setAiMode('refine');
            setAiPanelOpen(true);
            toast.success('Draft generated — refine it in the AI chat or save when ready ✨');
          }
          if (eventType === 'error') throw new Error(String(parsed.message ?? 'Streaming generation failed'));
          if (eventType === 'done') return;
        }
      }
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setAiLoading(false);
    }
  }

  function handleLoadWorkItem() {
    const workItemId = Number(workItemInput.trim());
    if (!Number.isFinite(workItemId) || workItemId <= 0) {
      toast.error('Enter a numeric work item ID');
      return;
    }
    loadWorkItemMutation.mutate(workItemId);
  }

  function toggleRepoContextItem(path: string) {
    setRepoQueryInput((current) => {
      const lines = current.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (lines.includes(path)) {
        return lines.filter((line) => line !== path).join('\n');
      }
      return [...lines, path].join('\n');
    });
  }

  async function handleRefine() {
    if (!activeMcpId) return;
    const message = (refineInputRef.current?.value ?? '').trim();
    if (!message) return;

    const userTurn = { role: 'user' as const, content: message, ts: Date.now() };
    setChatHistory((prev) => [...prev, userTurn]);
    if (refineInputRef.current) refineInputRef.current.value = '';
    setAiLoading(true);

    try {
      const token = localStorage.getItem('nexus_auth_token');
      const historyForApi = chatHistory.map(({ role, content }) => ({ role, content }));

      const response = await fetch(`/api/mcp-connections/${activeMcpId}/generate-wiki-page`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          projectId,
          path: draft.path.trim(),
          locale: draft.locale,
          format: editorFormat,
          refine: true,
          existingContent: draft.content,
          message,
          chatHistory: historyForApi,
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error(await response.text().catch(() => 'Refine request failed'));
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assistantContent = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';

        for (const part of parts) {
          let eventType = 'message';
          let data = '';
          for (const line of part.split('\n')) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim();
            if (line.startsWith('data: ')) data += line.slice(6).trim();
          }
          if (!data) continue;
          const parsed = JSON.parse(data) as GeneratedWikiPage & { message?: string };

          if (eventType === 'log' && parsed.message) {
            // swallow logs silently in refine mode
          }
          if (eventType === 'chunk') {
            assistantContent += String(parsed.content ?? '');
          }
          if (eventType === 'result') {
            const newContent = String(parsed.content ?? draft.content);
            setDraft((current) => ({ ...current, content: newContent }));
            setChatHistory((prev) => [...prev, { role: 'assistant', content: message, ts: Date.now() }]);
            toast.success('Content updated ✨');
          }
          if (eventType === 'error') throw new Error(String(parsed.message ?? 'Refinement failed'));
        }
      }
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setAiLoading(false);
    }
  }

  const inputClass = 'w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 focus:border-indigo-400 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-white';
  const paneClass = 'min-h-0 flex-1 rounded-2xl border border-gray-200 bg-gray-50/70 p-3 dark:border-gray-700 dark:bg-gray-800/40';

  function renderTreeNodes(nodes: TreeNode[], depth = 0) {
    return nodes.map((node) => {
      const showCollapsedChildren = depth >= 3 && node.children.length > 0;
      const moreKey = `${node.path}::__more`;
      const isSelected = selectedPath === node.path;

      return (
        <div key={node.path} className="space-y-1">
          <div
            className={`group flex items-center gap-1 rounded-xl border px-2 py-1.5 transition-colors ${
              isSelected
                ? 'border-indigo-300 bg-indigo-50 dark:border-indigo-700 dark:bg-indigo-900/20'
                : 'border-transparent hover:border-gray-200 hover:bg-white dark:hover:border-gray-700 dark:hover:bg-gray-800'
            }`}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
          >
            {node.hasChildren ? (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  updateExpanded(node.path);
                }}
                className="rounded-md p-0.5 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
              >
                {expandedSet.has(node.path) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
            ) : (
              <span className="w-[18px]" />
            )}

            <button
              type="button"
              onClick={() => {
                if (node.page) openPage(node.page);
                else if (node.hasChildren) updateExpanded(node.path);
              }}
              className="min-w-0 flex-1 text-left"
            >
              <div className="truncate text-sm font-medium text-gray-900 dark:text-white">{node.title}</div>
              <div className="truncate text-[11px] text-gray-500 dark:text-gray-400">{node.fragment}</div>
            </button>

            <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  startNewPage(node.path);
                }}
                className="rounded-md p-1 text-gray-500 hover:bg-gray-100 hover:text-indigo-600 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-indigo-300"
                title="Create child page here"
              >
                <Plus size={14} />
              </button>
              {node.page && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    startEditPage(node.page);
                  }}
                  className="rounded-md p-1 text-gray-500 hover:bg-gray-100 hover:text-indigo-600 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-indigo-300"
                  title="Edit page"
                >
                  <PencilLine size={14} />
                </button>
              )}
            </div>
          </div>

          {node.hasChildren && expandedSet.has(node.path) && !showCollapsedChildren && (
            <div className="space-y-1">{renderTreeNodes(node.children, depth + 1)}</div>
          )}

          {node.hasChildren && expandedSet.has(node.path) && showCollapsedChildren && (
            <div className="space-y-1">
              <button
                type="button"
                onClick={() => updateExpanded(moreKey)}
                className="ml-8 rounded-lg px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
              >
                {expandedSet.has(moreKey) ? 'Hide deeper pages' : '... show deeper pages'}
              </button>
              {expandedSet.has(moreKey) && <div className="space-y-1">{renderTreeNodes(node.children, depth + 1)}</div>}
            </div>
          )}
        </div>
      );
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

  const showEditor = isCreating || isEditing;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Documentation</h2>
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
              <Wifi size={12} /> Sync with Wiki
            </span>
            {wikiStatusQuery.data?.data && (() => {
              const st = wikiStatusQuery.data.data;
              if (st.mcpAvailable) {
                return (
                  <span title="Operations routed through MCP server" className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-700 dark:border-violet-900/50 dark:bg-violet-900/20 dark:text-violet-300">
                    <Zap size={12} /> MCP
                  </span>
                );
              }
              if (st.mcpConfigured && !st.mcpAvailable) {
                return (
                  <span title={`MCP unavailable — using direct GraphQL. Error: ${st.mcpError ?? 'unknown'}`} className="inline-flex cursor-help items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                    <AlertTriangle size={12} /> MCP failed → Direct
                  </span>
                );
              }
              return (
                <span title="Using direct GraphQL (no MCP configured)" className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs font-medium text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
                  Direct GraphQL
                </span>
              );
            })()}
            <button
              type="button"
              title="Run a diagnostic write test to check if Wiki.js accepts pages from this server"
              onClick={() => testWriteMutation.mutate()}
              disabled={testWriteMutation.isPending}
              className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs font-medium text-gray-500 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-600 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-indigo-900/20 dark:hover:text-indigo-300"
            >
              {testWriteMutation.isPending ? '…' : '🔬 Test Write'}
            </button>
            <button
              type="button"
              title="Toggle debug log"
              onClick={() => setDebugLogOpen((v) => !v)}
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${debugLogOpen ? 'border-slate-400 bg-slate-100 text-slate-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200' : 'border-gray-200 bg-gray-50 text-gray-500 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400'}`}
            >
              🪵 {debugLog.length > 0 ? debugLog.length : ''} Log
            </button>
          </div>
          {debugLogOpen && (
            <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900">
              <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-700">
                <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">Wiki.js Operation Log</span>
                <button type="button" onClick={() => setDebugLog([])} className="text-xs text-slate-400 hover:text-red-500">Clear</button>
              </div>
              {debugLog.length === 0 ? (
                <div className="px-3 py-3 text-xs text-slate-400">No operations yet. Save a page or run Test Write to see logs.</div>
              ) : (
                <div className="max-h-48 overflow-y-auto font-mono text-xs">
                  {debugLog.map((entry) => (
                    <div key={entry.ts} className={`flex items-start gap-2 border-b border-slate-100 px-3 py-1.5 last:border-0 dark:border-slate-800 ${entry.ok ? '' : 'bg-red-50 dark:bg-red-900/10'}`}>
                      <span className="mt-0.5 shrink-0">{entry.ok ? '✅' : '❌'}</span>
                      <span className="shrink-0 text-slate-400">{new Date(entry.ts).toLocaleTimeString()}</span>
                      <span className={`shrink-0 rounded px-1 py-0.5 text-xs font-semibold ${entry.source === 'mcp' ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300' : 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'}`}>
                        {entry.source}
                      </span>
                      <span className="text-slate-600 dark:text-slate-300">{entry.op}</span>
                      {entry.detail && <span className="ml-auto text-slate-400 dark:text-slate-500">{entry.detail}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Browse, create, edit, and generate Wiki.js pages directly from NexusHiveDesk.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <select
            className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 focus:border-indigo-400 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-white"
            value={activeMcpId}
            onChange={(event) => {
              setSelectedMcpId(event.target.value);
              setSelectedPath('');
              setIsCreating(false);
              setIsEditing(false);
              setAiPanelOpen(false);
            }}
          >
            {wikiConnections.map((connection) => (
              <option key={connection.id} value={connection.id}>{connection.name}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => startNewPage()}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            <FilePlus2 size={15} /> New Page
          </button>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[340px_minmax(0,1fr)] xl:items-start">
        <aside className="sticky top-4 flex max-h-[calc(100vh-6rem)] flex-col gap-3 overflow-hidden rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <div className="shrink-0 rounded-2xl border border-gray-200 bg-gray-50/70 p-3 dark:border-gray-700 dark:bg-gray-800/40">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="relative flex-1">
                <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  className="w-full rounded-xl border border-gray-200 bg-white py-2 pl-9 pr-3 text-sm text-gray-900 placeholder-gray-400 focus:border-indigo-400 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-white dark:placeholder-gray-500"
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                  placeholder="Search wiki pages..."
                />
              </div>
              <button
                type="button"
                onClick={() => {
                  setSearchTerm('');
                  setDebouncedSearch('');
                }}
                className="rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                Clear
              </button>
            </div>

            <div className="mb-2 flex items-center justify-between rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
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

            <div className="max-h-[200px] space-y-2 overflow-y-auto pr-1">
              {searchQuery.isFetching && debouncedSearch ? (
                <div className="flex items-center gap-2 rounded-xl border border-gray-200 px-3 py-3 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                  <Loader2 size={14} className="animate-spin" /> Searching Wiki.js…
                </div>
              ) : debouncedSearch ? (
                searchResults.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-gray-200 px-3 py-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                    No pages found for this search.
                  </div>
                ) : (
                  searchResults.map((page) => (
                    <button
                      key={`${page.path}-${page.locale ?? 'de'}`}
                      type="button"
                      onClick={() => openPage(page)}
                      className={`w-full rounded-xl border px-3 py-3 text-left transition-colors ${
                        selectedPath === page.path
                          ? 'border-indigo-300 bg-indigo-50 dark:border-indigo-700 dark:bg-indigo-900/20'
                          : 'border-gray-200 hover:border-indigo-200 hover:bg-white dark:border-gray-700 dark:hover:border-indigo-800 dark:hover:bg-gray-800'
                      }`}
                    >
                      <div className="truncate text-sm font-medium text-gray-900 dark:text-white">{page.title}</div>
                      <div className="mt-1 truncate text-xs text-gray-500 dark:text-gray-400">{page.path}</div>
                      {page.description && (
                        <div className="mt-2 line-clamp-2 text-xs text-gray-500 dark:text-gray-400">{page.description}</div>
                      )}
                    </button>
                  ))
                )
              ) : (
                <div className="rounded-xl border border-dashed border-gray-200 px-3 py-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                  Type to search pages. The full page tree stays available below.
                </div>
              )}
            </div>
          </div>

          <div className={`${paneClass} flex flex-col`}>
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Page tree</h3>
                <p className="text-xs text-gray-500 dark:text-gray-400">Create child pages or jump straight into editing.</p>
              </div>
              <span className="rounded-full bg-white px-2 py-1 text-[11px] text-gray-500 dark:bg-gray-900 dark:text-gray-400">
                {(treeQuery.data?.data ?? []).length}
              </span>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              {treeQuery.isLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 7 }).map((_, index) => (
                    <div key={index} className="h-12 animate-pulse rounded-xl bg-gray-200/70 dark:bg-gray-800" />
                  ))}
                </div>
              ) : treeQuery.error || (wikiStatusQuery.data?.data?.directAvailable === false) ? (
                <div className="rounded-xl border border-dashed border-amber-200 bg-amber-50/60 px-3 py-5 text-center dark:border-amber-800 dark:bg-amber-900/20">
                  <AlertTriangle size={20} className="mx-auto mb-2 text-amber-500" />
                  <p className="text-xs font-medium text-amber-700 dark:text-amber-300">Page tree unavailable</p>
                  <p className="mt-1 text-xs text-amber-600/80 dark:text-amber-400/80">
                    {wikiStatusQuery.data?.data?.directError ?? 'Direct GraphQL is not reachable. Fix the Wiki.js URL in the connection settings.'}
                  </p>
                </div>
              ) : treeNodes.length === 0 ? (
                <div className="rounded-xl border border-dashed border-gray-200 px-3 py-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                  No pages found.
                </div>
              ) : (
                <div className="space-y-1">{renderTreeNodes(treeNodes)}</div>
              )}
            </div>
          </div>
        </aside>

        <section ref={contentSectionRef} className="min-h-[600px] overflow-y-auto rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
          {showEditor ? (
            <div className="space-y-4">
              <div className="flex flex-col gap-3 border-b border-gray-100 pb-4 dark:border-gray-800 md:flex-row md:items-start md:justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                    {isCreating ? 'Create new page' : 'Edit page'}
                  </h3>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {editorFormat === 'html' ? 'Write HTML (inline CSS) and save directly to Wiki.js.' : 'Write markdown and save it directly to Wiki.js.'}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={toggleAiPanel}
                    className="inline-flex items-center gap-2 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-sm font-medium text-violet-700 hover:bg-violet-100 dark:border-violet-900/50 dark:bg-violet-900/20 dark:text-violet-300"
                  >
                    <Sparkles size={15} /> {aiPanelOpen ? 'Hide AI panel' : 'Generate with AI'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIsCreating(false);
                      setIsEditing(false);
                      setAiPanelOpen(false);
                    }}
                    className="rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                  >
                    Cancel
                  </button>
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Path</label>
                  <input
                    className={inputClass}
                    value={draft.path}
                    onChange={(event) => setDraft((current) => ({ ...current, path: event.target.value }))}
                    placeholder={`projects/${projectId}/overview`}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Title</label>
                  <input
                    className={inputClass}
                    value={draft.title}
                    onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                    placeholder="Architecture overview"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Locale</label>
                  <select
                    className={inputClass}
                    value={draft.locale}
                    onChange={(event) => setDraft((current) => ({ ...current, locale: event.target.value as 'de' | 'en' }))}
                  >
                    <option value="de">de</option>
                    <option value="en">en</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Tags</label>
                  <input
                    className={inputClass}
                    value={draft.tags}
                    onChange={(event) => setDraft((current) => ({ ...current, tags: event.target.value }))}
                    placeholder="architecture, onboarding"
                  />
                </div>
              </div>

              {aiPanelOpen && (
                <div className="rounded-2xl border border-violet-200 bg-violet-50/70 p-4 dark:border-violet-900/50 dark:bg-violet-900/10">
                  {/* Panel header: tabs + format toggle + spinner */}
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <div className="flex rounded-lg border border-violet-200 dark:border-violet-900/50 overflow-hidden text-xs font-semibold">
                      <button
                        type="button"
                        onClick={() => setAiMode('generate')}
                        className={`flex items-center gap-1.5 px-3 py-1.5 transition-colors ${aiMode === 'generate' ? 'bg-violet-600 text-white' : 'text-violet-700 hover:bg-violet-100 dark:text-violet-300 dark:hover:bg-violet-900/30'}`}
                      >
                        <Sparkles size={12} /> Generate
                      </button>
                      <button
                        type="button"
                        onClick={() => setAiMode('refine')}
                        className={`flex items-center gap-1.5 px-3 py-1.5 transition-colors ${aiMode === 'refine' ? 'bg-violet-600 text-white' : 'text-violet-700 hover:bg-violet-100 dark:text-violet-300 dark:hover:bg-violet-900/30'}`}
                      >
                        💬 Refine
                      </button>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {/* Format toggle */}
                      <div className="flex rounded-lg border border-violet-200 dark:border-violet-900/50 overflow-hidden text-xs font-medium">
                        <button
                          type="button"
                          onClick={() => { setEditorFormat('markdown'); setHtmlViewMode('edit'); }}
                          className={`px-3 py-1.5 transition-colors ${editorFormat === 'markdown' ? 'bg-violet-600 text-white' : 'text-violet-700 hover:bg-violet-100 dark:text-violet-300 dark:hover:bg-violet-900/30'}`}
                        >
                          Markdown
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditorFormat('html')}
                          className={`px-3 py-1.5 transition-colors ${editorFormat === 'html' ? 'bg-violet-600 text-white' : 'text-violet-700 hover:bg-violet-100 dark:text-violet-300 dark:hover:bg-violet-900/30'}`}
                        >
                          HTML
                        </button>
                      </div>
                      {aiLoading && <Loader2 size={16} className="animate-spin text-violet-600 dark:text-violet-300" />}
                    </div>
                  </div>

                  {/* ── Generate tab ─────────────────────────────────────────── */}
                  {aiMode === 'generate' && (<>
                    <p className="mb-4 text-xs text-violet-700/80 dark:text-violet-300/80">
                      Pull in work items, recordings, and repo context, then generate a fresh draft.
                    </p>
                    <div className="grid gap-4 lg:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">Work Item</label>
                        <div className="relative">
                          <div className="flex gap-2">
                            <input
                              className={inputClass}
                              value={workItemInput}
                              onChange={(event) => {
                                setWorkItemInput(event.target.value);
                                setWorkItemSearchOpen(true);
                                if (!event.target.value.trim()) setLoadedWorkItem(null);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' && workItemInput.trim()) handleLoadWorkItem();
                                if (event.key === 'Escape') setWorkItemSearchOpen(false);
                              }}
                              onFocus={() => workItemInput.trim() && setWorkItemSearchOpen(true)}
                              placeholder="Search by ID or title…"
                            />
                            {loadedWorkItem && (
                              <button
                                type="button"
                                onClick={() => { setLoadedWorkItem(null); setWorkItemInput(''); }}
                                className="shrink-0 rounded-xl border border-gray-200 px-2 py-1 text-xs text-gray-400 hover:text-red-500 dark:border-gray-700"
                              >✕</button>
                            )}
                          </div>
                          {workItemSearchOpen && debouncedWorkItemSearch.length >= 2 && (
                            <div className="absolute z-20 mt-1 w-full rounded-xl border border-violet-200 bg-white shadow-lg dark:border-violet-900/50 dark:bg-gray-900">
                              {workItemSearchQuery.isFetching ? (
                                <div className="flex items-center gap-2 px-3 py-3 text-xs text-gray-500">
                                  <Loader2 size={12} className="animate-spin" /> Searching…
                                </div>
                              ) : (workItemSearchQuery.data?.data ?? []).length === 0 ? (
                                <div className="px-3 py-3 text-xs text-gray-400">No work items found</div>
                              ) : (
                                <div className="max-h-48 overflow-y-auto">
                                  {(workItemSearchQuery.data?.data ?? []).map((wi) => (
                                    <button
                                      key={wi.id}
                                      type="button"
                                      onClick={() => {
                                        setWorkItemInput(String(wi.id));
                                        setWorkItemSearchOpen(false);
                                        setLoadedWorkItem({ id: wi.id, title: String(wi.title ?? ''), type: String(wi.type ?? ''), state: String(wi.state ?? '') });
                                      }}
                                      className="flex w-full items-start gap-2 border-b border-gray-100 px-3 py-2 text-left last:border-0 hover:bg-violet-50 dark:border-gray-800 dark:hover:bg-violet-900/20"
                                    >
                                      <span className="mt-0.5 shrink-0 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">{String(wi.type ?? '')}</span>
                                      <span className="flex-1 text-xs text-gray-800 dark:text-gray-200">#{wi.id} — {String(wi.title ?? '')}</span>
                                      <span className="shrink-0 text-[10px] text-gray-400">{String(wi.state ?? '')}</span>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                        {loadedWorkItem && (
                          <div className="mt-2 rounded-xl border border-violet-200 bg-white px-3 py-2 dark:border-violet-900/40 dark:bg-gray-900/60">
                            <div className="flex items-center gap-2">
                              <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
                                {loadedWorkItem.type}
                              </span>
                              <span className="text-[11px] text-gray-500 dark:text-gray-400">#{loadedWorkItem.id}</span>
                            </div>
                            <div className="mt-1 text-sm font-medium text-gray-900 dark:text-white">{loadedWorkItem.title}</div>
                          </div>
                        )}
                        {!loadedWorkItem && !workItemInput.trim() && (
                          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">Type an ID or title keyword to search</p>
                        )}
                      </div>

                      {activeTeamsMcpId && (
                        <div>
                          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">Teams Recording</label>
                          <select
                            className={inputClass}
                            value={selectedRecordingId}
                            onChange={(event) => setSelectedRecordingId(event.target.value)}
                          >
                            <option value="">Select a recording</option>
                            {recordings.map((recording) => (
                              <option key={recording.id} value={recording.id}>
                                {recording.title ?? recording.id}
                              </option>
                            ))}
                          </select>
                          {recordingsQuery.isFetching && (
                            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">Loading recordings…</p>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="mt-4 grid gap-4">
                      <div>
                        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">Repo context</label>
                        {projectRepos.length > 0 && (
                          <div className="mb-2 flex gap-2">
                            <select
                              className={inputClass}
                              value={selectedRepoId}
                              onChange={(event) => {
                                setSelectedRepoId(event.target.value);
                                setRepoBrowserOpen(false);
                                setRepoBrowsePath('/');
                              }}
                            >
                              <option value="">Select a repo...</option>
                              {projectRepos.map((repo) => (
                                <option key={repo.id} value={repo.id}>{repo.label || repo.repoName}</option>
                              ))}
                            </select>
                            {selectedRepoId && (
                              <button
                                type="button"
                                onClick={() => setRepoBrowserOpen((current) => !current)}
                                className="shrink-0 rounded-xl border border-violet-300 bg-white px-3 py-2 text-sm font-medium text-violet-700 hover:bg-violet-50 dark:border-violet-700 dark:bg-gray-900 dark:text-violet-300 dark:hover:bg-violet-900/20"
                              >
                                {repoBrowserOpen ? 'Close' : 'Browse'}
                              </button>
                            )}
                          </div>
                        )}
                        {repoBrowserOpen && selectedRepoId && (
                          <div className="mb-2 rounded-xl border border-violet-200 bg-white dark:border-violet-900/40 dark:bg-gray-900/60">
                            <div className="flex items-center gap-2 border-b border-violet-100 px-3 py-2 dark:border-violet-900/20">
                              <span className="text-xs text-gray-500">Path:</span>
                              <span className="text-xs font-mono text-gray-700 dark:text-gray-300">{repoBrowsePath}</span>
                              {repoBrowsePath !== '/' && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    const parent = repoBrowsePath.split('/').slice(0, -1).join('/') || '/';
                                    setRepoBrowsePath(parent);
                                  }}
                                  className="ml-auto text-xs text-violet-600 hover:underline dark:text-violet-400"
                                >← Up</button>
                              )}
                            </div>
                            <div className="max-h-48 overflow-y-auto p-2">
                              {repoTreeQuery.isLoading ? (
                                <p className="py-4 text-center text-xs text-gray-500">Loading…</p>
                              ) : repoTreeQuery.isError ? (
                                <p className="py-4 text-center text-xs text-red-500">
                                  {(repoTreeQuery.error as Error)?.message ?? 'Failed to load tree. Check repo connection & branch.'}
                                </p>
                              ) : treeItems.length === 0 ? (
                                <p className="py-4 text-center text-xs text-gray-500">No items found</p>
                              ) : (
                                <div className="space-y-1">
                                  {treeItems.map((item) => (
                                    <div key={item.path} className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-violet-50 dark:hover:bg-violet-900/20">
                                      <button
                                        type="button"
                                        onClick={() => {
                                          if (item.type === 'tree') {
                                            setRepoBrowsePath(item.path);
                                          } else {
                                            toggleRepoContextItem(item.path);
                                          }
                                        }}
                                        className="flex flex-1 items-center gap-2 text-left text-xs text-gray-700 dark:text-gray-300"
                                      >
                                        <span>{item.type === 'tree' ? '📁' : '📄'}</span>
                                        <span>{item.name}</span>
                                        {item.type === 'tree' && <span className="ml-auto text-gray-400">→</span>}
                                      </button>
                                      {item.type === 'blob' && (
                                        <input
                                          type="checkbox"
                                          checked={selectedRepoEntries.has(item.path)}
                                          onChange={() => toggleRepoContextItem(item.path)}
                                          className="h-3 w-3 rounded accent-violet-600"
                                        />
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                        <textarea
                          rows={2}
                          className={inputClass}
                          value={repoQueryInput}
                          onChange={(event) => setRepoQueryInput(event.target.value)}
                          placeholder="Selected files appear here, or type keywords: README, onboarding"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">Custom instructions</label>
                        <textarea
                          rows={3}
                          className={inputClass}
                          value={customInstructions}
                          onChange={(event) => setCustomInstructions(event.target.value)}
                          placeholder="What should this page cover? Any special focus?"
                        />
                      </div>
                      {editorFormat === 'html' && wikiStyles.length > 0 && (
                        <div>
                          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">
                            HTML Style
                          </label>
                          <select
                            className={inputClass}
                            value={selectedStyleSkillId}
                            onChange={(event) => setSelectedStyleSkillId(event.target.value)}
                          >
                            <option value="">Default (built-in Nobilis Green)</option>
                            {wikiStyles.map((style) => (
                              <option key={style.id} value={style.id}>
                                {style.name}{style.builtIn ? ' ✦' : ''}
                              </option>
                            ))}
                          </select>
                          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                            Create custom styles in the Skills section (type: wiki-style).
                          </p>
                        </div>
                      )}

                      {/* ── AI Model + Agent + Skills ───────────────────────── */}
                      <div className="rounded-xl border border-violet-100 bg-violet-50/50 p-3 dark:border-violet-900/30 dark:bg-violet-950/20">
                        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">AI Configuration</div>
                        <div className="space-y-3">
                          {/* Model */}
                          <div>
                            <label className="mb-1 block text-xs font-semibold text-gray-600 dark:text-gray-400">
                              Model{selectedAgentId ? ' (overridden by agent)' : ''}
                            </label>
                            <select
                              className={inputClass}
                              value={selectedModel.startsWith('custom:') ? 'custom' : selectedModel}
                              onChange={(event) => {
                                if (event.target.value === 'custom') setSelectedModel('custom:');
                                else setSelectedModel(event.target.value);
                              }}
                              disabled={!!selectedAgentId}
                            >
                              <option value="">Default (gpt-4o-mini)</option>
                              <optgroup label="OpenAI GPT">
                                <option value="gpt-4o-mini">gpt-4o-mini — fast, cheap</option>
                                <option value="gpt-4o">gpt-4o — smarter, balanced</option>
                                <option value="gpt-4.1-mini">gpt-4.1-mini — fast + capable</option>
                                <option value="gpt-4.1">gpt-4.1 — most capable GPT</option>
                                <option value="o4-mini">o4-mini — reasoning</option>
                              </optgroup>
                              <optgroup label="OpenAI Codex">
                                <option value="codex-mini-latest">codex-mini-latest — code-focused</option>
                              </optgroup>
                              <optgroup label="Anthropic Claude (GitHub Models)">
                                <option value="claude-3-5-sonnet">claude-3-5-sonnet</option>
                                <option value="claude-3-7-sonnet">claude-3-7-sonnet</option>
                                <option value="claude-sonnet-4-5">claude-sonnet-4-5</option>
                                <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
                              </optgroup>
                              <option value="custom">Custom model ID…</option>
                            </select>
                            {selectedModel.startsWith('custom:') && (
                              <input
                                type="text"
                                className={`${inputClass} mt-1 font-mono text-xs`}
                                placeholder="e.g. claude-sonnet-4-6 or gpt-4.5"
                                value={selectedModel.slice(7)}
                                onChange={(event) => setSelectedModel(`custom:${event.target.value}`)}
                              />
                            )}
                            <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                              Uses GitHub Models API — model must be in the{' '}
                              <a href="https://github.com/marketplace/models" target="_blank" rel="noreferrer" className="underline text-violet-500">GitHub Models catalog</a>.
                            </p>
                          </div>
                          {/* Agent */}
                          {projectAgents.length > 0 && (
                            <div>
                              <label className="mb-1 block text-xs font-semibold text-gray-600 dark:text-gray-400">Agent</label>
                              <select
                                className={inputClass}
                                value={selectedAgentId}
                                onChange={(event) => setSelectedAgentId(event.target.value)}
                              >
                                <option value="">No agent</option>
                                {projectAgents.map((agent) => (
                                  <option key={agent.id} value={agent.id}>
                                    {agent.name}{agent.model ? ` (${agent.model})` : ''}
                                  </option>
                                ))}
                              </select>
                              {selectedAgentId && (() => {
                                const ag = projectAgents.find((a) => a.id === selectedAgentId);
                                return ag?.description ? (
                                  <p className="mt-1 text-xs text-gray-400 dark:text-gray-500 line-clamp-2">{ag.description}</p>
                                ) : null;
                              })()}
                            </div>
                          )}
                          {/* Extra skills (only shown when no agent, or in addition) */}
                          {promptSkills.length > 0 && (
                            <div>
                              <label className="mb-1 block text-xs font-semibold text-gray-600 dark:text-gray-400">
                                Extra skills <span className="font-normal text-gray-400">(prompt injection)</span>
                              </label>
                              <div className="max-h-28 overflow-y-auto rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
                                {promptSkills.map((skill) => (
                                  <label key={skill.id} className="flex cursor-pointer items-center gap-2 border-b border-gray-100 px-3 py-1.5 last:border-0 hover:bg-violet-50 dark:border-gray-800 dark:hover:bg-violet-900/20">
                                    <input
                                      type="checkbox"
                                      className="accent-violet-600"
                                      checked={selectedSkillIds.includes(skill.id)}
                                      onChange={(event) => setSelectedSkillIds((prev) =>
                                        event.target.checked ? [...prev, skill.id] : prev.filter((id) => id !== skill.id)
                                      )}
                                    />
                                    <span className="text-xs text-gray-700 dark:text-gray-300">{skill.name}</span>
                                  </label>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="mt-4 rounded-2xl border border-violet-200 bg-white p-3 dark:border-violet-900/40 dark:bg-gray-950/40">
                      <div className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">
                        <span>Generation log</span>
                        {aiStreamText && <span>{aiStreamText.length} streamed chars</span>}
                      </div>
                      <div ref={aiLogRef} className="max-h-40 space-y-2 overflow-y-auto pr-1 text-xs text-gray-600 dark:text-gray-300">
                        {aiLogs.length === 0 ? (
                          <p className="text-gray-500 dark:text-gray-400">Logs will appear here while AI builds the draft.</p>
                        ) : (
                          aiLogs.map((log, index) => (
                            <div key={`${log}-${index}`} className="flex items-start gap-2">
                              {aiLoading && index === aiLogs.length - 1 ? (
                                <Loader2 size={12} className="mt-0.5 shrink-0 animate-spin text-violet-500" />
                              ) : (
                                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500" />
                              )}
                              <span>{log}</span>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                      <p className="text-xs text-violet-700/80 dark:text-violet-300/80">
                        After generating, switch to the Refine tab to iterate before saving.
                      </p>
                      <button
                        type="button"
                        onClick={() => void handleGenerate()}
                        disabled={aiLoading}
                        className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
                      >
                        {aiLoading ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
                        {aiLoading ? 'Generating…' : 'Generate'}
                      </button>
                    </div>
                  </>)}

                  {/* ── Refine tab ───────────────────────────────────────────── */}
                  {aiMode === 'refine' && (
                    <div className="flex flex-col gap-3">
                      {chatHistory.length === 0 && !draft.content.trim() && (
                        <p className="text-xs text-violet-700/80 dark:text-violet-300/80">
                          Generate a draft first, then ask the AI to adjust it here.
                        </p>
                      )}
                      {chatHistory.length === 0 && draft.content.trim() && (
                        <p className="text-xs text-violet-700/80 dark:text-violet-300/80">
                          The AI will modify the current draft based on your instructions. Ask for any changes!
                        </p>
                      )}

                      {/* Chat history */}
                      {chatHistory.length > 0 && (
                        <div className="max-h-72 space-y-3 overflow-y-auto rounded-2xl border border-violet-200 bg-white p-3 dark:border-violet-900/40 dark:bg-gray-950/40">
                          {chatHistory.map((msg, i) => (
                            <div key={i} className={`flex gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                              <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                                msg.role === 'user'
                                  ? 'bg-violet-600 text-white rounded-br-sm'
                                  : 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200 rounded-bl-sm'
                              }`}>
                                {msg.role === 'user' ? msg.content : '✅ Content updated'}
                              </div>
                            </div>
                          ))}
                          {aiLoading && (
                            <div className="flex justify-start gap-2">
                              <div className="rounded-2xl rounded-bl-sm bg-gray-100 px-3 py-2 dark:bg-gray-800">
                                <Loader2 size={14} className="animate-spin text-violet-500" />
                              </div>
                            </div>
                          )}
                          <div ref={chatEndRef} />
                        </div>
                      )}

                      {/* Input */}
                      <div className="flex gap-2">
                        <textarea
                          ref={refineInputRef}
                          rows={2}
                          className={`${inputClass} resize-none`}
                          defaultValue=""
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              void handleRefine();
                            }
                          }}
                          placeholder="e.g. Change the hero color to blue, add a troubleshooting section, translate to English…"
                          disabled={aiLoading}
                        />
                        <button
                          type="button"
                          onClick={() => void handleRefine()}
                          disabled={aiLoading}
                          className="shrink-0 rounded-xl bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
                        >
                          {aiLoading ? <Loader2 size={15} className="animate-spin" /> : '↑'}
                        </button>
                      </div>
                      <p className="text-[11px] text-violet-600/70 dark:text-violet-400/60">Enter to send · Shift+Enter for new line · each reply updates the editor</p>
                    </div>
                  )}
                </div>
              )}

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Description</label>
                <input
                  className={inputClass}
                  value={draft.description}
                  onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
                  placeholder="Short summary shown in search results"
                />
              </div>

              <div>
                <div className="mb-1 flex items-center gap-2">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Content</label>
                  {/* Inline format toggle */}
                  <div className="flex rounded-md border border-gray-200 dark:border-gray-700 overflow-hidden text-xs font-medium">
                    <button
                      type="button"
                      onClick={() => { setEditorFormat('markdown'); setHtmlViewMode('edit'); }}
                      className={`px-2.5 py-0.5 transition-colors ${editorFormat === 'markdown' ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`}
                    >
                      Markdown
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditorFormat('html')}
                      className={`px-2.5 py-0.5 transition-colors ${editorFormat === 'html' ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`}
                    >
                      HTML
                    </button>
                  </div>
                  {editorFormat === 'html' && (
                    <>
                      <span className="text-xs text-gray-400 dark:text-gray-500">Wiki.js HTML editor — inline CSS only</span>
                      {/* Edit / Preview toggle for HTML */}
                      <div className="ml-auto flex rounded-md border border-gray-200 dark:border-gray-700 overflow-hidden text-xs font-medium">
                        <button
                          type="button"
                          onClick={() => setHtmlViewMode('edit')}
                          className={`px-2.5 py-0.5 transition-colors ${htmlViewMode === 'edit' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => setHtmlViewMode('preview')}
                          className={`px-2.5 py-0.5 transition-colors ${htmlViewMode === 'preview' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`}
                        >
                          Preview
                        </button>
                      </div>
                    </>
                  )}
                </div>
                {editorFormat === 'html' && htmlViewMode === 'preview' ? (
                  <iframe
                    key={draft.content}
                    srcDoc={`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;padding:16px;background:#fff;}</style></head><body>${draft.content}</body></html>`}
                    sandbox="allow-same-origin"
                    className="min-h-[360px] w-full rounded-2xl border border-gray-200 bg-white dark:border-gray-700"
                    title="HTML Preview"
                  />
                ) : (
                  <textarea
                    className="min-h-[360px] w-full rounded-2xl border border-gray-200 bg-gray-50 px-3 py-3 font-mono text-sm text-gray-900 focus:border-indigo-400 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                    value={draft.content}
                    onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))}
                    placeholder={editorFormat === 'html' ? '<div style="...">\n  <!-- Your HTML content here -->\n</div>' : '# Overview'}
                  />
                )}
              </div>

              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => saveMutation.mutate({ ...draft, editorFormat })}
                  disabled={!draft.path.trim() || !draft.title.trim() || saveMutation.isPending}
                  className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  {saveMutation.isPending ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
                  Save to Wiki
                </button>
                <button
                  type="button"
                  onClick={() => setAiPanelOpen((current) => !current)}
                  className="rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                  {aiPanelOpen ? 'Hide AI panel' : 'Show AI panel'}
                </button>
              </div>
            </div>
          ) : pageQuery.isLoading ? (
            <div className="flex min-h-[420px] items-center justify-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <Loader2 size={16} className="animate-spin" /> Loading page…
            </div>
          ) : selectedPath && !isCreating && !pageQuery.isLoading && !currentPage ? (
            <div className="flex min-h-[420px] flex-col items-center justify-center text-center">
              <BookOpen size={42} className="mb-4 text-amber-400 dark:text-amber-600" />
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Page not found</h3>
              <p className="mt-2 max-w-md text-sm text-gray-500 dark:text-gray-400">
                <code className="rounded bg-gray-100 px-1.5 py-0.5 dark:bg-gray-800">{selectedPath}</code> does not exist yet. You can create it as a new page.
              </p>
              <button
                type="button"
                onClick={() => startNewPage(selectedPath, false)}
                className="mt-4 inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
              >
                <FilePlus2 size={15} /> Create this page
              </button>
            </div>
          ) : currentPage ? (
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
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={toggleAiPanel}
                      className="inline-flex items-center gap-2 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-sm font-medium text-violet-700 hover:bg-violet-100 dark:border-violet-900/50 dark:bg-violet-900/20 dark:text-violet-300"
                    >
                      <Sparkles size={15} /> Generate with AI
                    </button>
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
                      type="button"
                      onClick={() => startEditPage(currentPage)}
                      className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
                    >
                      <PencilLine size={15} /> Edit
                    </button>
                  </div>
                </div>

                {currentPage.description && (
                  <p className="text-sm text-gray-500 dark:text-gray-400">{currentPage.description}</p>
                )}
                <div className="rounded-2xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-950/40">
                  <div
                    className="prose prose-sm max-w-none dark:prose-invert prose-headings:font-semibold prose-a:text-indigo-500 prose-table:text-xs"
                    dangerouslySetInnerHTML={{ __html: currentPage.content || '<p>No content available.</p>' }}
                  />
                </div>
              </div>
          ) : (
            <div className="flex min-h-[420px] flex-col items-center justify-center text-center">
              <BookOpen size={42} className="mb-4 text-emerald-400 dark:text-emerald-600" />
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Select a page to get started</h3>
              <p className="mt-2 max-w-md text-sm text-gray-500 dark:text-gray-400">
                Search Wiki.js, explore the page tree, or create a new page for this project.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
