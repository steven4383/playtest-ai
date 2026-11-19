import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { adb } from '../automation/adb.js';
import { devkit, tmpDir } from '../automation/devkit.js';

type S = { Params: { serial: string } };
type SP = { Params: { serial: string; pkg: string } };

/** Send a temp file as a download, then delete it. */
function sendTemp(reply: FastifyReply, file: string, name: string, type = 'application/octet-stream') {
  const ascii = name.replace(/[^\w.()+-]/g, '_');
  reply.header('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  reply.header('Cache-Control', 'no-store');
  const stream = fs.createReadStream(file);
  stream.on('close', () => fs.rm(file, { force: true }, () => {}));
  return reply.type(type).send(stream);
}

const appAction = z.enum(['launch', 'stop', 'clear', 'uninstall']);
const emuBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('geo'), lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
  z.object({ action: z.literal('battery'), level: z.number().int().min(0).max(100).optional(), charging: z.boolean().optional() }),
  z.object({
    action: z.literal('network'),
    speed: z.enum(['full', 'lte', 'hsdpa', 'umts', 'edge', 'gprs']).optional(),
    delay: z.enum(['none', 'umts', 'edge', 'gprs']).optional(),
  }),
  z.object({ action: z.literal('rotate') }),
]);

export async function devkitRoutes(app: FastifyInstance) {
  // ---- info / Wi-Fi
  app.get<S>('/adb/devices/:serial/info', async (req) => devkit.info(req.params.serial));
  app.post<S>('/adb/devices/:serial/wireless', async (req) => devkit.toWireless(req.params.serial));

  // ---- apps
  app.get<S>('/adb/devices/:serial/foreground', async (req) => ({ package: await adb.foregroundPackage(req.params.serial) }));
  app.get<S & { Querystring: { system?: string } }>('/adb/devices/:serial/apps', async (req) => ({
    apps: await devkit.apps(req.params.serial, req.query.system === 'true'),
  }));
  app.get<SP>('/adb/devices/:serial/apps/:pkg', async (req) => devkit.appDetails(req.params.serial, req.params.pkg));
  app.post<SP & { Params: { action: string } }>('/adb/devices/:serial/apps/:pkg/:action', async (req) =>
    devkit.appAction(req.params.serial, req.params.pkg, appAction.parse(req.params.action)),
  );
  app.post<SP>('/adb/devices/:serial/apps/:pkg/permission', async (req) => {
    const b = z.object({ permission: z.string().min(3).max(200), grant: z.boolean() }).parse(req.body);
    return devkit.setPermission(req.params.serial, req.params.pkg, b.permission, b.grant);
  });
  app.post<SP>('/adb/devices/:serial/apps/:pkg/locale', async (req) => {
    const b = z.object({ locale: z.string().max(40) }).parse(req.body);
    return devkit.setAppLocale(req.params.serial, req.params.pkg, b.locale.trim());
  });
  app.get<SP>('/adb/devices/:serial/apps/:pkg/apk', async (req, reply) => {
    const r = await devkit.pullApk(req.params.serial, req.params.pkg);
    return sendTemp(reply, r.file, r.name, 'application/vnd.android.package-archive');
  });
  app.post<S>('/adb/devices/:serial/install', async (req) => {
    const b = z.object({ apk_id: z.string().min(1).max(64), launch: z.boolean().default(true) }).parse(req.body);
    return devkit.installApk(req.params.serial, b.apk_id, b.launch);
  });

  // ---- performance
  app.get<S & { Querystring: { pkg?: string } }>('/adb/devices/:serial/perf', async (req) => {
    const pkg = z.string().min(3).max(200).parse(req.query.pkg);
    return devkit.perf(req.params.serial, pkg);
  });
  app.post<S>('/adb/devices/:serial/perf/reset', async (req) => {
    const b = z.object({ pkg: z.string().min(3).max(200) }).parse(req.body);
    return devkit.resetFrames(req.params.serial, b.pkg);
  });

  // ---- logcat (SSE)
  app.get<S & { Querystring: { pkg?: string; tail?: string } }>('/adb/devices/:serial/logcat', (req, reply) => {
    const q = z.object({ pkg: z.string().min(3).max(200).optional(), tail: z.coerce.number().int().min(0).max(2000).optional() }).parse(req.query);
    let stop: (() => void) | null = null;
    const res = reply.raw;
    const send = (event: string, data: unknown) => !res.writableEnded && res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    // Validate before hijacking so bad input still gets a normal 400.
    const start = () =>
      devkit.logcatStream(
        req.params.serial,
        { pkg: q.pkg || undefined, tail: q.tail },
        (lines) => send('lines', lines),
        (s) => send('status', s),
        (reason) => {
          send('end', { reason });
          res.end();
        },
      );
    stop = start();
    reply.hijack();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    send('ready', { serial: req.params.serial, pkg: q.pkg ?? null });
    const ping = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      stop?.();
    });
  });
  app.post<S>('/adb/devices/:serial/logcat/clear', async (req) => {
    await devkit.clearLogcat(req.params.serial);
    return { ok: true };
  });

  // ---- screen recording
  app.get<S>('/adb/devices/:serial/record', async (req) => devkit.recordingStatus(req.params.serial));
  app.post<S>('/adb/devices/:serial/record/start', async (req) => {
    const b = z.object({ seconds: z.number().int().min(5).max(180).default(60), bit_rate_mbps: z.number().min(1).max(40).optional(), title: z.string().max(80).default('') }).parse(req.body ?? {});
    return devkit.startRecording(req.params.serial, b.seconds, b.bit_rate_mbps, b.title || req.params.serial);
  });
  app.post<S>('/adb/devices/:serial/record/stop', async (req) => devkit.stopRecording(req.params.serial));
  app.get('/recordings', async () => ({ recordings: devkit.listRecordings() }));
  app.get<{ Params: { id: string }; Querystring: { download?: string } }>('/recordings/:id', async (req, reply) => {
    const f = devkit.recordingFile(req.params.id);
    if (!f) return reply.code(404).send({ error: 'Recording not found' });
    if (req.query.download === 'true') reply.header('Content-Disposition', `attachment; filename="${req.params.id}.mp4"`);
    return reply.type('video/mp4').send(fs.createReadStream(f));
  });
  app.delete<{ Params: { id: string } }>('/recordings/:id', async (req, reply) => {
    if (!devkit.deleteRecording(req.params.id)) return reply.code(404).send({ error: 'Recording not found' });
    return reply.code(204).send();
  });

  // ---- deep links
  app.post<S>('/adb/devices/:serial/deeplink', async (req) => {
    const b = z.object({ url: z.string().trim().min(3).max(2000), package: z.string().trim().max(200).optional() }).parse(req.body);
    return devkit.deepLink(req.params.serial, b.url, b.package || undefined);
  });

  // ---- quick settings
  app.get<S>('/adb/devices/:serial/toggles', async (req) => ({ toggles: await devkit.getToggles(req.params.serial) }));
  app.put<S>('/adb/devices/:serial/toggles', async (req) => {
    const b = z.object({ id: z.string().regex(/^[a-z_]{2,40}$/), value: z.string().max(10) }).parse(req.body);
    return devkit.setToggle(req.params.serial, b.id, b.value);
  });

  // ---- emulator console
  app.post<S>('/adb/devices/:serial/emu', async (req) => devkit.emu(req.params.serial, emuBody.parse(req.body)));

  // ---- files
  app.get<S & { Querystring: { path?: string } }>('/adb/devices/:serial/files', async (req) => devkit.listFiles(req.params.serial, req.query.path ?? '/sdcard'));
  app.get<S & { Querystring: { path?: string } }>('/adb/devices/:serial/files/download', async (req, reply) => {
    const r = await devkit.pullFile(req.params.serial, z.string().min(1).parse(req.query.path));
    return sendTemp(reply, r.file, r.name);
  });
  app.post<S & { Querystring: { dir?: string } }>('/adb/devices/:serial/files/upload', async (req, reply) => {
    const dir = z.string().min(1).parse(req.query.dir);
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'Send the file as multipart field "file"' });
    const tmp = path.join(tmpDir(), `up_${crypto.randomBytes(8).toString('hex')}`);
    try {
      await pipeline(file.file, fs.createWriteStream(tmp));
      if (file.file.truncated) return reply.code(413).send({ error: 'File is too large' });
      reply.code(201);
      return await devkit.pushFile(req.params.serial, tmp, dir, file.filename);
    } finally {
      fs.rm(tmp, { force: true }, () => {});
    }
  });
  app.delete<S & { Querystring: { path?: string } }>('/adb/devices/:serial/files', async (req) => devkit.deleteFile(req.params.serial, z.string().min(1).parse(req.query.path)));
}
