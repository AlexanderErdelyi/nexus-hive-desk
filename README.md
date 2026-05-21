# NexusHiveDesk

> AI-powered platform for Business Central translations, documentation generation, Azure DevOps work item management, and project knowledge management

NexusHiveDesk started as a solution to the "last 10% problem" of XLIFF translation — but has evolved into a full AI-powered workspace connecting Business Central projects to Azure DevOps, GitHub, Wiki.js, and more. It helps developers, consultants, and teams manage translations, generate documentation, manage work items, maintain glossaries, and automate knowledge work — all from a single interface.

---

## Features

### 📂 XLIFF Translation Management
- Upload XLIFF translation files (`.xlf`) for BC projects
- View all translation units with source, target, state, and BC metadata (object type, object name, field name)
- Resizable columns, dark mode support, full-text search
- Filter by object type (Table, Codeunit, Page, Report, …), translation state, and more
- Drag & drop a BC source folder → auto-detect object names and build smart filters

### ✏️ Manual Translation Editing
- Inline edit target translations
- Pending edits highlighted in amber until saved or discarded
- Batch save / discard all pending changes
- Upload modified XLIFF back to file

### 🤖 AI Translation
- Translate selected or all untranslated strings with AI
- Results shown as pending — review before saving
- AI enforces the project glossary (e.g. `Customer → Debitor`, not `Kunde`)

### 🧠 AI Review
- Quality-check all translations in BC context
- Per-row badges: ✓ Good / ⚠ Warning / ✗ Error with reason and suggestion
- Context-aware: provide additional instructions for domain-specific review

### 📖 Glossary
- Define term mappings (e.g. `Customer → Debitor`, `Vendor → Kreditor`)
- **AI Auto-Generate** — analyzes your XLIFF and suggests BC-specific terms automatically
- **AI Prompt** — natural language batch generation (`"Customer=Debitor, all finance terms"`)
- Review suggestions with confidence badges, edit inline, accept/reject, import in one click

---

### 📋 Azure DevOps Work Item Management
- View, search, and filter work items (User Stories, Tasks, Bugs, Features) across ADO projects
- **Work Item Detail Modal** with tabbed view:
  - Overview — editable title, description (AI-refined), acceptance criteria, state, priority
  - Comments — view all comments, add new comments
  - AI Refinement — refine the description/AC with AI using context from repos, Teams recordings, or manual instructions; choose model, agent, and skills per refinement
  - Split / Decompose — AI-powered splitting of User Stories into Tasks (with technical spec, acceptance criteria), or Features into User Stories, with expandable per-item cards and per-item AI chat for fine-tuning before pushing to ADO
- **AI Create Work Item** — generate work item from context (manual text, Teams recording, repo files) with AI-suggested title, description, AC, and priority
- **Branch → Work Item → PR workflow** when committing translation changes:
  - Create a new branch with one click
  - Search existing ADO work items (by ID or title) to link to the branch
  - Create a new work item (manual or **AI-suggested** title/description) if none exists
  - Open a Pull Request directly from the commit modal — title auto-filled from the work item
  - PR status badge (`Open` / `Merged` / `Closed`) shown on each XLIFF file

---

### 📄 Documentation Generation (Wiki)
- Generate structured wiki pages from multiple source types:
  - **Manual text** — describe a topic and let AI draft the page
  - **Azure DevOps Work Items** — load a work item by ID and generate a process/feature doc
  - **Azure DevOps Repo files** — browse repo tree, select files/folders, generate code docs
  - **Teams Recordings** — transcribe a meeting (via MCP Teams Recorder) and generate meeting notes
- Publish directly to **Wiki.js** or **Azure DevOps Wiki** via MCP
- Full **HTML** (styled, Nobilis Green wiki style) or **Markdown** output
- AI configuration per generation:
  - **Model picker** — choose from 30+ models (flat grouped dropdown, same as agents)
  - **Agent** — attach a project-specific AI agent with custom system prompt
  - **Skills** — inject prompt skills for domain-specific content

