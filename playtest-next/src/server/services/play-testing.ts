import { z } from 'zod';
import { db, newId } from '../db/index';

/**
 * Google Play closed testing tracker. New personal developer accounts must run a closed test with at least
 * 12 testers who stay opted in for 14 days in a row before applying for production. Play Console counts Google
 * accounts (emails) of real people who opted in on their own phones — this keeps the list, who opted in when,
 * and when the requirement is met. Stored only in the local database; nothing is sent anywhere.
 */

export const PKG_RE = /^[a-zA-Z][\w]*(\.[a-zA-Z_][\w]*)+$/;
export const testerStatus = z.enum(['invited', 'opted_in', 'left']);
export type TesterStatus = z.infer<typeof testerStatus>;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/, 'Use a date like 2026-11-19')
  .refine((s) => !Number.isNaN(Date.parse(s)) && Date.parse(s) <= Date.now() + 86_400_000, 'Date cannot be in the future');

export const testerInput = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address').max(254),
  name: z.string().trim().max(100).optional().nullable(),
  device: z.string().trim().max(100).optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
  status: testerStatus.optional(),
  opted_in_at: isoDate.optional().nullable(),
});
export const testerPatch = testerInput.partial();

export const settingsInput = z.object({
  opt_in_url: z
    .string()
    .trim()
    .max(300)
    .regex(/^https:\/\/[\w.-]+\/[^\s"'<>]*$/, 'Use the https:// opt-in link from Play Console')
    .optional()
    .nullable(),
  required_testers: z.number().int().min(1).max(500).optional(),
  required_days: z.number().int().min(1).max(90).optional(),
});

export interface Tester {
  id: string;
  package_name: string;
  email: string;
  name: string | null;
  device: string | null;
  status: TesterStatus;
  invited_at: string;
  opted_in_at: string | null;
  left_at: string | null;
  notes: string | null;
  created_at: string;
}

interface PlayTest {
  package_name: string;
  opt_in_url: string | null;
  required_testers: number;
  required_days: number;
  created_at: string;
}

const DAY = 86_400_000;
const bad = (msg: string, statusCode = 400) => Object.assign(new Error(msg), { statusCode });
const assertPkg = (pkg: string) => {
  if (!PKG_RE.test(pkg) || pkg.length > 200) throw bad(`Invalid package name: ${pkg}`);
};

function settings(pkg: string): PlayTest {
  const row = db.prepare('SELECT * FROM play_tests WHERE package_name = ?').get(pkg) as PlayTest | undefined;
  return row ?? { package_name: pkg, opt_in_url: null, required_testers: 12, required_days: 14, created_at: new Date().toISOString() };
}

function ensureTest(pkg: string) {
  db.prepare('INSERT OR IGNORE INTO play_tests (package_name, created_at) VALUES (?, ?)').run(pkg, new Date().toISOString());
}

/**
 * Where the closed test stands. Play needs `required_testers` opted in for the last `required_days` days in a row:
 * the clock starts when the Nth of the testers who are still opted in joined (someone leaving can move it later).
 */
export function summarize(pkg: string, testers: Tester[]) {
  const s = settings(pkg);
  const opted = testers
    .filter((t) => t.status === 'opted_in' && t.opted_in_at)
    .sort((a, b) => Date.parse(a.opted_in_at!) - Date.parse(b.opted_in_at!));
  const n = s.required_testers;
  const since = opted.length >= n ? opted[n - 1].opted_in_at! : null;
  const daysDone = since ? Math.max(0, Math.floor((Date.now() - Date.parse(since)) / DAY)) : 0;
  const eligibleAt = since ? new Date(Date.parse(since) + s.required_days * DAY).toISOString() : null;
  const met = !!eligibleAt && Date.now() >= Date.parse(eligibleAt);
  return {
    required_testers: n,
    required_days: s.required_days,
    opted_in: opted.length,
    invited: testers.filter((t) => t.status === 'invited').length,
    left: testers.filter((t) => t.status === 'left').length,
    need_more: Math.max(0, n - opted.length),
    /** Opted-in testers beyond the minimum — a buffer in case someone leaves. */
    spare: Math.max(0, opted.length - n),
    clock_started_at: since,
    days_done: Math.min(daysDone, s.required_days),
    eligible_at: eligibleAt,
    met,
    status: met ? 'met' : since ? 'counting' : 'need_testers',
  };
}

export const playTesting = {
  apps() {
    const rows = db
      .prepare(
        `SELECT package_name, COUNT(*) AS testers, SUM(status = 'opted_in') AS opted_in FROM play_testers GROUP BY package_name
         UNION SELECT package_name, 0, 0 FROM play_tests WHERE package_name NOT IN (SELECT package_name FROM play_testers)`,
      )
      .all() as { package_name: string; testers: number; opted_in: number }[];
    return rows.map((r) => ({ ...r, summary: summarize(r.package_name, this.testers(r.package_name)) }));
  },

  testers(pkg: string): Tester[] {
    assertPkg(pkg);
    return db
      .prepare(`SELECT * FROM play_testers WHERE package_name = ? ORDER BY CASE status WHEN 'opted_in' THEN 0 WHEN 'invited' THEN 1 ELSE 2 END, COALESCE(name, email)`)
      .all(pkg) as unknown as Tester[];
  },

  get(pkg: string) {
    assertPkg(pkg);
    const testers = this.testers(pkg);
    const s = settings(pkg);
    return {
      package_name: pkg,
      settings: { ...s, opt_in_url: s.opt_in_url ?? `https://play.google.com/apps/testing/${pkg}`, store_url: `https://play.google.com/store/apps/details?id=${pkg}` },
      testers,
      summary: summarize(pkg, testers),
    };
  },

  saveSettings(pkg: string, input: z.infer<typeof settingsInput>) {
    assertPkg(pkg);
    ensureTest(pkg);
    const cur = settings(pkg);
    db.prepare('UPDATE play_tests SET opt_in_url = ?, required_testers = ?, required_days = ? WHERE package_name = ?').run(
      input.opt_in_url === undefined ? cur.opt_in_url : input.opt_in_url || null,
      input.required_testers ?? cur.required_testers,
      input.required_days ?? cur.required_days,
      pkg,
    );
    return this.get(pkg);
  },

  add(pkg: string, input: z.infer<typeof testerInput>): Tester {
    assertPkg(pkg);
    ensureTest(pkg);
    if (db.prepare('SELECT 1 FROM play_testers WHERE package_name = ? AND email = ?').get(pkg, input.email)) throw bad(`${input.email} is already on the list`, 409);
    const now = new Date().toISOString();
    const status = input.status ?? 'invited';
    const id = newId('tst');
    db.prepare(
      'INSERT INTO play_testers (id, package_name, email, name, device, status, invited_at, opted_in_at, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).run(id, pkg, input.email, input.name || null, input.device || null, status, now, status === 'opted_in' ? (input.opted_in_at ?? now) : null, input.notes || null, now);
    return db.prepare('SELECT * FROM play_testers WHERE id = ?').get(id) as unknown as Tester;
  },

  /** Paste a list: every email address found in the text is added as "invited" (duplicates skipped). */
  importText(pkg: string, text: string) {
    assertPkg(pkg);
    const found = [...new Set((text.match(/[^\s,;<>"'()]+@[^\s,;<>"'()]+\.[a-z]{2,}/gi) ?? []).map((e) => e.toLowerCase()))];
    const added: string[] = [];
    const skipped: string[] = [];
    const invalid: string[] = [];
    for (const email of found) {
      const parsed = testerInput.safeParse({ email });
      if (!parsed.success) {
        invalid.push(email);
        continue;
      }
      try {
        this.add(pkg, parsed.data);
        added.push(email);
      } catch {
        skipped.push(email);
      }
    }
    return { added, skipped, invalid };
  },

  update(id: string, patch: z.infer<typeof testerPatch>): Tester {
    const cur = db.prepare('SELECT * FROM play_testers WHERE id = ?').get(id) as unknown as Tester | undefined;
    if (!cur) throw bad('Tester not found', 404);
    if (patch.email && patch.email !== cur.email && db.prepare('SELECT 1 FROM play_testers WHERE package_name = ? AND email = ?').get(cur.package_name, patch.email))
      throw bad(`${patch.email} is already on the list`, 409);
    const status = patch.status ?? cur.status;
    const now = new Date().toISOString();
    // Opting in (again) starts this tester's days now unless a date is given; leaving keeps the history.
    const optedIn =
      status === 'opted_in' ? (patch.opted_in_at ?? (cur.status === 'opted_in' ? cur.opted_in_at : now)) : status === 'invited' ? null : cur.opted_in_at;
    const leftAt = status === 'left' ? (cur.status === 'left' ? cur.left_at : now) : null;
    db.prepare('UPDATE play_testers SET email = ?, name = ?, device = ?, notes = ?, status = ?, opted_in_at = ?, left_at = ? WHERE id = ?').run(
      patch.email ?? cur.email,
      patch.name === undefined ? cur.name : patch.name || null,
      patch.device === undefined ? cur.device : patch.device || null,
      patch.notes === undefined ? cur.notes : patch.notes || null,
      status,
      optedIn,
      leftAt,
      id,
    );
    return db.prepare('SELECT * FROM play_testers WHERE id = ?').get(id) as unknown as Tester;
  },

  remove(id: string) {
    if (!db.prepare('DELETE FROM play_testers WHERE id = ?').run(id).changes) throw bad('Tester not found', 404);
    return { deleted: id };
  },

  /** Forget an app's closed test: its settings and every tester on its list. */
  removeApp(pkg: string) {
    assertPkg(pkg);
    const testers = db.prepare('DELETE FROM play_testers WHERE package_name = ?').run(pkg).changes;
    db.prepare('DELETE FROM play_tests WHERE package_name = ?').run(pkg);
    return { deleted: pkg, testers };
  },

  /** Email list for Play Console (Testing → Closed testing → Testers → Create email list → Upload CSV): one address per line. */
  csv(pkg: string) {
    return this.testers(pkg)
      .filter((t) => t.status !== 'left')
      .map((t) => t.email)
      .join('\r\n');
  },
};
