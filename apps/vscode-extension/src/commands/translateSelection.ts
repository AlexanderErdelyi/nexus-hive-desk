import * as vscode from 'vscode';
import { createAIProvider, getConfig } from '../provider';

export function registerTranslateSelection(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('nexus.translateSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('Nexus Translator: No active editor.');
        return;
      }

      const selection = editor.selection;
      const text = editor.document.getText(selection);
      if (!text.trim()) {
        vscode.window.showWarningMessage('Nexus Translator: No text selected.');
        return;
      }

      let provider;
      try {
        provider = await createAIProvider(context);
      } catch (err: unknown) {
        vscode.window.showErrorMessage((err as Error).message);
        return;
      }

      const config = getConfig();

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Nexus Translator',
          cancellable: false,
        },
        async (progress) => {
          progress.report({
            message: `Translating to ${config.targetLanguage}…`,
          });

          try {
            const response = await provider.translate({
              units: [{ id: '1', source: text }],
              sourceLanguage: config.sourceLanguage,
              targetLanguage: config.targetLanguage,
            });

            const result = response.results[0];
            if (!result) {
              vscode.window.showErrorMessage('Nexus Translator: Translation returned no result.');
              return;
            }

            const confidenceLabel =
              result.confidenceScore !== undefined
                ? ` (confidence: ${result.confidenceScore}%)`
                : '';

            const action = await vscode.window.showInformationMessage(
              `Translation${confidenceLabel}: "${result.translatedText}"`,
              'Replace Selection',
              'Copy to Clipboard'
            );

            if (action === 'Replace Selection') {
              await editor.edit((editBuilder) => {
                editBuilder.replace(selection, result.translatedText);
              });
            } else if (action === 'Copy to Clipboard') {
              await vscode.env.clipboard.writeText(result.translatedText);
              vscode.window.showInformationMessage('Nexus Translator: Translation copied to clipboard.');
            }
          } catch (err: unknown) {
            vscode.window.showErrorMessage(`Nexus Translator: ${(err as Error).message}`);
          }
        }
      );
    })
  );
}
