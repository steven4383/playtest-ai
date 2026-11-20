import { run, runBuffer, tools } from './sdk.js';

export interface AdbDevice {
  serial: string;
  state: string; // device | offline | unauthorized
  model?: string;
  product?: string;
  device?: string;
  transport_id?: string;
  is_emulator: boolean;
  /** usb = cable, wifi = `adb connect` / wireless debugging, emulator = local AVD */
  connection: 'usb' | 'wifi' | 'emulator';
}

const SERIAL_RE = /^[\w.:-]+$/;
export function assertSerial(serial: string) {
  if (!SERIAL_RE.test(serial)) throw Object.assign(new Error(`Invalid ADB serial: ${serial}`), { statusCode: 400 });
}

/** host:port — IPv4 or hostname (wireless debugging shows e.g. 192.168.1.23:37211). */
const ADDR_RE = /^[a-zA-Z0-9.-]{1,253}:\d{1,5}$/;
function assertAddr(addr: string) {
  if (!ADDR_RE.test(addr) || Number(addr.split(':')[1]) > 65535)
    throw Object.assign(new Error(`Invalid address "${addr}" — use IP:port, e.g. 192.168.1.23:5555`), { statusCode: 400 });
}

export const KEYCODES: Record<string, number> = {
  home: 3,
  back: 4,
  power: 26,
  volume_up: 24,
  volume_down: 25,
  recents: 187,
  enter: 66,
  delete: 67,
  menu: 82,
  /** Turns the display on (never off, unlike power). */
  wakeup: 224,
};

export type InputAction =
  | { action: 'tap'; x: number; y: number }
  | { action: 'swipe'; x1: number; y1: number; x2: number; y2: number; duration_ms?: number }
  | { action: 'key'; key: string }
  | { action: 'text'; text: string };

const PACKAGE_RE =/^[a-zA-Z][\w]*(\.[a-zA-Z_][\w]*)+$/;
export function assertPackage(pkg: string) {
  if (!PACKAGE_RE.test(pkg)) throw Object.assign(new Error(`Invalid package name: ${pkg}`), { statusCode: 400 });
}

const connectionOf =(serial: string): AdbDevice['connection'] =>
  serial.startsWith('emulator-') ? 'emulator' : serial.includes(':') || serial.includes('._adb-tls-connect') ? 'wifi' : 'usb';

