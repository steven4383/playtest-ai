import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { bugRepo } from './bugs.js';
import { campaignRepo } from './campaigns.js';

/**
 * Campaign reports (architecture doc §12, phase 9): APK identity, device configuration, totals, per-device outcomes
 * and evidence links. JSON for the dashboard, a self-contained HTML file for sharing / printing to PDF.
 */

const ms = (a?: string | null, b?: string | null) => (a && b ? Math.max(0, new Date(b).getTime() - new Date(a).getTime()) : null);

export interface ReportDevice {
  execution_id: string;
  device_id: string;
  device_name: string | null;
  type: string | null;
  avd_name: string | null;
  model: string | null;
  android_version: string | null;
  api_level: number | null;
  resolution: string | null;
  ram_mb: number | null;
  serial: string | null;
  status: string;
  error_summary: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  install_ms: number | null;
  avg_launch_ms: number | null;
  slow_start: boolean;
  steps: { name: string; status: string; actual_result: string | null; duration_ms: number | null }[];
  evidence: { id: string; type: string; created_at: string }[];
  bugs: string[];
}

export function reportData(campaignId: string) {
  const c = campaignRepo.get(campaignId);
  if (!c) return null;
  const apk = (db.prepare('SELECT filename, package_name, version_name, version_code, min_sdk, target_sdk, size_bytes, sha256, created_at FROM apk_builds WHERE id = ?').get(c.apk_id) ??
    null) as Record<string, any> | null;
  const bugs = bugRepo.list({ campaign_id: campaignId });
  const devices: ReportDevice[] = c.executions.map((e: any) => {
    const profile = db.prepare('SELECT type, android_version, api_level, resolution, ram_mb, avd_name FROM devices WHERE id = ?').get(e.device_id) as any;
    const m = (e.metrics ?? {}) as Record<string, any>;
    return {
      execution_id: e.id,
      device_id: e.device_id,
      device_name: e.device_name,
      type: profile?.type ?? null,
      avd_name: profile?.avd_name ?? null,
      model: m.model ?? null,
      android_version: m.android_version ?? profile?.android_version ?? null,
      api_level: m.api_level ?? profile?.api_level ?? null,
      resolution: m.resolution ?? profile?.resolution ?? null,
      ram_mb: profile?.ram_mb ?? null,
      serial: e.serial,
      status: e.status,
      error_summary: e.error_summary,
      started_at: e.started_at,
      completed_at: e.completed_at,
      duration_ms: ms(e.started_at, e.completed_at),
      install_ms: m.install_ms ?? null,
      avg_launch_ms: m.avg_launch_ms ?? null,
      slow_start: !!m.slow_start,
      steps: e.steps,
      evidence: e.artifacts,
      bugs: bugs.filter((b) => b.execution_id === e.id).map((b) => b.id),
    };
  });
  const s = c.summary ?? { total: 0, passed: 0, failed: 0, error: 0, skipped: 0, cancelled: 0, running: 0, queued: 0 };
  const judged = s.passed + s.failed;
  return {
    generated_at: new Date().toISOString(),
    campaign: { id: c.id, name: c.name, status: c.status, created_at: c.created_at, started_at: c.started_at, completed_at: c.completed_at, duration_ms: ms(c.started_at, c.completed_at), config: c.config },
    apk,
    totals: { ...s, pass_rate: judged ? s.passed / judged : null },
    devices,
    bugs: bugs.map(({ excerpt: _x, steps: _s, evidence: _e, ...b }) => b),
  };
}
export type ReportData = NonNullable<ReturnType<typeof reportData>>;

/** Across all runs: totals, recent runs, and pass rate per device profile (device comparison). */
export function reportsOverview() {
  const runs = campaignRepo.list();
  const exec = db.prepare("SELECT status, COUNT(*) AS n FROM executions WHERE status NOT IN ('queued','running') GROUP BY status").all() as { status: string; n: number }[];
  const by = Object.fromEntries(exec.map((r) => [r.status, r.n])) as Record<string, number>;
  const perDevice = db
    .prepare(
      `SELECT e.device_id, MAX(e.device_name) AS device_name,
              SUM(e.status = 'passed') AS passed, SUM(e.status = 'failed') AS failed, SUM(e.status = 'error') AS error, COUNT(*) AS total,
              MAX(e.completed_at) AS last_run
       FROM executions e WHERE e.status NOT IN ('queued','running') GROUP BY e.device_id ORDER BY total DESC LIMIT 30`,
    )
    .all();
  const passed = by.passed ?? 0;
  const failed = by.failed ?? 0;
  return {
    runs: runs.length,
    executions: Object.values(by).reduce((a, b) => a + b, 0),
    by_status: by,
    pass_rate: passed + failed ? passed / (passed + failed) : null,
    bugs: bugRepo.stats(),
    recent: runs.slice(0, 20).map((r: any) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      created_at: r.created_at,
      package_name: r.package_name,
      version_name: r.version_name,
      summary: r.summary,
    })),
    per_device: perDevice,
  };
}

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const dur = (n: number | null) => (n === null ? '—' : n < 60_000 ? `${(n / 1000).toFixed(1)} s` : `${Math.floor(n / 60_000)} min ${Math.round((n % 60_000) / 1000)} s`);
const STATUS_COLOR: Record<string, string> = { passed: '#1a7f37', failed: '#cf222e', error: '#9a6700', skipped: '#6e7781', cancelled: '#6e7781' };
const SEV_COLOR: Record<string, string> = { critical: '#cf222e', high: '#bc4c00', medium: '#9a6700', low: '#6e7781' };

