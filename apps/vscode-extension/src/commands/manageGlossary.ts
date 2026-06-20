import * as vscode from 'vscode';
import { getGlossaryManager } from '../glossaryManager';
import { getTmManager } from '../tmManager';
import { getConfig } from '../provider';

export function registerManageGlossary(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('nexus.manageGlossary', async () => {
      const panel = vscode.window.createWebviewPanel(
        'nexus.glossaryManager',
        'Nexus: Glossary & TM',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true }
      );

      const glossary = getGlossaryManager(context);
      const tm = getTmManager(context);
      const config = getConfig();

      panel.webview.html = getGlossaryHtml(panel.webview.cspSource, getNonce());

      const sendGlossary = async () => {
        const terms = await glossary.getAll();
        const tmEntries = await tm.getAll();
        panel.webview.postMessage({
          type: 'glossaryData',
          terms,
          tmCount: tmEntries.length,
          defaultSrc: config.sourceLanguage,
          defaultTgt: config.targetLanguage,
        });
      };

      panel.webview.onDidReceiveMessage(async (msg) => {
        switch (msg.type as string) {
          case 'getGlossary':
            await sendGlossary();
            break;

          case 'addTerm': {
            const src = (msg.sourceTerm as string)?.trim();
            const tgt = (msg.targetTerm as string)?.trim();
            if (!src || !tgt) break;
            await glossary.add({
              sourceTerm: src,
              targetTerm: tgt,
              sourceLanguage: (msg.sourceLanguage as string) || config.sourceLanguage,
              targetLanguage: (msg.targetLanguage as string) || config.targetLanguage,
              description: (msg.description as string)?.trim() || undefined,
              caseSensitive: !!msg.caseSensitive,
            });
            await sendGlossary();
            break;
          }

          case 'deleteTerm':
            await glossary.delete(msg.id as string);
            await sendGlossary();
            break;
        }
      }, undefined, context.subscriptions);
    })
  );
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) nonce += chars[Math.floor(Math.random() * chars.length)];
  return nonce;
}

