import type { Metadata } from 'next';
import { ReleasesPage } from '@/dashboard/pages/ReleasesPage';

export const metadata: Metadata = { title: 'Releases' };
// Rendered in the browser (see src/dashboard/Shell.tsx) — nothing to validate for instant navigation.
export const instant = false;

export default function Page() {
  return <ReleasesPage />;
}
