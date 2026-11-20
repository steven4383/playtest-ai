/**
 * The whole PlayTest API (devices, emulators, test runs, SDK, Flutter, reports …) lives under /api/v1/*.
 * Every method goes to one dispatcher with ~130 routes (src/server/router.ts). The server modules are imported
 * on the first request, not at build time, so `next build` never opens the database or starts background work.
 */
async function handle(request: Request): Promise<Response> {
  const { dispatch } = await import('@/server/router');
  return dispatch(request);
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
