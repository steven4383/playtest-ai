import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { bus } from '../core/events.js';
import { deviceRepo } from '../services/devices.js';
import { adb } from './adb.js';
import { avdHome, run, tools } from './sdk.js';

export type BootMode = 'fast' | 'cold' | 'first';

export interface RunningEmulator {
  device_id: string;
  avd_name: string;
  serial: string;
  console_port: number;
  pid?: number;
  ram_mb: number;
  started_at: string;
  booted: boolean;
  /** Found already running (e.g. after a backend restart) rather than started by this process. */
  adopted?: boolean;
  /** Started without a window (-no-window). Unknown for adopted emulators. */
  headless?: boolean;
  /** What the emulator is doing before it is ready, e.g. "Android is booting". */
  phase?: string;
  /** 0-100 while booting, 100 once ready. Estimated from the boot stage and this AVD's previous boot times. */
  progress?: number;
  /** fast = resumes the clean snapshot, first = cold boot that saves it, cold = plain cold boot. */
  boot_mode?: BootMode;
  /** How long this kind of boot took last time for this AVD (ms) — drives the progress bar and ETA. */
  expected_ms?: number;
  /** How long the boot really took (ms), once ready. */
  boot_ms?: number;
}

export interface BootProgress {
  device_id: string;
  serial: string;
  avd_name: string;
  progress: number;
  phase: string | null;
  mode: BootMode | null;
  elapsed_s: number;
  /** Seconds left by the estimate; null once it is taking longer than usual. */
  eta_s: number | null;
  booted: boolean;
}

/** Snapshot every emulator starts from: booted, home screen, animations off. Never saved over (-no-snapshot-save). */
export const FAST_BOOT_SNAPSHOT = 'playtest_clean';

const AVD_RE = /^[\w.-]+$/;
const running = new Map<string, RunningEmulator & { child?: ChildProcess }>();
/** Console ports of emulators we don't manage (Android Studio etc.), so a new one never collides. */
let foreignPorts = new Set<number>();
/** serial → last time someone used it from the dashboard (screen, input, tools). Drives "idle" for the RAM saver. */
const lastUse = new Map<string, number>();
/** serial → emulators started outside PlayTest (terminal, Android Studio) whose boot we are following. */
const external = new Map<string, RunningEmulator>();
/** Outside emulators already seen fully booted (not followed again until they disappear). */
const externalDone = new Set<string>();

