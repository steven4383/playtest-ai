import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import { writeEnv } from '../core/env-file.js';
import { bus } from '../core/events.js';
import { newId } from '../db/index.js';
import { emulatorManager } from './emulator.js';
import { avdHome, hostAbi, runSdkTool, sdkRoot, tools } from './sdk.js';

const isWin = process.platform === 'win32';

/** Download system images and create AVDs from the dashboard (sdkmanager + avdmanager). */

export interface SystemImage {
  package: string; // system-images;android-35;google_apis;x86_64
  api_level: number | null;
  api_id: string; // android-35, android-36.1 …
  android_version: string | null;
  tag: string;
  tag_label: string;
  abi: string;
  description: string | null;
  version: string | null;
  installed: boolean;
  host_compatible: boolean;
  /** Download size from Google's repository index (null = unknown). */
  download_bytes?: number | null;
  /** Size on disk, for installed images. */
  disk_bytes?: number | null;
}

export interface SdkJob {
  id: string;
  kind: 'install_image' | 'create_avd' | 'provision' | 'move_avds' | 'move_images';
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

const PKG_RE = /^system-images;android-[\w.-]+;[\w-]+;(x86_64|x86|arm64-v8a|armeabi-v7a)$/;
const AVD_RE = /^[\w.-]{1,80}$/;
const HW_RE = /^[\w .()-]{1,60}$/;
const MIN_FREE_DISK_GB = 6;
const MIN_AVD_FREE_GB = 3;

/** Where new AVD data folders go (AVD_STORAGE_DIR). null = avdmanager default (~/.android/avd). */
const avdStorage: { dir: string | null } = { dir: config.AVD_STORAGE_DIR ? path.resolve(config.AVD_STORAGE_DIR) : null };
/** Where system images are kept (SYSTEM_IMAGES_DIR). null = inside the SDK as usual. */
const imagesStorage: { dir: string | null } = { dir: config.SYSTEM_IMAGES_DIR ? path.resolve(config.SYSTEM_IMAGES_DIR) : null };

export interface AvdLocation {
  name: string;
  ini_path: string;
  data_path: string;
  size_bytes: number;
  in_storage_dir: boolean;
  in_use: boolean;
  exists: boolean;
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

export interface ImageLeaf {
  package: string;
  rel: string[]; // [api, tag, abi]
  sdk_path: string;
  real_path: string;
  linked: boolean;
}

export interface ImagesLocation {
  /** SYSTEM_IMAGES_DIR, or null = images stay inside the SDK. */
  dir: string | null;
  sdk_path: string;
  free_gb: number | null;
  images: (ImageLeaf & { size_bytes: number })[];
  /** Images still physically inside the SDK folder (e.g. a download that has not been moved yet). */
  in_sdk_bytes: number;
  elsewhere_bytes: number;
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) total += (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

const samePath = (a: string, b: string) => (isWin ? a.toLowerCase() === b.toLowerCase() : a === b);
const sameDrive = (a: string, b: string) => samePath(path.parse(path.resolve(a)).root, path.parse(path.resolve(b)).root);

/** A running emulator (ours or Android Studio's) leaves *.lock entries in the AVD folder. */
function avdLocked(dataPath: string): boolean {
  try {
    return fs.readdirSync(dataPath).some((n) => n.endsWith('.lock'));
  } catch {
    return false;
  }
}

/** Copy a folder tree, reporting bytes as they are written. */
async function copyDir(src: string, dst: string, onBytes: (n: number) => void) {
  await fsp.mkdir(dst, { recursive: true });
  for (const e of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) await copyDir(s, d, onBytes);
    else if (e.isFile()) {
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          onBytes(chunk.length);
          cb(null, chunk);
        },
      });
      await pipeline(fs.createReadStream(s), counter, fs.createWriteStream(d));
    }
  }
}

/** Point an AVD .ini at its new data folder (path.rel would point back at the default home, so drop it). */
function rewriteIni(iniPath: string, dataPath: string) {
  const text = fs.readFileSync(iniPath, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/).filter((l) => l && !l.startsWith('path=') && !l.startsWith('path.rel='));
  lines.splice(1, 0, `path=${dataPath}`);
  fs.writeFileSync(iniPath, lines.join(eol) + eol);
}

export const ANDROID_NAMES: Record<number, string> = {
  21: '5.0', 22: '5.1', 23: '6.0', 24: '7.0', 25: '7.1', 26: '8.0', 27: '8.1', 28: '9', 29: '10',
  30: '11', 31: '12', 32: '12L', 33: '13', 34: '14', 35: '15', 36: '16', 37: '17',
};
const TAG_LABELS: Record<string, string> = {
  default: 'AOSP',
  google_apis: 'Google APIs',
  google_apis_playstore: 'Google Play',
  google_atd: 'Automated Test Device',
  aosp_atd: 'AOSP Test Device',
};

