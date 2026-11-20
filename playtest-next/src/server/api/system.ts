import type { FastifyInstance } from '../http';
import { z } from 'zod';
import { config } from '../config';
import { bus } from '../core/events';
import { db } from '../db/index';
import { estimateCampaign } from '../services/capacity';
import { systemMonitor } from '../services/system-monitor';

export async function systemRoutes(app: FastifyInstance) {
  app.get('/system/info', async () => ({
    ...systemMonitor.info(),
    limits: {
      max_concurrent_emulators: config.MAX_CONCURRENT_EMULATORS,
      emulator_ram_mb: config.EMULATOR_RAM_MB,
      emulator_gpu_mode: config.EMULATOR_GPU_MODE,
      reserved_ram_gb: config.HOST_RESERVED_RAM_GB,
    },
  }));

  app.get('/system/metrics', async () => systemMonitor.latest());

  app.get<{ Querystring: { limit?: string } }>('/system/metrics/history', async (req) =>
    systemMonitor.history(req.query.limit ? Number(req.query.limit) : undefined),
  );

  app.get('/system/metrics/daily', async () =>
    db
      .prepare(
        `SELECT substr(ts, 1, 13) AS hour, ROUND(AVG(cpu_pct),1) AS cpu_pct, ROUND(MAX(mem_used_gb),2) AS mem_peak_gb,
                ROUND(AVG(gpu_pct),1) AS gpu_pct, MAX(running_emulators) AS emulators
         FROM metric_samples WHERE ts >= ? GROUP BY hour ORDER BY hour`,
      )
      .all(new Date(Date.now() - 24 * 3600_000).toISOString()),
  );

  app.get('/system/capacity', async () => systemMonitor.capacity());

  const estimateQuery = z.object({
    devices: z.coerce.number().int().min(1).max(50).default(4),
    tests: z.coerce.number().int().min(1).max(500).default(10),
    concurrency: z.coerce.number().int().min(1).max(50).optional(),
    snapshot: z.enum(['true', 'false']).default('true'),
  });
  app.get('/system/estimate', async (req) => {
    const q = estimateQuery.parse(req.query);
    const cap = systemMonitor.capacity();
    return estimateCampaign({
      devices: q.devices,
      tests_per_device: q.tests,
      concurrency: q.concurrency ?? Math.min(cap.recommended_concurrent, config.MAX_CONCURRENT_EMULATORS),
      snapshot: q.snapshot === 'true',
    });
  });

  /** Server-Sent Events: live metrics + device lifecycle (section 10, live updates). */
  app.get('/events', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (e: { event: string; data: unknown; timestamp?: string }) =>
      res.write(`event: ${e.event}\ndata: ${JSON.stringify({ ...((e.data as object) ?? {}), timestamp: e.timestamp })}\n\n`);

    const latest = systemMonitor.latest();
    if (latest) send({ event: 'metrics', data: { metrics: latest, capacity: systemMonitor.capacity() } });

    bus.on('event', send);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      bus.off('event', send);
    });
  });
}
