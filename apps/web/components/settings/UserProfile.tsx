'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';

function getErrMsg(e: unknown) {
  return e instanceof Error ? e.message : 'Request failed';
}

export function UserProfile() {
  const { user, login } = useAuth();
  const [name, setName] = useState(user?.name ?? '');
  const [nameLoading, setNameLoading] = useState(false);

  const [pwForm, setPwForm] = useState({ current: '', next: '', confirm: '' });
  const [pwLoading, setPwLoading] = useState(false);

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || name.trim() === user?.name) return;
    setNameLoading(true);
    try {
      await api.patch('/api/auth/me', { name: name.trim() });
      toast.success('Name updated');
      // Re-fetch user by re-triggering auth context (reload page approach)
      window.location.reload();
    } catch (err) {
      toast.error(getErrMsg(err));
    } finally {
      setNameLoading(false);
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (pwForm.next !== pwForm.confirm) {
      toast.error('New passwords do not match');
      return;
    }
    if (pwForm.next.length < 8) {
      toast.error('New password must be at least 8 characters');
      return;
    }
    setPwLoading(true);
    try {
      await api.post('/api/auth/change-password', {
        currentPassword: pwForm.current,
        newPassword: pwForm.next,
      });
      toast.success('Password changed successfully');
      setPwForm({ current: '', next: '', confirm: '' });
    } catch (err) {
      toast.error(getErrMsg(err));
    } finally {
      setPwLoading(false);
    }
  }

  if (!user) return null;

  return (
    <div className="space-y-6">
      {/* Profile */}
      <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-900">
        <h2 className="mb-4 text-base font-semibold text-gray-900 dark:text-white">Profile</h2>
        <form onSubmit={saveName} className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
              Email
            </label>
            <input
              type="email"
              disabled
              value={user.email}
              className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-400"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
              Display Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            />
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={nameLoading || !name.trim() || name.trim() === user.name}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {nameLoading ? 'Saving…' : 'Save Name'}
            </button>
          </div>
        </form>
      </div>

      {/* Change password */}
      <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-900">
        <h2 className="mb-4 text-base font-semibold text-gray-900 dark:text-white">Change Password</h2>
        <form onSubmit={changePassword} className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
              Current Password
            </label>
            <input
              type="password"
              autoComplete="current-password"
              value={pwForm.current}
              onChange={(e) => setPwForm((f) => ({ ...f, current: e.target.value }))}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
              New Password
            </label>
            <input
              type="password"
              autoComplete="new-password"
              value={pwForm.next}
              onChange={(e) => setPwForm((f) => ({ ...f, next: e.target.value }))}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
              Confirm New Password
            </label>
            <input
              type="password"
              autoComplete="new-password"
              value={pwForm.confirm}
              onChange={(e) => setPwForm((f) => ({ ...f, confirm: e.target.value }))}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            />
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={pwLoading || !pwForm.current || !pwForm.next || !pwForm.confirm}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {pwLoading ? 'Changing…' : 'Change Password'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
