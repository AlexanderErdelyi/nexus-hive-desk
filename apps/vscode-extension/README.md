# Nexus Translator

<p align="center">
  <img src="images/icon.png" width="96" alt="Nexus Translator logo" />
</p>

<p align="center">
  <strong>AI-powered XLIFF translation editor for Business Central AL development — right inside VS Code.</strong>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#getting-started">Getting Started</a> •
  <a href="#translation-editor">Translation Editor</a> •
  <a href="#ai-translation">AI Translation</a> •
  <a href="#export--import-for-review-excel">Excel Review</a> •
  <a href="#translation-memory">Translation Memory</a> •
  <a href="#glossary">Glossary</a> •
  <a href="#mcp-server">MCP Server</a> •
  <a href="#commands">Commands</a>
</p>

---

## Features

| | |
|---|---|
| 🗂 **Visual XLIFF Editor** | Rich table view for `.xlf` files — filter, search, edit inline |
| ⚡ **AI Translation** | Translate with GitHub Copilot, OpenAI, or any API-compatible provider |
| 🧠 **AI + Context** | Context-aware translate & review using each unit's BC object/property + AL source |
| 💾 **Translation Memory** | Local TM with fuzzy matching — reuse past translations automatically |
| 📖 **Glossary** | Manage term pairs to keep terminology consistent across all translations |
| 🔍 **Find in Nexus** | Right-click any AL label in source code to jump to its translation |
| 📂 **Folder Filter** | Right-click a folder to open the editor pre-filtered to its AL objects |
| 🔀 **Translation Diff** | Compare current XLIFF against git HEAD — or toggle the raw XML working-tree diff |
| 📤 **Excel Review Round-trip** | Export (filtered or all) to `.xlsx` for customers, then import their updates |
| 🤖 **MCP Server** | Ask Copilot Chat to suggest glossary terms, populate TM, or analyze translations |
| ✅ **Bulk Actions** | Select multiple rows → AI translate, apply TM, or set status in one click |
| ✨ **Change Highlighting** | Units touched by the last AI run or import are highlighted and focusable |

---

## Getting Started

### Installation

1. Download `nexus-translator-x.x.x.vsix` from the [releases page](../../releases)
2. In VS Code: **Extensions** → `···` → **Install from VSIX…**
3. Reload the window

### Opening a translation file

`.xlf` files open as raw XML by default (so your existing git diffs are unaffected).

To open in Nexus Translator:
- **Right-click** an `.xlf` file → **Open in Nexus Translator**
- Or: open the file, then click the **Nexus** button in the editor title bar

To make Nexus Translator the default editor for `.xlf`:
- Run **Nexus: Use Nexus as Default .xlf Editor** from the Command Palette

### Setting up AI translation

Nexus Translator supports multiple AI providers:

| Provider | How to configure |
|---|---|
| **GitHub Copilot** | No token needed — uses your existing Copilot session |
| **OpenAI / Azure OpenAI** | Run **Nexus: Set API Token (Secure)**, paste your key |
| **Ollama (local)** | Set `nexus.translator.baseUrl` to `http://localhost:11434/v1` |

---

## Translation Editor

The editor provides a table view of all translation units with inline editing.

### Toolbar

| Control | Description |
|---|---|
| 🔍 Search box | Filter by source text, target text, or object name |
| **Search in** dropdown | Scope search to Source / Target / Object name / All |
| **State** dropdown | Filter by translation state (needs translation, translated, final…) |
| **Type** dropdown | Filter by AL object type (Table, Page, Codeunit…) |
| **⚡ AI Translate All** | Translate all untranslated units in the current filter |
| **✔ Review All** | Run quality review on all translated units |
| **⇅ Populate TM** | Import all translated/final units into Translation Memory |
| **⚠ Clean up duplicates** | Fix units with multiple `<target>` elements (NAB AL Tool artifact) |
| **📤 Export for Review** | Export translations (filtered or all) to Excel for customer review |
| **📥 Import Review** | Import a reviewed Excel file and apply the updates |
| **📄 Raw XML** | Open the underlying `.xlf` in the plain text editor |
| **💾 Save** | Save all pending changes back to the XLIFF file |

### Row actions

Each row has inline controls:
- **Edit target** — click the target text area, type, press Save
- **Set state** — use the state dropdown in the row
- **⚡** — AI-translate this single unit
- **✔** — AI-review this single unit
- **→ Go to Source** — jump to the AL label in the source code
- **TM pill** — if a Translation Memory match exists, shows score% with an **Apply** button

