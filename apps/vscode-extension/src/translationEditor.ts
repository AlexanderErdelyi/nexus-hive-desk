import * as path from 'path';
import * as vscode from 'vscode';
import { parseXliff, serializeXliff, filterUnits } from '@nexus/xliff';
import type { TranslationState, XliffUnit } from '@nexus/xliff';
import type { AIProvider } from '@nexus/ai';
import { createAIProvider, getConfig } from './provider';
import { getWebviewContent } from './webviewContent';
import { pendingFilters, pendingSearches, pendingUnitIds } from './state';
import { getTmManager } from './tmManager';
import type { TmMatch } from './tmManager';
import { getGlossaryManager } from './glossaryManager';

// ─── Glossary helper ───────────────────────────────────────────────────────────

/** Load glossary terms for the given language pair, shaped for the AI translate request. */
async function loadGlossary(
  context: vscode.ExtensionContext,
  srcLang: string,
  tgtLang: string
): Promise<Array<{ sourceTerm: string; targetTerm: string }>> {
  try {
    const entries = await getGlossaryManager(context).getAll(srcLang, tgtLang);
    return entries.map((e) => ({ sourceTerm: e.sourceTerm, targetTerm: e.targetTerm }));
  } catch {
    return [];
  }
}

// ─── Duplicate <target> detection ──────────────────────────────────────────────

/** Returns the ids of trans-units that contain more than one <target> element. */
function findDuplicateTargetIds(xmlText: string): string[] {
  const duplicates: string[] = [];
  const unitRe = /<trans-unit\b[^>]*\bid="([^"]+)"[\s\S]*?<\/trans-unit>/g;
  let m: RegExpExecArray | null;
  while ((m = unitRe.exec(xmlText)) !== null) {
    const block = m[0];
    const targetCount = (block.match(/<target\b/g) ?? []).length;
    if (targetCount > 1) duplicates.push(m[1]);
  }
  return duplicates;
}

// ─── Provider registration ────────────────────────────────────────────────────

