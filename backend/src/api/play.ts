import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { playTesting, settingsInput, testerInput, testerPatch } from '../services/play-testing.js';

type P = { Params: { pkg: string } };
type T = { Params: { id: string } };
const ID_RE = /^[\w-]{1,64}$/;
const id = (v: string) => {
  if (!ID_RE.test(v)) throw Object.assign(new Error('Invalid id'), { statusCode: 400 });
  return v;
};

/** Google Play closed-testing tracker (12 testers × 14 days). Local only — nothing is sent to Google. */
export async function playRoutes(app: FastifyInstance) {
  app.get('/play/apps', async () => ({ apps: playTesting.apps() }));
  app.get<P>('/play/:pkg', async (req) => playTesting.get(req.params.pkg));
  app.delete<P>('/play/:pkg', async (req) => playTesting.removeApp(req.params.pkg));
  app.put<P>('/play/:pkg/settings', async (req) => playTesting.saveSettings(req.params.pkg, settingsInput.parse(req.body ?? {})));

  app.post<P>('/play/:pkg/testers', async (req, reply) => {
    reply.code(201);
    return playTesting.add(req.params.pkg, testerInput.parse(req.body));
  });
  app.post<P>('/play/:pkg/testers/import', async (req) => {
    const { text } = z.object({ text: z.string().max(50_000) }).parse(req.body);
    return playTesting.importText(req.params.pkg, text);
  });
  app.patch<T>('/play/testers/:id', async (req) => playTesting.update(id(req.params.id), testerPatch.parse(req.body ?? {})));
  app.delete<T>('/play/testers/:id', async (req) => playTesting.remove(id(req.params.id)));

  /** Email list for Play Console's "Upload CSV" (one address per line). */
  app.get<P>('/play/:pkg/testers.csv', async (req, reply) => {
    const csv = playTesting.csv(req.params.pkg);
    reply.header('Content-Disposition', `attachment; filename="testers-${req.params.pkg.replace(/[^\w.]/g, '_')}.csv"`);
    reply.header('Cache-Control', 'no-store');
    return reply.type('text/csv; charset=utf-8').send(csv);
  });
}
