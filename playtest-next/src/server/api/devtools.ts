import type { FastifyInstance } from '../http';
import { z } from 'zod';
import { adb } from '../automation/adb';
import { flutterStatus, scrcpy } from '../automation/devtools';

const n = z.number().int().min(0).max(20000);
const inputBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('tap'), x: n, y: n }),
  z.object({ action: z.literal('swipe'), x1: n, y1: n, x2: n, y2: n, duration_ms: z.number().int().min(50).max(3000).optional() }),
  z.object({ action: z.literal('key'), key: z.string().max(20) }),
  z.object({ action: z.literal('text'), text: z.string().min(1).max(200) }),
]);

const mirrorBody = z.object({
  title: z.string().max(80).optional(),
  stay_awake: z.boolean().optional(),
  turn_screen_off: z.boolean().optional(),
  max_size: z.number().int().min(480).max(4096).optional(),
});

export async function devtoolsRoutes(app: FastifyInstance) {
  /** Flutter SDK + what `flutter devices` sees (should include every device listed under ADB). */
  app.get<{ Querystring: { refresh?: string } }>('/devtools/flutter', async (req) => flutterStatus(req.query.refresh === 'true'));

  app.get('/devtools/scrcpy', async () => scrcpy.status());
  app.post('/devtools/scrcpy/install', async (_req, reply) => {
    reply.code(202);
    return scrcpy.install();
  });

  /** Open a scrcpy mirror window (mouse + keyboard control) on this PC. */
  app.post<{ Params: { serial: string } }>('/adb/devices/:serial/mirror', async (req) => {
    const b = mirrorBody.parse(req.body ?? {});
    return scrcpy.open(req.params.serial, { title: b.title, stayAwake: b.stay_awake, turnScreenOff: b.turn_screen_off, maxSize: b.max_size });
  });

  /** One PNG frame for the in-browser live view. */
  app.get<{ Params: { serial: string } }>('/adb/devices/:serial/screen', async (req, reply) => {
    const png = await adb.screenshot(req.params.serial);
    if (!png) return reply.code(502).send({ error: 'Could not capture the screen (device locked to secure content, or disconnected)' });
    reply.header('Cache-Control', 'no-store');
    return reply.type('image/png').send(png);
  });

  app.post<{ Params: { serial: string } }>('/adb/devices/:serial/input', async (req, reply) => {
    const r = await adb.input(req.params.serial, inputBody.parse(req.body));
    if (!r.ok) return reply.code(502).send({ error: r.error ?? 'input failed' });
    return { ok: true };
  });
}
