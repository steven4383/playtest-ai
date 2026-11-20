// Import data from the old Fastify backend (../backend) into this Next.js app:
// database (consistent snapshot via VACUUM INTO), the storage folder (APKs, screenshots, logs, recordings) and the
// absolute file paths stored in the database, which pointed into backend/storage.
//
//   node scripts/import-from-backend.mjs               copy db + storage, then fix paths (refuses to overwrite)
//   node scripts/import-from-backend.mjs --force       replace this app's db + storage with a fresh copy
//   node scripts/import-from-backend.mjs --paths-only  only rewrite paths in this app's db
//
// Stop both apps first when copying (the old backend may be writing).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const oldRoot = path.resolve(here, '..', 'backend');
const args = new Set(process.argv.slice(2));
const oldDb = path.join(oldRoot, 'playtest_ai.db');
const newDb = path.join(here, 'playtest_ai.db');
const oldStorage = path.join(oldRoot, 'storage');
// Upper-case drive letter, the form Windows and Node use for C:\ paths.
const newStorage = path.join(here, 'storage').replace(/^[a-z]:/, (d) => d.toUpperCase());

if (!args.has('--paths-only')) {
  if (!fs.existsSync(oldDb)) throw new Error(`No database at ${oldDb}`);
  if ((fs.existsSync(newDb) || fs.existsSync(newStorage)) && !args.has('--force'))
    throw new Error('This app already has data (playtest_ai.db / storage). Use --force to replace it, or --paths-only.');
  for (const f of [newDb, `${newDb}-wal`, `${newDb}-shm`]) fs.rmSync(f, { force: true });
  new DatabaseSync(oldDb, { readOnly: true }).exec(`VACUUM INTO '${newDb.replace(/'/g, "''")}'`);
  fs.rmSync(newStorage, { recursive: true, force: true });
  if (fs.existsSync(oldStorage)) fs.cpSync(oldStorage, newStorage, { recursive: true });
  console.log(`Copied database and storage from ${oldRoot}`);
}

// Rewrite every text value that starts with the old storage folder (both slash styles).
const db = new DatabaseSync(newDb);
// Old storage (both slash styles), plus this app's own storage in any letter case (normalised to one form).
const prefixes = [oldStorage, oldStorage.replace(/\\/g, '/'), newStorage];
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
let changed = 0;
db.exec('BEGIN');
try {
  for (const { name } of tables) {
    const cols = db.prepare(`PRAGMA table_info("${name}")`).all().filter((c) => /TEXT|^$/i.test(c.type));
    for (const { name: col } of cols) {
      for (const from of prefixes) {
        const to = from.includes('/') ? newStorage.replace(/\\/g, '/') : newStorage;
        // Windows paths are case-insensitive (C:\ vs c:\), so compare the prefix without case.
        const r = db
          .prepare(
            `UPDATE "${name}" SET "${col}" = ? || substr("${col}", ?) WHERE lower(substr("${col}", 1, ?)) = lower(?) AND substr("${col}", 1, ?) <> ?`,
          )
          .run(to, from.length + 1, from.length, from, to.length, to);
        if (r.changes) console.log(`  ${name}.${col}: ${r.changes} path(s)`);
        changed += Number(r.changes);
      }
    }
  }
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}
console.log(`Rewrote ${changed} stored path(s) to ${newStorage}`);
