# Changelog

All notable changes to **Nexus Translator** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Toolbar icons for Open/Find** — the **Open in Nexus Translator** and **Find in
  Nexus Translator** editor-title actions now render as compact icons (a globe and a
  magnifying glass) instead of full-width text buttons, freeing up room in the tab bar.
  Hovering shows the full command name and its keyboard shortcut.
- **Accept quality issues** — each inconsistency in the Quality Check view now has an
  **✓ Accept all** button (accept every variant for a source) plus a per-variant
  **✓ Accept** on each translation, so you can accept just one rendering (e.g.
  `ADDRESS`) while keeping the other variants flagged for review. An inconsistency is
  only flagged while **two or more** variants remain unresolved; a genuinely new
  variant re-flags it.
- **Accepted issues review panel** — a new **✓ Accepted (N)** toolbar button opens a
  panel listing everything you've accepted. Each source shows its accepted target
  variants with a usage count, a **🔍 Show** button to inspect exactly which rows use
  that translation (and **🔍 Show all uses** for the whole source), the accept
  timestamp, and **✗ Un-accept** controls — per variant or for the whole source.
  Accepted issues are stored per-file in workspace state.

### Fixed
- **Find in Nexus Translator now applies the object filter** — running **Find in Nexus
  Translator** from an AL object file and picking a translation file now opens the editor
  pre-filtered to that object (e.g. `Table FMD VP Warehouse RC Cues`). Previously the
  filter could be silently dropped on a freshly opened file because the pending filter
  was stored under a different URI-string key than the editor read it back with. Both
  sides now agree on a path-normalised key, matching the earlier diff-filter fix.
- **"Opening…" progress while a large file loads** — opening a big translation file now
  shows a notification-area progress spinner (`Nexus: Opening <file>…`) that stays until
  the first render completes, plus a clearer in-panel hint that large files can take a
  few seconds. Previously the panel looked frozen while tens of thousands of units were
  parsed on the extension host.
- **"Edit N changed unit in Nexus Translator" now opens filtered** — clicking the button
  in the diff view reliably opens the editor showing only the changed units. Previously,
  when the editor was freshly opened (or still loading a large file), the filter message
  could be dropped because the panel was registered before its webview finished loading,
  or lost to a URI-key mismatch on Windows. The editor now waits for the webview's
  `ready` signal before pushing a live filter, and falls back to a path-normalised
  hand-off during init otherwise.
- **Umlauts corrupted after publishing to Business Central** — translation files are now
  always written as **UTF-8 with a byte-order mark (BOM)** on save, import, and export.
  Without a BOM, BC's AL compiler decoded the (valid UTF-8) file using the machine's OEM
  code page, turning German umlauts into mojibake such as `Für` → `F├╝r`,
  `Ländercode` → `L├ñndercode`, and `Überschreiben` → `├£berschreiben`. The BOM forces
  correct UTF-8 detection; diff baselines strip the BOM so it never shows as a phantom change.
- **AI + Context "Message exceeds token limit"** — the Copilot provider now measures
  each request against the model's own input token limit (`countTokens` /
  `maxInputTokens`) and automatically splits a batch into token-sized sub-requests.
  Context-mode translation/review (which adds BC metadata + AL source snippets per
  unit) no longer fails when a 50-unit batch is too large; it transparently sends more,
  smaller sub-requests instead.

### Changed
- **Object filter bar is now scrollable and collapsible** — running **Find in Nexus
  Translator** on a folder can produce dozens of object filters. The filter chip bar is
  now capped in height (scrolls internally) instead of pushing the translation list off
  screen, and a **Filter (N)** toggle lets you collapse the chips entirely while keeping
  the filter active.
- **Smoother scrolling on large files** — the editor list now renders incrementally
  and **auto-loads** the next batch as you scroll (via an on-screen sentinel) instead
  of only when you click *Load more*. Newly loaded rows are appended without
  re-rendering the ones already on screen, so paging through a 19k-unit file no longer
  gets slower the further you scroll. *Load more* remains as a manual fallback.
- **Faster search on large files** — the in-editor search box is now debounced and
  reuses cached lowercased fields, so filtering files with tens of thousands of units
  (e.g. 19k+) no longer stutters on every keystroke.
- **Exact-match search** — a new **Exact** checkbox next to the search box filters to
  entries whose field *equals* the search text (case-insensitive) instead of merely
  containing it. Searching `both` with Exact on now matches only "Both", not
  "…E-Document file only, or both."
- **Lazy activation** — the extension no longer activates on every VS Code startup.
  It now activates only when a workspace contains `.xlf` files, or when a Nexus
  command or the translation editor is used, so it adds zero startup cost to
  unrelated projects.

## [0.2.0] - 2026-06-22

### Added
- **Status bar item** showing the active `.xlf` file's translation progress and target
  language; click it to open the file in the Nexus editor.
- **Keyboard shortcuts** for the most common commands (open in Nexus, show changes,
  find in Nexus, export/import for review).
- **Cancellable progress** for in-editor bulk AI translate and review — long runs now
  show a native progress notification with a Cancel button.
- **Diagnostics output channel** (`Nexus Translator`) for surfacing errors and
  background operation details.
- **Unit tests** for the XLIFF parser/serializer (round-trip, placeholder and state
  preservation, XML escaping) and the Translation Memory similarity scoring. Run with
  `pnpm test`.

### Changed
- Translation Memory and Glossary writes are now serialized and written atomically
  (temp file + rename) to avoid corrupting `.nexus/tm.json` / `.nexus/glossary.json`
  when multiple windows or the MCP server write concurrently.
- Extracted the fuzzy-matching helpers into `src/similarity.ts` (no VS Code API
  dependency) so they can be unit-tested in isolation.

## [0.1.0] - 2026-06-21

### Added
- **Visual XLIFF editor** — table view for `.xlf` files with inline editing, search,
  and filtering by state, object type, and object name.
- **AI translation** via GitHub Copilot, GitHub Models, OpenAI, or Azure OpenAI, with
  single-unit, translate-all, and bulk-selection actions.
- **AI + Context** and **Review + Context** — context-aware translate/review using each
  unit's Business Central object/property metadata, AL source snippets, and approved TM
  references for higher quality on ambiguous strings.
- **AI quality review** with per-unit error/warning results.
- **Translation Memory** with fuzzy matching, auto-population on save, and per-unit
  suggestion pills.
- **Glossary** management to keep terminology consistent across translations.
- **Find in Nexus** — jump from an AL label/caption to its translation unit, and a
  folder filter to scope the editor to a folder's AL objects.
- **Go to Source** — jump from a translation unit back to the AL definition, with an
  `openNavigationIn` setting (same window vs split).
- **Translation diff** against git HEAD, plus an "Open standard XML diff" toggle for the
  classic working-tree text diff.
- **Excel review round-trip** — export translations (filtered or all) to `.xlsx` for
  customer review and import the reviewed file back, highlighting changed units.
- **Change highlighting** for the units touched by the last AI run or import.
- **MCP server integration** — manage glossary/TM and analyze translations from Copilot
  Chat.

[Unreleased]: https://github.com/AlexanderErdelyi/nexus-hive-desk/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/AlexanderErdelyi/nexus-hive-desk/releases/tag/v0.1.0
