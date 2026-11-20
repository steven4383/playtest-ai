import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getApk } from '../services/apks.js';
import { deviceRepo } from '../services/devices.js';
import { adb, assertPackage, assertSerial } from './adb.js';
import { campaignRunner } from './campaign-runner.js';
import { emulatorManager } from './emulator.js';
import { run, tools } from './sdk.js';

/**
 * Developer tools for one connected device: info, apps, performance, logcat, recording, deep links,
 * quick settings, emulator console, files, USB → Wi-Fi.
 *
 * SECURITY: `adb shell a b c` joins its arguments into ONE string that the device's `sh` parses.
 * Every value that reaches a shell command here is either a fixed word from a table, a number that
 * was range-checked, a regex-validated identifier, or a single-quoted string with `'` rejected.
 */

const bad = (msg: string, statusCode = 400) => Object.assign(new Error(msg), { statusCode });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wrap in single quotes for the device shell. Nothing inside single quotes is special except `'` itself. */
function sq(v: string, what = 'Value') {
  if (/['\r\n\0]/.test(v)) throw bad(`${what} may not contain ' or line breaks`);
  return `'${v}'`;
}

export const tmpDir = () => {
  const d = path.join(config.STORAGE_DIR, 'tmp');
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const recordingsDir = () => {
  const d = path.join(config.STORAGE_DIR, 'recordings');
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const tmpFile = (ext: string) => path.join(tmpDir(), `${crypto.randomBytes(8).toString('hex')}${ext}`);

/** True while a test run is using this serial — mutating actions are refused so the run isn't disturbed. */
export function serialBusy(serial: string) {
  const busy = campaignRunner.busyDevices();
  if (!busy.length) return false;
  const running = emulatorManager.list();
  return deviceRepo
    .list()
    .some((p: any) => busy.includes(p.id) && (p.adb_serial === serial || running.some((r) => r.device_id === p.id && r.serial === serial)));
}
function assertFree(serial: string) {
  if (serialBusy(serial)) throw bad('A test run is using this device right now — wait for it or cancel it first', 409);
}

const sh = (serial: string, args: string[], timeoutMs = 15_000) => adb.shell(serial, args, timeoutMs);
const outOf = (r: { stdout: string; stderr: string }) => `${r.stdout}\n${r.stderr}`.trim();

// ---------------------------------------------------------------- device info

function parseProps(out: string) {
  const props: Record<string, string> = {};
  for (const m of out.matchAll(/^\[([^\]]+)\]: \[([^\]]*)\]/gm)) props[m[1]] = m[2];
  return props;
}

async function info(serial: string) {
  assertSerial(serial);
  const [propsR, density, battery, mem, ip, uptime, df, size] = await Promise.all([
    sh(serial, ['getprop']),
    sh(serial, ['wm', 'density']),
    sh(serial, ['dumpsys', 'battery']),
    sh(serial, ['cat', '/proc/meminfo']),
    sh(serial, ['ip', '-f', 'inet', 'addr', 'show', 'wlan0']),
    sh(serial, ['cat', '/proc/uptime']),
    sh(serial, ['df', '-k', '/data']),
    sh(serial, ['wm', 'size']),
  ]);
  const p = parseProps(propsR.stdout);
  const num = (s: string | undefined) => (s && /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null);
  const bat = (k: string) => battery.stdout.match(new RegExp(`^\\s*${k}:\\s*(.+)$`, 'm'))?.[1]?.trim();
  const BAT_STATUS: Record<string, string> = { '1': 'unknown', '2': 'charging', '3': 'discharging', '4': 'not charging', '5': 'full' };
  const kb = (k: string) => num(mem.stdout.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))?.[1]);
  const dfCols = df.stdout.trim().split(/\r?\n/).pop()?.split(/\s+/) ?? [];
  const sizeOf = (label: string) => size.stdout.match(new RegExp(`${label} size:\\s*(\\d+x\\d+)`))?.[1] ?? null;
  const densOf = (label: string) => num(density.stdout.match(new RegExp(`${label} density:\\s*(\\d+)`))?.[1]);
  const memTotal = kb('MemTotal');
  const memAvail = kb('MemAvailable');
  const temp = num(bat('temperature'));
  const plugged = ['AC powered', 'USB powered', 'Wireless powered'].filter((k) => bat(k) === 'true').map((k) => k.split(' ')[0]);
  return {
    serial,
    connection: serial.startsWith('emulator-') ? 'emulator' : serial.includes(':') || serial.includes('._adb-tls-connect') ? 'wifi' : 'usb',
    manufacturer: p['ro.product.manufacturer'] ?? null,
    brand: p['ro.product.brand'] ?? null,
    model: p['ro.product.model'] ?? null,
    device: p['ro.product.device'] ?? null,
    android_version: p['ro.build.version.release'] ?? null,
    api_level: num(p['ro.build.version.sdk']),
    security_patch: p['ro.build.version.security_patch'] || null,
    build_id: p['ro.build.display.id'] ?? null,
    fingerprint: p['ro.build.fingerprint'] ?? null,
    abis: (p['ro.product.cpu.abilist'] ?? p['ro.product.cpu.abi'] ?? '').split(',').filter(Boolean),
    hardware: p['ro.hardware'] ?? null,
    screen: {
      physical: sizeOf('Physical'),
      override: sizeOf('Override'),
      density: densOf('Physical'),
      density_override: densOf('Override'),
    },
    battery: {
      level: num(bat('level')),
      status: BAT_STATUS[bat('status') ?? ''] ?? null,
      temperature_c: temp === null ? null : temp / 10,
      plugged,
    },
    memory: { total_mb: memTotal ? Math.round(memTotal / 1024) : null, available_mb: memAvail ? Math.round(memAvail / 1024) : null },
    storage: {
      total_mb: num(dfCols[1]) !== null ? Math.round(Number(dfCols[1]) / 1024) : null,
      free_mb: num(dfCols[3]) !== null ? Math.round(Number(dfCols[3]) / 1024) : null,
    },
    wifi_ip: ip.stdout.match(/inet (\d+\.\d+\.\d+\.\d+)/)?.[1] ?? null,
    uptime_s: num(uptime.stdout.trim().split(/\s+/)[0]) !== null ? Math.round(Number(uptime.stdout.trim().split(/\s+/)[0])) : null,
    is_emulator: serial.startsWith('emulator-') || p['ro.kernel.qemu'] === '1' || p['ro.boot.qemu'] === '1',
  };
}

// ---------------------------------------------------------------- apps

const PERM_RE = /^[a-zA-Z][\w.]{1,199}$/;
const LOCALE_RE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8}){0,3}$/;

async function apps(serial: string, includeSystem: boolean) {
  assertSerial(serial);
  const parse = (out: string) =>
    out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('package:'))
      .map((l) => {
        const name = l.slice(8).split(/\s+/)[0];
        return {
          package: name,
          version_code: Number(l.match(/versionCode:(\d+)/)?.[1]) || null,
          uid: Number(l.match(/uid:(\d+)/)?.[1]) || null,
        };
      })
      .filter((a) => /^[\w.]+$/.test(a.package));
  const [third, all] = await Promise.all([
    sh(serial, ['pm', 'list', 'packages', '-3', '--show-versioncode', '-U'], 30_000),
    includeSystem ? sh(serial, ['pm', 'list', 'packages', '--show-versioncode', '-U'], 30_000) : Promise.resolve(null),
  ]);
  if (!third.ok && !third.stdout) throw bad(third.error ?? 'pm list packages failed', 502);
  const user = new Set(parse(third.stdout).map((a) => a.package));
  const list = parse((all ?? third).stdout).map((a) => ({ ...a, system: !user.has(a.package) }));
  return list.sort((a, b) => Number(a.system) - Number(b.system) || a.package.localeCompare(b.package));
}

async function appDetails(serial: string, pkg: string) {
  assertPackage(pkg);
  const [dump, paths, pid, locales] = await Promise.all([
    sh(serial, ['dumpsys', 'package', pkg], 30_000),
    sh(serial, ['pm', 'path', pkg]),
    adb.pidOf(serial, pkg),
    sh(serial, ['cmd', 'locale', 'get-app-locales', pkg]),
  ]);
  const out = dump.stdout;
  // dumpsys prints "Packages:" then the package block; ignore everything before it (activity resolver tables).
  const block = out.slice(Math.max(0, out.indexOf(`Package [${pkg}]`)));
  if (!block.includes(`Package [${pkg}]`)) throw bad(`${pkg} is not installed on this device`, 404);
  const pick = (re: RegExp) => block.match(re)?.[1] ?? null;

  const requested: string[] = [];
  const runtime: Record<string, boolean> = {};
  const install: Record<string, boolean> = {};
  let mode: 'none' | 'requested' | 'runtime' | 'install' = 'none';
  for (const raw of block.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^requested permissions:$/i.test(line)) mode = 'requested';
    else if (/^runtime permissions:$/i.test(line)) mode = 'runtime';
    else if (/^install permissions:$/i.test(line)) mode = 'install';
    else if (/^[A-Za-z][\w ]*:$/.test(line)) mode = 'none'; // any other section header
    else if (mode === 'requested' && /^[\w.]+(:.*)?$/.test(line)) requested.push(line.split(':')[0]);
    else if ((mode === 'runtime' || mode === 'install') && /^[\w.]+: granted=(true|false)/.test(line)) {
      const [, name, g] = line.match(/^([\w.]+): granted=(true|false)/)!;
      (mode === 'runtime' ? runtime : install)[name] = g === 'true';
    }
  }
  const apkPaths = paths.stdout
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^package:/, ''))
    .filter(Boolean);
  const locale = locales.ok ? (locales.stdout.match(/are \[([^\]]*)\]/)?.[1] ?? '') : null;
  return {
    package: pkg,
    version_name: pick(/versionName=(\S+)/),
    version_code: Number(pick(/versionCode=(\d+)/)) || null,
    min_sdk: Number(pick(/minSdk=(\d+)/)) || null,
    target_sdk: Number(pick(/targetSdk=(\d+)/)) || null,
    first_install: pick(/firstInstallTime=([^\r\n]+)/)?.trim() ?? null,
    last_update: pick(/lastUpdateTime=([^\r\n]+)/)?.trim() ?? null,
    installer: pick(/installerPackageName=(\S+)/),
    debuggable: /flags=\[[^\]]*\bDEBUGGABLE\b/.test(block),
    running_pid: pid,
    apk_paths: apkPaths,
    split_apks: apkPaths.length > 1,
    app_locale: locale, // null = not supported (Android < 13)
    permissions: {
      runtime: Object.entries(runtime)
        .map(([name, granted]) => ({ name, granted }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      install: Object.keys(install).sort(),
      requested: [...new Set(requested)].sort(),
    },
  };
}

async function launch(serial: string, pkg: string) {
  assertPackage(pkg);
  const comp = await adb.launcherActivity(serial, pkg);
  if (comp) {
    const r = await adb.startActivity(serial, comp);
    if (r.ok && r.slow) return { ok: true, total_time_ms: null, message: `Opening ${comp} — slow start (no first frame within 10 s), it should appear shortly` };
    if (r.ok) return { ok: true, total_time_ms: r.total_time_ms, message: `Opened ${comp}${r.total_time_ms ? ` in ${r.total_time_ms} ms` : ''}` };
  }
  const m = await adb.monkeyLaunch(serial, pkg);
  if (!m.ok) throw bad(`Could not open ${pkg} — it has no launcher activity, or isn't installed`, 502);
  return { ok: true, total_time_ms: null, message: `Opened ${pkg}` };
}

async function appAction(serial: string, pkg: string, action: 'launch' | 'stop' | 'clear' | 'uninstall') {
  assertPackage(pkg);
  assertFree(serial);
  switch (action) {
    case 'launch':
      return launch(serial, pkg);
    case 'stop':
      await adb.forceStop(serial, pkg);
      return { ok: true, message: `Stopped ${pkg}` };
    case 'clear': {
      const r = await sh(serial, ['pm', 'clear', pkg], 60_000);
      if (!/Success/.test(r.stdout)) throw bad(outOf(r) || 'pm clear failed', 502);
      return { ok: true, message: `Cleared data of ${pkg}` };
    }
    case 'uninstall': {
      const r = await adb.uninstall(serial, pkg);
      if (!/Success/.test(r.stdout)) throw bad(outOf(r) || 'uninstall failed', 502);
      return { ok: true, message: `Uninstalled ${pkg}` };
    }
  }
}

async function setPermission(serial: string, pkg: string, permission: string, grant: boolean) {
  assertPackage(pkg);
  if (!PERM_RE.test(permission)) throw bad('Invalid permission name');
  const r = await sh(serial, ['pm', grant ? 'grant' : 'revoke', pkg, permission]);
  const out = outOf(r);
  if (!r.ok || /exception|error/i.test(out)) throw bad(out.split(/\r?\n/)[0] || `pm ${grant ? 'grant' : 'revoke'} failed`, 502);
  return { ok: true };
}

async function setAppLocale(serial: string, pkg: string, locale: string) {
  assertPackage(pkg);
  if (locale && !LOCALE_RE.test(locale)) throw bad('Use a language tag like en-US, hi-IN or ta');
  const r = await sh(serial, ['cmd', 'locale', 'set-app-locales', pkg, '--locales', locale ? locale : "''"]);
  const out = outOf(r);
  if (!r.ok || /exception|error|unknown/i.test(out)) throw bad(out.split(/\r?\n/)[0] || 'Per-app language needs Android 13+', 502);
  return { ok: true };
}

/** Copies the installed base.apk to a temp file on this PC. */
async function pullApk(serial: string, pkg: string) {
  assertPackage(pkg);
  const r = await sh(serial, ['pm', 'path', pkg]);
  const paths = r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^package:/, ''))
    .filter((p) => /^\/[\w./=~+-]+\.apk$/.test(p));
  const base = paths.find((p) => p.endsWith('/base.apk')) ?? paths[0];
  if (!base) throw bad(`${pkg} is not installed`, 404);
  const dest = tmpFile('.apk');
  const pull = await run(tools.adb(), ['-s', serial, 'pull', base, dest], 300_000);
  if (!pull.ok || !fs.existsSync(dest)) throw bad(pull.error ?? 'adb pull failed', 502);
  return { file: dest, name: `${pkg}.apk`, split: paths.length > 1 };
}