function parsePackage(pkg: string): Omit<SystemImage, 'description' | 'version' | 'installed'> | null {
  const [kind, apiId, tag, abi] = pkg.split(';');
  if (kind !== 'system-images' || !apiId || !tag || !abi) return null;
  const n = Number(apiId.match(/^android-(\d+)/)?.[1]);
  const api = Number.isNaN(n) ? null : n;
  return {
    package: pkg,
    api_level: api,
    api_id: apiId,
    android_version: api ? (ANDROID_NAMES[api] ?? null) : null,
    tag,
    tag_label: TAG_LABELS[tag] ?? tag.replace(/_/g, ' '),
    abi,
    host_compatible: abi === hostAbi() || (hostAbi() === 'x86_64' && abi === 'x86'),
  };
}

const requireTool = (name: 'sdkmanager' | 'avdmanager') => {
  const bin = tools[name]();
  if (!bin) throw Object.assign(new Error(`${name} not found — install "Android SDK Command-line Tools (latest)" from Android Studio → SDK Manager → SDK Tools`), { statusCode: 412 });
  return bin;
};

// ---------- jobs ----------

const jobs = new Map<string, SdkJob>();
let queue: Promise<void> = Promise.resolve();

const publicJob = (j: SdkJob) => ({ ...j, log: j.log.slice(-12) });
function publish(job: SdkJob) {
  bus.publish({ event: 'sdk_job', data: { job: publicJob(job) } });
}

function enqueue(kind: SdkJob['kind'], title: string, work: (job: SdkJob, update: (p: Partial<SdkJob>) => void) => Promise<Record<string, unknown> | void>): SdkJob {
  const job: SdkJob = {
    id: newId('job'),
    kind,
    title,
    status: 'queued',
    step: 'Waiting for the previous SDK job',
    progress: null,
    message: null,
    log: [],
    created_at: new Date().toISOString(),
    finished_at: null,
  };
  jobs.set(job.id, job);
  // keep the last 20 jobs
  for (const id of [...jobs.keys()].slice(0, Math.max(0, jobs.size - 20))) jobs.delete(id);

  // Only push an SSE event when something visible changed (sdkmanager prints many identical progress lines).
  let lastSig = '';
  const update = (p: Partial<SdkJob>) => {
    Object.assign(job, p);
    const sig = `${job.status}|${job.step}|${job.progress === null ? '-' : Math.floor(job.progress)}|${job.message}`;
    if (sig === lastSig) return;
    lastSig = sig;
    publish(job);
  };

  publish(job);
  queue = queue.then(async () => {
    update({ status: 'running', step: 'Starting' });
    try {
      const result = await work(job, update);
      update({ status: 'done', step: 'Finished', progress: 100, finished_at: new Date().toISOString(), result: result ?? undefined });
    } catch (err: any) {
      update({ status: 'error', step: 'Failed', message: err?.message ?? String(err), finished_at: new Date().toISOString() });
    }
  });
  return job;
}

function lineLogger(job: SdkJob, update: (p: Partial<SdkJob>) => void, stepPrefix = '') {
  return (line: string) => {
    job.log.push(line);
    if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
    const m = line.match(/(\d{1,3})%\s*(.*)$/);
    if (m) update({ progress: Math.min(100, Number(m[1])), step: `${stepPrefix}${m[2]?.trim() || 'Working'}`.slice(0, 140) });
  };
}

function freeDiskGb(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return (s.bavail * s.bsize) / 1024 ** 3;
  } catch {
    return null;
  }
}

// ---------- catalog ----------

let catalogCache: { at: number; images: SystemImage[] } | null = null;
let definitionsCache: string[] | null = null;

