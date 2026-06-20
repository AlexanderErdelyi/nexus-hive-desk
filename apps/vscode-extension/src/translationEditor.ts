import * as path from 'path';
import * as vscode from 'vscode';
import { parseXliff, serializeXliff, filterUnits } from '@nexus/xliff';
import type { TranslationState } from '@nexus/xliff';
import type { AIProvider, AITranslateResult } from '@nexus/ai';
import { createAIProvider, getConfig } from './provider';
import { getWebviewContent } from './webviewContent';
import { pendingFilters } from './state';

// ─── Provider registration ────────────────────────────────────────────────────

export class TranslationEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'nexus.translationEditor';

  /** Registry of all currently open translation editor panels, keyed by document URI. */
  private static readonly activePanels = new Map<string, vscode.WebviewPanel>();

  /** If the document is already open in a panel, apply a search filter and focus it. */
  public static applyFilter(uri: vscode.Uri, filter: string): boolean {
    const panel = TranslationEditorProvider.activePanels.get(uri.toString());
    if (!panel) return false;
    panel.reveal(undefined, false);
    const objectFilters = filter.split(',').map((f) => f.trim()).filter(Boolean);
    panel.webview.postMessage({ type: 'setFilter', objectFilters, state: 'all' });
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

    const sendInit = () => {
      try {
        const parsed = parseXliff(document.getText());
        const initialFilter = pendingFilters.get(uriKey);
        if (initialFilter) pendingFilters.delete(uriKey);
        const objectFilters = initialFilter
          ? initialFilter.split(',').map((f) => f.trim()).filter(Boolean)
          : [];
        webviewPanel.webview.postMessage({
          type: 'init',
          units: parsed.units,
          sourceLanguage: parsed.sourceLanguage,
          targetLanguage: parsed.targetLanguage,
          fileName: path.basename(document.fileName),
          objectFilters,
        });
      } catch (err: unknown) {
        webviewPanel.webview.postMessage({
          type: 'error',
          message: `Failed to parse XLIFF: ${(err as Error).message}`,
        });
      }
    };

    // ─── Message handler ─────────────────────────────────────────────────────

    const msgHandler = webviewPanel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type as string) {
        case 'ready':
          sendInit();
          break;

        case 'updateUnit':
          pendingChanges.set(msg.id as string, {
            target: msg.target as string,
            state: msg.state as TranslationState,
          });
          break;

        case 'save':
          await doSave(document, webviewPanel, pendingChanges);
          pendingChanges.clear();
          webviewPanel.webview.postMessage({ type: 'saved' });
          break;

        case 'translateAll':
          await handleTranslateAll(document, webviewPanel, pendingChanges, this.context);
          break;

        case 'translateUnit':
          await handleTranslateUnit(
            document, webviewPanel, pendingChanges, this.context,
            msg.id as string, msg.source as string
          );
          break;

        case 'reviewAll':
          await handleReviewAll(document, webviewPanel, this.context);
          break;

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

      // Notify webview after the save completes
      setTimeout(() => {
        pendingChanges.clear();
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
        sendInit();
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
  changes: Map<string, { target: string; state: TranslationState }>
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
}

// ─── Translate All ────────────────────────────────────────────────────────────

async function handleTranslateAll(
  document: vscode.TextDocument,
  webviewPanel: vscode.WebviewPanel,
  pendingChanges: Map<string, { target: string; state: TranslationState }>,
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
  const untranslated = filterUnits(parsed.units, { untranslatedOnly: true });

  if (untranslated.length === 0) {
    webviewPanel.webview.postMessage({ type: 'error', message: 'No untranslated units found.' });
    return;
  }

  webviewPanel.webview.postMessage({ type: 'translating', ids: untranslated.map((u) => u.id) });

  try {
    const batchSize = config.batchSize;
    for (let i = 0; i < untranslated.length; i += batchSize) {
      const batch = untranslated.slice(i, i + batchSize);
      const response = await provider.translate({
        units: batch.map((u) => ({ id: u.id, source: u.source })),
        sourceLanguage: srcLang,
        targetLanguage: tgtLang,
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

  try {
    const response = await provider.translate({
      units: [{ id: unitId, source }],
      sourceLanguage: srcLang,
      targetLanguage: tgtLang,
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
