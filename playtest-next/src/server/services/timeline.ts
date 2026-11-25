import { z } from 'zod';
import { db, newId } from '../db';

/**
 * Timeline: what you plan next and what you achieved — personal life (education, career, health, events …) and
 * project milestones (planning → development → testing → deployment → completion). Published Google Play releases
 * appear on it automatically. Achievements earn XP → level → rank (for the Quest view).
 */

const bad = (msg: string, statusCode = 400) => Object.assign(new Error(msg), { statusCode });
const now = () => new Date().toISOString();

export const PERSONAL = ['goal', 'education', 'career', 'personal', 'health', 'event'] as const;
export const PROJECT = ['planning', 'development', 'testing', 'deployment', 'completion'] as const;
export const category = z.enum([...PERSONAL, ...PROJECT]);
export const entryStatus = z.enum(['planned', 'in_progress', 'achieved', 'dropped']);

/** XP an achieved entry is worth (Quest view). */
export const XP: Record<z.infer<typeof category>, number> = {
  goal: 50, education: 80, career: 100, personal: 40, health: 40, event: 20,
  planning: 30, development: 60, testing: 50, deployment: 100, completion: 150,
};
const RELEASE_XP = 100;

export const entryInput = z.object({
  scope: z.enum(['personal', 'project']).optional(),
  project_id: z.string().regex(/^[\w-]{1,64}$/).nullable().optional(),
  category,
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).nullable().optional(),
  notes: z.string().max(20_000).nullable().optional(),
  status: entryStatus.optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  achieved_at: z.string().regex(/^\d{4}-\d{2}-\d{2}/).nullable().optional(),
});

export interface Entry {
  id: string;
  scope: 'personal' | 'project';
  project_id: string | null;
  project_name?: string | null;
  project_color?: string | null;
  category: z.infer<typeof category>;
  title: string;
  description: string | null;
  notes: string | null;
  status: z.infer<typeof entryStatus>;
  date: string | null;
  achieved_at: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT = 'SELECT e.*, p.name AS project_name, p.color AS project_color FROM timeline_entries e LEFT JOIN projects p ON p.id = e.project_id';

/** Level from XP: 50 XP for level 2, then a bit more each level. Rank E → S by level. */
export function levelOf(xp: number) {
  const level = Math.floor(Math.sqrt(xp / 50)) + 1;
  const floor = 50 * (level - 1) ** 2;
  const next = 50 * level ** 2;
  const rank = level >= 30 ? 'S' : level >= 20 ? 'A' : level >= 15 ? 'B' : level >= 10 ? 'C' : level >= 5 ? 'D' : 'E';
  return { level, rank, xp, level_xp: xp - floor, level_span: next - floor };
}

export const timeline = {
  list(opts: { scope?: 'personal' | 'project'; project?: string }) {
    const where: string[] = [];
    const args: string[] = [];
    if (opts.project) {
      where.push('e.project_id = ?');
      args.push(opts.project);
    } else if (opts.scope) {
      where.push('e.scope = ?');
      args.push(opts.scope);
    }
    const entries = db.prepare(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY COALESCE(e.achieved_at, e.date, e.created_at)`).all(...args) as unknown as Entry[];

    // Published releases are achievements too (unless only personal entries were asked for).
    const releases =
      opts.scope === 'personal'
        ? []
        : (db
            .prepare(
              `SELECT r.id, r.version_after, r.track, r.finished_at, c.name AS app, p.id AS project_id, p.name AS project_name, p.color AS project_color
               FROM releases r JOIN project_components c ON c.id = r.component_id JOIN projects p ON p.id = c.project_id
               WHERE r.mode = 'publish' AND r.status = 'succeeded' ${opts.project ? 'AND p.id = ?' : ''} ORDER BY r.finished_at`,
            )
            .all(...(opts.project ? [opts.project] : [])) as {
            id: string;
            version_after: string;
            track: string;
            finished_at: string;
            app: string;
            project_id: string;
            project_name: string;
            project_color: string | null;
          }[]);

    const achieved = entries.filter((e) => e.status === 'achieved');
    const xp = achieved.reduce((s, e) => s + XP[e.category], 0) + releases.length * RELEASE_XP;
    const today = new Date().toISOString().slice(0, 10);
    return {
      entries,
      releases,
      stats: {
        ...levelOf(xp),
        achieved: achieved.length + releases.length,
        active: entries.filter((e) => e.status === 'in_progress').length,
        upcoming: entries.filter((e) => e.status === 'planned').length,
        overdue: entries.filter((e) => (e.status === 'planned' || e.status === 'in_progress') && e.date && e.date < today).length,
        next: entries.filter((e) => (e.status === 'planned' || e.status === 'in_progress') && e.date && e.date >= today).sort((a, b) => a.date!.localeCompare(b.date!))[0] ?? null,
      },
    };
  },

  get(id: string): Entry | null {
    return (db.prepare(`${SELECT} WHERE e.id = ?`).get(id) as unknown as Entry) ?? null;
  },

  create(input: z.infer<typeof entryInput>): Entry {
    const projectId = input.project_id ?? null;
    if (projectId && !db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw bad('Project not found', 404);
    const status = input.status ?? 'planned';
    const id = newId('tl');
    db.prepare(
      'INSERT INTO timeline_entries (id, scope, project_id, category, title, description, notes, status, date, achieved_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      id,
      projectId ? 'project' : (input.scope ?? 'personal'),
      projectId,
      input.category,
      input.title,
      input.description ?? null,
      input.notes ?? null,
      status,
      input.date ?? null,
      status === 'achieved' ? (input.achieved_at ?? now()) : null,
      now(),
      now(),
    );
    return this.get(id)!;
  },

  /** Returns the entry and the XP / level before and after (so the view can celebrate a level-up). */
  update(id: string, patch: Partial<z.infer<typeof entryInput>>) {
    const cur = this.get(id);
    if (!cur) throw bad('Timeline entry not found', 404);
    const status = patch.status ?? cur.status;
    const achievedAt = status === 'achieved' ? (patch.achieved_at ?? cur.achieved_at ?? now()) : null;
    const projectId = patch.project_id === undefined ? cur.project_id : patch.project_id;
    if (projectId && !db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw bad('Project not found', 404);
    // Level-up is judged in the entry's own space: personal goals and projects keep separate levels.
    const space = { scope: (projectId ? 'project' : (patch.scope ?? cur.scope)) as 'personal' | 'project' };
    const before = this.list(space).stats;
    db.prepare(
      'UPDATE timeline_entries SET scope = ?, project_id = ?, category = ?, title = ?, description = ?, notes = ?, status = ?, date = ?, achieved_at = ?, updated_at = ? WHERE id = ?',
    ).run(
      projectId ? 'project' : (patch.scope ?? cur.scope),
      projectId,
      patch.category ?? cur.category,
      patch.title ?? cur.title,
      patch.description === undefined ? cur.description : patch.description,
      patch.notes === undefined ? cur.notes : patch.notes,
      status,
      patch.date === undefined ? cur.date : patch.date,
      achievedAt,
      now(),
      id,
    );
    const after = this.list(space).stats;
    return { entry: this.get(id)!, level_before: before.level, level_after: after.level, xp_gained: after.xp - before.xp, rank: after.rank };
  },

  remove(id: string) {
    if (!db.prepare('DELETE FROM timeline_entries WHERE id = ?').run(id).changes) throw bad('Timeline entry not found', 404);
    return { deleted: id };
  },
};