export const sdkManager = {
  /** Installed images with their size on disk (walks the folders — a few hundred ms). */
  async installedImagesWithSize(): Promise<SystemImage[]> {
    const root = sdkRoot();
    const list = this.installedImages();
    if (!root) return list;
    const sizes = await repoSizes().catch(() => new Map<string, number>());
    return Promise.all(
      list.map(async (i) => {
        const [, api, tag, abi] = i.package.split(';');
        return { ...i, disk_bytes: await dirSize(path.join(root, 'system-images', api, tag, abi)), download_bytes: sizes.get(i.package) ?? null };
      }),
    );
  },

  /** Fast: scans <sdk>/system-images on disk, no network. */
  installedImages(): SystemImage[] {
    const root = sdkRoot();
    if (!root) return [];
    const base = path.join(root, 'system-images');
    if (!fs.existsSync(base)) return [];
    const out: SystemImage[] = [];
    for (const api of fs.readdirSync(base)) {
      const apiDir = path.join(base, api);
      if (!fs.statSync(apiDir).isDirectory()) continue;
      for (const tag of fs.readdirSync(apiDir)) {
        const tagDir = path.join(apiDir, tag);
        if (!fs.statSync(tagDir).isDirectory()) continue;
        for (const abi of fs.readdirSync(tagDir)) {
          const dir = path.join(tagDir, abi);
          if (!fs.existsSync(path.join(dir, 'system.img'))) continue;
          const parsed = parsePackage(`system-images;${api};${tag};${abi}`);
          if (!parsed) continue;
          const props = fs.existsSync(path.join(dir, 'source.properties')) ? fs.readFileSync(path.join(dir, 'source.properties'), 'utf8') : '';
          out.push({
            ...parsed,
            description: null,
            version: props.match(/^Pkg\.Revision=(.+)$/m)?.[1]?.trim() ?? null,
            installed: true,
          });
        }
      }
    }
    return out.sort((a, b) => (b.api_level ?? 0) - (a.api_level ?? 0) || a.tag.localeCompare(b.tag));
  },

  /** Slow (fetches Google's repository, ~10–40 s): every downloadable system image. Cached 15 min. */
  async catalog(refresh = false): Promise<SystemImage[]> {
    if (!refresh && catalogCache && Date.now() - catalogCache.at < 15 * 60_000) {
      const installed = new Set(this.installedImages().map((i) => i.package));
      return catalogCache.images.map((i) => ({ ...i, installed: installed.has(i.package) }));
    }
    const r = await runSdkTool(requireTool('sdkmanager'), ['--list'], { timeoutMs: 180_000 });
    if (!r.ok) throw Object.assign(new Error(`sdkmanager --list failed: ${r.error}`), { statusCode: 502 });
    const byPkg = new Map<string, SystemImage>();
    for (const raw of r.stdout.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line.startsWith('system-images;')) continue;
      const [pkg, version, description] = line.split('|').map((s) => s.trim());
      const parsed = parsePackage(pkg);
      if (!parsed || byPkg.has(pkg)) continue;
      byPkg.set(pkg, { ...parsed, version: version ?? null, description: description ?? null, installed: false });
    }
    const installed = new Set(this.installedImages().map((i) => i.package));
    const images = [...byPkg.values()]
      .map((i) => ({ ...i, installed: installed.has(i.package) }))
      .sort((a, b) => (b.api_level ?? 0) - (a.api_level ?? 0) || a.tag.localeCompare(b.tag) || a.abi.localeCompare(b.abi));
    const sizes = await repoSizes().catch(() => new Map<string, number>());
    for (const i of images) i.download_bytes = sizes.get(i.package) ?? null;
    catalogCache = { at: Date.now(), images };
    return images;
  },

  /** Hardware profiles avdmanager knows (pixel_8, pixel_tablet, "Nexus 5X" …). */
  async deviceDefinitions(): Promise<string[]> {
    if (definitionsCache) return definitionsCache;
    const r = await runSdkTool(requireTool('avdmanager'), ['list', 'device', '-c'], { timeoutMs: 60_000 });
    if (!r.ok) throw Object.assign(new Error(`avdmanager list device failed: ${r.error}`), { statusCode: 502 });
    definitionsCache = r.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && HW_RE.test(s) && !/^(automotive|wearos|tv_|desktop)/.test(s));
    return definitionsCache;
  },

  jobs(): ReturnType<typeof publicJob>[] {
    return [...jobs.values()].reverse().map(publicJob);
  },

  job(id: string) {
    const j = jobs.get(id);
    return j ? { ...j } : null;
  },

  // ---------- actions ----------

  installImage(pkg: string, opts: { force?: boolean } = {}): SdkJob {
    if (!PKG_RE.test(pkg)) throw Object.assign(new Error(`Invalid system image package: ${pkg}`), { statusCode: 400 });
    const bin = requireTool('sdkmanager');
    this.assertDisk(opts.force);
    return enqueue('install_image', `Download ${pkg}`, async (job, update) => {
      await doInstall(bin, pkg, job, update);
      await moveNewImage(pkg, job, update);
      return { package: pkg };
    });
  },

  /** `onDone` runs after the AVD exists (e.g. to add a device profile); its failure is logged, not fatal. */
  createAvd(input: { name: string; package: string; device: string }, onDone?: () => void): SdkJob {
    validateAvdInput(input);
    const bin = requireTool('avdmanager');
    return enqueue('create_avd', `Create AVD ${input.name}`, async (job, update) => {
      await doCreateAvd(bin, input, job, update);
      try {
        onDone?.();
      } catch (err: any) {
        job.log.push(`AVD created, but follow-up step failed: ${err?.message}`);
      }
      return { avd_name: input.name };
    });
  },

  /**
   * One click for a device profile whose AVD does not exist yet:
   * reuse an installed image with the same API level, otherwise download
   * the Google APIs image, then create the AVD under the profile's avd_name.
   */
  async provision(profile: { name: string; avd_name: string; api_level: number }, opts: { force?: boolean } = {}): Promise<SdkJob> {
    if (!AVD_RE.test(profile.avd_name)) throw Object.assign(new Error(`Invalid AVD name: ${profile.avd_name}`), { statusCode: 400 });
    const avdBin = requireTool('avdmanager');
    const sdkBin = requireTool('sdkmanager');
    const installed = this.installedImages().filter((i) => i.api_level === profile.api_level && i.host_compatible);
    const rank = (tag: string) => {
      const i = ['google_apis', 'google_apis_playstore', 'default'].indexOf(tag);
      return i === -1 ? 99 : i;
    };
    installed.sort((a, b) => rank(a.tag) - rank(b.tag));
    const image = installed[0]?.package ?? `system-images;android-${profile.api_level};google_apis;${hostAbi()}`;
    if (!installed.length) this.assertDisk(opts.force);
    const definitions = await this.deviceDefinitions().catch(() => [] as string[]);
    const hardware = guessHardware(profile, definitions);

    return enqueue('provision', `Set up ${profile.name}`, async (job, update) => {
      if (!installed.length) {
        update({ step: `Downloading ${image}` });
        await doInstall(sdkBin, image, job, update);
        await moveNewImage(image, job, update);
      } else {
        job.log.push(`Using installed image ${image}`);
      }
      update({ step: `Creating AVD ${profile.avd_name} (${hardware})`, progress: null });
      await doCreateAvd(avdBin, { name: profile.avd_name, package: image, device: hardware }, job, update);
      return { avd_name: profile.avd_name, package: image, device: hardware };
    });
  },

  async deleteAvd(name: string) {
    if (!AVD_RE.test(name)) throw Object.assign(new Error(`Invalid AVD name: ${name}`), { statusCode: 400 });
    if (emulatorManager.list().some((r) => r.avd_name === name))
      throw Object.assign(new Error('Stop the running emulator before deleting its AVD'), { statusCode: 409 });
    const r = await runSdkTool(requireTool('avdmanager'), ['delete', 'avd', '-n', name], { timeoutMs: 60_000 });
    if (!r.ok) throw Object.assign(new Error(`avdmanager delete failed: ${r.error}`), { statusCode: 502 });
    return { deleted: name };
  },

  // ---------- AVD storage location ----------

  /** Every AVD the emulator knows (from the .ini files in the AVD home), where its data lives and how big it is. */
  async avdLocations(): Promise<AvdLocation[]> {
    const home = avdHome();
    if (!fs.existsSync(home)) return [];
    const running = new Set(emulatorManager.list().map((r) => r.avd_name));
    const out: AvdLocation[] = [];
    for (const f of fs.readdirSync(home).filter((n) => n.endsWith('.ini'))) {
      const iniPath = path.join(home, f);
      const name = f.slice(0, -4);
      const ini = fs.readFileSync(iniPath, 'utf8');
      const p = ini.match(/^path=(.+)$/m)?.[1]?.trim();
      const rel = ini.match(/^path\.rel=(.+)$/m)?.[1]?.trim();
      const dataPath = p && fs.existsSync(p) ? p : rel ? path.join(path.dirname(home), rel) : path.join(home, `${name}.avd`);
      const exists = fs.existsSync(dataPath);
      out.push({
        name,
        ini_path: iniPath,
        data_path: dataPath,
        size_bytes: exists ? await dirSize(dataPath) : 0,
        in_storage_dir: !!avdStorage.dir && samePath(path.dirname(path.resolve(dataPath)), avdStorage.dir),
        in_use: running.has(name) || (exists && avdLocked(dataPath)),
        exists,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  },

  async storageInfo(): Promise<StorageInfo> {
    const root = sdkRoot();
    const home = avdHome();
    const target = avdStorage.dir ?? home;
    const avds = await this.avdLocations();
    return {
      avd_storage_dir: avdStorage.dir,
      avd_home: home,
      effective_dir: target,
      effective_free_gb: freeDiskGb(fs.existsSync(target) ? target : path.parse(target).root),
      sdk_root: root,
      sdk_free_gb: root ? freeDiskGb(root) : null,
      avds,
      total_avd_bytes: avds.reduce((s, a) => s + a.size_bytes, 0),
      images: await imagesLocation(),
    };
  },

  /**
   * Keep system images on another drive (e.g. M:\\Android\\system-images). Each installed image moves there and
   * <sdk>\\system-images\\<api>\\<tag>\\<abi> becomes a junction to it — sdkmanager, the emulator and Android Studio
   * follow it transparently. New downloads are moved there automatically after sdkmanager finishes.
   * null = move every image back into the SDK.
   */
  async setImagesStorage(dirInput: string | null): Promise<{ storage: StorageInfo; job: SdkJob | null }> {
    const root = sdkRoot();
    if (!root) throw Object.assign(new Error('Android SDK not found'), { statusCode: 412 });
    if (!isWin) throw Object.assign(new Error('A separate system images folder is supported on Windows only'), { statusCode: 400 });
    let dir: string | null = null;
    if (dirInput && dirInput.trim()) {
      const raw = dirInput.trim();
      if (!path.isAbsolute(raw)) throw Object.assign(new Error('Use a full path, e.g. M:\\Android\\system-images'), { statusCode: 400 });
      dir = path.resolve(raw);
      if (!/^[\w .:()\\\/-]+$/.test(dir)) throw Object.assign(new Error('Folder path may only contain letters, digits, spaces and . _ - ( )'), { statusCode: 400 });
      if (!fs.existsSync(path.parse(dir).root)) throw Object.assign(new Error(`Drive ${path.parse(dir).root} does not exist`), { statusCode: 400 });
      if (samePath(dir, root) || dir.toLowerCase().startsWith(root.toLowerCase() + path.sep))
        throw Object.assign(new Error('Pick a folder outside the Android SDK'), { statusCode: 400 });
      if (avdStorage.dir && (samePath(dir, avdStorage.dir) || dir.toLowerCase().startsWith(avdStorage.dir.toLowerCase() + path.sep)))
        throw Object.assign(new Error('Use a different folder than the AVD folder'), { statusCode: 400 });
      try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, `.playtest-write-test-${process.pid}`);
        fs.writeFileSync(probe, 'ok');
        fs.rmSync(probe);
      } catch (err: any) {
        throw Object.assign(new Error(`Cannot write to ${dir}: ${err.code ?? err.message}`), { statusCode: 400 });
      }
    }
    const pending = imageLeaves(root).filter((l) => (dir ? !l.linked || !samePath(l.real_path, path.join(dir, ...l.rel)) : l.linked));
    if (pending.length && emulatorManager.list().length)
      throw Object.assign(new Error('Stop all running emulators first — their system image files are in use'), { statusCode: 409 });
    imagesStorage.dir = dir;
    writeEnv({ SYSTEM_IMAGES_DIR: dir ?? '' });
    const job = pending.length
      ? enqueue('move_images', dir ? `Move ${pending.length} system image(s) to ${dir}` : `Move ${pending.length} system image(s) back into the SDK`, (job, update) =>
          moveImages(dir, job, update),
        )
      : null;
    return { storage: await this.storageInfo(), job };
  },

  /**
   * Change where new AVDs are stored (null = default). Validates the folder, saves AVD_STORAGE_DIR to .env and,
   * if asked, moves existing AVDs there as a background job (copy + verify + delete across drives, rename on the same drive).
   */
  async setAvdStorage(dirInput: string | null, moveExisting: boolean): Promise<{ storage: StorageInfo; job: SdkJob | null }> {
    let dir: string | null = null;
    if (dirInput && dirInput.trim()) {
      const raw = dirInput.trim();
      if (!path.isAbsolute(raw)) throw Object.assign(new Error('Use a full path, e.g. M:\\Android\\avd'), { statusCode: 400 });
      dir = path.resolve(raw);
      if (!/^[\w .:()\\\/-]+$/.test(dir)) throw Object.assign(new Error('Folder path may only contain letters, digits, spaces and . _ - ( ) — no special characters'), { statusCode: 400 });
      if (!fs.existsSync(path.parse(dir).root)) throw Object.assign(new Error(`Drive ${path.parse(dir).root} does not exist`), { statusCode: 400 });
      const sdk = sdkRoot();
      if (sdk && (samePath(dir, sdk) || dir.toLowerCase().startsWith(sdk.toLowerCase() + path.sep))) throw Object.assign(new Error('Pick a folder outside the Android SDK'), { statusCode: 400 });
      try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, `.playtest-write-test-${process.pid}`);
        fs.writeFileSync(probe, 'ok');
        fs.rmSync(probe);
      } catch (err: any) {
        throw Object.assign(new Error(`Cannot write to ${dir}: ${err.code ?? err.message}`), { statusCode: 400 });
      }
      if (samePath(dir, avdHome())) dir = null; // that is the default anyway
    }

    avdStorage.dir = dir;
    writeEnv({ AVD_STORAGE_DIR: dir ?? '' });

    let job: SdkJob | null = null;
    if (moveExisting) {
      const target = dir ?? avdHome();
      const toMove = (await this.avdLocations()).filter((a) => a.exists && !samePath(path.dirname(path.resolve(a.data_path)), target));
      if (toMove.length) job = moveAvdsJob(toMove, target);
    }
    return { storage: await this.storageInfo(), job };
  },

  assertDisk(force?: boolean) {
    if (force) return;
    const root = sdkRoot();
    if (!root) return;
    const imagesDir = imagesStorage.dir ?? path.join(root, 'system-images');
    const separate = !sameDrive(imagesDir, root);
    // sdkmanager downloads + unzips in <sdk>\.temp, then moves the image into system-images.
    const sdkFree = freeDiskGb(root);
    const imgFree = separate ? freeDiskGb(fs.existsSync(imagesDir) ? imagesDir : path.parse(imagesDir).root) : sdkFree;
    if (separate) {
      if (sdkFree !== null && sdkFree < 4)
        throw Object.assign(new Error(`Only ${sdkFree.toFixed(1)} GB free on the SDK drive — sdkmanager downloads and unzips there before the image is moved. Free space or retry with force.`), { statusCode: 409 });
      if (imgFree !== null && imgFree < 4)
        throw Object.assign(new Error(`Only ${imgFree.toFixed(1)} GB free where system images are stored (${imagesDir}). Free space or retry with force.`), { statusCode: 409 });
    } else if (sdkFree !== null && sdkFree < MIN_FREE_DISK_GB)
      throw Object.assign(
        new Error(`Only ${sdkFree.toFixed(1)} GB free on the SDK drive — a system image plus AVD needs ~${MIN_FREE_DISK_GB} GB. Free space, move system images to another drive (Storage), or retry with force.`),
        { statusCode: 409 },
      );
  },
};

