'use client';

import { useCallback, useState } from 'react';
import { useKeyboard } from '@/hooks/useKeyboard';
import { KeyboardShortcutsHelp } from './KeyboardShortcutsHelp';

/**
 * Mounts once in the root layout. Registers global shortcuts and renders the
 * keyboard help modal.
 *
 * Custom DOM events dispatched so individual components can hook in:
 *   - nhd:save           → Ctrl+S / Cmd+S  (save current editor)
 *   - nhd:navigate-prev  → k               (previous list item)
 *   - nhd:navigate-next  → j               (next list item)
 *   - nhd:close-modal    → Escape          (close top-most modal)
 */
export function KeyboardShortcutsProvider({ children }: { children?: React.ReactNode }) {
  const [helpOpen, setHelpOpen] = useState(false);

  const dispatch = useCallback((name: string) => {
    window.dispatchEvent(new CustomEvent(name));
  }, []);

  useKeyboard({
    '?': (e) => {
      e.preventDefault();
      setHelpOpen((v) => !v);
    },

    '/': (e) => {
      e.preventDefault();
      const input = document.querySelector<HTMLInputElement>(
        'input[type="search"], input[placeholder*="earch"], input[placeholder*="ilter"]',
      );
      input?.focus();
    },

    'j': (e) => {
      e.preventDefault();
      dispatch('nhd:navigate-next');
    },

    'k': (e) => {
      e.preventDefault();
      dispatch('nhd:navigate-prev');
    },

    'Escape': () => {
      if (helpOpen) {
        setHelpOpen(false);
      } else {
        dispatch('nhd:close-modal');
      }
    },

    'ctrl+s': (e) => {
      e.preventDefault();
      dispatch('nhd:save');
    },
  });

  return (
    <>
      {children}
      {helpOpen && <KeyboardShortcutsHelp onClose={() => setHelpOpen(false)} />}
    </>
  );
}