/** Install an uploaded APK (from the APK library) and optionally open it. */
async function installApk(serial: string, apkId: string, open: boolean) {
  assertSerial(serial);
  assertFree(serial);
  const apk = getApk(apkId);
  if (!apk) throw bad('APK not found', 404);
  const r = await adb.install(serial, apk.storage_path);
  const out = outOf(r);
  if (!/Success/.test(r.stdout)) {
    const reason = out.match(/INSTALL_[A-Z_]+[^\r\n]*/)?.[0] ?? out.split(/\r?\n/).pop() ?? r.error ?? 'install failed';
    throw bad(`Install failed: ${reason}`, 502);
  }
  let opened: string | null = null;
  if (open && apk.package_name) {
    try {
      opened = (await launch(serial, apk.package_name)).message;
    } catch (e: any) {
      opened = e.message;
    }
  }
  return { ok: true, package_name: apk.package_name, message: `Installed ${apk.package_name ?? apk.filename}`, opened };
}

// ---------------------------------------------------------------- performance

/** One sample. The client turns two samples into CPU % and FPS. */
async function perf(serial: string, pkg: string) {
  assertPackage(pkg);
  const pid = await adb.pidOf(serial, pkg);
  if (!pid) return { running: false as const, at: Date.now() };
  const [stat, meminfo, gfx] = await Promise.all([
    sh(serial, ['cat', `/proc/${pid}/stat`, '/proc/stat']),
    sh(serial, ['dumpsys', 'meminfo', pkg], 20_000),
    sh(serial, ['dumpsys', 'gfxinfo', pkg], 20_000),
  ]);
  // /proc/<pid>/stat: fields 14,15 = utime, stime (after the ")" of the comm field).
  let procTicks: number | null = null;
  let totalTicks: number | null = null;
  const after = stat.stdout.slice(stat.stdout.indexOf(')') + 2).split(/\s+/);
  if (after.length > 13) procTicks = Number(after[11]) + Number(after[12]);
  const cpuLine = stat.stdout.match(/^cpu\s+([\d\s]+)$/m)?.[1];
  if (cpuLine) totalTicks = cpuLine.trim().split(/\s+/).map(Number).reduce((a, b) => a + b, 0);
  let cpuPct: number | null = null;
  if (totalTicks === null) {
    // /proc/stat not readable — fall back to top's own percentage.
    const top = await sh(serial, ['top', '-b', '-n', '1', '-p', String(pid)]);
    const lines = top.stdout.split(/\r?\n/);
    const head = lines.find((l) => /%CPU/.test(l))?.trim().split(/\s+/);
    const row = lines.find((l) => l.trim().startsWith(String(pid)))?.trim().split(/\s+/);
    const i = head?.findIndex((h) => /%CPU/.test(h)) ?? -1;
    if (row && i >= 0) cpuPct = Number(row[i]) || 0;
  }
  const pss = Number(meminfo.stdout.match(/TOTAL PSS:\s+(\d+)/)?.[1] ?? meminfo.stdout.match(/^\s*TOTAL\s+(\d+)/m)?.[1]);
  const frames = Number(gfx.stdout.match(/Total frames rendered:\s*(\d+)/)?.[1]);
  const janky = Number(gfx.stdout.match(/Janky frames:\s*(\d+)/)?.[1]);
  return {
    running: true as const,
    at: Date.now(),
    pid,
    proc_ticks: Number.isFinite(procTicks) ? procTicks : null,
    total_ticks: totalTicks,
    cpu_pct: cpuPct,
    cores: (stat.stdout.match(/^cpu\d+\s/gm) ?? []).length || null,
    pss_kb: Number.isFinite(pss) ? pss : null,
    frames: Number.isFinite(frames) ? frames : null,
    janky_frames: Number.isFinite(janky) ? janky : null,
  };
}

