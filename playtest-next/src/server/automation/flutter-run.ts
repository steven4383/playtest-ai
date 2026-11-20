import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { flutterBin } from './devtools';
import { assertProject } from './flutter-project';
import { sdkRoot } from './sdk';

import { keep } from '../core/keep';
/**
 * `flutter run --machine` sessions driven from the dashboard: hot reload / hot restart / stop over Flutter's
 * JSON-RPC daemon protocol (more reliable than typing r/R into a non-TTY stdin), with live output.
 */

const bad = (msg: string, statusCode = 400) => Object.assign(new Error(msg), { statusCode });
const isWin = process.platform === 'win32';
const SERIAL_RE = /^[\w.:-]{1,120}$/;

export type RunStatus = 'launching' | 'running' | 'reloading' | 'stopping' | 'stopped' | 'error';
export interface RunLine {
  t: number;
  kind: 'log' | 'progress' | 'error' | 'info';
  text: string;
}
interface Session {
  id: string;
  project: string;
  name: string;
  serial: string;
  status: RunStatus;
  message: string | null;
  started_at: string;
  app_id: string | null;
  vm_service: string | null;
  devtools: string | null;
  lines: RunLine[];
  listeners: Set<(e: { type: 'line'; line: RunLine } | { type: 'status'; session: PublicSession }) => void>;
  child: ChildProcess;
  rpcId: number;
  pending: Map<number, (r: { error?: unknown; result?: unknown }) => void>;
}
export type PublicSession = Omit<Session, 'lines' | 'listeners' | 'child' | 'rpcId' | 'pending'> & { line_count: number };

const sessions = keep('flutter.sessions', () => new Map<string, Session>());
const MAX_LINES = 2000;

const pub = (s: Session): PublicSession => ({
  id: s.id,
  project: s.project,
  name: s.name,
  serial: s.serial,
  status: s.status,
  message: s.message,
  started_at: s.started_at,
  app_id: s.app_id,
  vm_service: s.vm_service,
  devtools: s.devtools,
  line_count: s.lines.length,
});

function push(s: Session, kind: RunLine['kind'], text: string) {
  for (const t of text.split(/\r?\n/)) {
    if (!t.trim()) continue;
    const line = { t: Date.now(), kind, text: t.slice(0, 4000) };
    s.lines.push(line);
    if (s.lines.length > MAX_LINES) s.lines.splice(0, s.lines.length - MAX_LINES);
    s.listeners.forEach((fn) => fn({ type: 'line', line }));
  }
}
function setStatus(s: Session, status: RunStatus, message: string | null = s.message) {
  s.status = status;
  s.message = message;
  s.listeners.forEach((fn) => fn({ type: 'status', session: pub(s) }));
}

function killTree(child: ChildProcess) {
  if (child.exitCode !== null || !child.pid) return;
  if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill('SIGTERM');
}

function handleEvent(s: Session, msg: any) {
  if (msg.id !== undefined && !msg.event) {
    s.pending.get(msg.id)?.(msg);
    s.pending.delete(msg.id);
    return;
  }
  const p = msg.params ?? {};
  switch (msg.event) {
    case 'daemon.logMessage':
      push(s, p.level === 'error' ? 'error' : 'info', p.message ?? '');
      break;
    case 'app.start':
      s.app_id = p.appId ?? null;
      push(s, 'info', `Launching ${s.name} on ${p.deviceId ?? s.serial}…`);
      break;
    case 'app.debugPort':
      s.vm_service = p.wsUri ?? null;
      break;
    case 'app.devTools':
      s.devtools = p.uri ?? null;
      break;
    case 'app.started':
      setStatus(s, 'running', 'Running — hot reload is ready');
      push(s, 'info', '✓ App started. Use Hot reload after saving a file.');
      break;
    case 'app.log':
      push(s, p.error ? 'error' : 'log', p.log ?? '');
      break;
    case 'app.progress':
      if (p.message) {
        push(s, 'progress', p.message);
        if (s.status === 'launching') s.message = p.message;
      }
      break;
    case 'app.stop':
      if (p.error) push(s, 'error', String(p.error));
      setStatus(s, p.error ? 'error' : 'stopped', p.error ? String(p.error).slice(0, 300) : 'App stopped');
      break;
    default:
      break;
  }
}

function rpc(s: Session, method: string, params: Record<string, unknown>, timeoutMs = 120_000): Promise<{ error?: unknown; result?: any }> {
  if (!s.child.stdin || s.child.exitCode !== null) return Promise.reject(bad('This run has already ended', 409));
  const id = ++s.rpcId;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      s.pending.delete(id);
      resolve({ error: 'timed out' });
    }, timeoutMs);
    s.pending.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    s.child.stdin!.write(`${JSON.stringify([{ id, method, params }])}\n`);
  });
}

