import { XMLParser, XMLValidator } from 'fast-xml-parser';
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


// ─── State mapping ────────────────────────────────────────────────────────────
// NAB AL Tool prefixes that indicate non-final translation states.
// These appear at the start of <target> text when a BC XLIFF file is processed by NAB AL Tool.
const NAB_PREFIX_STATES: Array<{ prefix: RegExp; state: TranslationState }> = [
  { prefix: /^\[NAB:\s*NOT TRANSLATED\]/i,   state: 'needs-translation' },
  { prefix: /^\[NAB:\s*REVIEW\]/i,           state: 'needs-review-translation' },
  { prefix: /^\[NAB:\s*SUGGESTION\]/i,       state: 'needs-review-translation' },
  { prefix: /^\[NAB:\s*[A-Z _]+\]/i,         state: 'needs-review-translation' }, // catch-all for future NAB prefixes
];

/** Strip any NAB prefix from target text and return the cleaned text + inferred state. */
function stripNabPrefix(text: string): { cleaned: string; nabState: TranslationState | null } {
  for (const { prefix, state } of NAB_PREFIX_STATES) {
    if (prefix.test(text)) {
      return { cleaned: text.replace(prefix, '').trim(), nabState: state };
    }
  }
  return { cleaned: text, nabState: null };
}

