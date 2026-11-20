/**
 * Process-wide state for the API (running emulators, test runs, SDK jobs, the event bus …).
 *
 * Next.js re-evaluates server modules when their code changes in `next dev`, and may load the same module in more
 * than one bundle. Plain module-level Maps would then be lost or duplicated — e.g. a running emulator could no
 * longer be stopped. Everything that must outlive a module instance is kept on globalThis under one key instead.
 */
const store = ((globalThis as { __playtest?: Record<string, unknown> }).__playtest ??= {});

export function keep<T>(key: string, init: () => T): T {
  if (!(key in store)) store[key] = init();
  return store[key] as T;
}
