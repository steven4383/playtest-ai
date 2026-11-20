'use client';
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/queries';

/**
 * Providers that are safe during server rendering: the server-state cache (TanStack Query). Chakra UI (Emotion
 * styles) is provided by the Shell once the app runs in the browser, so no server/browser style mismatch occurs.
 */
export function Providers({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
