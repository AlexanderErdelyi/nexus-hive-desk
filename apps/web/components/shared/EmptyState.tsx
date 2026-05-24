import { type LucideIcon } from 'lucide-react';

interface EmptyStateProps {
  /** Emoji string or a Lucide icon component */
  icon: string | LucideIcon;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
  className?: string;
}

export function EmptyState({ icon, title, description, action, className = '' }: EmptyStateProps) {
  const IconComponent = typeof icon !== 'string' ? icon : null;

  return (
    <div
      className={`flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-200 bg-white py-16 text-center dark:border-gray-700 dark:bg-gray-900 ${className}`}
    >
      <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800">
        {IconComponent ? (
          <IconComponent size={28} className="text-gray-400 dark:text-gray-500" />
        ) : (
          <span className="text-2xl">{icon as string}</span>
        )}
      </div>
      <p className="text-sm font-semibold text-gray-700 dark:text-gray-300">{title}</p>
      {description && (
        <p className="mt-1 max-w-xs text-xs text-gray-400 dark:text-gray-500">{description}</p>
      )}
      {action && (
        <button
          onClick={action.onClick}
          className="mt-4 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-700"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
