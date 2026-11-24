import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config';
import { bus } from '../core/events';
import { keep } from '../core/keep';
import { db, newId } from '../db';
import { projectRepo, readPubspecVersion, type Component, type PlayConfig } from '../services/projects';
import { flutterBin } from './devtools';
import { git, gitInfo } from './git';
import { playPublisher, readServiceAccount } from './play-publisher';
import { javaHome, run, sdkRoot } from './sdk';

/**
 * One-click release of a Flutter app:
 *   Checks → Version bump (pubspec.yaml) → flutter build appbundle → Signing check → Upload to Google Play → Commit & tag
 *
 * Modes: publish (the real thing) · dry_run (Google validates the release, nothing is published, pubspec.yaml is put
 * back) · build (just a signed AAB with the current version). If anything fails before the upload, pubspec.yaml is
 * restored, so a failed release never leaves a half-changed project behind.
 */

const isWin = process.platform === 'win32';
const bad = (msg: string, statusCode = 400) => Object.assign(new Error(msg), { statusCode });

export const releaseInput = z.object({
  mode: z.enum(['publish', 'dry_run', 'build']).default('dry_run'),
  track: z.string().trim().regex(/^[\w:-]{1,64}$/).optional(),
  bump: z.enum(['patch', 'minor', 'major', 'build']).optional(),
  release_status: z.enum(['completed', 'draft', 'inProgress']).optional(),
  user_fraction: z.number().gt(0).lt(1).nullable().optional(),
  notes: z.string().max(500).optional().nullable(),
  confirm_production: z.boolean().optional(),
});
export type ReleaseInput = z.infer<typeof releaseInput>;