export const flutterRunner = {
  list(): PublicSession[] {
    return [...sessions.values()].map(pub).sort((a, b) => b.started_at.localeCompare(a.started_at));
  },

  get(id: string) {
    return sessions.get(id) ?? null;
  },

  start(projectInput: string, serial: string): PublicSession {
    const project = assertProject(projectInput);
    if (!SERIAL_RE.test(serial)) throw bad('Invalid device serial');
    const bin = flutterBin();
    if (!bin) throw bad('Flutter SDK not found — set FLUTTER_ROOT in backend/.env', 412);
    const existing = [...sessions.values()].find((s) => s.project === project && s.serial === serial && !['stopped', 'error'].includes(s.status));
    if (existing) return pub(existing);
    // Forget finished sessions beyond the last 10.
    const done = [...sessions.values()].filter((s) => ['stopped', 'error'].includes(s.status)).sort((a, b) => a.started_at.localeCompare(b.started_at));
    for (const s of done.slice(0, Math.max(0, done.length - 10))) sessions.delete(s.id);

    const sdk = sdkRoot();
    const env = { ...process.env, ...(sdk ? { ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk } : {}) };
    // .bat needs a shell on Windows; every argument is fixed or a validated serial, and cwd is passed as an option.
    const child = isWin
      ? spawn(`"${bin}"`, ['run', '--machine', '-d', serial], { cwd: project, shell: true, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(bin, ['run', '--machine', '-d', serial], { cwd: project, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const s: Session = {
      id: `run_${crypto.randomBytes(5).toString('hex')}`,
      project,
      name: path.basename(project),
      serial,
      status: 'launching',
      message: 'Starting flutter run…',
      started_at: new Date().toISOString(),
      app_id: null,
      vm_service: null,
      devtools: null,
      lines: [],
      listeners: new Set(),
      child,
      rpcId: 0,
      pending: new Map(),
    };
    sessions.set(s.id, s);
    push(s, 'info', `$ flutter run --machine -d ${serial}   (in ${project})`);

    let partial = '';
    child.stdout!.on('data', (c: Buffer) => {
      const text = partial + c.toString('utf8');
      const lines = text.split(/\r?\n/);
      partial = lines.pop() ?? '';
      for (const l of lines) {
        const t = l.trim();
        if (t.startsWith('[{') && t.endsWith('}]')) {
          try {
            for (const msg of JSON.parse(t)) handleEvent(s, msg);
            continue;
          } catch {
            /* not JSON after all */
          }
        }
        if (t) push(s, 'log', t);
      }
    });
    child.stderr!.on('data', (c: Buffer) => push(s, 'error', c.toString('utf8')));
    child.stdin!.on('error', () => {});
    child.on('error', (e) => {
      push(s, 'error', e.message);
      setStatus(s, 'error', e.message);
    });
    child.on('close', (code) => {
      for (const fn of s.pending.values()) fn({ error: 'flutter exited' });
      s.pending.clear();
      if (s.status !== 'stopped' && s.status !== 'error') {
        const last = [...s.lines].reverse().find((l) => l.kind === 'error')?.text;
        setStatus(s, code === 0 ? 'stopped' : 'error', code === 0 ? 'flutter run ended' : (last ?? `flutter exited with code ${code}`));
      }
      push(s, 'info', `flutter run exited (code ${code ?? '?'})`);
    });
    return pub(s);
  },

  async reload(id: string, full: boolean) {
    const s = sessions.get(id);
    if (!s) throw bad('Run not found', 404);
    if (!s.app_id || s.status !== 'running') throw bad(s.status === 'launching' ? 'Still launching — wait until it says Running' : 'The app is not running', 409);
    setStatus(s, 'reloading', full ? 'Hot restarting…' : 'Hot reloading…');
    const t0 = Date.now();
    const r = await rpc(s, 'app.restart', { appId: s.app_id, fullRestart: full, pause: false, reason: 'manual' });
    const res = r.result as { code?: number; message?: string } | undefined;
    const ok = !r.error && (res?.code ?? 0) === 0;
    const msg = ok ? `${full ? 'Hot restart' : 'Hot reload'} done in ${Date.now() - t0} ms${res?.message ? ` — ${res.message}` : ''}` : `${full ? 'Hot restart' : 'Hot reload'} failed: ${res?.message ?? String(r.error)}`;
    push(s, ok ? 'info' : 'error', msg);
    if ((s.status as RunStatus) === 'reloading') setStatus(s, 'running', msg);
    if (!ok) throw bad(msg, 502);
    return { ok, message: msg };
  },

  async stop(id: string) {
    const s = sessions.get(id);
    if (!s) throw bad('Run not found', 404);
    if (s.status === 'stopped' || s.status === 'error') return pub(s);
    setStatus(s, 'stopping', 'Stopping…');
    if (s.app_id) await rpc(s, 'app.stop', { appId: s.app_id }, 10_000).catch(() => null);
    setTimeout(() => killTree(s.child), 3000);
    return pub(s);
  },

  stopAll() {
    for (const s of sessions.values()) killTree(s.child);
  },

  /** Opens a normal console window running `flutter run -d <serial>` in the project (type r / R there). */
  openTerminal(projectInput: string, serial: string) {
    if (!isWin) throw bad('Opening a terminal is supported on Windows only — run `flutter run -d <serial>` yourself', 400);
    const project = assertProject(projectInput);
    if (!SERIAL_RE.test(serial)) throw bad('Invalid device serial');
    const bin = flutterBin();
    if (!bin) throw bad('Flutter SDK not found', 412);
    if (/["%&|<>^!]/.test(bin) || /["%&|<>^!]/.test(project)) throw bad('Flutter or project path contains characters cmd.exe cannot handle safely');
    // cmd /c start "title" cmd /k ""<flutter.bat>" run -d <serial>"
    const cmdline = `/c start "PlayTest - flutter run" /D "${project}" cmd /k ""${bin}" run -d ${serial}"`;
    const child = spawn('cmd.exe', [cmdline], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return { ok: true, message: `Opened a terminal running flutter run -d ${serial} in ${path.basename(project)}` };
  },
};
