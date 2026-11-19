import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);
const isWin = process.platform === 'win32';
const exe = (name: string) => (isWin ? `${name}.exe` : name);

/** Resolve the Android SDK folder from config, env vars or the Android Studio default. */
export function sdkRoot(): string | null {
  const candidates = [
    config.ANDROID_SDK_ROOT,
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    isWin ? path.join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk') : '',
    process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Android', 'sdk') : '',
    path.join(os.homedir(), 'Android', 'Sdk'),
  ].filter((p): p is string => !!p);
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

function inSdk(...parts: string[]): string | null {
  const root = sdkRoot();
  if (!root) return null;
  const p = path.join(root, ...parts);
  return fs.existsSync(p) ? p : null;
}

/** cmdline-tools/latest/bin/<name>, falling back to the newest versioned cmdline-tools folder. */
function cmdlineTool(name: string): string | null {
  const file = isWin ? `${name}.bat` : name;
  const latest = inSdk('cmdline-tools', 'latest', 'bin', file);
  if (latest) return latest;
  const dir = inSdk('cmdline-tools');
  if (!dir) return null;
  const versions = fs
    .readdirSync(dir)
    .filter((d) => /^\d/.test(d))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const v of versions) {
    const p = path.join(dir, v, 'bin', file);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Java for sdkmanager/avdmanager: JAVA_HOME from .env, then the environment,
 * then the JBR bundled with Android Studio (a JDK on PATH is often too old).
 */
export function javaHome(): string | null {
  const javaBin = (home: string) => path.join(home, 'bin', exe('java'));
  const candidates = [
    config.JAVA_HOME,
    process.env.JAVA_HOME,
    isWin ? path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Android', 'Android Studio', 'jbr') : '',
    isWin ? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Android Studio', 'jbr') : '',
    process.platform === 'darwin' ? '/Applications/Android Studio.app/Contents/jbr/Contents/Home' : '',
    process.platform === 'linux' ? '/opt/android-studio/jbr' : '',
  ].filter((p): p is string => !!p);
  return candidates.find((p) => fs.existsSync(javaBin(p))) ?? null;
}

/** Host ABI for system images: x86_64 on Intel/AMD, arm64-v8a on Apple Silicon / ARM. */
export const hostAbi = () => (os.arch() === 'arm64' ? 'arm64-v8a' : 'x86_64');

export const tools = {
  adb: () => inSdk('platform-tools', exe('adb')) ?? exe('adb'),
  emulator: () => inSdk('emulator', exe('emulator')) ?? exe('emulator'),
  sdkmanager: () => cmdlineTool('sdkmanager'),
  avdmanager: () => cmdlineTool('avdmanager'),
  /** aapt2/aapt from the newest build-tools folder. */
  aapt: (): string | null => {
    const bt = inSdk('build-tools');
    if (!bt) return null;
    const versions = fs
      .readdirSync(bt)
      .filter((d) => /^\d/.test(d))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) {
      for (const name of ['aapt2', 'aapt']) {
        const p = path.join(bt, v, exe(name));
        if (fs.existsSync(p)) return p;
      }
    }
    return null;
  },
};

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

/**
 * Run an SDK binary with fixed arguments. Never goes through a shell, so
 * values coming from the database or an LLM cannot inject commands.
 */
export async function run(bin: string, args: string[], timeoutMs = 30_000, env?: Record<string, string>): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    return { ok: true, stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (err: any) {
    return {
      ok: false,
      stdout: err?.stdout?.toString() ?? '',
      stderr: err?.stderr?.toString() ?? '',
      error: err?.code === 'ENOENT' ? `${path.basename(bin)} not found — install Android SDK or set ANDROID_SDK_ROOT` : err?.message,
    };
  }
}

/** Like run(), but returns stdout as raw bytes (screenshots). */
export async function runBuffer(bin: string, args: string[], timeoutMs = 30_000): Promise<{ ok: boolean; data: Buffer; error?: string }> {
  try {
    const { stdout } = await execFileAsync(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' });
    return { ok: true, data: stdout };
  } catch (err: any) {
    return { ok: false, data: Buffer.alloc(0), error: err?.message };
  }
}

/**
 * Arguments passed to the SDK .bat scripts. No quotes, %, &, |, <, >, ^ or `!` — safe to quote for cmd.exe.
 * Backslashes are allowed for Windows paths, but not at the end (`\"` would escape the closing quote for Java).
 */
const SAFE_ARG = /^[\w .;:=()\\\/-]+$/;

/** Folder that holds the AVD .ini pointer files (what `emulator -list-avds` reads). */
export function avdHome(): string {
  if (process.env.ANDROID_AVD_HOME) return path.resolve(process.env.ANDROID_AVD_HOME);
  if (process.env.ANDROID_USER_HOME) return path.join(process.env.ANDROID_USER_HOME, 'avd');
  if (process.env.ANDROID_SDK_HOME) return path.join(process.env.ANDROID_SDK_HOME, '.android', 'avd');
  return path.join(os.homedir(), '.android', 'avd');
}

/**
 * Run sdkmanager / avdmanager (Java tools shipped as .bat on Windows).
 * Node refuses to spawn .bat files without a shell, so on Windows every argument
 * is validated against SAFE_ARG and double-quoted before cmd.exe sees it.
 * `input` is written to stdin (used to answer license / hardware-profile prompts).
 */
export function runSdkTool(
  bin: string,
  args: string[],
  opts: { input?: string; timeoutMs?: number; onLine?: (line: string) => void } = {},
): Promise<RunResult & { code: number | null }> {
  for (const a of args) if (!SAFE_ARG.test(a) || a.endsWith('\\')) throw new Error(`Unsafe SDK tool argument: ${a}`);
  const sdk = sdkRoot();
  const jh = javaHome();
  const env = {
    ...process.env,
    ...(sdk ? { ANDROID_SDK_ROOT: sdk, ANDROID_HOME: sdk } : {}),
    ...(jh ? { JAVA_HOME: jh } : {}),
  };
  return new Promise((resolve) => {
    const child = isWin
      ? spawn(`"${bin}"`, args.map((a) => `"${a}"`), { shell: true, windowsHide: true, env })
      : spawn(bin, args, { windowsHide: true, env });
    let stdout = '';
    let stderr = '';
    let pending = '';
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 30 * 60_000);
    const onData = (chunk: Buffer, isErr: boolean) => {
      const s = chunk.toString();
      if (isErr) stderr += s;
      else stdout += s;
      if (stdout.length > 4 * 1024 * 1024) stdout = stdout.slice(-1024 * 1024);
      if (!opts.onLine) return;
      pending += s;
      const parts = pending.split(/[\r\n]+/);
      pending = parts.pop() ?? '';
      for (const line of parts) if (line.trim()) opts.onLine(line.trim());
    };
    child.stdout.on('data', (c: Buffer) => onData(c, false));
    child.stderr.on('data', (c: Buffer) => onData(c, true));
    child.stdin.on('error', () => {}); // tool may exit before reading all input
    if (opts.input) child.stdin.write(opts.input);
    child.stdin.end();
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr, error: err.code === 'ENOENT' ? `${path.basename(bin)} not found` : err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (pending.trim()) opts.onLine?.(pending.trim());
      const ok = code === 0;
      const lastErr = (stderr.trim() || stdout.trim()).split(/\r?\n/).filter(Boolean).pop();
      resolve({ ok, code, stdout, stderr, error: ok ? undefined : (lastErr ?? `exited with code ${code}`) });
    });
  });
}

export async function toolStatus() {
  const [adb, emu] = await Promise.all([run(tools.adb(), ['version'], 5000), run(tools.emulator(), ['-version'], 8000)]);
  return {
    sdk_root: sdkRoot(),
    adb: { available: adb.ok, version: adb.ok ? adb.stdout.split('\n')[0]?.trim() : null, error: adb.error },
    emulator: {
      available: emu.ok,
      version: emu.ok ? (emu.stdout.match(/version\s+([\d.]+)/i)?.[1] ?? 'unknown') : null,
      error: emu.error,
    },
    aapt: tools.aapt(),
    sdkmanager: tools.sdkmanager(),
    avdmanager: tools.avdmanager(),
    java_home: javaHome(),
    host_abi: hostAbi(),
  };
}
