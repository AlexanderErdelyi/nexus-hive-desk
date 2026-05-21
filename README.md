# NexusHiveDesk

> AI-powered platform for Business Central translations, documentation generation, and project knowledge management

NexusHiveDesk started as a solution to the "last 10% problem" of XLIFF translation — but has evolved into a full AI-powered workspace connecting Business Central projects to Azure DevOps, GitHub, Wiki.js, and more. It helps developers, consultants, and teams manage translations, generate documentation, maintain glossaries, and automate knowledge work — all from a single interface.

---

## Features

### 📂 XLIFF Translation Management
- Upload XLIFF translation files (`.xlf`) for BC projects
- View all translation units with source, target, state, and BC metadata (object type, object name, field name)
- Resizable columns, dark mode support, full-text search

### 🔍 Search & Filter
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

### 📄 Documentation Generation (Wiki)
- Generate structured wiki pages from multiple source types:
  - **Manual text** — describe a topic and let AI draft the page
  - **Azure DevOps Work Items** — load a work item by ID and generate a process/feature doc
  - **Azure DevOps Repo files** — browse repo tree, select files/folders, generate code docs
  - **Teams Recordings** — transcribe a meeting (via MCP Teams Recorder) and generate meeting notes
- Publish directly to **Wiki.js** or **Azure DevOps Wiki** via MCP
- Full **HTML** (styled, Nobilis Green wiki style) or **Markdown** output
- AI configuration per generation:
  - **Model picker** — choose from 30+ models (see below)
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
- Use work items as source content for documentation generation
- **Branch → Work Item → PR workflow** when committing translation changes:
  - Commit to a new branch with one click
  - Search existing ADO work items (by ID or title) to link to the branch
  - Create a new work item (manual or **AI-suggested** title/description) if none exists
  - Open a Pull Request directly from the commit modal — title auto-filled from the work item
  - PR status badge (`Open` / `Merged` / `Closed`) shown on each XLIFF file
  - GitHub repos: commit + PR flow (no work item step)

### 🧩 Skills & Agents
- **Skills** — reusable prompt fragments that can be injected into any AI generation
  - Types: `prompt` (system prompt injection), `wiki-style` (HTML/Markdown formatting)
  - Built-in: Nobilis Green Wiki HTML style
- **Agents** — project-specific AI agents with a model, system prompt, and attached skills
  - Agent model overrides the global model picker
  - Agents are scoped per project

---

## AI Models

NexusHiveDesk uses **GitHub Models** (`models.github.ai`) as the default AI provider. No separate API key is needed — just a GitHub personal access token.

| Provider | Models | Best for |
|----------|--------|----------|
| **OpenAI GPT-4** | `gpt-4o`, `gpt-4o-mini`, `gpt-4.1`, `gpt-4.1-mini`, `gpt-4.1-nano` | Translation, review, structured output |
| **OpenAI GPT-5** ⚡ | `gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `gpt-5-chat` | Rich documentation, advanced reasoning |
| **OpenAI o-series** ⚡ | `o3`, `o3-mini`, `o4-mini` | Complex reasoning, technical docs |
| **Meta Llama 4** | `llama-4-scout`, `llama-4-maverick` | Fast, cost-efficient generation |
| **Microsoft Phi-4** | `phi-4`, `phi-4-mini` | Lightweight tasks |
| **DeepSeek** | `deepseek-v3`, `deepseek-r1` ⚡ | Code-heavy documentation |
| **Cohere** | `command-r`, `command-r-plus` | Long-context retrieval |
| **AI21 Jamba** | `jamba-1.6-mini`, `jamba-1.6-large` | Long documents |

> ⚡ = Reasoning model (gpt-5, o-series, DeepSeek R1). These models do internal "thinking" before responding — no temperature or response_format control, but higher quality.

### Claude (Anthropic)
Claude is not in the GitHub Models catalog. To use Claude, set one of:
- `ANTHROPIC_API_KEY` — direct Anthropic API
- `OPENROUTER_API_KEY` — [OpenRouter](https://openrouter.ai) free tier (also supports Claude)

### Custom model
Enter any model ID manually for custom deployments.

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

---

## Roadmap

- [ ] Azure DevOps / GitHub — auto-create branches & PRs for translation changes
- [ ] Multi-user workspace with role-based access per project
- [ ] CI/CD pipeline integration for translation validation
- [ ] More MCP connectors (Confluence, Notion, SharePoint)
- [ ] Custom Skills marketplace (import/export skill packs)
- [ ] Translation memory across projects

---

## License

MIT
