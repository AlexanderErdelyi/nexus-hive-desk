# Nexus Hive Desk — Copilot Instructions

This is a Business Central AL translation management monorepo. When helping with translation-related tasks, use the **Nexus Translator** MCP tools (server: `nexus-translator`) rather than reading/writing XLIFF files manually.

## Key MCP tools available

- `get_new_units(filePath)` — get units added/changed since git HEAD (use after AL Sync Translation)
- `write_translations(filePath, [{id, target, state}])` — write translations back to XLIFF
- `set_unit_states(filePath, unitIds, state)` — bulk set translation state
- `get_translation_progress()` — overall % translated stats
- `validate_placeholders(filePath)` — find missing %1/%2 placeholders (BC runtime bug risk)
- `find_inconsistencies(filePath)` — same source translated differently
- `get_glossary` / `add_glossary_term` — manage terminology
- `search_tm` / `populate_tm_from_xliff` — Translation Memory

## Documentation generation (fast caption lookup)

When generating customer documentation in a target language (e.g. German), do **not** scan the whole `.xlf` or rely on Translation Memory (the same source can be translated differently per object). Use the caption index instead — it is exact, location-aware, and token-cheap:

- `get_object_translations(objectType, objectName, language)` — get the translated Caption/ToolTip of an object and ALL its fields/controls/actions in one call. The primary tool for docs. Falls back to source text with `translated:false` when an element isn't translated yet.
- `lookup_translation({objectType, objectName, elementKind?, elementName?, property?} | {note}, language)` — resolve a single element property (one field caption, one control tooltip). Accepts a raw BC "Xliff Generator" note string too.
- `build_caption_index(force?)` — (re)build `.nexus/caption-index.json`. Usually unnecessary: lookups auto-rebuild when `.xlf` files change.

## For the full agentic translation workflow

Switch to **Nexus Translator** chat mode (dropdown in the chat input) for step-by-step guided translation with review and approval before writing to files.

## Project structure

- `apps/vscode-extension/` — VS Code extension (XLIFF editor, diff view, find-in-nexus)
- `apps/mcp-server/` — MCP server exposing translation tools to Copilot Chat
- `apps/api/` — Web API (translation memory, AI translation endpoints)
- `apps/web/` — Next.js web application
- `packages/xliff/` — Shared XLIFF parser
- `packages/ai/` — Shared AI translation provider
- `packages/types/` — Shared TypeScript types