### Bulk selection

Check the header checkbox to select all visible rows, or check individual rows. A bulk action bar appears:
- **⚡ AI Translate** — translate all selected
- **🧠 AI + Context** — context-aware translate (BC object/property + AL source + TM/glossary)
- **✔ Review** / **🧠 Review + Context** — AI quality-review the selected units
- **⟳ Apply TM** — apply best TM match to all selected
- **Set Status** — set state for all selected
- **✕ Deselect all**

### Filter chips

When you navigate from a folder or source file, the editor shows active filter chips above the list. Click **✕** on a chip to remove it.

---

## AI Translation

### Single unit
Click **⚡** in any row to translate that unit. The AI fills in the target and marks it **translated**.

### Translate all
Click **⚡ AI Translate All** to translate all units that pass the current filter and have no target yet.

### Bulk translate
Select rows with checkboxes → **⚡ AI Translate** in the bulk bar.

### AI + Context (better quality)
Standard AI translation only sees the source string. **🧠 AI + Context** (in the bulk bar) additionally sends each unit's Business Central object/property context (from the XLIFF note, e.g. *Codeunit "Job Queue" - Field "Error Count"*), any approved Translation Memory and glossary terms, and — when available — the surrounding AL source. This helps the AI translate ambiguous strings correctly (e.g. an integer field labelled *Error Count* in a Job Queue context). It uses more tokens, so it's a separate button — use plain **AI Translate** for the bulk of your file and **AI + Context** for the tricky remainder.

### Change highlighting
After an AI run, the affected rows are highlighted (purple) and a banner appears at the top:
- **Show only these** — filter the list to just the last run
- **↓ Jump to first** — scroll to the first highlighted row
- **✕ Clear highlight** — remove the highlight

