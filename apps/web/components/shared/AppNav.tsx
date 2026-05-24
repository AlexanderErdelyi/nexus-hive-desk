'use client';

import Link from 'next/link';
import { Menu, X } from 'lucide-react';
import { useState } from 'react';
import { ThemeToggle } from '@/components/ThemeToggle';
import { UserMenu } from '@/components/auth/UserMenu';
import { TourButton } from '@/components/tour/TourButton';

const NAV_LINKS = [
  { href: '/dashboard', label: 'Dashboard', 'data-tour': undefined },
  { href: '/projects', label: 'Projects', 'data-tour': 'nav-projects' },
  { href: '/customers', label: 'Customers', 'data-tour': undefined },
  { href: '/agents', label: 'Agents', 'data-tour': 'nav-agents' },
  { href: '/settings', label: 'Settings', 'data-tour': 'nav-settings' },
];

export function AppNav() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <nav className="border-b border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
      <div className="flex items-center gap-3 px-4 py-3 sm:px-6">
        {/* Logo */}
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600">
            <span className="text-sm font-bold text-white">N</span>
          </div>
          <span className="text-lg font-semibold text-gray-900 dark:text-white">NexusHiveDesk</span>
        </div>

        <span className="hidden text-gray-300 dark:text-gray-700 md:block">|</span>

        {/* Desktop nav links */}
        <div className="hidden items-center gap-1 md:flex">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              data-tour={link['data-tour']}
              className="rounded-lg px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white"
            >
              {link.label}
            </Link>
          ))}
        </div>

        {/* Right side */}
        <div className="ml-auto flex items-center gap-2">
          <TourButton />
          <UserMenu />
          <ThemeToggle />
          {/* Hamburger — visible below md */}
          <button
            onClick={() => setMobileOpen((v) => !v)}
            aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={mobileOpen}
            className="min-h-[44px] min-w-[44px] rounded-lg p-2 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800 md:hidden"
          >
            {mobileOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>

      {/* Mobile dropdown */}
      {mobileOpen && (
        <div className="border-t border-gray-100 bg-white px-4 py-2 dark:border-gray-800 dark:bg-gray-900 md:hidden">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              data-tour={link['data-tour']}
              onClick={() => setMobileOpen(false)}
              className="block min-h-[44px] rounded-lg px-3 py-3 text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              {link.label}
            </Link>
          ))}
        </div>
      )}
    </nav>
  );
}
