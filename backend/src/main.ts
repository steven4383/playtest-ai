import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { config } from './config.js';
import { migrate } from './db/index.js';
import { apkRoutes } from './api/apks.js';
import { deviceRoutes } from './api/devices.js';
import { systemRoutes } from './api/system.js';
import { sdkRoutes } from './api/sdk.js';
import { llmRoutes } from './api/llm.js';
import { llmStatus } from './llm/index.js';
import { campaignRoutes } from './api/campaigns.js';
import { bugRoutes } from './api/bugs.js';
import { bugRepo } from './services/bugs.js';
import { devtoolsRoutes } from './api/devtools.js';
import { devkitRoutes } from './api/devkit.js';
import { devkit } from './automation/devkit.js';
import { flutterRoutes } from './api/flutter.js';
import { flutterRunner } from './automation/flutter-run.js';
import { campaignRunner } from './automation/campaign-runner.js';
import { campaignRepo } from './services/campaigns.js';
import { emulatorManager } from './automation/emulator.js';
import { systemMonitor } from './services/system-monitor.js';

const app = Fastify({
  logger: {
    level: config.APP_ENV === 'local' ? 'info' : 'warn',
    transport: config.APP_ENV === 'local' ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } : undefined,
  },
  bodyLimit: 1024 * 1024,
});

app.setErrorHandler((err: any, _req, reply) => {
  if (err instanceof ZodError) return reply.code(400).send({ error: 'Validation failed', issues: err.issues });
  const code = err.statusCode ?? 500;
  if (code >= 500) app.log.error(err);
  return reply.code(code).send({ error: err.message ?? 'Internal error' });
});

await app.register(cors, { origin: [/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/] });
await app.register(multipart, { limits: { fileSize: config.MAX_APK_SIZE_MB * 1024 * 1024, files: 1 } });

app.get('/api/v1/health', async () => ({ status: 'ok', version: '0.1.0', uptime_s: Math.round(process.uptime()) }));

await app.register(
  async (api) => {
    await api.register(systemRoutes);
    await api.register(deviceRoutes);
    await api.register(apkRoutes);
    await api.register(sdkRoutes);
    await api.register(llmRoutes);
    await api.register(campaignRoutes);
    await api.register(bugRoutes);
    await api.register(devtoolsRoutes);
    await api.register(devkitRoutes);
    await api.register(flutterRoutes);
  },
  { prefix: '/api/v1' },
);

// Serve the built dashboard in production (npm run build && npm start).
const dashboardDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dashboard/dist');
if (fs.existsSync(dashboardDist)) {
  await app.register(fastifyStatic, { root: dashboardDist, wildcard: false });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith('/api/') ? reply.code(404).send({ error: 'Not found' }) : reply.sendFile('index.html'),
  );
}

const applied = migrate();
if (applied) app.log.info(`Applied ${applied} database migration(s)`);
fs.mkdirSync(config.STORAGE_DIR, { recursive: true });
const interrupted = campaignRepo.recoverInterrupted();
if (interrupted) app.log.warn(`Marked ${interrupted} campaign(s) interrupted by the last restart`);
const backfilled = bugRepo.backfill();
if (backfilled) app.log.info(`Created ${backfilled} bug report(s) from earlier test runs`);

await systemMonitor.start();
// Re-attach emulators that kept running across a backend restart, and notice ones closed elsewhere.
await emulatorManager.sync().catch(() => {});
setInterval(() => void emulatorManager.sync().catch(() => {}), 10_000).unref();
const cap = systemMonitor.capacity();
const info = systemMonitor.info();
app.log.info(
  `Host: ${info?.cpu.brand} (${info?.cpu.threads} threads), ${info?.memory.total_gb} GB RAM, GPU: ${info?.gpus.map((g) => g.model).join(', ') || 'none'}`,
);
const ai = llmStatus();
app.log.info(`LLM: ${ai.provider_label} (${ai.model}) — ${ai.configured ? `key set ${ai.key_hint}` : 'no API key yet (set GEMINI_API_KEY or use the AI page)'}`);
app.log.info(`Capacity:${cap.recommended_concurrent} concurrent emulator(s) recommended (limited by ${cap.limiting_factor}), status=${cap.status}`);

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received — stopping emulators and server`);
  systemMonitor.stop();
  await campaignRunner.cancelAll();
  await devkit.stopAll();
  flutterRunner.stopAll();
  await emulatorManager.stopAll();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.HOST, port: config.PORT });
