import type { Metadata } from 'next';
import { ProjectsPage } from '@/dashboard/pages/ProjectsPage';

export const metadata: Metadata = { title: 'Projects' };
// Rendered in the browser (see src/dashboard/Shell.tsx) — nothing to validate for instant navigation.
export const instant = false;

export default function Page() {
  return <ProjectsPage />;
}
