import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import { db, newId } from '../db/index.js';

export const deviceInput = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['emulator', 'physical', 'remote']).default('emulator'),
  android_version: z.string().max(20).nullish(),
  api_level: z.number().int().min(16).max(40).nullish(),
  avd_name: z.string().regex(/^[\w.-]+$/, 'letters, digits, _ . - only').nullish(),
  adb_serial: z.string().regex(/^[\w.:-]+$/).nullish(),
  resolution: z.string().regex(/^\d+x\d+$/).nullish(),
  ram_mb: z.number().int().min(1024).max(16384).nullish(),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(1).max(1000).default(100),
});
export const devicePatch = deviceInput.partial();
export type DeviceInput = z.infer<typeof deviceInput>;
type DevicePreset = z.input<typeof deviceInput>;

export interface DeviceRow {
  id: string;
  name: string;
  type: 'emulator' | 'physical' | 'remote';
  android_version: string | null;
  api_level: number | null;
  avd_name: string | null;
  adb_serial: string | null;
  resolution: string | null;
  ram_mb: number | null;
  enabled: boolean;
  priority: number;
  status: string;
  last_health_check: string | null;
  last_execution: string | null;
  last_error: string | null;
  created_at: string;
}

const MAX_PROFILES = 50;
const COLUMNS = ['name', 'type', 'android_version', 'api_level', 'avd_name', 'adb_serial', 'resolution', 'ram_mb', 'enabled', 'priority'] as const;

function toRow(r: any): DeviceRow {
  return { ...r, enabled: !!r.enabled };
}

const toDb = (v: unknown) => (typeof v === 'boolean' ? (v ? 1 : 0) : (v ?? null));

export const deviceRepo = {
  list(): DeviceRow[] {
    return (db.prepare('SELECT * FROM devices ORDER BY priority ASC, created_at ASC').all() as any[]).map(toRow);
  },

  get(id: string): DeviceRow | null {
    const r = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
    return r ? toRow(r) : null;
  },

  create(input: DeviceInput): DeviceRow {
    const count = (db.prepare('SELECT COUNT(*) AS n FROM devices').get() as { n: number }).n;
    if (count >= MAX_PROFILES) throw Object.assign(new Error(`Profile limit (${MAX_PROFILES}) reached`), { statusCode: 409 });
    const id = newId('dev');
    db.prepare(
      `INSERT INTO devices (id, ${COLUMNS.join(', ')}) VALUES (?, ${COLUMNS.map(() => '?').join(', ')})`,
    ).run(id, ...COLUMNS.map((c) => toDb(input[c])) as any[]);
    return this.get(id)!;
  },

  update(id: string, patch: Partial<DeviceInput>): DeviceRow | null {
    const keys = COLUMNS.filter((c) => c in patch);
    if (keys.length) {
      db.prepare(`UPDATE devices SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
        ...(keys.map((k) => toDb(patch[k])) as any[]),
        id,
      );
    }
    return this.get(id);
  },

  setStatus(id: string, fields: Partial<Pick<DeviceRow, 'status' | 'last_error' | 'last_health_check' | 'adb_serial' | 'android_version' | 'api_level' | 'resolution'>>) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    db.prepare(`UPDATE devices SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
      ...(keys.map((k) => (fields[k] ?? null) as any)),
      id,
    );
  },

  /** Also removes this device's test executions (their files live under storage/executions/<id>). */
  remove(id: string): boolean {
    const execs = db.prepare('SELECT id FROM executions WHERE device_id = ?').all(id) as { id: string }[];
    for (const e of execs) fs.rmSync(path.join(config.STORAGE_DIR, 'executions', e.id), { recursive: true, force: true });
    db.prepare('DELETE FROM executions WHERE device_id = ?').run(id);
    return db.prepare('DELETE FROM devices WHERE id = ?').run(id).changes > 0;
  },

  /** 12 starter profiles from the architecture doc (section 5.3). Only inserted when the table is empty. */
  seedDefaults(): number {
    const count = (db.prepare('SELECT COUNT(*) AS n FROM devices').get() as { n: number }).n;
    if (count > 0) return 0;
    const presets: DevicePreset[] = [
      { name: 'Pixel 8 API 35', android_version: '15', api_level: 35, avd_name: 'PT_Pixel_8_API_35', resolution: '1080x2400', priority: 1 },
      { name: 'Pixel 7 API 34', android_version: '14', api_level: 34, avd_name: 'PT_Pixel_7_API_34', resolution: '1080x2400', priority: 2 },
      { name: 'Pixel 6 API 33', android_version: '13', api_level: 33, avd_name: 'PT_Pixel_6_API_33', resolution: '1080x2400', priority: 3 },
      { name: 'Pixel 5 API 31', android_version: '12', api_level: 31, avd_name: 'PT_Pixel_5_API_31', resolution: '1080x2340', priority: 4 },
      { name: 'Pixel 4a API 30', android_version: '11', api_level: 30, avd_name: 'PT_Pixel_4a_API_30', resolution: '1080x2340', priority: 5 },
      { name: 'Pixel 3 API 29', android_version: '10', api_level: 29, avd_name: 'PT_Pixel_3_API_29', resolution: '1080x2160', priority: 6 },
      { name: 'Nexus 5X API 28', android_version: '9', api_level: 28, avd_name: 'PT_Nexus_5X_API_28', resolution: '1080x1920', priority: 7 },
      { name: 'Small phone API 26', android_version: '8.0', api_level: 26, avd_name: 'PT_Small_API_26', resolution: '720x1280', ram_mb: 1536, priority: 8 },
      { name: 'Low-end API 24', android_version: '7.0', api_level: 24, avd_name: 'PT_LowEnd_API_24', resolution: '480x854', ram_mb: 1536, priority: 9 },
      { name: 'Pixel Tablet API 34', android_version: '14', api_level: 34, avd_name: 'PT_Tablet_API_34', resolution: '2560x1600', priority: 10 },
      { name: 'Pixel Fold API 34', android_version: '14', api_level: 34, avd_name: 'PT_Fold_API_34', resolution: '2208x1840', priority: 11 },
      { name: 'Medium tablet API 30', android_version: '11', api_level: 30, avd_name: 'PT_Tablet_API_30', resolution: '1600x2560', priority: 12 },
    ];
    for (const p of presets) this.create(deviceInput.parse({ ...p, type: 'emulator', enabled: p.priority! <= 4 }));
    return presets.length;
  },
};
