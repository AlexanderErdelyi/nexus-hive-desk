'use client';

import { useTour } from './TourContext';

export function TourButton() {
  const { startTour } = useTour();

  return (
    <button
      type="button"
      onClick={() => startTour()}
      className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 px-2.5 py-1.5 text-xs text-gray-500 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
    >
      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-current text-[10px] font-semibold">
        ?
      </span>
      <span>Tour</span>
    </button>
  );
}
