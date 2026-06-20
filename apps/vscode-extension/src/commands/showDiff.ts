import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { parseXliff } from '@nexus/xliff';
import type { XliffUnit } from '@nexus/types';

// ─── Types ────────────────────────────────────────────────────────────────────

interface UnitDiff {
  type: 'added' | 'removed' | 'modified';
  unit: XliffUnit;
  oldUnit?: XliffUnit;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

function getBaselineContent(fsPath: string): string | null {
  const wsFolders = vscode.workspace.workspaceFolders;
  if (!wsFolders || wsFolders.length === 0) return null;

  // Try each workspace folder to find the right git root
  for (const wsFolder of wsFolders) {
    const relPath = path.relative(wsFolder.uri.fsPath, fsPath).replace(/\\/g, '/');
    if (relPath.startsWith('..')) continue; // not inside this workspace folder
    try {
      const result = cp.execFileSync('git', ['show', `HEAD:${relPath}`], {
        cwd: wsFolder.uri.fsPath,
        maxBuffer: 50 * 1024 * 1024,
      });
      return result.toString('utf-8');
    } catch {
      // HEAD doesn't have this file yet (new file) — return null
      return null;
    }
  }
  return null;
}

function computeDiff(oldUnits: XliffUnit[], newUnits: XliffUnit[]): UnitDiff[] {
  const oldMap = new Map(oldUnits.map((u) => [u.id, u]));
  const newMap = new Map(newUnits.map((u) => [u.id, u]));
  const diffs: UnitDiff[] = [];

  for (const [id, newUnit] of newMap) {
    const oldUnit = oldMap.get(id);
    if (!oldUnit) {
      diffs.push({ type: 'added', unit: newUnit });
    } else if (oldUnit.target !== newUnit.target || oldUnit.state !== newUnit.state) {
      diffs.push({ type: 'modified', unit: newUnit, oldUnit });
    }
  }
  for (const [id, oldUnit] of oldMap) {
    if (!newMap.has(id)) {
      diffs.push({ type: 'removed', unit: oldUnit });
    }
  }
  return diffs;
}

// ─── Webview HTML ─────────────────────────────────────────────────────────────

function getDiffHtml(
  cspSource: string,
  nonce: string,
  fileName: string,
  diffs: UnitDiff[]
): string {
  const added = diffs.filter((d) => d.type === 'added').length;
  const removed = diffs.filter((d) => d.type === 'removed').length;
  const modified = diffs.filter((d) => d.type === 'modified').length;

  function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function parseContext(note?: string): { badge: string; name: string; prop: string } {
    if (!note) return { badge: 'OTHER', name: '-', prop: '-' };
    const parts = note.split(' - ');
    const objPart = parts[0] || '';
    const space = objPart.indexOf(' ');
    const badge = space > 0 ? objPart.slice(0, space).toUpperCase() : 'OTHER';
    const name = space > 0 ? objPart.slice(space + 1) : objPart;
    const prop = parts.slice(1).join(' - ');
    return { badge, name, prop };
  }

  const rows = diffs.map((d) => {
    const ctx = parseContext(d.unit.note);
    const typeColor = d.type === 'added' ? '#4ec9b0' : d.type === 'removed' ? '#f48771' : '#dcdcaa';
    const typeBg = d.type === 'added' ? 'rgba(78,201,176,0.08)' : d.type === 'removed' ? 'rgba(244,135,113,0.08)' : 'rgba(220,220,170,0.08)';
    const typeLabel = d.type.toUpperCase();

    const oldTarget = d.oldUnit ? esc(d.oldUnit.target || '(empty)') : '';
    const newTarget = d.type === 'removed' ? '' : esc(d.unit.target || '(empty)');

    const targetCell = d.type === 'modified'
      ? `<span class="old-val">${oldTarget}</span><span class="arrow">→</span><span class="new-val">${newTarget}</span>`
      : d.type === 'added' ? `<span class="new-val">${newTarget}</span>`
      : `<span class="old-val">${esc(d.unit.target || '(empty)')}</span>`;

    return `<tr style="background:${typeBg}">
      <td><span class="badge" style="color:${typeColor};border-color:${typeColor}">${typeLabel}</span></td>
      <td><div class="ctx-name">${esc(ctx.name)}</div><div class="ctx-prop">${esc(ctx.prop)}</div></td>
      <td>${esc(d.unit.source)}</td>
      <td class="target-cell">${targetCell}</td>
    </tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline';">
  <title>Translation Diff</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, -apple-system, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 16px;
    }
    h2 { font-size: 15px; font-weight: 600; margin-bottom: 12px; }
    .summary {
      display: flex; gap: 16px; margin-bottom: 16px;
      padding: 10px 14px;
      background: var(--vscode-sideBar-background, rgba(128,128,128,0.05));
      border-radius: 4px; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
    }
    .sum-item { display: flex; align-items: center; gap: 6px; font-size: 13px; }
    .sum-dot { width: 10px; height: 10px; border-radius: 50%; }
    .empty-state { padding: 40px; text-align: center; color: var(--vscode-descriptionForeground); }
    table {
      width: 100%; border-collapse: collapse; font-size: 12px;
    }
    thead th {
      padding: 5px 10px; text-align: left;
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.06em; color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
    }
    tbody tr { border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.08)); }
    tbody td { padding: 8px 10px; vertical-align: top; }
    .badge {
      display: inline-block; font-size: 9px; font-weight: 700;
      padding: 1px 5px; border-radius: 3px; border: 1px solid;
      letter-spacing: 0.06em;
    }
    .ctx-name { font-size: 12px; font-weight: 500; }
    .ctx-prop { font-size: 10px; color: var(--vscode-descriptionForeground); font-style: italic; margin-top: 2px; }
    .target-cell { display: flex; flex-direction: column; gap: 4px; }
    .old-val { color: #f48771; text-decoration: line-through; }
    .new-val { color: #4ec9b0; }
    .arrow { color: var(--vscode-descriptionForeground); font-size: 10px; }
    col.c-status { width: 80px; }
    col.c-ctx    { width: 200px; }
    col.c-src    { width: 35%; }
    col.c-tgt    { width: auto; }
  </style>
</head>
<body>
  <h2>Translation Changes — ${esc(fileName)}</h2>
  ${diffs.length === 0
    ? '<div class="empty-state">✓ No translation changes compared to HEAD</div>'
    : `<div class="summary">
        <div class="sum-item"><div class="sum-dot" style="background:#dcdcaa"></div>${modified} modified</div>
        <div class="sum-item"><div class="sum-dot" style="background:#4ec9b0"></div>${added} added</div>
        <div class="sum-item"><div class="sum-dot" style="background:#f48771"></div>${removed} removed</div>
      </div>
      <table>
        <colgroup><col class="c-status"><col class="c-ctx"><col class="c-src"><col class="c-tgt"></colgroup>
        <thead><tr><th>Status</th><th>Context</th><th>Source</th><th>Target</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
  }
</body>
</html>`;
}

// ─── Command ──────────────────────────────────────────────────────────────────

export function registerShowTranslationDiff(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('nexus.showTranslationDiff', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target || !target.fsPath.toLowerCase().endsWith('.xlf')) {
        vscode.window.showErrorMessage('Please open an .xlf file first.');
        return;
      }

      const currentText = (await vscode.workspace.fs.readFile(target)).toString();
      const baselineText = getBaselineContent(target.fsPath);

      let currentParsed;
      try {
        currentParsed = parseXliff(currentText);
      } catch (err: unknown) {
        vscode.window.showErrorMessage(`Failed to parse current XLIFF: ${(err as Error).message}`);
        return;
      }

      if (!baselineText) {
        vscode.window.showInformationMessage('No baseline found in git HEAD (new file or not tracked). Showing all units as added.');
      }

      let oldUnits: XliffUnit[] = [];
      if (baselineText) {
        try {
          oldUnits = parseXliff(baselineText).units;
        } catch {
          // baseline is unparseable — treat everything as added
        }
      }

      const diffs = computeDiff(oldUnits, currentParsed.units);
      const fileName = path.basename(target.fsPath);
      const panel = vscode.window.createWebviewPanel(
        'nexus.translationDiff',
        `Diff: ${fileName}`,
        vscode.ViewColumn.Beside,
        { enableScripts: false }
      );

      const nonce = getNonce();
      panel.webview.html = getDiffHtml(panel.webview.cspSource, nonce, fileName, diffs);
    })
  );
}