export class TranslationEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'nexus.translationEditor';

  /** Registry of all currently open translation editor panels, keyed by document URI. */
  private static readonly activePanels = new Map<string, vscode.WebviewPanel>();

  /** If the document is already open in a panel, apply a search filter and focus it. */
  public static applyFilter(uri: vscode.Uri, filter: string, searchText?: string, unitIds?: string[]): boolean {
    const panel = TranslationEditorProvider.activePanels.get(uri.toString());
    if (!panel) return false;
    panel.reveal(undefined, false);
    const objectFilters = filter.split(',').map((f) => f.trim()).filter(Boolean);
    panel.webview.postMessage({ type: 'setFilter', filter: searchText || '', objectFilters, state: 'all', diffUnitIds: unitIds ?? null });
    return true;
  }

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      TranslationEditorProvider.viewType,
      new TranslationEditorProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    );
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  // ─── Core lifecycle ───────────────────────────────────────────────────────

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    webviewPanel.webview.options = { enableScripts: true };
    webviewPanel.webview.html = getWebviewContent(
      webviewPanel.webview.cspSource,
      getNonce()
    );

    // Register this panel so commands can find it even when already open
    const uriKey = document.uri.toString();
    TranslationEditorProvider.activePanels.set(uriKey, webviewPanel);

    // Track pending in-memory changes for this editor instance.
    const pendingChanges = new Map<string, { target: string; state: TranslationState }>();

    const sendInit = async () => {
      try {
        const parsed = parseXliff(document.getText());
        const initialFilter = pendingFilters.get(uriKey);
        if (initialFilter) pendingFilters.delete(uriKey);
        const initialSearch = pendingSearches.get(uriKey);
        if (initialSearch) pendingSearches.delete(uriKey);
        const objectFilters = initialFilter
          ? initialFilter.split(',').map((f) => f.trim()).filter(Boolean)
          : [];
        const initialUnitIds = pendingUnitIds.get(uriKey);
        if (initialUnitIds) pendingUnitIds.delete(uriKey);
        webviewPanel.webview.postMessage({
          type: 'init',
          units: parsed.units,
          sourceLanguage: parsed.sourceLanguage,
          targetLanguage: parsed.targetLanguage,
          fileName: path.basename(document.fileName),
          objectFilters,
          filterSearch: initialSearch || '',
          duplicateTargetIds: findDuplicateTargetIds(document.getText()),
          diffUnitIds: initialUnitIds ?? null,
        });
        // Fire-and-forget: compute TM suggestions and push them once ready
        // Also auto-populate TM from this file if TM is empty (first use)
        const tm = getTmManager(this.context);
        const srcLang2 = parsed.sourceLanguage || getConfig().sourceLanguage;
        const tgtLang2 = parsed.targetLanguage || getConfig().targetLanguage;
        const existingEntries = await tm.getAll(srcLang2, tgtLang2);
        if (existingEntries.length === 0) {
          // TM is empty — silently seed it from current file's translated units
          const confirmed = parsed.units.filter(
            (u) => u.target && u.target.trim() && (u.state === 'translated' || u.state === 'final' || u.state === 'signed-off')
          );
          if (confirmed.length > 0) {
            await tm.upsertBatch(
              confirmed.map((u) => ({ source: u.source, target: u.target })),
              srcLang2, tgtLang2
            );
          }
        }
        void sendTmSuggestions(
          parsed.units,
          srcLang2,
          tgtLang2
        );
      } catch (err: unknown) {
        webviewPanel.webview.postMessage({
          type: 'error',
          message: `Failed to parse XLIFF: ${(err as Error).message}`,
        });
      }
    };

    // ─── TM suggestions ──────────────────────────────────────────────────────
    // Look up local Translation Memory matches for untranslated (and exact-match)
    // units and push them to the webview as inline suggestion pills.

    const sendTmSuggestions = async (units: XliffUnit[], srcLang: string, tgtLang: string) => {
      try {
        const tm = getTmManager(this.context);
        // Look up all units' sources — show suggestions for untranslated units and
        // exact (100%) confirmations for already-translated ones.
        const sources = units.map((u) => u.source).filter(Boolean);
        if (sources.length === 0) return;
        const suggestions = await tm.lookup(sources, srcLang, tgtLang);
        const byId: Record<string, TmMatch[]> = {};
        for (const unit of units) {
          const matches = suggestions[unit.source];
          if (!matches || matches.length === 0) continue;
          // For units that already have a target, only keep an exact (100%) confirmation
          if (unit.target && unit.target.trim()) {
            if (matches[0].score >= 100) byId[unit.id] = matches;
          } else {
            byId[unit.id] = matches;
          }
        }
        webviewPanel.webview.postMessage({ type: 'tmSuggestions', suggestions: byId });
      } catch {
        // TM is best-effort — ignore failures
      }
    };

    // ─── Message handler ─────────────────────────────────────────────────────

    const msgHandler = webviewPanel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type as string) {
        case 'ready':
          void sendInit();
          break;

        case 'updateUnit':
          pendingChanges.set(msg.id as string, {
            target: msg.target as string,
            state: msg.state as TranslationState,
          });
          break;

        case 'save':
          await doSave(document, webviewPanel, pendingChanges, this.context);
          pendingChanges.clear();
          webviewPanel.webview.postMessage({ type: 'saved' });
          break;

        case 'translateAll':
          await handleTranslateAll(document, webviewPanel, pendingChanges, this.context);
          break;

        case 'bulkTranslate':
          await handleBulkTranslate(document, webviewPanel, pendingChanges, this.context, msg.ids as string[]);
          break;

        case 'bulkTmApply':
          await handleBulkTmApply(document, webviewPanel, pendingChanges, this.context, msg.items as { id: string; source: string }[]);
          break;

        case 'bulkSetStatus':
          handleBulkSetStatus(pendingChanges, webviewPanel, msg.items as { id: string; target: string; state: TranslationState }[]);
          break;

        case 'cleanupDuplicates':
          handleCleanupDuplicates(document, webviewPanel, pendingChanges, msg.ids as string[]);
          break;

        case 'upsertTm':
          await getTmManager(this.context).upsert(
            msg.source as string, msg.target as string, msg.srcLang as string, msg.tgtLang as string
          );
          break;

        case 'translateUnit':
          await handleTranslateUnit(
            document, webviewPanel, pendingChanges, this.context,
            msg.id as string, msg.source as string
          );
          break;

        case 'qualityCheck': {
          // Validate placeholders and find inconsistencies inline
          const parsed2 = parseXliff(document.getText());
          const issues: Array<{
            id: string;
            type: 'placeholder' | 'inconsistency';
            message: string;
            variants?: Array<{ target: string; count: number }>;
          }> = [];

          // 1. Placeholder check: find %1, %2, {0}, {1} in source but not in target
          const placeholderRe = /%\d+|\{[\d]+\}/g;
          for (const unit of parsed2.units) {
            if (!unit.target || !unit.target.trim()) continue;
            const srcPh = Array.from(new Set((unit.source.match(placeholderRe) || []).map((p) => p.toLowerCase())));
            const tgtPh = Array.from(new Set((unit.target.match(placeholderRe) || []).map((p) => p.toLowerCase())));
            const missing = srcPh.filter((p) => !tgtPh.includes(p));
            const extra = tgtPh.filter((p) => !srcPh.includes(p));
            if (missing.length > 0) {
              issues.push({ id: unit.id, type: 'placeholder', message: `Missing placeholder(s): ${missing.join(', ')}` });
            } else if (extra.length > 0) {
              issues.push({ id: unit.id, type: 'placeholder', message: `Extra placeholder(s) in target: ${extra.join(', ')}` });
            }
          }

          // 2. Inconsistency check: same source → different targets
          const srcToTargets = new Map<string, { id: string; target: string }[]>();
          for (const unit of parsed2.units) {
            if (!unit.target || !unit.target.trim()) continue;
            const key = unit.source.trim().toLowerCase();
            if (!srcToTargets.has(key)) srcToTargets.set(key, []);
            srcToTargets.get(key)!.push({ id: unit.id, target: unit.target.trim() });
          }
          for (const [, entries] of srcToTargets) {
            const uniqueTargets = [...new Set(entries.map((e) => e.target))];
            if (uniqueTargets.length > 1) {
              // Count how many rows use each variant
              const variantCounts = uniqueTargets.map((t) => ({
                target: t,
                count: entries.filter((e) => e.target === t).length,
              }));
              for (const entry of entries) {
                issues.push({
                  id: entry.id,
                  type: 'inconsistency',
                  message: `Inconsistent: ${uniqueTargets.length} different translations used for this source`,
                  variants: variantCounts,
                });
              }
            }
          }

          webviewPanel.webview.postMessage({ type: 'qualityResults', issues });
          break;
        }

        case 'applyToSource': {
          // Apply one target to ALL units that share the same source text
          const { source, target } = msg as { source: string; target: string };
          const parsed3 = parseXliff(document.getText());
          const toUpdate = parsed3.units.filter(
            (u) => u.source.trim().toLowerCase() === source.trim().toLowerCase()
          );
          for (const u of toUpdate) {
            pendingChanges.set(u.id, { target, state: 'translated' as TranslationState });
          }
          webviewPanel.webview.postMessage({
            type: 'applyToSourceDone',
            ids: toUpdate.map((u) => u.id),
            target,
          });
          break;
        }

        case 'reviewAll':
          await handleReviewAll(document, webviewPanel, this.context);
          break;

        case 'populateTm': {
          const parsed = parseXliff(document.getText());
          const srcLang = parsed.sourceLanguage || getConfig().sourceLanguage;
          const tgtLang = parsed.targetLanguage || getConfig().targetLanguage;
          const toImport = parsed.units.filter(
            (u) => u.target && ['translated', 'final', 'signed-off'].includes(u.state || '')
          );
          await getTmManager(this.context).upsertBatch(
            toImport.map((u) => ({ source: u.source, target: u.target })),
            srcLang,
            tgtLang
          );
          webviewPanel.webview.postMessage({
            type: 'notification',
            message: `Imported ${toImport.length} units into TM`,
          });
          break;
        }

        case 'openAsText':
          // Open the same file in the default text editor (bypasses our custom editor)
          await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
          break;

        case 'goToSource':
          await goToSource(msg.note as string);
          break;
      }
    });

    // ─── Ctrl+S hook ─────────────────────────────────────────────────────────
    // Apply pending changes as TextEdits so the document saves correctly.

    const willSaveHandler = vscode.workspace.onWillSaveTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      if (pendingChanges.size === 0) return;

      const newContent = serializeXliff(document.getText(), pendingChanges);
      const fullRange = new vscode.Range(0, 0, document.lineCount, 0);
      e.waitUntil(Promise.resolve([new vscode.TextEdit(fullRange, newContent)]));

      // Notify webview after the save completes, and harvest confirmed units into TM
      setTimeout(() => {
        pendingChanges.clear();
        void populateTmFromContent(this.context, newContent);
        webviewPanel.webview.postMessage({ type: 'saved' });
      }, 150);
    });

    // ─── External change watcher ─────────────────────────────────────────────
    // If the file changes on disk (e.g. git pull), refresh the webview.

    const changeHandler = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      if (e.reason === vscode.TextDocumentChangeReason.Undo ||
          e.reason === vscode.TextDocumentChangeReason.Redo) {
        pendingChanges.clear();
        void sendInit();
      }
    });

    webviewPanel.onDidDispose(() => {
      TranslationEditorProvider.activePanels.delete(uriKey);
      msgHandler.dispose();
      willSaveHandler.dispose();
      changeHandler.dispose();
    });
  }
}