async function resetFrames(serial: string, pkg: string) {
  assertPackage(pkg);
  await sh(serial, ['dumpsys', 'gfxinfo', pkg, 'reset'], 20_000);
  return { ok: true };
}

// ---------------------------------------------------------------- logcat stream

export interface LogLine {
  ts: string;
  pid: number;
  tid: number;
  level: string;
  tag: string;
  msg: string;
}
const LOG_RE = /^(\d\d-\d\d\s+\d\d:\d\d:\d\d\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.*?)\s*: (.*)$/;
const streams = new Set<{ child: ChildProcess; stop: () => void; started: number }>();
const MAX_STREAMS = 4;

/**
 * Streams logcat lines in batches. With `pkg`, only the app's process (pid re-read every 2 s so restarts are
 * followed) plus system lines that mention the package are sent.
 */
function logcatStream(
  serial: string,
  opts: { pkg?: string; tail?: number },
  onBatch: (lines: LogLine[]) => void,
  onStatus: (s: { pid: number | null; running: boolean }) => void,
  onEnd: (reason: string) => void,
) {
  assertSerial(serial);
  if (opts.pkg) assertPackage(opts.pkg);
  // Too many open viewers (stale tabs) — close the oldest.
  if (streams.size >= MAX_STREAMS) [...streams].sort((a, b) => a.started - b.started)[0]?.stop();

  const tail = Math.max(0, Math.min(2000, opts.tail ?? 300));
  const child = spawn(tools.adb(), ['-s', serial, 'logcat', '-v', 'threadtime', '-T', String(tail || 1)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let pid: number | null = null;
  let pending: LogLine[] = [];
  let partial = '';
  let ended = false;

  const pkg = opts.pkg;
  // With a package filter, hold the first lines until the app's pid is known (otherwise the backlog is dropped).
  let pidKnown = !pkg;
  let early: LogLine[] = [];
  const refreshPid = async () => {
    if (!pkg) return;
    const p = await adb.pidOf(serial, pkg).catch(() => null);
    if (p !== pid || !pidKnown) {
      pid = p;
      onStatus({ pid, running: !!pid });
    }
    if (!pidKnown) {
      pidKnown = true;
      pending.push(...early.filter((l) => l.pid === pid || l.msg.includes(pkg)));
      early = [];
    }
  };
  void refreshPid();
  const pidTimer = pkg ? setInterval(() => void refreshPid(), 2000) : null;
  const flushTimer = setInterval(() => {
    if (pending.length) {
      const batch = pending;
      pending = [];
      onBatch(batch);
    }
  }, 250);

  child.stdout!.on('data', (chunk: Buffer) => {
    const text = partial + chunk.toString('utf8');
    const lines = text.split(/\r?\n/);
    partial = lines.pop() ?? '';
    for (const l of lines) {
      const m = LOG_RE.exec(l);
      if (!m) continue;
      const line: LogLine = { ts: m[1], pid: Number(m[2]), tid: Number(m[3]), level: m[4], tag: m[5], msg: m[6] };
      if (!pidKnown) {
        if (early.length < 5000) early.push(line);
        continue;
      }
      if (pkg && line.pid !== pid && !line.msg.includes(pkg)) continue;
      pending.push(line);
    }
    if (pending.length > 5000) pending = pending.slice(-5000);
  });
  let errText = '';
  child.stderr!.on('data', (c: Buffer) => (errText = (errText + c.toString()).slice(-500)));

  const entry = {
    child,
    started: Date.now(),
    stop: () => {
      if (ended) return;
      ended = true;
      clearInterval(flushTimer);
      if (pidTimer) clearInterval(pidTimer);
      streams.delete(entry);
      if (child.exitCode === null) child.kill();
    },
  };
  streams.add(entry);
  child.on('close', () => {
    const wasEnded = ended;
    entry.stop();
    if (!wasEnded) onEnd(errText.trim().split(/\r?\n/).pop() || 'logcat ended (device disconnected?)');
  });
  child.on('error', (e) => {
    entry.stop();
    onEnd(e.message);
  });
  return entry.stop;
}

// ---------------------------------------------------------------- screen recording

interface RecordingMeta {
  id: string;
  serial: string;
  title: string;
  started_at: string;
  ended_at: string | null;
  size_bytes: number;
}
const recordings = new Map<string, { id: string; title: string; started_at: string; seconds: number; state: 'recording' | 'saving'; done: Promise<void>; child: ChildProcess }>();

function recordingStatus(serial: string) {
  const r = recordings.get(serial);
  return r ? { active: true, id: r.id, state: r.state, started_at: r.started_at, seconds: r.seconds } : { active: false };
}

async function startRecording(serial: string, seconds: number, bitRateMbps: number | undefined, title: string) {
  assertSerial(serial);
  if (recordings.has(serial)) throw bad('Already recording this device', 409);
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 180) throw bad('Duration must be 5–180 seconds');
  const id = `rec_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  const remote = `/sdcard/pt-${id}.mp4`;
  const args = ['-s', serial, 'shell', 'screenrecord', '--time-limit', String(seconds)];
  if (bitRateMbps) args.push('--bit-rate', String(Math.round(Math.max(1, Math.min(40, bitRateMbps)) * 1_000_000)));
  args.push(remote);
  const child = spawn(tools.adb(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr!.on('data', (c: Buffer) => (err += c.toString()));
  child.stdout!.on('data', (c: Buffer) => (err += c.toString()));
  const started_at = new Date().toISOString();
  const cleanTitle = title.replace(/[^\w .:()-]/g, '').slice(0, 80) || serial;

  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  recordings.set(serial, { id, title: cleanTitle, started_at, seconds, state: 'recording', done, child });

  const finish = async () => {
    const rec = recordings.get(serial);
    if (rec) rec.state = 'saving';
    await sleep(800); // let the device finish writing the mp4 moov atom
    const dest = path.join(recordingsDir(), `${id}.mp4`);
    const pull = await run(tools.adb(), ['-s', serial, 'pull', remote, dest], 120_000);
    await sh(serial, ['rm', '-f', remote]).catch(() => null);
    if (pull.ok && fs.existsSync(dest)) {
      const meta: RecordingMeta = { id, serial, title: cleanTitle, started_at, ended_at: new Date().toISOString(), size_bytes: fs.statSync(dest).size };
      fs.writeFileSync(path.join(recordingsDir(), `${id}.json`), JSON.stringify(meta));
    } else {
      lastRecordingError.set(serial, (err.trim().split(/\r?\n/).pop() || pull.error || 'Recording failed').slice(0, 300));
    }
    recordings.delete(serial);
    resolveDone();
  };
  child.on('close', () => void finish());
  child.on('error', () => void finish());
  lastRecordingError.delete(serial);
  return { ok: true, id, seconds };
}
const lastRecordingError = new Map<string, string>();

async function stopRecording(serial: string) {
  assertSerial(serial);
  const rec = recordings.get(serial);
  if (!rec) return { ok: true, id: null };
  if (rec.state === 'recording') {
    // SIGINT makes screenrecord close the file properly; killing the adb client would leave a broken mp4.
    await sh(serial, ['pkill', '-2', 'screenrecord']).catch(() => null);
    const timeout = sleep(10_000).then(() => rec.child.exitCode === null && rec.child.kill());
    await Promise.race([rec.done, timeout]);
  }
  await rec.done;
  return { ok: true, id: rec.id, error: lastRecordingError.get(serial) ?? null };
}

function listRecordings(): RecordingMeta[] {
  const dir = recordingsDir();
  return fs
    .readdirSync(dir)
    .filter((f) => /^rec_[\w]+\.json$/.test(f))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as RecordingMeta;
      } catch {
        return null;
      }
    })
    .filter((m): m is RecordingMeta => !!m && fs.existsSync(path.join(dir, `${m.id}.mp4`)))
    .sort((a, b) => b.started_at.localeCompare(a.started_at));
}

function recordingFile(id: string) {
  if (!/^rec_\w+$/.test(id)) throw bad('Invalid recording id');
  const f = path.join(recordingsDir(), `${id}.mp4`);
  return fs.existsSync(f) ? f : null;
}

function deleteRecording(id: string) {
  const f = recordingFile(id);
  if (!f) return false;
  fs.rmSync(f, { force: true });
  fs.rmSync(f.replace(/\.mp4$/, '.json'), { force: true });
  return true;
}

// ---------------------------------------------------------------- deep links

const URL_RE = /^[a-zA-Z][\w+.-]*:[^\s'"\\`]+$/;

async function deepLink(serial: string, url: string, pkg?: string) {
  if (url.length > 2000 || !URL_RE.test(url)) throw bad('Enter a URL like https://example.com/path or myapp://screen (no spaces or quotes)');
  if (pkg) assertPackage(pkg);
  const args = ['am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', sq(url, 'URL')];
  if (pkg) args.push(pkg);
  const r = await sh(serial, args, 60_000);
  const out = outOf(r);
  const error = out.match(/^Error[^\n]*/m)?.[0] ?? null;
  return {
    ok: !error && /Status:\s*ok/i.test(out),
    activity: out.match(/Activity:\s*(\S+)/)?.[1] ?? null,
    total_time_ms: Number(out.match(/TotalTime:\s*(\d+)/)?.[1]) || null,
    error,
    output: out.slice(0, 2000),
  };
}

// ---------------------------------------------------------------- quick toggles

interface ToggleDef {
  id: string;
  label: string;
  group: 'display' | 'debug' | 'power' | 'network';
  options: { value: string; label: string }[];
  hint?: string;
  get: (s: string) => Promise<string | null>;
  set: (s: string, v: string) => Promise<unknown>;
}
const ONOFF = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];
const setting = async (s: string, ns: 'system' | 'global' | 'secure', key: string) => {
  const v = (await sh(s, ['settings', 'get', ns, key])).stdout.trim();
  return v === 'null' || v === '' ? null : v;
};
const put = (s: string, ns: 'system' | 'global' | 'secure', key: string, v: string) => sh(s, ['settings', 'put', ns, key, v]);
const onoff = (v: string | null, on = (x: string) => x !== '0' && x !== '0.0') => (v === null ? null : on(v) ? 'on' : 'off');
const settingToggle = (id: string, label: string, group: ToggleDef['group'], ns: 'system' | 'global', key: string, hint?: string): ToggleDef => ({
  id,
  label,
  group,
  hint,
  options: ONOFF,
  get: async (s) => onoff(await setting(s, ns, key)) ?? 'off',
  set: (s, v) => put(s, ns, key, v === 'on' ? '1' : '0'),
});

