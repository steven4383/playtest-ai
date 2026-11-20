import type { Metadata } from 'next';
import type { ReactNode } from 'react';
// Self-hosted fonts (work offline): Roboto for UI text, Poppins for headings and big numbers.
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/roboto/700.css';
import '@fontsource/poppins/500.css';
import '@fontsource/poppins/600.css';
import '@fontsource/poppins/700.css';
import '@/dashboard/styles.css';
import { Providers } from '@/dashboard/Providers';
import { Shell } from '@/dashboard/Shell';
import { InlineScript } from '@/dashboard/InlineScript';

export const metadata: Metadata = {
  title: { default: 'PlayTest AI', template: '%s · PlayTest AI' },
  description: 'Local Android dev & QA: devices, emulators, test runs, Flutter tools and reports.',
};

// Apply the saved theme before first paint so the page never flashes the wrong colors (Chakra reads the class).
const themeScript = `try{var t=localStorage.getItem('pt-theme');var d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.add(d?'dark':'light');document.documentElement.style.colorScheme=d?'dark':'light'}catch(e){document.documentElement.classList.add('dark')}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <InlineScript html={themeScript} />
      </head>
      <body>
        <Providers>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
