'use client';

import Link from 'next/link';
import { CheckCircle2, Loader2, X, Zap } from 'lucide-react';
import { useBulkTranslate } from '@/lib/bulk-translate-context';

export function BulkTranslateBar() {
  const { isRunning, isDone, progress, xliffFileId, projectId, xliffFilename, cancel, clear, errorMessage } =
    useBulkTranslate();

  if (!isRunning && !isDone) return null;

  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const isError = !!errorMessage;

  return (
    <div
      className={`fixed bottom-0 left-0 right-0 z-50 border-t shadow-lg ${
        isError
          ? 'border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950'
          : 'border-orange-200 bg-orange-50 dark:border-orange-800 dark:bg-orange-950'
      }`}
    >
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-2.5">
        {isRunning ? (
          <Loader2 size={14} className="shrink-0 animate-spin text-orange-500" />
        ) : isError ? (
          <Zap size={14} className="shrink-0 text-red-500" />
        ) : (
          <CheckCircle2 size={14} className="shrink-0 text-green-500" />
        )}

        <span
          className={`text-sm font-medium ${
            isError ? 'text-red-800 dark:text-red-300' : 'text-orange-800 dark:text-orange-300'
          }`}
        >
          {isError
            ? 'Translation error'
            : isRunning
              ? `Translating${xliffFilename ? ` ${xliffFilename}` : ''}…`
              : `Translation complete${xliffFilename ? ` — ${xliffFilename}` : ''}`}
        </span>

        {!isError && (
          <>
            <div className="max-w-xs flex-1">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-orange-200 dark:bg-orange-900">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${isDone ? 'bg-green-500' : 'bg-orange-500'}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>

            <span className="font-mono text-xs text-orange-700 dark:text-orange-400">
              {progress.done.toLocaleString()}/{progress.total.toLocaleString()} ({pct}%)
            </span>
          </>
        )}

        {isError && (
          <span className="text-xs text-red-600 dark:text-red-400">{errorMessage}</span>
        )}

        {projectId && xliffFileId && (
          <Link
            href={`/projects/${projectId}/translations?xliffFileId=${xliffFileId}`}
            className="text-xs underline text-orange-600 hover:text-orange-800 dark:text-orange-400 dark:hover:text-orange-200"
          >
            View results
          </Link>
        )}

        <button
          type="button"
          onClick={isRunning ? cancel : clear}
          className="ml-auto text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          title={isRunning ? 'Cancel' : 'Dismiss'}
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
