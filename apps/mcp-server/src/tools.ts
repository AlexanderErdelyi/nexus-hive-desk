import * as fs from 'fs';
import * as path from 'path';
import { XMLParser } from 'fast-xml-parser';
import {
  GlossaryEntry,
  TmEntry,
  readGlossary,
  readTm,
  writeGlossary,
  writeTm,
} from './storage.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ParsedUnit {
  id: string;
  source: string;
  target: string;
  state: string;
  note: string;
}

interface ParsedXliff {
  units: ParsedUnit[];
  sourceLanguage: string;
  targetLanguage: string;
}

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

// ─── Self-contained XLIFF parsing (no @nexus/xliff dependency) ────────────────

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: false,
  isArray: (name) => ['trans-unit', 'file', 'note', 'group'].includes(name),
});

function textOf(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (typeof node === 'object') {
    const rec = node as Record<string, unknown>;
    if ('#text' in rec) return textOf(rec['#text']);
  }
  return '';
}

/** Recursively collect every `trans-unit` array found anywhere in the object tree. */
function collectTransUnits(node: unknown, out: Record<string, unknown>[]): void {
  if (node == null || typeof node !== 'object') return;
  const rec = node as Record<string, unknown>;
  if (Array.isArray(rec['trans-unit'])) {
    for (const u of rec['trans-unit'] as unknown[]) {
      if (u && typeof u === 'object') out.push(u as Record<string, unknown>);
    }
  }
  for (const key of Object.keys(rec)) {
    const val = rec[key];
    if (Array.isArray(val)) {
      for (const item of val) collectTransUnits(item, out);
    } else if (val && typeof val === 'object') {
      collectTransUnits(val, out);
    }
  }
}

function parseXliffContent(xml: string): ParsedXliff {
  const doc = xmlParser.parse(xml) as Record<string, unknown>;
  const xliff = (doc['xliff'] ?? doc) as Record<string, unknown>;
  const files = Array.isArray((xliff as Record<string, unknown>)['file'])
    ? ((xliff as Record<string, unknown>)['file'] as Record<string, unknown>[])
    : [];
  const firstFile = files[0] ?? {};
  const sourceLanguage = String(firstFile['@_source-language'] ?? 'en');
  const targetLanguage = String(firstFile['@_target-language'] ?? '');

  const rawUnits: Record<string, unknown>[] = [];
  collectTransUnits(xliff, rawUnits);

  const units: ParsedUnit[] = rawUnits.map((u) => {
    const id = String(u['@_id'] ?? '');
    const source = textOf(u['source']);
    const targetNode = u['target'];
    const target = textOf(targetNode);
    let state = '';
    if (targetNode && typeof targetNode === 'object' && !Array.isArray(targetNode)) {
      state = String((targetNode as Record<string, unknown>)['@_state'] ?? '');
    }
    const notes = Array.isArray(u['note']) ? (u['note'] as unknown[]) : u['note'] ? [u['note']] : [];
    let note = '';
    for (const n of notes) {
      const t = textOf(n);
      if (t) {
        note = t;
        break;
      }
    }
    // Infer a sensible state when none is present.
    if (!state) {
      state = target && target.trim() ? 'translated' : 'needs-translation';
    }
    return { id, source, target, state, note };
  });

  return { units, sourceLanguage, targetLanguage };
}

const CONFIRMED_STATES = new Set(['translated', 'final', 'signed-off']);

// ─── Levenshtein similarity (threshold 0.75) ──────────────────────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a.toLowerCase(), b.toLowerCase()) / maxLen;
}

const FUZZY_THRESHOLD = 0.75;

// ─── Filesystem helpers ───────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out']);

function findXliffFiles(root: string): string[] {
  const result: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.xlf')) {
        result.push(full);
      }
    }
  };
  walk(root);
  return result.map((f) => path.relative(root, f).split(path.sep).join('/'));
}

function resolveFilePath(workspaceRoot: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);
}

// ─── Tool definitions (for ListTools) ────────────────────────────────────────

