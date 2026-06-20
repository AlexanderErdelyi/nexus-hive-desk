/** Returns the full HTML for the translation editor webview panel. */
export function getWebviewContent(cspSource: string, nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Nexus Translation Editor</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* ─── Header ─── */
    #header {
      padding: 10px 16px;
      background: var(--vscode-sideBar-background, var(--vscode-editorGroupHeader-tabsBackground));
      border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-editorGroup-border));
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-shrink: 0;
      min-height: 52px;
    }
    .hdr-left { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .file-name { font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .lang-pair { font-size: 11px; color: var(--vscode-descriptionForeground); }
    .hdr-right { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
    .stat-pill {
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 10px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      white-space: nowrap;
    }
    .stat-pill.needs { background: rgba(230,153,0,0.2); color: #e69900; border: 1px solid rgba(230,153,0,0.35); }
    .progress-wrap { display: flex; align-items: center; gap: 6px; }
    .progress-track { width: 90px; height: 6px; background: var(--vscode-progressBar-background, rgba(128,128,128,0.2)); border-radius: 3px; overflow: hidden; }
    .progress-fill { height: 100%; background: var(--vscode-button-background, #007acc); border-radius: 3px; transition: width 0.3s ease; }
    .progress-label { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; }

    /* ─── Toolbar ─── */
    #toolbar {
      padding: 7px 16px;
      background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-sideBar-background));
      border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-editorGroup-border));
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
      flex-wrap: wrap;
    }
    .toolbar-search {
      flex: 1;
      min-width: 140px;
      max-width: 280px;
      padding: 4px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      font-size: var(--vscode-font-size, 13px);
      font-family: var(--vscode-font-family, inherit);
    }
    .toolbar-search:focus { outline: 1px solid var(--vscode-focusBorder); border-color: var(--vscode-focusBorder); }
    .toolbar-select {
      padding: 4px 6px;
      background: var(--vscode-dropdown-background, var(--vscode-input-background));
      color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, transparent));
      border-radius: 2px;
      font-size: var(--vscode-font-size, 13px);
      font-family: var(--vscode-font-family, inherit);
      cursor: pointer;
    }
    .toolbar-select:focus { outline: 1px solid var(--vscode-focusBorder); }
    .toolbar-spacer { flex: 1; }
    button {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 4px 10px;
      border: none;
      border-radius: 2px;
      cursor: pointer;
      font-size: var(--vscode-font-size, 13px);
      font-family: var(--vscode-font-family, inherit);
      white-space: nowrap;
    }
    .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .btn-primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2));
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      border: 1px solid var(--vscode-button-border, transparent);
    }
    .btn-secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.3)); }
    .btn-ghost {
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border: 1px solid transparent;
      font-size: 11px;
    }
    .btn-ghost:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); border-color: var(--vscode-widget-border, transparent); }
    .btn-go-source {
      background: transparent;
      border: none;
      color: var(--vscode-textLink-foreground);
      font-size: 11px;
      padding: 1px 5px;
      cursor: pointer;
      border-radius: 3px;
      opacity: 0;
      transition: opacity 0.15s;
      margin-left: auto;
    }
    .unit-card:hover .btn-go-source { opacity: 1; }
    .btn-go-source:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
    button:disabled { opacity: 0.45; cursor: default; }

    /* ─── Unit list ─── */
    #unit-list {
      flex: 1;
      overflow-y: auto;
      padding: 10px 16px;
    }
    .unit-card {
      margin-bottom: 6px;
      border: 1px solid var(--vscode-panel-border, var(--vscode-editorGroup-border));
      border-radius: 4px;
      background: var(--vscode-editor-background);
      transition: border-color 0.15s;
    }
    .unit-card:hover { border-color: var(--vscode-focusBorder); }
    .unit-card.has-pending { border-left: 3px solid var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
    .unit-card.is-loading { opacity: 0.65; pointer-events: none; }
    .unit-body { padding: 9px 12px 6px; }
    .unit-meta { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; flex-wrap: wrap; }
    .unit-id {
      font-size: 10px;
      font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
      color: var(--vscode-descriptionForeground);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 400px;
      flex-shrink: 1;
    }
    .source-row { display: flex; gap: 8px; margin-bottom: 5px; }
    .source-label { font-size: 11px; color: var(--vscode-descriptionForeground); flex-shrink: 0; padding-top: 1px; }
    .source-text {
      font-size: 13px;
      color: var(--vscode-editor-foreground);
      line-height: 1.4;
      word-break: break-word;
    }
    .dev-note {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.1));
      border-left: 2px solid var(--vscode-textBlockQuote-border, rgba(128,128,128,0.35));
      padding: 3px 6px;
      margin-bottom: 5px;
      border-radius: 0 2px 2px 0;
      word-break: break-word;
    }
    textarea.target-input {
      width: 100%;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      padding: 5px 7px;
      font-size: var(--vscode-font-size, 13px);
      font-family: var(--vscode-font-family, inherit);
      line-height: 1.4;
      resize: none;
      min-height: 34px;
      overflow: hidden;
      display: block;
      margin-bottom: 6px;
    }
    textarea.target-input:focus { outline: 1px solid var(--vscode-focusBorder); border-color: var(--vscode-focusBorder); }
    .unit-actions { display: flex; align-items: center; gap: 8px; padding: 5px 12px 8px; border-top: 1px solid var(--vscode-panel-border, var(--vscode-editorGroup-border)); background: var(--vscode-sideBar-background, transparent); border-radius: 0 0 4px 4px; }
    .state-select {
      padding: 3px 6px;
      background: var(--vscode-dropdown-background, var(--vscode-input-background));
      color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, transparent));
      border-radius: 2px;
      font-size: 11px;
      font-family: var(--vscode-font-family, inherit);
      cursor: pointer;
    }
    .state-select:focus { outline: 1px solid var(--vscode-focusBorder); }
    .actions-right { margin-left: auto; display: flex; align-items: center; gap: 6px; }
    .btn-ai-single { padding: 3px 8px; font-size: 11px; }
    .review-box {
      margin: 0 12px 8px;
      padding: 6px 10px;
      border-radius: 3px;
      font-size: 12px;
      line-height: 1.4;
    }
    .review-good { background: rgba(35,180,90,0.1); border: 1px solid rgba(35,180,90,0.3); color: #23b45a; }
    .review-warning { background: rgba(230,153,0,0.1); border: 1px solid rgba(230,153,0,0.35); color: #e69900; }
    .review-error { background: rgba(240,60,60,0.1); border: 1px solid rgba(240,60,60,0.35); color: #f04040; }
    .review-suggestion { margin-top: 4px; font-style: italic; }

    /* ─── State badges ─── */
    .state-badge {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 10px;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.2px;
      flex-shrink: 0;
      text-transform: uppercase;
    }
    .state-new { background: rgba(128,128,128,0.15); color: var(--vscode-descriptionForeground); border: 1px solid rgba(128,128,128,0.3); }
    .state-needs-translation { background: rgba(230,153,0,0.15); color: #e69900; border: 1px solid rgba(230,153,0,0.35); }
    .state-needs-review-translation { background: rgba(180,90,220,0.15); color: #b45adc; border: 1px solid rgba(180,90,220,0.35); }
    .state-translated { background: rgba(0,122,204,0.15); color: #4daaff; border: 1px solid rgba(0,122,204,0.35); }
    .state-final { background: rgba(35,180,90,0.15); color: #23b45a; border: 1px solid rgba(35,180,90,0.35); }
    .state-signed-off { background: rgba(20,140,60,0.15); color: #148c3c; border: 1px solid rgba(20,140,60,0.35); }

    /* ─── Confidence badge ─── */
    .conf-badge {
      display: inline-block;
      padding: 1px 5px;
      border-radius: 10px;
      font-size: 10px;
      font-weight: 600;
    }
    .conf-high { background: rgba(35,180,90,0.15); color: #23b45a; }
    .conf-med  { background: rgba(230,153,0,0.15);  color: #e69900; }
    .conf-low  { background: rgba(240,60,60,0.15);  color: #f04040; }

    /* ─── Loading / Spinner ─── */
    .spinner {
      display: inline-block;
      width: 11px; height: 11px;
      border: 2px solid rgba(128,128,128,0.3);
      border-top-color: currentColor;
      border-radius: 50%;
      animation: spin 0.75s linear infinite;
      vertical-align: middle;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ─── Empty / loading states ─── */
    .empty-state {
      padding: 48px 16px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }
    .load-more-wrap { text-align: center; padding: 12px 0 4px; }

    /* ─── Footer ─── */
    #footer {
      padding: 7px 16px;
      background: var(--vscode-statusBar-background, var(--vscode-editorGroupHeader-tabsBackground));
      border-top: 1px solid var(--vscode-panel-border, var(--vscode-editorGroup-border));
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
    }
    .footer-info { font-size: 12px; color: var(--vscode-descriptionForeground); }
    .pending-dot { font-size: 12px; color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
    .btn-save { padding: 4px 14px; font-size: 13px; }

    /* ─── Notification toast ─── */
    #notif {
      position: fixed;
      bottom: 52px;
      right: 16px;
      padding: 8px 14px;
      border-radius: 4px;
      font-size: 12px;
      max-width: 380px;
      z-index: 200;
      animation: slide-up 0.2s ease;
    }
    #notif.hidden { display: none; }
    .notif-success { background: var(--vscode-notificationsInfoIcon-foreground, #007acc); color: #fff; }
    .notif-error { background: var(--vscode-errorForeground, #f04040); color: #fff; }
    .notif-info { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    @keyframes slide-up { from { transform: translateY(8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  </style>
</head>
<body>

  <!-- Header: file info + progress -->
  <div id="header">
    <div class="hdr-left">
      <span class="file-name" id="hdr-file">Loading…</span>
      <span class="lang-pair" id="hdr-langs"></span>
    </div>
    <div class="hdr-right">
      <span class="stat-pill needs" id="hdr-needs" hidden></span>
      <div class="progress-wrap">
        <div class="progress-track"><div class="progress-fill" id="hdr-fill" style="width:0%"></div></div>
        <span class="progress-label" id="hdr-pct">—</span>
      </div>
    </div>
  </div>

  <!-- Toolbar: search + filter + actions -->
  <div id="toolbar">
    <input id="search-input" class="toolbar-search" type="search" placeholder="🔍  Search source, target or ID…" autocomplete="off">
    <select id="state-filter" class="toolbar-select">
      <option value="all">All States</option>
      <option value="needs-translation">Needs Translation</option>
      <option value="needs-review-translation">Needs Review</option>
      <option value="new">New</option>
      <option value="translated">Translated</option>
      <option value="final">Final</option>
      <option value="signed-off">Signed Off</option>
    </select>
    <div class="toolbar-spacer"></div>
    <button id="btn-translate-all" class="btn-primary" title="AI-translate all untranslated units">⚡ Translate Untranslated</button>
    <button id="btn-review-all" class="btn-secondary" title="AI review all translated units">🔍 Review</button>
    <button id="btn-open-text" class="btn-ghost" title="Open raw XML in the default text editor">📄 Raw XML</button>
  </div>

  <!-- Unit list (scrollable) -->
  <div id="unit-list"><div class="empty-state"><span class="spinner"></span> Loading translations…</div></div>

  <!-- Footer: pending indicator + save -->
  <div id="footer">
    <span class="footer-info" id="footer-shown"></span>
    <span class="pending-dot" id="footer-pending" hidden></span>
    <div class="toolbar-spacer"></div>
    <button id="btn-save" class="btn-primary btn-save" disabled>💾 Save</button>
  </div>

  <!-- Notification -->
  <div id="notif" class="hidden"></div>

  <script nonce="${nonce}">
  (function () {
    'use strict';

    var vscode = acquireVsCodeApi();

    // ─── State ────────────────────────────────────────────────────────────────
    var units = [];
    var filterSearch = '';
    var filterState = 'all';
    var pendingChanges = {};   // id -> { target, state }
    var reviewMap = {};        // id -> { quality, reason, suggestion }
    var loadingSet = new Set();
    var srcLang = '';
    var tgtLang = '';
    var fileName = '';
    var visibleCount = 80;
    var notifTimer = null;

    // ─── Startup ──────────────────────────────────────────────────────────────
    vscode.postMessage({ type: 'ready' });

    // ─── Message handling ─────────────────────────────────────────────────────
    window.addEventListener('message', function (evt) {
      var msg = evt.data;
      if (!msg || !msg.type) return;

      if (msg.type === 'init') {
        units = msg.units || [];
        srcLang = msg.sourceLanguage || '';
        tgtLang = msg.targetLanguage || '';
        fileName = msg.fileName || '';
        pendingChanges = {};
        reviewMap = {};
        loadingSet = new Set();
        visibleCount = 80;
        // Apply initial filter from "Find in Nexus Translator" command
        if (msg.initialFilter) {
          filterSearch = msg.initialFilter;
          var searchEl = document.getElementById('search-input');
          if (searchEl) searchEl.value = filterSearch;
        }
        renderAll();

      } else if (msg.type === 'translating') {
        (msg.ids || []).forEach(function (id) { loadingSet.add(id); });
        renderList();

      } else if (msg.type === 'translationResults') {
        (msg.results || []).forEach(function (r) {
          loadingSet.delete(r.id);
          var unit = findUnit(r.id);
          if (unit) {
            unit.target = r.translatedText;
            unit.state = 'translated';
            if (r.confidenceScore != null) unit.confidenceScore = r.confidenceScore;
          }
          pendingChanges[r.id] = { target: r.translatedText, state: 'translated' };
        });
        renderAll();
        showNotif('Translated ' + msg.results.length + ' unit(s).', 'success');

      } else if (msg.type === 'reviewing') {
        (msg.ids || []).forEach(function (id) { loadingSet.add(id); });
        renderList();

      } else if (msg.type === 'reviewResults') {
        loadingSet.clear();
        (msg.results || []).forEach(function (r) {
          reviewMap[r.id] = r;
        });
        renderList();
        var errors = msg.results.filter(function (r) { return r.quality === 'error'; }).length;
        var warnings = msg.results.filter(function (r) { return r.quality === 'warning'; }).length;
        showNotif('Review done — ' + errors + ' errors, ' + warnings + ' warnings.', errors > 0 ? 'error' : 'success');

      } else if (msg.type === 'error') {
        loadingSet.clear();
        renderList();
        showNotif(msg.message, 'error');

      } else if (msg.type === 'saved') {
        pendingChanges = {};
        renderFooter();
        showNotif('Saved.', 'success');
      }
    });

    // ─── Render ───────────────────────────────────────────────────────────────
    function renderAll() {
      renderHeader();
      renderList();
      renderFooter();
    }

    function getStats() {
      var total = units.length;
      var translated = 0, needsTrans = 0;
      for (var i = 0; i < units.length; i++) {
        var s = units[i].state;
        if (s === 'translated' || s === 'final' || s === 'signed-off') translated++;
        if (s === 'new' || s === 'needs-translation' || !units[i].target) needsTrans++;
      }
      var pct = total > 0 ? Math.round(translated / total * 100) : 0;
      return { total: total, translated: translated, needsTrans: needsTrans, pct: pct };
    }

    function getFiltered() {
      var q = filterSearch.toLowerCase();
      return units.filter(function (u) {
        if (filterState !== 'all' && u.state !== filterState) return false;
        if (q) {
          var hit = u.source.toLowerCase().indexOf(q) >= 0 ||
                    u.target.toLowerCase().indexOf(q) >= 0 ||
                    u.id.toLowerCase().indexOf(q) >= 0;
          if (!hit) return false;
        }
        return true;
      });
    }

    function renderHeader() {
      var stats = getStats();
      document.getElementById('hdr-file').textContent = fileName || 'Translation Editor';
      document.getElementById('hdr-langs').textContent = srcLang && tgtLang ? srcLang + ' \u2192 ' + tgtLang : '';
      var needsEl = document.getElementById('hdr-needs');
      if (stats.needsTrans > 0) {
        needsEl.textContent = stats.needsTrans + ' to translate';
        needsEl.hidden = false;
      } else {
        needsEl.hidden = true;
      }
      document.getElementById('hdr-fill').style.width = stats.pct + '%';
      document.getElementById('hdr-pct').textContent = stats.translated + '/' + stats.total + ' (' + stats.pct + '%)';
    }

    function renderList() {
      var filtered = getFiltered();
      var visible = filtered.slice(0, visibleCount);
      var el = document.getElementById('unit-list');

      if (filtered.length === 0) {
        el.innerHTML = '<div class="empty-state">No units match the current filter.</div>';
        return;
      }

      var html = '';
      for (var i = 0; i < visible.length; i++) {
        html += renderCard(visible[i]);
      }
      if (filtered.length > visibleCount) {
        html += '<div class="load-more-wrap"><button class="btn-secondary" id="btn-load-more">Load more (' + (filtered.length - visibleCount) + ' remaining)</button></div>';
      }
      el.innerHTML = html;

      // Attach listeners
      el.querySelectorAll('textarea.target-input').forEach(function (ta) {
        ta.addEventListener('input', autoResize);
        ta.addEventListener('blur', onTargetBlur);
        autoResize.call(ta);
      });
      el.querySelectorAll('.state-select').forEach(function (sel) {
        sel.addEventListener('change', onStateChange);
      });
      el.querySelectorAll('.btn-ai-single').forEach(function (btn) {
        btn.addEventListener('click', onTranslateSingle);
      });
      el.querySelectorAll('.btn-go-source').forEach(function (btn) {
        btn.addEventListener('click', function () {
          vscode.postMessage({ type: 'goToSource', id: this.getAttribute('data-id') });
        });
      });
      var btnLoadMore = document.getElementById('btn-load-more');
      if (btnLoadMore) {
        btnLoadMore.addEventListener('click', function () {
          visibleCount += 80;
          renderList();
        });
      }
    }

    function renderCard(unit) {
      var isLoading = loadingSet.has(unit.id);
      var hasPending = pendingChanges[unit.id] !== undefined;
      var review = reviewMap[unit.id];
      var confBadge = '';
      if (unit.confidenceScore != null) {
        var tier = unit.confidenceScore >= 90 ? 'high' : unit.confidenceScore >= 70 ? 'med' : 'low';
        confBadge = '<span class="conf-badge conf-' + tier + '">' + unit.confidenceScore + '% conf</span>';
      }
      var devNote = unit.developerNote
        ? '<div class="dev-note">\uD83D\uDCDD ' + esc(unit.developerNote) + '</div>'
        : '';
      var reviewHtml = '';
      if (review) {
        if (review.quality === 'good') {
          reviewHtml = '<div class="review-box review-good">\u2713 Good translation</div>';
        } else {
          var cls = review.quality === 'error' ? 'review-error' : 'review-warning';
          var icon = review.quality === 'error' ? '\u2716' : '\u26A0';
          reviewHtml = '<div class="review-box ' + cls + '">' + icon + ' ' + esc(review.reason || '') +
            (review.suggestion ? '<div class="review-suggestion">Suggestion: ' + esc(review.suggestion) + '</div>' : '') +
            '</div>';
        }
      }
      var loadingOverlay = isLoading ? '<div class="spinner" style="margin-right:4px"></div>' : '';
      var cardClass = 'unit-card' + (hasPending ? ' has-pending' : '') + (isLoading ? ' is-loading' : '');
      return '<div class="' + cardClass + '" data-id="' + esc(unit.id) + '">' +
        '<div class="unit-body">' +
          '<div class="unit-meta">' +
            '<span class="state-badge state-' + esc(unit.state) + '">' + fmtState(unit.state) + '</span>' +
            confBadge +
            loadingOverlay +
            '<span class="unit-id" title="' + esc(unit.id) + '">' + esc(trunc(unit.id, 90)) + '</span>' +
            '<button class="btn-go-source" data-id="' + esc(unit.id) + '" title="Go to source in AL file">⤴ Source</button>' +
          '</div>' +
          '<div class="source-row">' +
            '<span class="source-label">SRC</span>' +
            '<span class="source-text">' + esc(unit.source) + '</span>' +
          '</div>' +
          devNote +
          '<textarea class="target-input" data-id="' + esc(unit.id) + '" rows="2"' +
            (isLoading ? ' disabled' : '') + '>' + esc(unit.target) + '</textarea>' +
        '</div>' +
        reviewHtml +
        '<div class="unit-actions">' +
          '<select class="state-select" data-id="' + esc(unit.id) + '">' + stateOpts(unit.state) + '</select>' +
          '<div class="actions-right">' +
            '<button class="btn-secondary btn-ai-single" data-id="' + esc(unit.id) + '" data-source="' + esc(unit.source) + '"' +
              (isLoading ? ' disabled' : '') + '>' +
              (isLoading ? '<span class="spinner"></span> Translating\u2026' : '\u27F3 AI Translate') +
            '</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    }

    function renderFooter() {
      var filtered = getFiltered();
      var cnt = Object.keys(pendingChanges).length;
      document.getElementById('footer-shown').textContent = filtered.length + ' of ' + units.length + ' units';
      var pendingEl = document.getElementById('footer-pending');
      if (cnt > 0) {
        pendingEl.textContent = '\u25CF ' + cnt + ' unsaved change' + (cnt !== 1 ? 's' : '');
        pendingEl.hidden = false;
      } else {
        pendingEl.hidden = true;
      }
      document.getElementById('btn-save').disabled = cnt === 0;
    }

    // ─── Event handlers ───────────────────────────────────────────────────────
    function onTargetBlur(evt) {
      var el = evt.target;
      var id = el.getAttribute('data-id');
      var unit = findUnit(id);
      if (!unit) return;
      var newTarget = el.value;
      if (newTarget === unit.target) return;
      unit.target = newTarget;
      var newState = unit.state;
      if ((unit.state === 'needs-translation' || unit.state === 'new') && newTarget.trim()) {
        newState = 'translated';
        unit.state = newState;
        // Update state badge visually
        var card = el.closest('.unit-card');
        if (card) {
          var badge = card.querySelector('.state-badge');
          if (badge) { badge.className = 'state-badge state-' + newState; badge.textContent = fmtState(newState); }
          var sel = card.querySelector('.state-select');
          if (sel) sel.value = newState;
        }
      }
      pendingChanges[id] = { target: newTarget, state: newState };
      vscode.postMessage({ type: 'updateUnit', id: id, target: newTarget, state: newState });
      renderFooter();
    }

    function onStateChange(evt) {
      var el = evt.target;
      var id = el.getAttribute('data-id');
      var unit = findUnit(id);
      if (!unit) return;
      var newState = el.value;
      unit.state = newState;
      pendingChanges[id] = { target: unit.target, state: newState };
      vscode.postMessage({ type: 'updateUnit', id: id, target: unit.target, state: newState });
      renderFooter();
      var card = el.closest('.unit-card');
      if (card) {
        var badge = card.querySelector('.state-badge');
        if (badge) { badge.className = 'state-badge state-' + newState; badge.textContent = fmtState(newState); }
      }
    }

    function onTranslateSingle(evt) {
      var btn = evt.currentTarget;
      var id = btn.getAttribute('data-id');
      var source = btn.getAttribute('data-source');
      loadingSet.add(id);
      // Update UI for just this card immediately
      var card = btn.closest('.unit-card');
      if (card) {
        card.classList.add('is-loading');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Translating\u2026';
        var ta = card.querySelector('textarea');
        if (ta) ta.disabled = true;
      }
      vscode.postMessage({ type: 'translateUnit', id: id, source: source });
    }

    function autoResize() {
      this.style.height = 'auto';
      this.style.height = this.scrollHeight + 'px';
    }

    // ─── Toolbar setup ────────────────────────────────────────────────────────
    document.getElementById('search-input').addEventListener('input', function () {
      filterSearch = this.value;
      visibleCount = 80;
      renderList();
      renderFooter();
    });
    document.getElementById('state-filter').addEventListener('change', function () {
      filterState = this.value;
      visibleCount = 80;
      renderList();
      renderFooter();
    });
    document.getElementById('btn-translate-all').addEventListener('click', function () {
      vscode.postMessage({ type: 'translateAll' });
    });
    document.getElementById('btn-review-all').addEventListener('click', function () {
      vscode.postMessage({ type: 'reviewAll' });
    });
    document.getElementById('btn-open-text').addEventListener('click', function () {
      vscode.postMessage({ type: 'openAsText' });
    });
    document.getElementById('btn-save').addEventListener('click', function () {
      vscode.postMessage({ type: 'save' });
    });

    // ─── Helpers ──────────────────────────────────────────────────────────────
    function findUnit(id) {
      for (var i = 0; i < units.length; i++) {
        if (units[i].id === id) return units[i];
      }
      return null;
    }
    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
    function trunc(s, n) { return s.length > n ? s.slice(0, n) + '\u2026' : s; }
    function fmtState(s) {
      var map = {
        'new': 'New',
        'needs-translation': 'Needs Translation',
        'needs-review-translation': 'Needs Review',
        'translated': 'Translated',
        'final': 'Final',
        'signed-off': 'Signed Off'
      };
      return map[s] || s;
    }
    function stateOpts(current) {
      var states = ['new', 'needs-translation', 'needs-review-translation', 'translated', 'final', 'signed-off'];
      return states.map(function (s) {
        return '<option value="' + s + '"' + (s === current ? ' selected' : '') + '>' + fmtState(s) + '</option>';
      }).join('');
    }
    function showNotif(msg, type) {
      var el = document.getElementById('notif');
      el.textContent = msg;
      el.className = 'notif-' + type;
      el.classList.remove('hidden');
      if (notifTimer) clearTimeout(notifTimer);
      notifTimer = setTimeout(function () { el.classList.add('hidden'); }, 4500);
    }

  }());
  </script>
</body>
</html>`;
}
