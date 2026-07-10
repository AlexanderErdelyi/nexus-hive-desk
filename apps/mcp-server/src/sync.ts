// ─────────────────────────────────────────────────────────────────────────────
// XLIFF sync engine  (dependency-free, raw-text, minimal-diff)
//
// Given a freshly generated BC base file (`<App>.g.xlf`) and an existing
// language file (`<App>.de-DE.xlf`), produce an updated language file that:
//   • ADDS units that are new in the generated file,
//   • leaves UNCHANGED units byte-for-byte (zero diff — keeps the human
//     translation and preserves formatting),
//   • flags units whose SOURCE changed for review (keeps the old translation),
//   • handles ORPHANS (in the language file but no longer generated) per policy:
//       - preserve  (add-only, default): never delete,
//       - remove    (full sync): delete — EXCEPT units pinned with a
//         `<note from="NexusCustom">`, which are always kept (this protects
//         deliberately-added base-app caption overrides).
//
// Why raw-text: writing only the changed trans-unit blocks (and keeping a
// deterministic order) means two feature branches that touch different objects
// produce non-overlapping diffs, which git can auto-merge — unlike NAB, which
// rewrites the whole file every sync and guarantees conflicts.
//
// This file is intentionally dependency-free so the identical copy can live in
// both `packages/xliff` (VS Code extension) and `apps/mcp-server` (MCP tool),
// neither of which shares a runtime.
// ─────────────────────────────────────────────────────────────────────────────

export interface SyncOptions {
  /** Delete orphan units (default false = add-only/preserve). Pinned units survive regardless. */
  removeOrphans?: boolean;
  /** Reorder all units by stable id for merge-friendliness (default true). */
  canonicalOrder?: boolean;
  /** State applied to a unit whose source text changed (default 'needs-review-translation'). */
  sourceChangedState?: string;
  /** State applied to a new, un-prefilled unit (default 'needs-translation'). */
  newState?: string;
  /** `from` attribute that marks a unit as pinned/custom (default 'NexusCustom'). */
  pinNoteFrom?: string;
  /**
   * Optional prefill hook for NEW units — return a translation for the given
   * source (e.g. an exact Translation-Memory match), or null. When it returns a
   * value the new unit is written with that target and `state` (default 'translated').
   */
  prefill?: (source: string) => { target: string; state?: string } | null;
}

export interface SyncSummary {
  added: number;
  updated: number;
  unchanged: number;
  orphansPreserved: number;
  orphansRemoved: number;
  pinnedPreserved: number;
  prefilled: number;
  addedIds: string[];
  updatedIds: string[];
  removedIds: string[];
}

export interface SyncResult {
  xml: string;
  summary: SyncSummary;
  /** True when the output is identical to the input target (no changes). */
  unchangedFile: boolean;
}

interface Block {
  id: string;
  xml: string; // the `<trans-unit ...> ... </trans-unit>` element, no surrounding whitespace
}

interface SplitResult {
  head: string; // everything before the first <trans-unit> (incl. its leading indent)
  blocks: Block[];
  sep: string; // whitespace separating consecutive trans-units
  tail: string; // closing tags after the last </trans-unit>
}

const ID_RE = /^<trans-unit[^>]*?\bid=["']([^"']+)["']/;

/** Split raw XLIFF into head / per-unit blocks / separator / tail. */
function splitBlocks(xml: string): SplitResult {
  const segments = xml.split(/(?=<trans-unit[\s>])/);
  const head = segments[0] ?? '';
  const rawUnits = segments.slice(1);

  const blocks: Block[] = [];
  const trailings: string[] = [];
  for (const seg of rawUnits) {
    const m = seg.match(/^([\s\S]*?<\/trans-unit>)([\s\S]*)$/);
    if (!m) {
      // Malformed (no closing tag) — keep verbatim as a block with empty id.
      blocks.push({ id: '', xml: seg });
      trailings.push('');
      continue;
    }
    const unitXml = m[1];
    const trailing = m[2];
    const idMatch = unitXml.match(ID_RE);
    blocks.push({ id: idMatch ? idMatch[1] : '', xml: unitXml });
    trailings.push(trailing);
  }

  // Separator = trailing whitespace after a non-last unit; tail = trailing of last unit.
  let sep = '\n        ';
  let tail = '';
  if (trailings.length > 0) {
    tail = trailings[trailings.length - 1];
    sep = trailings.length > 1 ? trailings[0] : deriveSep(head);
  }

  return { head, blocks, sep, tail };
}

/** Best-effort inter-unit whitespace when the file has only one unit: reuse the head's trailing indent. */
function deriveSep(head: string): string {
  const m = head.match(/(\r?\n[ \t]*)$/);
  return m ? m[1] : '\n        ';
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#160;/g, '\u00a0')
    .replace(/&amp;/g, '&');
}

function xmlEscapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Raw (still-escaped) inner text of the `<source>` element, or '' if absent. */
function rawSource(unitXml: string): string {
  const m = unitXml.match(/<source[^>]*>([\s\S]*?)<\/source>/);
  return m ? m[1] : '';
}

