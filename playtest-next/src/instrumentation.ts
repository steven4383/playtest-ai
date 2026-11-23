/**
 * Runs once when the Next.js server starts. Background work (system monitor, emulator tracking, recovery of
 * interrupted test runs) lives with the API route, so ask it to start right away instead of waiting for the first
 * page to load. The API module keeps its own state; this file only knocks on the door.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const port = process.env.PORT || '4300';
  setTimeout(() => {
    fetch(`http://127.0.0.1:${port}/api/v1/health`).catch(() => {
      /* server not listening yet or another host: the first real request starts it */
    });
  }, 1500);
}