// ─── Save helper ──────────────────────────────────────────────────────────────

async function doSave(
  document: vscode.TextDocument,
  _webviewPanel: vscode.WebviewPanel,
  changes: Map<string, { target: string; state: TranslationState }>,
  context: vscode.ExtensionContext
): Promise<void> {
  if (changes.size === 0) {
    await document.save();
    return;
  }
  const newContent = serializeXliff(document.getText(), changes);
  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(0, 0, document.lineCount, 0);
  edit.replace(document.uri, fullRange, newContent);
  await vscode.workspace.applyEdit(edit);
  await document.save();
  await populateTmFromContent(context, newContent);
}

/** Harvest confirmed (translated/final) units from XLIFF content into local TM. */
async function populateTmFromContent(context: vscode.ExtensionContext, content: string): Promise<void> {
  try {
    const parsed = parseXliff(content);
    const srcLang = parsed.sourceLanguage || getConfig().sourceLanguage;
    const tgtLang = parsed.targetLanguage || getConfig().targetLanguage;
    const confirmed = parsed.units.filter(
      (u) => u.target && u.target.trim() && (u.state === 'translated' || u.state === 'final')
    );
    if (confirmed.length === 0) return;
    await getTmManager(context).upsertBatch(
      confirmed.map((u) => ({ source: u.source, target: u.target })),
      srcLang,
      tgtLang
    );
  } catch {
    // best-effort
  }
}

