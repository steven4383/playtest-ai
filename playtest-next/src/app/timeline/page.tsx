import type { Metadata } from 'next';
import { TimelinePage } from '@/dashboard/pages/TimelinePage';

export const metadata: Metadata = { title: 'Timeline' };
// Rendered in the browser (see src/dashboard/Shell.tsx) — nothing to validate for instant navigation.
export const instant = false;

export default function Page() {
  return <TimelinePage />;
}
