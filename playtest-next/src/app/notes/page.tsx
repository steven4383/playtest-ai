import type { Metadata } from 'next';
import { NotesPage } from '@/dashboard/pages/NotesPage';

export const metadata: Metadata = { title: 'Notes' };
// Rendered in the browser (see src/dashboard/Shell.tsx) — nothing to validate for instant navigation.
export const instant = false;

export default function Page() {
  return <NotesPage />;
}