type StepId = 'preflight' | 'version' | 'build' | 'verify' | 'upload' | 'git';
type StepState = 'pending' | 'running' | 'done' | 'skipped' | 'failed';
export interface Step {
  id: StepId;
  label: string;
  state: StepState;
  detail?: string;
  ms?: number;
}
export interface ReleaseRow {
  id: string;
  component_id: string;
  mode: 'publish' | 'dry_run' | 'build';
  track: string | null;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  version_before: string | null;
  version_after: string | null;
  version_code: number | null;
  release_status: string | null;
  user_fraction: number | null;
  notes: string | null;
  aab_path: string | null;
  aab_bytes: number | null;
  steps: string | null;
  warning: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

const LABELS: Record<StepId, string> = {
  preflight: 'Checks',
  version: 'Version bump',
  build: 'Build App Bundle',
  verify: 'Signing check',
  upload: 'Upload to Google Play',
  git: 'Commit & tag',
};
const ORDER: StepId[] = ['preflight', 'version', 'build', 'verify', 'upload', 'git'];

type Listener = (e: { type: 'line'; line: string } | { type: 'release'; release: unknown }) => void;
interface Session {
  row: ReleaseRow;
  steps: Step[];
  lines: string[];
  listeners: Set<Listener>;
  child: ChildProcess | null;
  cancelled: boolean;
  logFile: string;
}
const sessions = keep('release.sessions', () => new Map<string, Session>());

class Cancelled extends Error {}

// ---------------------------------------------------------------- version

/** 1.2.3+4 → next version. The build number is always above both the old one and Play's highest version code. */
export function nextVersion(current: string | null, bump: 'patch' | 'minor' | 'major' | 'build', minCode: number) {
  const m = (current ?? '').match(/^(\d+)\.(\d+)\.(\d+)(?:\+(\d+))?$/);
  if (!m) throw bad(`pubspec.yaml version "${current ?? '(none)'}" is not like 1.2.3+4 — fix it first`);
  let [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const build = m[4] ? Number(m[4]) : 0;
  if (bump === 'major') [maj, min, pat] = [maj + 1, 0, 0];
  else if (bump === 'minor') [min, pat] = [min + 1, 0];
  else if (bump === 'patch') pat += 1;
  const code = Math.max(build + 1, minCode);
  return { name: `${maj}.${min}.${pat}`, code, full: `${maj}.${min}.${pat}+${code}` };
}

function writePubspecVersion(file: string, full: string) {
  const text = fs.readFileSync(file, 'utf8');
  if (!/^version:\s*[^\s#]+/m.test(text)) throw bad('pubspec.yaml has no "version:" line');
  fs.writeFileSync(file, text.replace(/^version:\s*[^\s#]+/m, `version: ${full}`));
}

// ---------------------------------------------------------------- session helpers

const pub = (s: Session) => ({ ...s.row, steps: s.steps, live: true, log_lines: s.lines.length });

function save(s: Session) {
  const r = s.row;
  db.prepare(
    `UPDATE releases SET status = ?, version_before = ?, version_after = ?, version_code = ?, aab_path = ?, aab_bytes = ?, steps = ?,
       warning = ?, error = ?, finished_at = ? WHERE id = ?`,
  ).run(r.status, r.version_before, r.version_after, r.version_code, r.aab_path, r.aab_bytes, JSON.stringify(s.steps), r.warning, r.error, r.finished_at, r.id);
  for (const l of s.listeners) l({ type: 'release', release: pub(s) });
  const comp = projectRepo.component(r.component_id);
  bus.publish({ event: 'release_update', data: { release_id: r.id, component_id: r.component_id, project_id: comp?.project_id ?? null, status: r.status } });
}

function log(s: Session, line: string) {
  const l = line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
  if (!l) return;
  s.lines.push(l);
  if (s.lines.length > 4000) s.lines.splice(0, s.lines.length - 4000);
  try {
    fs.appendFileSync(s.logFile, l + '\n');
  } catch {
    /* log file is best-effort */
  }
  for (const fn of s.listeners) fn({ type: 'line', line: l });
}

async function step<T>(s: Session, id: StepId, fn: () => Promise<{ detail?: string; value?: T } | void>): Promise<T | undefined> {
  if (s.cancelled) throw new Cancelled();
  const st = s.steps.find((x) => x.id === id)!;
  st.state = 'running';
  st.detail = undefined;
  save(s);
  log(s, `── ${st.label}`);
  const t0 = Date.now();
  try {
    const r = await fn();
    st.state = 'done';
    st.detail = r?.detail;
    return r?.value;
  } catch (err) {
    st.state = s.cancelled ? 'skipped' : 'failed';
    st.detail = s.cancelled ? 'Cancelled' : (err as Error).message;
    throw err;
  } finally {
    st.ms = Date.now() - t0;
    save(s);
  }
}

function skip(s: Session, id: StepId, why: string) {
  const st = s.steps.find((x) => x.id === id)!;
  st.state = 'skipped';
  st.detail = why;
}

/** Run a build tool, streaming every output line into the release log. */
function runStreaming(s: Session, bin: string, args: string[], cwd: string, timeoutMs: number): Promise<number> {
  const sdk = sdkRoot();
  const jh = javaHome();
  const env = { ...process.env, ...(sdk ? { ANDROID_SDK_ROOT: sdk, ANDROID_HOME: sdk } : {}), ...(jh ? { JAVA_HOME: jh } : {}) };
  return new Promise((resolve, reject) => {
    // .bat files (flutter.bat) need a shell on Windows; the arguments here are fixed words, never user input.
    const child = isWin ? spawn(`"${bin}"`, args, { cwd, shell: true, windowsHide: true, env }) : spawn(bin, args, { cwd, windowsHide: true, env });
    s.child = child;
    let pending = '';
    const onData = (chunk: Buffer) => {
      pending += chunk.toString();
      const parts = pending.split(/\r?\n|\r/);
      pending = parts.pop() ?? '';
      for (const p of parts) log(s, p);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const timer = setTimeout(() => {
      log(s, `Timed out after ${Math.round(timeoutMs / 60_000)} min`);
      killTree(child);
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      s.child = null;
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (pending) log(s, pending);
      s.child = null;
      resolve(code ?? -1);
    });
  });
}

function killTree(child: ChildProcess) {
  if (!child.pid) return;
  if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill('SIGTERM');
}

/** Keep the AAB of the last few releases per app (logs stay). */
function pruneBundles(componentId: string, keepCount = 5) {
  const root = path.join(config.STORAGE_DIR, 'releases', componentId);
  const rows = db.prepare("SELECT id, aab_path FROM releases WHERE component_id = ? AND aab_path IS NOT NULL ORDER BY started_at DESC").all(componentId) as {
    id: string;
    aab_path: string;
  }[];
  for (const r of rows.slice(keepCount)) {
    if (r.aab_path.toLowerCase().startsWith(root.toLowerCase())) fs.rmSync(r.aab_path, { force: true });
    db.prepare('UPDATE releases SET aab_path = NULL WHERE id = ?').run(r.id);
  }
}

// ---------------------------------------------------------------- the pipeline

async function pipeline(s: Session, comp: Component, cfg: PlayConfig | null, opts: Required<Pick<ReleaseInput, 'mode'>> & ReleaseInput) {
  const dir = comp.path;
  const pubspec = path.join(dir, 'pubspec.yaml');
  const mode = opts.mode;
  const uploads = mode !== 'build';
  let original: string | null = null; // pubspec.yaml before the bump (restored on failure / dry run)
  let uploaded = false;
  let maxCode = 0;
  let sa: ReturnType<typeof readServiceAccount> | null = null;
  let full = s.row.version_before ?? '';
  let gitRepo = false;

  try {
    await step(s, 'preflight', async () => {
      if (comp.framework !== 'flutter' || !fs.existsSync(pubspec)) throw bad('Releases are for Flutter apps (no pubspec.yaml in this folder)');
      if (!flutterBin()) throw bad('Flutter SDK not found — set FLUTTER_ROOT in .env or add flutter to PATH');
      const version = readPubspecVersion(dir).version;
      if (mode !== 'build') nextVersion(version, 'build', 0); // validates the format early
      const keyProps = path.join(dir, 'android', 'key.properties');
      if (!fs.existsSync(keyProps)) {
        if (uploads) throw bad('Release signing is not set up: android/key.properties is missing (Flutter docs → "Build and release an Android app" → Signing).');
        log(s, 'No android/key.properties — the bundle will use whatever signing build.gradle sets up.');
      }
      const info = await gitInfo(dir);
      gitRepo = info.repo;
      if (info.repo) log(s, `Git: ${info.branch ?? '?'} · ${info.changed.length} uncommitted change(s)`);
      if (mode === 'publish' && info.repo && cfg?.require_clean && info.changed.length) {
        const list = info.changed.slice(0, 5).map((c) => c.file).join(', ');
        throw bad(`Commit or stash your changes first (${info.changed.length}: ${list}${info.changed.length > 5 ? ' …' : ''}) — or turn off "Only release committed code".`);
      }
      if (uploads) {
        if (!cfg) throw bad('Set up Google Play for this app first (package name and service account)');
        if (!cfg.service_account_file || !fs.existsSync(cfg.service_account_file)) throw bad('Add the Google Play service-account key (JSON) first');
        if (comp.package_name && comp.package_name !== cfg.package_name)
          log(s, `Note: build.gradle says ${comp.package_name}, Play settings say ${cfg.package_name}.`);
        sa = readServiceAccount(cfg.service_account_file);
        const st = await playPublisher.status(sa, cfg.package_name);
        maxCode = st.max_version_code;
        for (const t of st.tracks) {
          const rel = t.releases?.map((r) => `${r.name ?? r.versionCodes?.join(',')} (${r.status})`).join(', ');
          log(s, `Play ${t.track}: ${rel || 'empty'}`);
        }
        return { detail: `Play access OK · highest version code ${maxCode || 'none yet'} · ${info.repo ? info.branch : 'no git'}` };
      }
      return { detail: info.repo ? `Git branch ${info.branch}` : 'Not a git repository' };
    });

    if (mode === 'build') skip(s, 'version', 'Build only — keeps the current version');
    else
      await step(s, 'version', async () => {
        const before = readPubspecVersion(dir).version;
        const next = nextVersion(before, opts.bump ?? cfg?.bump ?? 'patch', maxCode + 1);
        original = fs.readFileSync(pubspec, 'utf8');
        writePubspecVersion(pubspec, next.full);
        full = next.full;
        s.row.version_after = next.full;
        s.row.version_code = next.code;
        log(s, `pubspec.yaml: ${before} → ${next.full}`);
        return { detail: `${before} → ${next.full}` };
      });

    const aab = await step<string>(s, 'build', async () => {
      const started = Date.now();
      const code = await runStreaming(s, flutterBin()!, ['build', 'appbundle', '--release'], dir, 45 * 60_000);
      if (s.cancelled) throw new Cancelled();
      if (code !== 0) throw bad(`flutter build appbundle failed (exit ${code}) — see the log`);
      const out = path.join(dir, 'build', 'app', 'outputs', 'bundle', 'release', 'app-release.aab');
      if (!fs.existsSync(out) || fs.statSync(out).mtimeMs < started - 5_000) throw bad('Build finished but build/app/outputs/bundle/release/app-release.aab was not produced');
      const destDir = path.join(config.STORAGE_DIR, 'releases', comp.id, s.row.id);
      fs.mkdirSync(destDir, { recursive: true });
      const dest = path.join(destDir, `${(cfg?.package_name ?? comp.name).replace(/[^\w.-]/g, '_')}-${(s.row.version_after ?? full ?? 'build').replace(/[^\w.+-]/g, '_')}.aab`);
      fs.copyFileSync(out, dest);
      s.row.aab_path = dest;
      s.row.aab_bytes = fs.statSync(dest).size;
      return { detail: `${(s.row.aab_bytes / 1024 / 1024).toFixed(1)} MB in ${Math.round((Date.now() - started) / 1000)} s`, value: dest };
    });

    await step(s, 'verify', async () => {
      const jh = javaHome();
      const keytool = jh ? path.join(jh, 'bin', isWin ? 'keytool.exe' : 'keytool') : null;
      if (!keytool || !fs.existsSync(keytool)) return { detail: 'Skipped — keytool (Java) not found' };
      const r = await run(keytool, ['-printcert', '-jarfile', aab!], 60_000);
      const owner = `${r.stdout}`.match(/Owner:\s*(.+)/)?.[1]?.trim();
      if (!owner) throw bad('The App Bundle is not signed — set up release signing in android/app/build.gradle');
      if (/CN=Android Debug/i.test(owner)) {
        const msg = 'Signed with the DEBUG key — Play rejects it. Point the release signingConfig in android/app/build.gradle at your upload keystore (key.properties).';
        if (uploads) throw bad(msg);
        s.row.warning = msg;
        return { detail: 'Debug key (fine for a local build only)' };
      }
      return { detail: `Signed by ${owner}` };
    });

    if (!uploads) skip(s, 'upload', 'Build only');
    else
      await step(s, 'upload', async () => {
        const track = opts.track ?? cfg!.default_track;
        const status = opts.release_status ?? cfg!.release_status;
        const r = await playPublisher.publish(
          sa!,
          cfg!.package_name,
          aab!,
          {
            track,
            status,
            userFraction: status === 'inProgress' ? (opts.user_fraction ?? cfg!.user_fraction ?? 0.1) : null,
            notes: opts.notes,
            releaseName: s.row.version_after ?? undefined,
            dryRun: mode === 'dry_run',
          },
          (l) => log(s, l),
        );
        uploaded = mode === 'publish';
        return { detail: mode === 'dry_run' ? `Validated by Google Play for "${track}" — not published` : `Version ${r.version_code} on "${track}" (${status})` };
      });

    if (mode !== 'publish') {
      skip(s, 'git', mode === 'dry_run' ? 'Dry run — nothing committed' : 'Build only');
      if (original !== null) {
        fs.writeFileSync(pubspec, original);
        log(s, 'pubspec.yaml put back to its previous version (dry run).');
      }
    } else if (!gitRepo || !cfg?.git_commit) skip(s, 'git', gitRepo ? 'Turned off in settings' : 'Not a git repository');
    else
      try {
        await step(s, 'git', async () => {
          const tag = `v${full}`;
          const add = await git(dir, ['add', '--', 'pubspec.yaml']);
          const commit = add.ok ? await git(dir, ['commit', '-m', `chore(release): ${tag}`, '--', 'pubspec.yaml']) : add;
          if (!commit.ok) throw bad(`git commit failed: ${(commit.stderr || commit.stdout || commit.error || '').trim().split(/\r?\n/).pop()}`);
          const done = [`committed ${tag}`];
          if (cfg.git_tag) {
            const t = await git(dir, ['tag', '-a', tag, '-m', `Release ${full} (${opts.track ?? cfg.default_track})`]);
            if (t.ok) done.push('tagged');
            else log(s, `git tag failed: ${t.stderr.trim()}`);
          }
          if (cfg.git_push) {
            const p = await git(dir, ['push', 'origin', 'HEAD'], 120_000);
            const pt = p.ok && cfg.git_tag ? await git(dir, ['push', 'origin', tag], 120_000) : p;
            if (p.ok && pt.ok) done.push('pushed');
            else throw bad(`Pushed nothing: ${(pt.stderr || p.stderr || p.error || '').trim().split(/\r?\n/).pop()} — push from your editor later`);
          }
          return { detail: done.join(' · ') };
        });
      } catch (err) {
        // The app is already on Play: a git problem is a warning, not a failed release.
        s.row.warning = `Released, but git: ${(err as Error).message}`;
      }

    s.row.status = 'succeeded';
    log(s, mode === 'publish' ? `Released ${full} 🎉` : mode === 'dry_run' ? 'Dry run finished — everything would work.' : 'Build finished.');
  } catch (err) {
    s.row.status = s.cancelled || err instanceof Cancelled ? 'cancelled' : 'failed';
    s.row.error = s.row.status === 'cancelled' ? 'Cancelled' : (err as Error).message;
    log(s, `✖ ${s.row.error}`);
    for (const st of s.steps) if (st.state === 'pending') st.state = 'skipped';
    if (original !== null && !uploaded) {
      fs.writeFileSync(pubspec, original);
      log(s, 'pubspec.yaml put back to its previous version.');
      if (s.row.version_after) s.row.version_after = null;
    }
  } finally {
    s.row.finished_at = new Date().toISOString();
    save(s);
    pruneBundles(comp.id);
    // Keep finished sessions a while for the live view, then drop them (the row and log file stay).
    setTimeout(() => sessions.delete(s.row.id), 10 * 60_000).unref();
  }
}

// ---------------------------------------------------------------- public API

const rowPublic = (r: ReleaseRow) => {
  const live = sessions.get(r.id);
  if (live) return pub(live);
  return { ...r, steps: r.steps ? (JSON.parse(r.steps) as Step[]) : [], live: false };
};

export const releaseRunner = {
  start(componentId: string, input: ReleaseInput) {
    const comp = projectRepo.component(componentId);
    if (!comp) throw bad('Project part not found', 404);
    for (const s of sessions.values()) if (s.row.status === 'running') throw bad(`Another release is running (${s.row.version_after ?? s.row.id}) — wait for it or cancel it`, 409);
    const cfg = projectRepo.playConfig(componentId);
    const track = input.track ?? cfg?.default_track ?? null;
    if (input.mode === 'publish' && track === 'production' && !input.confirm_production) throw bad('Releasing to production needs confirmation', 409);

    const id = newId('rel');
    const row: ReleaseRow = {
      id,
      component_id: componentId,
      mode: input.mode,
      track: input.mode === 'build' ? null : track,
      status: 'running',
      version_before: readPubspecVersion(comp.path).version,
      version_after: null,
      version_code: null,
      release_status: input.mode === 'build' ? null : (input.release_status ?? cfg?.release_status ?? 'completed'),
      user_fraction: input.user_fraction ?? null,
      notes: input.notes ?? null,
      aab_path: null,
      aab_bytes: null,
      steps: null,
      warning: null,
      error: null,
      started_at: new Date().toISOString(),
      finished_at: null,
    };
    db.prepare(
      'INSERT INTO releases (id, component_id, mode, track, status, version_before, release_status, user_fraction, notes, started_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).run(id, componentId, row.mode, row.track, row.status, row.version_before, row.release_status, row.user_fraction, row.notes, row.started_at);
    const dir = path.join(config.STORAGE_DIR, 'releases', componentId, id);
    fs.mkdirSync(dir, { recursive: true });
    const s: Session = {
      row,
      steps: ORDER.map((sid) => ({ id: sid, label: LABELS[sid], state: 'pending' as StepState })),
      lines: [],
      listeners: new Set(),
      child: null,
      cancelled: false,
      logFile: path.join(dir, 'release.log'),
    };
    sessions.set(id, s);
    log(s, `${input.mode === 'publish' ? 'Release' : input.mode === 'dry_run' ? 'Dry run' : 'Build'} of ${comp.name} (${comp.path}) started`);
    void pipeline(s, comp, cfg, { ...input, mode: input.mode });
    return pub(s);
  },

  list(componentId: string, limit = 30) {
    const rows = db.prepare('SELECT * FROM releases WHERE component_id = ? ORDER BY started_at DESC LIMIT ?').all(componentId, limit) as unknown as ReleaseRow[];
    return rows.map(rowPublic);
  },

  get(id: string) {
    const live = sessions.get(id);
    if (live) return pub(live);
    const r = db.prepare('SELECT * FROM releases WHERE id = ?').get(id) as unknown as ReleaseRow | undefined;
    return r ? rowPublic(r) : null;
  },

  /** Full log: live lines, or the saved log file of a finished release. */
  lines(id: string): string[] {
    const live = sessions.get(id);
    if (live) return live.lines;
    const r = db.prepare('SELECT component_id FROM releases WHERE id = ?').get(id) as { component_id: string } | undefined;
    if (!r) return [];
    const file = path.join(config.STORAGE_DIR, 'releases', r.component_id, id, 'release.log');
    try {
      return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-4000);
    } catch {
      return [];
    }
  },

  subscribe(id: string, fn: Listener) {
    const s = sessions.get(id);
    if (!s) return null;
    s.listeners.add(fn);
    return () => s.listeners.delete(fn);
  },

  cancel(id: string) {
    const s = sessions.get(id);
    if (!s || s.row.status !== 'running') throw bad('This release is not running', 409);
    s.cancelled = true;
    if (s.child) killTree(s.child);
    log(s, 'Cancelling…');
    return { cancelling: true };
  },

  /** On shutdown: stop a running build. */
  stopAll() {
    for (const s of sessions.values()) {
      s.cancelled = true;
      if (s.child) killTree(s.child);
    }
  },
};
