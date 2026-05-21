import type { Step } from 'react-joyride';

export type TourStep = Step & {
  navigate?: string;
};

export const tourSteps: TourStep[] = [
  // ── 1. Welcome ────────────────────────────────────────────────────────────────
  {
    target: 'body',
    placement: 'center',
    title: '👋 Welcome to NexusHiveDesk',
    content:
      "Let's take a quick tour of the platform. We'll show you how to set up your workspace, manage translations, and use AI-powered features. It only takes 2 minutes.",
    skipBeacon: true,
  },
  // ── 2. Projects nav ───────────────────────────────────────────────────────────
  {
    target: '[data-tour="nav-projects"]',
    placement: 'bottom',
    title: '📁 Projects',
    content:
      'Everything starts with a Project. A project connects to your Azure DevOps repo, holds your XLIFF translation files, and links to wiki documentation.',
    skipBeacon: true,
  },
  // ── 3. Agents nav ─────────────────────────────────────────────────────────────
  {
    target: '[data-tour="nav-agents"]',
    placement: 'bottom',
    title: '🤖 AI Agents',
    content:
      'Agents are AI assistants you configure. Choose a model (GPT-4, Claude, Llama…), add MCP connections (like a Teams recorder), and use them for translations, work items and docs.',
    skipBeacon: true,
  },
  // ── 4. Settings nav ───────────────────────────────────────────────────────────
  {
    target: '[data-tour="nav-settings"]',
    placement: 'bottom',
    title: '⚙️ Settings',
    content: 'Connect your Azure DevOps, GitHub, and AI provider API keys here. You only need to do this once.',
    skipBeacon: true,
  },
  // ── 5. Create Project button ──────────────────────────────────────────────────
  {
    target: '[data-tour="create-project-btn"]',
    placement: 'bottom',
    title: '➕ Create your first project',
    content:
      'Click here to create a project. Fill in your ADO org, project name, and PAT token. NexusHiveDesk will connect to your repository automatically.',
    skipBeacon: true,
    navigate: '/projects',
  },
  // ── 6. XLIFF Translations ─────────────────────────────────────────────────────
  {
    target: 'body',
    placement: 'center',
    title: '🌍 XLIFF Translations',
    content:
      'Open a project and go to the Translations tab. Upload your .xlf/.xliff file — NexusHiveDesk extracts all translation units into a searchable, filterable table.',
    skipBeacon: true,
  },
  // ── 7. AI Translation ─────────────────────────────────────────────────────────
  {
    target: 'body',
    placement: 'center',
    title: '✨ AI Translation',
    content:
      'Select untranslated entries and click "AI Translate" to auto-fill them. Add a Glossary to enforce specific terms — e.g. Customer → Debitor in German.',
    skipBeacon: true,
  },
  // ── 8. Work Items ─────────────────────────────────────────────────────────────
  {
    target: 'body',
    placement: 'center',
    title: '📋 Work Items',
    content:
      'The Work Items tab connects to Azure DevOps. Browse, create, and refine work items with AI — generate acceptance criteria, split stories into tasks, or create a full feature hierarchy.',
    skipBeacon: true,
  },
  // ── 9. AI Refine & Split ──────────────────────────────────────────────────────
  {
    target: 'body',
    placement: 'center',
    title: '🔀 AI Refine & Decompose',
    content:
      'Open any work item and use the "Refine" tab to improve descriptions with AI, or the "Split" tab to decompose a User Story into tasks, sub-stories, or a full Feature → Stories → Tasks hierarchy.',
    skipBeacon: true,
  },
  // ── 10. Wiki & Documentation ──────────────────────────────────────────────────
  {
    target: 'body',
    placement: 'center',
    title: '📚 Wiki & Documentation',
    content:
      'Connect to Wiki.js or ADO wiki and let AI draft documentation pages — using your repo files and Teams meeting recordings as context. Never write boilerplate docs again.',
    skipBeacon: true,
  },
  // ── 11. Branch & PR workflow ──────────────────────────────────────────────────
  {
    target: '[data-tour="branch-selector"]',
    placement: 'bottom',
    title: '🌿 Branch & PR workflow',
    content:
      'Switch branches, commit translation changes, link to ADO work items, and open Pull Requests — all without leaving NexusHiveDesk.',
    skipBeacon: true,
  },
  // ── 12. Done ──────────────────────────────────────────────────────────────────
  {
    target: 'body',
    placement: 'center',
    title: "🎉 You're all set!",
    content:
      "That's the full tour! Click the '?' Tour button in the top navigation anytime to restart. Good luck with your translations!",
    skipBeacon: true,
  },
];
