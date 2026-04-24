'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useSettingsStore } from '@/lib/store/settings';

/**
 * Fetches server-configured providers on mount and merges into settings store.
 * Renders nothing — purely a side-effect component.
 */
export function ServerProvidersInit() {
  const fetchServerProviders = useSettingsStore((state) => state.fetchServerProviders);
  const pathname = usePathname();

  useEffect(() => {
    if (pathname === '/login' || pathname === '/register') {
      return;
    }
    fetchServerProviders();
  }, [fetchServerProviders, pathname]);

  return null;
}
