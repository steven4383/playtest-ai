import fs from 'node:fs';
import { config } from './config';
import { migrate } from './db';
import { llmStatus } from './llm';
import { bugRepo } from './services/bugs';
import { campaignRepo } from './services/campaigns';
import { systemMonitor } from './services/system-monitor';
import { startIdleWatcher } from './services/ram-saver';
import { campaignRunner } from './automation/campaign-runner';
import { devkit } from './automation/devkit';
import { emulatorManager } from './automation/emulator';
import { flutterRunner } from './automation/flutter-run';

/**
 * Starts the background side of PlayTest once per server process (what backend/src/main.ts did): database
 * migrations, recovering interrupted runs, the system monitor, emulator re-attach + boot tracking, the RAM-saver
 * watcher and a clean shutdown. Called by the API route before the first request and by instrumentation.ts.
 *
 * In `next dev`, editing server code loads a new copy of these modules: the background loops are then restarted
 * with the new code, while the one-time steps (migrations, recovery) and all state (kept on globalThis) stay.
 */
interface BootState {
  owner?: symbol;
  ready?: Promise<void>;
  oneTimeDone?: boolean;
  stopLoops?: () => void;
  shutdown?: (signal: string) => Promise<void>;
  signalsHooked?: boolean;
}
const g = globalThis as { __playtestBoot?: BootState };
const MODULE = Symbol('boot');

const log = (msg: string) => console.log(`[playtest] ${msg}`);

export function ensureBooted(): Promise<void> {
  const st = (g.__playtestBoot ??= {});
  if (st.owner === MODULE && st.ready) return st.ready;
  st.stopLoops?.(); // loops of an older copy of this code (dev reload)
  st.owner = MODULE;
  st.ready = (async () => {
    if (!st.oneTimeDone) {
      st.oneTimeDone = true;
      const applied = migrate();
      if (applied) log(`Applied ${applied} database migration(s)`);
      fs.mkdirSync(config.STORAGE_DIR, { recursive: true });
      const interrupted = campaignRepo.recoverInterrupted();
      if (interrupted) log(`Marked ${interrupted} test run(s) interrupted by the last restart`);
      const backfilled = bugRepo.backfill();
      if (backfilled) log(`Created ${backfilled} bug report(s) from earlier test runs`);
    }

    await systemMonitor.start();
    // Re-attach emulators that kept running across a restart, and notice ones closed elsewhere. Every 4 s, so an
    // emulator started from a terminal shows its boot progress almost from the start.
    await emulatorManager.sync().catch(() => {});
    const syncTimer = setInterval(() => void emulatorManager.sync().catch(() => {}), 4_000);
    syncTimer.unref();
    const idleTimer = startIdleWatcher();
    st.stopLoops = () => {
      systemMonitor.stop();
      clearInterval(syncTimer);
      clearInterval(idleTimer);
    };

    // Shutdown uses the newest code; signal handlers are added once per process.
    st.shutdown = async (signal: string) => {
      log(`${signal} received — stopping test runs and the emulators PlayTest started`);
      st.stopLoops?.();
      await campaignRunner.cancelAll().catch(() => {});
      await devkit.stopAll().catch(() => {});
      flutterRunner.stopAll();
      await emulatorManager.stopAll().catch(() => {});
    };
    if (!st.signalsHooked) {
      st.signalsHooked = true;
      for (const sig of ['SIGINT', 'SIGTERM'] as const) {
        process.once(sig, () => {
          void g.__playtestBoot?.shutdown?.(sig).finally(() => process.exit(0));
        });
      }
    }

    const cap = systemMonitor.capacity();
    const info = systemMonitor.info();
    const ai = llmStatus();
    log(`Host: ${info?.cpu.brand} (${info?.cpu.threads} threads), ${info?.memory.total_gb} GB RAM, GPU: ${info?.gpus.map((x) => x.model).join(', ') || 'none'}`);
    log(`LLM: ${ai.provider_label} (${ai.model}) — ${ai.configured ? `key set ${ai.key_hint}` : 'no API key yet (set GEMINI_API_KEY or use the AI page)'}`);
    log(`Capacity: ${cap.recommended_concurrent} emulator(s) at once recommended (limited by ${cap.limiting_factor}), status=${cap.status}`);
  })().catch((err) => {
    // Let the next request try again instead of keeping a failed start forever.
    st.owner = undefined;
    st.ready = undefined;
    throw err;
  });
  return st.ready;
}
