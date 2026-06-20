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
      font-family: var(--vscode-font-family, -apple-system, sans-serif);
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
      padding: 10px 16px 8px;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
      flex-shrink: 0;
    }
    .hdr-top { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
    #hdr-file { font-size: 14px; font-weight: 600; }
    #hdr-langs { font-size: 12px; color: var(--vscode-descriptionForeground); }
    #hdr-needs {
      font-size: 11px; color: #dcdcaa;
      background: rgba(220,220,170,0.12);
      padding: 1px 7px; border-radius: 10px;
    }
    .hdr-progress { display: flex; align-items: center; gap: 8px; }
    #hdr-bar {
      flex: 1; height: 5px;
      background: var(--vscode-progressBar-background, rgba(128,128,128,0.2));
      border-radius: 3px; overflow: hidden;
    }
    #hdr-fill {
      height: 100%;
      background: var(--vscode-button-background, #0078d4);
      border-radius: 3px; transition: width 0.4s ease;
    }
    #hdr-pct { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; min-width: 80px; text-align: right; }

    /* ─── Toolbar ─── */
    #toolbar {
      display: flex; align-items: center; gap: 6px;
      padding: 5px 16px;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
      flex-shrink: 0; flex-wrap: wrap;
    }
    .toolbar-search {
      flex: 1; min-width: 150px; max-width: 280px;
      height: 26px; padding: 3px 8px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
      color: var(--vscode-input-foreground);
      border-radius: 3px; font-size: 12px; font-family: inherit;
    }
    .toolbar-search:focus { outline: 1px solid var(--vscode-focusBorder); border-color: var(--vscode-focusBorder); }
    .toolbar-select {
      height: 26px; padding: 2px 6px;
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border, rgba(128,128,128,0.3));
      color: var(--vscode-dropdown-foreground);
      border-radius: 3px; font-size: 12px; font-family: inherit;
    }
    .tb-spacer { flex: 1; }
    button {
      height: 26px; padding: 0 10px; border: none; border-radius: 3px;
      cursor: pointer; font-size: 12px; font-family: inherit;
      display: inline-flex; align-items: center; gap: 5px; white-space: nowrap;
    }
    .btn-primary   { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .btn-primary:hover:not(:disabled)    { background: var(--vscode-button-hoverBackground); }
    .btn-secondary { background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2)); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border: 1px solid rgba(128,128,128,0.3); }
    .btn-secondary:hover:not(:disabled)  { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.3)); }
    .btn-ghost     { background: transparent; color: var(--vscode-descriptionForeground); border: 1px solid transparent; font-size: 11px; }
    .btn-ghost:hover:not(:disabled)      { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
    button:disabled { opacity: 0.45; cursor: default; }

    /* ─── Column headers ─── */
    #col-headers {
      display: grid;
      grid-template-columns: 180px 1fr 1.5fr 145px;
      padding: 3px 0;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
      flex-shrink: 0;
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    }
    .col-hdr {
      padding: 3px 10px;
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.06em; color: var(--vscode-descriptionForeground);
    }

    /* ─── Unit list ─── */
    #unit-list { flex: 1; overflow-y: auto; }

    /* ─── Unit row ─── */
    .unit-row {
      display: grid;
      grid-template-columns: 180px 1fr 1.5fr 145px;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.08));
      min-height: 56px;
      transition: background 0.1s;
    }
    .unit-row:hover  { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.06)); }
    .unit-row.has-pending { border-left: 3px solid var(--vscode-button-background, #0078d4); }
    .unit-row.is-loading  { opacity: 0.65; }

    /* ─── Context column ─── */
    .col-ctx {
      padding: 8px 8px 8px 14px;
      display: flex; flex-direction: column; gap: 3px;
      border-right: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.08));
      min-width: 0; overflow: hidden;
    }
    .obj-badge {
      display: inline-block; font-size: 10px; font-weight: 700;
      padding: 1px 5px; border-radius: 3px;
      text-transform: uppercase; letter-spacing: 0.04em; width: fit-content;
    }
    .badge-table      { background: rgba(86,156,214,0.18);  color: #569cd6; }
    .badge-page       { background: rgba(78,201,176,0.18);  color: #4ec9b0; }
    .badge-codeunit   { background: rgba(197,134,192,0.18); color: #c586c0; }
    .badge-report     { background: rgba(206,145,120,0.18); color: #ce9178; }
    .badge-query      { background: rgba(156,220,254,0.18); color: #9cdcfe; }
    .badge-enum       { background: rgba(220,220,170,0.18); color: #dcdcaa; }
    .badge-other      { background: rgba(128,128,128,0.18); color: var(--vscode-descriptionForeground); }
    .obj-name {
      font-size: 12px; font-weight: 500;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .obj-prop {
      font-size: 10px; color: var(--vscode-descriptionForeground);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-style: italic;
    }
    .btn-go-src {
      display: none; border: none; background: transparent;
      color: var(--vscode-textLink-foreground); font-size: 10px;
      padding: 0; cursor: pointer; height: auto; text-align: left;
      font-family: inherit;
    }
    .unit-row:hover .btn-go-src { display: inline; }
    .btn-go-src:hover { text-decoration: underline; }

    /* ─── Source column ─── */
    .col-src {
      padding: 8px 10px;
      display: flex; flex-direction: column; gap: 4px;
      border-right: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.08));
      min-width: 0;
    }
    .src-text { font-size: 12px; line-height: 1.45; word-break: break-word; }
    .dev-note {
      font-size: 10px; color: var(--vscode-descriptionForeground);
      border-left: 2px solid var(--vscode-button-background, #0078d4);
      padding-left: 5px;
    }
    .conf-pill {
      font-size: 10px; padding: 1px 5px; border-radius: 10px; width: fit-content;
    }
    .conf-high   { background: rgba(78,201,176,0.15); color: #4ec9b0; }
    .conf-medium { background: rgba(220,220,170,0.15); color: #dcdcaa; }
    .conf-low    { background: rgba(206,145,120,0.15); color: #ce9178; }

    /* ─── Target column ─── */
    .col-tgt {
      padding: 6px 8px;
      display: flex; flex-direction: column; gap: 4px;
      border-right: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.08));
      min-width: 0;
    }
    .target-input {
      width: 100%; min-height: 38px;
      background: transparent;
      border: 1px solid transparent;
      color: var(--vscode-foreground);
      font-family: inherit; font-size: 12px;
      padding: 4px 6px; resize: none; border-radius: 2px;
      line-height: 1.45; overflow: hidden;
      transition: border-color 0.12s, background 0.12s;
    }
    .target-input:hover  { border-color: var(--vscode-input-border, rgba(128,128,128,0.4)); background: var(--vscode-input-background); }
    .target-input:focus  { outline: none; border-color: var(--vscode-focusBorder); background: var(--vscode-input-background); }
    .target-input:disabled { opacity: 0.5; }

    /* review overlay */
    .rv-box {
      font-size: 10px; padding: 3px 6px; border-radius: 2px;
      display: flex; flex-direction: column; gap: 1px;
    }
    .rv-error   { background: rgba(244,135,113,0.12); border-left: 2px solid #f48771; }
    .rv-warning { background: rgba(220,220,170,0.12); border-left: 2px solid #dcdcaa; }
    .rv-good    { background: rgba(78,201,176,0.12);  border-left: 2px solid #4ec9b0; }
    .rv-reason  { color: var(--vscode-foreground); }
    .rv-suggest { color: var(--vscode-textLink-foreground); font-style: italic; }

    /* ─── State column ─── */
    .col-state {
      padding: 8px 8px; display: flex; flex-direction: column; gap: 5px;
      min-width: 0;
    }
    .state-select {
      width: 100%; height: 24px; padding: 2px 4px;
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border, rgba(128,128,128,0.3));
      color: var(--vscode-dropdown-foreground);
      border-radius: 3px; font-size: 11px; font-family: inherit; cursor: pointer;
    }
    .btn-ai-row {
      background: transparent;
      border: 1px solid var(--vscode-button-border, rgba(128,128,128,0.35));
      color: var(--vscode-foreground);
      font-size: 10px; padding: 2px 6px; height: auto; border-radius: 3px;
      cursor: pointer; font-family: inherit;
      display: flex; align-items: center; gap: 3px;
    }
    .btn-ai-row:hover:not(:disabled) {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: transparent;
    }

    /* ─── Spinner ─── */
    .spinner {
      display: inline-block; width: 11px; height: 11px;
      border: 2px solid transparent; border-top-color: currentColor;
      border-radius: 50%; animation: spin 0.7s linear infinite; vertical-align: middle;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ─── Footer ─── */
    #footer {
      display: flex; align-items: center; gap: 10px; padding: 5px 16px;
      border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
      flex-shrink: 0; font-size: 11px;
    }
    #footer-shown   { color: var(--vscode-descriptionForeground); }
    #footer-pending { color: #dcdcaa; }
    .ft-spacer { flex: 1; }

    /* ─── Load more ─── */
    .load-more-wrap { display: flex; justify-content: center; padding: 12px; }

    /* ─── Empty / notification ─── */
    .empty-state {
      display: flex; align-items: center; justify-content: center;
      padding: 48px; color: var(--vscode-descriptionForeground); font-size: 13px;
    }
    #notif {
      position: fixed; bottom: 44px; right: 14px;
      padding: 6px 12px; border-radius: 4px; font-size: 12px; z-index: 999;
    }
    #notif.hidden { display: none; }
    .notif-success { background: rgba(78,201,176,0.15); border: 1px solid #4ec9b0; color: #4ec9b0; }
    .notif-error   { background: rgba(244,135,113,0.15); border: 1px solid #f48771; color: #f48771; }
  </style>
</head>
<body>

<!-- Header -->
<div id="header">
  <div class="hdr-top">
    <span id="hdr-file">Translation Editor</span>
    <span id="hdr-langs"></span>
    <span id="hdr-needs" hidden></span>
  </div>
  <div class="hdr-progress">
    <div id="hdr-bar"><div id="hdr-fill" style="width:0%"></div></div>
    <span id="hdr-pct">0/0</span>
  </div>
</div>

<!-- Toolbar -->
<div id="toolbar">
  <input id="search-input" class="toolbar-search" type="search" placeholder="&#128269;  Search source, target or ID&hellip;" autocomplete="off">
  <select id="state-filter" class="toolbar-select">
    <option value="all">All States</option>
    <option value="new">New</option>
    <option value="needs-translation">Needs Translation</option>
    <option value="needs-review-translation">Needs Review</option>
    <option value="translated">Translated</option>
    <option value="final">Final</option>
    <option value="signed-off">Signed Off</option>
  </select>
  <div class="tb-spacer"></div>
  <button id="btn-translate-all" class="btn-primary" title="AI-translate all untranslated units">&#9889; Translate Untranslated</button>
  <button id="btn-review-all" class="btn-secondary" title="AI review all translated units">&#128269; Review</button>
  <button id="btn-open-text" class="btn-ghost" title="Open raw XML in the text editor">&#128196; Raw XML</button>
</div>

<!-- Column headers -->
<div id="col-headers">
  <div class="col-hdr">Context</div>
  <div class="col-hdr">Source</div>
  <div class="col-hdr">Target</div>
  <div class="col-hdr">State</div>
</div>

<!-- Unit list -->
<div id="unit-list">
  <div class="empty-state"><span class="spinner"></span>&nbsp; Loading translations&hellip;</div>
</div>

<!-- Footer -->
<div id="footer">
  <span id="footer-shown">0 units</span>
  <span id="footer-pending" hidden></span>
  <span class="ft-spacer"></span>
  <button id="btn-save" class="btn-primary" disabled>&#128190; Save</button>
</div>

<!-- Notification -->
<div id="notif" class="hidden"></div>

<script nonce="${nonce}">
(function () {
  'use strict';
  var vscode = acquireVsCodeApi();

  // ─── State ─────────────────────────────────────────────────────────────────
  var units = [], srcLang = '', tgtLang = '', fileName = '';
  var filterSearch = '', filterState = 'all';
  var pendingChanges = {}, reviewMap = {}, loadingSet = new Set();
  var visibleCount = 100, notifTimer = null;

  // ─── Message handler ───────────────────────────────────────────────────────
  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || !msg.type) return;

    if (msg.type === 'init') {
      units = msg.units || [];
      srcLang = msg.sourceLanguage || '';
      tgtLang = msg.targetLanguage || '';
      fileName = msg.fileName || '';
      pendingChanges = {}; reviewMap = {}; loadingSet = new Set(); visibleCount = 100;
      if (msg.initialFilter) {
        filterSearch = msg.initialFilter;
        document.getElementById('search-input').value = filterSearch;
      }
      renderAll();

    } else if (msg.type === 'setFilter') {
      filterSearch = msg.filter || '';
      filterState  = msg.state  || 'all';
      document.getElementById('search-input').value  = filterSearch;
      document.getElementById('state-filter').value  = filterState;
      visibleCount = 100;
      renderList(); renderFooter();

    } else if (msg.type === 'translating') {
      (msg.ids || []).forEach(function (id) { loadingSet.add(id); });
      renderList();

    } else if (msg.type === 'translationResults') {
      (msg.results || []).forEach(function (r) {
        loadingSet.delete(r.id);
        var u = findUnit(r.id);
        if (u) { u.target = r.translatedText; u.state = 'translated'; if (r.confidenceScore != null) u.confidenceScore = r.confidenceScore; }
        pendingChanges[r.id] = { target: r.translatedText, state: 'translated' };
      });
      renderAll();
      showNotif('Translated ' + msg.results.length + ' unit(s).', 'success');

    } else if (msg.type === 'reviewing') {
      (msg.ids || []).forEach(function (id) { loadingSet.add(id); });
      renderList();

    } else if (msg.type === 'reviewResults') {
      loadingSet.clear();
      (msg.results || []).forEach(function (r) { reviewMap[r.id] = r; });
      renderList();
      var errs = (msg.results || []).filter(function (r) { return r.quality === 'error'; }).length;
      var warns = (msg.results || []).filter(function (r) { return r.quality === 'warning'; }).length;
      showNotif('Review done \u2014 ' + errs + ' errors, ' + warns + ' warnings.', errs > 0 ? 'error' : 'success');

    } else if (msg.type === 'error') {
      loadingSet.clear(); renderList();
      showNotif(msg.message, 'error');

    } else if (msg.type === 'saved') {
      pendingChanges = {}; renderFooter();
      showNotif('Saved.', 'success');
    }
  });

  // ─── Render ────────────────────────────────────────────────────────────────
  function renderAll() { renderHeader(); renderList(); renderFooter(); }

  function getStats() {
    var total = units.length, translated = 0, needsTrans = 0;
    units.forEach(function (u) {
      if (u.state === 'translated' || u.state === 'final' || u.state === 'signed-off') translated++;
      if (!u.target || u.state === 'new' || u.state === 'needs-translation') needsTrans++;
    });
    return { total: total, translated: translated, needsTrans: needsTrans, pct: total > 0 ? Math.round(translated / total * 100) : 0 };
  }

  function getFiltered() {
    var q = filterSearch.toLowerCase();
    return units.filter(function (u) {
      if (filterState !== 'all' && u.state !== filterState) return false;
      if (!q) return true;
      return u.source.toLowerCase().indexOf(q) >= 0 ||
             u.target.toLowerCase().indexOf(q) >= 0 ||
             u.id.toLowerCase().indexOf(q) >= 0 ||
             (u.note  && u.note.toLowerCase().indexOf(q) >= 0);
    });
  }

  function renderHeader() {
    var s = getStats();
    document.getElementById('hdr-file').textContent  = fileName || 'Translation Editor';
    document.getElementById('hdr-langs').textContent = srcLang && tgtLang ? srcLang + ' \u2192 ' + tgtLang : '';
    var needsEl = document.getElementById('hdr-needs');
    if (s.needsTrans > 0) { needsEl.textContent = s.needsTrans + ' to translate'; needsEl.hidden = false; }
    else { needsEl.hidden = true; }
    document.getElementById('hdr-fill').style.width = s.pct + '%';
    document.getElementById('hdr-pct').textContent  = s.translated + '/' + s.total + ' (' + s.pct + '%)';
  }

  function renderList() {
    var filtered = getFiltered();
    var visible  = filtered.slice(0, visibleCount);
    var el = document.getElementById('unit-list');
    if (filtered.length === 0) {
      el.innerHTML = '<div class="empty-state">No units match the current filter.</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < visible.length; i++) html += renderRow(visible[i]);
    if (filtered.length > visibleCount) {
      html += '<div class="load-more-wrap"><button class="btn-secondary" id="btn-load-more">Load more (' + (filtered.length - visibleCount) + ' remaining)</button></div>';
    }
    el.innerHTML = html;

    el.querySelectorAll('textarea.target-input').forEach(function (ta) {
      ta.addEventListener('input', autoResize);
      ta.addEventListener('blur',  onTargetBlur);
      autoResize.call(ta);
    });
    el.querySelectorAll('.state-select').forEach(function (sel) { sel.addEventListener('change', onStateChange); });
    el.querySelectorAll('.btn-ai-row').forEach(function (btn) { btn.addEventListener('click', onTranslateSingle); });
    el.querySelectorAll('.btn-go-src').forEach(function (btn) {
      btn.addEventListener('click', function () {
        vscode.postMessage({ type: 'goToSource', id: this.getAttribute('data-id') });
      });
    });
    var btnMore = document.getElementById('btn-load-more');
    if (btnMore) btnMore.addEventListener('click', function () { visibleCount += 100; renderList(); });
  }

  function renderFooter() {
    var cnt = Object.keys(pendingChanges).length;
    var filtered = getFiltered();
    document.getElementById('footer-shown').textContent = filtered.length + ' of ' + units.length + ' units';
    var pEl = document.getElementById('footer-pending');
    if (cnt > 0) { pEl.textContent = '\u25cf ' + cnt + ' unsaved change' + (cnt !== 1 ? 's' : ''); pEl.hidden = false; }
    else { pEl.hidden = true; }
    document.getElementById('btn-save').disabled = cnt === 0;
  }

  // ─── Context parser ────────────────────────────────────────────────────────
  // BC XLIFF Xliff-Generator note format (human-readable):
  //   "Table NobilisTable - Property Caption"
  //   "Codeunit PIM Export - NamedType FileSuffixLbl"
  //   "Table NobilisTable - Method UpdateAuth - NamedType 2266612977"
  // Fallback: unit ID (numeric IDs)
  function parseContext(unit) {
    var source = unit.note || unit.id;
    var parts  = source.split(' - ');
    var m = parts[0].match(/^(Page|Table|Codeunit|Report|Query|XmlPort|Enum|Interface|PermissionSet)\s+(.+)/i);
    if (!m) return { type: 'other', name: trunc(source, 40), prop: '' };

    var type = m[1];
    var name = m[2].trim();

    // Build a readable property label from remaining segments
    var rest = parts.slice(1).map(function (p) {
      return p.replace(/^(Property|NamedType|Control|Action|Field|Method)\s*/i, '').trim();
    }).filter(Boolean);
    var prop = rest.join(' \u203a ');  // " › "

    return { type: type, name: name, prop: prop };
  }

  function badgeClass(type) {
    switch ((type || '').toLowerCase()) {
      case 'table':       return 'badge-table';
      case 'page':        return 'badge-page';
      case 'codeunit':    return 'badge-codeunit';
      case 'report':      return 'badge-report';
      case 'query':       return 'badge-query';
      case 'enum': case 'interface': case 'permissionset': return 'badge-enum';
      default:            return 'badge-other';
    }
  }

  // ─── Row renderer ──────────────────────────────────────────────────────────
  function renderRow(unit) {
    var ctx       = parseContext(unit);
    var hasPend   = !!pendingChanges[unit.id];
    var isLoading = loadingSet.has(unit.id);
    var review    = reviewMap[unit.id];
    var rowClass  = 'unit-row' + (hasPend ? ' has-pending' : '') + (isLoading ? ' is-loading' : '');

    // ── Context cell ──────────────────────────────────────────────────────────
    var ctxHtml =
      '<div class="col-ctx">' +
        '<span class="obj-badge ' + badgeClass(ctx.type) + '">' + esc(ctx.type) + '</span>' +
        '<div class="obj-name" title="' + esc(unit.note || unit.id) + '">' + esc(trunc(ctx.name, 36)) + '</div>' +
        (ctx.prop ? '<div class="obj-prop">' + esc(trunc(ctx.prop, 40)) + '</div>' : '') +
        '<button class="btn-go-src" data-id="' + esc(unit.id) + '" title="Go to AL source">&#10548; Go to Source</button>' +
      '</div>';

    // ── Source cell ───────────────────────────────────────────────────────────
    var confHtml = '';
    if (unit.confidenceScore != null) {
      var t = unit.confidenceScore >= 90 ? 'high' : unit.confidenceScore >= 70 ? 'medium' : 'low';
      confHtml = '<span class="conf-pill conf-' + t + '">' + unit.confidenceScore + '%</span>';
    }
    var srcHtml =
      '<div class="col-src">' +
        '<div class="src-text">' + esc(unit.source) + '</div>' +
        (unit.developerNote ? '<div class="dev-note">' + esc(unit.developerNote) + '</div>' : '') +
        confHtml +
      '</div>';

    // ── Target cell ───────────────────────────────────────────────────────────
    var rvHtml = '';
    if (review) {
      rvHtml = '<div class="rv-box rv-' + esc(review.quality) + '">' +
        (review.reason    ? '<div class="rv-reason">'  + esc(review.reason)    + '</div>' : '') +
        (review.suggestion? '<div class="rv-suggest">\u2192 ' + esc(review.suggestion) + '</div>' : '') +
        '</div>';
    }
    var tgtHtml =
      '<div class="col-tgt">' +
        '<textarea class="target-input" data-id="' + esc(unit.id) + '" rows="2"' + (isLoading ? ' disabled' : '') + '>' + esc(unit.target) + '</textarea>' +
        rvHtml +
      '</div>';

    // ── State cell ────────────────────────────────────────────────────────────
    var aiBtn = isLoading
      ? '<button class="btn-ai-row btn-ai-single" data-id="' + esc(unit.id) + '" data-source="' + esc(unit.source) + '" disabled><span class="spinner"></span></button>'
      : '<button class="btn-ai-row btn-ai-single" data-id="' + esc(unit.id) + '" data-source="' + esc(unit.source) + '">\u27F3 AI</button>';
    var stateHtml =
      '<div class="col-state">' +
        '<select class="state-select" data-id="' + esc(unit.id) + '">' + stateOpts(unit.state) + '</select>' +
        aiBtn +
      '</div>';

    return '<div class="' + rowClass + '" data-id="' + esc(unit.id) + '">' +
      ctxHtml + srcHtml + tgtHtml + stateHtml +
      '</div>';
  }

  // ─── Event handlers ────────────────────────────────────────────────────────
  function autoResize() { this.style.height = 'auto'; this.style.height = (this.scrollHeight) + 'px'; }
  function findUnit(id) { return units.find(function (u) { return u.id === id; }); }

  function onTargetBlur(evt) {
    var el = evt.target, id = el.getAttribute('data-id');
    var unit = findUnit(id);
    if (!unit || el.value === unit.target) return;
    unit.target = el.value;
    var newState = unit.state;
    if ((unit.state === 'needs-translation' || unit.state === 'new') && el.value.trim()) {
      newState = 'translated'; unit.state = newState;
      var sel = el.closest('.unit-row').querySelector('.state-select');
      if (sel) sel.value = newState;
    }
    pendingChanges[id] = { target: el.value, state: newState };
    el.closest('.unit-row').classList.add('has-pending');
    vscode.postMessage({ type: 'updateUnit', id: id, target: el.value, state: newState });
    renderFooter();
  }

  function onStateChange(evt) {
    var el = evt.target, id = el.getAttribute('data-id');
    var unit = findUnit(id);
    if (!unit) return;
    unit.state = el.value;
    pendingChanges[id] = { target: unit.target, state: unit.state };
    el.closest('.unit-row').classList.add('has-pending');
    vscode.postMessage({ type: 'updateUnit', id: id, target: unit.target, state: unit.state });
    renderFooter();
  }

  function onTranslateSingle(evt) {
    var btn = evt.currentTarget;
    vscode.postMessage({ type: 'translateUnit', id: btn.getAttribute('data-id'), source: btn.getAttribute('data-source') });
  }

  // ─── Toolbar ───────────────────────────────────────────────────────────────
  document.getElementById('search-input').addEventListener('input', function () {
    filterSearch = this.value; visibleCount = 100; renderList(); renderFooter();
  });
  document.getElementById('state-filter').addEventListener('change', function () {
    filterState = this.value; visibleCount = 100; renderList(); renderFooter();
  });
  document.getElementById('btn-translate-all').addEventListener('click', function () { vscode.postMessage({ type: 'translateAll' }); });
  document.getElementById('btn-review-all').addEventListener('click',    function () { vscode.postMessage({ type: 'reviewAll' }); });
  document.getElementById('btn-open-text').addEventListener('click',     function () { vscode.postMessage({ type: 'openAsText' }); });
  document.getElementById('btn-save').addEventListener('click',          function () { vscode.postMessage({ type: 'save' }); });

  // ─── Helpers ───────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function trunc(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '\u2026' : s; }

  function stateOpts(cur) {
    var opts = [
      ['new','New'], ['needs-translation','Needs Translation'],
      ['needs-review-translation','Needs Review'], ['translated','Translated'],
      ['final','Final'], ['signed-off','Signed Off'],
    ];
    return opts.map(function (o) {
      return '<option value="' + o[0] + '"' + (o[0] === cur ? ' selected' : '') + '>' + o[1] + '</option>';
    }).join('');
  }

  function showNotif(msg, type) {
    var el = document.getElementById('notif');
    el.textContent = msg; el.className = 'notif-' + type; el.classList.remove('hidden');
    if (notifTimer) clearTimeout(notifTimer);
    notifTimer = setTimeout(function () { el.classList.add('hidden'); }, 4500);
  }

  // ─── Boot ──────────────────────────────────────────────────────────────────
  vscode.postMessage({ type: 'ready' });
}());
</script>
</body>
</html>`;
}
