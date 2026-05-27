'use client';

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { getAuthHeaders } from './api';

const API_URL = '';
const BATCH_SIZE = 60; // keep in sync with server

export interface BulkResult {
  id: string;
  suggestedTarget: string;
  confidenceScore: number;
  confidence: string;
}

interface BulkTranslateState {
  isRunning: boolean;
  progress: { done: number; total: number };
  results: BulkResult[];
  isDone: boolean;
  xliffFileId: string | null;
  projectId: string | null;
  xliffFilename: string | null;
  errorMessage: string | null;
}

interface BulkTranslateContextType extends BulkTranslateState {
  start(params: { projectId: string; xliffFileId: string; xliffFilename: string; limit?: number }): void;
  cancel(): void;
  clear(): void;
}

const BulkTranslateContext = createContext<BulkTranslateContextType | null>(null);

const INITIAL_STATE: BulkTranslateState = {
  isRunning: false,
  progress: { done: 0, total: 0 },
  results: [],
  isDone: false,
  xliffFileId: null,
  projectId: null,
  xliffFilename: null,
  errorMessage: null,
};

export function BulkTranslateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<BulkTranslateState>(INITIAL_STATE);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(
    async (params: { projectId: string; xliffFileId: string; xliffFilename: string; limit?: number }) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setState({
        isRunning: true,
        progress: { done: 0, total: 0 },
        results: [],
        isDone: false,
        xliffFileId: params.xliffFileId,
        projectId: params.projectId,
        xliffFilename: params.xliffFilename,
        errorMessage: null,
      });

      try {
        const res = await fetch(`${API_URL}/api/ai/translate-stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({
            projectId: params.projectId,
            xliffFileId: params.xliffFileId,
            ...(params.limit ? { limit: params.limit } : {}),
          }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          let errMsg = 'Failed to start bulk translation';
          try {
            const errJson = (await res.json()) as { message?: string };
            if (errJson.message) errMsg = errJson.message;
          } catch { /* ignore */ }
          throw new Error(errMsg);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const event = JSON.parse(line.slice(6)) as {
                type: string;
                total?: number;
                done?: number;
                results?: BulkResult[];
                message?: string;
                waitMs?: number;
                attempt?: number;
              };

              if (event.type === 'start') {
                setState((s) => ({ ...s, progress: { done: 0, total: event.total ?? 0 } }));
              } else if (event.type === 'progress') {
                setState((s) => ({
                  ...s,
                  progress: { done: event.done ?? 0, total: s.progress.total },
                  results: [...s.results, ...(event.results ?? [])],
                }));
              } else if (event.type === 'retry') {
                const waitSec = Math.round((event.waitMs ?? 30_000) / 1000);
                toast.info(`AI rate limit — retrying in ${waitSec}s (attempt ${event.attempt ?? 1}/3)`);
              } else if (event.type === 'complete') {
                setState((s) => ({
                  ...s,
                  isRunning: false,
                  isDone: true,
                  progress: { done: event.done ?? s.progress.total, total: s.progress.total },
                }));
                toast.success(`Bulk translation done — ${event.done} strings ready to review`);
              } else if (event.type === 'error') {
                const msg = event.message ?? 'Bulk translation failed';
                setState((s) => ({ ...s, isRunning: false, isDone: true, errorMessage: msg }));
                toast.error(msg);
              }
            } catch { /* skip malformed SSE line */ }
          }
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          setState((s) => ({ ...s, isRunning: false }));
          toast.info('Bulk translation cancelled');
        } else {
          const msg = error instanceof Error ? error.message : 'Bulk translation failed';
          setState((s) => ({ ...s, isRunning: false, isDone: true, errorMessage: msg }));
          toast.error(msg);
        }
      }
    },
    []
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setState((s) => ({ ...s, isRunning: false }));
  }, []);

  const clear = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  return (
    <BulkTranslateContext.Provider value={{ ...state, start, cancel, clear }}>
      {children}
    </BulkTranslateContext.Provider>
  );
}

export function useBulkTranslate() {
  const ctx = useContext(BulkTranslateContext);
  if (!ctx) throw new Error('useBulkTranslate must be used within BulkTranslateProvider');
  return ctx;
}

/** Estimated number of AI batches for a given string count */
export function estimateBatches(count: number) {
  return Math.ceil(count / BATCH_SIZE);
}

/** Estimated duration string (e.g. "~2 min" or "~45 sec") */
export function estimateDuration(count: number) {
  const batches = estimateBatches(count);
  const seconds = batches * 4;
  if (seconds < 90) return `~${seconds} sec`;
  return `~${Math.round(seconds / 60)} min`;
}
