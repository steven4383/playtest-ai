import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config';
import { db, newId } from '../db/index';

/** A campaign = one APK × N devices, run with a chosen concurrency and test flow. */
export const campaignInput = z.object({
  name: z.string().trim().max(100).optional(),
  apk_id: z.string().min(1),
  device_ids: z.array(z.string().min(1)).min(1, 'Pick at least one device').max(50),
  /** sequential = one device at a time; parallel = up to `concurrency` devices at once */
  mode: z.enum(['sequential', 'parallel']).default('sequential'),
  concurrency: z.number().int().min(1).max(10).default(2),
  /** open_close: install → open app → wait → check it is running / did not crash → screenshot → close */
  flow: z.literal('open_close').default('open_close'),
  launch_wait_seconds: z.number().int().min(2).max(120).default(8),
  cycles: z.number().int().min(1).max(10).default(1),
  fresh_install: z.boolean().default(false),
  uninstall_after: z.boolean().default(false),
  stop_emulators_after: z.boolean().default(true),
});
export type CampaignConfig = z.infer<typeof campaignInput>;

export type CampaignStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'CANCELLED' | 'INTERRUPTED';
export type ExecutionStatus = 'queued' | 'running' | 'passed' | 'failed' | 'error' | 'skipped' | 'cancelled';
export type StepStatus = 'running' | 'passed' | 'failed' | 'skipped' | 'error';

export interface Summary {
  total: number;
  passed: number;
  failed: number;
  error: number;
  skipped: number;
  cancelled: number;
  running: number;
  queued: number;
}

const json = <T>(s: string | null): T | null => {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
};

export const executionsDir = (executionId: string) => path.join(config.STORAGE_DIR, 'executions', executionId);