function getGlossaryHtml(cspSource: string, nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Nexus Glossary & TM</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 16px;
    }
    h1 { font-size: 16px; margin-bottom: 4px; }
    .subtitle { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 16px; }
    .add-form {
      display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-end;
      padding: 12px; margin-bottom: 16px;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      border-radius: 4px;
      background: var(--vscode-sideBar-background, rgba(128,128,128,0.05));
    }
    .field { display: flex; flex-direction: column; gap: 3px; }
    .field label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); }
    input[type=text] {
      height: 28px; padding: 3px 8px; min-width: 140px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
      color: var(--vscode-input-foreground);
      border-radius: 3px; font-size: 12px; font-family: inherit;
    }
    input:focus { outline: 1px solid var(--vscode-focusBorder); }
    .chk-field { flex-direction: row; align-items: center; gap: 5px; height: 28px; }
    button {
      height: 28px; padding: 0 12px; border: none; border-radius: 3px;
      cursor: pointer; font-size: 12px; font-family: inherit;
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .btn-del {
      background: transparent; color: var(--vscode-errorForeground, #f48771);
      border: 1px solid transparent; height: 24px; padding: 0 8px; font-size: 11px;
    }
    .btn-del:hover { background: rgba(244,135,113,0.15); }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th {
      text-align: left; padding: 6px 8px; font-size: 10px; text-transform: uppercase;
      letter-spacing: 0.05em; color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
    }
    td { padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.1)); vertical-align: top; }
    .term { font-weight: 600; }
    .lang-pill { font-size: 10px; color: var(--vscode-descriptionForeground); }
    .desc { color: var(--vscode-descriptionForeground); font-style: italic; }
    .empty { padding: 24px; text-align: center; color: var(--vscode-descriptionForeground); }
    .tm-note { margin-top: 18px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <h1>Glossary &amp; Translation Memory</h1>
  <div class="subtitle">Glossary terms are passed to AI translation so terminology stays consistent. TM stores confirmed translations and is populated automatically on save.</div>

  <div class="add-form">
    <div class="field"><label>Source term</label><input type="text" id="in-source" placeholder="e.g. Invoice"></div>
    <div class="field"><label>Target term</label><input type="text" id="in-target" placeholder="e.g. Rechnung"></div>
    <div class="field"><label>Source lang</label><input type="text" id="in-srclang" style="min-width:80px"></div>
    <div class="field"><label>Target lang</label><input type="text" id="in-tgtlang" style="min-width:80px"></div>
    <div class="field"><label>Description (optional)</label><input type="text" id="in-desc" placeholder="notes"></div>
    <div class="field chk-field"><input type="checkbox" id="in-case"><label for="in-case" style="text-transform:none">Case sensitive</label></div>
    <button id="btn-add">+ Add term</button>
  </div>

  <table>
    <thead>
      <tr><th>Source</th><th>Target</th><th>Languages</th><th>Description</th><th></th></tr>
    </thead>
    <tbody id="tbody"></tbody>
  </table>
  <div id="empty" class="empty" hidden>No glossary terms yet. Add one above.</div>
  <div id="tm-note" class="tm-note"></div>

  <script nonce="${nonce}">
  (function () {
    var vscode = acquireVsCodeApi();
    var defaultSrc = 'en-US', defaultTgt = 'de-DE';

    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    window.addEventListener('message', function (event) {
      var msg = event.data;
      if (!msg || msg.type !== 'glossaryData') return;
      defaultSrc = msg.defaultSrc || defaultSrc;
      defaultTgt = msg.defaultTgt || defaultTgt;
      if (!document.getElementById('in-srclang').value) document.getElementById('in-srclang').value = defaultSrc;
      if (!document.getElementById('in-tgtlang').value) document.getElementById('in-tgtlang').value = defaultTgt;

      var terms = msg.terms || [];
      var tbody = document.getElementById('tbody');
      document.getElementById('empty').hidden = terms.length > 0;
      tbody.innerHTML = terms.map(function (t) {
        return '<tr>' +
          '<td class="term">' + esc(t.sourceTerm) + (t.caseSensitive ? ' <span class="lang-pill">(Aa)</span>' : '') + '</td>' +
          '<td class="term">' + esc(t.targetTerm) + '</td>' +
          '<td class="lang-pill">' + esc(t.sourceLanguage) + ' \\u2192 ' + esc(t.targetLanguage) + '</td>' +
          '<td class="desc">' + esc(t.description || '') + '</td>' +
          '<td><button class="btn-del" data-id="' + esc(t.id) + '">\\u2715 Delete</button></td>' +
          '</tr>';
      }).join('');
      tbody.querySelectorAll('.btn-del').forEach(function (b) {
        b.addEventListener('click', function () {
          vscode.postMessage({ type: 'deleteTerm', id: this.getAttribute('data-id') });
        });
      });
      document.getElementById('tm-note').textContent = 'Translation Memory: ' + (msg.tmCount || 0) + ' entr' + (msg.tmCount === 1 ? 'y' : 'ies') + ' stored.';
    });

    document.getElementById('btn-add').addEventListener('click', function () {
      var src = document.getElementById('in-source').value.trim();
      var tgt = document.getElementById('in-target').value.trim();
      if (!src || !tgt) return;
      vscode.postMessage({
        type: 'addTerm',
        sourceTerm: src,
        targetTerm: tgt,
        sourceLanguage: document.getElementById('in-srclang').value.trim() || defaultSrc,
        targetLanguage: document.getElementById('in-tgtlang').value.trim() || defaultTgt,
        description: document.getElementById('in-desc').value,
        caseSensitive: document.getElementById('in-case').checked
      });
      document.getElementById('in-source').value = '';
      document.getElementById('in-target').value = '';
      document.getElementById('in-desc').value = '';
      document.getElementById('in-case').checked = false;
    });

    vscode.postMessage({ type: 'getGlossary' });
  }());
  </script>
</body>
</html>`;
}
