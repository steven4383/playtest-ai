import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { bus } from '../core/events';
import { db } from '../db/index';
import { getApk } from '../services/apks';
import { bugRepo } from '../services/bugs';
import { campaignRepo, executionsDir, type CampaignConfig, type ExecutionStatus, type StepStatus } from '../services/campaigns';
import { saveReport } from '../services/reports';
import { deviceRepo, type DeviceRow } from '../services/devices';
import { systemMonitor } from '../services/system-monitor';
import { adb, assertPackage } from './adb';
import { emulatorManager } from './emulator';

import { keep } from '../core/keep';
/**
 * Runs campaigns: a pool of `concurrency` workers pulls devices off the queue and runs the
 * open/close flow on each. Emulator boots are limited by MAX_CONCURRENT_EMULATORS and free RAM,
 * and only one emulator boots at a time (booting is the RAM/CPU spike). Physical devices are
 * not limited by emulator slots.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

class Cancelled extends Error {
  constructor() {
    super('Cancelled by user');
  }
}

/** A step outcome; `error` = infrastructure problem (device/emulator), `failed` = the app misbehaved. */
class StepFail extends Error {
  constructor(
    message: string,
    public kind: 'failed' | 'error' | 'skipped' = 'failed',
  ) {
    super(message);
  }
}

interface Ctx {
  campaignId: string;
  cancelled: boolean;
  /** Paused runs finish the current step, then wait before the next one (Live Testing → Pause). */
  paused: boolean;
}

const active = keep('campaigns.active', () => new Map<string, Ctx>());
/** Devices currently used by any campaign, so two campaigns never share one device. */
const busyDevices = keep('campaigns.busyDevices', () => new Set<string>());
/** Emulators the runner booted and left running on purpose; stopped when another device needs the slot. */
const keptRunning = keep('campaigns.keptRunning', () => new Set<string>());

function publishCampaign(campaignId: string) {
  const c = campaignRepo.get(campaignId);
  if (c) bus.publish({ event: 'campaign_update', data: { campaign_id: campaignId, status: c.status, summary: c.summary, paused: !!active.get(campaignId)?.paused } });
}

/** Wait here while the run is paused (cancel still works). */
async function pauseGate(ctx: Ctx) {
  while (ctx.paused && !ctx.cancelled) await sleep(500);
  if (ctx.cancelled) throw new Cancelled();
}
function publishExecution(campaignId: string, executionId: string, status: ExecutionStatus, step?: string) {
  bus.publish({ event: 'execution_update', data: { campaign_id: campaignId, execution_id: executionId, status, step } });
}

async function waitFor(ctx: Ctx, cond: () => boolean | Promise<boolean>, timeoutMs: number, everyMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ctx.cancelled) throw new Cancelled();
    if (await cond()) return true;
    await sleep(everyMs);
  }
  return false;
}

/** Find FATAL EXCEPTION / ANR / native crash for this package in a logcat dump. */
export function findCrash(log: string, pkg: string): { kind: 'crash' | 'anr' | 'native_crash'; excerpt: string } | null {
  const lines = log.split(/\r?\n/);
  const excerptFrom = (i: number) => lines.slice(Math.max(0, i - 2), i + 40).join('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.includes('FATAL EXCEPTION') && lines.slice(i, i + 4).some((n) => n.includes(`Process: ${pkg}`))) return { kind: 'crash', excerpt: excerptFrom(i) };
    if (l.includes(`ANR in ${pkg}`)) return { kind: 'anr', excerpt: excerptFrom(i) };
    if (l.includes(`>>> ${pkg} <<<`)) return { kind: 'native_crash', excerpt: excerptFrom(i) };
  }
  return null;
}

