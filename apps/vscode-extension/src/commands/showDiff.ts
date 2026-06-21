import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { parseXliff } from '@nexus/xliff';
import type { XliffUnit } from '@nexus/types';
import { pendingUnitIds } from '../state';
import { TranslationEditorProvider } from '../translationEditor';
import { getNavigationViewColumn } from '../navigation';

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

/** Resolve git root for a file and return { gitRoot, relPath } or null. */
function resolveGitInfo(fsPath: string): { gitRoot: string; relPath: string } | null {
  const fileDir = path.dirname(fsPath);
  try {
    const gitRoot = cp.execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: fileDir,
      encoding: 'utf-8',
    }).trim().replace(/\//g, path.sep);

    const relPath = path.relative(gitRoot, fsPath).replace(/\\/g, '/');
    return { gitRoot, relPath };
  } catch {
    return null;
  }
}

function getBaselineContent(fsPath: string): string | null {
  const info = resolveGitInfo(fsPath);
  if (!info) return null;
  const { gitRoot, relPath } = info;

  // Try HEAD first, then the index (staged version) as fallback
  for (const ref of [`HEAD:${relPath}`, `:${relPath}`]) {
    try {
      const result = cp.execFileSync('git', ['show', ref], {
        cwd: gitRoot,
        maxBuffer: 50 * 1024 * 1024,
      });
      return result.toString('utf-8');
    } catch {
      // try next ref
    }
  }
  return null; // untracked new file
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
  diffs: UnitDiff[],
  baselineLabel: string,
  actionableIds: string[]
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
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
    h2 { font-size: 15px; font-weight: 600; margin-bottom: 4px; }
    .baseline-label { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 12px; }
    .baseline-label code { font-family: var(--vscode-editor-font-family, monospace); }
    .summary {
      display: flex; gap: 16px; margin-bottom: 12px;
      padding: 10px 14px;
      background: var(--vscode-sideBar-background, rgba(128,128,128,0.05));
      border-radius: 4px; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
    }
    .sum-item { display: flex; align-items: center; gap: 6px; font-size: 13px; }
    .sum-dot { width: 10px; height: 10px; border-radius: 50%; }
    .open-btn {
      margin-bottom: 12px;
      display: inline-flex; align-items: center; gap: 6px;
      padding: 5px 12px; border-radius: 4px; border: none; cursor: pointer;
      font-size: 12px; font-family: inherit;
      background: var(--vscode-button-background, #0078d4);
      color: var(--vscode-button-foreground, #fff);
    }
    .open-btn:hover { background: var(--vscode-button-hoverBackground, #006cbf); }
    .open-btn:disabled { opacity: 0.5; cursor: default; }
    .open-btn-secondary {
      margin-left: 8px;
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #fff);
    }
    .open-btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
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
  <p class="baseline-label">Compared to: <code>${esc(baselineLabel)}</code></p>
  ${diffs.length === 0
    ? `<div class="empty-state">✓ No translation changes compared to ${esc(baselineLabel)}</div>`
    : `<div class="summary">
        <div class="sum-item"><div class="sum-dot" style="background:#dcdcaa"></div>${modified} modified</div>
        <div class="sum-item"><div class="sum-dot" style="background:#4ec9b0"></div>${added} added</div>
        <div class="sum-item"><div class="sum-dot" style="background:#f48771"></div>${removed} removed</div>
      </div>
      ${actionableIds.length > 0
        ? `<button class="open-btn" id="btn-open-nexus">&#9998; Edit ${actionableIds.length} changed unit${actionableIds.length !== 1 ? 's' : ''} in Nexus Translator</button>`
        : ''}
      <button class="open-btn open-btn-secondary" id="btn-open-xmldiff" title="Open the standard VS Code text diff (HEAD vs working tree)">&#8644; Open standard XML diff</button>
      <table>
        <colgroup><col class="c-status"><col class="c-ctx"><col class="c-src"><col class="c-tgt"></colgroup>
        <thead><tr><th>Status</th><th>Context</th><th>Source</th><th>Target</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
  }
  <script nonce="${nonce}">
    var vscode = acquireVsCodeApi();
    var actionableIds = ${JSON.stringify(actionableIds)};
    var btn = document.getElementById('btn-open-nexus');
    if (btn) {
      btn.addEventListener('click', function () {
        btn.disabled = true;
        btn.textContent = 'Opening…';
        vscode.postMessage({ type: 'openInNexus', unitIds: actionableIds });
      });
    }
    var btnXml = document.getElementById('btn-open-xmldiff');
    if (btnXml) {
      btnXml.addEventListener('click', function () {
        vscode.postMessage({ type: 'openXmlDiff' });
      });
    }
  </script>
</body>
</html>`;
}

// ─── Command ──────────────────────────────────────────────────────────────────

/** Resolve baseline content and label. Tries HEAD then index (:path). */
function resolveBaseline(fsPath: string): { content: string; label: string } | null {
  const info = resolveGitInfo(fsPath);
  if (!info) return null;
  const { gitRoot, relPath } = info;

  const candidates = [
    { ref: `HEAD:${relPath}`, label: 'HEAD' },
    { ref: `:${relPath}`,     label: 'index (staged)' },
  ];

  for (const { ref, label } of candidates) {
    try {
      const content = cp.execFileSync('git', ['show', ref], {
        cwd: gitRoot,
        maxBuffer: 50 * 1024 * 1024,
      }).toString('utf-8');
      return { content, label };
    } catch {
      // try next
    }
  }
  return null;
}

export function registerShowTranslationDiff(
  context: vscode.ExtensionContext,
  extensionUri: vscode.Uri
): void {
  // Reuse one diff panel per file so re-opening focuses the existing view
  // instead of stacking duplicate tabs.
  const openDiffPanels = new Map<string, vscode.WebviewPanel>();

  // Virtual scheme used to render BOTH sides of the standard text diff (HEAD
  // and working tree). Routing both sides through this provider — with a path
  // that does NOT end in .xlf — guarantees a plain text/XML diff and prevents
  // the *.xlf custom-editor association from hijacking either side.
  const XMLDIFF_SCHEME = 'nexus-xmlbaseline';
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(XMLDIFF_SCHEME, {
      provideTextDocumentContent(u: vscode.Uri): string {
        const params = new URLSearchParams(u.query);
        const fsPath = params.get('path') || '';
        if (!fsPath) return '';
        if (params.get('role') === 'working') {
          try {
            return fs.readFileSync(fsPath, 'utf-8');
          } catch {
            return '';
          }
        }
        const b = resolveBaseline(fsPath);
        return b ? b.content : '';
      },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('nexus.showTranslationDiff', async (uri?: vscode.Uri) => {
      const raw = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!raw || !raw.fsPath.toLowerCase().endsWith('.xlf')) {
        vscode.window.showErrorMessage('Please open an .xlf file first.');
        return;
      }
      // Always work against the working-tree file, even if invoked with a
      // non-file scheme (e.g. a git: URI from a Source Control diff).
      const target = raw.scheme === 'file' ? raw : vscode.Uri.file(raw.fsPath);

      // If a diff is already open for this file, just focus it.
      const existing = openDiffPanels.get(target.toString());
      if (existing) {
        existing.reveal(vscode.ViewColumn.Active);
        return;
      }

      const currentText = (await vscode.workspace.fs.readFile(target)).toString();

      let currentParsed;
      try {
        currentParsed = parseXliff(currentText);
      } catch (err: unknown) {
        vscode.window.showErrorMessage(`Failed to parse current XLIFF: ${(err as Error).message}`);
        return;
      }

      const baseline = resolveBaseline(target.fsPath);
      let oldUnits: XliffUnit[] = [];
      let baselineLabel = 'git HEAD';

      if (!baseline) {
        vscode.window.showWarningMessage(
          'No git baseline found — file may be untracked. Showing all units as new.'
        );
      } else {
        baselineLabel = baseline.label;
        try {
          oldUnits = parseXliff(baseline.content).units;
        } catch {
          vscode.window.showWarningMessage('Baseline XLIFF could not be parsed — showing all units as new.');
        }
      }

      const diffs = computeDiff(oldUnits, currentParsed.units);
      // Only added/modified units can be edited (removed units no longer exist)
      const actionableIds = diffs
        .filter((d) => d.type === 'added' || d.type === 'modified')
        .map((d) => d.unit.id);

      const fileName = path.basename(target.fsPath);
      const panel = vscode.window.createWebviewPanel(
        'nexus.translationDiff',
        `Diff: ${fileName}`,
        vscode.ViewColumn.Active,
        { enableScripts: true, localResourceRoots: [extensionUri] }
      );
      openDiffPanels.set(target.toString(), panel);
      panel.onDidDispose(() => {
        if (openDiffPanels.get(target.toString()) === panel) {
          openDiffPanels.delete(target.toString());
        }
      });

      const nonce = getNonce();
      panel.webview.html = getDiffHtml(panel.webview.cspSource, nonce, fileName, diffs, baselineLabel, actionableIds);

      panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.type === 'openInNexus' && Array.isArray(msg.unitIds)) {
          const uriKey = target.toString();
          // If panel already open, apply filter directly; otherwise store for sendInit
          if (!TranslationEditorProvider.applyFilter(target, '', undefined, msg.unitIds)) {
            pendingUnitIds.set(uriKey, msg.unitIds);
            await vscode.commands.executeCommand('vscode.openWith', target, 'nexus.translationEditor', getNavigationViewColumn());
          }
        } else if (msg.type === 'openXmlDiff') {
          // Standard VS Code text diff: HEAD (left) ↔ working tree (right).
          // Both sides use the virtual scheme with a non-.xlf path so the
          // Nexus custom editor never claims them.
          const leftUri = vscode.Uri.from({
            scheme: XMLDIFF_SCHEME,
            path: '/' + fileName + ' (HEAD).xml',
            query: new URLSearchParams({ role: 'head', path: target.fsPath }).toString(),
          });
          const rightUri = vscode.Uri.from({
            scheme: XMLDIFF_SCHEME,
            path: '/' + fileName + ' (Working Tree).xml',
            query: new URLSearchParams({ role: 'working', path: target.fsPath }).toString(),
          });
          await vscode.commands.executeCommand(
            'vscode.diff',
            leftUri,
            rightUri,
            `${fileName} (HEAD \u2194 Working Tree)`,
            { viewColumn: vscode.ViewColumn.Active }
          );
        }
      }, undefined, context.subscriptions);
    })
  );
}