The same pattern applies (in green) after importing a reviewed Excel file — see [Export & Import for Review](#export--import-for-review-excel).

### AI provider selection
Configure in VS Code settings (`File → Preferences → Settings → search "nexus"`):

```json
"nexus.translator.provider": "github-copilot",  // github-copilot | github-models | openai | azure-openai
"nexus.translator.baseUrl": "",                   // custom base URL (required for azure-openai)
"nexus.translator.model": ""                      // model override (e.g. gpt-4o)
```

---

## Translation Memory

The Translation Memory (TM) stores source→target pairs and surfaces them as you work.

### How it works
- After you save a file, all `translated`/`final` units are automatically added to the TM
- When you open a file, the editor looks up each untranslated unit against the TM
- If a match ≥ 75% similarity is found, a **TM pill** appears below the target field
- Click **Apply** to accept the suggestion

### TM scores
| Score | Color | Meaning |
|---|---|---|
| ≥ 95% | 🟢 Teal | Near-exact match |
| 80–94% | 🟡 Yellow | Good fuzzy match |
| 75–79% | 🟠 Orange | Acceptable match |

### Populating TM manually
- **In the editor**: click **⇅ Populate TM** in the toolbar
- **Right-click** any `.xlf` file → **Nexus: Populate TM from File**
- **Command Palette**: `Nexus: Populate TM from File`

### Storage
TM is stored in `.nexus/tm.json` in your workspace root. This file is shared with the [MCP server](#mcp-server).

---

## Glossary

The Glossary ensures consistent terminology (e.g. always translate "Customer" as "Debitor" in German).

### Managing terms
Run **Nexus: Manage Glossary & TM** from:
- Right-click an `.xlf` file
- The Command Palette

The panel lets you add, delete, and view term pairs per language.

### How glossary is used
Glossary terms are passed to every AI translation call — the AI is instructed to follow them. This prevents common mistakes like translating a BC-specific term incorrectly.

### Storage
Glossary is stored in `.nexus/glossary.json` in your workspace root (shared with the MCP server).

---

## Translation Diff

See what changed in your XLIFF file compared to git HEAD.

### Opening the diff
- **Right-click** an `.xlf` file → **Nexus: Show Translation Changes**
- Or click the **$(diff)** icon in the editor title bar
- Or run from the Command Palette

### Diff view
Shows a color-coded table:
- 🟡 **MODIFIED** — target text changed
- 🟢 **ADDED** — new translation unit
- 🔴 **REMOVED** — unit deleted

### Editing from diff
Click **✎ Edit N changed units in Nexus Translator** to open the editor pre-filtered to only the changed (added + modified) units. A banner at the top shows "Diff view — Showing N changed units". Click **Show all units** to remove the filter.

### Standard XML diff (working tree)
When Nexus is your default `.xlf` editor, the source-control gutter and "Open Changes" route through the Nexus diff. If you prefer the classic line-by-line XML diff, click **⇄ Open standard XML diff** on the Translation Changes view — it opens the raw working-tree-vs-HEAD text diff for the file in the same window.

---

## Export & Import for Review (Excel)

Reports and apps often need a customer or external reviewer to check translations and make corrections. Nexus round-trips this through an Excel file.

### Export
- In the editor toolbar click **📤 Export for Review**, or right-click an `.xlf` file → **Nexus: Export for Review (Excel)**
- If a filter is active (e.g. you filtered to a single report), Nexus asks whether to export **only the filtered units** or **all units** — so you can hand off just one report
- The `.xlsx` has a **Read me** sheet and a **Translations** sheet with ID / Context / Developer Note / Source / Translation / State / Comment columns
- Reference columns are locked; only **Translation**, **State** (dropdown), and **Comment** are editable, so reviewers can't accidentally break IDs

### Import
- Click **📥 Import Review** in the toolbar, or right-click the `.xlf` → **Nexus: Import Reviewed Translations (Excel)**
- Nexus matches rows back by **ID**, applies only the changed targets/states, saves the file, and reports how many units were updated / unchanged / not found
- If the file is open in the editor, the changed units are **highlighted in green** and your **current filter is preserved** — use **Show only these** / **↓ Jump to first** in the green banner to review exactly what the customer changed

---

## Find in Nexus (from AL source code)

Navigate from your AL code directly to a translation unit.

### Usage
1. Place your cursor on or near a label/caption in an AL file, e.g.:
   ```al
   Caption = 'Customer Address', Comment = '%1 = Name';
   ```
2. Right-click → **Find in Nexus Translator**
3. The Nexus editor opens, filtered to the object and pre-filled with the caption text

### Folder filter
Right-click **any folder** containing AL files → **Find in Nexus Translator** → the editor opens filtered to all AL objects found in that folder.

### Go to source
In the Nexus editor, click **→ Go to Source** on any row to jump to the AL file and line where that label is defined.

---

## MCP Server

The Nexus MCP server lets you use **Copilot Chat** to manage translations, get glossary suggestions, and populate TM through natural conversation.

### Setup
The server is configured automatically in `.vscode/mcp.json`. Enable it in Copilot Chat:
1. Open the Chat panel (`Ctrl+Alt+I`)
2. Click the 🔌 **Tools** icon
3. Enable **nexus-translator**

### Example conversations

**Getting glossary suggestions from your translations:**
```
You: Analyze my EN-DE.xlf and suggest 10 terms for the glossary
Copilot: Based on your translations, I suggest:
         • Customer → Debitor (appears 47 times)
         • Vendor → Kreditor (appears 31 times)
         • G/L Account → Sachkonto (appears 28 times)
         ...

You: Add "Customer" → "Debitor" for EN→DE
Copilot: ✓ Added to glossary

You: Also add "Vendor" → "Kreditor"
Copilot: ✓ Added to glossary
```

**Managing TM:**
```
You: Populate TM from Apps/Translations/Cronus.de-DE.xlf
Copilot: Imported 847 units into TM (12 skipped, already present)

You: Search TM for "Address" in EN→DE
Copilot: Found 3 matches:
         • "Address" → "Adresse" (100%, used 12 times)
         • "Ship-to Address" → "Lieferadresse" (91%)
         • "Bill-to Address" → "Rechnungsadresse" (88%)
```

**Reviewing glossary:**
```
You: What's in my EN→DE glossary?
Copilot: You have 8 terms:
         • Customer → Debitor
         • Vendor → Kreditor
         ...

You: Delete the "Vendor" entry
Copilot: ✓ Deleted
```

### Available tools

| Tool | Description |
|---|---|
| `list_xliff_files` | List all `.xlf` files in the workspace |
| `read_xliff_translations` | Read and parse translation units from a file |
| `get_new_units` | Diff an XLIFF against git HEAD — returns only units added/modified by the AL Sync Translation step |
| `write_translations` | Write `{id, target, state}[]` back to the XLIFF file (the "apply" step) |
| `set_unit_states` | Bulk set the translation state for unit IDs (approve/reject reviewed) |
| `get_translation_progress` | Per-file and overall % translated statistics |
| `validate_placeholders` | Find units where `%1`/`%2`/`{0}` etc. are missing from the target |
| `find_inconsistencies` | Find the same source translated differently in the same file |
| `analyze_translations_for_glossary` | Prepare translation data for glossary analysis |
| `get_glossary` | Get current glossary entries |
| `add_glossary_term` | Add a new term pair |
| `update_glossary_term` | Update an existing term |
| `delete_glossary_term` | Remove a term |
| `get_tm_stats` | Get TM statistics by language pair |
| `populate_tm_from_xliff` | Import translations from a file into TM |
| `search_tm` | Fuzzy-search TM for a source string |

---

## Commands

| Command | Description |
|---|---|
| `Nexus: Open in Nexus Translator` | Open the selected `.xlf` in the visual editor |
| `Nexus: Find in Nexus Translator` | Find the AL label at cursor in the translation editor |
| `Nexus: Show Translation Changes` | Show git diff for a translation file |
| `Nexus: Translate XLIFF File` | AI-translate all untranslated units in a file |
| `Nexus: Review XLIFF File Translations` | AI quality-review all translations in a file |
| `Nexus: Populate TM from File` | Import all translated units into Translation Memory |
| `Nexus: Export for Review (Excel)` | Export translations (filtered or all) to an `.xlsx` for customer review |
| `Nexus: Import Reviewed Translations (Excel)` | Import a reviewed `.xlsx` and apply the updates back to the file |
| `Nexus: Manage Glossary & TM` | Open the Glossary management panel |
| `Nexus: Set API Token (Secure)` | Store your OpenAI/Azure API key in the system keychain |
| `Nexus: Use Nexus as Default .xlf Editor` | Make Nexus the default editor for `.xlf` files |
| `Nexus: Use Text (Raw XML) as Default .xlf Editor` | Restore raw XML as the default |

---

## Keyboard Shortcuts

There are no default shortcuts — bind any command to a key via **File → Preferences → Keyboard Shortcuts**.

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `nexus.translator.provider` | `github-copilot` | AI provider: `github-copilot`, `github-models`, `openai`, `azure-openai` |
| `nexus.translator.token` | `""` | API token/key (prefer **Nexus: Set API Token (Secure)**) |
| `nexus.translator.model` | `""` | Model override (e.g. `gpt-4o`, `gpt-4o-mini`) |
| `nexus.translator.baseUrl` | `""` | Custom API base URL (required for `azure-openai`, optional for `openai`/Ollama) |
| `nexus.translator.sourceLanguage` | `en-US` | Fallback source language when the XLIFF omits one |
| `nexus.translator.targetLanguage` | `de-DE` | Fallback target language when the XLIFF omits one |
| `nexus.translator.batchSize` | `50` | Units per AI request — lower it if you hit token limits |
| `nexus.translator.openNavigationIn` | `active` | Where navigation opens editors: `active` (same window) or `beside` (split) |

---

## File Storage

All Nexus data is stored in `.nexus/` at your workspace root:

```
.nexus/
  tm.json        Translation Memory entries
  glossary.json  Glossary term pairs
```

> **Note:** `.nexus/` is added to `.gitignore` automatically. TM and Glossary are personal/project data — commit them deliberately if you want to share with your team.

---

## Requirements

- VS Code 1.102+
- Business Central AL projects with `.xlf` translation files
- For AI translation: GitHub Copilot subscription, or an OpenAI-compatible API key

---

## Development

Build, type-check and test from this folder (or run `pnpm test` at the repo root to test all packages):

```bash
pnpm type-check          # tsc --noEmit
pnpm test                # node:test unit tests
pnpm run build           # bundle to dist/extension.js (esbuild)
pnpm run package         # produce nexus-translator.vsix
pnpm run install-ext     # build + package + install into VS Code
```

Tests use Node's built-in test runner (`node:test`) and run TypeScript directly, so
they require **Node 22.18+** (Node 24 recommended). Pure logic is kept free of the
VS Code API (`src/similarity.ts`, `packages/xliff`) so it can be unit-tested without a
running editor.

---

## License

MIT — see [LICENSE](../../LICENSE)
