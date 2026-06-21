import * as vscode from 'vscode';

/** Matches an AL top-level object declaration, capturing the object type and name. */
const AL_OBJECT_RE =
  /^(tableextension|table|pagecustomization|pageextension|page|codeunit|reportextension|report|xmlport|query|enumextension|enum|profile|interface|permissionset)\s+\d+\s+["']?([^"'{\n]+?)["']?\s*[{(]/gim;

interface AlObjectEntry {
  uri: vscode.Uri;
  text: string;
  /** Byte offset where this object's declaration starts (for multi-object files). */
  start: number;
  /** Byte offset where the next object starts (or end of file). */
  end: number;
}

/**
 * Extracts relevant AL source code for a translation unit so the AI can understand
 * the data type, ToolTip, and surrounding structure of the element being translated.
 *
 * The XLIFF note only tells us "Page X - Control Y - Property Caption"; the AL source
 * adds the field's data type (e.g. Integer ⇒ a count), its ToolTip, and the enclosing
 * group (e.g. a CueGroup), all of which materially improve translation quality.
 *
 * A one-time scan of all `.al` files is cached on the instance and reused across the
 * whole translate run, so per-unit lookups are cheap.
 */
export class SourceContextProvider {
  private index: Map<string, AlObjectEntry> | null = null;
  private buildPromise: Promise<Map<string, AlObjectEntry>> | null = null;

  /** Drop the cache so the next lookup re-scans the workspace. */
  invalidate(): void {
    this.index = null;
    this.buildPromise = null;
  }

  private async ensureIndex(): Promise<Map<string, AlObjectEntry>> {
    if (this.index) return this.index;
    if (this.buildPromise) return this.buildPromise;
    this.buildPromise = this.build();
    this.index = await this.buildPromise;
    return this.index;
  }

  private async build(): Promise<Map<string, AlObjectEntry>> {
    const idx = new Map<string, AlObjectEntry>();
    let files: vscode.Uri[] = [];
    try {
      files = await vscode.workspace.findFiles('**/*.al', '**/node_modules/**', 8000);
    } catch {
      return idx;
    }

    for (const uri of files) {
      let text: string;
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        text = new TextDecoder().decode(bytes);
      } catch {
        continue;
      }

      // A single .al file may contain multiple objects; index each declaration.
      AL_OBJECT_RE.lastIndex = 0;
      const decls: Array<{ type: string; name: string; start: number }> = [];
      let m: RegExpExecArray | null;
      while ((m = AL_OBJECT_RE.exec(text)) !== null) {
        const type = m[1].toLowerCase();
        const name = m[2].trim().replace(/^["']|["']$/g, '');
        decls.push({ type, name, start: m.index });
      }
      for (let i = 0; i < decls.length; i++) {
        const d = decls[i];
        const end = i + 1 < decls.length ? decls[i + 1].start : text.length;
        idx.set(this.key(d.type, d.name), { uri, text, start: d.start, end });
      }
    }
    return idx;
  }

  private key(objectType: string, objectName: string): string {
    return objectType.toLowerCase() + '|' + objectName.toLowerCase();
  }

  /**
   * Return a trimmed AL snippet relevant to the unit identified by its BC note,
   * or undefined if the source cannot be located.
   *
   * Note format: "{ObjectType} {ObjectName} - [{MemberType} {MemberName} -] {PropertyType} {PropName}"
   */
  async getSnippet(note: string | undefined, maxChars = 1100): Promise<string | undefined> {
    if (!note) return undefined;

    const parts = note.split(' - ');
    const head = parts[0];
    const firstSpace = head.indexOf(' ');
    if (firstSpace < 0) return undefined;
    const objectType = head.substring(0, firstSpace).trim();
    const objectName = head.substring(firstSpace + 1).trim();
    if (!objectType || !objectName) return undefined;

    const idx = await this.ensureIndex();
    const entry = idx.get(this.key(objectType, objectName));
    if (!entry) return undefined;

    // Restrict to this object's text region (files may hold several objects).
    const objectText = entry.text.substring(entry.start, entry.end);
    const lines = objectText.split('\n');

    // The object declaration line gives the AI the overall object kind/name.
    const declLine = lines[0] ? lines[0].trim() : `${objectType} ${objectName}`;

    // Resolve the member name to locate (field/control/action/named type).
    let memberName: string | undefined;
    if (parts.length >= 3) {
      const mid = parts[1];
      const midSpace = mid.indexOf(' ');
      memberName = (midSpace >= 0 ? mid.substring(midSpace + 1) : mid).trim();
    }
    if (!memberName) {
      const last = parts[parts.length - 1];
      const lastSpace = last.indexOf(' ');
      memberName = (lastSpace >= 0 ? last.substring(lastSpace + 1) : last).trim();
    }
    memberName = memberName.replace(/^["']|["']$/g, '');
    if (!memberName) return undefined;

    // Find the member declaration line.
    let lineIdx = lines.findIndex((l) => l.includes('"' + memberName + '"'));
    if (lineIdx < 0) {
      lineIdx = lines.findIndex((l) => {
        const re = new RegExp('\\b' + escapeRegExp(memberName!) + '\\b');
        return re.test(l);
      });
    }
    if (lineIdx < 0) return undefined;

    // Capture the member's declaration plus its `{ ... }` property block (balanced braces),
    // capped to a reasonable number of lines.
    const block: string[] = [];
    let depth = 0;
    let opened = false;
    for (let i = lineIdx; i < lines.length && block.length < 28; i++) {
      const l = lines[i];
      block.push(l);
      for (let c = 0; c < l.length; c++) {
        if (l[c] === '{') {
          depth++;
          opened = true;
        } else if (l[c] === '}') {
          depth--;
        }
      }
      if (opened && depth <= 0) break;
    }

    let snippet = declLine + '\n    …\n' + block.join('\n');

    // Second hop: for page fields/cues the data type lives in the underlying table
    // field, not on the page. Resolve SourceTable + the referenced field so the AI
    // sees e.g. `field(...; "No. of Errors"; Integer)` ⇒ a count.
    const tableField = this.resolveTableField(objectType, objectText, block.join('\n'), idx);
    if (tableField) snippet += '\n\n' + tableField;

    snippet = snippet.replace(/\t/g, '  ').replace(/\n{3,}/g, '\n\n').trim();
    if (snippet.length > maxChars) snippet = snippet.slice(0, maxChars).trimEnd() + ' …';
    return snippet;
  }

  /**
   * For a page/pageextension member, find the underlying table field declaration
   * (which carries the data type) by resolving the page's SourceTable and the
   * field's SourceExpr. Returns a short `Table "X" field: <decl>` line or undefined.
   */
  private resolveTableField(
    objectType: string,
    objectText: string,
    memberBlock: string,
    idx: Map<string, AlObjectEntry>
  ): string | undefined {
    const ot = objectType.toLowerCase();
    if (ot !== 'page' && ot !== 'pageextension') return undefined;

    // Find the page's source table.
    const stMatch = objectText.match(/SourceTable\s*=\s*["']?([^"';\n]+?)["']?\s*;/i);
    if (!stMatch) return undefined;
    const tableName = stMatch[1].trim();

    // Find the referenced field name: either `field(Name; <Expr>)` or a SourceExpr.
    // Prefer the expression that points at a Rec field, e.g. Rec."No. of Errors".
    let fieldName: string | undefined;
    const fieldDecl = memberBlock.match(/\bfield\s*\(\s*[^;]*;\s*(?:Rec\.)?["']?([^"'();\n]+?)["']?\s*\)/i);
    if (fieldDecl) fieldName = fieldDecl[1].trim();
    if (!fieldName) {
      const srcExpr = memberBlock.match(/SourceExpr\s*=\s*(?:Rec\.)?["']?([^"';\n]+?)["']?\s*;/i);
      if (srcExpr) fieldName = srcExpr[1].trim();
    }
    if (!fieldName) return undefined;

    // Look up the table (or tableextension) and locate the field declaration line.
    const tableEntry =
      idx.get(this.key('table', tableName)) || idx.get(this.key('tableextension', tableName));
    if (!tableEntry) return undefined;
    const tText = tableEntry.text.substring(tableEntry.start, tableEntry.end);
    const tLines = tText.split('\n');
    const declLine = tLines.find(
      (l) => /^\s*field\s*\(/i.test(l) && l.includes('"' + fieldName + '"')
    );
    if (!declLine) return undefined;
    return `Table "${tableName}" field: ${declLine.trim()}`;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
