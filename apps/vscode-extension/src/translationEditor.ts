import * as path from 'path';
import * as vscode from 'vscode';
import { parseXliff, serializeXliff, filterUnits } from '@nexus/xliff';
import type { TranslationState } from '@nexus/xliff';
import type { AIProvider, AITranslateResult } from '@nexus/ai';
import { createAIProvider, getConfig } from './provider';
import { getWebviewContent } from './webviewContent';

// ─── Provider registration ────────────────────────────────────────────────────

export class TranslationEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'nexus.translationEditor';

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

    // Track pending in-memory changes for this editor instance.
    // Written to the document only on explicit Save (button or Ctrl+S).
    const pendingChanges = new Map<string, { target: string; state: TranslationState }>();

    const sendInit = () => {
      try {
        const parsed = parseXliff(document.getText());
        webviewPanel.webview.postMessage({
          type: 'init',
          units: parsed.units,
          sourceLanguage: parsed.sourceLanguage,
          targetLanguage: parsed.targetLanguage,
          fileName: path.basename(document.fileName),
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
