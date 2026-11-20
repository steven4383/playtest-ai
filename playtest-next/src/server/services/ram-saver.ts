import os from 'node:os';
import { config } from '../config';
import { writeEnv } from '../core/env-file';
import { campaignRunner } from '../automation/campaign-runner';
import { emulatorManager, pidsByPort } from '../automation/emulator';
import { flutterRunner } from '../automation/flutter-run';
import { run } from '../automation/sdk';
import { systemMonitor } from './system-monitor';

/**
 * RAM saver for the PC: how much memory each emulator and the biggest apps use, which emulators are idle,
 * and stopping idle emulators (by hand, or automatically for headless ones after EMULATOR_IDLE_STOP_MINUTES).
 * Other PC programs are only listed with a tip — PlayTest never closes them.
 */

const APPS: { re: RegExp; label: string; tip?: string }[] = [
  { re: /^qemu-system/i, label: 'Android emulators' },
  { re: /^emulator\.exe$|^emulator-check/i, label: 'Emulator launcher' },
  { re: /^studio64\.exe$/i, label: 'Android Studio', tip: 'Close it while you only test with PlayTest — it often uses 1–3 GB.' },
  { re: /^javaw?\.exe$/i, label: 'Java (Gradle daemons, sdkmanager)', tip: 'Idle Gradle daemons keep 0.5–2 GB each — run "gradlew --stop" in your project.' },
  { re: /^dart(aotruntime)?\.exe$/i, label: 'Dart / Flutter tools', tip: 'Stop finished "flutter run" sessions; the analysis server restarts on demand.' },
  { re: /^chrome\.exe$/i, label: 'Google Chrome', tip: 'Every tab is a process — close tabs you do not need.' },
  { re: /^msedge(webview2)?\.exe$/i, label: 'Microsoft Edge / WebView2' },
  { re: /^firefox\.exe$/i, label: 'Firefox' },
  { re: /^Code\.exe$/i, label: 'VS Code' },
  { re: /^node\.exe$/i, label: 'Node.js (PlayTest backend, dev servers)' },
  { re: /^(ms-)?teams\.exe$/i, label: 'Microsoft Teams' },
  { re: /^Discord\.exe$/i, label: 'Discord' },
  { re: /^Memory Compression$/i, label: 'Windows memory compression', tip: 'Large when RAM is short — Windows is compressing memory to cope.' },
  { re: /^MsMpEng\.exe$/i, label: 'Microsoft Defender' },
];
const SKIP = /^(System Idle Process|System|Registry|Secure System|smss\.exe|csrss\.exe|wininit\.exe)$/i;

async function processes(): Promise<{ name: string; pid: number; mb: number }[]> {
  if (process.platform !== 'win32') return [];
  const r = await run('tasklist', ['/FO', 'CSV', '/NH'], 15_000);
  const out: { name: string; pid: number; mb: number }[] = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const cols = line.match(/"([^"]*)"/g)?.map((c) => c.slice(1, -1));
    if (!cols || cols.length < 5) continue;
    const kb = Number(cols[4].replace(/[^\d]/g, ''));
    if (cols[0] && kb) out.push({ name: cols[0], pid: Number(cols[1]), mb: Math.round(kb / 1024) });
  }
  return out;
}

const activeFlutterSerials = () => new Set(flutterRunner.list().filter((s) => !['stopped', 'error'].includes(s.status)).map((s) => s.serial));

/** A test run or a `flutter run` session counts as use, so those emulators never look idle. */
function touchBusy() {
  const busy = new Set(campaignRunner.busyDevices());
  const flutter = activeFlutterSerials();
  for (const e of emulatorManager.list()) if (busy.has(e.device_id) || flutter.has(e.serial)) emulatorManager.touch(e.serial);
}

export async function hostRam() {
  touchBusy();
  const emus = emulatorManager.list();
  const [procs, pids] = await Promise.all([processes().catch(() => []), pidsByPort(emus.map((e) => e.console_port)).catch(() => new Map<number, number>())]);
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const busy = new Set(campaignRunner.busyDevices());
  const flutter = activeFlutterSerials();
  const emulators = emus.map((e) => {
    const pid = pids.get(e.console_port) ?? null;
    return {
      device_id: e.device_id,
      avd_name: e.avd_name,
      serial: e.serial,
      booted: e.booted,
      headless: e.headless ?? null,
      adopted: !!e.adopted,
      pid,
      mem_mb: pid ? (byPid.get(pid)?.mb ?? null) : null,
      guest_ram_mb: e.ram_mb,
      idle_s: e.idle_s,
      busy: busy.has(e.device_id),
      flutter: flutter.has(e.serial),
    };
  });

  const groups = new Map<string, { label: string; mb: number; count: number; tip?: string }>();
  for (const p of procs) {
    if (SKIP.test(p.name)) continue;
    const app = APPS.find((a) => a.re.test(p.name));
    const key = app?.label ?? p.name;
    const g = groups.get(key) ?? { label: key, mb: 0, count: 0, tip: app?.tip };
    g.mb += p.mb;
    g.count++;
    groups.set(key, g);
  }
  const m = systemMonitor.latest()?.memory;
  const totalMb = Math.round((m?.total_gb ?? os.totalmem() / 1024 ** 3) * 1024);
  const availMb = Math.round((m?.available_gb ?? os.freemem() / 1024 ** 3) * 1024);
  return {
    total_mb: totalMb,
    available_mb: availMb,
    used_pct: totalMb ? Math.round(((totalMb - availMb) / totalMb) * 100) : null,
    emulators,
    top: [...groups.values()].sort((a, b) => b.mb - a.mb).slice(0, 10),
    idle_stop_minutes: config.EMULATOR_IDLE_STOP_MINUTES,
  };
}

/** Stop emulators nobody has used for `minutes` (never one a test run or `flutter run` is using). */
export async function stopIdleEmulators(minutes: number, opts: { headlessOnly: boolean; reason: string }) {
  touchBusy();
  const busy = new Set(campaignRunner.busyDevices());
  const flutter = activeFlutterSerials();
  const targets = emulatorManager
    .list()
    .filter((e) => e.booted && !busy.has(e.device_id) && !flutter.has(e.serial) && e.idle_s >= minutes * 60 && (!opts.headlessOnly || e.headless === true));
  const stopped: string[] = [];
  const failed: { avd_name: string; error: string }[] = [];
  for (const t of targets) {
    try {
      await emulatorManager.stop(t.device_id, opts.reason);
      stopped.push(t.avd_name);
    } catch (err: any) {
      failed.push({ avd_name: t.avd_name, error: err?.message ?? String(err) });
    }
  }
  return { stopped, failed };
}

export function setIdleStopMinutes(minutes: number) {
  config.EMULATOR_IDLE_STOP_MINUTES = minutes;
  writeEnv({ EMULATOR_IDLE_STOP_MINUTES: String(minutes) });
  return { idle_stop_minutes: minutes };
}

/** Every minute: keep "idle" honest for busy devices and, if enabled, stop headless emulators idle for too long. */
export function startIdleWatcher(): NodeJS.Timeout {
  return setInterval(() => {
    touchBusy();
    const min = config.EMULATOR_IDLE_STOP_MINUTES;
    if (min > 0) void stopIdleEmulators(min, { headlessOnly: true, reason: `RAM saver: stopped after ${min} min without use` }).catch(() => {});
  }, 60_000).unref();
}
