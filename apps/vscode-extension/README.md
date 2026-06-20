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
| 🧠 **Translation Memory** | Local TM with fuzzy matching — reuse past translations automatically |
| 📖 **Glossary** | Manage term pairs to keep terminology consistent across all translations |
| 🔍 **Find in Nexus** | Right-click any AL label in source code to jump to its translation |
| 📂 **Folder Filter** | Right-click a folder to open the editor pre-filtered to its AL objects |
| 🔀 **Translation Diff** | Compare current XLIFF against git HEAD — see what changed, added, or removed |
| 🤖 **MCP Server** | Ask Copilot Chat to suggest glossary terms, populate TM, or analyze translations |
| ✅ **Bulk Actions** | Select multiple rows → AI translate, apply TM, or set status in one click |

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
| **Ollama (local)** | Set `nexusTranslator.apiBaseUrl` to `http://localhost:11434/v1` |

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

### AI provider selection
Configure in VS Code settings (`File → Preferences → Settings → search "nexus"`):

```json
"nexusTranslator.aiProvider": "copilot",       // copilot | openai | azure
"nexusTranslator.apiBaseUrl": "",               // custom base URL
"nexusTranslator.model": "gpt-4o"              // model override
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
| `nexusTranslator.aiProvider` | `copilot` | AI provider: `copilot`, `openai`, `azure` |
| `nexusTranslator.apiBaseUrl` | `""` | Custom API base URL (e.g. for Ollama) |
| `nexusTranslator.model` | `""` | Model override (e.g. `gpt-4o`, `llama3`) |

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

- VS Code 1.90+
- Business Central AL projects with `.xlf` translation files
- For AI translation: GitHub Copilot subscription, or an OpenAI-compatible API key

---

## License

MIT — see [LICENSE](../../LICENSE)
