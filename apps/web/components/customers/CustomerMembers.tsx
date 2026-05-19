'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';

interface Member {
  id: string;
  userId: string;
  customerId: string;
  role: string;
  user: { id: string; email: string; name: string };
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Request failed';
}

export function CustomerMembers({ customerId }: { customerId: string }) {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ email: '', role: 'viewer' });

  const { data, isLoading } = useQuery({
    queryKey: ['customer-members', customerId],
    queryFn: () => api.get<{ data: Member[] }>(`/api/customers/${customerId}/members`),
  });

  const addMutation = useMutation({
    mutationFn: (input: typeof form) =>
      api.post(`/api/customers/${customerId}/members`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customer-members', customerId] });
      setShowAdd(false);
      setForm({ email: '', role: 'viewer' });
      toast.success('Member added');
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const updateRoleMutation = useMutation({
    mutationFn: ({ memberId, role }: { memberId: string; role: string }) =>
      api.patch(`/api/customers/${customerId}/members/${memberId}`, { role }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customer-members', customerId] });
      toast.success('Role updated');
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const removeMutation = useMutation({
    mutationFn: (memberId: string) =>
      api.delete(`/api/customers/${customerId}/members/${memberId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customer-members', customerId] });
      toast.success('Member removed');
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const members = data?.data ?? [];

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 font-semibold text-gray-900 dark:text-white">
          <Users size={18} /> Members
        </h3>
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
        >
          <Plus size={14} /> Add Member
        </button>
      </div>

      {showAdd && (
        <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-600 dark:bg-gray-800">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                Email
              </label>
              <input
                type="email"
                className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="user@example.com"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                Role
              </label>
              <select
                className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                value={form.role}
                onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
              >
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
                <option value="admin">Admin</option>
              </select>
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => addMutation.mutate(form)}
              disabled={!form.email || addMutation.isPending}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {addMutation.isPending ? 'Adding...' : 'Add'}
            </button>
            <button
              onClick={() => setShowAdd(false)}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="py-4 text-center text-sm text-gray-400">Loading members...</div>
      ) : members.length === 0 ? (
        <div className="py-4 text-center text-sm text-gray-500 dark:text-gray-400">
          No members yet. Add a member to get started.
        </div>
      ) : (
        <div className="space-y-2">
          {members.map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between rounded-lg border border-gray-100 px-4 py-3 dark:border-gray-700"
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-gray-900 dark:text-white">
                  {m.user.name}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400">{m.user.email}</div>
              </div>
              <div className="flex items-center gap-2">
                <select
                  className="rounded border border-gray-200 bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
                  value={m.role}
                  onChange={(e) =>
                    updateRoleMutation.mutate({ memberId: m.id, role: e.target.value })
                  }
                >
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                  <option value="admin">Admin</option>
                </select>
                <button
                  onClick={() => {
                    if (confirm('Remove this member?')) removeMutation.mutate(m.id);
                  }}
                  className="text-gray-400 hover:text-red-500 dark:text-gray-600 dark:hover:text-red-400"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
