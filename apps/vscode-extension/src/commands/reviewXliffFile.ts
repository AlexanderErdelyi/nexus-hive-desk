import * as vscode from 'vscode';
import { parseXliff, getXliffStats } from '@nexus/xliff';
import type { AIReviewUnit } from '@nexus/ai';
import { createAIProvider, getConfig } from '../provider';

export function registerReviewXliffFile(context: vscode.ExtensionContext): void {
  // Persistent output channel reused across invocations
  const outputChannel = vscode.window.createOutputChannel('Nexus Translator — Review');
  context.subscriptions.push(outputChannel);

  context.subscriptions.push(
    vscode.commands.registerCommand('nexus.reviewXliffFile', async () => {
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
      const content = editor.document.getText();

      let parsed;
      try {
        parsed = parseXliff(content);
      } catch (err: unknown) {
        vscode.window.showErrorMessage(`Nexus Translator: Failed to parse XLIFF — ${(err as Error).message}`);
        return;
      }

      const srcLang = parsed.sourceLanguage || config.sourceLanguage;
      const tgtLang = parsed.targetLanguage || config.targetLanguage;

      // Only review units that have a translation
      const reviewable = parsed.units.filter(
        (u) =>
          u.target.trim() &&
          (u.state === 'translated' || u.state === 'needs-review-translation' || u.state === 'final')
      );

      if (reviewable.length === 0) {
        vscode.window.showInformationMessage('Nexus Translator: No translated units found to review.');
        return;
      }

      const stats = getXliffStats(parsed.units);
      const confirm = await vscode.window.showInformationMessage(
        `Review ${reviewable.length} translated unit(s) in "${editor.document.fileName.split(/[\\/]/).pop()}"?`,
        { modal: true },
        'Review'
      );
      if (confirm !== 'Review') return;

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Nexus Translator — Review',
          cancellable: false,
        },
        async (progress) => {
          const batchSize = config.batchSize;
          const batches = chunk(reviewable, batchSize);

          const allResults: Array<{
            id: string;
            source: string;
            target: string;
            quality: string;
            reason?: string;
            suggestion?: string;
          }> = [];

          let processedCount = 0;

          try {
            for (const batch of batches) {
              progress.report({
                message: `Reviewing ${processedCount + 1}–${Math.min(processedCount + batch.length, reviewable.length)} of ${reviewable.length}…`,
                increment: (batch.length / reviewable.length) * 100,
              });

              const reviewUnits: AIReviewUnit[] = batch.map((u) => ({
                id: u.id,
                source: u.source,
                target: u.target,
                ...(u.developerNote ? { context: u.developerNote } : {}),
              }));

              const response = await provider.review({
                units: reviewUnits,
                sourceLanguage: srcLang,
                targetLanguage: tgtLang,
              });

              for (const result of response.results) {
                const unit = batch.find((u) => u.id === result.id);
                allResults.push({
                  id: result.id,
                  source: unit?.source ?? '',
                  target: unit?.target ?? '',
                  quality: result.quality,
                  reason: result.reason,
                  suggestion: result.suggestion,
                });
              }

              processedCount += batch.length;
            }

            writeReviewResults(
              outputChannel,
              allResults,
              srcLang,
              tgtLang,
              editor.document.fileName,
              stats
            );
            outputChannel.show(true);

            const errors = allResults.filter((r) => r.quality === 'error').length;
            const warnings = allResults.filter((r) => r.quality === 'warning').length;
            const good = allResults.filter((r) => r.quality === 'good').length;

            vscode.window.showInformationMessage(
              `Nexus Translator: Review complete — ${good} good, ${warnings} warnings, ${errors} errors. See Output panel.`
            );
          } catch (err: unknown) {
            vscode.window.showErrorMessage(`Nexus Translator: Review failed — ${(err as Error).message}`);
          }
        }
      );
    })
  );
}

function writeReviewResults(
  channel: vscode.OutputChannel,
  results: Array<{
    id: string;
    source: string;
    target: string;
    quality: string;
    reason?: string;
    suggestion?: string;
  }>,
  srcLang: string,
  tgtLang: string,
  filePath: string,
  stats: ReturnType<typeof getXliffStats>
): void {
  const now = new Date().toLocaleString();
  const fileName = filePath.split(/[\\/]/).pop() ?? filePath;

  channel.clear();
  channel.appendLine(`${'='.repeat(72)}`);
  channel.appendLine(`Nexus Translator — AI Review Report`);
  channel.appendLine(`File:      ${fileName}`);
  channel.appendLine(`Languages: ${srcLang} → ${tgtLang}`);
  channel.appendLine(`Reviewed:  ${results.length} units  |  File progress: ${stats.translated}/${stats.total} (${stats.progress}%)`);
  channel.appendLine(`Date:      ${now}`);
  channel.appendLine(`${'='.repeat(72)}`);

  const errors = results.filter((r) => r.quality === 'error');
  const warnings = results.filter((r) => r.quality === 'warning');
  const good = results.filter((r) => r.quality === 'good');

  channel.appendLine(`\nSummary: ${good.length} good  |  ${warnings.length} warnings  |  ${errors.length} errors\n`);

  if (errors.length > 0) {
    channel.appendLine(`${'─'.repeat(72)}`);
    channel.appendLine(`ERRORS (${errors.length})`);
    channel.appendLine(`${'─'.repeat(72)}`);
    for (const r of errors) {
      appendResult(channel, r);
    }
  }

  if (warnings.length > 0) {
    channel.appendLine(`${'─'.repeat(72)}`);
    channel.appendLine(`WARNINGS (${warnings.length})`);
    channel.appendLine(`${'─'.repeat(72)}`);
    for (const r of warnings) {
      appendResult(channel, r);
    }
  }

  if (good.length > 0) {
    channel.appendLine(`${'─'.repeat(72)}`);
    channel.appendLine(`GOOD (${good.length})`);
    channel.appendLine(`${'─'.repeat(72)}`);
    for (const r of good) {
      channel.appendLine(`  ✓ [${r.id}] "${r.source}" → "${r.target}"`);
    }
  }

  channel.appendLine('');
}

function appendResult(
  channel: vscode.OutputChannel,
  r: { id: string; source: string; target: string; quality: string; reason?: string; suggestion?: string }
): void {
  const icon = r.quality === 'error' ? '✖' : '⚠';
  channel.appendLine(`  ${icon} ID:         ${r.id}`);
  channel.appendLine(`     Source:     ${r.source}`);
  channel.appendLine(`     Target:     ${r.target}`);
  if (r.reason) channel.appendLine(`     Reason:     ${r.reason}`);
  if (r.suggestion) channel.appendLine(`     Suggestion: ${r.suggestion}`);
  channel.appendLine('');
}

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}
