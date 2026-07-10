import * as fs from 'fs';
import * as path from 'path';
import { getNexusDir } from './storage.js';
import { parseXliffContent, findXliffFiles, resolveFilePath, type ParsedUnit } from './tools.js';

// ─────────────────────────────────────────────────────────────────────────────
// Caption index
//
// A compact, exact lookup of AL element Caption/ToolTip (and other Property)
// translations, keyed by the BC "Xliff Generator" note path — e.g.
//   "Table Authorization - Field Address - Property Caption"
// which maps (ObjectType, ObjectName, Element, Property) -> text per language.
//
// This is the token-cheap, location-exact source of truth for generating
// customer documentation in a target language: the agent walks AL source and
// asks for one object's captions/tooltips at a time instead of loading a huge
// multi-thousand-unit .xlf into context, and — unlike Translation Memory —
// the same source string ("Address") keeps its distinct per-object translation.
// ─────────────────────────────────────────────────────────────────────────────

const INDEX_VERSION = 1;
const INDEX_FILENAME = 'caption-index.json';

/** property name -> language code -> translated text */
export type PropMap = Record<string, Record<string, string>>;

export interface IndexElement {
  kind: string; // Field | Control | Action | Group | Part | ...
  name: string;
  properties: PropMap;
}

export interface IndexObject {
  type: string; // Table | Page | Report | Codeunit | PageExtension | ...
  name: string;
  /** Object-level properties (Caption, InstructionalText, AboutTitle, ...). */
  properties: PropMap;
  /** Child elements keyed by `${kind}:${lowercased name}`. */
  elements: Record<string, IndexElement>;
}

export interface CaptionIndex {
  version: number;
  generatedAt: string;
  sourceLanguage: string;
  languages: string[];
  /** Per-source freshness signature (relative path -> mtime/size). */
  sources: Record<string, { mtimeMs: number; size: number }>;
  /** Objects keyed by `${type}:${lowercased name}`. */
  objects: Record<string, IndexObject>;
}

// ─── Note-path parsing ────────────────────────────────────────────────────────

export interface ParsedNotePath {
  objectType: string;
  objectName: string;
  element?: { kind: string; name: string };
  property: string;
}

/** Object types BC emits as the first segment of a generator note. */
const OBJECT_TYPES = new Set([
  'table', 'tableextension', 'page', 'pageextension', 'pagecustomization',
  'report', 'reportextension', 'codeunit', 'xmlport', 'query',
  'enum', 'enumextension', 'profile', 'interface', 'permissionset', 'permissionsetextension',
  'controladdin', 'dotnet', 'entitlement', 'reportlayout',
]);

function stripQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) {
    return t.slice(1, -1);
  }
  return t;
}

/** Split "Kind Name" into its leading kind token and the (possibly spaced) name. */
function splitKindName(segment: string): { kind: string; name: string } {
  const s = segment.trim();
  const sp = s.indexOf(' ');
  if (sp < 0) return { kind: s, name: '' };
  return { kind: s.slice(0, sp), name: stripQuotes(s.slice(sp + 1)) };
}

/**
 * Parse a BC "Xliff Generator" note into an object/element/property path.
 * Returns null when the note is not a caption/tooltip-style property (e.g. a
 * code label such as "... - Method Foo - NamedType Bar", whose final segment is
 * not "Property <name>").
 */
export function parseGeneratorNote(note: string | undefined | null): ParsedNotePath | null {
  if (!note) return null;
  const parts = note.split(' - ').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  const first = splitKindName(parts[0]);
  if (!OBJECT_TYPES.has(first.kind.toLowerCase()) || !first.name) return null;

  const last = splitKindName(parts[parts.length - 1]);
  if (last.kind.toLowerCase() !== 'property' || !last.name) return null;
  const property = last.name;

  const middle = parts.slice(1, -1);
  let element: { kind: string; name: string } | undefined;
  if (middle.length > 0) {
    // The property belongs to the innermost element (last middle segment).
    const el = splitKindName(middle[middle.length - 1]);
    if (el.kind && el.name) element = { kind: el.kind, name: el.name };
  }

  return { objectType: first.kind, objectName: first.name, element, property };
}

// ─── Translation-quality gate ─────────────────────────────────────────────────

/**
 * A target counts as a real translation (not a BC placeholder copy) when it is
 * non-empty, not explicitly flagged untranslated, and not just the source text
 * echoed back (unless it was deliberately confirmed).
 */