export const campaignRunner = {
  start(campaignId: string) {
    if (active.has(campaignId)) return;
    const ctx: Ctx = { campaignId, cancelled: false, paused: false };
    active.set(campaignId, ctx);
    void runCampaign(ctx).finally(() => active.delete(campaignId));
  },

  cancel(campaignId: string): boolean {
    const ctx = active.get(campaignId);
    if (!ctx) return false;
    ctx.cancelled = true;
    return true;
  },

  /** Pause / resume between steps. */
  setPaused(campaignId: string, paused: boolean): boolean {
    const ctx = active.get(campaignId);
    if (!ctx) return false;
    ctx.paused = paused;
    publishCampaign(campaignId);
    return true;
  },

  isPaused: (campaignId: string) => !!active.get(campaignId)?.paused,
  isActive: (campaignId: string) => active.has(campaignId),
  busyDevices: () => [...busyDevices],

  async cancelAll() {
    for (const ctx of active.values()) ctx.cancelled = true;
  },
};

async function runCampaign(ctx: Ctx) {
  const c = campaignRepo.get(ctx.campaignId);
  if (!c) return;
  const cfg = c.config as CampaignConfig;
  campaignRepo.setStatus(ctx.campaignId, 'RUNNING', { started_at: now() });
  publishCampaign(ctx.campaignId);

  const queue = campaignRepo.queuedExecutions(ctx.campaignId);
  const workers = cfg.mode === 'sequential' ? 1 : Math.max(1, Math.min(cfg.concurrency, queue.length));

  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (let ex = queue.shift(); ex; ex = queue.shift()) {
        await pauseGate(ctx).catch(() => {});
        if (ctx.cancelled) {
          campaignRepo.updateExecution(ex.id, { status: 'cancelled', error_summary: 'Campaign cancelled', completed_at: now() });
          publishExecution(ctx.campaignId, ex.id, 'cancelled');
          continue;
        }
        await runExecution(ctx, cfg, c.apk_id, ex.id, ex.device_id).catch((err) => {
          // Last-resort guard: runExecution records its own failures.
          campaignRepo.updateExecution(ex!.id, { status: 'error', error_summary: String(err?.message ?? err), completed_at: now() });
        });
        campaignRepo.refreshSummary(ctx.campaignId);
        publishCampaign(ctx.campaignId);
      }
    }),
  );

  campaignRepo.refreshSummary(ctx.campaignId);
  campaignRepo.setStatus(ctx.campaignId, ctx.cancelled ? 'CANCELLED' : 'COMPLETED', { completed_at: now() });
  try {
    bugRepo.resolveRetests(ctx.campaignId);
    saveReport(ctx.campaignId);
  } catch {
    /* the report can still be generated on demand */
  }
  publishCampaign(ctx.campaignId);
}

