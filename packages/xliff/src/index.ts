import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import type { ParsedXliff, TranslationState, XliffUnit } from '@nexus/types';

const PARSER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  // Keep trimValues false: XLIFF translation strings may have significant leading/trailing
  // whitespace (e.g. " value ") that trimValues:true would silently strip.
  trimValues: false,
  // Preserve CDATA sections as a special __cdata property rather than inlining them as text.
  // This prevents CDATA content from being double-encoded on round-trip serialization.
  cdataPropName: '__cdata',
  // Decode XML entities (&amp; &lt; &gt; &quot; &#160; etc.) into their character equivalents.
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

/**
 * Extract plain text content from a parsed XML node.
 *
 * Handles four cases:
 *  1. Primitive values (string / number) — returned as-is.
 *  2. CDATA sections — returned as the raw CDATA text (not double-encoded).
 *  3. Mixed-content nodes — the `#text` property may be a string or an array
 *     when the text is interleaved with child elements; all parts are joined.
 *  4. Nested inline XML tags (XLIFF <g>, <ph>, <x/>, <bpt>, <ept>, …) — their
 *     text content is recursively collected so that inline markup is not silently
 *     stripped from source/target strings.
 */
function getText(node: unknown): string {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (typeof node !== 'object') return '';

  const obj = node as Record<string, unknown>;

  // CDATA sections are stored under the cdataPropName key ('__cdata').
  if ('__cdata' in obj) return String(obj['__cdata'] ?? '');

  // Collect text from all children of the node in order.
  // Attribute keys (prefixed @_) and the special '#text' key are handled
  // separately; everything else is a child element.
  let result = '';

  for (const [key, val] of Object.entries(obj)) {
    if (key.startsWith('@_')) continue; // XML attributes — not text content

    if (key === '#text') {
      // fast-xml-parser may produce an array when text nodes are interleaved
      // with child elements (mixed content), or a simple string otherwise.
      if (Array.isArray(val)) {
        result += (val as unknown[]).map((v) => String(v ?? '')).join('');
      } else {
        result += String(val ?? '');
      }
    } else {
      // Child element — recurse to collect its text content.
      if (Array.isArray(val)) {
        for (const item of val as unknown[]) result += getText(item);
      } else {
        result += getText(val);
      }
    }
  }

  return result;
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
      // A closing quote must be followed by:
      //   - a next XML attribute (whitespace, an XML name-start char, then '=')
      //   - or the end of the opening tag (optional whitespace, then '>' or '/>')
      // Crucially we require '=' after the attribute name — otherwise "word word"
      // inside an attribute value would be misidentified as a next attribute.
      const after = xml.slice(i + 1);
      const isEnd =
        /^\s+[a-zA-Z_:][a-zA-Z0-9_:.\-]*\s*=/.test(after) || // next attr (requires '=')
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
      // Include the raw lines around the error in the thrown message for diagnosis
      const rawLines = xmlContent.split('\n');
      const sanitizedLines = sanitized.split('\n');
      const errLine = err.line - 1;
      const rawCtx = rawLines.slice(Math.max(0, errLine - 1), errLine + 2).map((l, i) => `RAW  ${errLine - 1 + i + 1}: ${l.substring(0, 200)}`).join('\n');
      const sanCtx = sanitizedLines.slice(Math.max(0, errLine - 1), errLine + 2).map((l, i) => `SANI ${errLine - 1 + i + 1}: ${l.substring(0, 200)}`).join('\n');
      console.error(`[XLIFF] parse error line ${err.line}, col ${err.col}: ${err.msg}\n${rawCtx}\n${sanCtx}`);
      throw new Error(`Invalid XML at line ${err.line}, col ${err.col}: ${err.msg}\n${rawCtx}`);
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
  const rawTargetLang = attrs['@_target-language'];
  const targetLanguage = rawTargetLang ? String(rawTargetLang) : '';

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
    // preserveOrder:false is the default; being explicit here for clarity.
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
      applyTargetUpdate(unit, updates);
    }

    for (const grp of groups) {
      const groupUnits: Record<string, unknown>[] = Array.isArray(grp['trans-unit'])
        ? (grp['trans-unit'] as Record<string, unknown>[])
        : grp['trans-unit']
          ? [grp['trans-unit'] as Record<string, unknown>]
          : [];
      for (const unit of groupUnits) {
        applyTargetUpdate(unit, updates);
      }
    }
  }

  const builder = new XMLBuilder(BUILDER_OPTIONS);
  return `<?xml version="1.0" encoding="utf-8"?>\n${builder.build(parsed)}`;
}

/**
 * Apply a target update to a single trans-unit node in the parsed XML tree.
 *
 * Empty-target fix: when the new target text is an empty string the builder
 * must still emit `<target state="…"></target>` (not the self-closed form
 * `<target state="…"/>`).  fast-xml-parser's XMLBuilder respects
 * `suppressEmptyNode: false` only when the node has an explicit `#text` key.
 * We therefore always set `#text` — using a zero-width non-breaking space as
 * a placeholder that looks empty when rendered, then strip it after building
 * so the final XML truly has `<target …></target>`.
 *
 * Special characters: the builder will XML-encode `&`, `<`, `>` etc. in the
 * target text string, so callers must pass the *decoded* plain-text value
 * (e.g. "A & B"), not pre-encoded XML entities (e.g. "A &amp; B").
 */
function applyTargetUpdate(
  unit: Record<string, unknown>,
  updates: Map<string, { target: string; state: TranslationState }>
): void {
  const id = String(unit['@_id'] ?? '');
  const update = updates.get(id);
  if (!update) return;

  const existingTarget = unit.target;
  if (typeof existingTarget === 'object' && existingTarget !== null) {
    (existingTarget as Record<string, unknown>)['#text'] = update.target;
    (existingTarget as Record<string, unknown>)['@_state'] = update.state;
  } else {
    unit.target = { '#text': update.target, '@_state': update.state };
  }
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
