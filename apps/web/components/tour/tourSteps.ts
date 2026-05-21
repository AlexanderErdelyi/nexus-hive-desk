import type { Step } from 'react-joyride';

export type TourStep = Step & {
  navigate?: string;
  disableScrolling?: boolean;
};

export const tourSteps: TourStep[] = [
  {
    target: 'body',
    placement: 'center',
    disableScrolling: true,
    title: '👋 Welcome to NexusHiveDesk',
    content:
      "Let's take a quick tour of the platform. We'll show you how to set up your workspace, manage translations, and use AI-powered features. It only takes 2 minutes.",
  },
  {
    target: '[data-tour="nav-projects"]',
    placement: 'bottom',
    disableScrolling: true,
    title: '📁 Projects',
    content:
      'Everything starts with a Project. A project connects to your Azure DevOps repo, holds your XLIFF translation files, and links to wiki documentation.',
  },
  {
    target: '[data-tour="nav-agents"]',
    placement: 'bottom',
    disableScrolling: true,
    title: '🤖 AI Agents',
    content:
      'Agents are AI assistants you configure. Choose a model (GPT-4, Claude, Llama…), add MCP connections (like a Teams recorder), and use them for translations, work items and docs.',
  },
  {
    target: '[data-tour="nav-settings"]',
    placement: 'bottom',
    disableScrolling: true,
    title: '⚙️ Settings',
    content: 'Connect your Azure DevOps, GitHub, and AI provider API keys here. You only need to do this once.',
  },
  {
    target: '[data-tour="create-project-btn"]',
    placement: 'bottom',
    disableScrolling: true,
    title: '➕ Create your first project',
    content:
      'Click here to create a project. Fill in your ADO org, project name, and PAT token. NexusHiveDesk will connect to your repository automatically.',
    navigate: '/projects',
  },
  {
    target: '[data-tour="project-tabs"]',
    placement: 'bottom',
    disableScrolling: true,
    title: '🗂️ Project Sections',
    content:
      "Each project has tabs: Translations (XLIFF), Work Items (ADO), Wiki, and Documentation. Let's walk through each one.",
    navigate: '/projects',
  },
  {
    target: '[data-tour="tab-translations"]',
    placement: 'right',
    disableScrolling: true,
    title: '🌍 XLIFF Translations',
    content:
      'Upload your .xlf or .xliff file. NexusHiveDesk extracts all translation units and lets you filter, search, and edit them in a clean table.',
  },
  {
    target: '[data-tour="tab-translations"]',
    placement: 'right',
    disableScrolling: true,
    title: '✨ AI Translation',
    content:
      'Select untranslated entries and use AI to auto-translate them. You can also add a Glossary to enforce specific terms (e.g. Customer → Debitor in German).',
  },
  {
    target: '[data-tour="tab-workitems"]',
    placement: 'right',
    disableScrolling: true,
    title: '📋 Work Items',
    content:
      'Browse and create ADO work items directly here. Use AI Refine to improve descriptions, create tasks from user stories, or generate acceptance criteria.',
  },
  {
    target: '[data-tour="tab-wiki"]',
    placement: 'right',
    disableScrolling: true,
    title: '📚 Wiki & Documentation',
    content:
      'Connect to Wiki.js or ADO wiki to create and update pages. Use AI with Teams meeting recordings and repo context to auto-generate documentation.',
  },
  {
    target: '[data-tour="branch-selector"]',
    placement: 'bottom',
    disableScrolling: true,
    title: '🌿 Branch & PR workflow',
    content:
      'Switch branches, commit translation changes, create ADO work items, and open Pull Requests — all without leaving NexusHiveDesk.',
  },
  {
    target: 'body',
    placement: 'center',
    disableScrolling: true,
    title: "🎉 You're all set!",
    content:
      "That's the full tour! If you ever need a refresher, click the '?' button in the top navigation. Good luck with your translations!",
  },
];
