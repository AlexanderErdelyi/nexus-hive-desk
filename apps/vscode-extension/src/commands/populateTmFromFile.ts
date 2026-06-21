import * as path from 'path';
import * as vscode from 'vscode';
import { parseXliff } from '@nexus/xliff';
import { getConfig } from '../provider';
import { getTmManager } from '../tmManager';

const CONFIRMED_STATES = new Set(['translated', 'final', 'signed-off']);

/** Resolve the target .xlf URI from the command arg (explorer/editor-title) or active editor. */
function resolveXliffUri(arg?: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri && arg.fsPath.toLowerCase().endsWith('.xlf')) {
    return arg;
  }
  const active = vscode.window.activeTextEditor;
  if (active && active.document.fileName.toLowerCase().endsWith('.xlf')) {
    return active.document.uri;
  }
  return undefined;
}

export function registerPopulateTmFromFile(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('nexus.populateTmFromFile', async (arg?: unknown) => {
      const uri = resolveXliffUri(arg);
      if (!uri) {
        vscode.window.showErrorMessage('Nexus Translator: Please open or right-click an XLIFF (.xlf) file first.');
        return;
      }

      let content: string;
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        content = new TextDecoder().decode(bytes);
      } catch (err: unknown) {
        vscode.window.showErrorMessage(`Nexus Translator: Failed to read file — ${(err as Error).message}`);
        return;
      }

      let parsed;
      try {
        parsed = parseXliff(content);
      } catch (err: unknown) {
        vscode.window.showErrorMessage(`Nexus Translator: Failed to parse XLIFF — ${(err as Error).message}`);
        return;
      }

      const config = getConfig();
      const srcLang = parsed.sourceLanguage || config.sourceLanguage;
      const tgtLang = parsed.targetLanguage || config.targetLanguage;

      const confirmed = parsed.units.filter(
        (u) => u.target && u.target.trim() && CONFIRMED_STATES.has(u.state || '')
      );

      if (confirmed.length === 0) {
        vscode.window.showInformationMessage('Nexus Translator: No translated units to add to Translation Memory.');
        return;
      }

      await getTmManager(context).upsertBatch(
        confirmed.map((u) => ({ source: u.source, target: u.target })),
        srcLang,
        tgtLang
      );

      vscode.window.showInformationMessage(
        `Added ${confirmed.length} units to Translation Memory from ${path.basename(uri.fsPath)}`
      );
    })
  );
}
