import * as vscode from 'vscode';

export interface TranslationStats {
  total: number;
  translated: number;
  targetLanguage: string;
}

let item: vscode.StatusBarItem | undefined;
let currentUri: vscode.Uri | undefined;

function ensureItem(): vscode.StatusBarItem {
  if (!item) {
    item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    item.name = 'Nexus Translator';
  }
  return item;
}

/** Register the status bar item and keep it relevant to the focused editor. */
export function registerStatusBar(context: vscode.ExtensionContext): void {
  context.subscriptions.push(ensureItem());
  // Hide the indicator when a different (non-Nexus) text editor gains focus.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (ed && ed.document.uri.toString() !== currentUri?.toString()) hideStatus();
    })
  );
}

/** Show/refresh the progress indicator for a given translation document. */
export function updateStatus(uri: vscode.Uri, stats: TranslationStats): void {
  const it = ensureItem();
  currentUri = uri;
  const pct = stats.total > 0 ? Math.round((stats.translated / stats.total) * 100) : 0;
  it.text = `$(globe) ${pct}% ${stats.targetLanguage}`;
  it.tooltip =
    `Nexus Translator — ${stats.translated}/${stats.total} units translated (${stats.targetLanguage})\n` +
    'Click to open this file in Nexus Translator';
  it.command = {
    title: 'Open in Nexus Translator',
    command: 'nexus.openInNexusEditor',
    arguments: [uri],
  };
  it.show();
}

/** Hide the indicator (no Nexus document focused). */
export function hideStatus(): void {
  item?.hide();
  currentUri = undefined;
}
