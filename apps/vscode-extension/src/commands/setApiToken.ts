import * as vscode from 'vscode';
import { storeToken } from '../provider';

export function registerSetApiToken(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('nexus.setApiToken', async () => {
      const token = await vscode.window.showInputBox({
        title: 'Nexus Translator — Set API Token',
        prompt: 'Enter your AI provider API token/key. It will be stored in VS Code secret storage.',
        password: true,
        placeHolder: 'sk-… or ghp_…',
        validateInput: (value) => (value.trim() ? null : 'Token cannot be empty'),
      });

      if (!token) return;

      await storeToken(context, token);
      vscode.window.showInformationMessage('Nexus Translator: API token saved securely.');
    })
  );
}
