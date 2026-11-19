import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import { config } from '../config.js';
import { bus } from '../core/events.js';
import { deviceRepo } from '../services/devices.js';
import { adb } from './adb.js';
import { run, tools } from './sdk.js';

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
  /** What the emulator is doing before it is ready, e.g. "Saving fast-boot snapshot". */
  phase?: string;
}

/** Snapshot every emulator starts from: booted, home screen, animations off. Never saved over (-no-snapshot-save). */
export const FAST_BOOT_SNAPSHOT = 'playtest_clean';

const AVD_RE = /^[\w.-]+$/;
const running = new Map<string, RunningEmulator & { child?: ChildProcess }>();
/** Console ports of emulators we don't manage (Android Studio etc.), so a new one never collides. */
let foreignPorts = new Set<number>();

function nextFreePort(): number {
  const used = new Set([...running.values()].map((r) => r.console_port).concat([...foreignPorts]));
  for (let p = 5554; p <= 5682; p += 2) if (!used.has(p)) return p;
  throw new Error('No free emulator console port between 5554 and 5682');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const portOf = (serial: string) => Number(serial.match(/^emulator-(\d+)$/)?.[1]) || null;

/** CPU cores per emulator: EMULATOR_CORES, or half the host threads clamped to 2-4. */
export const emulatorCores = () => config.EMULATOR_CORES || Math.max(2, Math.min(4, Math.floor(os.cpus().length / 2)));

async function serialGone(serial: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { devices } = await adb.devices();
    if (!devices.some((d) => d.serial === serial)) return true;
    await sleep(1000);
  }
  return false;
}

/** Last resort: kill the emulator process that owns the console port (Windows: netstat -> taskkill). */
async function killByConsolePort(port: number): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const r = await run('netstat', ['-ano', '-p', 'TCP'], 10_000);
  const line = r.stdout.split(/\r?\n/).find((l) => l.includes(`127.0.0.1:${port} `) && /\bLISTENING\b/.test(l));
  const pid = Number(line?.trim().split(/\s+/).pop());
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

  list(): RunningEmulator[] {
    return [...running.values()].map(({ child, ...rest }) => rest);
  },

  count(): number {
    return running.size;
  },

  get(deviceId: string) {
    return running.get(deviceId);
  },

  /**
   * Start an AVD and wait (in the background) for sys.boot_completed.
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
    const entry = {
      device_id: opts.device_id,
      avd_name: opts.avd_name,
      serial,
      console_port: port,
      pid: child.pid,
      ram_mb: ram,
      started_at: new Date().toISOString(),
      booted: false,
      child,
    };
    running.set(opts.device_id, entry);
    bus.publish({ event: 'device_starting', data: { device_id: opts.device_id, serial } });

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

  async waitForBoot(deviceId: string, serial: string, fastBoot = false) {
    const deadline = Date.now() + config.DEVICE_BOOT_TIMEOUT_SECONDS * 1000;
    while (Date.now() < deadline) {
      const entry = running.get(deviceId);
      if (!entry) return;
      if (await adb.bootCompleted(serial)) {
        if (fastBoot) await this.prepareSnapshot(deviceId, serial).catch(() => {});
        if (!running.has(deviceId)) return;
        entry.booted = true;
        entry.phase = undefined;
        bus.publish({ event: 'device_ready', data: { device_id: deviceId, serial } });
        return;
      }
      await sleep(3000);
    }
    bus.publish({
      event: 'device_error',
      data: { device_id: deviceId, serial, message: `Boot timed out after ${config.DEVICE_BOOT_TIMEOUT_SECONDS}s` },
    });
  },

  /**
   * After the first cold boot: turn animations off (faster, steadier tests), let the home screen settle and save the
   * clean state as a snapshot. Later starts resume it in seconds. Skipped when the snapshot already exists.
   */
  async prepareSnapshot(deviceId: string, serial: string) {
    const list = await emu(serial, ['avd', 'snapshot', 'list']);
    if (!list.ok || list.stdout.includes(FAST_BOOT_SNAPSHOT)) return;
    const entry = running.get(deviceId);
    if (entry) entry.phase = 'Saving fast-boot snapshot (first boot only)';
    bus.publish({ event: 'device_starting', data: { device_id: deviceId, serial, message: 'First boot: saving a fast-boot snapshot so the next start takes seconds' } });
    for (const k of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) await adb.shell(serial, ['settings', 'put', 'global', k, '0'], 10_000);
    for (let i = 0; i < 30 && !(await adb.foregroundPackage(serial)); i++) await sleep(2000); // home screen up
    await sleep(15_000); // let first-boot jobs calm down so the snapshot is quiet
    await emu(serial, ['avd', 'snapshot', 'save', FAST_BOOT_SNAPSHOT], 180_000);
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
  async stop(deviceId: string): Promise<boolean> {
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
        bus.publish({ event: 'device_stopped', data: { device_id: deviceId, serial: entry.serial } });
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
        continue;
      }
      const booted = await adb.bootCompleted(d.serial);
      running.set(profile.id, {
        device_id: profile.id,
        avd_name: name!,
        serial: d.serial,
        console_port: port,
        ram_mb: profile.ram_mb ?? config.EMULATOR_RAM_MB,
        started_at: new Date().toISOString(),
        booted,
        adopted: true,
      });
      bus.publish({ event: booted ? 'device_ready' : 'device_starting', data: { device_id: profile.id, serial: d.serial } });
    }
    foreignPorts = foreign;
  },

  /** Hardware acceleration report from `emulator -accel-check` (cached 10 min) plus the speed settings. */
  async speedInfo() {
    if (!accelCache || Date.now() - accelCache.at > 600_000) {
      const r = await run(tools.emulator(), ['-accel-check'], 30_000);
      accelCache = { at: Date.now(), text: `${r.stdout}\n${r.stderr}` };
    }
    const line = accelCache.text.split(/\r?\n/).find((l) => /(WHPX|AEHD|HAXM|KVM|HVF|Hypervisor)/i.test(l))?.trim() ?? null;
    return {
      acceleration: { ok: !!line && /usable/i.test(line) && !/not usable/i.test(line), detail: line ?? 'Could not check (emulator -accel-check)' },
      gpu_mode: config.EMULATOR_GPU_MODE,
      cores: emulatorCores(),
      ram_mb: config.EMULATOR_RAM_MB,
      fast_boot: config.EMULATOR_FAST_BOOT,
      headless_default: config.EMULATOR_HEADLESS,
      host_threads: os.cpus().length,
    };
  },

  /** On shutdown: stop only emulators this process started (adopted ones were started by someone else). */
  async stopAll() {
    await Promise.all([...running.entries()].filter(([, e]) => !e.adopted).map(([id]) => this.stop(id).catch(() => false)));
  },
};
