import * as vscode from 'vscode';
import * as path from 'path';
import { pendingFilters, pendingSearches } from '../state';
import { TranslationEditorProvider } from '../translationEditor';
import { getNavigationViewColumn } from '../navigation';

/** Maps lowercase AL keyword → BC XLIFF object type string (matches Xliff Generator note prefix) */
const AL_TYPE_MAP: Record<string, string> = {
  table: 'Table', tableextension: 'TableExtension',
  page: 'Page', pageextension: 'PageExtension', pagecustomization: 'PageCustomization',
  codeunit: 'Codeunit', report: 'Report', reportextension: 'ReportExtension',
  xmlport: 'XMLPort', query: 'Query',
  enum: 'Enum', enumextension: 'EnumExtension',
  profile: 'Profile', interface: 'Interface', permissionset: 'PermissionSet',
};

/**
 * Regex matching the first object declaration in an AL file.
 * Group 1 = keyword, 2 = object name.
 * Handles both plain and quoted names, and the `extends "..."` clause used by extension types.
 */
const AL_OBJECT_RE = /^(tableextension|table|pagecustomization|pageextension|page|codeunit|reportextension|report|xmlport|query|enumextension|enum|profile|interface|permissionset)\s+\d+\s+["']?([^"'{\n]+?)["']?(?:\s+extends\s+["']?[^"'{\n]*["']?)?\s*[{(]/im;

/**
 * Extracts the translatable text value from an AL property/label line.
 * Priority: Label 'text' → property = 'text' (skipping Comment = '...')
 */
function extractLineValue(lineText: string): string | null {
  // AL Label variable: `MyLabel: Label 'text'[, Comment = '...']`
  const labelMatch = /\bLabel\s+['"]([^'"]+)['"]/i.exec(lineText);
  if (labelMatch) return labelMatch[1].trim();

  // Property assignment (Caption, ToolTip, etc.) but NOT Comment metadata:
  // look for `Word = 'value'` where Word is not "Comment"
  const propMatch = /\b(?!Comment\b)([A-Za-z_]\w*)\s*=\s*['"]([^'"]+)['"]/i.exec(lineText);
  if (propMatch) return propMatch[2].trim();

  return null;
}

/** Parse an AL file's text and return its "{ObjectType} {ObjectName}" filter token, or null. */
function parseAlFilter(text: string): string | null {
  const m = AL_OBJECT_RE.exec(text);
  if (!m) return null;
  const bcType = AL_TYPE_MAP[m[1].toLowerCase()];
  if (!bcType) return null;
  const name = m[2].trim().replace(/^["']|["']$/g, '');
  return `${bcType} ${name}`;
}

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

        // If triggered from an AL file editor, grab the caption/value at the cursor line
        let initialSearch: string | undefined;
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.uri.fsPath.toLowerCase().endsWith('.al')) {
          const lineText = editor.document.lineAt(editor.selection.active.line).text;
          const extracted = extractLineValue(lineText);
          if (extracted) initialSearch = extracted;
        }

        // Determine the search filter string from the selected resource
        const filterStr = await resolveFilter(target);
        if (filterStr === null) return; // user cancelled or no objects found

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

        // If the panel is already open, send the filter directly and focus it
        if (filterStr && TranslationEditorProvider.applyFilter(xliffUri, filterStr, initialSearch)) {
          return;
        }

        // Otherwise store filter so the editor applies it when it opens.
        // Key by fsPath (lowercased) so producer/consumer agree regardless of
        // URI-string encoding differences (drive-letter casing / percent-encoding).
        const pendingKey = xliffUri.fsPath.toLowerCase();
        if (filterStr) {
          pendingFilters.set(pendingKey, filterStr);
        }
        if (initialSearch) {
          pendingSearches.set(pendingKey, initialSearch);
        }

        await vscode.commands.executeCommand(
          'vscode.openWith',
          xliffUri,
          'nexus.translationEditor',
          getNavigationViewColumn()
        );
      }
    )
  );
}

/** Recursively collect all .al file URIs under a directory. */
async function findAlFilesInDir(dirUri: vscode.Uri): Promise<vscode.Uri[]> {
  const result: vscode.Uri[] = [];
  let entries: [string, vscode.FileType][];
  try { entries = await vscode.workspace.fs.readDirectory(dirUri); }
  catch { return result; }
  for (const [name, type] of entries) {
    const child = vscode.Uri.joinPath(dirUri, name);
    if (type === vscode.FileType.Directory) {
      result.push(...await findAlFilesInDir(child));
    } else if (type === vscode.FileType.File && name.toLowerCase().endsWith('.al')) {
      result.push(child);
    }
  }
  return result;
}

/** Returns a comma-separated "{ObjectType} {ObjectName}" filter string for the given resource. */
async function resolveFilter(uri: vscode.Uri): Promise<string | null> {
  let stat: vscode.FileStat;
  try {
    stat = await vscode.workspace.fs.stat(uri);
  } catch {
    return null;
  }

  if (stat.type === vscode.FileType.Directory) {
    const alFiles = await findAlFilesInDir(uri);
    const seen = new Set<string>();
    const filters: string[] = [];
    for (const fileUri of alFiles) {
      try {
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        const text = new TextDecoder().decode(bytes);
        const f = parseAlFilter(text);
        if (f && !seen.has(f)) { seen.add(f); filters.push(f); }
      } catch { /* skip */ }
    }
    if (filters.length === 0) {
      vscode.window.showWarningMessage('No BC AL objects found in folder.');
      return null;
    }
    return filters.join(',');
  }

  // For .al files: parse and return "ObjectType ObjectName"
  if (uri.fsPath.toLowerCase().endsWith('.al')) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder().decode(bytes);
      const f = parseAlFilter(text);
      if (f) return f;
    } catch { /* ignore */ }
    return null;
  }

  return null;
}
