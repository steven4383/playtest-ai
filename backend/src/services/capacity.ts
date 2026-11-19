/**
 * Capacity planning: how many Android emulators can this machine run at once?
 *
 * Rule of thumb from the architecture review:
 *   each concurrent emulator ~ guest RAM + ~0.75 GB host overhead (qemu, GPU buffers)
 *   + 2 CPU threads + ~250 MB VRAM (with -gpu host)
 *   keep HOST_RESERVED_RAM_GB free for Windows + Node + Appium + browser.
 * These are estimates. Measure on the target machine and tune the env vars.
 */

export interface CapacityInput {
  total_ram_gb: number;
  available_ram_gb: number;
  cpu_threads: number;
  cpu_physical_cores: number;
  vram_mb: number | null;
  emulator_ram_mb: number;
  reserved_ram_gb: number;
  running_emulators: number;
  configured_max: number;
  gpu_mode: string;
}

export type LimitingFactor = 'ram' | 'cpu' | 'vram';

export interface CapacityResult {
  per_emulator: { ram_gb: number; cpu_threads: number; vram_mb: number; disk_gb: string };
  limits: { ram: number; cpu: number; vram: number | null };
  recommended_concurrent: number;
  limiting_factor: LimitingFactor;
  configured_max: number;
  configured_exceeds_recommended: boolean;
  startable_now: number;
  can_start_now: boolean;
  status: 'comfortable' | 'tight' | 'insufficient';
  advice: string[];
  upgrade_paths: { ram_gb: number; concurrent: number; limited_by: LimitingFactor }[];
}

const EMU_HOST_OVERHEAD_GB = 0.75;
const EMU_VRAM_MB = 250;
const START_HEADROOM_GB = 1.0;

function limitsFor(totalGb: number, threads: number, vramMb: number | null, perEmuGb: number, reservedGb: number, gpuHost: boolean) {
  const ram = Math.max(0, Math.floor((totalGb - reservedGb) / perEmuGb));
  const cpu = Math.max(1, Math.floor(threads / 2) - 1);
  const vram = gpuHost && vramMb ? Math.max(1, Math.floor((vramMb * 0.85) / EMU_VRAM_MB)) : null;
  const candidates: [LimitingFactor, number][] = [
    ['ram', ram],
    ['cpu', cpu],
    ...(vram !== null ? ([['vram', vram]] as [LimitingFactor, number][]) : []),
  ];
  candidates.sort((a, b) => a[1] - b[1]);
  return { ram, cpu, vram, min: candidates[0][1], factor: candidates[0][0] };
}

export function computeCapacity(i: CapacityInput): CapacityResult {
  const perEmuGb = i.emulator_ram_mb / 1024 + EMU_HOST_OVERHEAD_GB;
  const gpuHost = i.gpu_mode === 'host';
  const l = limitsFor(i.total_ram_gb, i.cpu_threads, i.vram_mb, perEmuGb, i.reserved_ram_gb, gpuHost);

  // Sequential mode always allows one emulator; flag it when even that is tight.
  const recommended = Math.max(1, l.min);
  const startableNow = Math.max(0, Math.floor((i.available_ram_gb - START_HEADROOM_GB) / perEmuGb));

  let status: CapacityResult['status'] = 'comfortable';
  if (l.ram < 1) status = 'insufficient';
  else if (l.ram === 1 || i.available_ram_gb < perEmuGb + START_HEADROOM_GB) status = 'tight';

  const advice: string[] = [];
  if (status === 'insufficient')
    advice.push(
      `Only ${i.total_ram_gb.toFixed(1)} GB RAM: lower EMULATOR_RAM_MB to 1536, close Android Studio and other apps, run one emulator headless.`,
    );
  if (recommended === 1) advice.push('Run campaigns sequentially (one emulator at a time). Keep MAX_CONCURRENT_EMULATORS=1.');
  if (i.configured_max > recommended)
    advice.push(`MAX_CONCURRENT_EMULATORS=${i.configured_max} is above the recommended ${recommended}; expect paging and Appium timeouts.`);
  if (l.factor === 'cpu' && recommended > 1)
    advice.push(`CPU is the bottleneck (${i.cpu_threads} threads). More RAM will not add emulators beyond ${l.cpu}.`);
  if (!gpuHost) advice.push(`GPU mode is "${i.gpu_mode}": rendering runs on the CPU. Use EMULATOR_GPU_MODE=host with a discrete GPU.`);
  if (startableNow === 0 && i.running_emulators === 0)
    advice.push(`Available RAM is ${i.available_ram_gb.toFixed(1)} GB right now — free memory before starting an emulator.`);
  const upgrade_paths = [16, 32, 64]
    .filter((g) => g > i.total_ram_gb + 1)
    .map((g) => {
      const u = limitsFor(g * 0.96, i.cpu_threads, i.vram_mb, perEmuGb, i.reserved_ram_gb, gpuHost);
      return { ram_gb: g, concurrent: Math.max(1, u.min), limited_by: u.factor };
    });

  const next = upgrade_paths.find((u) => u.concurrent > recommended);
  if (l.factor === 'ram' && next)
    advice.push(`Upgrading to ${next.ram_gb} GB RAM would allow ${next.concurrent} emulators in parallel (then limited by ${next.limited_by.toUpperCase()}).`);

  return {
    per_emulator: {
      ram_gb: Number(perEmuGb.toFixed(2)),
      cpu_threads: 2,
      vram_mb: gpuHost ? EMU_VRAM_MB : 0,
      disk_gb: '6–10',
    },
    limits: { ram: l.ram, cpu: l.cpu, vram: l.vram },
    recommended_concurrent: recommended,
    limiting_factor: l.factor,
    configured_max: i.configured_max,
    configured_exceeds_recommended: i.configured_max > recommended,
    startable_now: startableNow,
    can_start_now: startableNow >= 1 && i.running_emulators < i.configured_max,
    status,
    advice,
    upgrade_paths,
  };
}

/** Campaign duration estimate (seconds ranges per step, sequential waves). */
export function estimateCampaign(opts: { devices: number; tests_per_device: number; concurrency: number; snapshot: boolean }) {
  const boot = opts.snapshot ? [10, 25] : [60, 150];
  const install = [5, 20];
  const session = opts.snapshot ? [5, 10] : [15, 40];
  const perTest = [20, 60];
  const cleanup = [5, 10];
  const perDevice = [0, 1].map(
    (k) => boot[k] + install[k] + session[k] + perTest[k] * opts.tests_per_device + cleanup[k],
  ) as [number, number];
  const concurrency = Math.max(1, Math.min(opts.concurrency, opts.devices || 1));
  const waves = Math.ceil(Math.max(1, opts.devices) / concurrency);
  // Parallel emulators share CPU, so each wave runs ~15% slower per extra emulator.
  const slowdown = 1 + 0.15 * (concurrency - 1);
  const total = perDevice.map((s) => Math.round(s * waves * slowdown)) as [number, number];
  return {
    per_device_seconds: perDevice,
    waves,
    concurrency,
    total_seconds: total,
    breakdown: { boot, install, session, per_test: perTest, cleanup },
  };
}
