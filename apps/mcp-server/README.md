# Nexus Translator MCP Server

Stdio MCP server that exposes Nexus Translation Memory and Glossary tools to Copilot Chat and other MCP-compatible clients.

## Setup

The server is automatically configured in `.vscode/mcp.json` when you install the Nexus Translator VS Code extension. No manual setup needed.

## Building

```sh
cd apps/mcp-server
npm install
npm run build
```

## Tools

See the [VS Code extension README](../vscode-extension/README.md#mcp-server) for full documentation.

### Documentation generation

For generating customer documentation in a target language, use the caption-index tools instead of scanning the raw `.xlf` or Translation Memory:

- `get_object_translations(objectType, objectName, language)` — one call returns the Caption/ToolTip of an object and all its fields/controls/actions. Exact, location-aware, and token-cheap. Falls back to source text with `translated:false` when untranslated.
- `lookup_translation(...)` — resolve a single element property by explicit path or by a raw BC "Xliff Generator" note.
- `build_caption_index(force?)` — (re)build `.nexus/caption-index.json`. Lookups auto-rebuild when `.xlf` files change, so this is rarely needed.

### Sync (NAB-style refresh)

After the AL compiler regenerates `<App>.g.xlf`, propagate new/changed captions into the language files:

- `list_translation_targets(generatedFile?)` — discover `<App>.g.xlf` base files and their sibling `<App>.<lang>.xlf` language files.
- `sync_translation_file(generatedFile, {languages?|targetFiles?, removeOrphans?, canonicalOrder?, prefillFromTm?, dryRun?})` — sync a generated base file into language files. **Add-only by default** (never deletes → merge-friendly and preserves custom base-app overrides). Adds new units, flags source-changed units as `needs-review-translation`, and prefills brand-new units from exact Translation-Memory matches. Units carrying a `<note from="NexusCustom">` are pinned and kept even when `removeOrphans: true`. Pass `dryRun: true` to preview the summary without writing.

## Storage

Reads/writes `.nexus/tm.json`, `.nexus/glossary.json`, and `.nexus/caption-index.json` relative to `NEXUS_WORKSPACE` (set in `.vscode/mcp.json`). The TM and glossary files are shared with the VS Code extension; the caption index is a derived cache (gitignored) rebuilt automatically from the workspace `.xlf` files.