// ─── Translate All ────────────────────────────────────────────────────────────

async function handleTranslateAll(
  document: vscode.TextDocument,
  webviewPanel: vscode.WebviewPanel,
  pendingChanges: Map<string, { target: string; state: TranslationState }>,
  context: vscode.ExtensionContext,
  filterIds?: string[]
): Promise<void> {
  let provider: AIProvider;
  try {
    provider = await createAIProvider(context);
  } catch (err: unknown) {
    webviewPanel.webview.postMessage({ type: 'error', message: (err as Error).message });
    return;
  }

  let parsed;
  try {
    parsed = parseXliff(document.getText());
  } catch (err: unknown) {
    webviewPanel.webview.postMessage({ type: 'error', message: `Parse error: ${(err as Error).message}` });
    return;
  }

  const config = getConfig();
  const srcLang = parsed.sourceLanguage || config.sourceLanguage;
  const tgtLang = parsed.targetLanguage || config.targetLanguage;
  const glossary = await loadGlossary(context, srcLang, tgtLang);

  let targets: XliffUnit[];
  if (filterIds && filterIds.length > 0) {
    // Bulk translate: translate exactly the selected ids (regardless of current state)
    const idSet = new Set(filterIds);
    targets = parsed.units.filter((u) => idSet.has(u.id));
  } else {
    targets = filterUnits(parsed.units, { untranslatedOnly: true });
  }

  if (targets.length === 0) {
    webviewPanel.webview.postMessage({ type: 'error', message: 'No units to translate.' });
    return;
  }

  webviewPanel.webview.postMessage({ type: 'translating', ids: targets.map((u) => u.id) });

  try {
    const batchSize = config.batchSize;
    for (let i = 0; i < targets.length; i += batchSize) {
      const batch = targets.slice(i, i + batchSize);
      const response = await provider.translate({
        units: batch.map((u) => ({ id: u.id, source: u.source })),
        sourceLanguage: srcLang,
        targetLanguage: tgtLang,
        ...(glossary.length > 0 ? { glossary } : {}),
      });

      // Stream partial results back to webview as each batch completes
      webviewPanel.webview.postMessage({ type: 'translationResults', results: response.results });

      for (const r of response.results) {
        pendingChanges.set(r.id, { target: r.translatedText, state: 'translated' });
      }
    }
  } catch (err: unknown) {
    webviewPanel.webview.postMessage({ type: 'error', message: `Translation failed: ${(err as Error).message}` });
  }
}