/** First screenshot of an execution as a data: URI (keeps the HTML file self-contained). */
function screenshotUri(evidence: { id: string; type: string }[]): string | null {
  const shot = evidence.find((a) => a.type === 'screenshot');
  if (!shot) return null;
  const a = campaignRepo.artifact(shot.id);
  const root = path.resolve(config.STORAGE_DIR) + path.sep;
  if (!a || !path.resolve(a.path).startsWith(root) || !fs.existsSync(a.path)) return null;
  const buf = fs.readFileSync(a.path);
  return buf.length < 4_000_000 ? `data:image/png;base64,${buf.toString('base64')}` : null;
}

export function reportHtml(r: ReportData, opts: { print?: boolean } = {}) {
  const t = r.totals;
  const pct = t.pass_rate === null ? '—' : `${Math.round(t.pass_rate * 100)}%`;
  const maxLaunch = Math.max(1, ...r.devices.map((d) => d.avg_launch_ms ?? 0));
  const rows = r.devices
    .map(
      (d) => `<tr>
  <td><b>${esc(d.device_name)}</b><div class="muted">${esc(d.type ?? '')}${d.model ? ` · ${esc(d.model)}` : ''}</div></td>
  <td>${d.android_version ? `Android ${esc(d.android_version)} <span class="muted">(API ${esc(d.api_level)})</span>` : '—'}</td>
  <td>${esc(d.resolution ?? '—')}</td>
  <td><span class="pill" style="background:${STATUS_COLOR[d.status] ?? '#6e7781'}">${esc(d.status)}</span></td>
  <td>${dur(d.install_ms)}</td>
  <td>${d.avg_launch_ms ? `<div class="bar"><span style="width:${Math.round((d.avg_launch_ms / maxLaunch) * 100)}%"></span></div>${(d.avg_launch_ms / 1000).toFixed(2)} s${d.slow_start ? ' <span class="muted">(slow)</span>' : ''}` : '—'}</td>
  <td>${dur(d.duration_ms)}</td>
  <td class="err">${esc(d.error_summary ?? '')}</td>
</tr>`,
    )
    .join('\n');
  const bugs = r.bugs.length
    ? r.bugs
        .map(
          (b) => `<tr><td><span class="pill" style="background:${SEV_COLOR[b.severity] ?? '#6e7781'}">${esc(b.severity)}</span></td><td><b>${esc(b.title)}</b><div class="muted">${esc(b.actual ?? '')}</div></td><td>${esc(b.category)}</td><td>${esc(b.device_name)}</td><td>${b.confidence !== null ? `${Math.round(b.confidence * 100)}%` : '—'}</td><td>${esc(b.status)}</td></tr>`,
        )
        .join('\n')
    : '<tr><td colspan="6" class="muted">No bugs found in this run.</td></tr>';
  const evidence = r.devices
    .map((d) => {
      const uri = screenshotUri(d.evidence);
      const steps = d.steps
        .map((s: any) => `<li class="${esc(s.status)}"><b>${esc(s.name)}</b> — ${esc(s.status)}${s.duration_ms ? ` · ${dur(s.duration_ms)}` : ''}<div class="muted">${esc(s.actual_result ?? '')}</div></li>`)
        .join('');
      return `<section class="dev"><div class="dev-text"><h3>${esc(d.device_name)} <span class="pill" style="background:${STATUS_COLOR[d.status] ?? '#6e7781'}">${esc(d.status)}</span></h3><ol>${steps}</ol></div>${uri ? `<img src="${uri}" alt="Screenshot on ${esc(d.device_name)}">` : ''}</section>`;
    })
    .join('\n');
  const a = r.apk ?? {};
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Test report — ${esc(r.campaign.name)}</title>
<style>
  :root { --fg:#1f2328; --muted:#59636e; --line:#d1d9e0; --bg:#ffffff; --soft:#f6f8fa; --accent:#0969da; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--fg); background: var(--bg); }
  main { max-width: 1100px; margin: 0 auto; padding: 32px 24px 48px; }
  h1 { font-size: 26px; margin: 0 0 4px; } h2 { font-size: 18px; margin: 32px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
  h3 { font-size: 15px; margin: 0 0 8px; } .muted { color: var(--muted); font-size: 12px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; margin-top: 20px; }
  .stat { border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; background: var(--soft); }
  .stat b { display: block; font-size: 24px; } table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; } th { background: var(--soft); font-weight: 600; }
  .pill { color: #fff; border-radius: 999px; padding: 1px 8px; font-size: 11px; font-weight: 600; text-transform: uppercase; white-space: nowrap; }
  .bar { height: 6px; background: var(--soft); border-radius: 3px; margin-bottom: 3px; width: 120px; } .bar span { display: block; height: 100%; background: var(--accent); border-radius: 3px; }
  .err { color: #cf222e; max-width: 280px; } dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; } dt { color: var(--muted); } dd { margin: 0; word-break: break-all; }
  .dev { display: flex; gap: 20px; border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin-bottom: 14px; break-inside: avoid; }
  .dev-text { flex: 1; min-width: 0; } .dev img { width: 180px; height: auto; border-radius: 8px; border: 1px solid var(--line); align-self: flex-start; }
  ol { margin: 0; padding-left: 20px; } li { margin-bottom: 4px; } li.failed b, li.error b { color: #cf222e; }
  .note { background: var(--soft); border-left: 3px solid var(--accent); padding: 8px 12px; font-size: 12px; color: var(--muted); }
  @media print { main { padding: 0; } h2 { break-after: avoid; } a { color: inherit; } }
  @media (max-width: 640px) { .dev { flex-direction: column; } .dev img { width: 100%; max-width: 260px; } table { display: block; overflow-x: auto; } }
</style></head>
<body><main>
<div class="muted">PlayTest AI · test report</div>
<h1>${esc(r.campaign.name)}</h1>
<div class="muted">Run ${esc(r.campaign.id)} · ${esc(r.campaign.status)} · started ${esc(r.campaign.started_at ?? '—')} · took ${dur(r.campaign.duration_ms)} · report generated ${esc(r.generated_at)}</div>
<div class="stats">
  <div class="stat"><b>${pct}</b>pass rate</div><div class="stat"><b>${t.total}</b>devices</div>
  <div class="stat"><b style="color:#1a7f37">${t.passed}</b>passed</div><div class="stat"><b style="color:#cf222e">${t.failed}</b>failed</div>
  <div class="stat"><b style="color:#9a6700">${t.error}</b>infrastructure errors</div><div class="stat"><b>${r.bugs.length}</b>bugs</div>
</div>
<h2>App under test</h2>
<dl><dt>File</dt><dd>${esc(a.filename ?? '—')}</dd><dt>Package</dt><dd>${esc(a.package_name ?? '—')}</dd><dt>Version</dt><dd>${esc(a.version_name ?? '—')} (code ${esc(a.version_code ?? '—')})</dd>
<dt>SDK</dt><dd>min ${esc(a.min_sdk ?? '?')} · target ${esc(a.target_sdk ?? '?')}</dd><dt>Size</dt><dd>${a.size_bytes ? `${(a.size_bytes / 1048576).toFixed(1)} MB` : '—'}</dd><dt>SHA-256</dt><dd>${esc(a.sha256 ?? '—')}</dd>
<dt>Test flow</dt><dd>${esc(r.campaign.config?.flow ?? '')} · ${esc(r.campaign.config?.mode ?? '')} · wait ${esc(r.campaign.config?.launch_wait_seconds ?? '')} s · ${esc(r.campaign.config?.cycles ?? 1)} cycle(s)</dd></dl>
<h2>Device comparison</h2>
<table><thead><tr><th>Device</th><th>Android</th><th>Screen</th><th>Result</th><th>Install</th><th>Avg launch</th><th>Duration</th><th>Problem</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Bugs</h2>
<table><thead><tr><th>Severity</th><th>Bug</th><th>Category</th><th>Device</th><th>Confidence</th><th>Status</th></tr></thead><tbody>${bugs}</tbody></table>
<p class="note">Bugs list observed facts (process death, logcat crash, install result). Confidence is an evidence-strength estimate, not a probability. AI explanations, when present in the dashboard, are hypotheses.</p>
<h2>Evidence per device</h2>
${evidence}
</main>${opts.print ? '<script>window.addEventListener("load",()=>setTimeout(()=>window.print(),300))</script>' : ''}</body></html>`;
}

/** Save summary.json + report.html next to the run's evidence (storage/campaigns/<id>/report/). */
export function saveReport(campaignId: string) {
  const r = reportData(campaignId);
  if (!r) return null;
  const dir = path.join(config.STORAGE_DIR, 'campaigns', campaignId, 'report');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(r, null, 2));
  fs.writeFileSync(path.join(dir, 'report.html'), reportHtml(r));
  return dir;
}
