import type { Metadata } from 'next';
import { PersonalPage } from '@/dashboard/pages/PersonalPage';

export const metadata: Metadata = { title: 'Personal space' };
// Rendered in the browser (see src/dashboard/Shell.tsx) — nothing to validate for instant navigation.
export const instant = false;

export default function Page() {
  return <PersonalPage />;
}
