import * as vscode from 'vscode';
import { TranslationEditorProvider } from './translationEditor';
import { registerTranslateSelection } from './commands/translateSelection';
import { registerTranslateXliffFile } from './commands/translateXliffFile';
import { registerReviewXliffFile } from './commands/reviewXliffFile';
import { registerSetApiToken } from './commands/setApiToken';
import { registerOpenInNexus } from './commands/openInNexus';
import { registerFindInNexusTranslator } from './commands/findInNexus';
import { registerShowTranslationDiff } from './commands/showDiff';
import { registerManageGlossary } from './commands/manageGlossary';
import { registerPopulateTmFromFile } from './commands/populateTmFromFile';
import { getTmManager } from './tmManager';
import { getGlossaryManager } from './glossaryManager';

export function activate(context: vscode.ExtensionContext): void {
  // Initialise the TM & Glossary managers with the workspace root so they read/write
  // the shared workspace-relative `.nexus/` folder (also used by the MCP server).
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  getTmManager(context, workspaceRoot);
  getGlossaryManager(context, workspaceRoot);

  // Custom editor: opens .xlf files with the full translation UI panel
  context.subscriptions.push(TranslationEditorProvider.register(context));

  // Command-palette / context-menu commands (work on any file)
  registerTranslateSelection(context);
  registerTranslateXliffFile(context);
  registerReviewXliffFile(context);
  registerSetApiToken(context);

  // Open / find commands
  registerOpenInNexus(context);
  registerFindInNexusTranslator(context);
  registerShowTranslationDiff(context);

  // Glossary & Translation Memory management panel
  registerManageGlossary(context);

  // Populate TM from an XLIFF file
  registerPopulateTmFromFile(context);
}

export function deactivate(): void {}