export function createTools(_workspaceRoot: string): Array<Record<string, unknown>> {
  return [
    {
      name: 'list_xliff_files',
      description:
        'Recursively find all .xlf (XLIFF) files in the workspace. Skips node_modules, .git, dist and out folders.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'read_xliff_translations',
      description:
        'Read and parse an XLIFF file and return its translation units. By default only units with a non-empty target are returned.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Path to the .xlf file (relative to workspace root or absolute).' },
          includeAll: { type: 'boolean', description: 'If true, also return units that have no target. Defaults to false.' },
        },
        required: ['filePath'],
      },
    },
    {
      name: 'get_glossary',
      description: 'Return all glossary entries, optionally filtered by language pair.',
      inputSchema: {
        type: 'object',
        properties: {
          sourceLanguage: { type: 'string' },
          targetLanguage: { type: 'string' },
        },
      },
    },
    {
      name: 'add_glossary_term',
      description: 'Add a new glossary term.',
      inputSchema: {
        type: 'object',
        properties: {
          sourceTerm: { type: 'string' },
          targetTerm: { type: 'string' },
          sourceLanguage: { type: 'string' },
          targetLanguage: { type: 'string' },
          description: { type: 'string' },
          caseSensitive: { type: 'boolean' },
        },
        required: ['sourceTerm', 'targetTerm', 'sourceLanguage', 'targetLanguage'],
      },
    },
    {
      name: 'delete_glossary_term',
      description: 'Delete a glossary term by its id.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
    {
      name: 'update_glossary_term',
      description: 'Update the source term, target term and/or description of an existing glossary entry.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          sourceTerm: { type: 'string' },
          targetTerm: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['id'],
      },
    },
    {
      name: 'get_tm_stats',
      description: 'Return Translation Memory statistics, optionally filtered by language pair.',
      inputSchema: {
        type: 'object',
        properties: {
          sourceLanguage: { type: 'string' },
          targetLanguage: { type: 'string' },
        },
      },
    },
    {
      name: 'populate_tm_from_xliff',
      description: 'Import all translated/final/signed-off units from an XLIFF file into the Translation Memory.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Path to the .xlf file (relative to workspace root or absolute).' },
        },
        required: ['filePath'],
      },
    },
    {
      name: 'search_tm',
      description: 'Search the Translation Memory for a source string (exact or fuzzy via Levenshtein similarity).',
      inputSchema: {
        type: 'object',
        properties: {
          sourceText: { type: 'string' },
          sourceLanguage: { type: 'string' },
          targetLanguage: { type: 'string' },
          fuzzy: { type: 'boolean', description: 'If true, return fuzzy matches above 0.75 similarity. Defaults to false (exact match).' },
        },
        required: ['sourceText', 'sourceLanguage', 'targetLanguage'],
      },
    },
    {
      name: 'analyze_translations_for_glossary',
      description:
        'Return structured translation data (source/target pairs + existing glossary) so the LLM can suggest new glossary terms. Does not call an AI itself.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Path to the .xlf file (relative to workspace root or absolute).' },
          limit: { type: 'number', description: 'Maximum number of translated pairs to return. Defaults to 100.' },
        },
        required: ['filePath'],
      },
    },
  ];
}