function nextFreePort(): number {
  const used = new Set([...running.values()].map((r) => r.console_port).concat([...foreignPorts]));
  for (let p = 5554; p <= 5682; p += 2) if (!used.has(p)) return p;
  throw new Error('No free emulator console port between 5554 and 5682');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const portOf = (serial: string) => Number(serial.match(/^emulator-(\d+)$/)?.[1]) || null;

/** CPU cores per emulator: EMULATOR_CORES, or half the host threads clamped to 2-4. */
export const emulatorCores = () => config.EMULATOR_CORES || Math.max(2, Math.min(4, Math.floor(os.cpus().length / 2)));

// ---------------------------------------------------------------- boot progress

/**
 * Boot stages, the part of the 0-100 bar each one covers, and the share of the expected boot time it usually takes.
 * Inside a stage the bar eases towards the end of its range (fast at first, slower later), so it keeps moving on a
 * slow PC instead of freezing, but never claims the next stage before it really starts.
 */
const STAGES = {
  process: { label: 'Starting the emulator', from: 1, to: 12, share: 0.06 },
  adb: { label: 'Loading Android', from: 12, to: 35, share: 0.3 },
  android: { label: 'Starting Android services', from: 35, to: 88, share: 0.45 },
  home: { label: 'Drawing the home screen', from: 88, to: 95, share: 0.05 },
  snapshot: { label: 'Saving the fast-boot snapshot (first start only)', from: 95, to: 100, share: 0.15 },
} as const;
type Stage = keyof typeof STAGES;
/** device_id → current stage and when it began. */
const stageOf = new Map<string, { stage: Stage; at: number; from?: number; label?: string }>();

/** Typical boot times when this AVD has never booted here before. */
const DEFAULT_BOOT_MS: Record<BootMode, number> = { fast: 12_000, cold: 80_000, first: 110_000 };
const bootTimesFile = () => path.join(config.STORAGE_DIR, 'boot-times.json');
type BootTimes = Record<string, Partial<Record<BootMode, number>>>;

function readBootTimes(): BootTimes {
  try {
    return JSON.parse(fs.readFileSync(bootTimesFile(), 'utf8'));
  } catch {
    return {};
  }
}

/** Remember how long a boot took (smoothed, so one slow boot does not swing the next estimate much). */
function saveBootTime(avd: string, mode: BootMode, ms: number) {
  const all = readBootTimes();
  const prev = all[avd]?.[mode];
  all[avd] = { ...all[avd], [mode]: prev ? Math.round(prev * 0.4 + ms * 0.6) : ms };
  try {
    fs.mkdirSync(config.STORAGE_DIR, { recursive: true });
    fs.writeFileSync(bootTimesFile(), JSON.stringify(all, null, 2));
  } catch {
    /* estimate only */
  }
}

/** The AVD's data folder (from <avd home>/<name>.ini), or null. */
export function avdDataDir(avd: string): string | null {
  const home = avdHome();
  try {
    const ini = fs.readFileSync(path.join(home, `${avd}.ini`), 'utf8');
    const p = ini.match(/^path=(.+)$/m)?.[1]?.trim();
    if (p && fs.existsSync(p)) return p;
    const rel = ini.match(/^path\.rel=(.+)$/m)?.[1]?.trim();
    if (rel && fs.existsSync(path.join(path.dirname(home), rel))) return path.join(path.dirname(home), rel);
  } catch {
    /* fall through */
  }
  const d = path.join(home, `${avd}.avd`);
  return fs.existsSync(d) ? d : null;
}

/**
 * A killed emulator leaves *.lock entries (hardware-qemu.ini.lock …) in its AVD folder. The next start then thinks the
 * AVD is already running and boots read-only from a temporary copy: no fast-boot snapshot, a slow cold boot every time.
 * Remove them before starting an AVD nobody is running. Skipped while emulators we can't identify are up.
 */
function clearStaleLocks(avd: string): string[] {
  if (foreignPorts.size || [...running.values()].some((r) => r.avd_name === avd)) return [];
  const dir = avdDataDir(avd);
  if (!dir) return [];
  const removed: string[] = [];
  for (const n of fs.readdirSync(dir)) {
    if (!n.endsWith('.lock') || n.toLowerCase() === 'multiinstance.lock') continue;
    try {
      fs.rmSync(path.join(dir, n), { recursive: true, force: true });
      removed.push(n);
    } catch {
      /* really in use */
    }
  }
  return removed;
}

export function hasFastBootSnapshot(avd: string): boolean {
  const d = avdDataDir(avd);
  return !!d && fs.existsSync(path.join(d, 'snapshots', FAST_BOOT_SNAPSHOT));
}

function bootInfo(e: RunningEmulator): BootProgress {
  const elapsed = Date.now() - Date.parse(e.started_at);
  const expected = e.expected_ms ?? DEFAULT_BOOT_MS.cold;
  return {
    device_id: e.device_id,
    serial: e.serial,
    avd_name: e.avd_name,
    progress: e.booted ? 100 : Math.max(1, Math.floor(e.progress ?? 1)),
    phase: e.booted ? null : (e.phase ?? STAGES.process.label),
    mode: e.boot_mode ?? null,
    elapsed_s: Math.round((e.boot_ms ?? elapsed) / 1000),
    eta_s: e.booted ? 0 : elapsed < expected ? Math.ceil((expected - elapsed) / 1000) : null,
    booted: e.booted,
  };
}

const lastProgressSig = new Map<string, string>();
function publishProgress(e: RunningEmulator) {
  const info = bootInfo(e);
  const sig = `${info.progress}|${info.phase}|${info.eta_s}`;
  if (lastProgressSig.get(e.device_id) === sig) return;
  lastProgressSig.set(e.device_id, sig);
  bus.publish({ event: 'boot_progress', data: info });
}

/** Move the bar for `stage`: never backwards, easing towards (never reaching) the end of the stage's range. */
function setStage(e: RunningEmulator, stage: Stage) {
  let cur = stageOf.get(e.device_id);
  if (cur?.stage !== stage) {
    cur = { stage, at: Date.now() };
    stageOf.set(e.device_id, cur);
  }
  const s = STAGES[stage];
  const from = Math.max(s.from, cur.from ?? s.from);
  const tau = Math.max(4000, (e.expected_ms ?? DEFAULT_BOOT_MS.cold) * s.share);
  const p = from + (s.to - 1 - from) * (1 - Math.exp(-(Date.now() - cur.at) / tau));
  e.progress = Math.max(e.progress ?? 0, Math.round(p * 10) / 10);
  e.phase = cur.label ?? s.label;
  publishProgress(e);
}

// ---------------------------------------------------------------- stopping

async function serialGone(serial: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { devices } = await adb.devices();
    if (!devices.some((d) => d.serial === serial)) return true;
    await sleep(1000);
  }
  return false;
}

