'use client';

import { useAuth } from '@/lib/auth-context';
import { LogOut, User } from 'lucide-react';
import { useRouter } from 'next/navigation';

export function UserMenu() {
  const { user, logout } = useAuth();
  const router = useRouter();

  if (!user) return null;

  const handleLogout = () => {
    logout();
    router.push('/login');
  };

  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
        <User size={16} />
        <span>{user.name}</span>
      </div>
      <button
        onClick={handleLogout}
        className="flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
        title="Sign out"
      >
        <LogOut size={14} />
      </button>
    </div>
  );
}
