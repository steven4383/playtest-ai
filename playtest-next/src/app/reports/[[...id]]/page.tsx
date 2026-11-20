import type { Metadata } from 'next';
import { ReportsPage } from '@/dashboard/pages/ReportsPage';

export const metadata: Metadata = { title: 'Reports' };
// The dashboard renders in the browser (live device data, local settings), so there is nothing to validate for
// instant navigation on the server — see the Shell in src/dashboard/Shell.tsx.
export const instant = false;

export default function Page() {
  return <ReportsPage />;
}