function moveAvdsJob(avds: AvdLocation[], target: string): SdkJob {
  const total = avds.reduce((s, a) => s + a.size_bytes, 0);
  return enqueue('move_avds', `Move ${avds.length} AVD${avds.length === 1 ? '' : 's'} to ${target}`, async (job, update) => {
    const free = freeDiskGb(target);
    const needGb = total / 1024 ** 3;
    if (free !== null && avds.some((a) => !sameDrive(a.data_path, target)) && free < needGb + 1)
      throw new Error(`Not enough space in ${target}: ${free.toFixed(1)} GB free, AVDs need ${needGb.toFixed(1)} GB`);
    let done = 0;
    const moved: string[] = [];
    const skipped: string[] = [];
    for (const a of avds) {
      // Re-check right before moving: an emulator may have started since the job was queued.
      if (emulatorManager.list().some((r) => r.avd_name === a.name) || avdLocked(a.data_path)) {
        job.log.push(`Skipped ${a.name}: emulator is running (stop it and move again)`);
        skipped.push(a.name);
        done += a.size_bytes;
        continue;
      }
      const dest = path.join(target, path.basename(a.data_path));
      if (fs.existsSync(dest)) {
        job.log.push(`Skipped ${a.name}: ${dest} already exists`);
        skipped.push(a.name);
        done += a.size_bytes;
        continue;
      }
      update({ step: `Moving ${a.name}`, progress: total ? (done / total) * 100 : null });
      if (sameDrive(a.data_path, target)) {
        await fsp.rename(a.data_path, dest);
        done += a.size_bytes;
      } else {
        let copied = 0;
        await copyDir(a.data_path, dest, (n) => {
          copied += n;
          update({ step: `Copying ${a.name} (${(copied / 1024 ** 3).toFixed(2)} / ${(a.size_bytes / 1024 ** 3).toFixed(2)} GB)`, progress: total ? ((done + copied) / total) * 100 : null });
        });
        const copiedSize = await dirSize(dest);
        if (copiedSize !== a.size_bytes) {
          await fsp.rm(dest, { recursive: true, force: true });
          throw new Error(`Copy of ${a.name} is incomplete (${copiedSize} of ${a.size_bytes} bytes) — original left untouched`);
        }
        done += a.size_bytes;
      }
      rewriteIni(a.ini_path, dest);
      if (fs.existsSync(a.data_path)) await fsp.rm(a.data_path, { recursive: true, force: true });
      job.log.push(`Moved ${a.name} → ${dest}`);
      moved.push(a.name);
    }
    if (skipped.length && !moved.length) throw new Error(`Nothing moved: ${job.log.slice(-skipped.length).join(' · ')}`);
    return { moved, skipped, target };
  });
}