export const campaignRepo = {
  create(cfg: CampaignConfig, apk: { id: string; package_name: string; filename: string }, devices: { id: string; name: string }[]) {
    const id = newId('cmp');
    const name = cfg.name || `${apk.package_name} · ${devices.length} device${devices.length === 1 ? '' : 's'}`;
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO campaigns (id, apk_id, name, status, config) VALUES (?, ?, ?, ?, ?)').run(id, apk.id, name, 'QUEUED', JSON.stringify(cfg));
      const ins = db.prepare('INSERT INTO executions (id, campaign_id, device_id, device_name, status) VALUES (?, ?, ?, ?, ?)');
      for (const d of devices) ins.run(newId('exe'), id, d.id, d.name, 'queued');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    this.refreshSummary(id);
    return this.get(id)!;
  },

  list() {
    const rows = db
      .prepare(
        `SELECT c.id, c.name, c.status, c.created_at, c.started_at, c.completed_at, c.config, c.summary,
                a.package_name, a.version_name, a.filename
         FROM campaigns c LEFT JOIN apk_builds a ON a.id = c.apk_id
         ORDER BY c.created_at DESC LIMIT 100`,
      )
      .all() as any[];
    return rows.map((r) => ({ ...r, config: json<CampaignConfig>(r.config), summary: json<Summary>(r.summary) }));
  },

  get(id: string) {
    const c = db
      .prepare(
        `SELECT c.*, a.package_name, a.version_name, a.filename, a.min_sdk
         FROM campaigns c LEFT JOIN apk_builds a ON a.id = c.apk_id WHERE c.id = ?`,
      )
      .get(id) as any;
    if (!c) return null;
    const executions = (db.prepare('SELECT * FROM executions WHERE campaign_id = ? ORDER BY rowid').all(id) as any[]).map((e) => ({
      ...e,
      metrics: json<Record<string, unknown>>(e.metrics),
      steps: db.prepare('SELECT id, step_number, name, status, actual_result, duration_ms, started_at FROM execution_steps WHERE execution_id = ? ORDER BY step_number').all(e.id),
      artifacts: db.prepare('SELECT id, type, created_at FROM artifacts WHERE execution_id = ? ORDER BY created_at').all(e.id),
    }));
    return { ...c, config: json<CampaignConfig>(c.config), summary: json<Summary>(c.summary), executions };
  },

  setStatus(id: string, status: CampaignStatus, fields: { started_at?: string; completed_at?: string } = {}) {
    db.prepare('UPDATE campaigns SET status = ?, started_at = COALESCE(?, started_at), completed_at = COALESCE(?, completed_at) WHERE id = ?').run(
      status,
      fields.started_at ?? null,
      fields.completed_at ?? null,
      id,
    );
  },

  refreshSummary(id: string): Summary {
    const rows = db.prepare('SELECT status, COUNT(*) AS n FROM executions WHERE campaign_id = ? GROUP BY status').all(id) as { status: ExecutionStatus; n: number }[];
    const s: Summary = { total: 0, passed: 0, failed: 0, error: 0, skipped: 0, cancelled: 0, running: 0, queued: 0 };
    for (const r of rows) {
      s[r.status] = r.n;
      s.total += r.n;
    }
    db.prepare('UPDATE campaigns SET summary = ? WHERE id = ?').run(JSON.stringify(s), id);
    return s;
  },

  queuedExecutions(campaignId: string) {
    return db.prepare("SELECT id, device_id, device_name FROM executions WHERE campaign_id = ? AND status = 'queued' ORDER BY rowid").all(campaignId) as {
      id: string;
      device_id: string;
      device_name: string;
    }[];
  },

  updateExecution(id: string, f: { status?: ExecutionStatus; started_at?: string; completed_at?: string; error_summary?: string | null; serial?: string; metrics?: object }) {
    const sets: string[] = [];
    const vals: (string | null)[] = [];
    for (const [k, v] of Object.entries(f)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      vals.push(k === 'metrics' ? JSON.stringify(v) : (v as string | null));
    }
    if (sets.length) db.prepare(`UPDATE executions SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  },

  startStep(executionId: string, stepNumber: number, name: string) {
    const id = newId('stp');
    db.prepare('INSERT INTO execution_steps (id, execution_id, step_number, name, status, started_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      executionId,
      stepNumber,
      name,
      'running',
      new Date().toISOString(),
    );
    return id;
  },

  finishStep(stepId: string, status: StepStatus, actual: string | null, durationMs: number) {
    db.prepare('UPDATE execution_steps SET status = ?, actual_result = ?, duration_ms = ? WHERE id = ?').run(status, actual?.slice(0, 4000) ?? null, durationMs, stepId);
  },

  addArtifact(executionId: string, type: string, filePath: string) {
    db.prepare('INSERT INTO artifacts (id, execution_id, type, path) VALUES (?, ?, ?, ?)').run(newId('art'), executionId, type, filePath);
  },

  artifact(id: string) {
    return db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as { id: string; type: string; path: string } | undefined;
  },

  remove(id: string) {
    const execs = db.prepare('SELECT id FROM executions WHERE campaign_id = ?').all(id) as { id: string }[];
    for (const e of execs) fs.rmSync(executionsDir(e.id), { recursive: true, force: true });
    fs.rmSync(path.join(config.STORAGE_DIR, 'campaigns', id), { recursive: true, force: true });
    db.prepare('DELETE FROM bugs WHERE campaign_id = ?').run(id);
    return db.prepare('DELETE FROM campaigns WHERE id = ?').run(id).changes > 0;
  },

  /** After a backend restart nothing is running any more — close out what was in flight. */
  recoverInterrupted(): number {
    const now = new Date().toISOString();
    const ids = (db.prepare("SELECT id FROM campaigns WHERE status IN ('QUEUED','RUNNING')").all() as { id: string }[]).map((r) => r.id);
    for (const id of ids) {
      db.prepare("UPDATE executions SET status = 'error', error_summary = 'Backend restarted during the run', completed_at = ? WHERE campaign_id = ? AND status = 'running'").run(now, id);
      db.prepare("UPDATE executions SET status = 'cancelled', error_summary = 'Backend restarted before this device ran' WHERE campaign_id = ? AND status = 'queued'").run(id);
      db.prepare("UPDATE execution_steps SET status = 'error', actual_result = 'Interrupted' WHERE status = 'running' AND execution_id IN (SELECT id FROM executions WHERE campaign_id = ?)").run(id);
      this.setStatus(id, 'INTERRUPTED', { completed_at: now });
      this.refreshSummary(id);
    }
    return ids.length;
  },
};