/** Bulk AI-translate only the given unit ids. */
async function handleBulkTranslate(
  document: vscode.TextDocument,
  webviewPanel: vscode.WebviewPanel,
  pendingChanges: Map<string, { target: string; state: TranslationState }>,
  context: vscode.ExtensionContext,
  ids: string[]
): Promise<void> {
  if (!ids || ids.length === 0) {
    webviewPanel.webview.postMessage({ type: 'error', message: 'No units selected.' });
    return;
  }
  await handleTranslateAll(document, webviewPanel, pendingChanges, context, ids);
}

/** Apply the best local TM match to each selected unit. */
async function handleBulkTmApply(
  document: vscode.TextDocument,
  webviewPanel: vscode.WebviewPanel,
  pendingChanges: Map<string, { target: string; state: TranslationState }>,
  context: vscode.ExtensionContext,
  items: Array<{ id: string; source: string }>
): Promise<void> {
  if (!items || items.length === 0) return;
  const tm = getTmManager(context);
  let parsed;
  try {
    parsed = parseXliff(document.getText());
  } catch (err: unknown) {
    webviewPanel.webview.postMessage({ type: 'error', message: `Parse error: ${(err as Error).message}` });
    return;
  }
  const config = getConfig();
  const srcLang = parsed.sourceLanguage || config.sourceLanguage;
  const tgtLang = parsed.targetLanguage || config.targetLanguage;
  const sources = items.map((i) => i.source);
  const sugg = await tm.lookup(sources, srcLang, tgtLang);

  const results: Array<{ id: string; translatedText: string; confidenceScore: number }> = [];
  for (const item of items) {
    const match = sugg[item.source]?.[0];
    if (match) {
      pendingChanges.set(item.id, { target: match.target, state: 'translated' });
      results.push({ id: item.id, translatedText: match.target, confidenceScore: match.score });
    }
  }

  if (results.length === 0) {
    webviewPanel.webview.postMessage({ type: 'error', message: 'No TM matches found for the selected units.' });
    return;
  }
  webviewPanel.webview.postMessage({ type: 'translationResults', results });
}

/** Set the translation state for a batch of units, preserving their current target. */
function handleBulkSetStatus(
  pendingChanges: Map<string, { target: string; state: TranslationState }>,
  webviewPanel: vscode.WebviewPanel,
  items: Array<{ id: string; target: string; state: TranslationState }>
): void {
  if (!items || items.length === 0) return;
  for (const item of items) {
    pendingChanges.set(item.id, { target: item.target ?? '', state: item.state });
  }
  webviewPanel.webview.postMessage({
    type: 'bulkStatusUpdated',
    ids: items.map((i) => i.id),
    items,
  });
}

/** Mark units with duplicate <target> elements as pending so a save rewrites them cleanly. */
function handleCleanupDuplicates(
  document: vscode.TextDocument,
  webviewPanel: vscode.WebviewPanel,
  pendingChanges: Map<string, { target: string; state: TranslationState }>,
  ids: string[]
): void {
  if (!ids || ids.length === 0) return;
  let parsed;
  try {
    parsed = parseXliff(document.getText());
  } catch (err: unknown) {
    webviewPanel.webview.postMessage({ type: 'error', message: `Parse error: ${(err as Error).message}` });
    return;
  }
  const unitMap = new Map(parsed.units.map((u) => [u.id, u]));
  for (const id of ids) {
    const unit = unitMap.get(id);
    if (unit) pendingChanges.set(id, { target: unit.target, state: unit.state });
  }
  webviewPanel.webview.postMessage({ type: 'cleanupReady', ids });
}