const TOGGLES: ToggleDef[] = [
  {
    id: 'dark_mode',
    label: 'Dark mode',
    group: 'display',
    options: ONOFF,
    get: async (s) => {
      const m = (await sh(s, ['cmd', 'uimode', 'night'])).stdout.match(/Night mode:\s*(\w+)/)?.[1];
      return m === 'yes' ? 'on' : m === 'no' ? 'off' : (m ?? null);
    },
    set: (s, v) => sh(s, ['cmd', 'uimode', 'night', v === 'on' ? 'yes' : 'no']),
  },
  {
    id: 'font_scale',
    label: 'Font size',
    group: 'display',
    options: [
      { value: '0.85', label: 'Small' },
      { value: '1.0', label: 'Default' },
      { value: '1.15', label: 'Large' },
      { value: '1.3', label: 'Largest' },
      { value: '2.0', label: '200%' },
    ],
    get: async (s) => {
      const v = Number((await setting(s, 'system', 'font_scale')) ?? '1');
      return ['0.85', '1.0', '1.15', '1.3', '2.0'].find((o) => Math.abs(Number(o) - v) < 0.01) ?? String(v);
    },
    set: (s, v) => put(s, 'system', 'font_scale', v),
  },
  {
    id: 'rotation',
    label: 'Rotation',
    group: 'display',
    options: [
      { value: 'auto', label: 'Auto' },
      { value: '0', label: 'Portrait' },
      { value: '1', label: 'Landscape' },
      { value: '2', label: 'Upside down' },
      { value: '3', label: 'Landscape ⟲' },
    ],
    get: async (s) => ((await setting(s, 'system', 'accelerometer_rotation')) === '1' ? 'auto' : ((await setting(s, 'system', 'user_rotation')) ?? '0')),
    set: async (s, v) => {
      if (v === 'auto') return put(s, 'system', 'accelerometer_rotation', '1');
      await put(s, 'system', 'accelerometer_rotation', '0');
      return put(s, 'system', 'user_rotation', v);
    },
  },
  {
    id: 'animations',
    label: 'Animations',
    group: 'debug',
    hint: 'Off = faster, steadier UI tests',
    options: ONOFF,
    get: async (s) => onoff(await setting(s, 'global', 'animator_duration_scale')) ?? 'on',
    set: async (s, v) => {
      const val = v === 'on' ? '1' : '0';
      for (const k of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) await put(s, 'global', k, val);
    },
  },
  settingToggle('show_taps', 'Show taps', 'debug', 'system', 'show_touches', 'Circles where you touch — good for recordings'),
  settingToggle('pointer_location', 'Pointer location', 'debug', 'system', 'pointer_location', 'Touch coordinates overlay'),
  {
    id: 'layout_bounds',
    label: 'Layout bounds',
    group: 'debug',
    hint: 'Outlines every view (native views; Flutter: use the Widget Inspector)',
    options: ONOFF,
    get: async (s) => ((await adb.getprop(s, 'debug.layout')) === 'true' ? 'on' : 'off'),
    set: async (s, v) => {
      await sh(s, ['setprop', 'debug.layout', v === 'on' ? 'true' : 'false']);
      // Ask running apps to re-read system properties (SYSPROPS_TRANSACTION) so it applies without restarting them.
      await sh(s, ['service', 'call', 'activity', '1599295570']);
    },
  },
  {
    id: 'stay_awake',
    label: 'Stay awake while charging',
    group: 'power',
    options: ONOFF,
    get: async (s) => onoff(await setting(s, 'global', 'stay_on_while_plugged_in')) ?? 'off',
    set: (s, v) => sh(s, ['svc', 'power', 'stayon', v === 'on' ? 'true' : 'false']),
  },
  {
    id: 'wifi',
    label: 'Wi-Fi',
    group: 'network',
    hint: 'Test offline behaviour',
    options: ONOFF,
    get: async (s) => onoff(await setting(s, 'global', 'wifi_on')) ?? 'off',
    set: (s, v) => sh(s, ['svc', 'wifi', v === 'on' ? 'enable' : 'disable']),
  },
  {
    id: 'mobile_data',
    label: 'Mobile data',
    group: 'network',
    options: ONOFF,
    get: async (s) => onoff(await setting(s, 'global', 'mobile_data')) ?? 'off',
    set: (s, v) => sh(s, ['svc', 'data', v === 'on' ? 'enable' : 'disable']),
  },
];

