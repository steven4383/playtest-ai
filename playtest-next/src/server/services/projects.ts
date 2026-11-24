import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config';
import { db, newId } from '../db';
import { parseServiceAccount } from '../automation/play-publisher';

/**
 * Projects you maintain: each has parts (a Flutter app, a web panel, a backend …), Google Play settings for its
 * mobile app, and your own notes, requirements, tasks, bugs and ideas.
 */

const bad = (msg: string, statusCode = 400) => Object.assign(new Error(msg), { statusCode });
const now = () => new Date().toISOString();
const PKG_RE = /^[a-zA-Z][\w]*(\.[a-zA-Z_][\w]*)+$/;

export const componentKind = z.enum(['mobile', 'web', 'backend', 'other']);
export const noteKind = z.enum(['requirement', 'task', 'bug', 'idea', 'note']);
export const noteStatus = z.enum(['todo', 'doing', 'done']);
export const notePriority = z.enum(['low', 'medium', 'high']);

export const projectInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional().nullable(),
  color: z.string().regex(/^[a-z]+$/).max(20).optional().nullable(),
});
export const componentInput = z.object({
  path: z.string().trim().min(3).max(260),
  name: z.string().trim().max(80).optional(),
  kind: componentKind.optional(),
});
export const noteInput = z.object({
  kind: noteKind.default('task'),
  title: z.string().trim().min(1).max(200),
  body: z.string().max(20_000).optional().nullable(),
  status: noteStatus.optional(),
  priority: notePriority.optional(),
  component_id: z.string().regex(/^[\w-]{1,64}$/).optional().nullable(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  position: z.number().optional(),
});
export const playConfigInput = z.object({
  package_name: z.string().trim().regex(PKG_RE, 'Package name like com.company.app').max(200),
  default_track: z.string().trim().regex(/^[\w:-]{1,64}$/, 'Track like internal, alpha, beta, production').default('internal'),
  release_status: z.enum(['completed', 'draft', 'inProgress']).default('completed'),
  user_fraction: z.number().gt(0).lt(1).nullable().optional(),
  bump: z.enum(['patch', 'minor', 'major', 'build']).default('patch'),
  require_clean: z.boolean().default(true),
  git_commit: z.boolean().default(true),
  git_tag: z.boolean().default(true),
  git_push: z.boolean().default(false),
});

export interface Project {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  created_at: string;
  updated_at: string | null;
}
export interface Component {
  id: string;
  project_id: string;
  kind: z.infer<typeof componentKind>;
  name: string;
  path: string;
  framework: string | null;
  package_name: string | null;
  repo_url: string | null;
  created_at: string;
}
export interface PlayConfig {
  component_id: string;
  package_name: string;
  service_account_file: string | null;
  service_account_email: string | null;
  default_track: string;
  release_status: 'completed' | 'draft' | 'inProgress';
  user_fraction: number | null;
  bump: 'patch' | 'minor' | 'major' | 'build';
  require_clean: number;
  git_commit: number;
  git_tag: number;
  git_push: number;
  updated_at: string;
}
export interface Note {
  id: string;
  project_id: string;
  component_id: string | null;
  kind: z.infer<typeof noteKind>;
  title: string;
  body: string | null;
  status: z.infer<typeof noteStatus>;
  priority: z.infer<typeof notePriority>;
  due_date: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------- folder detection

const readText = (p: string, max = 400_000) => {
  try {
    return fs.readFileSync(p, 'utf8').slice(0, max);
  } catch {
    return '';
  }
};

/** Flutter version line: version: 1.2.3+45 */
export function readPubspecVersion(dir: string): { name: string | null; version: string | null } {
  const t = readText(path.join(dir, 'pubspec.yaml'));
  return { name: t.match(/^name:\s*([\w-]+)/m)?.[1] ?? null, version: t.match(/^version:\s*([^\s#]+)/m)?.[1] ?? null };
}

function androidAppId(dir: string): string | null {
  for (const f of ['android/app/build.gradle.kts', 'android/app/build.gradle', 'app/build.gradle.kts', 'app/build.gradle']) {
    const t = readText(path.join(dir, f));
    const id = t.match(/applicationId\s*=?\s*["']([\w.]+)["']/)?.[1];
    if (id) return id;
  }
  return null;
}

/** What kind of project is in this folder (Flutter app, Android app, Next.js/React web, Node backend …). */
export function detectFolder(dir: string) {
  const has = (f: string) => fs.existsSync(path.join(dir, f));
  if (has('pubspec.yaml')) {
    const p = readText(path.join(dir, 'pubspec.yaml'));
    if (/sdk:\s*flutter/.test(p)) {
      const v = readPubspecVersion(dir);
      return { kind: 'mobile' as const, framework: 'flutter', name: v.name, package_name: androidAppId(dir), version: v.version };
    }
    return { kind: 'other' as const, framework: 'dart', name: readPubspecVersion(dir).name, package_name: null, version: readPubspecVersion(dir).version };
  }
  if (has('android/app/build.gradle') || has('android/app/build.gradle.kts') || has('app/build.gradle') || has('app/build.gradle.kts'))
    return { kind: 'mobile' as const, framework: 'android', name: path.basename(dir), package_name: androidAppId(dir), version: null };
  if (has('package.json')) {
    let pkg: { name?: string; version?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
    try {
      pkg = JSON.parse(readText(path.join(dir, 'package.json')));
    } catch {
      /* unreadable */
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const framework = deps.next ? 'nextjs' : deps['react-native'] ? 'react-native' : deps.expo ? 'expo' : deps.vite || deps.react ? 'react' : deps['@nestjs/core'] ? 'nestjs' : deps.fastify ? 'fastify' : deps.express ? 'express' : 'node';
    const kind = ['react-native', 'expo'].includes(framework) ? 'mobile' : ['nestjs', 'fastify', 'express', 'node'].includes(framework) ? 'backend' : 'web';
    return { kind: kind as 'mobile' | 'web' | 'backend', framework, name: pkg.name ?? path.basename(dir), package_name: null, version: pkg.version ?? null };
  }
  return { kind: 'other' as const, framework: null, name: path.basename(dir), package_name: null, version: null };
}

function assertFolder(input: string): string {
  const raw = input.trim();
  if (!path.isAbsolute(raw)) throw bad('Use a full folder path, e.g. M:\\projects\\my_app');
  if (/[\0\r\n"<>|]/.test(raw)) throw bad('Invalid characters in the folder path');
  const dir = path.resolve(raw.replace(/[\\/]pubspec\.yaml$/i, ''));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw bad(`Folder not found: ${dir}`);
  return dir;
}

// ---------------------------------------------------------------- repository

const secretsDir = () => {
  const d = path.join(config.STORAGE_DIR, 'secrets');
  fs.mkdirSync(d, { recursive: true });
  return d;
};

export const projectRepo = {
  list(): (Project & { components: number; open_notes: number; last_release: string | null })[] {
    return db
      .prepare(
        `SELECT p.*,
           (SELECT COUNT(*) FROM project_components c WHERE c.project_id = p.id) AS components,
           (SELECT COUNT(*) FROM project_notes n WHERE n.project_id = p.id AND n.status != 'done') AS open_notes,
           (SELECT MAX(r.started_at) FROM releases r JOIN project_components c ON c.id = r.component_id WHERE c.project_id = p.id) AS last_release
         FROM projects p ORDER BY COALESCE(p.updated_at, p.created_at) DESC`,
      )
      .all() as never;
  },
  get(id: string): Project | null {
    return (db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as Project) ?? null;
  },
  create(input: z.infer<typeof projectInput>): Project {
    const id = newId('prj');
    db.prepare('INSERT INTO projects (id, name, description, color, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(
      id,
      input.name,
      input.description ?? null,
      input.color ?? null,
      now(),
      now(),
    );
    return this.get(id)!;
  },
  update(id: string, patch: Partial<z.infer<typeof projectInput>>): Project {
    const cur = this.get(id);
    if (!cur) throw bad('Project not found', 404);
    db.prepare('UPDATE projects SET name = ?, description = ?, color = ?, updated_at = ? WHERE id = ?').run(
      patch.name ?? cur.name,
      patch.description === undefined ? cur.description : patch.description,
      patch.color === undefined ? cur.color : patch.color,
      now(),
      id,
    );
    return this.get(id)!;
  },
  /** Removes the project from PlayTest (its parts, Play settings, release history and notes) — never your files. */
  remove(id: string) {
    for (const c of this.components(id)) this.removeComponent(c.id);
    db.prepare('UPDATE apk_builds SET project_id = NULL WHERE project_id = ?').run(id);
    if (!db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes) throw bad('Project not found', 404);
    return { deleted: id };
  },
  touch(id: string) {
    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now(), id);
  },

  // ---- parts
  components(projectId: string): Component[] {
    return db.prepare('SELECT * FROM project_components WHERE project_id = ? ORDER BY created_at').all(projectId) as unknown as Component[];
  },
  component(id: string): Component | null {
    return (db.prepare('SELECT * FROM project_components WHERE id = ?').get(id) as unknown as Component) ?? null;
  },
  addComponent(projectId: string, input: z.infer<typeof componentInput>, repoUrl?: string | null): Component {
    if (!this.get(projectId)) throw bad('Project not found', 404);
    const dir = assertFolder(input.path);
    if (db.prepare('SELECT 1 FROM project_components WHERE project_id = ? AND lower(path) = lower(?)').get(projectId, dir)) throw bad('This folder is already part of the project', 409);
    const d = detectFolder(dir);
    const id = newId('cmp');
    db.prepare('INSERT INTO project_components (id, project_id, kind, name, path, framework, package_name, repo_url, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(
      id,
      projectId,
      input.kind ?? d.kind,
      input.name || d.name || path.basename(dir),
      dir,
      d.framework,
      d.package_name,
      repoUrl ?? null,
      now(),
    );
    this.touch(projectId);
    return this.component(id)!;
  },
  updateComponent(id: string, patch: { name?: string; kind?: Component['kind'] }): Component {
    const c = this.component(id);
    if (!c) throw bad('Project part not found', 404);
    db.prepare('UPDATE project_components SET name = ?, kind = ? WHERE id = ?').run(patch.name ?? c.name, patch.kind ?? c.kind, id);
    return this.component(id)!;
  },
  removeComponent(id: string) {
    const cfg = this.playConfig(id);
    if (cfg?.service_account_file) fs.rmSync(cfg.service_account_file, { force: true });
    fs.rmSync(path.join(config.STORAGE_DIR, 'releases', id), { recursive: true, force: true });
    db.prepare('DELETE FROM project_components WHERE id = ?').run(id);
    return { deleted: id };
  },

  // ---- Google Play settings
  playConfig(componentId: string): PlayConfig | null {
    return (db.prepare('SELECT * FROM play_configs WHERE component_id = ?').get(componentId) as unknown as PlayConfig) ?? null;
  },
  /** Settings as shown to the dashboard: no key file path, only which account is used. */
  publicPlayConfig(componentId: string) {
    const c = this.playConfig(componentId);
    if (!c) return null;
    const { service_account_file, ...rest } = c;
    return { ...rest, has_service_account: !!service_account_file && fs.existsSync(service_account_file) };
  },
  savePlayConfig(componentId: string, input: z.infer<typeof playConfigInput>) {
    if (!this.component(componentId)) throw bad('Project part not found', 404);
    const cur = this.playConfig(componentId);
    db.prepare(
      `INSERT INTO play_configs (component_id, package_name, service_account_file, service_account_email, default_track, release_status, user_fraction, bump, require_clean, git_commit, git_tag, git_push, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(component_id) DO UPDATE SET package_name = excluded.package_name, default_track = excluded.default_track,
         release_status = excluded.release_status, user_fraction = excluded.user_fraction, bump = excluded.bump,
         require_clean = excluded.require_clean, git_commit = excluded.git_commit, git_tag = excluded.git_tag, git_push = excluded.git_push,
         updated_at = excluded.updated_at`,
    ).run(
      componentId,
      input.package_name,
      cur?.service_account_file ?? null,
      cur?.service_account_email ?? null,
      input.default_track,
      input.release_status,
      input.release_status === 'inProgress' ? (input.user_fraction ?? 0.1) : null,
      input.bump,
      input.require_clean ? 1 : 0,
      input.git_commit ? 1 : 0,
      input.git_tag ? 1 : 0,
      input.git_push ? 1 : 0,
      now(),
    );
    return this.publicPlayConfig(componentId);
  },
  /** Store the service-account key (validated) in storage/secrets, readable only by PlayTest's API. */
  saveServiceAccount(componentId: string, text: string) {
    const cfg = this.playConfig(componentId);
    if (!cfg) throw bad('Save the Play settings (package name) first', 409);
    const sa = parseServiceAccount(text);
    const file = path.join(secretsDir(), `play-${componentId}.json`);
    fs.writeFileSync(file, text, { mode: 0o600 });
    db.prepare('UPDATE play_configs SET service_account_file = ?, service_account_email = ?, updated_at = ? WHERE component_id = ?').run(file, sa.client_email, now(), componentId);
    return this.publicPlayConfig(componentId);
  },

  // ---- notes, requirements, tasks, bugs, ideas
  notes(projectId: string): Note[] {
    return db.prepare('SELECT * FROM project_notes WHERE project_id = ? ORDER BY status, position, updated_at DESC').all(projectId) as unknown as Note[];
  },
  addNote(projectId: string, input: z.infer<typeof noteInput>): Note {
    if (!this.get(projectId)) throw bad('Project not found', 404);
    if (input.component_id && this.component(input.component_id)?.project_id !== projectId) throw bad('That part belongs to another project');
    const id = newId('note');
    const pos = (db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM project_notes WHERE project_id = ?').get(projectId) as { p: number }).p;
    db.prepare(
      'INSERT INTO project_notes (id, project_id, component_id, kind, title, body, status, priority, due_date, position, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(id, projectId, input.component_id ?? null, input.kind, input.title, input.body ?? null, input.status ?? 'todo', input.priority ?? 'medium', input.due_date ?? null, input.position ?? pos, now(), now());
    this.touch(projectId);
    return db.prepare('SELECT * FROM project_notes WHERE id = ?').get(id) as unknown as Note;
  },
  updateNote(id: string, patch: Partial<z.infer<typeof noteInput>>): Note {
    const cur = db.prepare('SELECT * FROM project_notes WHERE id = ?').get(id) as unknown as Note | undefined;
    if (!cur) throw bad('Note not found', 404);
    const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Note;
    db.prepare('UPDATE project_notes SET kind = ?, title = ?, body = ?, status = ?, priority = ?, component_id = ?, due_date = ?, position = ?, updated_at = ? WHERE id = ?').run(
      next.kind,
      next.title,
      next.body,
      next.status,
      next.priority,
      next.component_id,
      next.due_date,
      next.position,
      now(),
      id,
    );
    this.touch(cur.project_id);
    return db.prepare('SELECT * FROM project_notes WHERE id = ?').get(id) as unknown as Note;
  },
  removeNote(id: string) {
    if (!db.prepare('DELETE FROM project_notes WHERE id = ?').run(id).changes) throw bad('Note not found', 404);
    return { deleted: id };
  },
};