// ─── Translate Single ─────────────────────────────────────────────────────────

async function handleTranslateUnit(
  document: vscode.TextDocument,
  webviewPanel: vscode.WebviewPanel,
  pendingChanges: Map<string, { target: string; state: TranslationState }>,
  context: vscode.ExtensionContext,
  unitId: string,
  source: string
): Promise<void> {
  let provider: AIProvider;
  try {
    provider = await createAIProvider(context);
  } catch (err: unknown) {
    webviewPanel.webview.postMessage({ type: 'error', message: (err as Error).message });
    return;
  }

  let parsed;
  try {
    parsed = parseXliff(document.getText());
  } catch (err: unknown) {
    webviewPanel.webview.postMessage({ type: 'error', message: `Parse error: ${(err as Error).message}` });
    return;
  }

  const config = getConfig();
  const srcLang = parsed.sourceLanguage || config.sourceLanguage;
  const tgtLang = parsed.targetLanguage || config.targetLanguage;
  const glossary = await loadGlossary(context, srcLang, tgtLang);

  try {
    const response = await provider.translate({
      units: [{ id: unitId, source }],
      sourceLanguage: srcLang,
      targetLanguage: tgtLang,
      ...(glossary.length > 0 ? { glossary } : {}),
    });

    const result = response.results[0];
    if (result) {
      pendingChanges.set(unitId, { target: result.translatedText, state: 'translated' });
    }

    webviewPanel.webview.postMessage({ type: 'translationResults', results: response.results });
  } catch (err: unknown) {
    webviewPanel.webview.postMessage({ type: 'error', message: `Translation failed: ${(err as Error).message}` });
  }
}

// ─── Review All ───────────────────────────────────────────────────────────────

async function handleReviewAll(
  document: vscode.TextDocument,
  webviewPanel: vscode.WebviewPanel,
  context: vscode.ExtensionContext
): Promise<void> {
  let provider: AIProvider;
  try {
    provider = await createAIProvider(context);
  } catch (err: unknown) {
    webviewPanel.webview.postMessage({ type: 'error', message: (err as Error).message });
    return;
  }

  let parsed;
  try {
    parsed = parseXliff(document.getText());
  } catch (err: unknown) {
    webviewPanel.webview.postMessage({ type: 'error', message: `Parse error: ${(err as Error).message}` });
    return;
  }

  const config = getConfig();
  const srcLang = parsed.sourceLanguage || config.sourceLanguage;
  const tgtLang = parsed.targetLanguage || config.targetLanguage;

  const reviewable = parsed.units.filter(
    (u) =>
      u.target.trim() &&
      (u.state === 'translated' ||
       u.state === 'needs-review-translation' ||
       u.state === 'final')
  );

  if (reviewable.length === 0) {
    webviewPanel.webview.postMessage({ type: 'error', message: 'No translated units to review.' });
    return;
  }

  webviewPanel.webview.postMessage({ type: 'reviewing', ids: reviewable.map((u) => u.id) });

  try {
    const batchSize = config.batchSize;
    const allResults: Array<{ id: string; quality: string; reason?: string; suggestion?: string }> = [];

    for (let i = 0; i < reviewable.length; i += batchSize) {
      const batch = reviewable.slice(i, i + batchSize);
      const response = await provider.review({
        units: batch.map((u) => ({
          id: u.id,
          source: u.source,
          target: u.target,
          ...(u.developerNote ? { context: u.developerNote } : {}),
        })),
        sourceLanguage: srcLang,
        targetLanguage: tgtLang,
      });
      allResults.push(...response.results);
    }

    webviewPanel.webview.postMessage({ type: 'reviewResults', results: allResults });
  } catch (err: unknown) {
    webviewPanel.webview.postMessage({ type: 'error', message: `Review failed: ${(err as Error).message}` });
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) nonce += chars[Math.floor(Math.random() * chars.length)];
  return nonce;
}

// ─── Go to source ─────────────────────────────────────────────────────────────

const BC_OBJECT_TYPES_LOWER = new Set([
  'table', 'tableextension', 'page', 'pageextension', 'pagecustomization',
  'codeunit', 'report', 'reportextension', 'xmlport', 'query',
  'enum', 'enumextension', 'profile', 'interface', 'permissionset',
]);