const isWifiSerial = (s: string) => s.includes(':') || s.includes('._adb-tls-connect');

async function getToggles(serial: string) {
  assertSerial(serial);
  const values = await Promise.all(TOGGLES.map((t) => t.get(serial).catch(() => null)));
  return TOGGLES.map((t, i) => ({
    id: t.id,
    label: t.label,
    group: t.group,
    hint: t.hint ?? null,
    options: t.options,
    value: values[i],
    // Turning Wi-Fi off on a phone connected over Wi-Fi would cut this very connection.
    disabled: t.id === 'wifi' && isWifiSerial(serial) ? 'Connected over Wi-Fi — turning it off would disconnect the device' : null,
  }));
}

async function setToggle(serial: string, id: string, value: string) {
  assertSerial(serial);
  const t = TOGGLES.find((x) => x.id === id);
  if (!t) throw bad(`Unknown setting: ${id}`);
  if (!t.options.some((o) => o.value === value)) throw bad(`Invalid value for ${t.label}`);
  if (t.id === 'wifi' && value === 'off' && isWifiSerial(serial)) throw bad('This device is connected over Wi-Fi — turning Wi-Fi off would disconnect it', 409);
  await t.set(serial, value);
  return { id, value: await t.get(serial).catch(() => value) };
}

// ---------------------------------------------------------------- emulator console

