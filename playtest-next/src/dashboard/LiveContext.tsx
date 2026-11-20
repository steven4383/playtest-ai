'use client';
import { createContext, useContext, type ReactNode } from 'react';
import type { Live } from './lib/useLive';

/** One live connection (SSE /events) for the whole dashboard, shared by every page. */
const Ctx = createContext<Live | null>(null);

export function LiveProvider({ live, children }: { live: Live; children: ReactNode }) {
  return <Ctx.Provider value={live}>{children}</Ctx.Provider>;
}

export function useLiveContext(): Live {
  const live = useContext(Ctx);
  if (!live) throw new Error('useLiveContext must be used inside the dashboard shell');
  return live;
}