function hasPinNote(unitXml: string, from: string): boolean {
  const re = new RegExp(`<note\\b[^>]*\\bfrom=["']${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i');
  return re.test(unitXml);
}

/** Detect the per-line indent used inside a unit block (for a freshly inserted <target>). */
function innerIndent(unitXml: string): string {
  const m = unitXml.match(/\n([ \t]+)<source/);
  return m ? m[1] : '          ';
}

/**
 * Build a language-file trans-unit block from a GENERATED block: drop any BC
 * placeholder `<target>` (source-copy) and insert a fresh target with the given
 * text/state. Source + notes are copied verbatim.
 */
function makeNewBlock(generated: string, target: string, state: string): string {
  // Remove an existing <target ...>...</target> or self-closing <target/>.
  let block = generated
    .replace(/[ \t]*<target[\s\S]*?<\/target>\s*\n?/, '')
    .replace(/[ \t]*<target\s*\/>\s*\n?/, '');

  const indent = innerIndent(block);
  const stateAttr = state ? ` state="${state}"` : '';
  const targetXml = `<target${stateAttr}>${xmlEscapeText(target)}</target>`;

  if (/<\/source>/.test(block)) {
    return block.replace(/(<\/source>)([ \t]*\r?\n)?/, `$1\n${indent}${targetXml}\n`);
  }
  // No source (unexpected) — append target before </trans-unit>.
  return block.replace(/([ \t]*)<\/trans-unit>/, `${indent}${targetXml}\n$1</trans-unit>`);
}

/** Set (or insert) the `state` attribute on an existing `<target>` without touching its text. */
function setTargetState(unitXml: string, state: string): string {
  if (/<target\b[^>]*\bstate=["'][^"']*["']/.test(unitXml)) {
    return unitXml.replace(/(<target\b[^>]*\bstate=)["'][^"']*["']/, `$1"${state}"`);
  }
  if (/<target\b[^>]*>/.test(unitXml)) {
    return unitXml.replace(/<target\b([^>]*)>/, `<target$1 state="${state}">`);
  }
  return unitXml;
}

/** Replace the `<source>` inner text of an existing block with new raw (escaped) source. */
function replaceSource(unitXml: string, newRawSource: string): string {
  return unitXml.replace(/(<source[^>]*>)[\s\S]*?(<\/source>)/, `$1${newRawSource}$2`);
}

/**
 * Sync a generated base file into a target language file.
 * Pure function: no file-system or parser dependency.
 */
export function syncXliff(generatedXml: string, targetXml: string, opts: SyncOptions = {}): SyncResult {
  const removeOrphans = opts.removeOrphans ?? false;
  const canonicalOrder = opts.canonicalOrder ?? true;
  const sourceChangedState = opts.sourceChangedState ?? 'needs-review-translation';
  const newState = opts.newState ?? 'needs-translation';
  const pinNoteFrom = opts.pinNoteFrom ?? 'NexusCustom';

  const gen = splitBlocks(generatedXml);
  const tgt = splitBlocks(targetXml);

  const genById = new Map<string, Block>();
  for (const b of gen.blocks) if (b.id) genById.set(b.id, b);

  const tgtById = new Map<string, Block>();
  for (const b of tgt.blocks) if (b.id) tgtById.set(b.id, b);

  const summary: SyncSummary = {
    added: 0, updated: 0, unchanged: 0,
    orphansPreserved: 0, orphansRemoved: 0, pinnedPreserved: 0, prefilled: 0,
    addedIds: [], updatedIds: [], removedIds: [],
  };

  const outBlocks: Block[] = [];

  // 1) Walk the generated units → add / keep / flag-source-change.
  for (const g of gen.blocks) {
    if (!g.id) continue;
    const existing = tgtById.get(g.id);
    if (!existing) {
      // NEW unit.
      const src = decodeEntities(rawSource(g.xml));
      const pre = opts.prefill ? opts.prefill(src) : null;
      let block: string;
      if (pre && pre.target) {
        block = makeNewBlock(g.xml, pre.target, pre.state ?? 'translated');
        summary.prefilled++;
      } else {
        block = makeNewBlock(g.xml, '', newState);
      }
      outBlocks.push({ id: g.id, xml: block });
      summary.added++;
      summary.addedIds.push(g.id);
    } else {
      // EXISTING unit — compare source text.
      const genSrc = decodeEntities(rawSource(g.xml));
      const tgtSrc = decodeEntities(rawSource(existing.xml));
      if (genSrc === tgtSrc) {
        outBlocks.push(existing); // untouched → zero diff
        summary.unchanged++;
      } else {
        // Source changed: keep translation, update source, flag for review.
        let block = replaceSource(existing.xml, rawSource(g.xml));
        block = setTargetState(block, sourceChangedState);
        outBlocks.push({ id: g.id, xml: block });
        summary.updated++;
        summary.updatedIds.push(g.id);
      }
    }
  }

  // 2) Handle orphans (in target, not generated).
  for (const t of tgt.blocks) {
    if (!t.id || genById.has(t.id)) continue;
    const pinned = hasPinNote(t.xml, pinNoteFrom);
    if (pinned) {
      outBlocks.push(t);
      summary.pinnedPreserved++;
    } else if (removeOrphans) {
      summary.orphansRemoved++;
      summary.removedIds.push(t.id);
    } else {
      outBlocks.push(t);
      summary.orphansPreserved++;
    }
  }

  // 3) Order.
  if (canonicalOrder) {
    outBlocks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  // 4) Reassemble, preserving head / separator / tail from the target file.
  const sep = tgt.sep || '\n        ';
  const tail = tgt.tail;
  const head = tgt.head;
  const body = outBlocks.map((b) => b.xml).join(sep);
  const xml = outBlocks.length > 0 ? head + body + tail : targetXml;

  return { xml, summary, unchangedFile: xml === targetXml };
}
