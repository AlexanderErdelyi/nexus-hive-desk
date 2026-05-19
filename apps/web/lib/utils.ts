import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(date: string | Date) {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date));
}

export function getStateColor(state: string): string {
  const map: Record<string, string> = {
    new: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
    'needs-translation': 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
    'needs-review-translation': 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
    translated: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    final: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    'signed-off': 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  };
  return map[state] ?? 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
}

export function getStateLabel(state: string): string {
  const map: Record<string, string> = {
    new: 'New',
    'needs-translation': 'Needs Translation',
    'needs-review-translation': 'Needs Review',
    translated: 'Translated',
    final: 'Final',
    'signed-off': 'Signed Off',
  };
  return map[state] ?? state;
}