/**
 * Navigate to the AL source file for the given BC XLIFF Xliff-Generator note.
 * Note format: "{ObjectType} {ObjectName} - [{MemberType} {MemberName} -] {PropertyType} {PropName}"
 * Mirrors the web app's vscode-link API logic.
 */
async function goToSource(note: string): Promise<void> {
  if (!note) {
    vscode.window.showWarningMessage('No source note available for this unit.');
    return;
  }

  const parts = note.split(' - ');
  const firstSpace = parts[0].indexOf(' ');
  const objectType = firstSpace >= 0 ? parts[0].substring(0, firstSpace) : '';
  const objectName = firstSpace >= 0 ? parts[0].substring(firstSpace + 1).trim() : '';

  if (!BC_OBJECT_TYPES_LOWER.has(objectType.toLowerCase()) || !objectName) {
    // Can't parse — open workspace search as fallback
    await vscode.commands.executeCommand('workbench.action.findInFiles', {
      query: note.split(' - ')[0].trim(),
      triggerSearch: true,
    });
    return;
  }

  // Parse member name (from middle segment) for precise field/method navigation
  // Note format: "{ObjectType} {ObjectName} - [{MemberType} {MemberName} -] {PropertyType} {PropName}"
  // For "Table Authorization - Field Address2 - Property Caption":
  //   memberName = "Address2"  (search for this → lands on the field declaration)
  // For "Codeunit PIM Export - NamedType FileSuffixLbl":
  //   propertyValue = "FileSuffixLbl" (unique label name → found directly)
  let searchText: string | undefined;
  if (parts.length >= 3) {
    // 3-segment note: member-level property — navigate by member name
    const mid = parts[1];
    const midSpace = mid.indexOf(' ');
    const memberName = midSpace >= 0 ? mid.substring(midSpace + 1).trim() : mid.trim();
    if (memberName) searchText = memberName;
  }
  // Fallback: use the last segment's value (e.g. unique NamedType label)
  if (!searchText) {
    const lastPart = parts[parts.length - 1];
    const lastSpace = lastPart.indexOf(' ');
    searchText = lastSpace >= 0 ? lastPart.substring(lastSpace + 1) : lastPart;
  }

  // AL object declaration regex — matches "tableextension 50200 "My Name" {"
  const AL_OBJECT_RE = /^(tableextension|table|pagecustomization|pageextension|page|codeunit|reportextension|report|xmlport|query|enumextension|enum|profile|interface|permissionset)\s+\d+\s+["']?([^"'{\n]+?)["']?\s*[{(]/im;

  const files = await vscode.workspace.findFiles('**/*.al', '**/node_modules/**');

  for (const fileUri of files) {
    let text: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(fileUri);
      text = new TextDecoder().decode(bytes);
    } catch { continue; }

    const m = AL_OBJECT_RE.exec(text);
    if (!m) continue;
    const declaredName = m[2].trim().replace(/^["']|["']$/g, '');
    if (declaredName.toLowerCase() !== objectName.toLowerCase()) continue;

    const doc = await vscode.workspace.openTextDocument(fileUri);

    // Find the specific member/property line by name.
    // Field names in AL are quoted: field(12; "Address2"; ...) → search for '"Address2"'
    let targetLine = -1;
    if (searchText) {
      const lines = text.split('\n');
      // Try quoted first (AL field/method names), then unquoted
      const quotedIdx = lines.findIndex((l) => l.includes(`"${searchText}"`));
      const rawIdx    = lines.findIndex((l) => l.includes(searchText!));
      targetLine = quotedIdx >= 0 ? quotedIdx : rawIdx;
    }

    const pos = new vscode.Position(Math.max(0, targetLine), 0);
    await vscode.window.showTextDocument(doc, {
      selection: new vscode.Range(pos, pos),
      preserveFocus: false,
    });
    return;
  }

  vscode.window.showWarningMessage(
    `Could not find ${objectType} "${objectName}" in .al files. Opening workspace search.`
  );
  await vscode.commands.executeCommand('workbench.action.findInFiles', {
    query: objectName,
    triggerSearch: true,
    filesToInclude: '*.al',
  });
}
