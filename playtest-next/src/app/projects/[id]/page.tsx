import type { Metadata } from 'next';
import { ProjectPage } from '@/dashboard/pages/project/ProjectPage';

export const metadata: Metadata = { title: 'Project' };
// Rendered in the browser (see src/dashboard/Shell.tsx) — nothing to validate for instant navigation.
export const instant = false;

export default function Page() {
  return <ProjectPage />;
}