function isRealTranslation(u: ParsedUnit): boolean {
  const t = (u.target ?? '').trim();
  if (!t) return false;
  const st = u.state;
  if (st === 'needs-translation' || st === 'new') return false;
  if (u.target === u.source && st !== 'final' && st !== 'signed-off') return false;
  return true;
}

// ─── Build ────────────────────────────────────────────────────────────────────

export interface BuildStats {
  indexPath: string;
  objectCount: number;
  elementCount: number;
  propertyCount: number;
  languages: string[];
  sourceFiles: number;
  builtAt: string;
}

function indexFilePath(workspaceRoot: string): string {
  return path.join(getNexusDir(workspaceRoot), INDEX_FILENAME);
}

function ensureObject(index: CaptionIndex, type: string, name: string): IndexObject {
  const key = `${type}:${name}`.toLowerCase();
  let obj = index.objects[key];
  if (!obj) {
    obj = { type, name, properties: {}, elements: {} };
    index.objects[key] = obj;
  }
  return obj;
}

function setProp(target: PropMap, property: string, lang: string, text: string): void {
  if (!target[property]) target[property] = {};
  target[property][lang] = text;
}

/** Scan every .xlf in the workspace and (re)write the caption index. */
export function buildCaptionIndex(workspaceRoot: string): BuildStats {
  const relFiles = findXliffFiles(workspaceRoot);
  const index: CaptionIndex = {
    version: INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    sourceLanguage: 'en-US',
    languages: [],
    sources: {},
    objects: {},
  };

  const langSet = new Set<string>();

  for (const rel of relFiles) {
    const full = resolveFilePath(workspaceRoot, rel);
    let content: string;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
      content = fs.readFileSync(full, 'utf-8');
    } catch {
      continue;
    }
    index.sources[rel] = { mtimeMs: stat.mtimeMs, size: stat.size };

    let parsed;
    try {
      parsed = parseXliffContent(content);
    } catch {
      continue;
    }
    const srcLang = parsed.sourceLanguage || 'en-US';
    const tgtLang = parsed.targetLanguage || '';
    index.sourceLanguage = srcLang;
    if (tgtLang) langSet.add(tgtLang);

    for (const u of parsed.units) {
      const note = parseGeneratorNote(u.note);
      if (!note) continue;
      const obj = ensureObject(index, note.objectType, note.objectName);
      const bag: PropMap = note.element
        ? (obj.elements[`${note.element.kind}:${note.element.name}`.toLowerCase()] ??= {
            kind: note.element.kind,
            name: note.element.name,
            properties: {},
          }).properties
        : obj.properties;

      // Always record the source text under the source language so lookups can
      // fall back to the original (e.g. English) when a translation is missing.
      if (u.source && u.source.trim()) setProp(bag, note.property, srcLang, u.source);
      // Record the target only when it is a genuine translation.
      if (tgtLang && isRealTranslation(u)) setProp(bag, note.property, tgtLang, u.target);
    }
  }

  index.languages = Array.from(langSet).sort();

  // Count for stats.
  let elementCount = 0;
  let propertyCount = 0;
  for (const obj of Object.values(index.objects)) {
    propertyCount += Object.keys(obj.properties).length;
    for (const el of Object.values(obj.elements)) {
      elementCount += 1;
      propertyCount += Object.keys(el.properties).length;
    }
  }

  const dir = getNexusDir(workspaceRoot);
  fs.mkdirSync(dir, { recursive: true });
  const outPath = indexFilePath(workspaceRoot);
  fs.writeFileSync(outPath, JSON.stringify(index), 'utf-8');
  // Invalidate the in-process memo so the next read returns the fresh index.
  memo = null;

  return {
    indexPath: path.relative(workspaceRoot, outPath).split(path.sep).join('/'),
    objectCount: Object.keys(index.objects).length,
    elementCount,
    propertyCount,
    languages: index.languages,
    sourceFiles: Object.keys(index.sources).length,
    builtAt: index.generatedAt,
  };
}

// ─── Read / freshness ─────────────────────────────────────────────────────────

let memo: { path: string; mtimeMs: number; index: CaptionIndex } | null = null;

function readIndexFromDisk(workspaceRoot: string): CaptionIndex | null {
  const file = indexFilePath(workspaceRoot);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (memo && memo.path === file && memo.mtimeMs === stat.mtimeMs) return memo.index;
  try {
    const index = JSON.parse(fs.readFileSync(file, 'utf-8')) as CaptionIndex;
    if (!index || index.version !== INDEX_VERSION) return null;
    memo = { path: file, mtimeMs: stat.mtimeMs, index };
    return index;
  } catch {
    return null;
  }
}

