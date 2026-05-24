'use client';

import { Keyboard, X } from 'lucide-react';

interface Shortcut {
  keys: string[];
  description: string;
  category: string;
}

const SHORTCUTS: Shortcut[] = [
  { category: 'Navigation', keys: ['/'], description: 'Focus search' },
  { category: 'Navigation', keys: ['j'], description: 'Next item in list' },
  { category: 'Navigation', keys: ['k'], description: 'Previous item in list' },
  { category: 'Editor', keys: ['Ctrl', 'S'], description: 'Save current editor' },
  { category: 'General', keys: ['Esc'], description: 'Close open modal' },
  { category: 'General', keys: ['?'], description: 'Open this help panel' },
];

function KeyBadge({ children }: { children: string }) {
  return (
    <kbd className="inline-flex min-w-[1.75rem] items-center justify-center rounded border border-gray-300 bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-700 shadow-[inset_0_-1px_0_0_rgba(0,0,0,0.1)] dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200">
      {children}
    </kbd>
  );
}

interface KeyboardShortcutsHelpProps {
  onClose: () => void;
}

export function KeyboardShortcutsHelp({ onClose }: KeyboardShortcutsHelpProps) {
  const categories = [...new Set(SHORTCUTS.map((s) => s.category))];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        className="w-full max-w-md rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4 dark:border-gray-800">
          <div className="flex items-center gap-2">
            <Keyboard size={16} className="text-indigo-500" />
            <span className="font-semibold text-gray-900 dark:text-white">Keyboard Shortcuts</span>
          </div>
          <button
            onClick={onClose}
            aria-label="Close shortcuts help"
            className="min-h-[44px] min-w-[44px] rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="divide-y divide-gray-100 px-5 py-3 dark:divide-gray-800">
          {categories.map((category) => (
            <div key={category} className="py-3">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
                {category}
              </p>
              <ul className="space-y-2">
                {SHORTCUTS.filter((s) => s.category === category).map((shortcut) => (
                  <li key={shortcut.description} className="flex items-center justify-between gap-4">
                    <span className="text-sm text-gray-700 dark:text-gray-300">{shortcut.description}</span>
                    <div className="flex shrink-0 items-center gap-1">
                      {shortcut.keys.map((k, i) => (
                        <span key={i} className="flex items-center gap-1">
                          {i > 0 && <span className="text-xs text-gray-400">+</span>}
                          <KeyBadge>{k}</KeyBadge>
                        </span>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="border-t border-gray-100 px-5 py-3 dark:border-gray-800">
          <p className="text-xs text-gray-400 dark:text-gray-500">
            Press <KeyBadge>?</KeyBadge> to toggle this panel · <KeyBadge>Esc</KeyBadge> to close
          </p>
        </div>
      </div>
    </div>
  );
}
