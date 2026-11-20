import { createRouter } from './http';
import { ensureBooted } from './boot';
import { emulatorManager } from './automation/emulator';
import { apkRoutes } from './api/apks';
import { bugRoutes } from './api/bugs';
import { campaignRoutes } from './api/campaigns';
import { deviceRoutes } from './api/devices';
import { devkitRoutes } from './api/devkit';
import { devtoolsRoutes } from './api/devtools';
import { flutterRoutes } from './api/flutter';
import { llmRoutes } from './api/llm';
import { playRoutes } from './api/play';
import { sdkRoutes } from './api/sdk';
import { systemRoutes } from './api/system';

export const API_PREFIX = '/api/v1';

const router = createRouter(API_PREFIX);
const registered = (async () => {
  router.app.get('/health', async () => ({ status: 'ok', version: '0.2.0', uptime_s: Math.round(process.uptime()) }));
  for (const routes of [systemRoutes, deviceRoutes, apkRoutes, sdkRoutes, llmRoutes, campaignRoutes, bugRoutes, devtoolsRoutes, devkitRoutes, flutterRoutes, playRoutes]) {
    await routes(router.app);
  }
})();

/** RAM saver: any per-device request (live screen, input, tools) counts as "in use". Thumbnails (?thumb=1) don't. */
function trackDeviceUse(path: string, url: URL) {
  const m = path.match(/^\/adb\/devices\/([^/]+)\//);
  if (m && url.searchParams.get('thumb') !== '1') {
    try {
      emulatorManager.touch(decodeURIComponent(m[1]));
    } catch {
      /* bad encoding: the route answers 400 */
    }
  }
}

/** Entry point of every /api/v1/* request (see src/app/api/v1/[...path]/route.ts). */
export async function dispatch(request: Request): Promise<Response> {
  try {
    await ensureBooted();
  } catch (err) {
    console.error('[playtest] start-up failed', err);
    return Response.json({ error: `PlayTest could not start: ${(err as Error).message}` }, { status: 503 });
  }
  await registered;
  return router.handle(request, trackDeviceUse);
}
