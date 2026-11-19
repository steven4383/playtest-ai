import fs from 'node:fs';
import { z } from 'zod';
import { db, newId } from '../db/index.js';

/**
 * Bug reports (architecture doc §12.2, phase 8): every failed test execution becomes an evidence-backed bug with a
 * category, severity, reproduction steps and links to its screenshot / logcat / crash excerpt.
 * Everything here is observed fact; an AI explanation is stored separately in `hypothesis` and labelled as such.
 */

export const BUG_STATUSES = ['open', 'confirmed', 'fixed', 'ignored'] as const;
export const bugStatus = z.enum(BUG_STATUSES);
export type BugStatus = z.infer<typeof bugStatus>;
export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type Category = 'crash' | 'anr' | 'native_crash' | 'install' | 'compatibility' | 'launch' | 'stability' | 'performance' | 'functional';

export interface BugRow {
  id: string;
  execution_id: string;
  campaign_id: string | null;
  device_id: string | null;
  device_name: string | null;
  package_name: string | null;
  app_version: string | null;
  android_version: string | null;
  api_level: number | null;
  title: string;
  severity: Severity;
  category: Category;
  expected: string | null;
  actual: string | null;
  confidence: number | null;
  reproducible: number | null;
  signature: string;
  status: BugStatus;
  steps: string[];
  evidence: { id: string; type: string }[];
  excerpt: string | null;
  hypothesis: string | null;
  retest_campaign_id: string | null;
  created_at: string;
}

const parse = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== 'string' || !s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
const rowOut = (r: any): BugRow => ({ ...r, steps: parse(r.steps, []), evidence: parse(r.evidence, []) });

