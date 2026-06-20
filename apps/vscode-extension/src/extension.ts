import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
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

/**
 * Copy the bundled chatmode file to the VS Code user chatmodes directory so
 * the "Nexus Translator" agent appears in the chat mode dropdown in every
 * workspace — without any manual setup by the user.
 */
async function installChatMode(context: vscode.ExtensionContext): Promise<void> {
  try {
    const src = vscode.Uri.joinPath(context.extensionUri, 'chatmodes', 'nexus-translator.chatmode.md');

    // Resolve platform-specific VS Code user data dir
    const userDataDir = (() => {
      switch (process.platform) {
        case 'win32':  return path.join(process.env['APPDATA'] ?? os.homedir(), 'Code', 'User');
        case 'darwin': return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User');
        default:       return path.join(os.homedir(), '.config', 'Code', 'User');
      }
    })();

    const chatmodesDir = vscode.Uri.file(path.join(userDataDir, 'chatmodes'));
    const dest = vscode.Uri.file(path.join(userDataDir, 'chatmodes', 'nexus-translator.chatmode.md'));

    await vscode.workspace.fs.createDirectory(chatmodesDir);
    const content = await vscode.workspace.fs.readFile(src);
    await vscode.workspace.fs.writeFile(dest, content);
  } catch {
    // Non-critical — silently skip if the directory isn't writable
  }
}

export function activate(context: vscode.ExtensionContext): void {
  // Install the bundled chatmode file so "Nexus Translator" appears in the
  // Copilot Chat mode dropdown in every workspace on this machine.
  installChatMode(context);
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
