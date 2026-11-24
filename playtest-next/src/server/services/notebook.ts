import { z } from 'zod';
import { db, newId } from '../db';

/**
 * Notebook: free notes and quick captures (ideas, commands, links, meeting notes) — optionally linked to a project.
 * Project requirements/tasks live in project_notes; this is the personal notepad around them.
 */

const bad = (msg: string, statusCode = 400) => Object.assign(new Error(msg), { statusCode });
const now = () => new Date().toISOString();

export const notebookInput = z.object({
  title: z.string().max(200).optional(),
  body: z.string().max(100_000).optional(),
  pinned: z.boolean().optional(),
  color: z.string().regex(/^[a-z]+$/).max(20).nullable().optional(),
  project_id: z.string().regex(/^[\w-]{1,64}$/).nullable().optional(),
});

export interface NotebookEntry {
  id: string;
  title: string;
  body: string;
  pinned: number;
  color: string | null;
  project_id: string | null;
  project_name?: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT = 'SELECT n.*, p.name AS project_name FROM notebook n LEFT JOIN projects p ON p.id = n.project_id';

export const notebook = {
  list(opts: { q?: string; project?: string }): NotebookEntry[] {
    const where: string[] = [];
    const args: string[] = [];
    if (opts.q) {
      where.push("(n.title LIKE ? ESCAPE '\\' OR n.body LIKE ? ESCAPE '\\')");
      const like = `%${opts.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      args.push(like, like);
    }
    if (opts.project) {
      where.push('n.project_id = ?');
      args.push(opts.project);
    }
    return db.prepare(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY n.pinned DESC, n.updated_at DESC LIMIT 500`).all(...args) as unknown as NotebookEntry[];
  },
  get(id: string): NotebookEntry | null {
    return (db.prepare(`${SELECT} WHERE n.id = ?`).get(id) as unknown as NotebookEntry) ?? null;
  },
  create(input: z.infer<typeof notebookInput>): NotebookEntry {
    if (input.project_id && !db.prepare('SELECT 1 FROM projects WHERE id = ?').get(input.project_id)) throw bad('Project not found', 404);
    const id = newId('nb');
    db.prepare('INSERT INTO notebook (id, title, body, pinned, color, project_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').run(
      id,
      input.title ?? '',
      input.body ?? '',
      input.pinned ? 1 : 0,
      input.color ?? null,
      input.project_id ?? null,
      now(),
      now(),
    );
    return this.get(id)!;
  },
  update(id: string, patch: z.infer<typeof notebookInput>): NotebookEntry {
    const cur = this.get(id);
    if (!cur) throw bad('Note not found', 404);
    if (patch.project_id && !db.prepare('SELECT 1 FROM projects WHERE id = ?').get(patch.project_id)) throw bad('Project not found', 404);
    db.prepare('UPDATE notebook SET title = ?, body = ?, pinned = ?, color = ?, project_id = ?, updated_at = ? WHERE id = ?').run(
      patch.title ?? cur.title,
      patch.body ?? cur.body,
      patch.pinned === undefined ? cur.pinned : patch.pinned ? 1 : 0,
      patch.color === undefined ? cur.color : patch.color,
      patch.project_id === undefined ? cur.project_id : patch.project_id,
      now(),
      id,
    );
    return this.get(id)!;
  },
  remove(id: string) {
    if (!db.prepare('DELETE FROM notebook WHERE id = ?').run(id).changes) throw bad('Note not found', 404);
    return { deleted: id };
  },
};

/** Requirements, tasks, bugs and ideas of every project (for the Maintenance → Tasks overview). */
export function allProjectItems(opts: { open?: boolean }) {
  return db
    .prepare(
      `SELECT n.*, p.name AS project_name, p.color AS project_color, c.name AS component_name
       FROM project_notes n JOIN projects p ON p.id = n.project_id LEFT JOIN project_components c ON c.id = n.component_id
       WHERE n.kind != 'note' ${opts.open ? "AND n.status != 'done'" : ''}
       ORDER BY CASE n.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, COALESCE(n.due_date, '9999'), n.updated_at DESC
       LIMIT 1000`,
    )
    .all();
}
