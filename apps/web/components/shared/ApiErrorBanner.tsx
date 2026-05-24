'use client';

import { useState } from 'react';
import { AlertCircle, X } from 'lucide-react';

interface ApiErrorBannerProps {
  message: string;
  onRetry?: () => void;
  onDismiss?: () => void;
}

export function ApiErrorBanner({ message, onRetry, onDismiss }: ApiErrorBannerProps) {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  function handleDismiss() {
    setDismissed(true);
    onDismiss?.();
  }

  return (
    <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm dark:border-red-800/40 dark:bg-red-900/10">
      <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-500" />
      <span className="flex-1 text-red-700 dark:text-red-300">{message}</span>
      <div className="flex shrink-0 items-center gap-2">
        {onRetry && (
          <button
            onClick={onRetry}
            className="rounded px-2 py-0.5 text-xs font-medium text-red-600 hover:bg-red-100 dark:text-red-400 dark:hover:bg-red-900/30"
          >
            Retry
          </button>
        )}
        <button
          onClick={handleDismiss}
          className="rounded p-0.5 text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
