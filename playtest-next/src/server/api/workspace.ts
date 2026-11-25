import fs from 'node:fs';
import type { FastifyInstance } from '../http';
import { z } from 'zod';
import { backdropPatch, backdrops } from '../services/backdrops';
import { listFolders, pickFolderNative } from '../services/folders';
import { github } from '../services/github';
import { entryInput, timeline } from '../services/timeline';

type P = { Params: { id: string } };
const id = (v: string) => {
  if (!/^[\w-]{1,64}$/.test(v)) throw Object.assign(new Error('Invalid id'), { statusCode: 400 });
  return v;
};

/** Folder picker, GitHub repositories, and the goals & achievements timeline. */
export async function workspaceRoutes(app: FastifyInstance) {
  // ---- folders (Browse… buttons)
  app.get('/fs/folders', async (req) => listFolders(z.object({ path: z.string().max(400).optional() }).parse(req.query).path));
  /** Opens the Windows folder dialog on this PC and waits for your choice. */
  app.post('/fs/pick-folder', async (req) => {
    const { initial } = z.object({ initial: z.string().max(400).optional() }).parse(req.body ?? {});
    return { path: await pickFolderNative(initial) };
  });

  // ---- GitHub
  app.get('/github/status', async () => github.status());
  app.put('/github/token', async (req) => github.connect(z.object({ token: z.string().min(10).max(300) }).parse(req.body).token));
  app.delete('/github/token', async () => github.disconnect());
  app.put('/github/projects-dir', async (req) => github.setProjectsDir(z.object({ dir: z.string().min(3).max(260) }).parse(req.body).dir));
  app.get('/github/repos', async (req) => {
    const { user } = z.object({ user: z.string().max(40).optional() }).parse(req.query);
    return { repos: await github.repos(user || undefined) };
  });

  // ---- timeline
  app.get('/timeline', async (req) => {
    const q = z.object({ scope: z.enum(['personal', 'project']).optional(), project: z.string().regex(/^[\w-]{1,64}$/).optional() }).parse(req.query);
    return timeline.list(q);
  });
  app.post('/timeline', async (req, reply) => {
    reply.code(201);
    return timeline.create(entryInput.parse(req.body));
  });
  app.patch<P>('/timeline/:id', async (req) => timeline.update(id(req.params.id), entryInput.partial().parse(req.body ?? {})));
  app.delete<P>('/timeline/:id', async (req) => timeline.remove(id(req.params.id)));

  // ---- personal space backdrops (your own images, stored on this PC)
  app.get('/personal/backdrops', async () => backdrops.list());
  app.post('/personal/backdrops', async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'Send the image as multipart field "file"' });
    reply.code(201);
    return backdrops.add(file.filename, file.file);
  });
  app.get<P>('/personal/backdrops/:id/image', async (req, reply) => {
    const f = backdrops.file(id(req.params.id));
    // Ids are new per upload, so the image never changes under the same URL.
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.type(f.mime).send(fs.createReadStream(f.path));
  });
  app.patch<P>('/personal/backdrops/:id', async (req) => backdrops.update(id(req.params.id), backdropPatch.parse(req.body ?? {})));
  app.delete<P>('/personal/backdrops/:id', async (req) => backdrops.remove(id(req.params.id)));
}
