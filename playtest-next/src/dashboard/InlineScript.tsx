'use client';

/**
 * A script that runs while the browser parses the server HTML (before first paint) — e.g. applying the saved theme.
 * Real script on the server, inert text/plain in the browser so React doesn't warn about rendering <script>
 * (pattern from the Next.js "Preventing flash before hydration" guide).
 */
export function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === 'undefined' ? 'text/javascript' : 'text/plain'}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
