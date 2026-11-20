import type { FastifyInstance } from '../http';
import { z } from 'zod';
import { adb } from '../automation/adb';
import { emulatorManager } from '../automation/emulator';
import { sdkManager } from '../automation/sdk-manager';
import { campaignRunner } from '../automation/campaign-runner';
import { qrPairing } from '../automation/adb-qr';
import { toolStatus } from '../automation/sdk';
import { bus } from '../core/events';
import { keep } from '../core/keep';
import { config } from '../config';
import { deviceInput, devicePatch, deviceRepo } from '../services/devices';
import { systemMonitor } from '../services/system-monitor';
import { hostRam, setIdleStopMinutes, stopIdleEmulators } from '../services/ram-saver';

export async function deviceRoutes(app: FastifyInstance) {
  // Keep DB status in sync with emulator lifecycle events — one listener per process, also across dev reloads.
  const onDeviceEvent = (e: any) => {
    const id = e.data?.device_id;
    if (!id) return;
    if (e.event === 'device_starting') deviceRepo.setStatus(id, { status: 'starting', adb_serial: e.data.serial, last_error: null });
    if (e.event === 'device_ready') deviceRepo.setStatus(id, { status: 'online', last_health_check: e.timestamp });
    if (e.event === 'device_stopped') deviceRepo.setStatus(id, { status: 'offline' });
    if (e.event === 'device_error') deviceRepo.setStatus(id, { status: 'error', last_error: e.data.message ?? 'unknown error' });
  };
  const slot = keep('devices.statusListener', () => ({ fn: null as null | ((e: any) => void) }));
  if (slot.fn) bus.off('event', slot.fn);
  slot.fn = onDeviceEvent;
  bus.on('event', onDeviceEvent);

  app.get('/devices', async () => {
    const running = new Map(emulatorManager.list().map((r) => [r.device_id, r]));
    return deviceRepo.list().map((d) => ({ ...d, running: running.get(d.id) ?? null }));
  });

  app.post('/devices', async (req, reply) => {
    const body = deviceInput.parse(req.body);
    reply.code(201);
    return deviceRepo.create(body);
  });

  app.post('/devices/seed', async () => ({ inserted: deviceRepo.seedDefaults() }));

  app.patch<{ Params: { id: string } }>('/devices/:id', async (req, reply) => {
    const updated = deviceRepo.update(req.params.id, devicePatch.parse(req.body));
    if (!updated) return reply.code(404).send({ error: 'Device not found' });
    return updated;
  });

  app.delete<{ Params: { id: string } }>('/devices/:id', async (req, reply) => {
    if (campaignRunner.busyDevices().includes(req.params.id)) return reply.code(409).send({ error: 'Device is being used by a running campaign' });
    await emulatorManager.stop(req.params.id);
    if (!deviceRepo.remove(req.params.id)) return reply.code(404).send({ error: 'Device not found' });
    return reply.code(204).send();
  });

  /** ?window=true shows the emulator window (for app development / flutter run), ?window=false forces headless; default follows EMULATOR_HEADLESS. */
  app.post<{ Params: { id: string }; Querystring: { force?: string; window?: string } }>('/devices/:id/start', async (req, reply) => {
    const device = deviceRepo.get(req.params.id);
    if (!device) return reply.code(404).send({ error: 'Device not found' });
    if (device.type !== 'emulator' || !device.avd_name)
      return reply.code(400).send({ error: 'Only emulator profiles with an avd_name can be started' });

    if (emulatorManager.count() >= config.MAX_CONCURRENT_EMULATORS)
      return reply.code(409).send({
        error: `Concurrency limit reached (MAX_CONCURRENT_EMULATORS=${config.MAX_CONCURRENT_EMULATORS}). Stop a running emulator first.`,
      });

    // RAM check for THIS profile's emulator (its own RAM setting, not the global default) + host overhead + headroom.
    const cap = systemMonitor.capacity();
    const needGb = (device.ram_mb ?? config.EMULATOR_RAM_MB) / 1024 + 0.75;
    const freeGb = systemMonitor.latest()?.memory.available_gb ?? null;
    if (freeGb !== null && freeGb < needGb + 1 && req.query.force !== 'true')
      return reply.code(409).send({
        error: `Not enough free RAM to start ${device.name} safely: ${freeGb.toFixed(1)} GB free, needs ~${needGb.toFixed(1)} GB + 1 GB headroom. Free RAM under Device Manager → Memory (RAM saver), or start anyway.`,
        code: 'low_ram',
        capacity: cap,
        hint: 'Close other apps or retry with ?force=true',
      });

    try {
      return emulatorManager.start({
        device_id: device.id,
        avd_name: device.avd_name,
        ram_mb: device.ram_mb ?? undefined,
        headless: req.query.window === 'true' ? false : req.query.window === 'false' ? true : undefined,
      });
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.post<{ Params: { id: string } }>('/devices/:id/stop', async (req, reply) => {
    if (campaignRunner.busyDevices().includes(req.params.id)) return reply.code(409).send({ error: 'A campaign is testing on this emulator — cancel the campaign first' });
    try {
      const stopped = await emulatorManager.stop(req.params.id);
      if (!stopped) return reply.code(404).send({ error: 'Emulator is not running for this device' });
      return { stopped: true };
    } catch (err: any) {
      return reply.code(502).send({ error: err.message });
    }
  });

  /** Stop any running emulator by its ADB serial (also ones started outside PlayTest or before a backend restart). */
  app.post<{ Params: { serial: string } }>('/adb/devices/:serial/emu-stop', async (req, reply) => {
    const serial = req.params.serial;
    if (!/^emulator-\d{4,5}$/.test(serial)) return reply.code(400).send({ error: 'Only emulators can be stopped' });
    await emulatorManager.sync();
    const profile = emulatorManager.profileOf(serial);
    if (profile && campaignRunner.busyDevices().includes(profile)) return reply.code(409).send({ error: 'A test run is using this emulator - cancel it first' });
    try {
      if (profile) await emulatorManager.stop(profile);
      else await emulatorManager.stopSerial(serial);
      return { stopped: true, serial };
    } catch (err: any) {
      return reply.code(502).send({ error: err.message });
    }
  });

  /** Health check: verify ADB connectivity and refresh Android version / API / resolution. */
  app.post<{ Params: { id: string } }>('/devices/:id/health', async (req, reply) => {
    const device = deviceRepo.get(req.params.id);
    if (!device) return reply.code(404).send({ error: 'Device not found' });
    const serial = emulatorManager.get(device.id)?.serial ?? device.adb_serial;
    const now = new Date().toISOString();
    if (!serial) {
      deviceRepo.setStatus(device.id, { last_health_check: now, status: 'offline' });
      return { healthy: false, reason: 'No ADB serial known — start the emulator or connect the device' };
    }
    const { devices, error } = await adb.devices();
    const found = devices.find((d) => d.serial === serial);
    if (!found || found.state !== 'device') {
      deviceRepo.setStatus(device.id, { last_health_check: now, status: 'offline', last_error: error ?? `ADB state: ${found?.state ?? 'not connected'}` });
      return { healthy: false, reason: error ?? `ADB state: ${found?.state ?? 'not connected'}` };
    }
    const info = await adb.inspect(serial);
    deviceRepo.setStatus(device.id, {
      last_health_check: now,
      status: 'online',
      last_error: null,
      android_version: info.android_version ?? device.android_version,
      api_level: info.api_level ?? device.api_level,
      resolution: info.resolution ?? device.resolution,
    });
    return { healthy: true, info };
  });

  /** Download the system image (if needed) and create the AVD this emulator profile points at. */
  app.post<{ Params: { id: string }; Querystring: { force?: string } }>('/devices/:id/provision', async (req, reply) => {
    const device = deviceRepo.get(req.params.id);
    if (!device) return reply.code(404).send({ error: 'Device not found' });
    if (device.type !== 'emulator' || !device.avd_name || !device.api_level)
      return reply.code(400).send({ error: 'Profile needs type=emulator, an AVD name and an API level to be set up automatically' });
    if ((req.body as { accept_licenses?: boolean } | undefined)?.accept_licenses !== true)
      return reply.code(400).send({ error: 'Set accept_licenses: true to accept the Android SDK License (system images may be downloaded)' });
    const { avds } = await emulatorManager.listAvds();
    if (avds.includes(device.avd_name)) return reply.code(409).send({ error: `AVD ${device.avd_name} already exists` });
    reply.code(202);
    return sdkManager.provision(
      { name: device.name, avd_name: device.avd_name, api_level: device.api_level },
      { force: req.query.force === 'true' },
    );
  });

  /** ADB devices, each tagged with the profile it belongs to (matched by serial). */
  app.get('/adb/devices', async () => {
    const result = await adb.devices();
    const profiles = deviceRepo.list();
    const running = emulatorManager.list();
    // Every emulator reports the same model (sdk_gphone64_x86_64) — show its AVD name so they can be told apart.
    const avdNames = await Promise.all(
      result.devices.map((d) =>
        d.is_emulator && d.state === 'device' ? (running.find((r) => r.serial === d.serial)?.avd_name ?? adb.emulatorAvdName(d.serial)) : null,
      ),
    );
    return {
      ...result,
      devices: result.devices.map((d, i) => ({
        ...d,
        avd_name: avdNames[i],
        busy: profiles.some((p) => campaignRunner.busyDevices().includes(p.id) && (p.adb_serial === d.serial || running.some((r) => r.device_id === p.id && r.serial === d.serial))),
        profile_id:
          profiles.find((p) => p.adb_serial === d.serial && (p.type !== 'emulator' || running.some((r) => r.device_id === p.id)))?.id ??
          running.find((r) => r.serial === d.serial)?.device_id ??
          null,
      })),
    };
  });

  const addrBody = z.object({ address: z.string().trim().min(3).max(260) });
  const pairBody = z.object({ address: z.string().trim().min(3).max(260), code: z.string().trim().regex(/^\d{6}$/, 'Pairing code is 6 digits') });

  app.post('/adb/pair', async (req, reply) => {
    const { address, code } = pairBody.parse(req.body);
    const r = await adb.pair(address, code);
    if (!r.ok) return reply.code(502).send({ error: r.message });
    return r;
  });

  app.post('/adb/connect', async (req, reply) => {
    const { address } = addrBody.parse(req.body);
    const r = await adb.connect(address);
    if (!r.ok) return reply.code(502).send({ error: r.message });
    return r;
  });

  app.post<{ Params: { serial: string } }>('/adb/devices/:serial/disconnect', async (req, reply) => {
    const r = await adb.disconnect(req.params.serial);
    if (!r.ok) return reply.code(502).send({ error: r.message });
    return r;
  });

  /** QR pairing: returns an SVG QR to show; poll GET /adb/qr-pair/:id for progress. */
  app.post('/adb/qr-pair', async () => qrPairing.start());
  app.get<{ Params: { id: string } }>('/adb/qr-pair/:id', async (req, reply) => qrPairing.get(req.params.id) ?? reply.code(404).send({ error: 'Pairing session not found' }));
  app.delete<{ Params: { id: string } }>('/adb/qr-pair/:id', async (req, reply) => qrPairing.cancel(req.params.id) ?? reply.code(404).send({ error: 'Pairing session not found' }));

  app.post('/adb/restart', async (_req, reply) => {
    const r = await adb.restartServer();
    if (!r.ok) return reply.code(502).send({ error: r.error ?? 'adb start-server failed' });
    return { restarted: true };
  });

  /** Turn a phone connected over USB / Wi-Fi into a device profile, filled from getprop. */
  app.post<{ Params: { serial: string } }>('/adb/devices/:serial/profile', async (req, reply) => {
    const serial = req.params.serial;
    const { devices, error } = await adb.devices();
    const found = devices.find((d) => d.serial === serial);
    if (!found) return reply.code(404).send({ error: error ?? `${serial} is not connected` });
    if (found.is_emulator) return reply.code(400).send({ error: 'Emulators are managed through AVD profiles — use "Create profile" on the AVD instead' });
    if (found.state !== 'device')
      return reply.code(409).send({
        error: found.state === 'unauthorized' ? 'Device is unauthorized — unlock the phone and accept the "Allow USB debugging" prompt' : `Device state is "${found.state}"`,
      });
    if (deviceRepo.list().some((d) => d.adb_serial === serial)) return reply.code(409).send({ error: 'A profile for this device already exists' });

    const info = await adb.inspect(serial);
    const api = info.api_level && info.api_level >= 16 && info.api_level <= 40 ? info.api_level : undefined;
    reply.code(201);
    return deviceRepo.create(
      deviceInput.parse({
        name: (info.model ?? found.model ?? serial).slice(0, 100),
        type: 'physical',
        adb_serial: serial,
        android_version: info.android_version?.slice(0, 20) || undefined,
        api_level: api,
        resolution: info.resolution ?? undefined,
        enabled: true,
      }),
    );
  });
  app.get('/emulators/avds', async () => emulatorManager.listAvds());
  app.get('/emulators/running', async () => emulatorManager.list());
  app.get('/emulators/speed', async () => emulatorManager.speedInfo());
  /** Boot progress (0-100, stage, ETA) of every emulator PlayTest tracks; live updates arrive as `boot_progress` events. */
  app.get('/emulators/boot', async () => emulatorManager.boot());

  // ---- RAM saver (PC)
  app.get('/system/ram', async () => hostRam());
  app.post('/emulators/stop-idle', async (req) => {
    const b = z.object({ idle_minutes: z.number().int().min(0).max(1440).default(10) }).parse(req.body ?? {});
    return stopIdleEmulators(b.idle_minutes, { headlessOnly: false, reason: `RAM saver: stopped (idle ${b.idle_minutes}+ min)` });
  });
  app.put('/emulators/settings', async (req) => {
    const b = z.object({ idle_stop_minutes: z.number().int().min(0).max(1440) }).parse(req.body);
    return setIdleStopMinutes(b.idle_stop_minutes);
  });
  app.get('/tools', async () => toolStatus());
}
