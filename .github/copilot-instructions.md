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
