'use client';

import { UserProfile } from '@/components/settings/UserProfile';
import { UserTokens } from '@/components/settings/UserTokens';

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <h1 className="mb-6 text-2xl font-bold text-gray-900 dark:text-white">Settings</h1>
      <UserProfile />
      <UserTokens />
    </div>
  );
}
