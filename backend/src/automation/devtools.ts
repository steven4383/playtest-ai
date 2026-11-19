import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { run, runSdkTool, tools } from './sdk.js';

/**
 * Developer helpers around connected devices:
 *  - Flutter: detect the SDK and list what `flutter devices` sees (same ADB server as PlayTest,
 *    so phones connected here — USB, Wi-Fi, QR — and emulators started here appear in flutter run / VS Code).
 *  - scrcpy: full-quality screen mirroring with mouse/keyboard control in its own window.
 */

const isWin = process.platform === 'win32';

function findOnPath(names: string[]): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) for (const n of names) {
    const p = path.join(d, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ---------- Flutter ----------

export interface FlutterDevice {
  id: string;
  name: string;
  target_platform: string;
  emulator: boolean;
  sdk: string;
  supported: boolean;
}

export function flutterBin(): string | null {
  const candidates = [
    config.FLUTTER_ROOT ? path.join(config.FLUTTER_ROOT, 'bin', isWin ? 'flutter.bat' : 'flutter') : '',
    process.env.FLUTTER_ROOT ? path.join(process.env.FLUTTER_ROOT, 'bin', isWin ? 'flutter.bat' : 'flutter') : '',
  ].filter((p) => p && fs.existsSync(p));
  return candidates[0] ?? findOnPath(isWin ? ['flutter.bat'] : ['flutter']) ?? [
    isWin ? 'C:\\src\\flutter\\bin\\flutter.bat' : '',
    isWin ? 'C:\\dev\\flutter\\bin\\flutter.bat' : '',
    path.join(os.homedir(), 'flutter', 'bin', isWin ? 'flutter.bat' : 'flutter'),
    path.join(os.homedir(), 'development', 'flutter', 'bin', 'flutter'),
  ].find((p) => p && fs.existsSync(p)) ?? null;
}

let flutterCache: { at: number; value: Awaited<ReturnType<typeof flutterStatusUncached>> } | null = null;

async function flutterStatusUncached() {
  const bin = flutterBin();
  if (!bin) return { available: false as const, path: null, version: null, channel: null, devices: [] as FlutterDevice[], error: null as string | null };
  const [ver, dev] = await Promise.all([
    runSdkTool(bin, ['--version', '--machine'], { timeoutMs: 60_000 }),
    runSdkTool(bin, ['devices', '--machine'], { timeoutMs: 60_000 }),
  ]);
  const parseJson = (s: string) => {
    const start = s.search(/[[{]/);
    try {
      return start >= 0 ? JSON.parse(s.slice(start)) : null;
    } catch {
      return null;
    }
  };
  const v = parseJson(ver.stdout);
  const list = (parseJson(dev.stdout) ?? []) as any[];
  return {
    available: true as const,
    path: bin,
    version: v?.frameworkVersion ?? null,
    channel: v?.channel ?? null,
    devices: list
      .filter((d) => typeof d?.id === 'string')
      .map((d) => ({
        id: d.id,
        name: d.name,
        target_platform: d.targetPlatform,
        emulator: !!d.emulator,
        sdk: d.sdk,
        supported: d.isSupported !== false,
      })),
    error: dev.ok ? null : dev.error ?? null,
  };
}

/** `flutter devices` takes a few seconds — cache for 10 s. */
export async function flutterStatus(refresh = false) {
  if (!refresh && flutterCache && Date.now() - flutterCache.at < 10_000) return flutterCache.value;
  const value = await flutterStatusUncached();
  flutterCache = { at: Date.now(), value };
  return value;
}

/** winget is an "app execution alias" (a 0-byte reparse point) — fs.existsSync can't see it, lstat can. */
function wingetBin(): string | null {
  if (!isWin) return null;
  const candidates = [
    path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'winget.exe'),
    ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, 'winget.exe')),
  ];
  for (const p of candidates) {
    try {
      fs.lstatSync(p);
      return p;
    } catch {
      /* not here */
    }
  }
  return null;
}

// ---------- scrcpy ----------

export function scrcpyBin(): string | null {
  const exe = isWin ? 'scrcpy.exe' : 'scrcpy';
  const candidates = [
    config.SCRCPY_PATH,
    findOnPath([exe]),
    isWin ? path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', 'scrcpy.exe') : '',
    process.platform === 'darwin' ? '/opt/homebrew/bin/scrcpy' : '',
    process.platform !== 'win32' ? '/usr/local/bin/scrcpy' : '',
  ].filter((p): p is string => !!p);
  const direct = candidates.find((p) => fs.existsSync(p));
  if (direct) return direct;
  // winget sometimes skips the Links shim — look inside its package folder.
  if (isWin) {
    const pkgs = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const d of fs.readdirSync(pkgs).filter((n) => n.startsWith('Genymobile.scrcpy'))) {
        const root = path.join(pkgs, d);
        for (const sub of fs.readdirSync(root)) {
          const p = path.join(root, sub, 'scrcpy.exe');
          if (fs.existsSync(p)) return p;
        }
      }
    } catch {
      /* not installed via winget */
    }
  }
  return null;
}

