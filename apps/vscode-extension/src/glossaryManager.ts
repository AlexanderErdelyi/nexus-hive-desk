import * as vscode from 'vscode';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface GlossaryEntry {
  id: string;
  sourceTerm: string;
  targetTerm: string;
  sourceLanguage: string;
  targetLanguage: string;
  description?: string;
  caseSensitive: boolean;
  createdAt: string;
}

// ─── GlossaryManager ───────────────────────────────────────────────────────────

export class GlossaryManager {
  private entries: GlossaryEntry[] = [];
  private loaded = false;
  private readonly fileUri: vscode.Uri;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.fileUri = vscode.Uri.joinPath(context.globalStorageUri, 'glossary.json');
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const bytes = await vscode.workspace.fs.readFile(this.fileUri);
      const text = new TextDecoder().decode(bytes);
      const data = JSON.parse(text) as GlossaryEntry[];
      this.entries = Array.isArray(data) ? data : [];
    } catch {
      this.entries = [];
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    } catch {
      // Directory may already exist — ignore
    }
    const text = JSON.stringify(this.entries, null, 2);
    await vscode.workspace.fs.writeFile(this.fileUri, new TextEncoder().encode(text));
  }

  /** Return all glossary terms, optionally filtered by language pair. */
  async getAll(srcLang?: string, tgtLang?: string): Promise<GlossaryEntry[]> {
    await this.ensureLoaded();
    return this.entries.filter(
      (e) =>
        (srcLang ? e.sourceLanguage === srcLang : true) &&
        (tgtLang ? e.targetLanguage === tgtLang : true)
    );
  }

  /** Add a new glossary term. Returns the created entry. */
  async add(entry: {
    sourceTerm: string;
    targetTerm: string;
    sourceLanguage: string;
    targetLanguage: string;
    description?: string;
    caseSensitive?: boolean;
  }): Promise<GlossaryEntry> {
    await this.ensureLoaded();
    const created: GlossaryEntry = {
      id: Date.now().toString() + Math.random().toString(36).slice(2, 8),
      sourceTerm: entry.sourceTerm,
      targetTerm: entry.targetTerm,
      sourceLanguage: entry.sourceLanguage,
      targetLanguage: entry.targetLanguage,
      description: entry.description,
      caseSensitive: entry.caseSensitive ?? false,
      createdAt: new Date().toISOString(),
    };
    this.entries.push(created);
    await this.persist();
    return created;
  }

  /** Remove a glossary term by id. */
  async delete(id: string): Promise<void> {
    await this.ensureLoaded();
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length !== before) await this.persist();
  }

  /** Patch an existing glossary term. */
  async update(id: string, patch: Partial<Omit<GlossaryEntry, 'id' | 'createdAt'>>): Promise<void> {
    await this.ensureLoaded();
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    Object.assign(entry, patch);
    await this.persist();
  }
}

// ─── Singleton accessor ──────────────────────────────────────────────────────

let instance: GlossaryManager | undefined;

export function getGlossaryManager(context: vscode.ExtensionContext): GlossaryManager {
  if (!instance) instance = new GlossaryManager(context);
  return instance;
}
