import * as vscode from 'vscode';
import { registerTranslateSelection } from './commands/translateSelection';
import { registerTranslateXliffFile } from './commands/translateXliffFile';
import { registerReviewXliffFile } from './commands/reviewXliffFile';
import { registerSetApiToken } from './commands/setApiToken';

export function activate(context: vscode.ExtensionContext): void {
  registerTranslateSelection(context);
  registerTranslateXliffFile(context);
  registerReviewXliffFile(context);
  registerSetApiToken(context);
}

export function deactivate(): void {}