/** True when the set of .xlf files or any file's mtime/size differs from the index. */
export function isIndexStale(workspaceRoot: string, index: CaptionIndex): boolean {
  const current = findXliffFiles(workspaceRoot);
  const recorded = Object.keys(index.sources);
  if (current.length !== recorded.length) return true;
  const currentSet = new Set(current);
  for (const rel of recorded) if (!currentSet.has(rel)) return true;
  for (const rel of current) {
    const sig = index.sources[rel];
    if (!sig) return true;
    try {
      const stat = fs.statSync(resolveFilePath(workspaceRoot, rel));
      if (stat.mtimeMs !== sig.mtimeMs || stat.size !== sig.size) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * Return a usable index, (re)building it on disk when it is missing or stale
 * (unless autoBuild is false, in which case a stale/missing index returns null).
 */
export function ensureIndex(workspaceRoot: string, autoBuild = true): CaptionIndex | null {
  const existing = readIndexFromDisk(workspaceRoot);
  if (existing && !isIndexStale(workspaceRoot, existing)) return existing;
  if (!autoBuild) return existing;
  buildCaptionIndex(workspaceRoot);
  return readIndexFromDisk(workspaceRoot);
}

// ─── Lookup ───────────────────────────────────────────────────────────────────

function norm(s: string): string {
  return stripQuotes(s).toLowerCase();
}

function resolveText(
  props: PropMap,
  property: string,
  language: string,
  sourceLanguage: string
): { text: string; translated: boolean; source: string } | null {
  const langs = props[property];
  if (!langs) return null;
  const source = langs[sourceLanguage] ?? '';
  const target = langs[language];
  if (target != null && target !== '') return { text: target, translated: true, source };
  // Fall back to the source text (e.g. English) when untranslated.
  return { text: source, translated: false, source };
}

export interface ObjectTranslations {
  object: {
    type: string;
    name: string;
    caption: string | null;
    captionSource: string | null;
    translated: boolean;
  };
  language: string;
  sourceLanguage: string;
  properties?: Record<string, { text: string; translated: boolean }>;
  elements: Array<{
    kind: string;
    name: string;
    caption: string | null;
    captionSource: string | null;
    tooltip?: string;
    tooltipTranslated?: boolean;
    translated: boolean;
    otherProperties?: Record<string, { text: string; translated: boolean }>;
  }>;
  elementCount: number;
}

const CAPTION_PROP = 'Caption';
const TOOLTIP_PROP = 'ToolTip';

/**
 * Return every caption/tooltip for one object in the requested language — the
 * primary tool for documentation. One call documents one page/table with a tiny
 * token footprint.
 */
export function getObjectTranslations(
  workspaceRoot: string,
  objectType: string,
  objectName: string,
  language: string
): ObjectTranslations | { error: string; availableTypes?: string[]; suggestions?: string[] } {
  const index = ensureIndex(workspaceRoot);
  if (!index) return { error: 'No caption index and no .xlf files found in the workspace.' };
  const lang = language || index.languages[0] || index.sourceLanguage;

  const key = `${objectType}:${objectName}`.toLowerCase();
  let obj = index.objects[key];
  if (!obj) {
    // Fall back to a name-only match (any type) to be forgiving of type mismatches.
    const nameMatches = Object.values(index.objects).filter((o) => norm(o.name) === norm(objectName));
    if (nameMatches.length === 1) obj = nameMatches[0];
    else if (nameMatches.length > 1) {
      return {
        error: `Multiple objects named "${objectName}" — specify objectType.`,
        availableTypes: nameMatches.map((o) => o.type),
      };
    }
  }
  if (!obj) {
    const suggestions = Object.values(index.objects)
      .filter((o) => norm(o.name).includes(norm(objectName)) || norm(objectName).includes(norm(o.name)))
      .slice(0, 8)
      .map((o) => `${o.type} ${o.name}`);
    return { error: `Object not found: ${objectType} ${objectName}`, suggestions };
  }

  const objCaption = resolveText(obj.properties, CAPTION_PROP, lang, index.sourceLanguage);

  // Remaining object-level properties (InstructionalText, AboutTitle, ...).
  const objProps: Record<string, { text: string; translated: boolean }> = {};
  for (const prop of Object.keys(obj.properties)) {
    if (prop === CAPTION_PROP) continue;
    const r = resolveText(obj.properties, prop, lang, index.sourceLanguage);
    if (r && r.text) objProps[prop] = { text: r.text, translated: r.translated };
  }

  const elements: ObjectTranslations['elements'] = [];
  for (const el of Object.values(obj.elements)) {
    const cap = resolveText(el.properties, CAPTION_PROP, lang, index.sourceLanguage);
    const tip = resolveText(el.properties, TOOLTIP_PROP, lang, index.sourceLanguage);
    const other: Record<string, { text: string; translated: boolean }> = {};
    for (const prop of Object.keys(el.properties)) {
      if (prop === CAPTION_PROP || prop === TOOLTIP_PROP) continue;
      const r = resolveText(el.properties, prop, lang, index.sourceLanguage);
      if (r && r.text) other[prop] = { text: r.text, translated: r.translated };
    }
    const entry: ObjectTranslations['elements'][number] = {
      kind: el.kind,
      name: el.name,
      caption: cap ? cap.text : null,
      captionSource: cap ? cap.source : null,
      translated: cap ? cap.translated : false,
    };
    if (tip && tip.text) {
      entry.tooltip = tip.text;
      entry.tooltipTranslated = tip.translated;
    }
    if (Object.keys(other).length > 0) entry.otherProperties = other;
    elements.push(entry);
  }

  const result: ObjectTranslations = {
    object: {
      type: obj.type,
      name: obj.name,
      caption: objCaption ? objCaption.text : null,
      captionSource: objCaption ? objCaption.source : null,
      translated: objCaption ? objCaption.translated : false,
    },
    language: lang,
    sourceLanguage: index.sourceLanguage,
    elements,
    elementCount: elements.length,
  };
  if (Object.keys(objProps).length > 0) result.properties = objProps;
  return result;
}

export interface SingleLookup {
  found: boolean;
  source: string | null;
  target: string | null;
  translated: boolean;
  language: string;
  sourceLanguage: string;
  path: { objectType: string; objectName: string; element?: { kind: string; name: string }; property: string };
}

/**
 * Look up a single element property. Either pass an explicit
 * (type/name/element/property) path or a raw generator `note` string.
 */
export function lookupTranslation(
  workspaceRoot: string,
  opts: {
    type?: string;
    name?: string;
    elementKind?: string;
    elementName?: string;
    property?: string;
    note?: string;
    language: string;
  }
): SingleLookup | { error: string } {
  const index = ensureIndex(workspaceRoot);
  if (!index) return { error: 'No caption index and no .xlf files found in the workspace.' };
  const lang = opts.language || index.languages[0] || index.sourceLanguage;

  let objectType = opts.type;
  let objectName = opts.name;
  let elementKind = opts.elementKind;
  let elementName = opts.elementName;
  let property = opts.property || CAPTION_PROP;

  if (opts.note) {
    const parsed = parseGeneratorNote(opts.note);
    if (!parsed) return { error: `Could not parse note as a caption path: "${opts.note}"` };
    objectType = parsed.objectType;
    objectName = parsed.objectName;
    elementKind = parsed.element?.kind;
    elementName = parsed.element?.name;
    property = parsed.property;
  }

  if (!objectType || !objectName) return { error: 'objectType and objectName (or note) are required.' };

  const pathInfo = {
    objectType,
    objectName,
    element: elementKind && elementName ? { kind: elementKind, name: elementName } : undefined,
    property,
  };

  const obj = index.objects[`${objectType}:${objectName}`.toLowerCase()];
  const notFound: SingleLookup = {
    found: false, source: null, target: null, translated: false,
    language: lang, sourceLanguage: index.sourceLanguage, path: pathInfo,
  };
  if (!obj) return notFound;

  let props: PropMap | undefined;
  if (elementKind && elementName) {
    const el = obj.elements[`${elementKind}:${elementName}`.toLowerCase()];
    props = el?.properties;
  } else {
    props = obj.properties;
  }
  if (!props) return notFound;

  const r = resolveText(props, property, lang, index.sourceLanguage);
  if (!r) return notFound;
  return {
    found: true,
    source: r.source || null,
    target: r.translated ? r.text : null,
    translated: r.translated,
    language: lang,
    sourceLanguage: index.sourceLanguage,
    path: pathInfo,
  };
}