function validateAvdInput(input: { name: string; package: string; device: string }) {
  if (!AVD_RE.test(input.name)) throw Object.assign(new Error('AVD name: letters, digits, _ . - only'), { statusCode: 400 });
  if (!PKG_RE.test(input.package)) throw Object.assign(new Error(`Invalid system image package: ${input.package}`), { statusCode: 400 });
  if (!HW_RE.test(input.device)) throw Object.assign(new Error(`Invalid hardware profile: ${input.device}`), { statusCode: 400 });
}

async function doInstall(bin: string, pkg: string, job: SdkJob, update: (p: Partial<SdkJob>) => void) {
  update({ step: `Downloading ${pkg}`, progress: 0 });
  // Answer "y" to any license prompt — the dashboard asks the user to accept first.
  const r = await runSdkTool(bin, ['--install', pkg], { input: 'y\n'.repeat(30), onLine: lineLogger(job, update) });
  if (!r.ok) throw new Error(`sdkmanager failed: ${r.error}`);
  if (!sdkManager.installedImages().some((i) => i.package === pkg))
    throw new Error(`sdkmanager finished but ${pkg} is not on disk — check the job log (license not accepted or package unavailable?)`);
}

async function doCreateAvd(bin: string, input: { name: string; package: string; device: string }, job: SdkJob, update: (p: Partial<SdkJob>) => void) {
  validateAvdInput(input);
  const existing = await emulatorManager.listAvds();
  if (existing.avds.includes(input.name)) throw new Error(`An AVD named ${input.name} already exists`);
  update({ step: `Creating AVD ${input.name}`, progress: null });
  // Custom storage: the AVD data folder goes to AVD_STORAGE_DIR, the small .ini pointer stays in the default
  // AVD home, so the emulator and Android Studio still list it.
  const args = ['create', 'avd', '-n', input.name, '-k', input.package, '-d', input.device];
  const targetDir = avdStorage.dir ?? avdHome();
  const free = freeDiskGb(fs.existsSync(targetDir) ? targetDir : path.parse(targetDir).root);
  if (free !== null && free < MIN_AVD_FREE_GB)
    throw new Error(`Only ${free.toFixed(1)} GB free in ${targetDir} — an AVD grows to ~${MIN_AVD_FREE_GB}+ GB. Set a folder on a bigger drive under Device Manager → Storage.`);
  if (avdStorage.dir) {
    const dataPath = path.join(avdStorage.dir, `${input.name}.avd`);
    if (fs.existsSync(dataPath)) throw new Error(`${dataPath} already exists — delete it or pick another AVD name`);
    args.push('-p', dataPath);
    job.log.push(`AVD data folder: ${dataPath}`);
  }
  const r = await runSdkTool(bin, args, {
    input: 'no\n', // "Do you wish to create a custom hardware profile? [no]"
    timeoutMs: 120_000,
    onLine: lineLogger(job, update, 'Creating AVD: '),
  });
  if (!r.ok) throw new Error(`avdmanager create failed: ${r.error}`);
  const after = await emulatorManager.listAvds();
  if (!after.avds.includes(input.name)) throw new Error(`avdmanager finished but ${input.name} is not listed by the emulator`);
}

