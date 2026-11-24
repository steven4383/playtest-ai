import { redirect } from 'next/navigation';

/** The dashboard opens on Projects. */
export default function Home() {
  redirect('/projects');
}
