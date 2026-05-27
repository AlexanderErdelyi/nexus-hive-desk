import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Toaster } from 'sonner';
import './globals.css';
import { Providers } from './providers';
import { AuthGuard } from '@/components/auth/AuthGuard';
import { GuidedTour } from '@/components/tour/GuidedTour';
import { AppNav } from '@/components/shared/AppNav';
import { BulkTranslateBar } from '@/components/shared/BulkTranslateBar';
import { KeyboardShortcutsProvider } from '@/components/shared/KeyboardShortcutsProvider';
import { OfflineBanner } from '@/components/shared/OfflineBanner';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'NexusHiveDesk',
  description: 'AI-powered translation management and developer workflow hub',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className}>
        <Providers>
          <KeyboardShortcutsProvider>
          <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
            <AppNav />
            <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
              <AuthGuard>{children}</AuthGuard>
            </main>
            <GuidedTour />
            <OfflineBanner />
            <BulkTranslateBar />
          </div>
          </KeyboardShortcutsProvider>
        </Providers>
        <Toaster richColors position="top-right" theme="system" />
      </body>
    </html>
  );
}
