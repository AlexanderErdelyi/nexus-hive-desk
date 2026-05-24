'use client';

import { useCallback, useEffect } from 'react';

type KeyHandler = (e: KeyboardEvent) => void;
export type KeyMap = Record<string, KeyHandler>;

/**
 * Registers global keyboard shortcut listeners.
 * Combo format: 'ctrl+s', 'ctrl+shift+s', '?', '/', 'j', 'Escape'
 * Note: both Ctrl and Meta (⌘) are normalised to 'ctrl'.
 */
export function useKeyboard(keyMap: KeyMap, enabled = true) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!enabled) return;

      const tag = (e.target as Element).tagName.toLowerCase();
      const isEditable =
        tag === 'input' ||
        tag === 'textarea' ||
        (e.target as HTMLElement).isContentEditable;

      // Build combo string (ctrl covers both Ctrl and Cmd/Meta)
      const parts: string[] = [];
      if (e.ctrlKey || e.metaKey) parts.push('ctrl');
      if (e.shiftKey) parts.push('shift');
      if (e.altKey) parts.push('alt');
      parts.push(e.key.toLowerCase());
      const combo = parts.join('+');

      // Modifier combos fire regardless of editable context
      if (parts.includes('ctrl') || parts.includes('alt')) {
        if (keyMap[combo]) {
          keyMap[combo](e);
          return;
        }
      }

      // Single-key shortcuts don't fire inside text inputs (except Escape)
      if (isEditable && e.key !== 'Escape') return;

      if (keyMap[combo]) {
        keyMap[combo](e);
        return;
      }

      // Fall back to bare key lookup (e.g. 'j', 'k', '?', 'Escape', '/')
      if (keyMap[e.key]) {
        keyMap[e.key](e);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, keyMap],
  );

  useEffect(() => {
    if (!enabled) return;
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown, enabled]);
}