function normalizeState(raw?: string, targetText?: string, sourceText?: string): TranslationState {
  const map: Record<string, TranslationState> = {
    new: 'new',
    'needs-translation': 'needs-translation',
    'needs-review-translation': 'needs-review-translation',
    translated: 'translated',
    final: 'final',
    'signed-off': 'signed-off',
  };

  // NAB AL Tool prefixes override everything — they are authoritative about the translation state.
  if (targetText) {
    const { nabState } = stripNabPrefix(targetText);
    if (nabState) return nabState;
  }

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
//     trans-unit id and note attribute values (e.g. id="Table "Cust." ...")
//  2. Duplicate <?xml?> processing instructions at the top of the file
// Both issues are fixed here before handing the content to fast-xml-parser.

/**
 * Single-pass XML pre-processor that escapes unescaped double-quotes inside
 * attribute values of opening tags.
 *
 * Operates as a lightweight state machine:
 *   TEXT → enters tag on '<'
 *   TAG  → copies tag name and whitespace/attribute-names/= as-is;
 *          on '"' enters ATTR_VALUE, on '>' or '/>' returns to TEXT
 *   ATTR_VALUE → accumulates chars; on '"' uses the same closing-quote
 *                heuristic (next attr or end-of-tag follows) to decide if
 *                this is the real closing delimiter; otherwise treats it as
 *                an embedded quote and replaces with &quot;
 *
 * Processing in a single pass eliminates the risk of one per-attribute pass
 * corrupting the output consumed by a subsequent pass.
 */
function fixAllUnescapedAttrQuotes(xml: string): string {
  const out: string[] = [];
  let i = 0;

  while (i < xml.length) {
    // ── TEXT content ── copy until next '<'
    const ltPos = xml.indexOf('<', i);
    if (ltPos === -1) { out.push(xml.slice(i)); break; }
    out.push(xml.slice(i, ltPos));
    i = ltPos; // i points at '<'

    const next = i + 1 < xml.length ? xml[i + 1] : '';

    // ── Closing tag, comment/CDATA/DOCTYPE, or processing instruction ──
    // Copy character-by-character until '>' (simple but safe for XLIFF).
    if (next === '/' || next === '!' || next === '?') {
      const gtPos = xml.indexOf('>', i);
      if (gtPos === -1) { out.push(xml.slice(i)); i = xml.length; break; }
      out.push(xml.slice(i, gtPos + 1));
      i = gtPos + 1;
      continue;
    }

    // ── Opening tag ── copy '<' and tag name
    out.push('<');
    i++;
    while (i < xml.length && /[a-zA-Z0-9_:.-]/.test(xml[i])) {
      out.push(xml[i]);
      i++;
    }

    // ── Attribute list ── process until '>' or '/>'
    while (i < xml.length) {
      const ch = xml[i];

      if (ch === '>') { out.push('>'); i++; break; }
      if (ch === '/' && i + 1 < xml.length && xml[i + 1] === '>') {
        out.push('/>'); i += 2; break;
      }

      if (ch === '"') {
        // Double-quoted attribute value — fix any embedded unescaped quotes.
        out.push('"');
        i++;
        let value = '';
        while (i < xml.length) {
          const vc = xml[i];
          if (vc !== '"') { value += vc; i++; continue; }

          // Is this the TRUE closing quote?
          // Closing = followed by: next attribute (whitespace+name+`=`)
          //                     OR end of tag (optional whitespace + `>` / `/>`)
          const after = xml.slice(i + 1);
          const isEnd =
            /^\s+[a-zA-Z_:][a-zA-Z0-9_:.\-]*\s*=/.test(after) ||
            /^\s*\/?>/.test(after);

          if (isEnd) {
            out.push(value.replace(/"/g, '&quot;'), '"');
            i++;
            break;
          }
          value += '"';
          i++;
        }
        if (i >= xml.length) { out.push(value); } // ran off end
        continue;
      }

      if (ch === "'") {
        // Single-quoted attribute value — copy verbatim (no fix needed for '"').
        out.push("'");
        i++;
        while (i < xml.length && xml[i] !== "'") { out.push(xml[i]); i++; }
        if (i < xml.length) { out.push("'"); i++; }
        continue;
      }

      // Whitespace, attribute name characters, '=' — copy as-is.
      out.push(ch);
      i++;
    }
  }

  return out.join('');
}

function sanitizeXmlAttributeQuotes(xml: string): { result: string; fix2Joins: number; lineShift: number } {
  const rawLineCount0 = xml.split('\n').length;

  // Normalise all line endings to \n so subsequent logic only needs to handle \n.
  xml = xml.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Fix 1 — duplicate XML declarations.  Keep only the first <?xml ... ?> line.
  xml = xml.replace(/((<\?xml[^?]*\?>)\s*)+/s, '$2\n');

  // Fix 2 — join continuation lines.
  // BC XLIFF Generator can emit opening tags that span multiple lines in two ways:
  //   a) Attribute VALUE split:  <note from="NAB\n          AL Language Tool" ...>
  //   b) Attribute LIST split:   <trans-unit id="..."\n          size-unit="char" ...>
  // Strategy: if a line does not start a new XML node (trimmed form does not begin with
  // '<') AND the preceding accumulated line is still inside an unclosed opening tag
  // (does not end with '>'), join it onto the preceding line with a space separator.
  // This single heuristic handles both (a) and (b).
  let fix2Joins = 0;
  {
    const lines = xml.split('\n');
    const joined: string[] = [];
    for (const line of lines) {
      const trimmed = line.trimStart();
      if (
        joined.length > 0 &&
        trimmed.length > 0 &&
        !trimmed.startsWith('<') &&
        !joined[joined.length - 1].trimEnd().endsWith('>')
      ) {
        joined[joined.length - 1] += ' ' + trimmed;
        fix2Joins++;
      } else {
        joined.push(line);
      }
    }
    xml = joined.join('\n');
  }

  const lineShift = rawLineCount0 - xml.split('\n').length;

  // Fix 3 — escape unescaped double-quotes inside opening-tag attribute values.
  // BC XLIFF Generator can emit trans-unit ids like id="Table "Customer" - Field "Name""
  xml = fixAllUnescapedAttrQuotes(xml);

  return { result: xml, fix2Joins, lineShift };
}

// ─── Parse XLIFF ──────────────────────────────────────────────────────────────
export function parseXliff(xmlContent: string): ParsedXliff {
  // Strip UTF-8 BOM (\uFEFF) — some editors / ADO add it; fast-xml-parser rejects it
  xmlContent = xmlContent.replace(/^\uFEFF/, '');

  // Always sanitize first so BC XLIFF malformations (multi-line opening tags, duplicate
  // XML declarations, unescaped quotes in attribute values) are normalised before validation.
  const { result: sanitized, fix2Joins, lineShift } = sanitizeXmlAttributeQuotes(xmlContent);

  const validationResult = XMLValidator.validate(sanitized, { allowBooleanAttributes: false });
  if (validationResult !== true) {
    const err = (validationResult as { err: { msg: string; line: number; col: number } }).err;
    const rawLines = xmlContent.split('\n');
    const sanitizedLines = sanitized.split('\n');
    const errLine = err.line - 1;  // 0-indexed
    // Show context in SANI around the error
    const sanCtx = sanitizedLines.slice(Math.max(0, errLine - 2), errLine + 3)
      .map((l, i) => `SANI ${errLine - 2 + i + 1}: ${l.substring(0, 500)}`).join('\n');
    // Show corresponding RAW context (accounting for lineShift)
    const rawErrLine = errLine + lineShift;
    const rawCtx = rawLines.slice(Math.max(0, rawErrLine - 2), rawErrLine + 3)
      .map((l, i) => `RAW  ${rawErrLine - 2 + i + 1}: ${l.substring(0, 500)}`).join('\n');
    let firstDiff = -1;
    for (let d = 0; d < Math.min(rawLines.length, sanitizedLines.length); d++) {
      if (rawLines[d] !== sanitizedLines[d]) { firstDiff = d; break; }
    }
    const diffCtx = firstDiff >= 0
      ? rawLines.slice(Math.max(0, firstDiff - 1), firstDiff + 3).map((l, i) => `DIFF_RAW  ${firstDiff + i}: ${l.substring(0, 300)}`).join('\n') + '\n' +
        sanitizedLines.slice(Math.max(0, firstDiff - 1), firstDiff + 3).map((l, i) => `DIFF_SANI ${firstDiff + i}: ${l.substring(0, 300)}`).join('\n')
      : '(no divergence found)';
    console.error(`[XLIFF] parse error line ${err.line}, col ${err.col}: ${err.msg} | lineShift=${lineShift} fix2Joins=${fix2Joins}\n${sanCtx}\n${rawCtx}\nFirst diff at raw line ${firstDiff}:\n${diffCtx}`);
    throw new Error(`Invalid XML at line ${err.line}, col ${err.col}: ${err.msg}`);
  }

  const xmlToParse = sanitized;

  const parser = new XMLParser({
    ...PARSER_OPTIONS,
    isArray: (name) => ['trans-unit', 'file', 'note', 'group'].includes(name),
  });

  const parsed = parser.parse(xmlToParse) as { xliff?: { file?: unknown } };
  const xliff = parsed?.xliff;

  if (!xliff) throw new Error('Invalid XLIFF: missing <xliff> root element');

  const files: unknown[] = Array.isArray(xliff.file) ? xliff.file : xliff.file ? [xliff.file] : [];
  if (files.length === 0) throw new Error('Invalid XLIFF: no <file> elements found');

  const file = files[0] as Record<string, unknown>;
  const attrs = file as Record<string, unknown>;

  const sourceLanguage = String(attrs['@_source-language'] ?? 'en');
  const targetLanguage = String(attrs['@_target-language'] ?? '');

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

    // Handle multiple <target> elements (NAB AL Tool may insert several suggestions).
    // Prefer the first target WITHOUT a NAB prefix (= confirmed translation);
    // fall back to the first element if all carry a NAB prefix.
    let targetNode: unknown = unit.target;
    if (Array.isArray(unit.target) && unit.target.length > 0) {
      const targets = unit.target as unknown[];
      const confirmed = targets.find((t) => {
        const txt = getText(t);
        return !NAB_PREFIX_STATES.some(({ prefix }) => prefix.test(txt));
      });
      targetNode = confirmed ?? targets[0];
    }

    const target = targetNode as Record<string, unknown> | string | undefined;
    const rawTargetText = getText(targetNode);
    const { cleaned: targetText } = stripNabPrefix(rawTargetText ?? '');
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
      state: normalizeState(targetState, rawTargetText, sourceText),
      note,
      developerNote,
    };
  });

  return { sourceLanguage, targetLanguage, units };
}

