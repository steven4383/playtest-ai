import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { config } from '../config';
import { db, newId } from '../db';

/**
 * Personal space backdrops: your own character art / wallpapers, shown as the cinematic hero of the Chronicle.
 * Files stay on this PC in storage/personal/backdrops (never sent anywhere).
 */

const bad = (msg: string, statusCode = 400) => Object.assign(new Error(msg), { statusCode });
const MAX_BYTES = 25 * 1024 * 1024;
const dir = () => {
  const d = path.join(config.STORAGE_DIR, 'personal', 'backdrops');
  fs.mkdirSync(d, { recursive: true });
  return d;
};

export interface Backdrop {
  id: string;
  name: string;
  file: string;
  mime: string;
  accent: string | null;
  focus_x: number;
  focus_y: number;
  active: number;
  created_at: string;
}

export const backdropPatch = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  accent: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  focus_x: z.number().int().min(0).max(100).optional(),
  focus_y: z.number().int().min(0).max(100).optional(),
  active: z.literal(true).optional(),
});

/** Image type from the first bytes (not the file name): PNG, JPEG, WebP, GIF. */
function sniff(b: Buffer): { ext: string; mime: string } | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', mime: 'image/png' };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('ascii', 0, 6))) return { ext: 'gif', mime: 'image/gif' };
  return null;
}

const pub = ({ file, ...b }: Backdrop) => ({ ...b, active: !!b.active });

export const backdrops = {
  list() {
    return (db.prepare('SELECT * FROM personal_backdrops ORDER BY created_at').all() as unknown as Backdrop[]).map(pub);
  },

  get(id: string): Backdrop | null {
    return (db.prepare('SELECT * FROM personal_backdrops WHERE id = ?').get(id) as unknown as Backdrop) ?? null;
  },

  /** Store an uploaded image (max 25 MB, PNG/JPEG/WebP/GIF checked by content). The first one becomes active. */
  async add(filename: string, stream: Readable) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of stream) {
      size += (c as Buffer).length;
      if (size > MAX_BYTES) {
        stream.destroy();
        throw bad('Image is larger than 25 MB', 413);
      }
      chunks.push(c as Buffer);
    }
    const buf = Buffer.concat(chunks);
    const kind = sniff(buf);
    if (!kind) throw bad('Not an image — use PNG, JPEG, WebP or GIF', 415);
    const id = newId('bd');
    const file = `${id}.${kind.ext}`;
    fs.writeFileSync(path.join(dir(), file), buf);
    const name = (path.parse(filename).name || 'Backdrop').replace(/[_-]+/g, ' ').trim().slice(0, 60) || 'Backdrop';
    const first = !db.prepare('SELECT 1 FROM personal_backdrops WHERE active = 1').get();
    db.prepare('INSERT INTO personal_backdrops (id, name, file, mime, active, created_at) VALUES (?,?,?,?,?,?)').run(id, name, file, kind.mime, first ? 1 : 0, new Date().toISOString());
    return pub(this.get(id)!);
  },

  update(id: string, patch: z.infer<typeof backdropPatch>) {
    const cur = this.get(id);
    if (!cur) throw bad('Backdrop not found', 404);
    if (patch.active) db.prepare('UPDATE personal_backdrops SET active = (id = ?)').run(id);
    db.prepare('UPDATE personal_backdrops SET name = ?, accent = ?, focus_x = ?, focus_y = ? WHERE id = ?').run(
      patch.name ?? cur.name,
      patch.accent === undefined ? cur.accent : patch.accent,
      patch.focus_x ?? cur.focus_x,
      patch.focus_y ?? cur.focus_y,
      id,
    );
    return pub(this.get(id)!);
  },

  remove(id: string) {
    const cur = this.get(id);
    if (!cur) throw bad('Backdrop not found', 404);
    db.prepare('DELETE FROM personal_backdrops WHERE id = ?').run(id);
    fs.rm(path.join(dir(), cur.file), { force: true }, () => {});
    if (cur.active) db.prepare('UPDATE personal_backdrops SET active = 1 WHERE id = (SELECT id FROM personal_backdrops ORDER BY created_at LIMIT 1)').run();
    return { deleted: id };
  },

  /** Absolute path of the image file (the stored name is ours, never user input). */
  file(id: string) {
    const cur = this.get(id);
    if (!cur) throw bad('Backdrop not found', 404);
    return { path: path.join(dir(), cur.file), mime: cur.mime };
  },
};
