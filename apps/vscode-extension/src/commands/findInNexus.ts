import * as vscode from 'vscode';
import * as path from 'path';
import { pendingFilters } from '../state';

export function registerFindInNexusTranslator(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'nexus.findInNexusTranslator',
      async (uri?: vscode.Uri) => {
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!target) {
          vscode.window.showErrorMessage('No file or folder selected.');
          return;
        }

        // Determine the search filter string from the selected resource
        const filterStr = await resolveFilter(target);
        if (filterStr === null) return; // user cancelled

        // Find all .xlf files in the workspace
        const xliffs = await vscode.workspace.findFiles('**/*.xlf', '**/node_modules/**');
        if (xliffs.length === 0) {
          vscode.window.showWarningMessage('No .xlf files found in this workspace.');
          return;
        }

        let xliffUri: vscode.Uri;
        if (xliffs.length === 1) {
          xliffUri = xliffs[0];
        } else {
          const picks = xliffs.map((u) => ({
            label: path.basename(u.fsPath),
            description: vscode.workspace.asRelativePath(u),
            uri: u,
          }));
          const chosen = await vscode.window.showQuickPick(picks, {
            placeHolder: 'Select the XLIFF file to open',
          });
          if (!chosen) return;
          xliffUri = chosen.uri;
        }

        // Store filter so the editor can apply it when it opens
        if (filterStr) {
          pendingFilters.set(xliffUri.toString(), filterStr);
        }

        await vscode.commands.executeCommand(
          'vscode.openWith',
          xliffUri,
          'nexus.translationEditor'
        );
      }
    )
  );
}

async function resolveFilter(uri: vscode.Uri): Promise<string | null> {
  let stat: vscode.FileStat;
  try {
    stat = await vscode.workspace.fs.stat(uri);
  } catch {
    return path.basename(uri.fsPath, path.extname(uri.fsPath));
  }

  if (stat.type === vscode.FileType.Directory) {
    return path.basename(uri.fsPath);
  }

  // For .al files: try to extract the BC object type + number from the file content
  // e.g. "page 50100 CustomerList" → filter by "page 50100"
  if (uri.fsPath.toLowerCase().endsWith('.al')) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder().decode(bytes);
      const m = text.match(
        /^\s*(page|table|codeunit|report|query|xmlport|enum|interface|permissionset)\s+(\d+)/im
      );
      if (m) return `${m[1].toLowerCase()} ${m[2]}`;
    } catch { /* ignore */ }
    return path.basename(uri.fsPath, '.al');
  }

  // Fallback: filename stem
  return path.basename(uri.fsPath, path.extname(uri.fsPath));
}
