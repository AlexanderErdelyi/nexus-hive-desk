'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Link, Plus, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';

interface Member {
  id: string;
  userId: string;
  projectId: string;
  role: string;
  user: { id: string; email: string; name: string };
}

interface Invite {
  id: string;
  token: string;
  role: string;
  email: string | null;
  expiresAt: string;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Request failed';
}

function RoleBadge({ role }: { role: string }) {
  const colors: Record<string, string> = {
    admin: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
    editor: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    translator: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    viewer: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
  };
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${colors[role] ?? colors.viewer}`}>
      {role}
    </span>
  );
}

export function ProjectMembers({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [form, setForm] = useState({ email: '', role: 'viewer' });
  const [inviteForm, setInviteForm] = useState({ role: 'translator', email: '' });
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['project-members', projectId],
    queryFn: () => api.get<{ data: Member[] }>(`/api/projects/${projectId}/members`),
  });

  const { data: invitesData } = useQuery({
    queryKey: ['project-invites', projectId],
    queryFn: () => api.get<{ data: Invite[] }>(`/api/projects/${projectId}/invites`),
  });

  const addMutation = useMutation({
    mutationFn: (input: typeof form) =>
      api.post(`/api/projects/${projectId}/members`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project-members', projectId] });
      setShowAdd(false);
      setForm({ email: '', role: 'viewer' });
      toast.success('Member added');
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const updateRoleMutation = useMutation({
    mutationFn: ({ memberId, role }: { memberId: string; role: string }) =>
      api.patch(`/api/projects/${projectId}/members/${memberId}`, { role }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project-members', projectId] });
      toast.success('Role updated');
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const removeMutation = useMutation({
    mutationFn: (memberId: string) =>
      api.delete(`/api/projects/${projectId}/members/${memberId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project-members', projectId] });
      toast.success('Member removed');
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const createInviteMutation = useMutation({
    mutationFn: (body: { role: string; email?: string }) =>
      api.post<{ data: Invite }>(`/api/projects/${projectId}/invites`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project-invites', projectId] });
      toast.success('Invite link created');
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const revokeInviteMutation = useMutation({
    mutationFn: (inviteId: string) =>
      api.delete(`/api/projects/${projectId}/invites/${inviteId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project-invites', projectId] });
      toast.success('Invite revoked');
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  function copyInviteLink(token: string) {
    const url = `${window.location.origin}/invite/${token}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedToken(token);
      setTimeout(() => setCopiedToken(null), 2000);
    });
  }

  const members = data?.data ?? [];
  const invites = invitesData?.data ?? [];

  return (
    <div className="space-y-4">
      {/* Members list */}
      <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-900">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="flex items-center gap-2 font-semibold text-gray-900 dark:text-white">
            <Users size={18} /> Project Members
          </h3>
          <div className="flex gap-2">
            <button
              onClick={() => { setShowInvite(true); setShowAdd(false); }}
              className="flex items-center gap-1 rounded-lg border border-indigo-300 px-3 py-1.5 text-xs font-medium text-indigo-600 hover:bg-indigo-50 dark:border-indigo-700 dark:text-indigo-400 dark:hover:bg-indigo-900/20"
            >
              <Link size={14} /> Invite Link
            </button>
            <button
              onClick={() => { setShowAdd(true); setShowInvite(false); }}
              className="flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
            >
              <Plus size={14} /> Add Member
            </button>
          </div>
        </div>

        {/* Add by email form */}
        {showAdd && (
          <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-600 dark:bg-gray-800">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Email</label>
                <input
                  type="email"
                  className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  placeholder="user@example.com"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Role</label>
                <select
                  className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                  value={form.role}
                  onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
                >
                  <option value="viewer">Viewer</option>
                  <option value="translator">Translator</option>
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

        {/* Invite link form */}
        {showInvite && (
          <div className="mb-4 rounded-lg border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-800 dark:bg-indigo-900/20">
            <p className="mb-3 text-xs text-indigo-700 dark:text-indigo-300">
              Generate a link anyone (or a specific email) can use to join this project.
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                  Restrict to email (optional)
                </label>
                <input
                  type="email"
                  className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                  value={inviteForm.email}
                  onChange={(e) => setInviteForm((f) => ({ ...f, email: e.target.value }))}
                  placeholder="Leave blank for open link"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Role</label>
                <select
                  className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                  value={inviteForm.role}
                  onChange={(e) => setInviteForm((f) => ({ ...f, role: e.target.value }))}
                >
                  <option value="viewer">Viewer</option>
                  <option value="translator">Translator</option>
                  <option value="editor">Editor</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() =>
                  createInviteMutation.mutate({
                    role: inviteForm.role,
                    email: inviteForm.email || undefined,
                  })
                }
                disabled={createInviteMutation.isPending}
                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {createInviteMutation.isPending ? 'Creating...' : 'Create Link'}
              </button>
              <button
                onClick={() => setShowInvite(false)}
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
            No members assigned to this project yet.
          </div>
        ) : (
          <div className="space-y-2">
            {members.map((m) => (
              <div
                key={m.id}
                className="flex items-center justify-between rounded-lg border border-gray-100 px-4 py-3 dark:border-gray-700"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-gray-900 dark:text-white">{m.user.name}</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">{m.user.email}</div>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    className="rounded border border-gray-200 bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
                    value={m.role}
                    onChange={(e) => updateRoleMutation.mutate({ memberId: m.id, role: e.target.value })}
                  >
                    <option value="viewer">Viewer</option>
                    <option value="translator">Translator</option>
                    <option value="editor">Editor</option>
                    <option value="admin">Admin</option>
                  </select>
                  <button
                    onClick={() => { if (confirm('Remove this member?')) removeMutation.mutate(m.id); }}
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

      {/* Active invite links */}
      {invites.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-900">
          <h3 className="mb-3 flex items-center gap-2 font-semibold text-gray-900 dark:text-white">
            <Link size={16} /> Active Invite Links
          </h3>
          <div className="space-y-2">
            {invites.map((inv) => (
              <div
                key={inv.id}
                className="flex items-center justify-between rounded-lg border border-gray-100 px-4 py-3 dark:border-gray-700"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <RoleBadge role={inv.role} />
                    {inv.email && (
                      <span className="text-xs text-gray-500 dark:text-gray-400">→ {inv.email}</span>
                    )}
                    {!inv.email && (
                      <span className="text-xs text-gray-400 dark:text-gray-500">open link</span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-gray-400">
                    Expires {new Date(inv.expiresAt).toLocaleDateString()}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => copyInviteLink(inv.token)}
                    className="flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
                  >
                    {copiedToken === inv.token ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
                    {copiedToken === inv.token ? 'Copied!' : 'Copy'}
                  </button>
                  <button
                    onClick={() => { if (confirm('Revoke this invite?')) revokeInviteMutation.mutate(inv.id); }}
                    className="text-gray-400 hover:text-red-500 dark:text-gray-600 dark:hover:text-red-400"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
