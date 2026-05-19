'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, GitBranch, Plus, Trash2, Settings, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';

interface Connection {
  id: string;
  customerId: string;
  type: 'azure-devops' | 'github';
  name: string;
  baseUrl?: string;
  createdAt: string;
}

interface Customer {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  connections?: Connection[];
  projects?: Array<{ id: string; name: string }>;
  _count?: { connections: number; projects: number };
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Request failed';
}

export function CustomersList() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', description: '' });

  const { data, isLoading } = useQuery({
    queryKey: ['customers'],
    queryFn: () => api.get<{ data: Customer[] }>('/api/customers'),
  });

  const createMutation = useMutation({
    mutationFn: (input: typeof form) => api.post('/api/customers', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customers'] });
      setShowCreate(false);
      setForm({ name: '', description: '' });
      toast.success('Customer created');
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/customers/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customers'] });
      toast.success('Customer deleted');
    },
  });

  const customers = data?.data ?? [];

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Customers</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          <Plus size={16} /> New Customer
        </button>
      </div>

      {showCreate && (
        <div className="mb-6 rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-900">
          <h3 className="mb-4 font-semibold text-gray-900 dark:text-white">Create Customer</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Name *</label>
              <input
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Acme Corp"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Description</label>
              <input
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
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
      ) : customers.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white py-12 text-center dark:border-gray-700 dark:bg-gray-900">
          <Building2 size={40} className="mx-auto mb-3 text-gray-300 dark:text-gray-600" />
          <p className="text-gray-500 dark:text-gray-400">No customers yet. Create your first customer.</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {customers.map((c) => (
            <div
              key={c.id}
              className="rounded-xl border border-gray-200 bg-white p-5 transition-colors hover:border-indigo-300 dark:border-gray-700 dark:bg-gray-900 dark:hover:border-indigo-500"
            >
              <div className="flex items-start justify-between">
                <div className="min-w-0 flex-1">
                  <a
                    href={`/customers/${c.id}`}
                    className="block truncate font-semibold text-gray-900 hover:text-indigo-600 dark:text-white dark:hover:text-indigo-400"
                  >
                    {c.name}
                  </a>
                  {c.description && (
                    <p className="mt-1 truncate text-sm text-gray-500 dark:text-gray-400">{c.description}</p>
                  )}
                </div>
                <button
                  onClick={() => {
                    if (confirm('Delete customer? This will remove all connections.')) deleteMutation.mutate(c.id);
                  }}
                  className="ml-2 flex-shrink-0 text-gray-400 hover:text-red-500 dark:text-gray-600 dark:hover:text-red-400"
                >
                  <Trash2 size={15} />
                </button>
              </div>
              <div className="mt-3 flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
                <span className="flex items-center gap-1">
                  <GitBranch size={12} /> {c._count?.connections ?? 0} connection(s)
                </span>
                <span>{c._count?.projects ?? 0} project(s)</span>
              </div>
              <div className="mt-2 text-xs text-gray-400 dark:text-gray-600">{formatDate(c.createdAt)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
