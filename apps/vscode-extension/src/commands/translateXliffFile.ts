import * as vscode from 'vscode';
import { parseXliff, serializeXliff, filterUnits, getXliffStats } from '@nexus/xliff';
import type { TranslationState } from '@nexus/xliff';
import { createAIProvider, getConfig } from '../provider';

export function registerTranslateXliffFile(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('nexus.translateXliffFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !editor.document.fileName.toLowerCase().endsWith('.xlf')) {
        vscode.window.showErrorMessage('Nexus Translator: Please open an XLIFF (.xlf) file first.');
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
      const originalContent = editor.document.getText();

      let parsed;
      try {
        parsed = parseXliff(originalContent);
      } catch (err: unknown) {
        vscode.window.showErrorMessage(`Nexus Translator: Failed to parse XLIFF — ${(err as Error).message}`);
        return;
      }

      const srcLang = parsed.sourceLanguage || config.sourceLanguage;
      const tgtLang = parsed.targetLanguage || config.targetLanguage;

      const untranslated = filterUnits(parsed.units, { untranslatedOnly: true });

      if (untranslated.length === 0) {
        const stats = getXliffStats(parsed.units);
        vscode.window.showInformationMessage(
          `Nexus Translator: No untranslated units found. (${stats.translated}/${stats.total} translated)`
        );
        return;
      }

      const confirm = await vscode.window.showInformationMessage(
        `Translate ${untranslated.length} untranslated unit(s) from ${srcLang} to ${tgtLang}?`,
        { modal: true },
        'Translate'
      );
      if (confirm !== 'Translate') return;

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Nexus Translator',
          cancellable: false,
        },
        async (progress) => {
          const batchSize = config.batchSize;
          const batches = chunk(untranslated, batchSize);
          const updates = new Map<string, { target: string; state: TranslationState }>();
          let processedCount = 0;

          try {
            for (const batch of batches) {
              progress.report({
                message: `Translating ${processedCount + 1}–${Math.min(processedCount + batch.length, untranslated.length)} of ${untranslated.length}…`,
                increment: (batch.length / untranslated.length) * 100,
              });

              const response = await provider.translate({
                units: batch.map((u) => ({ id: u.id, source: u.source })),
                sourceLanguage: srcLang,
                targetLanguage: tgtLang,
              });

              for (const result of response.results) {
                updates.set(result.id, {
                  target: result.translatedText,
                  state: 'translated',
                });
              }

              processedCount += batch.length;
            }

            const newContent = serializeXliff(originalContent, updates);

            await editor.edit((editBuilder) => {
              const fullRange = new vscode.Range(
                editor.document.positionAt(0),
                editor.document.positionAt(originalContent.length)
              );
              editBuilder.replace(fullRange, newContent);
            });

            const stats = getXliffStats(parsed.units);
            vscode.window.showInformationMessage(
              `Nexus Translator: ✓ Translated ${updates.size} unit(s). Progress: ${stats.translated + updates.size}/${stats.total}`
            );
          } catch (err: unknown) {
            vscode.window.showErrorMessage(`Nexus Translator: Translation failed — ${(err as Error).message}`);
          }
        }
      );
    })
  );
}

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}