export type EmuCommand =
  | { action: 'geo'; lat: number; lng: number }
  | { action: 'battery'; level?: number; charging?: boolean }
  | { action: 'network'; speed?: 'full' | 'lte' | 'hsdpa' | 'umts' | 'edge' | 'gprs'; delay?: 'none' | 'umts' | 'edge' | 'gprs' }
  | { action: 'rotate' };

async function emu(serial: string, c: EmuCommand) {
  assertSerial(serial);
  if (!serial.startsWith('emulator-')) throw bad('Emulator controls only work on emulators');
  const cmd = async (args: string[]) => {
    const r = await run(tools.adb(), ['-s', serial, 'emu', ...args], 10_000);
    const out = outOf(r);
    if (!r.ok || /^KO/m.test(out)) throw bad(out.match(/KO:?\s*(.*)/)?.[1] || r.error || 'Emulator console command failed', 502);
  };
  switch (c.action) {
    case 'geo':
      if (!(c.lat >= -90 && c.lat <= 90 && c.lng >= -180 && c.lng <= 180)) throw bad('Latitude −90…90, longitude −180…180');
      await cmd(['geo', 'fix', c.lng.toFixed(6), c.lat.toFixed(6)]); // longitude first
      break;
    case 'battery':
      if (c.level !== undefined) {
        if (!Number.isInteger(c.level) || c.level < 0 || c.level > 100) throw bad('Battery level 0–100');
        await cmd(['power', 'capacity', String(c.level)]);
      }
      if (c.charging !== undefined) {
        await cmd(['power', 'ac', c.charging ? 'on' : 'off']);
        await cmd(['power', 'status', c.charging ? 'charging' : 'discharging']);
      }
      break;
    case 'network':
      if (c.speed) await cmd(['network', 'speed', c.speed]);
      if (c.delay) await cmd(['network', 'delay', c.delay]);
      break;
    case 'rotate':
      await cmd(['rotate']);
      break;
  }
  return { ok: true };
}

// ---------------------------------------------------------------- files (/sdcard only)

