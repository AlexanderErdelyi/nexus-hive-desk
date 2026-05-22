'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';

interface InviteInfo {
  project: { id: string; name: string };
  role: string;
  email: string | null;
}

function RoleBadge({ role }: { role: string }) {
  const colors: Record<string, string> = {
    admin: 'bg-red-100 text-red-700',
    editor: 'bg-blue-100 text-blue-700',
    translator: 'bg-green-100 text-green-700',
    viewer: 'bg-gray-100 text-gray-700',
  };
  return (
    <span className={`rounded px-2 py-0.5 text-sm font-medium ${colors[role] ?? colors.viewer}`}>
      {role}
    </span>
  );
}

export default function InviteAcceptPage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const { user, isLoading: authLoading } = useAuth();

  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'accepting' | 'done'>('loading');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    fetch(`/api/invite/${token}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) {
          setErrorMsg(data.message ?? 'Invalid or expired invite link');
          setStatus('error');
          return;
        }
        setInvite(data.data);
        setStatus('ready');
      })
      .catch(() => {
        setErrorMsg('Failed to load invite');
        setStatus('error');
      });
  }, [token]);

  async function handleAccept() {
    if (!user) {
      // Store token in session storage and redirect to login
      sessionStorage.setItem('pendingInviteToken', token);
      router.push(`/login?redirect=/invite/${token}`);
      return;
    }
    setStatus('accepting');
    try {
      await api.post(`/api/invite/${token}/accept`, {});
      toast.success(`Joined ${invite?.project.name} as ${invite?.role}`);
      router.push(`/projects/${invite?.project.id}`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to accept invite');
      setStatus('error');
    }
  }

  if (authLoading || status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
        <div className="text-sm text-gray-500 dark:text-gray-400">Loading invite…</div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
        <div className="rounded-xl border border-red-200 bg-white p-8 text-center shadow dark:border-red-800 dark:bg-gray-900">
          <div className="mb-2 text-2xl">⚠️</div>
          <h1 className="mb-2 text-lg font-semibold text-gray-900 dark:text-white">Invite Unavailable</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">{errorMsg}</p>
          <button
            onClick={() => router.push('/')}
            className="mt-6 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            Go Home
          </button>
        </div>
      </div>
    );
  }

  if (status === 'done') return null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
      <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-8 shadow dark:border-gray-700 dark:bg-gray-900">
        <div className="mb-6 text-center">
          <div className="mb-3 text-4xl">🎉</div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">You&apos;ve been invited!</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Join <strong className="text-gray-900 dark:text-white">{invite?.project.name}</strong> as a{' '}
            <RoleBadge role={invite?.role ?? 'viewer'} />
          </p>
          {invite?.email && (
            <p className="mt-2 text-xs text-gray-400">This invite is restricted to: {invite.email}</p>
          )}
        </div>

        {!user ? (
          <div className="space-y-3">
            <p className="text-center text-sm text-gray-600 dark:text-gray-400">
              Sign in or create an account to accept this invite.
            </p>
            <button
              onClick={handleAccept}
              className="w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
            >
              Sign In to Accept
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-center text-sm text-gray-600 dark:text-gray-400">
              Accepting as <strong>{user.name}</strong> ({user.email})
            </p>
            <button
              onClick={handleAccept}
              disabled={status === 'accepting'}
              className="w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {status === 'accepting' ? 'Joining…' : `Join ${invite?.project.name}`}
            </button>
            <button
              onClick={() => router.push('/')}
              className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              Decline
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
