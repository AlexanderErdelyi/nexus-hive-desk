import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import type { ParsedXliff, TranslationState, XliffUnit } from '@nexus/types';

const PARSER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  trimValues: true,
  // Increase entity expansion limits — BC XLIFF files can contain thousands of
  // XML character references (e.g. &#160;) that hit fast-xml-parser's default of 1000.
  processEntities: { maxTotalExpansions: 100000, maxEntityCount: 100000, maxEntitySize: 100000, maxExpandedLength: 10000000, maxExpansionDepth: 100 },
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

// ─── XML pre-processor ────────────────────────────────────────────────────────
// BC Xliff Generator can produce malformed XML in several ways:
//  1. AL object/field names with double-quote chars end up unescaped in
//     trans-unit id and note attribute values (e.g. note="Table "Cust." ...")
//  2. Duplicate <?xml?> processing instructions at the top of the file
// Both issues are fixed here before handing the content to fast-xml-parser.

/**
 * Fix unescaped double-quotes inside the value of a named XML attribute.
 *
 * Strategy: scan character-by-character after the opening `attr="`.
 * A `"` is treated as the TRUE closing delimiter only when the very next
 * characters match one of:
 *   - whitespace then a XML name-start char (next attribute follows)
 *   - optional whitespace then `>` or `/>`  (tag ends here)
 * Every other `"` encountered is an embedded (unescaped) quote and is
 * replaced with `&quot;`.
 */
function fixAttrQuotes(xml: string, attrName: string): string {
  const prefix = `${attrName}="`;
  const parts: string[] = [];
  let pos = 0;

  while (pos < xml.length) {
    const start = xml.indexOf(prefix, pos);
    if (start === -1) { parts.push(xml.slice(pos)); break; }

    // Copy everything up to and including the opening `attr="`
    parts.push(xml.slice(pos, start + prefix.length));
    let i = start + prefix.length;
    let value = '';

    while (i < xml.length) {
      const ch = xml[i];
      if (ch !== '"') { value += ch; i++; continue; }

      // Is this the TRUE closing quote?
      const after = xml.slice(i + 1);
      const isEnd =
        /^\s+[a-zA-Z_:]/.test(after) ||   // next attribute: space then XML name-start
        /^\s*\/?>/.test(after);            // end of tag: />  or  >  (with optional space)

      if (isEnd) {
        parts.push(value.replace(/"/g, '&quot;'), '"');
        pos = i + 1;
        break;
      }
      value += '"';
      i++;
    }

    // Ran off end without finding a closing quote — just emit as-is
    if (i >= xml.length) { parts.push(value); pos = xml.length; break; }
  }

  return parts.join('');
}

function sanitizeXmlAttributeQuotes(xml: string): string {
  // Fix 1 — duplicate XML declarations.  Keep only the first <?xml ... ?> line.
  xml = xml.replace(/((<\?xml[^?]*\?>)\s*)+/s, '$2\n');

  // Fix 2 — unescaped `"` inside attribute values.
  // BC XLIFF generator sometimes emits AL object/field names without proper &quot; escaping
  // in trans-unit id and note attrs, and occasionally in <note> element from/annotates attrs.
  xml = fixAttrQuotes(xml, 'id');
  xml = fixAttrQuotes(xml, 'note');
  xml = fixAttrQuotes(xml, 'from');
  xml = fixAttrQuotes(xml, 'annotates');

  return xml;
}

// ─── Parse XLIFF ──────────────────────────────────────────────────────────────
export function parseXliff(xmlContent: string): ParsedXliff {
  // Strip UTF-8 BOM (\uFEFF) — some editors / ADO add it; fast-xml-parser rejects it
  xmlContent = xmlContent.replace(/^\uFEFF/, '');

  // Validate first to get a proper human-readable error instead of a JS TypeError
  const validationResult = XMLValidator.validate(xmlContent, { allowBooleanAttributes: false });
  if (validationResult !== true) {
    // Try to fix common issues (unescaped quotes in attribute values) then re-validate
    const sanitized = sanitizeXmlAttributeQuotes(xmlContent);
    const retryResult = XMLValidator.validate(sanitized, { allowBooleanAttributes: false });
    if (retryResult !== true) {
      const err = (retryResult as { err: { msg: string; line: number; col: number } }).err;
      // Log context around the error line + first chars of raw input for diagnosis
      const lines = sanitized.split('\n');
      const errLine = err.line - 1;
      const context = lines.slice(Math.max(0, errLine - 2), errLine + 3).join('\n');
      const firstChars = xmlContent.substring(0, 200).replace(/\n/g, '↵');
      console.error(`[XLIFF parse error] line ${err.line}, col ${err.col}: ${err.msg}\nFirst 200 chars: ${firstChars}\nContext:\n${context}`);
      throw new Error(`Invalid XML at line ${err.line}, col ${err.col}: ${err.msg}`);
    }
    xmlContent = sanitized;
  }

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