/** Map preset AVD names (PT_Pixel_8_API_35, PT_Tablet_API_30 …) to avdmanager hardware ids. */
function guessHardware(profile: { name: string; avd_name: string }, definitions: string[]): string {
  const key = profile.avd_name.replace(/^PT_/i, '').replace(/_API_\d+$/i, '').toLowerCase();
  const fromName = profile.name.replace(/\s*API\s*\d+$/i, '').trim().toLowerCase().replace(/\s+/g, '_');
  const special: Record<string, string> = {
    nexus_5x: 'Nexus 5X',
    small: 'small_phone',
    lowend: '5.4in FWVGA',
    fold: 'pixel_fold',
    tablet: /medium/i.test(profile.name) ? 'medium_tablet' : 'pixel_tablet',
  };
  const candidates = [special[key], key, fromName, 'medium_phone', 'pixel_6'].filter(Boolean) as string[];
  if (!definitions.length) return candidates[0];
  return candidates.find((c) => definitions.includes(c)) ?? definitions.find((d) => d.startsWith('pixel')) ?? definitions[0];
}

// ---------- system image sizes (Google's repository index) ----------

const REPO = 'https://dl.google.com/android/repository/';
let sizesCache: { at: number; map: Map<string, number> } | null = null;
let sizesInflight: Promise<Map<string, number>> | null = null;

