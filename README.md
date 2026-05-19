# NexusHiveDesk

> AI-powered XLIFF translation management for Business Central projects

NexusHiveDesk is a modern web tool that makes managing translations for Microsoft Dynamics 365 Business Central fast, smart, and collaborative. It solves the "last 10%" problem — when automated tools get you most of the way, NexusHiveDesk handles the rest with AI assistance, glossary enforcement, and a clean review workflow.

---

## Features

### 📂 XLIFF Management
- Upload XLIFF translation files (`.xlf`) for BC projects
- View all translation units with source, target, state, and BC metadata (object type, object name, property)
- Resizable columns, dark mode support

### 🔍 Search & Filter
- Full-text search across source, target, notes, and extracted metadata
- Filter by object type (Table, Codeunit, Page, Report, …), state, and more
- Drag & drop a source folder → auto-detect objects and build the filter

### ✏️ Manual Translation Editing
- Inline edit target translations
- Pending edits highlighted in amber until saved or discarded
- Batch save / discard all pending changes

### 🤖 AI Translation
- Translate selected or all untranslated strings with AI (GitHub Models / OpenAI-compatible)
- Results shown as pending (yellow) — review before saving
- AI respects the project glossary (e.g. Customer → Debitor, not Kunde)

### 🧠 AI Review
- Quality-check selected or all translations in BC context
- Per-row badges: ✓ Good / ⚠ Warning / ✗ Error with reason and suggestion
- Context-aware: provide additional instructions for the reviewer

### 📖 Glossary
- Define term mappings (e.g. `Customer → Debitor`, `Vendor → Kreditor`)
- **AI Auto-Generate** — analyzes your XLIFF and suggests BC-specific terms automatically
- **AI Prompt** — natural language batch generation (`"Customer=Debitor, all finance terms"`)
- Review suggestions with confidence badges, edit inline, accept/reject, then import in one click
- Glossary is applied automatically to every AI translation

---

## Architecture

```
nexus-hive-desk/        (Turborepo + pnpm workspaces)
├── apps/
│   ├── web/            Next.js 14 — frontend (React, Tailwind, TanStack Query)
│   └── api/            Fastify — REST API (tsx watch, Prisma ORM)
├── packages/
│   ├── ai/             AI provider abstraction (GitHub Models, OpenAI-compatible)
│   ├── types/          Shared TypeScript types
│   └── db/             Prisma schema + SQLite database
```

### Tech Stack
| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14, React, Tailwind CSS, TanStack Query |
| Backend | Fastify, TypeScript, tsx watch |
| Database | SQLite via Prisma ORM |
| AI | GitHub Models (default), OpenAI-compatible endpoint |
| Monorepo | Turborepo + pnpm workspaces |

---

## Getting Started

### Prerequisites
- Node.js 18+
- pnpm 8+

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
# From repo root — starts both API (3001) and Web (3000)
pnpm dev
```

Open **http://localhost:3000**

### AI Setup
In the app: go to **Settings → AI Provider** and enter your GitHub Models token or OpenAI-compatible endpoint + key.

---

## Roadmap

- [ ] Azure DevOps / GitHub integration — push translations directly to branches, auto-create PRs
- [ ] Multi-user / multi-project workspace with role-based access
- [ ] Wiki.js / Azure DevOps Wiki sync via MCP
- [ ] Documentation generation from BC objects
- [ ] Custom Skills & Agents — configurable AI agents per project
- [ ] CI/CD translation validation pipeline

---

## License

MIT