// ─── Serialize XLIFF ──────────────────────────────────────────────────────────

/** Escape special XML characters in text content (not for attribute values). */
function xmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Serialize an XLIFF file with targeted in-place replacement.
 *
 * Single-pass O(n) implementation: split the XML at `<trans-unit` boundaries
 * once, look up each unit id in the updates map, patch only those that need it,
 * then reassemble. This avoids the O(updates × xmlSize) cost of per-unit
 * full-string regex scans.
 *
 * Untouched trans-units are emitted exactly as-is — no reformatting, no added
 * state attributes, no indentation changes.
 */
export function serializeXliff(
  original: string,
  updates: Map<string, { target: string; state: TranslationState }>
): string {
  if (updates.size === 0) return original;

  // Split on every <trans-unit opening tag. The first segment is the XML
  // preamble before any trans-unit element.
  const segments = original.split(/(?=<trans-unit[\s>])/);

  // Extract the id attribute from the opening <trans-unit ...> tag
  const ID_RE = /^<trans-unit[^>]*?\bid=["']([^"']+)["']/;

  const out: string[] = [];
  for (const seg of segments) {
    const idMatch = seg.match(ID_RE);
    if (!idMatch) {
      out.push(seg);
      continue;
    }
    const update = updates.get(idMatch[1]);
    out.push(update ? applyTargetPatch(seg, update.target) : seg);
  }

  return out.join('');
}

/**
 * Replace (or insert) the `<target>` element inside a single `<trans-unit>` block.
 * Only the `<target>` portion is touched; everything else is preserved exactly.
 */
function applyTargetPatch(block: string, targetText: string): string {
  const newTargetXml = `<target>${xmlEscape(targetText)}</target>`;

  // Case 1: existing <target ...>...</target> (possibly multi-line)
  if (/<target[\s\S]*?<\/target>/.test(block)) {
    return block.replace(/<target[\s\S]*?<\/target>/, newTargetXml);
  }

  // Case 2: self-closing <target/>
  if (/<target\s*\/>/.test(block)) {
    return block.replace(/<target\s*\/>/, newTargetXml);
  }

  // Case 3: no <target> at all — insert after </source>
  const indentMatch = block.match(/^([ \t]*)<(?:source|target)/m);
  const indent = indentMatch ? indentMatch[1] : '        ';
  return block.replace(/(<\/source>[^\n]*\n)/, `$1${indent}${newTargetXml}\n`);
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