/** package path → download bytes, from the sys-img XML indexes sdkmanager itself reads. Cached 24 h. */
async function repoSizes(): Promise<Map<string, number>> {
  if (sizesCache && Date.now() - sizesCache.at < 24 * 3600_000) return sizesCache.map;
  if (sizesInflight) return sizesInflight;
  sizesInflight = (async () => {
    const get = async (url: string) => {
      const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return r.text();
    };
    const list = await get(`${REPO}addons_list-5.xml`);
    const urls = [...new Set([...list.matchAll(/<url>(sys-img\/[\w./-]+\.xml)<\/url>/g)].map((m) => m[1]))];
    const map = new Map<string, number>();
    const texts = await Promise.allSettled(urls.map((u) => get(REPO + u)));
    for (const t of texts) {
      if (t.status !== 'fulfilled') continue;
      for (const m of t.value.matchAll(/<remotePackage path="([^"]+)">([\s\S]*?)<\/remotePackage>/g)) {
        const size = Number(m[2].match(/<complete>\s*<size>(\d+)<\/size>/)?.[1]);
        if (!size) continue;
        // Stable channel (channel-0) wins over previews for the same package.
        const stable = /channelRef ref="channel-0"/.test(m[2]);
        if (!map.has(m[1]) || stable) map.set(m[1], size);
      }
    }
    if (map.size) sizesCache = { at: Date.now(), map };
    return map;
  })().finally(() => (sizesInflight = null));
  return sizesInflight;
}

// ---------- system images folder (per-image directory junctions) ----------
//
// Tested: sdkmanager lists a junctioned image and uninstalls it correctly (removes files + junction).
// A junction on the whole system-images folder is NOT safe — sdkmanager replaces it with a real folder on install.