/** netstat → PID of the process listening on 127.0.0.1:<port> (the emulator's qemu process for a console port). */
export async function pidsByPort(ports: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (process.platform !== 'win32' || !ports.length) return out;
  const r = await run('netstat', ['-ano', '-p', 'TCP'], 10_000);
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!/\bLISTENING\b/.test(line)) continue;
    for (const port of ports) {
      if (line.includes(`127.0.0.1:${port} `)) {
        const pid = Number(line.trim().split(/\s+/).pop());
        if (pid) out.set(port, pid);
      }
    }
  }
  return out;
}

/** Last resort: kill the emulator process that owns the console port (Windows: netstat -> taskkill). */
async function killByConsolePort(port: number): Promise<boolean> {
  const pid = (await pidsByPort([port])).get(port);
  if (!pid || pid === process.pid) return false;
  return (await run('taskkill', ['/PID', String(pid), '/T', '/F'], 15_000)).ok;
}

async function emu(serial: string, args: string[], timeoutMs = 20_000) {
  return run(tools.adb(), ['-s', serial, 'emu', ...args], timeoutMs);
}

let accelCache: { at: number; text: string } | null = null;

export const emulatorManager = {
  async listAvds(): Promise<{ avds: string[]; error?: string }> {
    const r = await run(tools.emulator(), ['-list-avds'], 15_000);
    if (!r.ok) return { avds: [], error: r.error };
    return {
      avds: r.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('INFO') && AVD_RE.test(s)),
    };
  },

  list(): (RunningEmulator & { idle_s: number })[] {
    return [...running.values()].map(({ child, ...rest }) => ({ ...rest, idle_s: this.idleSeconds(rest.serial, rest.started_at) }));
  },

  /** Set when the boot gave up (waitForBoot timed out) — the test runner stops waiting then. */
  bootFailed(deviceId: string): string | null {
    const p = running.get(deviceId)?.phase;
    return p?.startsWith('Boot timed out') ? p : null;
  },

  /** Boot progress of every emulator PlayTest is tracking (booting ones and ready ones). */
  boot(): BootProgress[] {
    return [...running.values(), ...external.values()].map(bootInfo);
  },

  count(): number {
    return running.size;
  },

  get(deviceId: string) {
    return running.get(deviceId);
  },

  /** Mark a device as used just now (dashboard screen, input, tools), so the RAM saver doesn't call it idle. */
  touch(serial: string) {
    lastUse.set(serial, Date.now());
  },

  idleSeconds(serial: string, startedAt?: string) {
    const last = Math.max(lastUse.get(serial) ?? 0, startedAt ? Date.parse(startedAt) : 0);
    return last ? Math.round((Date.now() - last) / 1000) : 0;
  },

  /**
   * Start an AVD and wait (in the background) for it to be usable, publishing `boot_progress` as it goes.
   * The AVD name is not assumed to equal the ADB serial — the serial is
   * derived from the console port we assign and then verified (section 5.2).
   */
  start(opts: { device_id: string; avd_name: string; ram_mb?: number; headless?: boolean; fast_boot?: boolean }): RunningEmulator {
    if (!AVD_RE.test(opts.avd_name)) throw new Error(`Invalid AVD name: ${opts.avd_name}`);
    if (running.has(opts.device_id)) throw new Error('Emulator for this device is already running');

    const port = nextFreePort();
    const serial = `emulator-${port}`;
    const ram = opts.ram_mb ?? config.EMULATOR_RAM_MB;
    const headless = opts.headless ?? config.EMULATOR_HEADLESS;
    const fastBoot = opts.fast_boot ?? config.EMULATOR_FAST_BOOT;
    const staleLocks = clearStaleLocks(opts.avd_name);
    if (staleLocks.length) console.warn(`[emulator] removed stale locks in ${opts.avd_name}: ${staleLocks.join(', ')}`);
    const mode: BootMode = !fastBoot ? 'cold' : hasFastBootSnapshot(opts.avd_name) ? 'fast' : 'first';

    const args = [
      '-avd', opts.avd_name,
      '-port', String(port),
      '-memory', String(ram),
      '-cores', String(emulatorCores()),
      '-gpu', config.EMULATOR_GPU_MODE,
      '-no-audio',
      '-no-boot-anim',
      '-netfast',
      // Fast boot: resume the saved clean snapshot (seconds) instead of a cold boot (1-2 min).
      // If it does not exist yet the emulator cold-boots and waitForBoot saves it once.
      ...(fastBoot ? ['-snapshot', FAST_BOOT_SNAPSHOT] : []),
      '-no-snapshot-save',
      ...(headless ? ['-no-window'] : []),
    ];

    const child = spawn(tools.emulator(), args, { stdio: 'ignore', windowsHide: true });
    const entry: RunningEmulator & { child?: ChildProcess } = {
      device_id: opts.device_id,
      avd_name: opts.avd_name,
      serial,
      console_port: port,
      pid: child.pid,
      ram_mb: ram,
      started_at: new Date().toISOString(),
      booted: false,
      headless,
      boot_mode: mode,
      expected_ms: readBootTimes()[opts.avd_name]?.[mode] ?? DEFAULT_BOOT_MS[mode],
      progress: 1,
      phase: STAGES.process.label,
      child,
    };
    running.set(opts.device_id, entry);
    lastProgressSig.delete(opts.device_id);
    bus.publish({ event: 'device_starting', data: { device_id: opts.device_id, serial } });
    publishProgress(entry);

    child.on('error', (err: NodeJS.ErrnoException) => {
      running.delete(opts.device_id);
      const message = err.code === 'ENOENT' ? 'Android emulator binary not found — install the SDK emulator package or set ANDROID_SDK_ROOT' : err.message;
      bus.publish({ event: 'device_error', data: { device_id: opts.device_id, message } });
    });
    child.on('exit', () => {
      if (running.get(opts.device_id)?.child === child) {
        running.delete(opts.device_id);
        bus.publish({ event: 'device_stopped', data: { device_id: opts.device_id, serial } });
      }
    });

    void this.waitForBoot(opts.device_id, serial, fastBoot);
    const { child: _c, ...pub } = entry;
    return pub;
  },

  /**
   * Follow the boot stage by stage (process → ADB → Android → home screen → first-boot snapshot) until the
   * launcher is drawn, so "ready" means a real screen instead of a black one.
   */
  async waitForBoot(deviceId: string, serial: string, fastBoot = false) {
    // A first boot on a busy PC can take 3+ minutes: allow at least twice what this kind of boot took last time.
    let limitMs = Math.max(config.DEVICE_BOOT_TIMEOUT_SECONDS * 1000, (running.get(deviceId)?.expected_ms ?? 0) * 2);
    let deadline = Date.now() + limitMs;
    stageOf.delete(deviceId);
    let homeSince: number | null = null;
    let notBootedSince: number | null = null;
    let fellBack = false;
    while (Date.now() < deadline) {
      const entry = running.get(deviceId);
      if (!entry || entry.serial !== serial) return;
      const { devices } = await adb.devices();
      const d = devices.find((x) => x.serial === serial);
      if (!d) setStage(entry, 'process');
      else if (d.state !== 'device') setStage(entry, 'adb');
      else if (!(await adb.bootCompleted(serial))) {
        // A restored snapshot is booted the moment ADB sees it. Still booting 15 s later = the snapshot could not be
        // used and it fell back to a cold boot: switch the estimate and allow the time a cold boot needs.
        notBootedSince ??= Date.now();
        if (entry.boot_mode === 'fast' && Date.now() - notBootedSince > 15_000) {
          fellBack = true;
          entry.boot_mode = 'cold';
          entry.expected_ms = readBootTimes()[entry.avd_name]?.first ?? readBootTimes()[entry.avd_name]?.cold ?? DEFAULT_BOOT_MS.cold;
          limitMs = Math.max(limitMs, Date.now() - Date.parse(entry.started_at) + entry.expected_ms * 2);
          deadline = Date.parse(entry.started_at) + limitMs;
          // Keep the bar where it is and spread the rest of this stage over the cold boot.
          stageOf.set(deviceId, { stage: 'android', at: Date.now(), from: entry.progress, label: 'Cold booting — the fast-boot snapshot could not be used' });
        }
        setStage(entry, 'android');
      } else {
        setStage(entry, 'home');
        homeSince ??= Date.now();
        // A restored snapshot was saved on the home screen, so it is drawn already — only cold boots need the check
        // (and dumpsys is slow right after a restore, which would add ~10 s for nothing).
        const restored = entry.boot_mode === 'fast' && !fellBack;
        const home = restored ? 'snapshot' : await adb.foregroundPackage(serial).catch(() => null);
        if (home || Date.now() - homeSince > 30_000) {
          // First boot saves the snapshot; after a fallback, save it again so the next start is fast again.
          if (fastBoot) await this.prepareSnapshot(deviceId, serial, fellBack).catch(() => {});
          if (running.get(deviceId) !== entry) return;
          entry.booted = true;
          entry.progress = 100;
          entry.phase = undefined;
          entry.boot_ms = Date.now() - Date.parse(entry.started_at);
          if (!entry.adopted && entry.boot_mode) saveBootTime(entry.avd_name, entry.boot_mode, entry.boot_ms);
          publishProgress(entry);
          bus.publish({ event: 'device_ready', data: { device_id: deviceId, serial } });
          return;
        }
      }
      await sleep(1000);
    }
    const entry = running.get(deviceId);
    const msg = `Boot timed out after ${Math.round(limitMs / 1000)}s — free RAM (Device Manager → Memory) or raise DEVICE_BOOT_TIMEOUT_SECONDS`;
    if (entry) entry.phase = msg;
    bus.publish({ event: 'device_error', data: { device_id: deviceId, serial, message: msg } });
  },

  /**
   * After the first cold boot: turn animations off (faster, steadier tests), let the home screen settle and save the
   * clean state as a snapshot. Later starts resume it in seconds. Skipped when the snapshot already exists, unless
   * `replace` (the old one could not be loaded, e.g. after the AVD's hardware settings changed).
   */
  async prepareSnapshot(deviceId: string, serial: string, replace = false) {
    const list = await emu(serial, ['avd', 'snapshot', 'list']);
    if (!list.ok || (list.stdout.includes(FAST_BOOT_SNAPSHOT) && !replace)) return;
    const entry = running.get(deviceId);
    const tick = entry ? setInterval(() => setStage(entry, 'snapshot'), 1000) : null;
    if (entry) setStage(entry, 'snapshot');
    try {
      bus.publish({ event: 'device_starting', data: { device_id: deviceId, serial, message: 'First boot: saving a fast-boot snapshot so the next start takes seconds' } });
      for (const k of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) await adb.shell(serial, ['settings', 'put', 'global', k, '0'], 10_000);
      for (let i = 0; i < 30 && !(await adb.foregroundPackage(serial)); i++) await sleep(2000); // home screen up
      await sleep(15_000); // let first-boot jobs calm down so the snapshot is quiet
      await emu(serial, ['avd', 'snapshot', 'save', FAST_BOOT_SNAPSHOT], 180_000);
    } finally {
      if (tick) clearInterval(tick);
    }
  },

  /** Stop one emulator by serial: `adb emu kill`, then kill the process holding its console port. */
  async stopSerial(serial: string): Promise<'emu_kill' | 'process_kill'> {
    if (!/^emulator-\d+$/.test(serial)) throw new Error('Only emulators can be stopped');
    await adb.emuKill(serial);
    if (await serialGone(serial, 12_000)) return 'emu_kill';
    const port = portOf(serial);
    if (port && (await killByConsolePort(port)) && (await serialGone(serial, 10_000))) return 'process_kill';
    throw new Error(`${serial} did not stop - close qemu-system-x86_64 in Task Manager`);
  },

  /** Stop the emulator of a profile - also one this backend did not start (matched by AVD name). */
  async stop(deviceId: string, reason?: string): Promise<boolean> {
    let entry = running.get(deviceId);
    if (!entry) {
      await this.sync();
      entry = running.get(deviceId);
    }
    if (!entry) return false;
    try {
      await this.stopSerial(entry.serial);
    } finally {
      entry.child?.kill();
      if (running.get(deviceId) === entry) {
        running.delete(deviceId);
        bus.publish({ event: 'device_stopped', data: { device_id: deviceId, serial: entry.serial, message: reason } });
      }
    }
    return true;
  },

  /** Profile that owns a running emulator serial, if any. */
  profileOf(serial: string): string | null {
    return [...running.values()].find((r) => r.serial === serial)?.device_id ?? null;
  },

  /**
   * Match running emulators to profiles (by AVD name) and drop ones that disappeared. Runs at startup and every
   * few seconds, so emulators survive backend restarts and can always be stopped from the dashboard.
   */
  async sync(): Promise<void> {
    const { devices, error } = await adb.devices();
    if (error) return;
    const present = new Set(devices.filter((d) => d.is_emulator).map((d) => d.serial));
    for (const [id, e] of running) {
      if (e.adopted && !present.has(e.serial)) {
        running.delete(id);
        bus.publish({ event: 'device_stopped', data: { device_id: id, serial: e.serial } });
      }
    }
    for (const s of externalDone) if (!present.has(s)) externalDone.delete(s);
    const tracked = new Set([...running.values()].map((e) => e.serial));
    const profiles = deviceRepo.list().filter((p) => p.type === 'emulator' && p.avd_name);
    const foreign = new Set<number>();
    for (const d of devices) {
      if (!d.is_emulator || tracked.has(d.serial)) continue;
      const port = portOf(d.serial);
      const name = d.state === 'device' ? await adb.emulatorAvdName(d.serial) : null;
      const profile = name ? profiles.find((p) => p.avd_name === name && !running.has(p.id)) : undefined;
      if (!profile || !port) {
        if (port) foreign.add(port);
        // Started outside PlayTest (terminal, Android Studio): still show its boot progress.
        if (!external.has(d.serial) && !externalDone.has(d.serial)) void this.watchExternal(d.serial);
        continue;
      }
      const booted = await adb.bootCompleted(d.serial);
      // Already followed as an outside emulator while it booted: keep its start time and progress.
      const ext = external.get(d.serial);
      external.delete(d.serial);
      running.set(profile.id, {
        device_id: profile.id,
        avd_name: name!,
        serial: d.serial,
        console_port: port,
        ram_mb: profile.ram_mb ?? config.EMULATOR_RAM_MB,
        started_at: ext?.started_at ?? new Date().toISOString(),
        booted,
        adopted: true,
        boot_mode: ext?.boot_mode,
        expected_ms: ext?.expected_ms,
        progress: booted ? 100 : Math.max(30, ext?.progress ?? 0),
        phase: booted ? undefined : STAGES.android.label,
      });
      if (ext) bus.publish({ event: 'device_stopped', data: { device_id: ext.device_id, serial: d.serial } }); // drop the outside entry
      bus.publish({ event: booted ? 'device_ready' : 'device_starting', data: { device_id: profile.id, serial: d.serial } });
      // Still booting (e.g. backend restarted mid-boot): keep following it so it turns "ready" by itself.
      if (!booted) void this.waitForBoot(profile.id, d.serial, false);
    }
    foreignPorts = foreign;
  },

  /**
   * Follow the boot of an emulator someone started outside PlayTest (e.g. `emulator -avd X -no-window -no-snapshot`)
   * so every view shows its progress too. Its start time is when ADB first listed it (a few seconds late at most).
   */
  async watchExternal(serial: string) {
    if (external.has(serial)) return;
    const e: RunningEmulator = {
      device_id: `ext:${serial}`,
      avd_name: serial,
      serial,
      console_port: portOf(serial) ?? 0,
      ram_mb: 0,
      started_at: new Date().toISOString(),
      booted: false,
      adopted: true,
      boot_mode: 'cold',
      expected_ms: DEFAULT_BOOT_MS.cold,
      progress: STAGES.adb.from,
      phase: STAGES.adb.label,
    };
    external.set(serial, e); // claim it before the first await, so the next sync doesn't start a second watcher
    if (await adb.bootCompleted(serial).catch(() => false)) {
      // Already up (e.g. an Android Studio emulator running since before): nothing to show.
      external.delete(serial);
      externalDone.add(serial);
      return;
    }
    const deadline = Date.now() + 20 * 60_000;
    let homeSince: number | null = null;
    while (Date.now() < deadline && external.get(serial) === e) {
      if (e.avd_name === serial) {
        const name = await adb.emulatorAvdName(serial).catch(() => null);
        if (name) {
          e.avd_name = name;
          const t = readBootTimes()[name];
          e.expected_ms = t?.cold ?? t?.first ?? DEFAULT_BOOT_MS.cold;
        }
      }
      const { devices } = await adb.devices();
      const d = devices.find((x) => x.serial === serial);
      if (external.get(serial) !== e) return; // adopted by a profile meanwhile
      if (!d) {
        external.delete(serial);
        bus.publish({ event: 'device_stopped', data: { device_id: e.device_id, serial } });
        return;
      }
      if (d.state !== 'device') setStage(e, 'adb');
      else if (!(await adb.bootCompleted(serial))) setStage(e, 'android');
      else {
        setStage(e, 'home');
        homeSince ??= Date.now();
        if ((await adb.foregroundPackage(serial).catch(() => null)) || Date.now() - homeSince > 30_000) {
          e.booted = true;
          e.progress = 100;
          e.phase = undefined;
          e.boot_ms = Date.now() - Date.parse(e.started_at);
          // Remember real cold boots of named AVDs, so the next estimate fits this PC.
          if (e.avd_name !== serial && e.boot_ms > 20_000) saveBootTime(e.avd_name, 'cold', e.boot_ms);
          publishProgress(e);
          external.delete(serial);
          externalDone.add(serial);
          bus.publish({ event: 'device_ready', data: { device_id: e.device_id, serial } });
          return;
        }
      }
      await sleep(1000);
    }
    if (external.get(serial) === e) external.delete(serial);
  },

  /** Hardware acceleration report from `emulator -accel-check` (cached 10 min) plus the speed settings. */
  async speedInfo() {
    if (!accelCache || Date.now() - accelCache.at > 600_000) {
      const r = await run(tools.emulator(), ['-accel-check'], 30_000);
      accelCache = { at: Date.now(), text: `${r.stdout}\n${r.stderr}` };
    }
    const line = accelCache.text.split(/\r?\n/).find((l) => /(WHPX|AEHD|HAXM|KVM|HVF|Hypervisor)/i.test(l))?.trim() ?? null;
    const times = readBootTimes();
    return {
      acceleration: { ok: !!line && /usable/i.test(line) && !/not usable/i.test(line), detail: line ?? 'Could not check (emulator -accel-check)' },
      gpu_mode: config.EMULATOR_GPU_MODE,
      cores: emulatorCores(),
      ram_mb: config.EMULATOR_RAM_MB,
      fast_boot: config.EMULATOR_FAST_BOOT,
      headless_default: config.EMULATOR_HEADLESS,
      host_threads: os.cpus().length,
      /** Last measured boot time per AVD, in seconds. */
      boot_times: Object.fromEntries(
        Object.entries(times).map(([avd, t]) => [avd, Object.fromEntries(Object.entries(t).map(([m, ms]) => [m, Math.round((ms as number) / 100) / 10]))]),
      ),
    };
  },

  /** On shutdown: stop only emulators this process started (adopted ones were started by someone else). */
  async stopAll() {
    await Promise.all([...running.entries()].filter(([, e]) => !e.adopted).map(([id]) => this.stop(id).catch(() => false)));
  },
};
