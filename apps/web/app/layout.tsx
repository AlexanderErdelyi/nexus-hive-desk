import type { Metadata } from 'next';
import Link from 'next/link';
import { Inter } from 'next/font/google';
import { Toaster } from 'sonner';
import './globals.css';
import { Providers } from './providers';
import { ThemeToggle } from '@/components/ThemeToggle';

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
          <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
            <nav className="flex items-center gap-3 border-b border-gray-200 bg-white px-6 py-3 dark:border-gray-800 dark:bg-gray-900">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600">
                  <span className="text-sm font-bold text-white">N</span>
                </div>
                <span className="text-lg font-semibold text-gray-900 dark:text-white">NexusHiveDesk</span>
              </div>
              <span className="text-gray-300 dark:text-gray-700">|</span>
              <Link href="/projects" className="text-sm text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white">
                Projects
              </Link>
              <div className="ml-auto">
                <ThemeToggle />
              </div>
            </nav>
            <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
          </div>
        </Providers>
        <Toaster richColors position="top-right" theme="system" />
      </body>
    </html>
  );
}
