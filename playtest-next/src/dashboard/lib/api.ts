export const API = '/api/v1';

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json', ...init?.headers } : init?.headers,
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Zod validation errors: show the first field message instead of a bare "Validation failed".
    const issue = Array.isArray(body.issues) ? body.issues[0]?.message : undefined;
    throw new Error(issue ?? body.error ?? `${res.status} ${res.statusText}`);
  }
  return body as T;
}

/** Start a profile's emulator. When the PC is short on free RAM the backend refuses — then ask before forcing it. Null = user said no. */
export async function startEmulatorProfile(id: string, query = ''): Promise<{ serial: string } | null> {
  const url = (force: boolean) => `/devices/${id}/start?${[query, force ? 'force=true' : ''].filter(Boolean).join('&')}`;
  try {
    return await api<{ serial: string }>(url(false), { method: 'POST', body: '{}' });
  } catch (e: any) {
    if (!/Not enough free RAM/.test(e?.message ?? '')) throw e;
    if (!confirm(`${e.message}\n\nStart anyway? The PC may slow down while it runs.`)) return null;
    return api<{ serial: string }>(url(true), { method: 'POST', body: '{}' });
  }
}

export interface GpuInfo {
  model: string;
  vendor: string;
  vram_mb: number | null;
  utilization_pct: number | null;
  vram_used_mb: number | null;
  temperature_c: number | null;
  is_discrete: boolean;
}

export interface Metrics {
  ts: string;
  cpu: { load_pct: number; per_core: number[]; speed_ghz: number | null; temperature_c: number | null };
  memory: { total_gb: number; used_gb: number; available_gb: number; used_pct: number; swap_used_gb: number; swap_total_gb: number };
  gpu: GpuInfo[];
  disk: { mount: string; size_gb: number; used_gb: number; free_gb: number; used_pct: number }[];
  processes: { backend_rss_mb: number; emulator_mem_gb: number | null; emulator_cpu_pct: number | null };
  emulators: { running: number; booted: number };
}

export interface Capacity {
  per_emulator: { ram_gb: number; cpu_threads: number; vram_mb: number; disk_gb: string };
  limits: { ram: number; cpu: number; vram: number | null };
  recommended_concurrent: number;
  limiting_factor: 'ram' | 'cpu' | 'vram';
  configured_max: number;
  configured_exceeds_recommended: boolean;
  startable_now: number;
  can_start_now: boolean;
  status: 'comfortable' | 'tight' | 'insufficient';
  advice: string[];
  upgrade_paths: { ram_gb: number; concurrent: number; limited_by: string }[];
}

export interface SystemInfo {
  host: { hostname: string; manufacturer: string; model: string };
  os: { platform: string; distro: string; release: string; arch: string };
  cpu: { brand: string; physical_cores: number; threads: number; base_ghz: number | null; max_ghz: number | null; virtualization: boolean | null };
  memory: { total_gb: number; modules: { size_gb: number; type: string; clock_mhz: number | null }[] };
  gpus: GpuInfo[];
  node: { version: string; pid: number };
  limits: { max_concurrent_emulators: number; emulator_ram_mb: number; emulator_gpu_mode: string; reserved_ram_gb: number };
}

export interface Estimate {
  per_device_seconds: [number, number];
  waves: number;
  concurrency: number;
  total_seconds: [number, number];
}

export interface Device {
  id: string;
  name: string;
  type: 'emulator' | 'physical' | 'remote';
  android_version: string | null;
  api_level: number | null;
  avd_name: string | null;
  adb_serial: string | null;
  resolution: string | null;
  ram_mb: number | null;
  enabled: boolean;
  priority: number;
  status: string;
  last_health_check: string | null;
  last_error: string | null;
  running: { serial: string; booted: boolean; started_at: string; ram_mb: number } | null;
}

export interface ToolStatus {
  sdk_root: string | null;
  adb: { available: boolean; version: string | null; error?: string };
  emulator: { available: boolean; version: string | null; error?: string };
  aapt: string | null;
  sdkmanager: string | null;
  avdmanager: string | null;
  java_home: string | null;
  host_abi: string;
}

