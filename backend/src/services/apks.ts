import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import { db, newId } from '../db/index.js';
import { run, tools } from '../automation/sdk.js';

export interface ApkMetadata {
  package_name: string | null;
  version_name: string | null;
  version_code: number | null;
  min_sdk: number | null;
  target_sdk: number | null;
  metadata_source: 'aapt' | 'aapt2' | 'none';
}

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export async function extractMetadata(apkPath: string): Promise<ApkMetadata> {
  const aapt = tools.aapt();
  const empty: ApkMetadata = { package_name: null, version_name: null, version_code: null, min_sdk: null, target_sdk: null, metadata_source: 'none' };
  if (!aapt) return empty;
  const r = await run(aapt, ['dump', 'badging', apkPath], 60_000);
  if (!r.ok && !r.stdout) return empty;
  const out = r.stdout;
  const pick = (re: RegExp) => out.match(re)?.[1] ?? null;
  const num = (s: string | null) => (s && /^\d+$/.test(s) ? Number(s) : null);
  return {
    package_name: pick(/package: name='([^']+)'/),
    version_code: num(pick(/versionCode='(\d+)'/)),
    version_name: pick(/versionName='([^']*)'/),
    min_sdk: num(pick(/(?:sdkVersion|minSdkVersion):'(\d+)'/)),
    target_sdk: num(pick(/targetSdkVersion:'(\d+)'/)),
    metadata_source: path.basename(aapt).startsWith('aapt2') ? 'aapt2' : 'aapt',
  };
}

/** Stream an upload to disk outside any public folder while hashing it. */
export async function storeApk(filename: string, stream: NodeJS.ReadableStream): Promise<Record<string, any>> {
  if (!/\.apk$/i.test(filename)) throw Object.assign(new Error('Only .apk files are accepted'), { statusCode: 400 });
  const id = newId('apk');
  const dir = path.join(config.STORAGE_DIR, 'apks', id);
  fs.mkdirSync(dir, { recursive: true });
  const safeName = path.basename(filename).replace(/[^\w.-]/g, '_');
  const dest = path.join(dir, safeName);

  const hash = crypto.createHash('sha256');
  let size = 0;
  let head: Buffer | null = null;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (!head) head = chunk.subarray(0, 4);
      hash.update(chunk);
      size += chunk.length;
      cb(null, chunk);
    },
  });

  try {
    await pipeline(stream, tap, fs.createWriteStream(dest));
    if ((stream as any).truncated) throw Object.assign(new Error(`APK exceeds ${config.MAX_APK_SIZE_MB} MB limit`), { statusCode: 413 });
    if (!head || !(head as Buffer).equals(ZIP_MAGIC)) throw Object.assign(new Error('File is not a valid APK (ZIP signature missing)'), { statusCode: 400 });
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }

  const sha256 = hash.digest('hex');
  const meta = await extractMetadata(dest);
  db.prepare(
    `INSERT INTO apk_builds (id, filename, package_name, version_name, version_code, min_sdk, target_sdk, size_bytes, sha256, storage_path, metadata_source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, safeName, meta.package_name, meta.version_name, meta.version_code, meta.min_sdk, meta.target_sdk, size, sha256, dest, meta.metadata_source);

  const duplicateOf = db
    .prepare('SELECT id FROM apk_builds WHERE sha256 = ? AND id != ? ORDER BY created_at ASC LIMIT 1')
    .get(sha256, id) as { id: string } | undefined;

  return { ...getApk(id)!, duplicate_of: duplicateOf?.id ?? null };
}

export function listApks() {
  return db.prepare('SELECT id, filename, package_name, version_name, version_code, min_sdk, target_sdk, size_bytes, sha256, metadata_source, created_at FROM apk_builds ORDER BY created_at DESC').all();
}

export function getApk(id: string): Record<string, any> | undefined {
  return db.prepare('SELECT * FROM apk_builds WHERE id = ?').get(id) as Record<string, any> | undefined;
}

export function deleteApk(id: string) {
  const apk = getApk(id);
  if (!apk) return false;
  fs.rmSync(path.dirname(apk.storage_path), { recursive: true, force: true });
  db.prepare('DELETE FROM apk_builds WHERE id = ?').run(id);
  return true;
}
