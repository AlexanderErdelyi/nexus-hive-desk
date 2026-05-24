'use client';

import { useCallback, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';

interface MarkdownSplitEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minHeight?: number;
}

type ToolbarAction = {
  label: string;
  title: string;
  prefix: string;
  suffix: string;
  block?: boolean;
  linePrefix?: string;
};

const TOOLBAR_ACTIONS: ToolbarAction[] = [
  { label: 'B', title: 'Bold', prefix: '**', suffix: '**' },
  { label: 'I', title: 'Italic', prefix: '_', suffix: '_' },
  { label: 'H', title: 'Heading', prefix: '## ', suffix: '', block: true },
  { label: '🔗', title: 'Link', prefix: '[', suffix: '](url)' },
  { label: '<>', title: 'Inline code', prefix: '`', suffix: '`' },
  { label: '```', title: 'Code block', prefix: '```\n', suffix: '\n```', block: true },
  { label: '• List', title: 'Unordered list', prefix: '', suffix: '', linePrefix: '- ' },
  { label: '1. List', title: 'Ordered list', prefix: '', suffix: '', linePrefix: '1. ' },
];

export function MarkdownSplitEditor({ value, onChange, placeholder, minHeight = 400 }: MarkdownSplitEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [leftWidthPct, setLeftWidthPct] = useState(50);
  const isDragging = useRef(false);

  // ── Drag-to-resize ────────────────────────────────────────────────────────
  const onDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;

    const container = containerRef.current;
    if (!container) return;

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isDragging.current) return;
      const rect = container.getBoundingClientRect();
      const raw = ((moveEvent.clientX - rect.left) / rect.width) * 100;
      setLeftWidthPct(Math.min(Math.max(raw, 20), 80));
    };

    const onMouseUp = () => {
      isDragging.current = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, []);

  // ── Toolbar insert ────────────────────────────────────────────────────────
  function applyAction(action: ToolbarAction) {
    const ta = textareaRef.current;
    if (!ta) return;

    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = value.slice(start, end);

    let newText: string;
    let newCursorStart: number;
    let newCursorEnd: number;

    if (action.linePrefix !== undefined) {
      // Prefix every selected line (or current line if no selection)
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const lineEnd = value.indexOf('\n', end);
      const blockEnd = lineEnd === -1 ? value.length : lineEnd;
      const block = value.slice(lineStart, blockEnd);
      const prefixed = block
        .split('\n')
        .map((line) => `${action.linePrefix}${line}`)
        .join('\n');
      newText = value.slice(0, lineStart) + prefixed + value.slice(blockEnd);
      newCursorStart = lineStart;
      newCursorEnd = lineStart + prefixed.length;
    } else if (action.block) {
      // Insert at the start of the line
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const insertion = action.prefix + (selected || 'text') + action.suffix;
      newText = value.slice(0, lineStart) + insertion + value.slice(lineStart + (selected ? selected.length : 0));
      newCursorStart = lineStart + action.prefix.length;
      newCursorEnd = lineStart + action.prefix.length + (selected || 'text').length;
    } else {
      const inner = selected || 'text';
      const insertion = action.prefix + inner + action.suffix;
      newText = value.slice(0, start) + insertion + value.slice(end);
      newCursorStart = start + action.prefix.length;
      newCursorEnd = start + action.prefix.length + inner.length;
    }

    onChange(newText);

    // Restore focus & selection after React re-render
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(newCursorStart, newCursorEnd);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1 rounded-xl border border-gray-200 bg-gray-50 px-2 py-1.5 dark:border-gray-700 dark:bg-gray-800">
        {TOOLBAR_ACTIONS.map((action) => (
          <button
            key={action.title}
            type="button"
            title={action.title}
            onClick={() => applyAction(action)}
            className="rounded-lg px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-white hover:text-indigo-700 hover:shadow-sm dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-indigo-300"
          >
            {action.label}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-gray-400 dark:text-gray-600">Split pane — drag divider to resize</span>
      </div>

      {/* Split pane */}
      <div
        ref={containerRef}
        className="flex overflow-hidden rounded-2xl border border-gray-200 dark:border-gray-700"
        style={{ minHeight }}
      >
        {/* Editor */}
        <div style={{ width: `${leftWidthPct}%`, minWidth: 0 }} className="flex flex-col">
          <div className="border-b border-gray-200 bg-gray-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:border-gray-700 dark:bg-gray-800">
            Editor
          </div>
          <textarea
            ref={textareaRef}
            className="flex-1 resize-none bg-gray-50 px-3 py-3 font-mono text-sm text-gray-900 focus:outline-none dark:bg-gray-800 dark:text-white"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder ?? '# Start writing…'}
            style={{ minHeight: minHeight - 28 }}
          />
        </div>

        {/* Draggable divider */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panes"
          onMouseDown={onDividerMouseDown}
          className="group relative flex w-2 cursor-col-resize items-center justify-center border-x border-gray-200 bg-gray-100 hover:bg-indigo-100 dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-indigo-900/40"
        >
          <div className="h-8 w-0.5 rounded-full bg-gray-300 group-hover:bg-indigo-400 dark:bg-gray-600 dark:group-hover:bg-indigo-500" />
        </div>

        {/* Preview */}
        <div style={{ width: `${100 - leftWidthPct}%`, minWidth: 0 }} className="flex flex-col overflow-hidden">
          <div className="border-b border-gray-200 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:border-gray-700 dark:bg-gray-900">
            Preview
          </div>
          <div className="flex-1 overflow-y-auto bg-white px-4 py-3 dark:bg-gray-900" style={{ minHeight: minHeight - 28 }}>
            {value.trim() ? (
              <div className="prose prose-sm max-w-none dark:prose-invert prose-headings:font-semibold prose-a:text-indigo-500 prose-code:text-pink-600 dark:prose-code:text-pink-400">
                <ReactMarkdown>{value}</ReactMarkdown>
              </div>
            ) : (
              <p className="text-sm text-gray-400 dark:text-gray-600">Preview will appear here as you type…</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