export const adb = {
  async devices(): Promise<{ devices: AdbDevice[]; error?: string }> {
    const r = await run(tools.adb(), ['devices', '-l'], 10_000);
    if (!r.ok) return { devices: [], error: r.error };
    const devices = r.stdout
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [serial, state, ...rest] = line.split(/\s+/);
        const kv = Object.fromEntries(rest.map((p) => p.split(':')).filter((a) => a.length === 2));
        return {
          serial,
          state,
          model: kv.model?.replace(/_/g, ' '),
          product: kv.product,
          device: kv.device,
          transport_id: kv.transport_id,
          is_emulator: serial.startsWith('emulator-'),
          connection: connectionOf(serial),
        } as AdbDevice;
      });
    return { devices };
  },

  async getprop(serial: string, prop: string): Promise<string | null> {
    assertSerial(serial);
    const r = await run(tools.adb(), ['-s', serial, 'shell', 'getprop', prop], 10_000);
    return r.ok ? r.stdout.trim() : null;
  },

  /** Read Android version, API level, resolution and storage (section 5.2). */
  async inspect(serial: string) {
    assertSerial(serial);
    const [release, sdk, model, wm, df, mem] = await Promise.all([
      this.getprop(serial, 'ro.build.version.release'),
      this.getprop(serial, 'ro.build.version.sdk'),
      this.getprop(serial, 'ro.product.model'),
      run(tools.adb(), ['-s', serial, 'shell', 'wm', 'size'], 10_000),
      run(tools.adb(), ['-s', serial, 'shell', 'df', '-k', '/data'], 10_000),
      run(tools.adb(), ['-s', serial, 'shell', 'cat', '/proc/meminfo'], 10_000),
    ]);
    const resolution = wm.ok ? (wm.stdout.match(/(\d+x\d+)\s*$/m)?.[1] ?? null) : null;
    let storage_free_mb: number | null = null;
    if (df.ok) {
      const cols = df.stdout.trim().split(/\r?\n/).pop()?.split(/\s+/);
      const avail = cols ? Number(cols[3]) : NaN;
      if (!Number.isNaN(avail)) storage_free_mb = Math.round(avail / 1024);
    }
    const memTotalKb = mem.ok ? Number(mem.stdout.match(/MemTotal:\s+(\d+)/)?.[1]) : NaN;
    return {
      serial,
      android_version: release,
      api_level: sdk ? Number(sdk) : null,
      model,
      resolution,
      storage_free_mb,
      ram_mb: Number.isNaN(memTotalKb) ? null : Math.round(memTotalKb / 1024),
    };
  },

  async bootCompleted(serial: string): Promise<boolean> {
    return (await this.getprop(serial, 'sys.boot_completed')) === '1';
  },

  async emuKill(serial: string) {
    assertSerial(serial);
    return run(tools.adb(), ['-s', serial, 'emu', 'kill'], 15_000);
  },

  async install(serial: string, apkPath: string) {
    assertSerial(serial);
    return run(tools.adb(), ['-s', serial, 'install', '-r', '-g', apkPath], 180_000);
  },

  /**
   * Android 11+ wireless debugging: pair once with the 6-digit code shown under
   * Developer options → Wireless debugging → "Pair device with pairing code".
   */
  async pair(addr: string, code: string): Promise<{ ok: boolean; message: string }> {
    assertAddr(addr);
    // 6-digit code (manual) or the alphanumeric password from a QR session.
    if (!/^[A-Za-z0-9]{6,32}$/.test(code)) throw Object.assign(new Error('Pairing code must be 6 digits'), { statusCode: 400 });
    const r = await run(tools.adb(), ['pair', addr, code], 30_000);
    const out = `${r.stdout}\n${r.stderr}`.trim();
    const ok = /successfully paired/i.test(out);
    return { ok, message: out.split(/\r?\n/).filter(Boolean).pop() ?? r.error ?? 'No output from adb pair' };
  },

  /** `adb connect` exits 0 even on failure, so success is read from its output. */
  async connect(addr: string): Promise<{ ok: boolean; message: string }> {
    assertAddr(addr);
    const r = await run(tools.adb(), ['connect', addr], 20_000);
    const out = `${r.stdout}\n${r.stderr}`.trim();
    const ok = /(^|\s)(already )?connected to/i.test(out) && !/failed|cannot|unable/i.test(out);
    return { ok, message: out.split(/\r?\n/).filter(Boolean).pop() ?? r.error ?? 'No output from adb connect' };
  },

  async disconnect(serial: string): Promise<{ ok: boolean; message: string }> {
    assertSerial(serial);
    const r = await run(tools.adb(), ['disconnect', serial], 10_000);
    const out = `${r.stdout}\n${r.stderr}`.trim();
    return { ok: r.ok && !/error|no such device/i.test(out), message: out || r.error || 'disconnected' };
  },

  // ---------- app testing helpers (package names are validated: they end up in a device shell command) ----------

  async shell(serial: string, args: string[], timeoutMs = 30_000) {
    assertSerial(serial);
    return run(tools.adb(), ['-s', serial, 'shell', ...args], timeoutMs);
  },

  /** AVD name of a running emulator (`adb emu avd name`), so identical-looking emulators can be told apart. */
  async emulatorAvdName(serial: string): Promise<string | null> {
    assertSerial(serial);
    const r = await run(tools.adb(), ['-s', serial, 'emu', 'avd', 'name'], 5_000);
    const name = r.ok ? r.stdout.split(/\r?\n/)[0]?.trim() : '';
    return name && /^[\w.-]+$/.test(name) ? name : null;
  },

  /** Package manager answers once Android has finished starting services after boot. */
  async packageManagerReady(serial: string) {
    const r = await this.shell(serial, ['pm', 'path', 'android'], 10_000);
    return r.ok && r.stdout.includes('package:');
  },

  async uninstall(serial: string, pkg: string) {
    assertPackage(pkg);
    assertSerial(serial);
    return run(tools.adb(), ['-s', serial, 'uninstall', pkg], 60_000);
  },

  async isInstalled(serial: string, pkg: string) {
    assertPackage(pkg);
    const r = await this.shell(serial, ['pm', 'path', pkg], 10_000);
    return r.ok && r.stdout.includes('package:');
  },

  /** Launcher activity component, e.g. com.example/.MainActivity (API 24+). */
  async launcherActivity(serial: string, pkg: string): Promise<string | null> {
    assertPackage(pkg);
    const r = await this.shell(serial, ['cmd', 'package', 'resolve-activity', '--brief', '-c', 'android.intent.category.LAUNCHER', pkg], 15_000);
    const line = r.stdout.trim().split(/\r?\n/).pop()?.trim() ?? '';
    // `$` (inner classes) would be expanded by the device shell — those fall back to monkeyLaunch.
    return line.startsWith(`${pkg}/`) && /^[\w.]+\/[\w.]+$/.test(line) ? line : null;
  },

  /**
   * `am start -W` waits for the first frame and reports TotalTime (cold start ms).
   * It gives up after ~10 s with `Status: timeout` — the activity was started, it just hasn't drawn yet
   * (common for big Flutter / Firebase apps on slow or headless emulators). That is reported as `slow`, not a failure.
   */
  async startActivity(serial: string, component: string) {
    if (!/^[\w.]+\/[\w.]+$/.test(component)) throw new Error(`Invalid component: ${component}`);
    const r = await this.shell(serial, ['am', 'start', '-W', '-n', component], 60_000);
    const out = `${r.stdout}\n${r.stderr}`;
    const total = Number(out.match(/TotalTime:\s*(\d+)/)?.[1]);
    const wait = Number(out.match(/WaitTime:\s*(\d+)/)?.[1]);
    const error = out.match(/^Error[^\n]*/m)?.[0] ?? (r.ok ? null : r.error ?? 'am start failed');
    const slow = !error && /Status:\s*timeout/i.test(out);
    return {
      ok: !error && (slow || /Status:\s*ok/i.test(out)),
      slow,
      total_time_ms: Number.isNaN(total) ? null : total,
      wait_time_ms: Number.isNaN(wait) ? null : wait,
      error,
      output: out.trim(),
    };
  },

  /** Fallback launcher when resolve-activity is unavailable (old Android). */
  async monkeyLaunch(serial: string, pkg: string) {
    assertPackage(pkg);
    const r = await this.shell(serial, ['monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'], 30_000);
    return { ok: r.ok && /Events injected:\s*1/.test(r.stdout), output: `${r.stdout}${r.stderr}`.trim() };
  },

  async pidOf(serial: string, pkg: string): Promise<number | null> {
    assertPackage(pkg);
    const r = await this.shell(serial, ['pidof', pkg], 10_000);
    const pid = Number(r.stdout.trim().split(/\s+/)[0]);
    return r.ok && pid > 0 ? pid : null;
  },

  /** Package of the activity currently in the foreground. */
  async foregroundPackage(serial: string): Promise<string | null> {
    const r = await this.shell(serial, ['dumpsys', 'activity', 'activities'], 20_000);
    const m = r.stdout.match(/(?:topResumedActivity|mResumedActivity|ResumedActivity)[=:].*?\s([\w.]+)\/[\w.$]+/);
    return m?.[1] ?? null;
  },

  async forceStop(serial: string, pkg: string) {
    assertPackage(pkg);
    return this.shell(serial, ['am', 'force-stop', pkg], 15_000);
  },

  async clearLogcat(serial: string) {
    return this.shell(serial, ['logcat', '-c'], 15_000);
  },

  /** Dump logcat (main+system+crash) since the last clear. */
  async dumpLogcat(serial: string) {
    const r = await this.shell(serial, ['logcat', '-d', '-v', 'threadtime', '-b', 'main', '-b', 'system', '-b', 'crash'], 30_000);
    return r.stdout;
  },

  async screenshot(serial: string): Promise<Buffer | null> {
    assertSerial(serial);
    const r = await runBuffer(tools.adb(), ['-s', serial, 'exec-out', 'screencap', '-p'], 30_000);
    // PNG signature check — some devices return an error string instead.
    return r.ok && r.data.length > 8 && r.data[0] === 0x89 && r.data[1] === 0x50 ? r.data : null;
  },

  /** Live-view input. Every value is a validated number or a whitelisted key, so nothing user-typed reaches the device shell unchecked. */
  async input(serial: string, a: InputAction) {
    const n = (v: number) => {
      if (!Number.isInteger(v) || v < 0 || v > 20000) throw Object.assign(new Error('Coordinates out of range'), { statusCode: 400 });
      return String(v);
    };
    switch (a.action) {
      case 'tap':
        return this.shell(serial, ['input', 'tap', n(a.x), n(a.y)], 10_000);
      case 'swipe':
        return this.shell(serial, ['input', 'swipe', n(a.x1), n(a.y1), n(a.x2), n(a.y2), n(Math.max(50, Math.min(3000, a.duration_ms ?? 250)))], 10_000);
      case 'key': {
        const code = KEYCODES[a.key];
        if (!code) throw Object.assign(new Error(`Unknown key: ${a.key}`), { statusCode: 400 });
        return this.shell(serial, ['input', 'keyevent', String(code)], 10_000);
      }
      case 'text': {
        // `input text` is passed through the device shell: allow only safe characters, %s = space.
        if (!/^[\w .,@\-+:/]{1,200}$/.test(a.text)) throw Object.assign(new Error('Text may contain letters, digits, spaces and . , @ - + : / _ only'), { statusCode: 400 });
        return this.shell(serial, ['input', 'text', a.text.replace(/ /g, '%s')], 15_000);
      }
    }
  },

  /** Restart the ADB server — fixes most "offline" / stuck device states. Starts with mDNS (QR pairing) enabled. */
  async restartServer() {
    await run(tools.adb(), ['kill-server'], 10_000);
    return run(tools.adb(), ['start-server'], 20_000, { ADB_MDNS_OPENSCREEN: '1' });
  },

  /** Is ADB's mDNS discovery running? Needed for QR pairing and auto-connect over Wi-Fi. */
  async mdnsCheck(): Promise<{ ok: boolean; message: string }> {
    const r = await run(tools.adb(), ['mdns', 'check'], 10_000);
    const out = `${r.stdout}\n${r.stderr}`.trim();
    return { ok: r.ok && /daemon version/i.test(out), message: out || r.error || 'no output' };
  },

  /** Services phones advertise on the LAN: _adb-tls-pairing (QR / code pairing) and _adb-tls-connect. */
  async mdnsServices(): Promise<{ name: string; type: string; address: string }[]> {
    const r = await run(tools.adb(), ['mdns', 'services'], 10_000);
    if (!r.ok) return [];
    return r.stdout
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p.length >= 3 && p[1].startsWith('_adb'))
      .map(([name, type, address]) => ({ name, type: type.replace(/\.$/, ''), address }));
  },
};
