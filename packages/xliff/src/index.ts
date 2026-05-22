import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import type { ParsedXliff, TranslationState, XliffUnit } from '@nexus/types';

const PARSER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
};

const BUILDER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  format: true,
  indentBy: '  ',
  suppressEmptyNode: false,
};

// ─── State mapping ────────────────────────────────────────────────────────────
function normalizeState(raw?: string, targetText?: string, sourceText?: string): TranslationState {
  const map: Record<string, TranslationState> = {
    new: 'new',
    'needs-translation': 'needs-translation',
    'needs-review-translation': 'needs-review-translation',
    translated: 'translated',
    final: 'final',
    'signed-off': 'signed-off',
  };

  // If source == target (both non-empty), treat as translated regardless of explicit state.
  // BC Xliff Generator copies source → target as a placeholder and marks state="needs-translation".
  // But identical source/target almost always means the string is the same in both languages
  // (proper nouns, abbreviations, codes, numbers, etc.) — no translation needed.
  const trimmedSource = sourceText?.trim();
  const trimmedTarget = targetText?.trim();
  if (trimmedSource && trimmedTarget && trimmedSource === trimmedTarget) return 'translated';

  if (raw && map[raw]) return map[raw];
  // No state attribute — infer from target text
  if (targetText && targetText.trim()) return 'translated';
  return 'needs-translation';
}

function getText(node: unknown): string {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (typeof node === 'object' && node !== null && '#text' in (node as Record<string, unknown>)) {
    return String((node as Record<string, unknown>)['#text'] ?? '');
  }
  return '';
}

// ─── Parse XLIFF ──────────────────────────────────────────────────────────────
export function parseXliff(xmlContent: string): ParsedXliff {
  const parser = new XMLParser({
    ...PARSER_OPTIONS,
    isArray: (name) => ['trans-unit', 'file', 'note', 'group'].includes(name),
  });

  const parsed = parser.parse(xmlContent) as { xliff?: { file?: unknown } };
  const xliff = parsed?.xliff;

  if (!xliff) throw new Error('Invalid XLIFF: missing <xliff> root element');

  const files: unknown[] = Array.isArray(xliff.file) ? xliff.file : xliff.file ? [xliff.file] : [];
  if (files.length === 0) throw new Error('Invalid XLIFF: no <file> elements found');

  const file = files[0] as Record<string, unknown>;
  const attrs = file as Record<string, unknown>;

  const sourceLanguage = String(attrs['@_source-language'] ?? 'en');
  const targetLanguage = String(attrs['@_target-language'] ?? 'de');

  const body = file.body as Record<string, unknown> | undefined;

  // BC XLIFF wraps trans-units in a <group id="body"> element
  let rawUnits: unknown[] = Array.isArray(body?.['trans-unit'])
    ? (body['trans-unit'] as unknown[])
    : body?.['trans-unit']
      ? [body['trans-unit']]
      : [];

  if (rawUnits.length === 0 && body?.group) {
    const groups: unknown[] = Array.isArray(body.group) ? (body.group as unknown[]) : [body.group];
    for (const g of groups) {
      const grp = g as Record<string, unknown>;
      const groupUnits: unknown[] = Array.isArray(grp['trans-unit'])
        ? (grp['trans-unit'] as unknown[])
        : grp['trans-unit']
          ? [grp['trans-unit']]
          : [];
      rawUnits = rawUnits.concat(groupUnits);
    }
  }

  const units: XliffUnit[] = rawUnits.map((raw) => {
    const unit = raw as Record<string, unknown>;
    const id = String(unit['@_id'] ?? '');

    const sourceText = getText(unit.source);
    const target = unit.target as Record<string, unknown> | string | undefined;
    const targetText = getText(unit.target);
    const targetState = typeof target === 'object' && target !== null
      ? String(target['@_state'] ?? '')
      : '';

    const notes: unknown[] = Array.isArray(unit.note)
      ? (unit.note as unknown[])
      : unit.note
        ? [unit.note]
        : [];

    let note: string | undefined;
    let developerNote: string | undefined;
    for (const n of notes) {
      const nObj = n as Record<string, unknown>;
      const from = String(nObj['@_from'] ?? '');
      const annotates = String(nObj['@_annotates'] ?? '');
      const text = getText(nObj);
      if (from === 'Developer' || annotates === 'source') {
        developerNote = text;
      } else {
        note = text;
      }
    }

    return {
      id,
      source: sourceText,
      target: targetText,
      state: normalizeState(targetState, targetText, sourceText),
      note,
      developerNote,
    };
  });

  return { sourceLanguage, targetLanguage, units };
}