### 🔌 MCP Connections
- Connect external services via MCP (Model Context Protocol):
  - **Wiki.js** — read page tree, create/update pages
  - **Azure DevOps Wiki** — read and write wiki pages
  - **Teams Recorder** — access Teams meeting recordings and transcripts
- Test connections, view available tools, manage credentials per connection

### 🤝 Azure DevOps & GitHub Integration
- Connect ADO organizations: browse repos, work items, wikis
- Browse repository file tree (drill down into folders)
- Use work items as source content for documentation generation or AI refinement
- GitHub repos: commit + PR flow (no work item step)

### 🧩 Skills & Agents

#### Skills
Reusable fragments that can be injected into any AI generation (documentation, agent calls, refinement):

| Type | Description | VS Code equivalent |
|------|-------------|-------------------|
| **Prompt** | System prompt injection / reusable prompt template | `.github/prompts/*.prompt.md` |
| **Instructions** | Always-injected scoped context (can use `applyTo` glob) | `.instructions.md` / `copilot-instructions.md` |
| **Skill** | Reusable skill definition with structured content | `.github/skills/*.skill.md` |
| **Code** | Script/code-based skill (placeholder for future execution) | — |

- **Import from VS Code** — drag in `.md` (`.prompt.md`, `.skill.md`, `.instructions.md`, `.agent.md`) or `.json` skill/agent files; frontmatter parsed automatically (name, description, type)
- **Skill detail modal** — full-screen view and edit overlay; read-only for built-in skills
- Built-in: `WikiHtmlStyleNobilisGreen` (HTML styling for Wiki.js)

#### Agents
Project-specific AI agents with a model, system prompt, skills, and MCP connections:
- **Model selector** — flat grouped dropdown with 30+ models (same catalogue as documentation)
- **System prompt** — large resizable textarea
- Agents override the global model for all AI operations
- **Import from VS Code** — `.agent.md` / `.instructions.md` with YAML frontmatter (name, description, tools, model)
- **Export** — download agent back as `.instructions.md` for use in VS Code

---

### 🗺️ Interactive Tour
- Built-in guided tour walks through every section: Translation, Glossary, Documentation, Work Items, Agents & Skills, MCP Connections, Settings
- Triggered on first load or manually from the header

---

## AI Models

NexusHiveDesk uses **GitHub Models** (`models.github.ai`) as the default AI provider. No separate API key is needed — just a GitHub personal access token.

Agents and the documentation page share the same flat grouped model selector:

| Provider | Models | Best for |
|----------|--------|----------|
| **OpenAI GPT-4** | `gpt-4o-mini`, `gpt-4o`, `gpt-4.1-nano`, `gpt-4.1-mini`, `gpt-4.1` | Translation, review, structured output |
| **OpenAI GPT-5** ⚡ | `gpt-5-nano`, `gpt-5-mini`, `gpt-5` | Rich documentation, advanced reasoning |
| **OpenAI o-series** ⚡ | `o4-mini`, `o3-mini`, `o3` | Complex reasoning, technical docs |
| **Meta Llama 4** | `llama-4-scout`, `llama-4-maverick`, `llama-3.3-70b` | Fast, cost-efficient, multilingual |
| **DeepSeek** | `deepseek-r1-0528` ⚡, `deepseek-v3-0324` | Code-heavy documentation, BC logic |
| **Microsoft Phi-4** | `phi-4`, `phi-4-mini` | Lightweight tasks, math + coding |
| **Cohere / AI21** | `command-a`, `jamba-1.5-large` | Long-context retrieval / RAG |
| **Anthropic Claude** | `haiku-4-5`, `sonnet-4-5`, `opus-4-5` | Writing quality, agents |
| **GitHub Copilot** | `claude-sonnet-4.5`, `gpt-4o`, `o3`, `o4-mini` | Copilot-native agent use |
| **Ollama (local)** | `llama3`, `mistral`, `mixtral`, `phi3`, `gemma2`, … | Offline / private deployments |

> ⚡ = Reasoning model. No temperature control, higher quality output.

