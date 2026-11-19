import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { campaignRunner } from '../automation/campaign-runner.js';
import { emulatorManager } from '../automation/emulator.js';
import { db } from '../db/index.js';
import { llm } from '../llm/index.js';
import { bugPrompt, bugRepo, bugStatus } from '../services/bugs.js';
import { campaignRepo, type CampaignConfig } from '../services/campaigns.js';
import { deviceRepo } from '../services/devices.js';
import { reportData, reportHtml, reportsOverview, saveReport } from '../services/reports.js';

const listQuery = z.object({
  status: bugStatus.optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  category: z.string().regex(/^[a-z_]{2,20}$/).optional(),
  package_name: z.string().regex(/^[\w.]{1,200}$/).optional(),
  campaign_id: z.string().regex(/^[\w-]{1,64}$/).optional(),
});

export async function bugRoutes(app: FastifyInstance) {
  app.get('/bugs', async (req) => ({ bugs: bugRepo.list(listQuery.parse(req.query ?? {})), stats: bugRepo.stats() }));

  app.get<{ Params: { id: string } }>('/bugs/:id', async (req, reply) => {
    const b = bugRepo.get(req.params.id);
    if (!b) return reply.code(404).send({ error: 'Bug not found' });
    return { ...b, occurrences: bugRepo.occurrences(b.signature) };
  });

  /** Status applies to every occurrence of the same problem. */
  app.patch<{ Params: { id: string } }>('/bugs/:id', async (req, reply) => {
    const { status } = z.object({ status: bugStatus }).parse(req.body);
    const b = bugRepo.setStatus(req.params.id, status);
    if (!b) return reply.code(404).send({ error: 'Bug not found' });
    return b;
  });

  /** Re-run the same APK on the same device (3 cycles, fresh install) to check whether the bug reproduces. */
  app.post<{ Params: { id: string } }>('/bugs/:id/retest', async (req, reply) => {
    const b = bugRepo.get(req.params.id);
    if (!b) return reply.code(404).send({ error: 'Bug not found' });
    const src = b.campaign_id ? campaignRepo.get(b.campaign_id) : null;
    const device = b.device_id ? deviceRepo.get(b.device_id) : null;
    if (!src || !device) return reply.code(409).send({ error: 'The original test run or device profile no longer exists' });
    const apk = db.prepare('SELECT id, package_name, filename FROM apk_builds WHERE id = ?').get(src.apk_id) as { id: string; package_name: string; filename: string } | undefined;
    if (!apk?.package_name) return reply.code(409).send({ error: 'The APK of that run was deleted' });
    if (device.type === 'emulator') {
      const { avds } = await emulatorManager.listAvds();
      if (!device.avd_name || !avds.includes(device.avd_name)) return reply.code(409).send({ error: `${device.name}: AVD is not installed any more` });
    }
    const cfg: CampaignConfig = { ...(src.config as CampaignConfig), name: `Re-test: ${b.title.slice(0, 70)}`, device_ids: [device.id], mode: 'sequential', cycles: 3, fresh_install: true };
    const c = campaignRepo.create(cfg, apk, [{ id: device.id, name: device.name }]);
    bugRepo.setRetest(b.id, c.id);
    campaignRunner.start(c.id);
    reply.code(201);
    return { campaign_id: c.id };
  });

  /** Optional AI explanation, stored and always shown as a hypothesis. */
  app.post<{ Params: { id: string } }>('/bugs/:id/analyze', async (req, reply) => {
    const b = bugRepo.get(req.params.id);
    if (!b) return reply.code(404).send({ error: 'Bug not found' });
    const p = bugPrompt(b);
    const r = await llm().generate({ system: p.system, prompt: p.prompt, temperature: 0.3, maxOutputTokens: 1200, timeoutMs: 60_000 });
    bugRepo.setHypothesis(b.id, r.text);
    return { hypothesis: r.text, model: r.model };
  });

  // ---- reports
  app.get('/reports/overview', async () => reportsOverview());

  app.get<{ Params: { id: string } }>('/reports/:id', async (req, reply) => {
    const r = reportData(req.params.id);
    if (!r) return reply.code(404).send({ error: 'Test run not found' });
    return r;
  });

  /** Standalone HTML report (?download=1 to save, ?print=1 opens the print dialog for "Save as PDF"). */
  app.get<{ Params: { id: string }; Querystring: { download?: string; print?: string } }>('/reports/:id/html', async (req, reply) => {
    const r = reportData(req.params.id);
    if (!r) return reply.code(404).send({ error: 'Test run not found' });
    if (!campaignRunner.isActive(r.campaign.id)) saveReport(r.campaign.id);
    const html = reportHtml(r, { print: req.query.print === '1' });
    reply.type('text/html; charset=utf-8');
    if (req.query.download === '1') {
      const safe = r.campaign.name.replace(/[^\w.-]+/g, '_').slice(0, 60);
      reply.header('Content-Disposition', `attachment; filename="playtest-report-${safe}.html"`);
    }
    return reply.send(html);
  });
}
