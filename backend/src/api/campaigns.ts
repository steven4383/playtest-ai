import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { campaignRunner } from '../automation/campaign-runner.js';
import { emulatorManager } from '../automation/emulator.js';
import { getApk } from '../services/apks.js';
import { campaignInput, campaignRepo } from '../services/campaigns.js';
import { deviceRepo } from '../services/devices.js';
import { systemMonitor } from '../services/system-monitor.js';

const CONTENT_TYPES: Record<string, string> = { '.png': 'image/png', '.txt': 'text/plain; charset=utf-8' };

export async function campaignRoutes(app: FastifyInstance) {
  app.get('/campaigns', async () => campaignRepo.list().map((c: any) => ({ ...c, paused: campaignRunner.isPaused(c.id) })));

  app.get<{ Params: { id: string } }>('/campaigns/:id', async (req, reply) => {
    const c = campaignRepo.get(req.params.id);
    if (!c) return reply.code(404).send({ error: 'Campaign not found' });
    return { ...c, active: campaignRunner.isActive(c.id), paused: campaignRunner.isPaused(c.id) };
  });

  /** Create and start a campaign. Validates everything up front so the run itself only fails for real reasons. */
  app.post('/campaigns', async (req, reply) => {
    const cfg = campaignInput.parse(req.body);
    const apk = getApk(cfg.apk_id);
    if (!apk) return reply.code(404).send({ error: 'APK not found' });
    if (!apk.package_name) return reply.code(400).send({ error: 'This APK has no package name (aapt could not read it) — re-upload with Android build-tools installed' });

    const ids = [...new Set(cfg.device_ids)];
    const devices = ids.map((id) => deviceRepo.get(id));
    const missing = ids.filter((_, i) => !devices[i]);
    if (missing.length) return reply.code(404).send({ error: `Device profile(s) not found: ${missing.join(', ')}` });

    const { avds } = await emulatorManager.listAvds();
    const problems: string[] = [];
    for (const d of devices) {
      if (!d) continue;
      if (d.type === 'emulator' && (!d.avd_name || !avds.includes(d.avd_name))) problems.push(`${d.name}: AVD not installed (press "Set up" on Device Manager)`);
      if (d.type !== 'emulator' && !d.adb_serial) problems.push(`${d.name}: no ADB serial`);
    }
    if (problems.length) return reply.code(400).send({ error: problems.join(' · ') });

    const campaign = campaignRepo.create({ ...cfg, device_ids: ids }, { id: apk.id, package_name: apk.package_name, filename: apk.filename }, devices as { id: string; name: string }[]);
    campaignRunner.start(campaign.id);
    reply.code(201);
    return campaign;
  });

  app.post<{ Params: { id: string } }>('/campaigns/:id/cancel', async (req, reply) => {
    if (!campaignRunner.cancel(req.params.id)) return reply.code(409).send({ error: 'Campaign is not running' });
    return { cancelling: true };
  });

  /** Live Testing: pause after the current step / resume. */
  app.post<{ Params: { id: string; action: string } }>('/campaigns/:id/:action', async (req, reply) => {
    const action = req.params.action;
    if (action !== 'pause' && action !== 'resume') return reply.code(404).send({ error: 'Unknown action' });
    if (!campaignRunner.setPaused(req.params.id, action === 'pause')) return reply.code(409).send({ error: 'Campaign is not running' });
    return { paused: action === 'pause' };
  });

  app.delete<{ Params: { id: string } }>('/campaigns/:id', async (req, reply) => {
    if (campaignRunner.isActive(req.params.id)) return reply.code(409).send({ error: 'Cancel the campaign before deleting it' });
    if (!campaignRepo.remove(req.params.id)) return reply.code(404).send({ error: 'Campaign not found' });
    return reply.code(204).send();
  });

  /** Concurrency the dashboard should offer: emulator slots vs. what this machine can actually run. */
  app.get('/campaigns/limits', async () => {
    const cap = systemMonitor.capacity();
    return {
      max_concurrent_emulators: config.MAX_CONCURRENT_EMULATORS,
      recommended_concurrent: cap.recommended_concurrent,
      busy_devices: campaignRunner.busyDevices(),
    };
  });

  /** Screenshots, logcat and crash excerpts. Only files under STORAGE_DIR are served. */
  app.get<{ Params: { id: string } }>('/artifacts/:id', async (req, reply) => {
    const a = campaignRepo.artifact(req.params.id);
    if (!a) return reply.code(404).send({ error: 'Artifact not found' });
    const root = path.resolve(config.STORAGE_DIR) + path.sep;
    const file = path.resolve(a.path);
    if (!file.startsWith(root) || !fs.existsSync(file)) return reply.code(404).send({ error: 'Artifact file missing' });
    reply.type(CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream');
    reply.header('Cache-Control', 'private, max-age=3600');
    return reply.send(fs.createReadStream(file));
  });
}