// ─── Tool execution ───────────────────────────────────────────────────────────

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }], isError: true };
}

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  workspaceRoot: string
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'list_xliff_files': {
        const files = findXliffFiles(workspaceRoot);
        return ok({ files });
      }

      case 'read_xliff_translations': {
        const filePath = String(args.filePath ?? '');
        if (!filePath) return fail('filePath is required');
        const full = resolveFilePath(workspaceRoot, filePath);
        if (!fs.existsSync(full)) return fail(`File not found: ${filePath}`);
        const includeAll = args.includeAll === true;
        const parsed = parseXliffContent(fs.readFileSync(full, 'utf-8'));
        const filtered = includeAll
          ? parsed.units
          : parsed.units.filter((u) => u.target && u.target.trim());
        return ok({
          units: filtered.map((u) => ({ id: u.id, source: u.source, target: u.target, state: u.state, note: u.note })),
          sourceLanguage: parsed.sourceLanguage,
          targetLanguage: parsed.targetLanguage,
          totalCount: parsed.units.length,
          translatedCount: parsed.units.filter((u) => u.target && u.target.trim()).length,
        });
      }

      case 'get_glossary': {
        const srcLang = args.sourceLanguage ? String(args.sourceLanguage) : undefined;
        const tgtLang = args.targetLanguage ? String(args.targetLanguage) : undefined;
        const entries = readGlossary(workspaceRoot).filter(
          (e) =>
            (srcLang ? e.sourceLanguage === srcLang : true) &&
            (tgtLang ? e.targetLanguage === tgtLang : true)
        );
        return ok({ entries, count: entries.length });
      }

      case 'add_glossary_term': {
        const sourceTerm = String(args.sourceTerm ?? '');
        const targetTerm = String(args.targetTerm ?? '');
        const sourceLanguage = String(args.sourceLanguage ?? '');
        const targetLanguage = String(args.targetLanguage ?? '');
        if (!sourceTerm || !targetTerm || !sourceLanguage || !targetLanguage) {
          return fail('sourceTerm, targetTerm, sourceLanguage and targetLanguage are required');
        }
        const entries = readGlossary(workspaceRoot);
        const entry: GlossaryEntry = {
          id: Date.now().toString() + Math.random().toString(36).slice(2, 8),
          sourceTerm,
          targetTerm,
          sourceLanguage,
          targetLanguage,
          description: args.description ? String(args.description) : undefined,
          caseSensitive: args.caseSensitive === true,
          createdAt: new Date().toISOString(),
        };
        entries.push(entry);
        writeGlossary(workspaceRoot, entries);
        return ok({ success: true, entry });
      }

      case 'delete_glossary_term': {
        const id = String(args.id ?? '');
        if (!id) return fail('id is required');
        const entries = readGlossary(workspaceRoot);
        const next = entries.filter((e) => e.id !== id);
        writeGlossary(workspaceRoot, next);
        return ok({ success: true });
      }

      case 'update_glossary_term': {
        const id = String(args.id ?? '');
        if (!id) return fail('id is required');
        const entries = readGlossary(workspaceRoot);
        const entry = entries.find((e) => e.id === id);
        if (!entry) return fail(`Glossary term not found: ${id}`);
        if (args.sourceTerm !== undefined) entry.sourceTerm = String(args.sourceTerm);
        if (args.targetTerm !== undefined) entry.targetTerm = String(args.targetTerm);
        if (args.description !== undefined) entry.description = String(args.description);
        writeGlossary(workspaceRoot, entries);
        return ok({ success: true, entry });
      }

      case 'get_tm_stats': {
        const srcLang = args.sourceLanguage ? String(args.sourceLanguage) : undefined;
        const tgtLang = args.targetLanguage ? String(args.targetLanguage) : undefined;
        const entries = readTm(workspaceRoot).filter(
          (e) =>
            (srcLang ? e.sourceLanguage === srcLang : true) &&
            (tgtLang ? e.targetLanguage === tgtLang : true)
        );
        const pairs = new Map<string, number>();
        for (const e of entries) {
          const key = `${e.sourceLanguage} → ${e.targetLanguage}`;
          pairs.set(key, (pairs.get(key) ?? 0) + 1);
        }
        return ok({
          totalEntries: entries.length,
          byLanguagePair: Array.from(pairs.entries()).map(([pair, count]) => ({ pair, count })),
        });
      }

      case 'populate_tm_from_xliff': {
        const filePath = String(args.filePath ?? '');
        if (!filePath) return fail('filePath is required');
        const full = resolveFilePath(workspaceRoot, filePath);
        if (!fs.existsSync(full)) return fail(`File not found: ${filePath}`);
        const parsed = parseXliffContent(fs.readFileSync(full, 'utf-8'));
        const total = parsed.units.length;
        const confirmed = parsed.units.filter(
          (u) => u.target && u.target.trim() && CONFIRMED_STATES.has(u.state)
        );
        const skipped = total - confirmed.length;

        const entries = readTm(workspaceRoot);
        const now = new Date().toISOString();
        let imported = 0;
        for (const u of confirmed) {
          const existing = entries.find(
            (e) =>
              e.source === u.source &&
              e.sourceLanguage === parsed.sourceLanguage &&
              e.targetLanguage === parsed.targetLanguage
          );
          if (existing) {
            if (existing.target !== u.target) {
              existing.target = u.target;
              existing.updatedAt = now;
            }
          } else {
            const entry: TmEntry = {
              source: u.source,
              target: u.target,
              sourceLanguage: parsed.sourceLanguage,
              targetLanguage: parsed.targetLanguage,
              usageCount: 1,
              updatedAt: now,
            };
            entries.push(entry);
          }
          imported++;
        }
        writeTm(workspaceRoot, entries);
        return ok({ imported, skipped, total });
      }

      case 'search_tm': {
        const sourceText = String(args.sourceText ?? '');
        const sourceLanguage = String(args.sourceLanguage ?? '');
        const targetLanguage = String(args.targetLanguage ?? '');
        if (!sourceText || !sourceLanguage || !targetLanguage) {
          return fail('sourceText, sourceLanguage and targetLanguage are required');
        }
        const fuzzy = args.fuzzy === true;
        const pool = readTm(workspaceRoot).filter(
          (e) => e.sourceLanguage === sourceLanguage && e.targetLanguage === targetLanguage
        );
        const matches: Array<{ source: string; target: string; score: number; usageCount: number }> = [];
        for (const e of pool) {
          if (fuzzy) {
            const score = similarity(sourceText, e.source);
            if (score >= FUZZY_THRESHOLD) {
              matches.push({ source: e.source, target: e.target, score: Math.round(score * 100), usageCount: e.usageCount });
            }
          } else if (e.source === sourceText) {
            matches.push({ source: e.source, target: e.target, score: 100, usageCount: e.usageCount });
          }
        }
        matches.sort((a, b) => b.score - a.score || b.usageCount - a.usageCount);
        return ok({ matches });
      }

      case 'analyze_translations_for_glossary': {
        const filePath = String(args.filePath ?? '');
        if (!filePath) return fail('filePath is required');
        const full = resolveFilePath(workspaceRoot, filePath);
        if (!fs.existsSync(full)) return fail(`File not found: ${filePath}`);
        const limit = typeof args.limit === 'number' ? args.limit : 100;
        const parsed = parseXliffContent(fs.readFileSync(full, 'utf-8'));
        const translated = parsed.units
          .filter((u) => u.target && u.target.trim())
          .slice(0, limit)
          .map((u) => ({ source: u.source, target: u.target, note: u.note }));
        const existingGlossary = readGlossary(workspaceRoot).filter(
          (e) => e.sourceLanguage === parsed.sourceLanguage && e.targetLanguage === parsed.targetLanguage
        );
        return ok({
          units: translated,
          sourceLanguage: parsed.sourceLanguage,
          targetLanguage: parsed.targetLanguage,
          existingGlossary,
          suggestion:
            'Based on the above translation pairs, identify technical terms, domain-specific vocabulary, and proper nouns that appear multiple times and would benefit from consistent translation. Suggest terms for the glossary.',
        });
      }

      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return fail((err as Error).message);
  }
}
