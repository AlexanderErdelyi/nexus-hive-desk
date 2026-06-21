import * as path from 'path';
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
  private readonly fileName = 'glossary.json';
  private readonly globalUri: vscode.Uri;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly workspaceRoot?: string
  ) {
    this.globalUri = vscode.Uri.joinPath(context.globalStorageUri, 'glossary.json');
  }

  /** Resolve the workspace-relative .nexus URI (the canonical write target). */
  private workspaceUri(): vscode.Uri | undefined {
    if (!this.workspaceRoot) return undefined;
    return vscode.Uri.file(path.join(this.workspaceRoot, '.nexus', this.fileName));
  }

  private async fileExists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Where data is written. Workspace-relative `.nexus/` is preferred so the MCP
   * server and extension share the same store; otherwise fall back to globalStorage.
   */
  private async getStoragePath(): Promise<vscode.Uri> {
    const wsUri = this.workspaceUri();
    if (this.workspaceRoot && wsUri) {
      try {
        await vscode.workspace.fs.createDirectory(
          vscode.Uri.file(path.join(this.workspaceRoot, '.nexus'))
        );
      } catch {
        // Directory may already exist — ignore
      }
      return wsUri;
    }
    return this.globalUri;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    // Priority: workspace-relative .nexus file wins if present; else globalStorage.
    let readUri = this.globalUri;
    const wsUri = this.workspaceUri();
    if (wsUri && (await this.fileExists(wsUri))) readUri = wsUri;
    try {
      const bytes = await vscode.workspace.fs.readFile(readUri);
      const text = new TextDecoder().decode(bytes);
      const data = JSON.parse(text) as GlossaryEntry[];
      this.entries = Array.isArray(data) ? data : [];
    } catch {
      this.entries = [];
    }
    this.loaded = true;
  }

  private writeQueue: Promise<void> = Promise.resolve();

  private async persist(): Promise<void> {
    // Serialize writes so concurrent adds can't interleave read-modify-write,
    // and snapshot the entries at enqueue time to keep each write self-consistent.
    const snapshot = JSON.stringify(this.entries, null, 2);
    const run = this.writeQueue.then(() => this.writeAtomic(snapshot));
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  /** Write to a temp file then rename over the target so readers never see a partial file. */
  private async writeAtomic(text: string): Promise<void> {
    const target = await this.getStoragePath();
    if (!this.workspaceUri()) {
      try {
        await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
      } catch {
        // Directory may already exist — ignore
      }
    }
    const bytes = new TextEncoder().encode(text);
    const tmp = target.with({ path: `${target.path}.tmp` });
    await vscode.workspace.fs.writeFile(tmp, bytes);
    try {
      await vscode.workspace.fs.rename(tmp, target, { overwrite: true });
    } catch {
      // Some filesystems can't rename over an open file — fall back to a direct write.
      await vscode.workspace.fs.writeFile(target, bytes);
      try { await vscode.workspace.fs.delete(tmp); } catch { /* ignore */ }
    }
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

export function getGlossaryManager(
  context: vscode.ExtensionContext,
  workspaceRoot?: string
): GlossaryManager {
  if (!instance) {
    instance = new GlossaryManager(
      context,
      workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    );
  }
  return instance;
}