### Claude (Anthropic)
Set one of these env vars to enable Claude models directly (without GitHub Models):
- `ANTHROPIC_API_KEY` — direct Anthropic API
- `OPENROUTER_API_KEY` — [OpenRouter](https://openrouter.ai) (also supports Claude)

---

## Architecture

```
nexus-hive-desk/           (Turborepo + pnpm workspaces)
├── apps/
│   ├── web/               Next.js 15 — frontend (React, Tailwind, TanStack Query)
│   └── api/               Fastify — REST API (tsx watch, Prisma ORM)
├── packages/
│   ├── ai/                AI provider abstraction (GitHub Models, OpenAI-compatible)
│   ├── types/             Shared TypeScript types
│   ├── db/                Prisma schema + SQLite database
│   └── xliff/             XLIFF parsing utilities
```

### Tech Stack
| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 15, React, Tailwind CSS, TanStack Query |
| Backend | Fastify, TypeScript, tsx watch |
| Database | SQLite via Prisma ORM |
| AI (default) | GitHub Models — `models.github.ai` (30+ models) |
| AI (optional) | Anthropic API, OpenRouter (Claude support) |
| Integration | Azure DevOps REST API, GitHub API |
| MCP | Model Context Protocol (Wiki.js, Teams Recorder) |
| Monorepo | Turborepo + pnpm workspaces |

---

## Getting Started

### Prerequisites
- Node.js 18+
- pnpm 8+
- A GitHub personal access token (for AI + GitHub/ADO integrations)

### Install
```bash
git clone https://github.com/AlexanderErdelyi/nexus-hive-desk.git
cd nexus-hive-desk
pnpm install
```

### Configure
Create `apps/api/.env`:
```env
DATABASE_URL="file:./dev.db"

# GitHub token — used for AI (GitHub Models) + ADO/GitHub integrations
GITHUB_TOKEN=ghp_your_token_here

# Default AI model (optional, default: openai/gpt-4o-mini)
AI_MODEL=openai/gpt-4o-mini

# Claude support (optional — one of these enables Claude models)
ANTHROPIC_API_KEY=sk-ant-...
OPENROUTER_API_KEY=sk-or-...
```

Create `apps/web/.env.local`:
```env
NEXT_PUBLIC_API_URL=http://localhost:3001
```

### Database setup
```bash
cd apps/api
pnpm exec prisma migrate dev --name init
```

### Run
```bash
# From repo root — starts both API (port 3001) and Web (port 3000)
pnpm dev
```

Open **http://localhost:3000**

---

## Quick Start — Translation Workflow

1. **Create a customer & project** in the sidebar
2. **Upload your XLIFF file** in the Translation tab
3. **Set up a glossary** (manually or let AI auto-generate from your XLIFF)
4. **Run AI Translation** on all untranslated strings
5. **Review** the results — use AI Review to catch quality issues
6. **Edit** any remaining strings manually in the inline editor
7. **Download** the updated XLIFF file

## Quick Start — Wiki Documentation

1. **Add an MCP Connection** (Wiki.js or ADO Wiki) in Settings
2. **Connect Azure DevOps** in your project (for work items / repo browsing)
3. Go to **Documentation** tab — browse your wiki page tree
4. Click **Generate** — choose source (manual, work item, repo files, or Teams recording)
5. Optionally configure an **Agent** or **Skills** for domain-specific content
6. Choose a model, review the generated page, and **publish** to your wiki

## Quick Start — Work Item Management

1. **Connect Azure DevOps** in your project settings
2. Go to the **Work Items** tab — browse and filter by type, state, assignee
3. Click a work item to open the detail modal
4. Use **AI Refinement** to improve descriptions / acceptance criteria with context
5. Use **Split / Decompose** to break User Stories into Tasks (with technical specs)
6. Push split items directly to ADO with one click

---

## Roadmap

- [x] Azure DevOps / GitHub — auto-create branches & PRs for translation changes
- [x] Import/export Skills and Agents from VS Code (`.md`, `.json`)
- [ ] Multi-user workspace with role-based access per project
- [ ] CI/CD pipeline integration for translation validation
- [ ] More MCP connectors (Confluence, Notion, SharePoint)
- [ ] Custom Skills marketplace (import/export skill packs)
- [ ] Translation memory across projects
- [ ] Azure OpenAI deployment support (private model hosting)

---

## License

MIT
