import type { Metadata } from 'next';
import { TasksPage } from '@/dashboard/pages/TasksPage';

export const metadata: Metadata = { title: 'Tasks' };
// Rendered in the browser (see src/dashboard/Shell.tsx) — nothing to validate for instant navigation.
export const instant = false;

export default function Page() {
  return <TasksPage />;
}
