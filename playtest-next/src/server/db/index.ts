import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { config } from '../config';
import { migrations } from './migrations';
import { keep } from '../core/keep';

/**
 * Uses Node's built-in SQLite (node:sqlite, Node >= 22.13) — no native
 * build tools needed on Windows. Swap for PostgreSQL later via the
 * repository layer in services/.
 */
fs.mkdirSync(path.dirname(config.DATABASE_PATH), { recursive: true });

// Loaded at runtime instead of imported: bundlers don't all know the newer node:sqlite built-in.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

/** One connection per process (kept across Next.js dev reloads). */
export const db: DatabaseSyncType = keep('db', () => {
  const conn = new DatabaseSync(config.DATABASE_PATH);
  conn.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  return conn;
});

export function migrate(): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
  );
  let count = 0;
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(m.version, m.name);
      db.exec('COMMIT');
      count++;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return count;
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