/** Stable part of a Java/Kotlin frame: `at com.x.Foo.bar(Foo.kt:12)` → `com.x.Foo.bar`. */
const frameKey = (l: string) => l.trim().replace(/^at\s+/, '').replace(/\(.*$/, '');

/** Pull exception class + message + first app frame out of a FATAL EXCEPTION excerpt. */
export function crashFacts(excerpt: string, pkg: string) {
  const lines = excerpt.split(/\r?\n/).map((l) => l.replace(/^.*?\b[EFWID]\s+AndroidRuntime:\s?/, ''));
  const exLine = lines.find((l) => /^\s*(Caused by: )?[\w$]+(\.[\w$]+)+(Exception|Error|Throwable)\b/.test(l)) ?? '';
  const m = exLine.trim().replace(/^Caused by: /, '').match(/^([\w$.]+)(?::\s*(.*))?$/);
  const cls = m?.[1] ?? 'Exception';
  const msg = (m?.[2] ?? '').trim();
  // The deepest cause usually names the real problem.
  const cause = [...lines].reverse().find((l) => l.trim().startsWith('Caused by:'))?.trim().replace(/^Caused by:\s*/, '');
  const frames = lines.filter((l) => /^\s*at\s/.test(l));
  const appRoot = pkg.split('.').slice(0, 2).join('.');
  const appFrame = frames.find((l) => l.includes(appRoot)) ?? frames[0] ?? '';
  return { cls, short: cls.split('.').pop()!, msg, cause, frame: frameKey(appFrame) };
}

function classify(e: any, steps: any[], artifacts: { id: string; type: string; path: string }[], apk: any) {
  const pkg: string = apk?.package_name ?? '';
  const metrics = parse<Record<string, any>>(e.metrics, {});
  const wait = parse<any>(e.config, {})?.launch_wait_seconds;
  const crashArt = artifacts.find((a) => a.type === 'crash' || a.type === 'anr' || a.type === 'native_crash');
  const excerpt = crashArt && fs.existsSync(crashArt.path) ? fs.readFileSync(crashArt.path, 'utf8').slice(0, 20_000) : null;
  const summary: string = e.error_summary ?? '';

  type C = { title: string; category: Category; severity: Severity; confidence: number; signature: string; expected: string; actual: string };
  let c: C | null = null;
  const open = `App opens and keeps running${wait ? ` for ${wait} s` : ''} without crashing`;

  if (e.status === 'failed' && crashArt?.type === 'crash' && excerpt) {
    const f = crashFacts(excerpt, pkg);
    c = {
      title: `Crash: ${f.short}${f.msg ? ` — ${f.msg.slice(0, 90)}` : ''}`,
      category: 'crash',
      severity: 'critical',
      confidence: 0.95,
      signature: `crash|${pkg}|${f.cls}|${f.frame}`,
      expected: open,
      actual: `The app process died with ${f.cls}${f.msg ? `: ${f.msg}` : ''}${f.cause ? ` (caused by ${f.cause})` : ''}${f.frame ? ` at ${f.frame}` : ''}.`,
    };
  } else if (e.status === 'failed' && crashArt?.type === 'anr' && excerpt) {
    const reason = excerpt.match(/Reason:\s*([^\n]+)/)?.[1]?.trim() ?? 'not responding';
    c = {
      title: `ANR: app not responding — ${reason.slice(0, 80)}`,
      category: 'anr',
      severity: 'high',
      confidence: 0.9,
      signature: `anr|${pkg}|${reason.replace(/\d+/g, '#').slice(0, 80)}`,
      expected: `${open}, and responds to input`,
      actual: `Android reported "Application Not Responding": ${reason}.`,
    };
  } else if (e.status === 'failed' && crashArt?.type === 'native_crash' && excerpt) {
    const sig = excerpt.match(/signal \d+ \((\w+)\)/)?.[1] ?? 'signal';
    const lib = excerpt.match(/#\d+ pc [0-9a-f]+\s+(\S+\.so)/)?.[1]?.split('/').pop() ?? '';
    c = {
      title: `Native crash: ${sig}${lib ? ` in ${lib}` : ''}`,
      category: 'native_crash',
      severity: 'critical',
      confidence: 0.9,
      signature: `native|${pkg}|${sig}|${lib}`,
      expected: open,
      actual: `The app process was killed by ${sig}${lib ? ` (top native frame in ${lib})` : ''}.`,
    };
  } else if (e.status === 'failed' && /^Install failed/i.test(summary)) {
    const code = summary.match(/INSTALL_[A-Z_]+/)?.[0] ?? summary.replace(/^Install failed:\s*/i, '').slice(0, 80);
    const compat = /NO_MATCHING_ABIS|OLDER_SDK|MISSING_SHARED_LIBRARY|FEATURE/.test(code);
    c = {
      title: `${compat ? 'Not compatible' : 'Install failed'}: ${code}`,
      category: compat ? 'compatibility' : 'install',
      severity: 'high',
      confidence: 0.95,
      signature: `install|${pkg}|${code}`,
      expected: 'The APK installs on this device',
      actual: summary,
    };
  } else if (e.status === 'failed' && /^Launch failed/i.test(summary) && /Status:\s*timeout/i.test(summary)) {
    c = {
      title: 'Launch timed out — no first screen within 10 s',
      category: 'launch',
      severity: 'medium',
      confidence: 0.5,
      signature: `launch_timeout|${pkg}`,
      expected: 'The first screen is drawn within 10 s of tapping the icon',
      actual: `${summary.split('\n')[0]} — Android stopped waiting after 10 s. Often a busy or slow emulator (just booted, headless, low RAM) rather than the app; PlayTest now waits up to 60 s more before failing.`,
    };
  } else if (e.status === 'failed' && /^Launch failed|no launcher activity|could not be started/i.test(summary)) {
    c = {
      title: 'App could not be launched',
      category: 'launch',
      severity: 'high',
      confidence: 0.85,
      signature: `launch|${pkg}|${summary.replace(/\d+/g, '#').slice(0, 60)}`,
      expected: 'Tapping the app icon opens its main screen',
      actual: summary,
    };
  } else if (e.status === 'failed' && /exited on its own/i.test(summary)) {
    c = {
      title: 'App closed by itself (no crash in logcat)',
      category: 'stability',
      severity: 'high',
      confidence: 0.6,
      signature: `exit|${pkg}`,
      expected: open,
      actual: 'The app process ended without a FATAL EXCEPTION, ANR or native crash in logcat (it may call exit(), be killed for memory, or crash before logging).',
    };
  } else if (e.status === 'failed') {
    c = {
      title: summary.slice(0, 120) || 'Test step failed',
      category: 'functional',
      severity: 'medium',
      confidence: 0.5,
      signature: `failed|${pkg}|${summary.replace(/\d+/g, '#').slice(0, 80)}`,
      expected: 'All test steps pass',
      actual: summary || 'A step failed',
    };
  } else if (e.status === 'passed' && metrics.slow_start) {
    const ms = Array.isArray(metrics.launch_times_ms) ? Math.max(...metrics.launch_times_ms) : null;
    c = {
      title: `Slow cold start${ms ? ` (${(ms / 1000).toFixed(1)} s)` : ''} on ${e.device_name ?? 'device'}`,
      category: 'performance',
      severity: 'low',
      confidence: 0.5,
      signature: `slow_start|${pkg}|${e.device_id}`,
      expected: 'First screen drawn within 10 s (Android stops timing a launch at 10 s)',
      actual: `First frame took longer than 10 s${ms ? ` — the app reached the foreground after ${(ms / 1000).toFixed(1)} s` : ''}. Can be the device or emulator speed rather than the app.`,
    };
  }
  if (!c) return null;

  const repro = [
    `Install ${apk?.filename ?? 'the APK'} (${pkg}${apk?.version_name ? ` ${apk.version_name}` : ''}) on ${e.device_name ?? 'the device'}${metrics.android_version ? ` — Android ${metrics.android_version}, API ${metrics.api_level}` : ''}`,
    ...steps
      .filter((s) => !/^(Boot emulator|Connect device|Install APK)$/.test(s.name))
      .map((s) => (s.status === 'passed' ? s.name : `${s.name} → ${s.status}: ${(s.actual_result ?? '').slice(0, 200)}`)),
  ];
  return {
    ...c,
    steps: repro,
    evidence: artifacts.map((a) => ({ id: a.id, type: a.type })),
    excerpt: excerpt ? excerpt.split(/\r?\n/).slice(0, 80).join('\n') : summary || null,
    android_version: metrics.android_version ?? null,
    api_level: metrics.api_level ?? null,
  };
}

export const bugRepo = {
  /** Create the bug for a finished execution (no-op if it passed cleanly, was skipped / cancelled / an infra error, or already has one). */
  fromExecution(executionId: string): BugRow | null {
    if (db.prepare('SELECT 1 FROM bugs WHERE execution_id = ?').get(executionId)) return null;
    const e = db
      .prepare('SELECT e.*, c.apk_id, c.config FROM executions e JOIN campaigns c ON c.id = e.campaign_id WHERE e.id = ?')
      .get(executionId) as any;
    if (!e) return null;
    const steps = db.prepare('SELECT name, status, actual_result FROM execution_steps WHERE execution_id = ? ORDER BY step_number').all(executionId) as any[];
    const artifacts = db.prepare('SELECT id, type, path FROM artifacts WHERE execution_id = ? ORDER BY created_at').all(executionId) as any[];
    const apk = db.prepare('SELECT * FROM apk_builds WHERE id = ?').get(e.apk_id) as any;
    const c = classify(e, steps, artifacts, apk);
    if (!c) return null;
    const id = newId('bug');
    db.prepare(
      `INSERT INTO bugs (id, execution_id, campaign_id, device_id, device_name, package_name, app_version, android_version, api_level,
         title, severity, category, expected, actual, confidence, reproducible, signature, status, steps, evidence, excerpt, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'open', ?, ?, ?, ?)`,
    ).run(
      id,
      executionId,
      e.campaign_id,
      e.device_id,
      e.device_name,
      apk?.package_name ?? null,
      apk?.version_name ?? null,
      c.android_version,
      c.api_level,
      c.title,
      c.severity,
      c.category,
      c.expected,
      c.actual,
      c.confidence,
      c.signature,
      JSON.stringify(c.steps),
      JSON.stringify(c.evidence),
      c.excerpt,
      e.completed_at ?? new Date().toISOString(),
    );
    // A bug already marked fixed that shows up again is re-opened.
    db.prepare("UPDATE bugs SET status = 'open' WHERE signature = ? AND status = 'fixed'").run(c.signature);
    const prev = db.prepare("SELECT status FROM bugs WHERE signature = ? AND id <> ? AND status IN ('confirmed','ignored') LIMIT 1").get(c.signature, id) as any;
    if (prev) db.prepare('UPDATE bugs SET status = ? WHERE id = ?').run(prev.status, id);
    return this.get(id);
  },

  /** Bugs for executions that finished before bug reports existed. */
  backfill(): number {
    const ids = db
      .prepare("SELECT e.id FROM executions e WHERE e.status IN ('failed','passed') AND NOT EXISTS (SELECT 1 FROM bugs b WHERE b.execution_id = e.id)")
      .all() as { id: string }[];
    let n = 0;
    for (const { id } of ids) if (this.fromExecution(id)) n++;
    return n;
  },

  list(f: { status?: string; severity?: string; category?: string; package_name?: string; campaign_id?: string } = {}): BugRow[] {
    const where: string[] = [];
    const vals: string[] = [];
    for (const [k, v] of Object.entries(f)) {
      if (!v) continue;
      where.push(`${k} = ?`);
      vals.push(v);
    }
    return (db.prepare(`SELECT * FROM bugs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT 1000`).all(...vals) as any[]).map(rowOut);
  },

  get(id: string): BugRow | null {
    const r = db.prepare('SELECT * FROM bugs WHERE id = ?').get(id);
    return r ? rowOut(r) : null;
  },

  /** Other occurrences of the same problem (same signature). */
  occurrences(signature: string) {
    return db
      .prepare('SELECT id, execution_id, campaign_id, device_name, android_version, created_at, status FROM bugs WHERE signature = ? ORDER BY created_at DESC LIMIT 50')
      .all(signature);
  },

  /** Set status on this bug and every other occurrence of the same problem. */
  setStatus(id: string, status: BugStatus) {
    const b = this.get(id);
    if (!b) return null;
    db.prepare('UPDATE bugs SET status = ? WHERE signature = ?').run(status, b.signature);
    return this.get(id);
  },

  setHypothesis(id: string, text: string) {
    db.prepare('UPDATE bugs SET hypothesis = ? WHERE id = ?').run(text, id);
  },

  setRetest(id: string, campaignId: string) {
    db.prepare('UPDATE bugs SET retest_campaign_id = ?, reproducible = NULL WHERE id = ?').run(campaignId, id);
  },

  /** After a re-test run: reproducible = the same signature failed again on that run. */
  resolveRetests(campaignId: string) {
    const waiting = db.prepare('SELECT id, signature FROM bugs WHERE retest_campaign_id = ?').all(campaignId) as { id: string; signature: string }[];
    if (!waiting.length) return;
    const again = new Set((db.prepare('SELECT signature FROM bugs WHERE campaign_id = ?').all(campaignId) as { signature: string }[]).map((r) => r.signature));
    const ran = db.prepare("SELECT COUNT(*) AS n FROM executions WHERE campaign_id = ? AND status IN ('passed','failed')").get(campaignId) as { n: number };
    for (const w of waiting) {
      if (again.has(w.signature)) db.prepare('UPDATE bugs SET reproducible = 1 WHERE id = ?').run(w.id);
      else if (ran.n > 0) db.prepare('UPDATE bugs SET reproducible = 0 WHERE id = ?').run(w.id);
    }
  },

  /** Counts for the dashboard. */
  stats() {
    const bySeverity = db.prepare("SELECT severity, COUNT(DISTINCT signature) AS n FROM bugs WHERE status IN ('open','confirmed') GROUP BY severity").all() as { severity: string; n: number }[];
    const total = db.prepare("SELECT COUNT(DISTINCT signature) AS n FROM bugs WHERE status IN ('open','confirmed')").get() as { n: number };
    return { open: total.n, by_severity: Object.fromEntries(bySeverity.map((r) => [r.severity, r.n])) };
  },
};

/** Prompt for the optional AI explanation: facts + crash excerpt only, framed as a hypothesis. */
export function bugPrompt(b: BugRow) {
  return {
    system:
      'You are a senior Android and Flutter engineer triaging a bug found by automated testing. Answer in short Markdown. ' +
      'Everything you say is a HYPOTHESIS unless the log proves it — say how sure you are. Never invent log lines.',
    prompt: [
      `Bug: ${b.title}`,
      `Category: ${b.category}, severity ${b.severity}`,
      `App: ${b.package_name} ${b.app_version ?? ''}`,
      `Device: ${b.device_name} (Android ${b.android_version ?? '?'}, API ${b.api_level ?? '?'})`,
      `Expected: ${b.expected}`,
      `Observed: ${b.actual}`,
      `Reproduction steps:\n${b.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
      b.excerpt ? `Log excerpt:\n\`\`\`\n${b.excerpt.slice(0, 6000)}\n\`\`\`` : '',
      'Give: 1) Likely cause (hypothesis) 2) Where to look in the code 3) A suggested fix 4) How to confirm it.',
    ].join('\n\n'),
  };
}
