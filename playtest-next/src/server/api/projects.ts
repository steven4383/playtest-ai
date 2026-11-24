import type { FastifyInstance } from '../http';
import { z } from 'zod';
import { cloneRepo, gitInfo } from '../automation/git';
import { playPublisher, readServiceAccount } from '../automation/play-publisher';
import { releaseInput, releaseRunner } from '../automation/release-runner';
import { componentInput, componentKind, detectFolder, noteInput, playConfigInput, projectInput, projectRepo, readPubspecVersion } from '../services/projects';

type P = { Params: { id: string } };
const ID = /^[\w-]{1,64}$/;
const id = (v: string) => {
  if (!ID.test(v)) throw Object.assign(new Error('Invalid id'), { statusCode: 400 });
  return v;
};
const notFound = (what: string) => Object.assign(new Error(`${what} not found`), { statusCode: 404 });

/** Projects you maintain: parts (app / web panel / backend), git, Google Play releases, notes & requirements. */
export async function projectRoutes(app: FastifyInstance) {
  // ---- projects
  app.get('/projects', async () => ({ projects: projectRepo.list() }));
  app.post('/projects', async (req, reply) => {
    reply.code(201);
    return projectRepo.create(projectInput.parse(req.body));
  });
  app.get<P>('/projects/:id', async (req) => {
    const p = projectRepo.get(id(req.params.id));
    if (!p) throw notFound('Project');
    const components = await Promise.all(
      projectRepo.components(p.id).map(async (c) => ({
        ...c,
        version: c.framework === 'flutter' ? readPubspecVersion(c.path).version : (detectFolder(c.path).version ?? null),
        git: await gitInfo(c.path),
        play: projectRepo.publicPlayConfig(c.id),
        last_release: releaseRunner.list(c.id, 1)[0] ?? null,
      })),
    );
    return { ...p, components };
  });
  app.patch<P>('/projects/:id', async (req) => projectRepo.update(id(req.params.id), projectInput.partial().parse(req.body ?? {})));
  app.delete<P>('/projects/:id', async (req) => projectRepo.remove(id(req.params.id)));

  /** Preview a folder before adding it: what it is, version, git remote. */
  app.post('/projects/detect', async (req) => {
    const { path } = z.object({ path: z.string().trim().min(3).max(260) }).parse(req.body);
    const d = detectFolder(path);
    return { ...d, git: await gitInfo(path) };
  });

  // ---- parts of a project
  app.post<P>('/projects/:id/components', async (req, reply) => {
    const body = componentInput.parse(req.body);
    const info = await gitInfo(body.path.trim());
    reply.code(201);
    return projectRepo.addComponent(id(req.params.id), body, info.web_url ?? info.remote);
  });
  app.post<P>('/projects/:id/components/clone', async (req, reply) => {
    const b = z.object({ url: z.string().trim().min(10).max(300), dest: z.string().trim().min(3).max(260), name: z.string().trim().max(80).optional(), kind: componentKind.optional() }).parse(req.body);
    const projectId = id(req.params.id);
    if (!projectRepo.get(projectId)) throw notFound('Project');
    const dest = await cloneRepo(b.url, b.dest);
    const info = await gitInfo(dest);
    reply.code(201);
    return projectRepo.addComponent(projectId, { path: dest, name: b.name, kind: b.kind }, info.web_url ?? b.url);
  });
  app.patch<P>('/components/:id', async (req) =>
    projectRepo.updateComponent(id(req.params.id), z.object({ name: z.string().trim().min(1).max(80).optional(), kind: componentKind.optional() }).parse(req.body ?? {})),
  );
  app.delete<P>('/components/:id', async (req) => projectRepo.removeComponent(id(req.params.id)));
  app.get<P>('/components/:id/git', async (req) => {
    const c = projectRepo.component(id(req.params.id));
    if (!c) throw notFound('Project part');
    return gitInfo(c.path);
  });

  // ---- Google Play settings of a mobile app
  app.get<P>('/components/:id/play', async (req) => ({ play: projectRepo.publicPlayConfig(id(req.params.id)) }));
  app.put<P>('/components/:id/play', async (req) => ({ play: projectRepo.savePlayConfig(id(req.params.id), playConfigInput.parse(req.body)) }));
  /** The service-account key JSON (read in the browser and sent as text). Stored on this PC only, never sent back. */
  app.post<P>('/components/:id/play/service-account', async (req) => {
    const { json } = z.object({ json: z.string().min(50).max(20_000) }).parse(req.body);
    return { play: projectRepo.saveServiceAccount(id(req.params.id), json) };
  });
  /** Live state of every Play track (also proves the service account works). */
  app.get<P>('/components/:id/play/status', async (req) => {
    const cfg = projectRepo.playConfig(id(req.params.id));
    if (!cfg?.service_account_file) throw Object.assign(new Error('Add the Google Play service-account key first'), { statusCode: 409 });
    return playPublisher.status(readServiceAccount(cfg.service_account_file), cfg.package_name);
  });

  // ---- releases
  app.get<P>('/components/:id/releases', async (req) => ({ releases: releaseRunner.list(id(req.params.id)) }));
  app.post<P>('/components/:id/releases', async (req, reply) => {
    reply.code(202);
    return releaseRunner.start(id(req.params.id), releaseInput.parse(req.body ?? {}));
  });
  app.get<P>('/releases/:id', async (req) => releaseRunner.get(id(req.params.id)) ?? Promise.reject(notFound('Release')));
  app.post<P>('/releases/:id/cancel', async (req) => releaseRunner.cancel(id(req.params.id)));
  app.get<P>('/releases/:id/log', async (req) => ({ lines: releaseRunner.lines(id(req.params.id)) }));
  /** SSE: the log so far, then live lines and step changes until the release ends. */
  app.get<P>('/releases/:id/stream', (req, reply) => {
    const rid = id(req.params.id);
    const rel = releaseRunner.get(rid);
    if (!rel) return reply.code(404).send({ error: 'Release not found' });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    const send = (event: string, data: unknown) => !res.writableEnded && res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('release', rel);
    send('lines', releaseRunner.lines(rid).slice(-1500));
    let batch: string[] = [];
    const flush = setInterval(() => {
      if (batch.length) {
        send('lines', batch);
        batch = [];
      }
    }, 250);
    const unsubscribe = releaseRunner.subscribe(rid, (e) => {
      if (e.type === 'line') batch.push(e.line);
      else send('release', e.release);
    });
    const ping = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      clearInterval(flush);
      unsubscribe?.();
    });
    if (!unsubscribe) {
      // Finished release: nothing more will come.
      clearInterval(ping);
      clearInterval(flush);
      res.end();
    }
  });

  // ---- notes, requirements, tasks, bugs, ideas
  app.get<P>('/projects/:id/notes', async (req) => ({ notes: projectRepo.notes(id(req.params.id)) }));
  app.post<P>('/projects/:id/notes', async (req, reply) => {
    reply.code(201);
    return projectRepo.addNote(id(req.params.id), noteInput.parse(req.body));
  });
  app.patch<P>('/notes/:id', async (req) => projectRepo.updateNote(id(req.params.id), noteInput.partial().parse(req.body ?? {})));
  app.delete<P>('/notes/:id', async (req) => projectRepo.removeNote(id(req.params.id)));
}