async function runExecution(ctx: Ctx, cfg: CampaignConfig, apkId: string, executionId: string, deviceId: string) {
  const device = deviceRepo.get(deviceId);
  const apk = getApk(apkId);
  let stepNo = 0;
  let startedEmulator = false;
  let serial: string | null = null;
  const metrics: Record<string, unknown> = { launch_times_ms: [] as number[] };
  const dir = executionsDir(executionId);
  fs.mkdirSync(dir, { recursive: true });

  campaignRepo.updateExecution(executionId, { status: 'running', started_at: now() });
  publishExecution(ctx.campaignId, executionId, 'running', 'Waiting for device');

  /** Run one named step and record it. Throws StepFail / Cancelled to abort the execution. */
  const step = async (name: string, fn: () => Promise<string | void>): Promise<void> => {
    await pauseGate(ctx);
    const id = campaignRepo.startStep(executionId, ++stepNo, name);
    publishExecution(ctx.campaignId, executionId, 'running', name);
    const t0 = Date.now();
    try {
      const detail = await fn();
      campaignRepo.finishStep(id, 'passed', detail ?? null, Date.now() - t0);
    } catch (err: any) {
      const status: StepStatus = err instanceof Cancelled ? 'skipped' : err instanceof StepFail ? (err.kind === 'skipped' ? 'skipped' : err.kind) : 'error';
      campaignRepo.finishStep(id, status, err?.message ?? String(err), Date.now() - t0);
      throw err;
    }
  };

  const saveText = (file: string, type: string, text: string) => {
    const p = path.join(dir, file);
    fs.writeFileSync(p, text.length > 3_000_000 ? text.slice(-3_000_000) : text);
    campaignRepo.addArtifact(executionId, type, p);
  };

  // Wait until no other campaign is using this device.
  await waitFor(ctx, () => !busyDevices.has(deviceId), 60 * 60_000, 3000);
  busyDevices.add(deviceId);

  let final: ExecutionStatus = 'passed';
  let errorSummary: string | null = null;
  try {
    if (!device) throw new StepFail('Device profile was deleted', 'error');
    if (!apk?.package_name) throw new StepFail('APK has no package name (aapt could not read it)', 'error');
    const pkg: string = apk.package_name;
    assertPackage(pkg);

    // 1. Device
    await step(device.type === 'emulator' ? 'Boot emulator' : 'Connect device', async () => {
      const r = await prepareDevice(ctx, device, () => (startedEmulator = true));
      serial = r.serial;
      campaignRepo.updateExecution(executionId, { serial: r.serial });
      return r.detail;
    });
    const s = serial!;

    const info = await adb.inspect(s);
    Object.assign(metrics, { android_version: info.android_version, api_level: info.api_level, model: info.model, resolution: info.resolution });
    if (apk.min_sdk && info.api_level && info.api_level < apk.min_sdk) {
      throw new StepFail(`APK needs Android API ${apk.min_sdk}+, device is API ${info.api_level}`, 'skipped');
    }

    // 2. Install
    await step('Install APK', async () => {
      let note = '';
      if (cfg.fresh_install && (await adb.isInstalled(s, pkg))) {
        await adb.uninstall(s, pkg);
        note = 'Removed previous install. ';
      }
      const t0 = Date.now();
      const r = await adb.install(s, apk.storage_path);
      const out = `${r.stdout}\n${r.stderr}`;
      if (!/Success/.test(out)) {
        const reason = out.match(/Failure \[([^\]]+)\]/)?.[1] ?? r.error ?? out.trim().split(/\r?\n/).pop() ?? 'install failed';
        throw new StepFail(`Install failed: ${reason}`);
      }
      metrics.install_ms = Date.now() - t0;
      return `${note}Installed ${pkg} ${apk.version_name ?? ''} in ${((Date.now() - t0) / 1000).toFixed(1)} s`;
    });

    const component = await adb.launcherActivity(s, pkg);

    // 3. Open → check → close, `cycles` times
    for (let cycle = 1; cycle <= cfg.cycles; cycle++) {
      const label = cfg.cycles > 1 ? ` (cycle ${cycle}/${cfg.cycles})` : '';
      await adb.clearLogcat(s);

      await step(`Open app${label}`, async () => {
        if (component) {
          const t0 = Date.now();
          const r = await adb.startActivity(s, component);
          if (!r.ok) throw new StepFail(`Launch failed: ${r.error ?? r.output.slice(0, 300)}`);
          if (r.slow) {
            // am start stopped waiting at ~10 s; give the app up to 60 s more to reach the foreground.
            // If the process dies meanwhile, the next step reads logcat and reports the crash properly.
            const up = await waitFor(ctx, async () => (await adb.foregroundPackage(s)) === pkg, 60_000, 2000);
            const secs = ((Date.now() - t0) / 1000).toFixed(1);
            metrics.slow_start = true;
            if (up) {
              (metrics.launch_times_ms as number[]).push(Date.now() - t0);
              return `Started ${component} — slow cold start: on screen after ~${secs} s (Android stops timing at 10 s). Normal for a big app on a slow or headless emulator.`;
            }
            if (await adb.pidOf(s, pkg)) return `Started ${component} — process running but still not in front after ${secs} s (very slow start)`;
            return `Started ${component}, but the process ended within ${secs} s — checking logcat`;
          }
          if (r.total_time_ms !== null) (metrics.launch_times_ms as number[]).push(r.total_time_ms);
          return `Started ${component}${r.total_time_ms !== null ? ` — first frame in ${r.total_time_ms} ms` : ''}`;
        }
        const r = await adb.monkeyLaunch(s, pkg);
        if (!r.ok) throw new StepFail(`App has no launcher activity or could not be started: ${r.output.slice(0, 300)}`);
        return `Started ${pkg} via launcher intent`;
      });

      await step(`App stays open for ${cfg.launch_wait_seconds}s${label}`, async () => {
        const end = Date.now() + cfg.launch_wait_seconds * 1000;
        while (Date.now() < end) {
          if (ctx.cancelled) throw new Cancelled();
          await sleep(Math.min(2000, end - Date.now()));
          if (!(await adb.pidOf(s, pkg))) break; // died early — stop waiting
        }
        const [pid, fg, log] = await Promise.all([adb.pidOf(s, pkg), adb.foregroundPackage(s), adb.dumpLogcat(s)]);
        saveText(`logcat-${cycle}.txt`, 'logcat', log);
        const shot = await adb.screenshot(s);
        if (shot) {
          const p = path.join(dir, `screen-${cycle}.png`);
          fs.writeFileSync(p, shot);
          campaignRepo.addArtifact(executionId, 'screenshot', p);
        }
        const crash = findCrash(log, pkg);
        if (crash) {
          saveText(`crash-${cycle}.txt`, crash.kind, crash.excerpt);
          metrics.crash = crash.kind;
          const first = crash.excerpt.split('\n').find((l) => /Exception|Error|ANR in|signal/.test(l) && !l.includes('FATAL EXCEPTION'))?.trim();
          throw new StepFail(`${crash.kind === 'anr' ? 'App not responding (ANR)' : crash.kind === 'native_crash' ? 'Native crash' : 'App crashed'}${first ? `: ${first.replace(/^.*?(?=\w+(\.\w+)+(Exception|Error))/, '')}` : ''}`);
        }
        if (!pid) throw new StepFail('App process exited on its own (no crash log found)');
        if (fg && fg !== pkg) return `Running (pid ${pid}) but another app is in front: ${fg}`;
        return `Running in the foreground (pid ${pid}), no crash or ANR in logcat`;
      });

      await step(`Close app${label}`, async () => {
        await adb.forceStop(s, pkg);
        const stopped = await waitFor(ctx, async () => !(await adb.pidOf(s, pkg)), 10_000, 1000);
        if (!stopped) throw new StepFail('App process still alive after force-stop');
        return 'Force-stopped, process gone';
      });
    }

    if (cfg.uninstall_after) {
      await step('Uninstall APK', async () => {
        const r = await adb.uninstall(s, pkg);
        if (!/Success/.test(r.stdout)) throw new StepFail(`Uninstall failed: ${r.stdout.trim() || r.error}`, 'error');
        return 'Uninstalled';
      });
    }
  } catch (err: any) {
    if (err instanceof Cancelled) {
      final = 'cancelled';
      errorSummary = 'Cancelled by user';
    } else if (err instanceof StepFail) {
      final = err.kind === 'skipped' ? 'skipped' : err.kind;
      errorSummary = err.message;
    } else {
      final = 'error';
      errorSummary = err?.message ?? String(err);
    }
  } finally {
    const times = metrics.launch_times_ms as number[];
    if (times.length) metrics.avg_launch_ms = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
    if (startedEmulator && device) {
      // Always stop an emulator that failed to come up; otherwise follow the campaign option.
      if (cfg.stop_emulators_after || final === 'error' || final === 'cancelled') await emulatorManager.stop(device.id).catch(() => {});
      else keptRunning.add(device.id);
    }
    busyDevices.delete(deviceId);
    campaignRepo.updateExecution(executionId, { status: final, error_summary: errorSummary, completed_at: now(), metrics });
    if (device) db.prepare('UPDATE devices SET last_execution = ? WHERE id = ?').run(now(), device.id);
    try {
      if (bugRepo.fromExecution(executionId)) bus.publish({ event: 'bug_found', data: { campaign_id: ctx.campaignId, execution_id: executionId } });
    } catch {
      /* classification must never break a run */
    }
    publishExecution(ctx.campaignId, executionId, final);
  }
}