function isLink(p: string) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Every installed image folder <sdk>\system-images\<api>\<tag>\<abi>, and where its files really are. */
function imageLeaves(root: string): ImageLeaf[] {
  const base = path.join(root, 'system-images');
  const out: ImageLeaf[] = [];
  const dirs = (p: string) => {
    try {
      return fs.readdirSync(p).filter((n) => {
        try {
          return fs.statSync(path.join(p, n)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
  };
  for (const api of dirs(base))
    for (const tag of dirs(path.join(base, api)))
      for (const abi of dirs(path.join(base, api, tag))) {
        const leaf = path.join(base, api, tag, abi);
        if (!fs.existsSync(path.join(leaf, 'system.img'))) continue;
        let real = leaf;
        try {
          real = fs.realpathSync.native(leaf);
        } catch {
          /* keep leaf */
        }
        out.push({ package: `system-images;${api};${tag};${abi}`, rel: [api, tag, abi], sdk_path: leaf, real_path: real, linked: isLink(leaf) });
      }
  return out;
}

async function imagesLocation(): Promise<ImagesLocation | null> {
  const root = sdkRoot();
  if (!root) return null;
  const images = await Promise.all(imageLeaves(root).map(async (l) => ({ ...l, size_bytes: await dirSize(l.real_path) })));
  const target = imagesStorage.dir ?? root;
  return {
    dir: imagesStorage.dir,
    sdk_path: path.join(root, 'system-images'),
    free_gb: freeDiskGb(fs.existsSync(target) ? target : path.parse(target).root),
    images,
    in_sdk_bytes: images.filter((i) => !i.linked).reduce((s, i) => s + i.size_bytes, 0),
    elsewhere_bytes: images.filter((i) => i.linked).reduce((s, i) => s + i.size_bytes, 0),
  };
}

/** Move one folder (rename on the same drive; copy + verify size + delete across drives). */
async function moveFolder(src: string, dst: string, label: string, update: (p: Partial<SdkJob>) => void) {
  if (fs.existsSync(dst)) {
    if (fs.readdirSync(dst).length) throw new Error(`${dst} already exists and is not empty`);
    fs.rmdirSync(dst);
  }
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  if (sameDrive(src, dst)) {
    await fsp.rename(src, dst);
    return;
  }
  const size = await dirSize(src);
  const free = freeDiskGb(path.dirname(dst));
  if (free !== null && free < size / 1024 ** 3 + 0.5) throw new Error(`Not enough space for ${label}: ${free.toFixed(1)} GB free, needs ${(size / 1024 ** 3).toFixed(1)} GB`);
  let copied = 0;
  await copyDir(src, dst, (n) => {
    copied += n;
    update({ step: `Copying ${label} (${(copied / 1024 ** 3).toFixed(2)} / ${(size / 1024 ** 3).toFixed(2)} GB)`, progress: size ? (copied / size) * 100 : null });
  });
  const got = await dirSize(dst);
  if (got !== size) {
    await fsp.rm(dst, { recursive: true, force: true });
    throw new Error(`Copy of ${label} is incomplete (${got} of ${size} bytes) — the original was left untouched`);
  }
  await fsp.rm(src, { recursive: true, force: true });
}

/** Put every installed image in `dir` (junction left in the SDK), or back into the SDK when dir is null. */
async function moveImages(dir: string | null, job: SdkJob, update: (p: Partial<SdkJob>) => void, only?: string[]) {
  const root = sdkRoot();
  if (!root) throw new Error('Android SDK not found');
  const leaves = imageLeaves(root).filter((l) => !only || only.includes(l.package));
  const moved: string[] = [];
  for (const [i, l] of leaves.entries()) {
    const label = l.rel.join(' / ');
    if (dir) {
      const desired = path.join(dir, ...l.rel);
      if (l.linked && samePath(l.real_path, desired)) continue;
      update({ step: `Moving ${label} (${i + 1}/${leaves.length})`, progress: null });
      await moveFolder(l.real_path, desired, label, update);
      if (l.linked) fs.unlinkSync(l.sdk_path); // removes the junction only, never its target
      else if (fs.existsSync(l.sdk_path)) await fsp.rm(l.sdk_path, { recursive: true, force: true });
      fs.symlinkSync(desired, l.sdk_path, 'junction');
      job.log.push(`${label} → ${desired}`);
    } else {
      if (!l.linked) continue;
      update({ step: `Moving ${label} back into the SDK (${i + 1}/${leaves.length})`, progress: null });
      const staging = `${l.sdk_path}.playtest-moving`;
      await moveFolder(l.real_path, staging, label, update);
      fs.unlinkSync(l.sdk_path);
      await fsp.rename(staging, l.sdk_path);
      // Drop the now-empty <tag> and <api> folders it left behind.
      for (let d = path.dirname(l.real_path), n = 0; n < 2; d = path.dirname(d), n++) {
        try {
          fs.rmdirSync(d);
        } catch {
          break; // not empty
        }
      }
      job.log.push(`${label} → ${l.sdk_path}`);
    }
    moved.push(l.package);
  }
  return { moved, dir };
}

/** After sdkmanager installs an image (into the SDK), move it to the images folder if one is set. */
async function moveNewImage(pkg: string, job: SdkJob, update: (p: Partial<SdkJob>) => void) {
  if (!imagesStorage.dir) return;
  update({ step: `Moving the image to ${imagesStorage.dir}`, progress: null });
  await moveImages(imagesStorage.dir, job, update, [pkg]);
}
