'use client';

import { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';

export function OfflineBanner() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    // Set initial state
    setOffline(!navigator.onLine);

    function handleOffline() { setOffline(true); }
    function handleOnline() { setOffline(false); }

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, []);

  if (!offline) return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-amber-300 bg-amber-50 px-4 py-2 shadow-lg dark:border-amber-700 dark:bg-amber-900/40">
      <WifiOff size={14} className="text-amber-600 dark:text-amber-400" />
      <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
        You&apos;re offline — some features may be unavailable
      </span>
    </div>
  );
}
