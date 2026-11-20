import { redirect } from 'next/navigation';

/** The dashboard opens on System & capacity. */
export default function Home() {
  redirect('/system');
}