const install: { state: 'idle' | 'installing' | 'done' | 'error'; message: string | null } = { state: 'idle', message: null };
const mirrors = new Map<string, { pid?: number; started_at: string }>();

export const scrcpy = {
  async status() {
    const bin = scrcpyBin();
    let version: string | null = null;
    if (bin) {
      const r = await run(bin, ['--version'], 10_000);
      version = r.stdout.match(/scrcpy\s+v?([\d.]+)/i)?.[1] ?? null;
    }
    return {
      available: !!bin,
      path: bin,
      version,
      install,
      can_install: !!wingetBin(),
      open: [...mirrors.keys()],
    };
  },

  /** Opens a scrcpy window for the device. Uses PlayTest's adb (ADB env) so two adb versions never fight over the server. */
  open(serial: string, opts: { title?: string; stayAwake?: boolean; turnScreenOff?: boolean; maxSize?: number } = {}) {
    if (!/^[\w.:-]+$/.test(serial)) throw Object.assign(new Error('Invalid serial'), { statusCode: 400 });
    const bin = scrcpyBin();
    if (!bin) throw Object.assign(new Error('scrcpy is not installed — use “Install scrcpy” or get it from github.com/Genymobile/scrcpy'), { statusCode: 412 });
    const title = (opts.title ?? serial).replace(/[^\w .:()-]/g, '').slice(0, 80) || serial;
    const args = ['-s', serial, '--window-title', `PlayTest · ${title}`];
    if (opts.stayAwake) args.push('--stay-awake');
    if (opts.turnScreenOff) args.push('--turn-screen-off');
    if (opts.maxSize) args.push('--max-size', String(Math.max(480, Math.min(4096, Math.round(opts.maxSize)))));
    const adbPath = tools.adb();
    const child = spawn(bin, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: { ...process.env, ...(path.isAbsolute(adbPath) ? { ADB: adbPath } : {}) },
    });
    child.unref();
    mirrors.set(serial, { pid: child.pid, started_at: new Date().toISOString() });
    child.on('exit', () => mirrors.delete(serial));
    child.on('error', () => mirrors.delete(serial));
    return { opened: true, serial };
  },

  /** winget install (Windows). Runs in the background; poll status(). */
  install() {
    if (!isWin) throw Object.assign(new Error('Automatic install is Windows-only — use brew/apt install scrcpy'), { statusCode: 400 });
    const winget = wingetBin();
    if (!winget) throw Object.assign(new Error('winget not found — install "App Installer" from the Microsoft Store, or download scrcpy from GitHub'), { statusCode: 412 });
    if (install.state === 'installing') return install;
    install.state = 'installing';
    install.message = 'Installing scrcpy with winget… (1–2 min)';
    const child = spawn(winget, ['install', '--id', 'Genymobile.scrcpy', '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (out += c.toString()));
    child.on('error', (err) => {
      install.state = 'error';
      install.message = `winget failed to start: ${err.message}`;
    });
    child.on('close', (code) => {
      const found = scrcpyBin();
      if (found) {
        install.state = 'done';
        install.message = `Installed: ${found}`;
      } else {
        install.state = 'error';
        const last = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^[-\\|/ ]+$/.test(l)).pop();
        install.message = `winget exited with code ${code}${last ? `: ${last}` : ''}. Restart the backend if it was installed, or set SCRCPY_PATH in backend/.env.`;
      }
    });
    return install;
  },
};
