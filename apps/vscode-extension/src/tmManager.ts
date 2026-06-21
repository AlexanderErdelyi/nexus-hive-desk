import * as path from 'path';
import * as vscode from 'vscode';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface TmEntry {
  source: string;
  target: string;
  sourceLanguage: string;
  targetLanguage: string;
  usageCount: number;
  updatedAt: string;
}

export interface TmMatch {
  target: string;
  score: number; // 0–100 integer
  sourceText: string; // the TM entry's source (may differ slightly from lookup source)
}

// ─── Similarity helpers (normalised Levenshtein, mirrors apps/api TM route) ──────

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;                        // exact case-sensitive match → 100%
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  // Quick length-ratio pre-filter: if strings differ in length by >40%, Levenshtein
  // score can never reach FUZZY_THRESHOLD (0.75), so skip the expensive computation.
  const minLen = Math.min(a.length, b.length);
  if (minLen / maxLen < 0.6) return 0;
  // Case-insensitive fuzzy score, capped at 0.99 so it never shows as "100%" when case differs
  const fuzzy = 1 - levenshtein(a.toLowerCase(), b.toLowerCase()) / maxLen;
  return Math.min(fuzzy, 0.99);
}

const FUZZY_THRESHOLD = 0.75;

// ─── TmManager ───────────────────────────────────────────────────────────────

export class TmManager {
  private entries: TmEntry[] = [];
  private loaded = false;
  private readonly fileName = 'tm.json';
  private readonly globalUri: vscode.Uri;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly workspaceRoot?: string
  ) {
    // Fallback location in VS Code's per-user global storage.
    this.globalUri = vscode.Uri.joinPath(context.globalStorageUri, 'translation-memory.json');
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
      const data = JSON.parse(text) as TmEntry[];
      this.entries = Array.isArray(data) ? data : [];
    } catch {
      // File does not exist yet — start with an empty store
      this.entries = [];
    }
    this.loaded = true;
  }

  private writeQueue: Promise<void> = Promise.resolve();

  private async persist(): Promise<void> {
    // Serialize writes so concurrent upserts can't interleave read-modify-write,
    // and snapshot the entries at enqueue time to keep each write self-consistent.
    const snapshot = JSON.stringify(this.entries, null, 2);
    const run = this.writeQueue.then(() => this.writeAtomic(snapshot));
    // Keep the chain alive even if one write fails.
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

  /** Find up to 3 TM matches (sorted by score DESC) for each requested source string. */
  async lookup(
    sources: string[],
    srcLang: string,
    tgtLang: string
  ): Promise<Record<string, TmMatch[]>> {
    await this.ensureLoaded();
    const pool = this.entries.filter(
      (e) => e.sourceLanguage === srcLang && e.targetLanguage === tgtLang
    );
    const results: Record<string, TmMatch[]> = {};

    for (const source of sources) {
      type Candidate = { target: string; textScore: number; usageCount: number; sourceText: string };
      const candidates: Candidate[] = [];

      for (const entry of pool) {
        const score = similarity(source, entry.source);
        if (score >= FUZZY_THRESHOLD) {
          const existing = candidates.find((c) => c.target === entry.target);
          if (existing) {
            if (score > existing.textScore) {
              existing.textScore = score;
              existing.sourceText = entry.source;
            }
            existing.usageCount += entry.usageCount;
          } else {
            candidates.push({ target: entry.target, textScore: score, usageCount: entry.usageCount, sourceText: entry.source });
          }
        }
      }

      if (!candidates.length) continue;

      const maxCount = Math.max(...candidates.map((c) => c.usageCount), 1);
      const weighted = candidates.map((c) => ({
        target: c.target,
        score: Math.round(c.textScore * (0.6 + 0.4 * (c.usageCount / maxCount)) * 100),
        sourceText: c.sourceText,
        usageCount: c.usageCount,
      }));

      weighted.sort((a, b) => b.score - a.score || b.usageCount - a.usageCount);

      results[source] = weighted.slice(0, 3).map((w) => ({
        target: w.target,
        score: w.score,
        sourceText: w.sourceText,
      }));
    }

    return results;
  }

  /** Add a new TM entry or update/increment an existing one for the same source. */
  async upsert(source: string, target: string, srcLang: string, tgtLang: string): Promise<void> {
    if (!source || !target || !srcLang || !tgtLang) return;
    await this.ensureLoaded();
    const existing = this.entries.find(
      (e) => e.source === source && e.sourceLanguage === srcLang && e.targetLanguage === tgtLang
    );
    if (existing) {
      existing.target = target;
      existing.usageCount += 1;
      existing.updatedAt = new Date().toISOString();
    } else {
      this.entries.push({
        source,
        target,
        sourceLanguage: srcLang,
        targetLanguage: tgtLang,
        usageCount: 1,
        updatedAt: new Date().toISOString(),
      });
    }
    await this.persist();
  }

  /** Bulk add/update entries (e.g. on save). Persists once at the end. */
  async upsertBatch(
    items: Array<{ source: string; target: string }>,
    srcLang: string,
    tgtLang: string
  ): Promise<void> {
    if (!items.length || !srcLang || !tgtLang) return;
    await this.ensureLoaded();
    const now = new Date().toISOString();
    for (const item of items) {
      if (!item.source || !item.target) continue;
      const existing = this.entries.find(
        (e) => e.source === item.source && e.sourceLanguage === srcLang && e.targetLanguage === tgtLang
      );
      if (existing) {
        if (existing.target !== item.target) {
          existing.target = item.target;
          existing.updatedAt = now;
        }
      } else {
        this.entries.push({
          source: item.source,
          target: item.target,
          sourceLanguage: srcLang,
          targetLanguage: tgtLang,
          usageCount: 1,
          updatedAt: now,
        });
      }
    }
    await this.persist();
  }

  /** Return all entries, optionally filtered by language pair. */
  async getAll(srcLang?: string, tgtLang?: string): Promise<TmEntry[]> {
    await this.ensureLoaded();
    return this.entries.filter(
      (e) =>
        (srcLang ? e.sourceLanguage === srcLang : true) &&
        (tgtLang ? e.targetLanguage === tgtLang : true)
    );
  }

  /** Remove a single entry by source + language pair. */
  async deleteEntry(source: string, srcLang: string, tgtLang: string): Promise<void> {
    await this.ensureLoaded();
    const before = this.entries.length;
    this.entries = this.entries.filter(
      (e) => !(e.source === source && e.sourceLanguage === srcLang && e.targetLanguage === tgtLang)
    );
    if (this.entries.length !== before) await this.persist();
  }
}

// ─── Singleton accessor ──────────────────────────────────────────────────────

let instance: TmManager | undefined;

export function getTmManager(
  context: vscode.ExtensionContext,
  workspaceRoot?: string
): TmManager {
  if (!instance) {
    instance = new TmManager(
      context,
      workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    );
  }
  return instance;
}
