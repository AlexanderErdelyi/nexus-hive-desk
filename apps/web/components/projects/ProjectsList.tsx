'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderOpen, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';

interface Customer {
  id: string;
  name: string;
}

interface Project {
  id: string;
  name: string;
  description?: string;
  customerId?: string | null;
  customer?: { id: string; name: string } | null;
  sourceLanguage: string;
  targetLanguage: string;
  createdAt: string;
  _count?: { xliffFiles: number };
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Request failed';
}

export function ProjectsList({ defaultCustomerId }: { defaultCustomerId?: string }) {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(!!defaultCustomerId);
  const [form, setForm] = useState({ name: '', description: '', customerId: defaultCustomerId ?? '', capabilities: 'translation' });
  const [customerFilter, setCustomerFilter] = useState('');

  const { data: customersData } = useQuery({
    queryKey: ['customers'],
    queryFn: () => api.get<{ data: Customer[] }>('/api/customers'),
  });

  const { data, isLoading } = useQuery({
    queryKey: ['projects', customerFilter],
    queryFn: () => {
      const params = customerFilter ? `?customerId=${customerFilter}` : '';
      return api.get<{ data: Project[] }>(`/api/projects${params}`);
    },
  });

  const createMutation = useMutation({
    mutationFn: (input: typeof form) => {
      const { customerId, ...rest } = input;
      return api.post('/api/projects', { ...rest, customerId: customerId || undefined });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      setShowCreate(false);
      setForm({ name: '', description: '', customerId: '', capabilities: 'translation' });
      toast.success('Project created');
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/projects/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      toast.success('Project deleted');
    },
  });

  const projects = data?.data ?? [];
  const customers = customersData?.data ?? [];

  return (
    <div data-tour="project-tabs">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Customer:</label>
          <select
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            value={customerFilter}
            onChange={(e) => setCustomerFilter(e.target.value)}
          >
            <option value="">All</option>
            <option value="none">Unassigned</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <button
          data-tour="create-project-btn"
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          <Plus size={16} /> New Project
        </button>
      </div>

      {showCreate && (
        <div className="mb-6 rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-900">
          <h3 className="mb-4 font-semibold text-gray-900 dark:text-white">Create Project</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Name *</label>
              <input
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white dark:placeholder-gray-500"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="My BC Module"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Description</label>
              <input
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white dark:placeholder-gray-500"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Customer</label>
              <select
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                value={form.customerId}
                onChange={(e) => setForm((f) => ({ ...f, customerId: e.target.value }))}
              >
                <option value="">None (unassigned)</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">Capabilities</label>
              <div className="flex flex-wrap gap-4">
                {[
                  { id: 'translation', label: 'Translation' },
                  { id: 'user-stories', label: 'Work Items' },
                  { id: 'documentation', label: 'Documentation' },
                ].map((cap) => {
                  const caps = form.capabilities.split(',').map((c) => c.trim()).filter(Boolean);
                  return (
                    <label key={cap.id} className="flex cursor-pointer items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-gray-300 text-indigo-600 dark:border-gray-600"
                        checked={caps.includes(cap.id)}
                        onChange={() => {
                          const next = caps.includes(cap.id) ? caps.filter((c) => c !== cap.id) : [...caps, cap.id];
                          setForm((f) => ({ ...f, capabilities: next.join(',') }));
                        }}
                      />
                      {cap.label}
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="mt-4 flex gap-3">
            <button
              onClick={() => createMutation.mutate(form)}
              disabled={!form.name || createMutation.isPending}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {createMutation.isPending ? 'Creating...' : 'Create'}
            </button>
            <button
              onClick={() => setShowCreate(false)}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="py-12 text-center text-gray-400">Loading...</div>
      ) : projects.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white py-12 text-center dark:border-gray-700 dark:bg-gray-900">
          <FolderOpen size={40} className="mx-auto mb-3 text-gray-300 dark:text-gray-600" />
          <p className="text-gray-500 dark:text-gray-400">No projects yet. Create your first project.</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <div
              key={p.id}
              className="rounded-xl border border-gray-200 bg-white p-5 transition-colors hover:border-indigo-300 dark:border-gray-700 dark:bg-gray-900 dark:hover:border-indigo-500"
            >
              <div className="flex items-start justify-between">
                <div className="min-w-0 flex-1">
                  <a href={`/projects/${p.id}`} className="block truncate font-semibold text-gray-900 hover:text-indigo-600 dark:text-white dark:hover:text-indigo-400">
                    {p.name}
                  </a>
                  {p.description && <p className="mt-1 truncate text-sm text-gray-500 dark:text-gray-400">{p.description}</p>}
                </div>
                <button
                  onClick={() => { if (confirm('Delete project?')) deleteMutation.mutate(p.id); }}
                  className="ml-2 flex-shrink-0 text-gray-400 hover:text-red-500 dark:text-gray-600 dark:hover:text-red-400"
                >
                  <Trash2 size={15} />
                </button>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                {p.customer && (
                  <a
                    href={`/customers/${p.customer.id}`}
                    className="rounded bg-indigo-50 px-2 py-0.5 font-medium text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:text-indigo-400 dark:hover:bg-indigo-900/50"
                  >
                    {p.customer.name}
                  </a>
                )}
                <span>{p._count?.xliffFiles ?? 0} file(s)</span>
              </div>
              <div className="mt-3 text-xs text-gray-400 dark:text-gray-600">{formatDate(p.createdAt)}</div>
              <div className="mt-4 flex gap-2">
                <a href={`/projects/${p.id}/translations`} className="rounded-lg bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:text-indigo-400 dark:hover:bg-indigo-900/50">
                  Translations
                </a>
                <a href={`/projects/${p.id}/glossary`} className="rounded-lg bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700">
                  Glossary
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
