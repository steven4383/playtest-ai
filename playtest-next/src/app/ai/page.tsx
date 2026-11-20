import type { Metadata } from 'next';
import { AiPage } from '@/dashboard/pages/AiPage';

export const metadata: Metadata = { title: 'AI (Gemini)' };
// The dashboard renders in the browser (live device data, local settings), so there is nothing to validate for
// instant navigation on the server — see the Shell in src/dashboard/Shell.tsx.
export const instant = false;

export default function Page() {
  return <AiPage />;
}