export interface AdbDevice {
  serial: string;
  state: string; // device | offline | unauthorized | no permissions
  model?: string;
  product?: string;
  device?: string;
  is_emulator: boolean;
  connection: 'usb' | 'wifi' | 'emulator';
  profile_id: string | null;
  avd_name: string | null;
  busy: boolean;
}

export interface SystemImage {
  package: string;
  api_level: number | null;
  api_id: string;
  android_version: string | null;
  tag: string;
  tag_label: string;
  abi: string;
  description: string | null;
  version: string | null;
  installed: boolean;
  host_compatible: boolean;
  /** Download size from Google's repository index. */
  download_bytes?: number | null;
  /** Size on disk (installed images). */
  disk_bytes?: number | null;
  /** AVDs that boot from this image (installed images). */
  used_by?: string[];
}

export interface AvdLocation {
  name: string;
  ini_path: string;
  data_path: string;
  size_bytes: number;
  in_storage_dir: boolean;
  in_use: boolean;
  exists: boolean;
  /** System image package the AVD boots. */
  image: string | null;
  /** Bytes "Wipe data" frees (user data, cache, snapshots). */
  wipeable_bytes: number;
  snapshot_bytes: number;
  ram_mb: number | null;
  /** disk.dataPartition.size as written in config.ini (bytes or e.g. "6G"). */
  data_partition: string | null;
}

export interface StorageInfo {
  avd_storage_dir: string | null;
  avd_home: string;
  effective_dir: string;
  effective_free_gb: number | null;
  sdk_root: string | null;
  sdk_free_gb: number | null;
  avds: AvdLocation[];
  total_avd_bytes: number;
  images: ImagesLocation | null;
}

export interface ImagesLocation {
  dir: string | null;
  sdk_path: string;
  free_gb: number | null;
  images: { package: string; rel: string[]; sdk_path: string; real_path: string; linked: boolean; size_bytes: number }[];
  in_sdk_bytes: number;
  elsewhere_bytes: number;
}

export interface QrSession {
  id: string;
  service_name: string;
  qr_svg: string;
  status: 'waiting' | 'pairing' | 'connecting' | 'connected' | 'failed' | 'expired' | 'cancelled';
  message: string;
  device_address: string | null;
  serial: string | null;
  created_at: string;
  expires_at: string;
}

export interface SdkJob {
  id: string;
  kind: 'install_image' | 'uninstall_image' | 'create_avd' | 'provision' | 'move_avds' | 'move_images';
  title: string;
  status: 'queued' | 'running' | 'done' | 'error';
  step: string;
  progress: number | null;
  message: string | null;
  log: string[];
  created_at: string;
  finished_at: string | null;
  result?: Record<string, unknown>;
}

export type CampaignStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'CANCELLED' | 'INTERRUPTED';
export type ExecutionStatus = 'queued' | 'running' | 'passed' | 'failed' | 'error' | 'skipped' | 'cancelled';

export interface CampaignConfig {
  name?: string;
  apk_id: string;
  device_ids: string[];
  mode: 'sequential' | 'parallel';
  concurrency: number;
  flow: 'open_close';
  launch_wait_seconds: number;
  cycles: number;
  fresh_install: boolean;
  uninstall_after: boolean;
  stop_emulators_after: boolean;
}

export interface CampaignSummary {
  total: number;
  passed: number;
  failed: number;
  error: number;
  skipped: number;
  cancelled: number;
  running: number;
  queued: number;
}

export interface CampaignListItem {
  id: string;
  paused?: boolean;
  name: string;
  status: CampaignStatus;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  config: CampaignConfig | null;
  summary: CampaignSummary | null;
  package_name: string | null;
  version_name: string | null;
  filename: string | null;
}

export interface ExecutionStep {
  id: string;
  step_number: number;
  name: string;
  status: 'running' | 'passed' | 'failed' | 'skipped' | 'error';
  actual_result: string | null;
  duration_ms: number | null;
  started_at: string | null;
}

