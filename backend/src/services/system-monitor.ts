import os from 'node:os';
import si from 'systeminformation';
import { config } from '../config.js';
import { bus } from '../core/events.js';
import { db } from '../db/index.js';
import { emulatorManager } from '../automation/emulator.js';
import { computeCapacity } from './capacity.js';

const GB = 1024 ** 3;
const round = (n: number, d = 1) => Number(n.toFixed(d));

export interface GpuInfo {
  model: string;
  vendor: string;
  vram_mb: number | null;
  utilization_pct: number | null;
  vram_used_mb: number | null;
  temperature_c: number | null;
  is_discrete: boolean;
}

export interface MetricsSnapshot {
  ts: string;
  cpu: { load_pct: number; per_core: number[]; speed_ghz: number | null; temperature_c: number | null };
  memory: { total_gb: number; used_gb: number; available_gb: number; used_pct: number; swap_used_gb: number; swap_total_gb: number };
  gpu: GpuInfo[];
  disk: { mount: string; size_gb: number; used_gb: number; free_gb: number; used_pct: number }[];
  processes: { backend_rss_mb: number; emulator_mem_gb: number | null; emulator_cpu_pct: number | null };
  emulators: { running: number; booted: number };
}

let staticInfo: Awaited<ReturnType<typeof collectStatic>> | null = null;
let latest: MetricsSnapshot | null = null;
const history: MetricsSnapshot[] = [];
const HISTORY_MAX = 180;

let gpuCache: GpuInfo[] = [];
let diskCache: MetricsSnapshot['disk'] = [];
let emuProcCache: { mem_gb: number | null; cpu: number | null } = { mem_gb: null, cpu: null };
let tick = 0;
let timer: NodeJS.Timeout | null = null;

async function collectStatic() {
  const [cpu, osInfo, system, graphics, memLayout] = await Promise.all([
    si.cpu(),
    si.osInfo(),
    si.system(),
    si.graphics().catch(() => ({ controllers: [] as si.Systeminformation.GraphicsControllerData[] })),
    si.memLayout().catch(() => [] as si.Systeminformation.MemLayoutData[]),
  ]);
  return {
    host: { hostname: os.hostname(), manufacturer: system.manufacturer, model: system.model },
    os: { platform: osInfo.platform, distro: osInfo.distro, release: osInfo.release, arch: osInfo.arch },
    cpu: {
      brand: `${cpu.manufacturer} ${cpu.brand}`.trim(),
      physical_cores: cpu.physicalCores,
      threads: cpu.cores,
      base_ghz: cpu.speed || null,
      max_ghz: cpu.speedMax || null,
      virtualization: cpu.virtualization ?? null,
    },
    memory: {
      total_gb: round(os.totalmem() / GB),
      modules: memLayout.filter((m) => m.size > 0).map((m) => ({ size_gb: round(m.size / GB), type: m.type, clock_mhz: m.clockSpeed })),
    },
    gpus: mapGpus(graphics.controllers),
    node: { version: process.version, pid: process.pid },
  };
}

function mapGpus(controllers: si.Systeminformation.GraphicsControllerData[]): GpuInfo[] {
  return controllers
    .filter((c) => c.model)
    .map((c) => {
      const vendor = c.vendor || '';
      const model = c.model || 'Unknown GPU';
      const discrete = /nvidia|geforce|rtx|gtx|radeon rx|arc a/i.test(`${vendor} ${model}`) && !/vega \d+ graphics|radeon\(tm\) graphics/i.test(model);
      return {
        model,
        vendor,
        vram_mb: c.memoryTotal ?? c.vram ?? null,
        utilization_pct: c.utilizationGpu ?? null,
        vram_used_mb: c.memoryUsed ?? null,
        temperature_c: c.temperatureGpu ?? null,
        is_discrete: discrete,
      };
    });
}