const ROOT = '/sdcard';
/** Normalises and confines a device path to shared storage. */
function remotePath(p: string) {
  if (typeof p !== 'string' || p.length > 1024 || /['\r\n\0\\`]/.test(p)) throw bad('Invalid path');
  const norm = path.posix.normalize(p.startsWith('/') ? p : `/${p}`).replace(/\/+$/, '') || '/';
  if (!/^\/(sdcard|storage\/emulated\/0)(\/|$)/.test(norm)) throw bad('Only shared storage (/sdcard) can be browsed');
  if (norm.split('/').includes('..')) throw bad('Invalid path');
  return norm;
}
const cleanName = (n: string) => path.basename(n).replace(/[^\w .()+@,-]/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'file';

async function statOne(serial: string, p: string) {
  const r = await sh(serial, ['stat', '-L', '-c', "'%F|%s'", sq(p, 'Path')]);
  const [type, size] = r.stdout.trim().split('|');
  return r.ok && type ? { type, size: Number(size) } : null;
}

async function listFiles(serial: string, dir: string) {
  assertSerial(serial);
  const d = remotePath(dir || ROOT);
  const st = await statOne(serial, d);
  if (!st) throw bad('Folder not found', 404);
  if (st.type !== 'directory') throw bad('Not a folder');
  // Globs stay outside the quotes so the device shell expands them; unmatched globs just print errors (ignored).
  const r = await sh(serial, ['stat', '-L', '-c', "'%F|%s|%Y|%n'", `${sq(d, 'Path')}/*`, `${sq(d, 'Path')}/.[!.]*`, '2>/dev/null'], 30_000);
  const entries = r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const parts = l.split('|');
      if (parts.length < 4) return null;
      const [type, size, mtime] = parts;
      const full = parts.slice(3).join('|');
      const name = full.slice(full.lastIndexOf('/') + 1);
      if (!name || name.includes('*')) return null;
      return {
        name,
        path: `${d}/${name}`,
        dir: type === 'directory',
        size: Number(size) || 0,
        modified: Number(mtime) ? new Date(Number(mtime) * 1000).toISOString() : null,
      };
    })
    .filter((e): e is NonNullable<typeof e> => !!e)
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return { path: d, parent: d === ROOT || d === '/storage/emulated/0' ? null : path.posix.dirname(d), entries };
}

const MAX_PULL = 500 * 1024 * 1024;
async function pullFile(serial: string, p: string) {
  assertSerial(serial);
  const f = remotePath(p);
  const st = await statOne(serial, f);
  if (!st) throw bad('File not found', 404);
  if (!st.type.startsWith('regular')) throw bad('Only files can be downloaded');
  if (st.size > MAX_PULL) throw bad('File is larger than 500 MB');
  const dest = tmpFile(path.posix.extname(f).replace(/[^\w.]/g, '').slice(0, 10));
  const r = await run(tools.adb(), ['-s', serial, 'pull', f, dest], 600_000);
  if (!r.ok || !fs.existsSync(dest)) throw bad(r.error ?? 'adb pull failed', 502);
  return { file: dest, name: cleanName(path.posix.basename(f)) };
}

async function pushFile(serial: string, localTmp: string, dir: string, name: string) {
  assertSerial(serial);
  const d = remotePath(dir);
  const st = await statOne(serial, d);
  if (st?.type !== 'directory') throw bad('Target folder not found', 404);
  const target = `${d}/${cleanName(name)}`;
  const r = await run(tools.adb(), ['-s', serial, 'push', localTmp, target], 600_000);
  if (!r.ok) throw bad(outOf(r).split(/\r?\n/).pop() || r.error || 'adb push failed', 502);
  return { ok: true, path: target };
}

async function deleteFile(serial: string, p: string) {
  assertSerial(serial);
  const f = remotePath(p);
  if (f === ROOT || f === '/storage/emulated/0') throw bad('Refusing to delete the storage root');
  const st = await statOne(serial, f);
  if (!st) throw bad('File not found', 404);
  if (!st.type.startsWith('regular')) throw bad('Only single files can be deleted here (not folders)');
  const r = await sh(serial, ['rm', '-f', sq(f, 'Path')]);
  if (!r.ok) throw bad(outOf(r) || 'rm failed', 502);
  return { ok: true };
}

// ---------------------------------------------------------------- USB → Wi-Fi

async function toWireless(serial: string) {
  assertSerial(serial);
  if (serial.startsWith('emulator-') || isWifiSerial(serial)) throw bad('Only USB-connected phones can be switched to Wi-Fi');
  assertFree(serial);
  const ipOut = (await sh(serial, ['ip', '-f', 'inet', 'addr', 'show', 'wlan0'])).stdout;
  const ip = ipOut.match(/inet (\d+\.\d+\.\d+\.\d+)/)?.[1];
  if (!ip) throw bad('The phone is not on Wi-Fi — connect it to the same network as this PC first', 412);
  const t = await run(tools.adb(), ['-s', serial, 'tcpip', '5555'], 15_000);
  if (!t.ok && !/restarting/i.test(outOf(t))) throw bad(outOf(t) || t.error || 'adb tcpip failed', 502);
  const addr = `${ip}:5555`;
  let last = '';
  for (let i = 0; i < 8; i++) {
    await sleep(1000);
    const c = await adb.connect(addr);
    if (c.ok) return { ok: true, serial: addr, message: `Connected over Wi-Fi as ${addr} — you can unplug the cable. Wi-Fi mode resets when the phone reboots.` };
    last = c.message;
  }
  throw bad(`Phone switched to Wi-Fi mode but ${addr} did not answer (${last}). Check that the PC and phone are on the same network and no firewall blocks port 5555.`, 502);
}

// ----------------------------------------------------------------

// ---------------------------------------------------------------- RAM saver

/** OOM groups printed by `dumpsys meminfo`, most important first. Only the closable ones are offered to the user. */
const MEM_GROUPS = new Set([
  'Native', 'System', 'Persistent', 'Persistent Service', 'Foreground', 'Visible', 'Perceptible', 'Perceptible Medium', 'Perceptible Low',
  'Backup', 'Heavy Weight', 'A Services', 'Home', 'Previous', 'B Services', 'Cached',
]);
/** Background groups Android itself would kill first when memory runs low. */
const CLOSABLE_GROUPS = new Set(['A Services', 'Previous', 'B Services', 'Cached']);
/** Never force-stopped, whatever group they are in (system UI, telephony, Play services the app under test may need). */
const PROTECTED_PKGS = new Set([
  'android', 'com.android.systemui', 'com.android.phone', 'com.android.shell', 'com.android.settings', 'com.google.android.gms', 'com.google.android.gsf',
  'com.android.bluetooth', 'com.android.networkstack', 'com.android.providers.media.module', 'com.android.se', 'com.android.nfc',
]);

export interface MemProcess {
  name: string;
  package: string | null;
  pid: number | null;
  mb: number;
  group: string;
  closable: boolean;
}

/** "Total PSS by OOM adjustment" from `dumpsys meminfo` (PSS preferred; Android 14+ prints an RSS table too). */
export function parseMeminfo(out: string): { groups: { name: string; mb: number }[]; processes: MemProcess[] } {
  const pss = out.search(/^Total PSS by OOM adjustment:/m);
  const start = pss >= 0 ? pss : out.search(/^Total RSS by OOM adjustment:/m);
  if (start < 0) return { groups: [], processes: [] };
  const lines = out.slice(start).split(/\r?\n/).slice(1);
  const groups: { name: string; mb: number }[] = [];
  const processes: MemProcess[] = [];
  let group = '';
  for (const line of lines) {
    if (!line.trim() || /^Total /.test(line)) break;
    const m = line.match(/^\s*([\d,]+)K:\s+(.+?)\s*$/);
    if (!m) continue;
    const mb = Math.round((Number(m[1].replace(/,/g, '')) / 1024) * 10) / 10;
    const rest = m[2];
    if (!rest.includes('(pid') && MEM_GROUPS.has(rest)) {
      group = rest;
      groups.push({ name: rest, mb });
      continue;
    }
    const name = rest.replace(/\s*\(pid.*$/, '');
    const pkg = name.split(':')[0].match(/^[a-zA-Z][\w]*(\.[a-zA-Z_][\w]*)+$/)?.[0] ?? null;
    processes.push({
      name,
      package: pkg,
      pid: Number(rest.match(/\(pid (\d+)/)?.[1]) || null,
      mb,
      group,
      closable: CLOSABLE_GROUPS.has(group) && !!pkg && !PROTECTED_PKGS.has(pkg),
    });
  }
  return { groups, processes: processes.sort((a, b) => b.mb - a.mb) };
}

async function availableMb(serial: string): Promise<number | null> {
  const r = await sh(serial, ['cat', '/proc/meminfo']);
  const kb = Number(r.stdout.match(/^MemAvailable:\s+(\d+)/m)?.[1]);
  return kb ? Math.round(kb / 1024) : null;
}

/** Launcher and keyboard: closing either would leave a blank or unusable screen. */
async function essentialPackages(serial: string): Promise<Set<string>> {
  const [home, ime] = await Promise.all([
    sh(serial, ['cmd', 'package', 'resolve-activity', '--brief', '-c', 'android.intent.category.HOME', '-a', 'android.intent.action.MAIN']),
    sh(serial, ['settings', 'get', 'secure', 'default_input_method']),
  ]);
  const out = new Set<string>();
  const homePkg = home.stdout.trim().split(/\r?\n/).pop()?.split('/')[0];
  const imePkg = ime.stdout.trim().split('/')[0];
  for (const p of [homePkg, imePkg]) if (p && PACKAGE_LIKE.test(p)) out.add(p);
  return out;
}
const PACKAGE_LIKE = /^[a-zA-Z][\w]*(\.[a-zA-Z_][\w]*)+$/;

/** Device RAM: totals from /proc/meminfo, usage by group and app from `dumpsys meminfo`, and which apps can be closed. */
async function memory(serial: string) {
  assertSerial(serial);
  const [mem, dump, fg, essential] = await Promise.all([
    sh(serial, ['cat', '/proc/meminfo']),
    // -t 60: dumpsys gives up after 10 s by default, which a busy emulator easily needs (it then prints nothing).
    sh(serial, ['dumpsys', '-t', '60', 'meminfo'], 90_000),
    adb.foregroundPackage(serial).catch(() => null),
    essentialPackages(serial).catch(() => new Set<string>()),
  ]);
  const kb = (k: string) => Number(mem.stdout.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))?.[1]) || 0;
  const total = Math.round(kb('MemTotal') / 1024);
  const avail = Math.round(kb('MemAvailable') / 1024);
  const { groups, processes } = parseMeminfo(dump.stdout);
  const byPkg = new Map<string, { package: string; mb: number; processes: number; group: string }>();
  for (const p of processes) {
    if (!p.closable || !p.package || p.package === fg || essential.has(p.package)) continue;
    const cur = byPkg.get(p.package);
    if (cur) {
      cur.mb = Math.round((cur.mb + p.mb) * 10) / 10;
      cur.processes++;
    } else byPkg.set(p.package, { package: p.package, mb: p.mb, processes: 1, group: p.group });
  }
  const closable = [...byPkg.values()].sort((a, b) => b.mb - a.mb);
  return {
    serial,
    total_mb: total || null,
    available_mb: avail || null,
    used_pct: total ? Math.round(((total - avail) / total) * 100) : null,
    swap_total_mb: Math.round(kb('SwapTotal') / 1024),
    swap_used_mb: Math.round((kb('SwapTotal') - kb('SwapFree')) / 1024),
    groups,
    top: processes.slice(0, 12).map((p) => ({ ...p, closable: p.closable && p.package !== fg && !essential.has(p.package ?? '') })),
    closable,
    closable_mb: Math.round(closable.reduce((s, c) => s + c.mb, 0)),
    foreground: fg,
    busy: serialBusy(serial),
  };
}

/**
 * Free device RAM: force-stop the chosen background apps (their services too), then `am kill-all` for every other
 * cached process Android considers safe to kill. The app on screen, the launcher, the keyboard and system apps are never touched.
 */
async function freeMemory(serial: string, packages: string[]) {
  assertSerial(serial);
  assertFree(serial);
  if (packages.length > 100) throw bad('Choose at most 100 apps');
  for (const p of packages) assertPackage(p);
  const [fg, essential, before] = await Promise.all([adb.foregroundPackage(serial).catch(() => null), essentialPackages(serial).catch(() => new Set<string>()), availableMb(serial)]);
  const stopped: string[] = [];
  const skipped: string[] = [];
  for (const p of [...new Set(packages)]) {
    if (PROTECTED_PKGS.has(p) || p === fg || essential.has(p)) {
      skipped.push(p);
      continue;
    }
    const r = await adb.forceStop(serial, p);
    (r.ok ? stopped : skipped).push(p);
  }
  await sh(serial, ['am', 'kill-all'], 20_000);
  await sleep(2500); // let the kernel account the freed pages
  const after = await availableMb(serial);
  return {
    before_mb: before,
    after_mb: after,
    freed_mb: before !== null && after !== null ? Math.max(0, after - before) : null,
    stopped,
    skipped,
  };
}

export const devkit = {
  memory,
  freeMemory,
  info,
  apps,
  appDetails,
  appAction,
  setPermission,
  setAppLocale,
  pullApk,
  installApk,
  perf,
  resetFrames,
  logcatStream,
  clearLogcat: (serial: string) => adb.clearLogcat(serial),
  recordingStatus,
  startRecording,
  stopRecording,
  listRecordings,
  recordingFile,
  deleteRecording,
  deepLink,
  getToggles,
  setToggle,
  emu,
  listFiles,
  pullFile,
  pushFile,
  deleteFile,
  toWireless,
  /** Shutdown: close logcat streams and finish recordings. */
  async stopAll() {
    for (const s of [...streams]) s.stop();
    await Promise.all([...recordings.keys()].map((serial) => stopRecording(serial).catch(() => null)));
  },
};
