'use client';

import React from 'react';
import { AlertTriangle } from 'lucide-react';

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex flex-col items-center justify-center rounded-xl border border-red-200 bg-red-50 px-6 py-12 text-center dark:border-red-800/40 dark:bg-red-900/10">
          <AlertTriangle size={32} className="mb-3 text-red-400" />
          <p className="text-sm font-semibold text-red-700 dark:text-red-300">Something went wrong</p>
          <p className="mt-1 max-w-xs text-xs text-red-500 dark:text-red-400">
            {this.state.error?.message ?? 'An unexpected error occurred.'}
          </p>
          <button
            className="mt-4 rounded-lg bg-red-600 px-4 py-2 text-xs font-medium text-white hover:bg-red-700"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
