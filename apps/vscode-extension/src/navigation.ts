import * as vscode from 'vscode';

/**
 * Resolve the editor column to use when navigating between the Nexus
 * Translator editor and AL source (and vice-versa), based on the user setting
 * `nexus.translator.openNavigationIn`:
 *   - "active" (default): open in the currently active editor group (same window)
 *   - "beside": open in a split editor group next to the current one
 */
export function getNavigationViewColumn(): vscode.ViewColumn {
  const mode = vscode.workspace
    .getConfiguration('nexus.translator')
    .get<string>('openNavigationIn', 'active');
  return mode === 'beside' ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
}