/** Get a ready ADB serial for the profile, booting the emulator if needed. */
async function prepareDevice(ctx: Ctx, device: DeviceRow, onStarted: () => void): Promise<{ serial: string; started: boolean; detail: string }> {
  if (device.type !== 'emulator') {
    if (!device.adb_serial) throw new StepFail('Profile has no ADB serial — connect the phone and use "Add as profile"', 'error');
    const { devices } = await adb.devices();
    const d = devices.find((x) => x.serial === device.adb_serial);
    if (!d) throw new StepFail(`${device.adb_serial} is not connected (USB cable / Wi-Fi debugging?)`, 'error');
    if (d.state !== 'device') throw new StepFail(`Device state is "${d.state}"${d.state === 'unauthorized' ? ' — accept the USB debugging prompt on the phone' : ''}`, 'error');
    deviceRepo.setStatus(device.id, { status: 'online', last_health_check: now() });
    return { serial: device.adb_serial, started: false, detail: `Connected (${d.model ?? device.adb_serial})` };
  }

  if (!device.avd_name) throw new StepFail('Emulator profile has no AVD name', 'error');
  const { avds } = await emulatorManager.listAvds();
  if (!avds.includes(device.avd_name)) throw new StepFail(`AVD ${device.avd_name} is not installed — press "Set up" on the Device Manager page`, 'error');

  let started = false;
  if (!emulatorManager.get(device.id)) {
    // Wait for a free emulator slot. Check + start happen in the same tick, so workers cannot over-book.
    const got = await waitFor(
      ctx,
      () => {
        const running = emulatorManager.list();
        if (running.length >= config.MAX_CONCURRENT_EMULATORS) {
          // Slots full of emulators we left running ("keep emulators running") that nobody is using → free one.
          const idle = running.find((r) => keptRunning.has(r.device_id) && !busyDevices.has(r.device_id));
          if (idle) {
            keptRunning.delete(idle.device_id);
            void emulatorManager.stop(idle.device_id);
          }
          return false;
        }
        if (running.some((r) => !r.booted)) return false; // one boot at a time
        if (running.length > 0 && systemMonitor.capacity().startable_now < 1) return false;
        emulatorManager.start({ device_id: device.id, avd_name: device.avd_name!, ram_mb: device.ram_mb ?? undefined });
        return true;
      },
      30 * 60_000,
      3000,
    );
    if (!got) throw new StepFail('No free emulator slot for 30 minutes', 'error');
    started = true;
    onStarted();
  }

  // The emulator manager decides when a boot has failed (it allows more time when a fast boot falls back to a cold
  // boot on a busy PC); this wait only has a generous safety cap.
  const booted = await waitFor(ctx, () => {
    const e = emulatorManager.get(device.id);
    if (!e) throw new StepFail(deviceRepo.get(device.id)?.last_error ?? 'Emulator exited during boot', 'error');
    const failed = emulatorManager.bootFailed(device.id);
    if (failed) throw new StepFail(failed, 'error');
    return e.booted;
  }, Math.max(config.DEVICE_BOOT_TIMEOUT_SECONDS + 10, 15 * 60) * 1000);
  if (!booted) throw new StepFail('Emulator did not finish booting in 15 minutes', 'error');

  const serial = emulatorManager.get(device.id)!.serial;
  const pmReady = await waitFor(ctx, () => adb.packageManagerReady(serial), 90_000, 2000);
  if (!pmReady) throw new StepFail('Android booted but the package manager is not responding', 'error');
  if (started) {
    // A freshly booted emulator is still busy (launcher, Play services, dexopt) — the first app launch can
    // miss am start's 10 s window. Wait for the home screen, then give it a few seconds to calm down.
    await waitFor(ctx, async () => !!(await adb.foregroundPackage(serial)), 60_000, 2000);
    await waitFor(ctx, () => false, 8_000, 1000);
  }
  return { serial, started, detail: started ? `Booted ${device.avd_name} as ${serial}` : `Reused running ${device.avd_name} (${serial})` };
}