// ─── Serialize XLIFF ──────────────────────────────────────────────────────────
export function serializeXliff(
  original: string,
  updates: Map<string, { target: string; state: TranslationState }>
): string {
  const parser = new XMLParser({
    ...PARSER_OPTIONS,
    isArray: (name) => ['trans-unit', 'file', 'note', 'group'].includes(name),
    cdataPropName: '__cdata',
    preserveOrder: false,
  });

  const parsed = parser.parse(original) as { xliff?: { file?: Record<string, unknown>[] | Record<string, unknown> } };
  const xliff = parsed?.xliff;
  const files: Record<string, unknown>[] = Array.isArray(xliff?.file)
    ? xliff.file
    : xliff?.file
      ? [xliff.file]
      : [];

  for (const file of files) {
    const body = file.body as Record<string, unknown> | undefined;

    // Collect units from direct body or group wrapper (BC XLIFF)
    let units: Record<string, unknown>[] = Array.isArray(body?.['trans-unit'])
      ? (body['trans-unit'] as Record<string, unknown>[])
      : body?.['trans-unit']
        ? [body['trans-unit'] as Record<string, unknown>]
        : [];

    const groups: Record<string, unknown>[] = body?.group
      ? (Array.isArray(body.group) ? (body.group as Record<string, unknown>[]) : [body.group as Record<string, unknown>])
      : [];

    for (const unit of units) {
      const id = String(unit['@_id'] ?? '');
      const update = updates.get(id);
      if (!update) continue;
      const existingTarget = unit.target;
      if (typeof existingTarget === 'object' && existingTarget !== null) {
        (existingTarget as Record<string, unknown>)['#text'] = update.target;
        (existingTarget as Record<string, unknown>)['@_state'] = update.state;
      } else {
        unit.target = { '#text': update.target, '@_state': update.state };
      }
    }

    for (const grp of groups) {
      const groupUnits: Record<string, unknown>[] = Array.isArray(grp['trans-unit'])
        ? (grp['trans-unit'] as Record<string, unknown>[])
        : grp['trans-unit']
          ? [grp['trans-unit'] as Record<string, unknown>]
          : [];
      for (const unit of groupUnits) {
        const id = String(unit['@_id'] ?? '');
        const update = updates.get(id);
        if (!update) continue;
        const existingTarget = unit.target;
        if (typeof existingTarget === 'object' && existingTarget !== null) {
          (existingTarget as Record<string, unknown>)['#text'] = update.target;
          (existingTarget as Record<string, unknown>)['@_state'] = update.state;
        } else {
          unit.target = { '#text': update.target, '@_state': update.state };
        }
      }
    }
  }

  const builder = new XMLBuilder(BUILDER_OPTIONS);
  return `<?xml version="1.0" encoding="utf-8"?>\n${builder.build(parsed)}`;
}

// ─── Filter helpers ───────────────────────────────────────────────────────────
export function filterUnits(
  units: XliffUnit[],
  opts: {
    states?: TranslationState[];
    search?: string;
    untranslatedOnly?: boolean;
  }
): XliffUnit[] {
  let result = units;

  if (opts.untranslatedOnly) {
    result = result.filter((u) => u.state === 'new' || u.state === 'needs-translation' || !u.target);
  }

  if (opts.states && opts.states.length > 0) {
    const set = new Set(opts.states);
    result = result.filter((u) => set.has(u.state));
  }

  if (opts.search) {
    const q = opts.search.toLowerCase();
    result = result.filter(
      (u) =>
        u.source.toLowerCase().includes(q) ||
        u.target.toLowerCase().includes(q) ||
        u.id.toLowerCase().includes(q)
    );
  }

  return result;
}

// ─── Stats ────────────────────────────────────────────────────────────────────
export function getXliffStats(units: XliffUnit[]) {
  const total = units.length;
  const translated = units.filter(
    (u) => u.state === 'translated' || u.state === 'final' || u.state === 'signed-off'
  ).length;
  const needsTranslation = units.filter(
    (u) => u.state === 'new' || u.state === 'needs-translation' || !u.target
  ).length;
  const needsReview = units.filter((u) => u.state === 'needs-review-translation').length;
  return {
    total,
    translated,
    needsTranslation,
    needsReview,
    progress: total > 0 ? Math.round((translated / total) * 100) : 0,
  };
}

export type { ParsedXliff, TranslationState, XliffUnit };