export interface Execution {
  id: string;
  device_id: string;
  device_name: string | null;
  serial: string | null;
  status: ExecutionStatus;
  started_at: string | null;
  completed_at: string | null;
  error_summary: string | null;
  metrics: { launch_times_ms?: number[]; avg_launch_ms?: number; install_ms?: number; crash?: string; android_version?: string; api_level?: number; model?: string; slow_start?: boolean } | null;
  steps: ExecutionStep[];
  artifacts: { id: string; type: string; created_at: string }[];
}

export interface Campaign extends CampaignListItem {
  min_sdk: number | null;
  active: boolean;
  executions: Execution[];
}

export type BugSeverity = 'critical' | 'high' | 'medium' | 'low';
export type BugStatus = 'open' | 'confirmed' | 'fixed' | 'ignored';
export interface Bug {
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
  severity: BugSeverity;
  category: string;
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
export interface BugDetail extends Bug {
  occurrences: { id: string; execution_id: string; campaign_id: string; device_name: string; android_version: string | null; created_at: string; status: BugStatus }[];
}
export interface BugStats {
  open: number;
  by_severity: Partial<Record<BugSeverity, number>>;
}

export interface ReportDevice {
  execution_id: string;
  device_id: string;
  device_name: string | null;
  type: string | null;
  model: string | null;
  android_version: string | null;
  api_level: number | null;
  resolution: string | null;
  ram_mb: number | null;
  status: ExecutionStatus;
  error_summary: string | null;
  duration_ms: number | null;
  install_ms: number | null;
  avg_launch_ms: number | null;
  slow_start: boolean;
  steps: ExecutionStep[];
  evidence: { id: string; type: string; created_at: string }[];
  bugs: string[];
}
export interface Report {
  generated_at: string;
  campaign: { id: string; name: string; status: CampaignStatus; created_at: string; started_at: string | null; completed_at: string | null; duration_ms: number | null; config: CampaignConfig | null };
  apk: { filename: string; package_name: string | null; version_name: string | null; version_code: number | null; min_sdk: number | null; target_sdk: number | null; size_bytes: number; sha256: string } | null;
  totals: CampaignSummary & { pass_rate: number | null };
  devices: ReportDevice[];
  bugs: Omit<Bug, 'excerpt' | 'steps' | 'evidence'>[];
}
export interface ReportsOverview {
  runs: number;
  executions: number;
  by_status: Record<string, number>;
  pass_rate: number | null;
  bugs: BugStats;
  recent: { id: string; name: string; status: CampaignStatus; created_at: string; package_name: string | null; version_name: string | null; summary: CampaignSummary | null }[];
  per_device: { device_id: string; device_name: string; passed: number; failed: number; error: number; total: number; last_run: string }[];
}
export interface EmulatorSpeed {
  acceleration: { ok: boolean; detail: string };
  gpu_mode: string;
  cores: number;
  ram_mb: number;
  fast_boot: boolean;
  headless_default: boolean;
  host_threads: number;
  /** Last measured boot time per AVD and boot kind, in seconds. */
  boot_times?: Record<string, Partial<Record<'fast' | 'cold' | 'first', number>>>;
}

/** Emulator boot progress (0-100) from GET /emulators/boot and `boot_progress` events. */
export interface BootProgress {
  device_id: string;
  serial: string;
  avd_name: string;
  progress: number;
  phase: string | null;
  mode: 'fast' | 'cold' | 'first' | null;
  elapsed_s: number;
  eta_s: number | null;
  booted: boolean;
}

export interface MemProcess {
  name: string;
  package: string | null;
  pid: number | null;
  mb: number;
  group: string;
  closable: boolean;
}

/** RAM of one device (GET /adb/devices/:serial/memory). */
export interface DeviceMemory {
  serial: string;
  total_mb: number | null;
  available_mb: number | null;
  used_pct: number | null;
  swap_total_mb: number;
  swap_used_mb: number;
  groups: { name: string; mb: number }[];
  top: MemProcess[];
  closable: { package: string; mb: number; processes: number; group: string }[];
  closable_mb: number;
  foreground: string | null;
  busy: boolean;
}

export interface FreeMemoryResult {
  before_mb: number | null;
  after_mb: number | null;
  freed_mb: number | null;
  stopped: string[];
  skipped: string[];
}

/** RAM of this PC, per emulator and per app (GET /system/ram). */
export interface HostRam {
  total_mb: number;
  available_mb: number;
  used_pct: number | null;
  emulators: {
    device_id: string;
    avd_name: string;
    serial: string;
    booted: boolean;
    headless: boolean | null;
    adopted: boolean;
    pid: number | null;
    mem_mb: number | null;
    guest_ram_mb: number;
    idle_s: number;
    busy: boolean;
    flutter: boolean;
  }[];
  top: { label: string; mb: number; count: number; tip?: string }[];
  idle_stop_minutes: number;
}

export interface LlmStatus {
  provider: string;
  provider_label: string;
  model: string;
  default_model: string;
  configured: boolean;
  key_hint: string | null;
  get_key_url: string;
}

export interface LlmModel {
  id: string;
  display_name: string;
  input_token_limit: number | null;
  output_token_limit: number | null;
}

export interface LlmTestResult {
  text: string;
  model: string;
  finish_reason: string | null;
  usage: { input_tokens: number | null; output_tokens: number | null };
  latency_ms: number;
}

export interface Apk {
  id: string;
  filename: string;
  package_name: string | null;
  version_name: string | null;
  version_code: number | null;
  min_sdk: number | null;
  target_sdk: number | null;
  size_bytes: number;
  sha256: string;
  metadata_source: string;
  created_at: string;
  duplicate_of?: string | null;
}

export const fmtDuration = (s: number) => {
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

export const fmtBytes = (b: number) =>
  b > 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : b > 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`;

// ---------- developer tools (one connected device) ----------

export interface DeviceInfo {
  serial: string;
  connection: 'usb' | 'wifi' | 'emulator';
  manufacturer: string | null;
  brand: string | null;
  model: string | null;
  device: string | null;
  android_version: string | null;
  api_level: number | null;
  security_patch: string | null;
  build_id: string | null;
  fingerprint: string | null;
  abis: string[];
  hardware: string | null;
  screen: { physical: string | null; override: string | null; density: number | null; density_override: number | null };
  battery: { level: number | null; status: string | null; temperature_c: number | null; plugged: string[] };
  memory: { total_mb: number | null; available_mb: number | null };
  storage: { total_mb: number | null; free_mb: number | null };
  wifi_ip: string | null;
  uptime_s: number | null;
  is_emulator: boolean;
}

export interface AppEntry {
  package: string;
  version_code: number | null;
  uid: number | null;
  system: boolean;
}

export interface AppDetails {
  package: string;
  version_name: string | null;
  version_code: number | null;
  min_sdk: number | null;
  target_sdk: number | null;
  first_install: string | null;
  last_update: string | null;
  installer: string | null;
  debuggable: boolean;
  running_pid: number | null;
  apk_paths: string[];
  split_apks: boolean;
  app_locale: string | null;
  permissions: { runtime: { name: string; granted: boolean }[]; install: string[]; requested: string[] };
}

export type PerfSample =
  | { running: false; at: number }
  | {
      running: true;
      at: number;
      pid: number;
      proc_ticks: number | null;
      total_ticks: number | null;
      cpu_pct: number | null;
      cores: number | null;
      pss_kb: number | null;
      frames: number | null;
      janky_frames: number | null;
    };

export interface LogLine {
  ts: string;
  pid: number;
  tid: number;
  level: string;
  tag: string;
  msg: string;
}

export interface Toggle {
  id: string;
  label: string;
  group: 'display' | 'debug' | 'power' | 'network';
  hint: string | null;
  options: { value: string; label: string }[];
  value: string | null;
  disabled: string | null;
}

export interface Recording {
  id: string;
  serial: string;
  title: string;
  started_at: string;
  ended_at: string | null;
  size_bytes: number;
}

export interface RecordingStatus {
  active: boolean;
  id?: string;
  state?: 'recording' | 'saving';
  started_at?: string;
  seconds?: number;
}

export interface RemoteFile {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  modified: string | null;
}

export const dev = (serial: string, path = '') => `/adb/devices/${encodeURIComponent(serial)}${path}`;
