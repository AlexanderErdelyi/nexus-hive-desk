// ─── Customer ─────────────────────────────────────────────────────────────────
export interface Customer {
  id: string;
  name: string;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
  connections?: CustomerConnection[];
  projects?: Project[];
  _count?: { connections: number; projects: number };
}

export interface CreateCustomerInput {
  name: string;
  description?: string;
}

export type ConnectionType = 'azure-devops' | 'github';

export interface CustomerConnection {
  id: string;
  customerId: string;
  type: ConnectionType;
  name: string;
  baseUrl?: string;
  pat: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateConnectionInput {
  customerId: string;
  type: ConnectionType;
  name: string;
  baseUrl?: string;
  pat: string;
}

// ─── Remote Repository Browsing ──────────────────────────────────────────────
export interface RemoteOrganization {
  id: string;
  name: string;
}

export interface RemoteProject {
  id: string;
  name: string;
  description?: string;
}

export interface RemoteRepo {
  id: string;
  name: string;
  defaultBranch?: string;
  url?: string;
}

export interface RemoteBranch {
  name: string;
  isDefault?: boolean;
}

export interface RemoteFileEntry {
  path: string;
  name: string;
  type: 'file' | 'directory';
  size?: number;
}

export interface RemoteFileContent {
  path: string;
  content: string;
  sha?: string; // GitHub blob SHA for commit
  objectId?: string; // Azure DevOps object ID
}

export interface CommitFileInput {
  connectionId: string;
  repo: string; // "org/project/repo" (AzDO) or "owner/repo" (GitHub)
  branch: string;
  path: string;
  content: string;
  message: string;
  sha?: string; // required for GitHub updates
  objectId?: string; // required for Azure DevOps
}

// ─── Project ─────────────────────────────────────────────────────────────────
export interface Project {
  id: string;
  name: string;
  description?: string;
  customerId?: string;
  sourceLanguage: string;
  targetLanguage: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  customerId?: string;
  sourceLanguage: string;
  targetLanguage: string;
}

// ─── XLIFF / Translation ──────────────────────────────────────────────────────
export type TranslationState =
  | 'new'
  | 'needs-translation'
  | 'needs-review-translation'
  | 'translated'
  | 'final'
  | 'signed-off';

export interface Translation {
  id: string;
  projectId: string;
  xliffFileId: string;
  unitId: string;
  source: string;
  target: string;
  state: TranslationState;
  note?: string;
  developerNote?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpdateTranslationInput {
  target: string;
  state?: TranslationState;
}

export interface TranslationFilter {
  state?: TranslationState | TranslationState[];
  search?: string;
  untranslatedOnly?: boolean;
  page?: number;
  pageSize?: number;
}

// ─── XLIFF File ───────────────────────────────────────────────────────────────
export interface XliffFile {
  id: string;
  projectId: string;
  filename: string;
  sourceLanguage: string;
  targetLanguage: string;
  translationCount: number;
  translatedCount: number;
  uploadedAt: Date;
  remoteConnectionId?: string;
  remotePath?: string;
  remoteBranch?: string;
  remoteRepo?: string;
}

export interface XliffUnit {
  id: string;
  source: string;
  target: string;
  state: TranslationState;
  note?: string;
  developerNote?: string;
}

export interface ParsedXliff {
  sourceLanguage: string;
  targetLanguage: string;
  filename?: string;
  units: XliffUnit[];
}

// ─── Glossary ─────────────────────────────────────────────────────────────────
export interface GlossaryEntry {
  id: string;
  projectId: string;
  sourceTerm: string;
  targetTerm: string;
  sourceLanguage: string;
  targetLanguage: string;
  description?: string;
  caseSensitive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateGlossaryEntryInput {
  projectId: string;
  sourceTerm: string;
  targetTerm: string;
  sourceLanguage: string;
  targetLanguage: string;
  description?: string;
  caseSensitive?: boolean;
}

// ─── AI ───────────────────────────────────────────────────────────────────────
export type AIProviderType = 'github-models' | 'openai' | 'azure-openai' | 'ollama';

export interface AITranslateRequest {
  units: Array<{ id: string; source: string }>;
  sourceLanguage: string;
  targetLanguage: string;
  glossary?: Array<{ sourceTerm: string; targetTerm: string }>;
  context?: string;
}

export interface AITranslateResult {
  id: string;
  translatedText: string;
  confidence?: 'high' | 'medium' | 'low';
}

export interface AITranslateResponse {
  results: AITranslateResult[];
  provider: AIProviderType;
  model: string;
}

export type AIReviewQuality = 'good' | 'warning' | 'error';

export interface AIReviewUnit {
  id: string;
  source: string;
  target: string;
  context?: string; // BC metadata: "Table Brand Folder Mapping - Field Active - Property Caption"
}

export interface AIReviewResult {
  id: string;
  quality: AIReviewQuality;
  suggestion?: string; // better translation if warning/error
  reason?: string;     // brief explanation why it's wrong
}

export interface AIReviewRequest {
  units: AIReviewUnit[];
  sourceLanguage: string;
  targetLanguage: string;
  glossary?: Array<{ sourceTerm: string; targetTerm: string }>;
  additionalContext?: string;
}

export interface AIReviewResponse {
  results: AIReviewResult[];
  provider: AIProviderType;
  model: string;
}

// ─── AI Glossary ──────────────────────────────────────────────────────────────
export interface AIGlossarySuggestion {
  sourceTerm: string;
  targetTerm: string;
  description: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface AIGlossaryGenerateRequest {
  /** Sample of source+target pairs from the XLIFF */
  samples: Array<{ source: string; target: string; context?: string }>;
  sourceLanguage: string;
  targetLanguage: string;
  /** Existing glossary terms to skip */
  existingTerms?: string[];
}

export interface AIGlossaryPromptRequest {
  prompt: string; // e.g. "Customer=Debitor, Vendor=Kreditor, all financial terms"
  sourceLanguage: string;
  targetLanguage: string;
  existingTerms?: string[];
}

export interface AIGlossaryResponse {
  suggestions: AIGlossarySuggestion[];
  provider: AIProviderType;
  model: string;
}

// ─── API Response Wrappers ────────────────────────────────────────────────────
export interface ApiResponse<T> {
  data: T;
  meta?: {
    total?: number;
    page?: number;
    pageSize?: number;
  };
}

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}

// ─── Pagination ───────────────────────────────────────────────────────────────
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
