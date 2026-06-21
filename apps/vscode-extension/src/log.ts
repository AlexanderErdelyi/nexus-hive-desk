import * as vscode from 'vscode';

/**
 * Shared diagnostics output channel for the extension. All commands and
 * background operations should log here so users (and we) can diagnose
 * failures from one place: View → Output → "Nexus Translator".
 */
let channel: vscode.OutputChannel | undefined;

export function getOutputChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Nexus Translator');
  }
  return channel;
}

function ts(): string {
  return new Date().toISOString();
}

/** Log an informational line. */
export function logInfo(message: string): void {
  getOutputChannel().appendLine(`[${ts()}] ${message}`);
}

/** Log an error (optionally with the originating error's stack) to the channel. */
export function logError(message: string, err?: unknown): void {
  const ch = getOutputChannel();
  ch.appendLine(`[${ts()}] ERROR: ${message}`);
  if (err instanceof Error) {
    ch.appendLine(`  ${err.message}`);
    if (err.stack) ch.appendLine(err.stack);
  } else if (err !== undefined) {
    ch.appendLine(`  ${String(err)}`);
  }
}

/**
 * Show an error to the user AND record full detail in the output channel.
 * Returns nothing — the toast offers a "Show Details" action that reveals the log.
 */
export function reportError(userMessage: string, err?: unknown): void {
  logError(userMessage, err);
  void vscode.window.showErrorMessage(`Nexus Translator: ${userMessage}`, 'Show Details').then((pick) => {
    if (pick === 'Show Details') getOutputChannel().show(true);
  });
}