async function sample(): Promise<MetricsSnapshot> {
  tick++;
  const heavy = tick % 3 === 1; // GPU + emulator process every ~3 intervals (si.graphics is slow on Windows)
  const [load, mem, temp, speed] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.cpuTemperature().catch(() => ({ main: null as number | null })),
    si.cpuCurrentSpeed().catch(() => ({ avg: null as number | null })),
  ]);

  if (heavy) {
    const [g, procs] = await Promise.all([
      si.graphics().catch(() => null),
      si.processLoad('qemu-system-x86_64,qemu-system-x86_64-headless,emulator').catch(() => []),
    ]);
    if (g) gpuCache = mapGpus(g.controllers);
    const live = (procs as { cpu: number; mem: number; pids: number[] }[]).filter((p) => p.pids?.length);
    emuProcCache = live.length
      ? {
          mem_gb: round(live.reduce((s, p) => s + p.mem, 0) * (os.totalmem() / GB) / 100, 2),
          cpu: round(live.reduce((s, p) => s + p.cpu, 0)),
        }
      : { mem_gb: 0, cpu: 0 };
  }
  if (tick % 15 === 1) {
    const fs = await si.fsSize().catch(() => []);
    diskCache = fs
      .filter((d) => d.size > 5 * GB && d.size < 100_000 * GB && !/^\/(proc|sys|dev|run|snap|mnt\/attach)/.test(d.mount))
      .map((d) => ({
        mount: d.mount,
        size_gb: round(d.size / GB),
        used_gb: round(d.used / GB),
        free_gb: round(d.available / GB),
        used_pct: round(d.use),
      }));
  }

  const total = mem.total;
  const available = mem.available;
  const used = total - available;
  const emus = emulatorManager.list();

  return {
    ts: new Date().toISOString(),
    cpu: {
      load_pct: round(load.currentLoad),
      per_core: load.cpus.map((c) => round(c.load)),
      speed_ghz: speed.avg ?? null,
      temperature_c: temp.main ?? null,
    },
    memory: {
      total_gb: round(total / GB, 2),
      used_gb: round(used / GB, 2),
      available_gb: round(available / GB, 2),
      used_pct: round((used / total) * 100),
      swap_used_gb: round(mem.swapused / GB, 2),
      swap_total_gb: round(mem.swaptotal / GB, 2),
    },
    gpu: gpuCache,
    disk: diskCache,
    processes: {
      backend_rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      emulator_mem_gb: emuProcCache.mem_gb,
      emulator_cpu_pct: emuProcCache.cpu,
    },
    emulators: { running: emus.length, booted: emus.filter((e) => e.booted).length },
  };
}

function primaryGpu(gpus: GpuInfo[]) {
  return gpus.find((g) => g.is_discrete) ?? gpus[0] ?? null;
}

export const systemMonitor = {
  async start() {
    staticInfo = await collectStatic();
    gpuCache = staticInfo.gpus;
    const loop = async () => {
      try {
        latest = await sample();
        history.push(latest);
        if (history.length > HISTORY_MAX) history.shift();
        bus.publish({ event: 'metrics', data: { metrics: latest, capacity: this.capacity() } });
        if (tick % 15 === 0) persistSample(latest);
      } catch (err) {
        console.error('metrics sample failed', err);
      }
      timer = setTimeout(loop, config.METRICS_INTERVAL_MS);
    };
    await loop();
  },

  stop() {
    if (timer) clearTimeout(timer);
  },

  info() {
    return staticInfo;
  },

  latest() {
    return latest;
  },

  history(limit = HISTORY_MAX) {
    return history.slice(-limit);
  },

  capacity() {
    const gpu = primaryGpu(latest?.gpu.length ? latest.gpu : (staticInfo?.gpus ?? []));
    return computeCapacity({
      total_ram_gb: latest?.memory.total_gb ?? staticInfo?.memory.total_gb ?? os.totalmem() / GB,
      available_ram_gb: latest?.memory.available_gb ?? os.freemem() / GB,
      cpu_threads: staticInfo?.cpu.threads ?? os.cpus().length,
      cpu_physical_cores: staticInfo?.cpu.physical_cores ?? os.cpus().length,
      vram_mb: gpu?.is_discrete ? gpu.vram_mb : null,
      emulator_ram_mb: config.EMULATOR_RAM_MB,
      reserved_ram_gb: config.HOST_RESERVED_RAM_GB,
      running_emulators: emulatorManager.count(),
      configured_max: config.MAX_CONCURRENT_EMULATORS,
      gpu_mode: config.EMULATOR_GPU_MODE,
    });
  },
};

const insertSample = () =>
  db.prepare(
    'INSERT INTO metric_samples (ts, cpu_pct, mem_used_gb, mem_total_gb, gpu_pct, vram_used_mb, running_emulators) VALUES (?,?,?,?,?,?,?)',
  );

function persistSample(m: MetricsSnapshot) {
  const g = primaryGpu(m.gpu);
  insertSample().run(m.ts, m.cpu.load_pct, m.memory.used_gb, m.memory.total_gb, g?.utilization_pct ?? null, g?.vram_used_mb ?? null, m.emulators.running);
  db.prepare("DELETE FROM metric_samples WHERE ts < datetime('now', '-7 days')").run();
}
