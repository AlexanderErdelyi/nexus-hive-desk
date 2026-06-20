import * as vscode from 'vscode';
import { TranslationEditorProvider } from './translationEditor';
import { registerTranslateSelection } from './commands/translateSelection';
import { registerTranslateXliffFile } from './commands/translateXliffFile';
import { registerReviewXliffFile } from './commands/reviewXliffFile';
import { registerSetApiToken } from './commands/setApiToken';

export function activate(context: vscode.ExtensionContext): void {
  // Custom editor: opens .xlf files with the full translation UI panel
  context.subscriptions.push(TranslationEditorProvider.register(context));

  // Command-palette / context-menu commands (work on any file)
  registerTranslateSelection(context);
  registerTranslateXliffFile(context);
  registerReviewXliffFile(context);
  registerSetApiToken(context);
}

export function deactivate(): void {}
