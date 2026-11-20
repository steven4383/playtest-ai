import type { FastifyInstance } from '../http';
import { z } from 'zod';
import { analyzeFlutterProject, explainPrompt, flutterDoctor, flutterProjects } from '../automation/flutter-project';
import { flutterRunner } from '../automation/flutter-run';
import { llm } from '../llm/index';

const pathBody = z.object({ path: z.string().trim().min(3).max(500) });
const runBody = pathBody.extend({ serial: z.string().trim().min(1).max(120) });

export async function flutterRoutes(app: FastifyInstance) {
  // ---- projects
  app.get<{ Querystring: { refresh?: string } }>('/flutter/projects', async (req) => ({ projects: await flutterProjects.list(req.query.refresh === 'true') }));
  app.post('/flutter/projects', async (req) => flutterProjects.remember(pathBody.parse(req.body).path));
  app.delete('/flutter/projects', async (req) => flutterProjects.forget(pathBody.parse(req.body).path));

  // ---- toolchain
  app.get<{ Querystring: { refresh?: string } }>('/flutter/doctor', async (req) => flutterDoctor(req.query.refresh === 'true'));

  // ---- analysis (read-only)
  app.post('/flutter/analyze', async (req) => analyzeFlutterProject(pathBody.parse(req.body).path));

  /** Optional: Gemini explanation built from the analysis facts only (no source code is sent). */
  app.post('/flutter/explain', async (req) => {
    const a = await analyzeFlutterProject(pathBody.parse(req.body).path);
    const p = explainPrompt(a);
    const r = await llm().generate({ system: p.system, prompt: p.prompt, temperature: 0.4, maxOutputTokens: 1200, timeoutMs: 60_000 });
    return { text: r.text, model: r.model, latency_ms: r.latency_ms };
  });

  // ---- run sessions
  app.get('/flutter/runs', async () => ({ runs: flutterRunner.list() }));
  app.post('/flutter/run', async (req, reply) => {
    const b = runBody.parse(req.body);
    reply.code(202);
    return flutterRunner.start(b.path, b.serial);
  });
  app.post('/flutter/terminal', async (req) => {
    const b = runBody.parse(req.body);
    return flutterRunner.openTerminal(b.path, b.serial);
  });
  app.post<{ Params: { id: string } }>('/flutter/runs/:id/reload', async (req) => flutterRunner.reload(req.params.id, false));
  app.post<{ Params: { id: string } }>('/flutter/runs/:id/restart', async (req) => flutterRunner.reload(req.params.id, true));
  app.post<{ Params: { id: string } }>('/flutter/runs/:id/stop', async (req) => flutterRunner.stop(req.params.id));

  /** SSE: backlog + live output and status of one run. */
  app.get<{ Params: { id: string } }>('/flutter/runs/:id/stream', (req, reply) => {
    const s = flutterRunner.get(req.params.id);
    if (!s) return reply.code(404).send({ error: 'Run not found' });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (event: string, data: unknown) => !res.writableEnded && res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('status', flutterRunner.list().find((r) => r.id === s.id));
    send('lines', s.lines.slice(-800));
    let batch: unknown[] = [];
    const flush = setInterval(() => {
      if (batch.length) {
        send('lines', batch);
        batch = [];
      }
    }, 200);
    const listener = (e: { type: 'line'; line: unknown } | { type: 'status'; session: unknown }) => {
      if (e.type === 'line') batch.push(e.line);
      else send('status', e.session);
    };
    s.listeners.add(listener);
    const ping = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      clearInterval(flush);
      s.listeners.delete(listener);
    });
  });
}
