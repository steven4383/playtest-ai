import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { assetsAndStrings, releaseChecklist, screenDetails, stateMap, type InsightContext } from './flutter-insights.js';
import { flutterBin } from './devtools.js';
import { runSdkTool } from './sdk.js';

/**
 * Read-only static analysis of a Flutter project: pubspec, platforms, structure, screens, routes and the
 * navigation calls between screens → a short brief and a Mermaid flow diagram. Nothing is executed.
 */

const bad = (msg: string, statusCode = 400) => Object.assign(new Error(msg), { statusCode });
const PLATFORM_NAMES: Record<string, string> = { android: 'Android', ios: 'iOS', web: 'Web', windows: 'Windows', macos: 'macOS', linux: 'Linux' };
const isWin = process.platform === 'win32';
const samePath = (a: string, b: string) => (isWin ? a.toLowerCase() === b.toLowerCase() : a === b);

// ---------------------------------------------------------------- project discovery

const SKIP_DIRS = new Set(['node_modules', 'build', '.dart_tool', '.git', '.idea', '.gradle', 'ios', 'android', 'windows', 'linux', 'macos', 'web', '.pub-cache', 'Pods']);
const rememberedFile = () => path.join(config.STORAGE_DIR, 'flutter-projects.json');

export interface ProjectRef {
  path: string;
  name: string;
  description: string | null;
  modified: string | null;
  remembered: boolean;
}

function readRemembered(): string[] {
  try {
    const v = JSON.parse(fs.readFileSync(rememberedFile(), 'utf8'));
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function writeRemembered(list: string[]) {
  fs.mkdirSync(path.dirname(rememberedFile()), { recursive: true });
  fs.writeFileSync(rememberedFile(), JSON.stringify([...new Set(list)].slice(0, 50), null, 2));
}

/** Returns the project's absolute path if `dir` is a Flutter project (pubspec.yaml depending on the flutter SDK). */
export function assertProject(dirInput: string): string {
  if (typeof dirInput !== 'string' || !dirInput.trim()) throw bad('Enter the project folder path');
  const raw = dirInput.trim().replace(/[\\/]pubspec\.yaml$/i, '');
  if (!path.isAbsolute(raw)) throw bad('Use a full path, e.g. C:\\Users\\me\\projects\\my_app');
  if (/[\0\r\n"<>|]/.test(raw)) throw bad('Invalid characters in the path');
  const dir = path.resolve(raw);
  const pubspec = path.join(dir, 'pubspec.yaml');
  if (!fs.existsSync(pubspec)) throw bad(`No pubspec.yaml in ${dir}`);
  const text = fs.readFileSync(pubspec, 'utf8').slice(0, 200_000);
  if (!/^\s+flutter:\s*\n\s+sdk:\s*flutter/m.test(text) && !/sdk:\s*flutter/.test(text)) throw bad('This is a Dart package, not a Flutter app (pubspec has no flutter SDK dependency)');
  return dir;
}

function quickMeta(dir: string): Omit<ProjectRef, 'remembered'> {
  const text = fs.readFileSync(path.join(dir, 'pubspec.yaml'), 'utf8').slice(0, 50_000);
  let modified: string | null = null;
  try {
    modified = fs.statSync(path.join(dir, 'lib')).mtime.toISOString();
  } catch {
    /* no lib */
  }
  return {
    path: dir,
    name: text.match(/^name:\s*['"]?([\w-]+)/m)?.[1] ?? path.basename(dir),
    description: text.match(/^description:\s*['"]?(.+?)['"]?\s*$/m)?.[1] ?? null,
    modified,
  };
}

let scanCache: { at: number; list: ProjectRef[] } | null = null;

async function walkForPubspec(root: string, depth: number, out: Set<string>) {
  if (depth < 0 || out.size > 200) return;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((e) => e.isFile() && e.name === 'pubspec.yaml')) {
    out.add(root);
    return; // don't descend into a project (example/ apps etc.)
  }
  await Promise.all(
    entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)).map((e) => walkForPubspec(path.join(root, e.name), depth - 1, out)),
  );
}

export const flutterProjects = {
  async list(refresh = false): Promise<ProjectRef[]> {
    const remembered = readRemembered().filter((p) => fs.existsSync(path.join(p, 'pubspec.yaml')));
    if (!refresh && scanCache && Date.now() - scanCache.at < 5 * 60_000) {
      return merge(scanCache.list.filter((p) => !p.remembered), remembered);
    }
    const home = os.homedir();
    const roots = [
      path.join(home, 'Downloads'),
      path.join(home, 'Documents'),
      path.join(home, 'StudioProjects'),
      path.join(home, 'dev'),
      path.join(home, 'projects'),
      path.join(home, 'Desktop'),
      ...(isWin ? ['C:\\src', 'C:\\dev', 'C:\\projects'] : []),
    ].filter((r) => fs.existsSync(r));
    const found = new Set<string>();
    await Promise.all(roots.map((r) => walkForPubspec(r, 3, found)));
    const scanned: ProjectRef[] = [];
    for (const dir of found) {
      try {
        assertProject(dir);
        scanned.push({ ...quickMeta(dir), remembered: false });
      } catch {
        /* plain Dart package or unreadable */
      }
    }
    scanCache = { at: Date.now(), list: scanned };
    return merge(scanned, remembered);
  },

  remember(dirInput: string) {
    const dir = assertProject(dirInput);
    writeRemembered([dir, ...readRemembered().filter((p) => !samePath(p, dir))]);
    return { ...quickMeta(dir), remembered: true };
  },

  forget(dirInput: string) {
    const dir = path.resolve(dirInput.trim());
    writeRemembered(readRemembered().filter((p) => !samePath(p, dir)));
    return { ok: true };
  },
};

function merge(scanned: ProjectRef[], remembered: string[]): ProjectRef[] {
  const out: ProjectRef[] = [];
  for (const p of remembered) {
    try {
      out.push({ ...quickMeta(p), remembered: true });
    } catch {
      /* gone */
    }
  }
  for (const s of scanned) if (!out.some((o) => samePath(o.path, s.path))) out.push(s);
  return out.sort((a, b) => Number(b.remembered) - Number(a.remembered) || (b.modified ?? '').localeCompare(a.modified ?? ''));
}

// ---------------------------------------------------------------- pubspec

const PKG_GROUPS: [string, RegExp][] = [
  ['State management', /^(flutter_riverpod|hooks_riverpod|riverpod|riverpod_annotation|provider|flutter_bloc|bloc|hydrated_bloc|get|getx|mobx|flutter_mobx|redux|flutter_redux|signals|stacked|flutter_hooks)$/],
  ['Navigation', /^(go_router|auto_route|beamer|routemaster|fluro|go_router_builder)$/],
  ['Storage', /^(hive|hive_flutter|isar|isar_flutter_libs|sqflite|drift|shared_preferences|objectbox|sembast|flutter_secure_storage|path_provider|get_storage)$/],
  ['Network & API', /^(http|dio|retrofit|chopper|graphql_flutter|graphql|web_socket_channel|connectivity_plus|supabase_flutter|appwrite|grpc)$/],
  ['Firebase', /^(firebase_\w+|cloud_firestore|cloud_functions|google_sign_in)$/],
  ['UI & animation', /^(google_fonts|fl_chart|lottie|flutter_svg|cached_network_image|animations|confetti|shimmer|flutter_animate|rive|carousel_slider|flutter_staggered_grid_view|syncfusion_\w+|cupertino_icons)$/],
  ['Device & media', /^(flutter_tts|speech_to_text|camera|image_picker|permission_handler|geolocator|google_maps_flutter|audioplayers|just_audio|video_player|url_launcher|share_plus|local_auth|flutter_local_notifications|device_info_plus|package_info_plus|sensors_plus|vibration)$/],
  ['Payments & ads', /^(in_app_purchase|purchases_flutter|google_mobile_ads|razorpay_flutter|stripe\w*|flutter_stripe)$/],
  ['Code generation & tooling', /^(build_runner|freezed|freezed_annotation|json_serializable|json_annotation|flutter_launcher_icons|flutter_native_splash|flutter_lints|lints|very_good_analysis|mockito|mocktail|flutter_gen\w*|intl_utils)$/],
  ['Utilities', /^(intl|uuid|collection|equatable|dartz|fpdart|logger|rxdart|get_it|injectable|flutter_localizations)$/],
];

interface Pubspec {
  name: string;
  description: string | null;
  version: string | null;
  sdk: string | null;
  flutter: string | null;
  dependencies: Record<string, string>;
  dev_dependencies: Record<string, string>;
  assets: string[];
}

/** Minimal YAML reader for the parts of pubspec.yaml we need (top-level scalars + one-level maps). */
function parsePubspec(text: string): Pubspec {
  const out: Pubspec = { name: '', description: null, version: null, sdk: null, flutter: null, dependencies: {}, dev_dependencies: {}, assets: [] };
  let section: string | null = null;
  let sub: string | null = null;
  const unq = (s: string) => s.trim().replace(/^['"]|['"]$/g, '');
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.replace(/\s+#.*$/, '');
    const m = line.trim().match(/^([\w-]+):\s*(.*)$/);
    if (indent === 0) {
      sub = null;
      if (!m) continue;
      section = m[1];
      if (m[1] === 'name') out.name = unq(m[2]);
      if (m[1] === 'description') out.description = unq(m[2]) || null;
      if (m[1] === 'version') out.version = unq(m[2]) || null;
      continue;
    }
    if (section === 'environment' && m) {
      if (m[1] === 'sdk') out.sdk = unq(m[2]);
      if (m[1] === 'flutter') out.flutter = unq(m[2]);
    }
    if ((section === 'dependencies' || section === 'dev_dependencies') && indent === 2 && m) {
      out[section][m[1]] = m[2] ? unq(m[2]) : m[1] === 'flutter' || m[1] === 'flutter_test' ? 'sdk' : 'path/git';
    }
    if (section === 'flutter') {
      if (indent === 2 && m) sub = m[1];
      else if (sub === 'assets' && /^\s+-\s+/.test(line)) out.assets.push(unq(line.replace(/^\s+-\s+/, '')));
    }
  }
  return out;
}

function groupPackages(deps: Record<string, string>) {
  const groups: Record<string, string[]> = {};
  for (const name of Object.keys(deps)) {
    if (name === 'flutter' || name === 'flutter_test' || name === 'flutter_driver' || name === 'integration_test') continue;
    const g = PKG_GROUPS.find(([, re]) => re.test(name))?.[0] ?? 'Other';
    (groups[g] ??= []).push(name);
  }
  return groups;
}

// ---------------------------------------------------------------- dart source scanning

const MAX_FILES = 3000;
const MAX_BYTES = 1024 * 1024;

async function dartFiles(lib: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    if (out.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.endsWith('.dart') && !/\.(g|freezed|gr|config|mocks)\.dart$/.test(e.name)) out.push(p);
      if (out.length >= MAX_FILES) return;
    }
  };
  await walk(lib);
  return out;
}

/** Drop comments and the contents of string literals' escapes so bracket matching is reliable enough. */
function stripComments(src: string) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"])\/\/.*$/gm, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

/** Index of the bracket that closes the one at `open` (handles nesting and quoted strings). */
function matchClose(src: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return i;
    }
  }
  return -1;
}

/** Split a call's argument text at top-level commas. */
function topLevelArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      out.push(args.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (args.slice(start).trim()) out.push(args.slice(start).trim());
  return out;
}

const named = (args: string[], key: string) => args.find((a) => a.startsWith(`${key}:`))?.slice(key.length + 1).trim() ?? null;

// ---------------------------------------------------------------- analysis

export interface Screen {
  id: string; // class name
  label: string;
  file: string; // relative to project
  feature: string;
  route: string | null;
}
export interface FlowEdge {
  from: string;
  to: string;
  kind: 'push' | 'go' | 'dynamic';
}
export interface RouteInfo {
  path: string;
  screen: string | null;
  name: string | null;
  file: string;
}

const WIDGET_BASE = /class\s+([A-Z]\w*)\s+extends\s+(StatelessWidget|StatefulWidget|ConsumerWidget|ConsumerStatefulWidget|HookWidget|HookConsumerWidget|GetView|GetWidget|StatelessScreen)\b/g;

function labelOf(cls: string) {
  return (
    cls
      .replace(/(Screen|Page|View)$/, '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .trim() || cls
  );
}

export async function analyzeFlutterProject(dirInput: string) {
  const dir = assertProject(dirInput);
  const rel = (p: string) => path.relative(dir, p).split(path.sep).join('/');
  const pub = parsePubspec(fs.readFileSync(path.join(dir, 'pubspec.yaml'), 'utf8'));
  const platforms = ['android', 'ios', 'web', 'windows', 'macos', 'linux'].filter((p) => fs.existsSync(path.join(dir, p)));

  // Android ids
  let android: { application_id: string | null; namespace: string | null; min_sdk: string | null; target_sdk: string | null } | null = null;
  for (const f of ['build.gradle.kts', 'build.gradle']) {
    const p = path.join(dir, 'android', 'app', f);
    if (!fs.existsSync(p)) continue;
    const g = fs.readFileSync(p, 'utf8');
    const pick = (k: string) => g.match(new RegExp(`${k}\\s*=?\\s*["']?([\\w.]+)["']?`))?.[1] ?? null;
    android = { application_id: pick('applicationId'), namespace: pick('namespace'), min_sdk: pick('minSdk(?:Version)?'), target_sdk: pick('targetSdk(?:Version)?') };
    break;
  }

  const lib = path.join(dir, 'lib');
  const files = await dartFiles(lib);
  const sources = new Map<string, string>();
  for (const f of files) {
    try {
      const st = await fsp.stat(f);
      if (st.size > MAX_BYTES) continue;
      sources.set(f, stripComments(await fsp.readFile(f, 'utf8')));
    } catch {
      /* unreadable */
    }
  }
  const linesOfCode = [...sources.values()].reduce((s, t) => s + t.split('\n').length, 0);

  // Structure: top-level folders under lib/ and features/
  const folders: Record<string, number> = {};
  for (const f of sources.keys()) {
    const parts = rel(f).split('/');
    if (parts.length > 2) folders[parts[1]] = (folders[parts[1]] ?? 0) + 1;
  }
  const featureDir = ['features', 'feature', 'modules', 'screens', 'pages', 'presentation'].find((d) => folders[d]);
  const features = new Set<string>();
  const featureOf = (file: string) => {
    const parts = rel(file).split('/');
    if (featureDir && parts[1] === featureDir && parts.length > 3) return parts[2];
    return parts.length > 2 ? parts[1] : 'app';
  };

  // Route path constants: class Routes { static const home = '/home'; }
  const consts = new Map<string, string>();
  for (const src of sources.values()) {
    let cls = '';
    const re = /class\s+(\w+)|static\s+const\s+(?:String\s+)?(\w+)\s*=\s*(['"])([^'"]*)\3/g;
    for (const m of src.matchAll(re)) {
      if (m[1]) cls = m[1];
      else {
        consts.set(`${cls}.${m[2]}`, m[4]);
        if (!consts.has(m[2])) consts.set(m[2], m[4]);
      }
    }
    for (const m of src.matchAll(/(?:^|\s)const\s+(?:String\s+)?(\w+)\s*=\s*(['"])(\/[^'"]*)\2/gm)) if (!consts.has(m[1])) consts.set(m[1], m[3]);
  }

  /** Evaluate a Dart path expression to a string; unknown interpolations become ':param'. */
  const evalPath = (expr: string | null): string | null => {
    if (!expr) return null;
    let e = expr.trim();
    if (/^[A-Za-z_]\w*(\.\w+)?$/.test(e)) return consts.get(e) ?? null;
    const parts = e.split(/\s*\+\s*/);
    if (parts.length > 1) {
      const vals = parts.map((p) => evalPath(p));
      return vals.some((v) => v === null) ? null : vals.join('');
    }
    const q = e.match(/^(['"])([\s\S]*)\1$/);
    if (!q) return null;
    e = q[2]
      .replace(/\$\{\s*([A-Za-z_]\w*(?:\.\w+)?)\s*\}/g, (_, k) => consts.get(k) ?? ':param')
      .replace(/\$\{[^}]*\}/g, ':param')
      .replace(/\$([A-Za-z_]\w*)/g, (_, k) => consts.get(k) ?? ':param');
    return e;
  };

  // Screens: widget classes in screen-like files that are routed to or build a Scaffold.
  const widgetClasses = new Map<string, string>(); // class → file
  for (const [f, src] of sources) for (const m of src.matchAll(WIDGET_BASE)) widgetClasses.set(m[1], f);

  // go_router / Navigator 2 routes
  const routes: RouteInfo[] = [];
  let initial: string | null = null;
  let guard = false;
  let routerKind: string | null = null;
  const shells: { start: number; end: number; file: string }[] = [];
  const routeSpans: { start: number; end: number; file: string; route: RouteInfo }[] = [];
  for (const [f, src] of sources) {
    for (const m of src.matchAll(/\b(StatefulShellRoute(?:\.indexedStack)?|ShellRoute)\s*\(/g)) {
      const open = m.index! + m[0].length - 1;
      const close = matchClose(src, open);
      if (close > 0) shells.push({ start: m.index!, end: close, file: f });
    }
    const spans: { start: number; end: number; full: string }[] = [];
    for (const m of src.matchAll(/\bGoRoute\s*\(/g)) {
      const open = m.index! + m[0].length - 1;
      const close = matchClose(src, open);
      if (close < 0) continue;
      const args = topLevelArgs(src.slice(open + 1, close));
      const p = evalPath(named(args, 'path')) ?? '';
      const builder = named(args, 'builder') ?? named(args, 'pageBuilder') ?? '';
      const screen = [...builder.matchAll(/(?:const\s+|new\s+)?\b([A-Z]\w*)\s*\(/g)].map((x) => x[1]).find((c) => widgetClasses.has(c) && !/^(MaterialPage|CupertinoPage|CustomTransitionPage|NoTransitionPage|Scaffold)$/.test(c)) ?? null;
      const parent = spans.filter((s) => s.start < m.index! && s.end > close).sort((a, b) => b.start - a.start)[0];
      const full = p.startsWith('/') || !parent ? p : `${parent.full.replace(/\/$/, '')}/${p}`;
      spans.push({ start: m.index!, end: close, full });
      const nm = named(args, 'name');
      const info: RouteInfo = { path: full || '/', screen, name: nm ? (evalPath(nm) ?? nm.replace(/^['"]|['"]$/g, '')) : null, file: rel(f) };
      routes.push(info);
      routeSpans.push({ start: m.index!, end: close, file: f, route: info });
      routerKind = 'go_router';
    }
    const il = src.match(/initialLocation\s*:\s*([^,\n)]+)/);
    if (il) initial = evalPath(il[1]) ?? initial;
    if (/GoRouter\s*\(/.test(src) && /\bredirect\s*:/.test(src)) guard = true;

    // MaterialApp(routes: {'/x': (context) => const X()}) and onGenerateRoute-style maps
    for (const m of src.matchAll(/(['"][^'"]+['"]|[A-Z]\w*\.\w+)\s*:\s*\([^)]*\)\s*=>\s*(?:const\s+)?([A-Z]\w*)\s*\(/g)) {
      const p = evalPath(m[1]);
      if (p && p.startsWith('/') && widgetClasses.has(m[2])) {
        routes.push({ path: p, screen: m[2], name: null, file: rel(f) });
        routerKind ??= 'Navigator (named routes)';
      }
    }
    const ir = src.match(/initialRoute\s*:\s*([^,\n)]+)/);
    if (ir && !initial) initial = evalPath(ir[1]);
  }
  // Bottom-navigation shells: their direct GoRoute children are tabs.
  const tabGroups: string[][] = [];
  for (const sh of shells) {
    const inside = routeSpans.filter((r) => r.file === sh.file && r.start > sh.start && r.end < sh.end);
    const direct = inside.filter((r) => !inside.some((o) => o !== r && o.start < r.start && o.end > r.end));
    const tabs = [...new Set(direct.map((r) => r.route.screen).filter(Boolean) as string[])];
    if (tabs.length > 1) tabGroups.push(tabs);
  }
  let homeScreen: string | null = null;
  for (const src of sources.values()) {
    const h = src.match(/\bhome\s*:\s*(?:const\s+)?([A-Z]\w*)\s*\(/);
    if (h && widgetClasses.has(h[1])) homeScreen = h[1];
  }

  const routed = new Set(routes.map((r) => r.screen).filter(Boolean) as string[]);
  const screens = new Map<string, Screen>();
  for (const [cls, f] of widgetClasses) {
    const base = path.basename(f, '.dart');
    const screenFile = /_(screen|page|view)$/.test(base) || /\/(screens|pages)\//.test(rel(f));
    const src = sources.get(f) ?? '';
    const isScreen = routed.has(cls) || cls === homeScreen || (screenFile && /(Screen|Page)$/.test(cls) && /Scaffold\s*\(/.test(src));
    if (!isScreen) continue;
    const feature = featureOf(f);
    features.add(feature);
    const r = routes.find((x) => x.screen === cls);
    screens.set(cls, { id: cls, label: labelOf(cls), file: rel(f), feature, route: r?.path ?? null });
  }

  // Resolve a target path to a route's screen.
  const seg = (p: string) => p.split('?')[0].split('/').filter(Boolean);
  const routeFor = (target: string): RouteInfo | null => {
    const t = seg(target);
    const exact = routes.find((r) => {
      const s = seg(r.path);
      return s.length === t.length && s.every((x, i) => x.startsWith(':') || t[i].startsWith(':') || x === t[i]);
    });
    if (exact) return exact;
    // longest static prefix
    let best: RouteInfo | null = null;
    let bestLen = -1;
    for (const r of routes) {
      const s = seg(r.path);
      if (s.length <= t.length && s.every((x, i) => x.startsWith(':') || x === t[i]) && s.length > bestLen) {
        best = r;
        bestLen = s.length;
      }
    }
    return best;
  };

  // Which screen does a file's code belong to? A screen file → its screen(s); a widget file → screens that use its widgets.
  const ownersOf = (f: string): string[] => {
    const own = [...screens.values()].filter((s) => s.file === rel(f)).map((s) => s.id);
    if (own.length) return own;
    const classes = [...widgetClasses.entries()].filter(([, file]) => file === f).map(([c]) => c);
    if (!classes.length) return [];
    const users: string[] = [];
    for (const s of screens.values()) {
      const src = sources.get(path.join(dir, s.file)) ?? '';
      if (classes.some((c) => new RegExp(`\\b${c}\\s*\\(`).test(src))) users.push(s.id);
    }
    return users;
  };

  const edges = new Map<string, FlowEdge>();
  const addEdge = (from: string, to: string, kind: FlowEdge['kind']) => {
    if (from === to || !screens.has(from) || !screens.has(to)) return;
    const key = `${from}>${to}`;
    const prev = edges.get(key);
    if (!prev || (prev.kind === 'dynamic' && kind !== 'dynamic')) edges.set(key, { from, to, kind });
  };

  for (const [f, src] of sources) {
    const owners = ownersOf(f);
    if (!owners.length) continue;
    let dynamicCall = false;
    const resolved = new Set<string>();
    // context.push('/x') / context.go(Routes.x) / GoRouter.of(context).push(...) / context.pushNamed('name')
    for (const m of src.matchAll(/(?:context|GoRouter\.of\(\s*context\s*\)|router)\s*\.\s*(push|go|pushReplacement|replace|pushNamed|goNamed|pushReplacementNamed)\s*(?:<[^>]*>)?\s*\(/g)) {
      const open = m.index! + m[0].length - 1;
      const close = matchClose(src, open);
      if (close < 0) continue;
      const first = topLevelArgs(src.slice(open + 1, close))[0] ?? '';
      const kind: FlowEdge['kind'] = m[1].startsWith('go') || m[1].startsWith('replace') || m[1] === 'pushReplacement' ? 'go' : 'push';
      let r: RouteInfo | null = null;
      if (m[1].endsWith('Named')) {
        const n = evalPath(first) ?? first.replace(/^['"]|['"]$/g, '');
        r = routes.find((x) => x.name === n) ?? null;
      } else {
        const p = evalPath(first);
        if (p) r = routeFor(p);
        else dynamicCall = true;
      }
      if (r?.screen) {
        resolved.add(r.screen);
        for (const o of owners) addEdge(o, r.screen, kind);
      }
    }
    // Navigator.push(context, MaterialPageRoute(builder: (_) => const X()))
    for (const m of src.matchAll(/Navigator\s*\.\s*(?:of\s*\(\s*context\s*\)\s*\.\s*)?(push|pushReplacement|pushAndRemoveUntil)\s*\(/g)) {
      const open = m.index! + m[0].length - 1;
      const close = matchClose(src, open);
      if (close < 0) continue;
      const body = src.slice(open, close);
      const target = [...body.matchAll(/=>\s*(?:const\s+)?([A-Z]\w*)\s*\(/g)].map((x) => x[1]).find((c) => screens.has(c));
      if (target) for (const o of owners) addEdge(o, target, m[1] === 'push' ? 'push' : 'go');
    }
    for (const m of src.matchAll(/Navigator\s*\.\s*(?:of\s*\(\s*context\s*\)\s*\.\s*)?(pushNamed|pushReplacementNamed|pushNamedAndRemoveUntil)\s*\(\s*(?:context\s*,\s*)?([^,)]+)/g)) {
      const p = evalPath(m[2]);
      const r = p ? routeFor(p) : null;
      if (r?.screen) for (const o of owners) addEdge(o, r.screen, m[1] === 'pushNamed' ? 'push' : 'go');
    }
    // push(route) with a variable: link to route constants this file mentions (e.g. a menu of game tiles).
    if (dynamicCall) {
      const candidates = [...src.matchAll(/\b([A-Z]\w*\.\w+)\b/g)].map((m) => consts.get(m[1])).concat([...src.matchAll(/(['"])(\/[\w\/-]*)\1/g)].map((m) => m[2]));
      for (const p of candidates) {
        const r = p ? routeFor(p) : null;
        if (r?.screen && !resolved.has(r.screen)) for (const o of owners) addEdge(o, r.screen, 'dynamic');
      }
    }
  }

  const initialScreen = (initial ? routeFor(initial)?.screen : null) ?? homeScreen ?? null;
  const depGroups = groupPackages(pub.dependencies);
  const devGroups = groupPackages(pub.dev_dependencies);
  const stateMgmt = depGroups['State management'] ?? [];
  const nav = depGroups['Navigation'] ?? [];

  const architecture = [
    featureDir ? `feature-first (lib/${featureDir}/ has ${[...features].filter((x) => x !== 'app').length} features)` : 'layer-first',
    folders.repositories || folders.repository || folders.data ? 'repository/data layer' : null,
    folders.services || folders.service ? 'services' : null,
    folders.providers || folders.controllers || folders.blocs || folders.bloc || folders.cubits ? `${folders.providers ? 'providers' : folders.blocs || folders.bloc ? 'blocs' : 'controllers'} folder` : null,
    folders.models || folders.domain ? 'models' : null,
  ].filter(Boolean) as string[];

  const brief: string[] = [];
  brief.push(`${pub.name}${pub.version ? ` ${pub.version}` : ''}${pub.description ? ` — ${pub.description}` : ''}`);
  brief.push(`Flutter app for ${platforms.length ? platforms.map((p) => PLATFORM_NAMES[p] ?? p).join(', ') : 'no platform folders yet'}${pub.sdk ? `, Dart SDK ${pub.sdk}` : ''}${android?.application_id ? `. Android id ${android.application_id}` : ''}.`);
  brief.push(
    `${sources.size} Dart files (~${linesOfCode.toLocaleString()} lines) in a ${architecture.join(', ')} structure.${stateMgmt.length ? ` State: ${stateMgmt.join(', ')}.` : ''}`,
  );
  if (routes.length || screens.size)
    brief.push(
      `${screens.size} screens, ${routes.length} routes${routerKind ? ` (${nav.length ? nav.join(', ') : routerKind})` : ''}${initialScreen ? `; the app opens on ${labelOf(initialScreen)}` : ''}${guard ? ', with a redirect guard that can send users elsewhere first' : ''}.`,
    );
  const notable = ['Storage', 'Network & API', 'Firebase', 'Device & media', 'Payments & ads'].filter((g) => depGroups[g]?.length).map((g) => `${g.toLowerCase()}: ${depGroups[g].join(', ')}`);
  if (notable.length) brief.push(`Uses ${notable.join('; ')}.`);
  const hubs = [...screens.values()]
    .map((s) => ({ s, out: [...edges.values()].filter((e) => e.from === s.id).length }))
    .sort((a, b) => b.out - a.out)
    .filter((x) => x.out >= 3)
    .slice(0, 2);
  if (hubs.length) brief.push(`Main hub${hubs.length > 1 ? 's' : ''}: ${hubs.map((h) => `${h.s.label} (links to ${h.out} screens)`).join(', ')}.`);

  const ctx: InsightContext = {
    dir,
    rel,
    sources,
    widgetClasses,
    screens: [...screens.values()],
    dependencies: pub.dependencies,
    devDependencies: pub.dev_dependencies,
    assets: pub.assets,
    version: pub.version,
    android,
    platforms,
    matchClose,
  };
  const details = screenDetails(ctx);

  return {
    path: dir,
    pubspec: { name: pub.name, description: pub.description, version: pub.version, sdk: pub.sdk, flutter: pub.flutter, assets: pub.assets.length },
    packages: { groups: depGroups, dev_groups: devGroups, count: Object.keys(pub.dependencies).length, dev_count: Object.keys(pub.dev_dependencies).length },
    platforms,
    android,
    structure: { dart_files: sources.size, lines_of_code: linesOfCode, folders, feature_dir: featureDir ?? null, architecture, truncated: files.length >= MAX_FILES },
    navigation: { router: routerKind, initial_location: initial, initial_screen: initialScreen, guard, routes },
    screens: [...screens.values()].sort((a, b) => a.feature.localeCompare(b.feature) || a.label.localeCompare(b.label)),
    edges: [...edges.values()],
    tabs: tabGroups.map((g) => g.filter((id) => screens.has(id))),
    unreached: [...screens.values()]
      .filter((s) => s.id !== initialScreen && ![...edges.values()].some((e) => e.to === s.id) && !tabGroups.some((g) => g.includes(s.id)))
      .map((s) => s.id),
    brief,
    mermaid: toMermaid([...screens.values()], [...edges.values()], initialScreen, guard, tabGroups),
    screen_details: details,
    state_map: stateMap(ctx, details),
    insights: assetsAndStrings(ctx),
    release: releaseChecklist(ctx),
  };
}

export type FlutterAnalysis = Awaited<ReturnType<typeof analyzeFlutterProject>>;

function toMermaid(screens: Screen[], edges: FlowEdge[], initial: string | null, guard: boolean, tabs: string[][] = []) {
  const safe = (s: string) => s.replace(/[^\w]/g, '_');
  const esc = (s: string) => s.replace(/"/g, "'").replace(/[<>]/g, '');
  const lines = ['flowchart TD'];
  lines.push('  start(("Start"))');
  const byFeature = new Map<string, Screen[]>();
  for (const s of screens) byFeature.set(s.feature, [...(byFeature.get(s.feature) ?? []), s]);
  for (const [feature, list] of byFeature) {
    const multi = byFeature.size > 1 && list.length > 1;
    if (multi) lines.push(`  subgraph f_${safe(feature)}["${esc(labelOf(feature.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace(/ /g, '')))}"]`);
    for (const s of list) lines.push(`${multi ? '    ' : '  '}${safe(s.id)}["${esc(s.label)}${s.route ? `<br/><small>${esc(s.route)}</small>` : ''}"]`);
    if (multi) lines.push('  end');
  }
  if (initial) lines.push(`  start ${guard ? '-->|"redirect guard"|' : '-->'} ${safe(initial)}`);
  tabs.forEach((g, i) => {
    const id = `tabs_${i}`;
    lines.push(`  ${id}{{"Bottom tabs"}}`);
    for (const t of g) if (screens.some((s) => s.id === t)) lines.push(`  ${id} -.- ${safe(t)}`);
  });
  for (const e of edges) lines.push(`  ${safe(e.from)} ${e.kind === 'push' ? '-->' : e.kind === 'go' ? '==>' : '-.->'} ${safe(e.to)}`);
  lines.push('  classDef entry fill:#2f6fe0,color:#fff,stroke:#2f6fe0');
  lines.push('  class start entry');
  return lines.join('\n');
}

/** Facts only (no source code) for an optional AI explanation. */
export function explainPrompt(a: FlutterAnalysis) {
  const facts = {
    name: a.pubspec.name,
    description: a.pubspec.description,
    platforms: a.platforms,
    packages: a.packages.groups,
    architecture: a.structure.architecture,
    files: a.structure.dart_files,
    router: a.navigation.router,
    initial_screen: a.navigation.initial_screen,
    redirect_guard: a.navigation.guard,
    screens: a.screens.map((s) => ({ name: s.label, feature: s.feature, route: s.route })),
    navigation: a.edges.map((e) => `${e.from} ${e.kind === 'go' ? 'replaces with' : 'opens'} ${e.to}`),
  };
  return {
    system:
      'You explain Flutter app projects to the developer who owns them. Be concise and concrete. Use short markdown sections: "What the app does", "How it is built", "Main user flows" (numbered, screen → screen), "Risky areas to test", "Quick wins". Under 350 words. Only use the facts given; say when something is a guess.',
    prompt: `Project facts (JSON, produced by static analysis — no source code):\n${JSON.stringify(facts, null, 1)}`,
  };
}

// ---------------------------------------------------------------- flutter doctor

export interface DoctorSection {
  status: 'ok' | 'warn' | 'fail' | 'info';
  title: string;
  summary: string | null;
  lines: { status: 'ok' | 'warn' | 'fail' | 'info'; text: string }[];
  fix: string | null;
  optional: boolean;
}

const DOCTOR_FIXES: [RegExp, string][] = [
  [/android-licenses|licenses not accepted|Android license status unknown/i, 'Run `flutter doctor --android-licenses` in a terminal and accept the licenses (type y).'],
  [/cmdline-tools component is missing/i, 'Android Studio → Settings → Android SDK → SDK Tools → tick “Android SDK Command-line Tools (latest)” → Apply.'],
  [/Unable to locate Android SDK/i, 'Install Android Studio, or run `flutter config --android-sdk <path to Sdk>`.'],
  [/Visual Studio not installed|Visual Studio - develop Windows/i, 'Only needed to build Windows desktop apps: install Visual Studio 2022 with “Desktop development with C++”. Ignore it for Android-only work.'],
  [/Cannot find Chrome|CHROME_EXECUTABLE/i, 'Only needed for Flutter web: install Google Chrome or set CHROME_EXECUTABLE.'],
  [/Android Studio \(not installed\)/i, 'Optional if you use VS Code — the Android SDK is what Flutter needs.'],
  [/Network resources|HTTP host .* is not reachable/i, 'Check your internet / proxy: Flutter needs pub.dev, storage.googleapis.com and maven.google.com.'],
  [/No devices available|No supported devices connected/i, 'Connect a phone (USB debugging) or start an emulator from the Developer page.'],
  [/Java version|Unable to find bundled Java|JDK/i, 'Point Flutter at Android Studio’s Java: flutter config --jdk-dir "C:\\Program Files\\Android\\Android Studio\\jbr"'],
  [/on path resolves to/i, 'Two Flutter/Dart installs are on PATH — remove the extra one so `where flutter` shows a single result.'],
  [/upstream repository|unknown channel/i, 'Run `flutter channel stable` then `flutter upgrade`.'],
];
const OPTIONAL = /Visual Studio|Chrome|Xcode|Linux toolchain|Android Studio|IntelliJ|VS Code|Connected device/i;

type DoctorResult = { ran_at: string; sections: DoctorSection[]; raw: string; error: string | null };
let doctorCache: { at: number; value: DoctorResult } | null = null;
let doctorInflight: Promise<DoctorResult> | null = null;

function lineStatus(mark: string): DoctorSection['status'] {
  if (/[✓√]/.test(mark)) return 'ok';
  if (/[✗X☠]/.test(mark)) return 'fail';
  if (/!/.test(mark)) return 'warn';
  return 'info';
}

/** `flutter doctor -v`, parsed into sections with a plain-language fix for each problem. Cached 10 min. */
export async function flutterDoctor(refresh = false): Promise<DoctorResult> {
  if (!refresh && doctorCache && Date.now() - doctorCache.at < 10 * 60_000) return doctorCache.value;
  if (doctorInflight) return doctorInflight;
  doctorInflight = (async () => {
    const bin = flutterBin();
    if (!bin) return { ran_at: new Date().toISOString(), sections: [], raw: '', error: 'Flutter SDK not found — add flutter\\bin to PATH or set FLUTTER_ROOT in backend/.env' };
    const r = await runSdkTool(bin, ['doctor', '-v'], { timeoutMs: 180_000 });
    const raw = `${r.stdout}\n${r.stderr}`.replace(/\r/g, '');
    const sections: DoctorSection[] = [];
    for (const line of raw.split('\n')) {
      const head = line.match(/^\[(.)\]\s+(.+?)(?:\s+\[[\d.]+m?s\])?$/);
      if (head) {
        const [title, ...rest] = head[2].split(/\s+\(/);
        sections.push({ status: lineStatus(head[1]), title: title.trim(), summary: rest.length ? `(${rest.join(' (')}` : null, lines: [], fix: null, optional: OPTIONAL.test(title) });
        continue;
      }
      const sub = line.match(/^\s+([•✗X!✓√])\s+(.+)$/);
      if (sub && sections.length) sections[sections.length - 1].lines.push({ status: sub[1] === '•' ? 'info' : lineStatus(sub[1]), text: sub[2].trim() });
    }
    for (const s of sections) {
      if (s.status === 'ok') continue;
      const text = [s.title, s.summary ?? '', ...s.lines.map((l) => l.text)].join('\n');
      s.fix =
        DOCTOR_FIXES.find(([re]) => re.test(text))?.[1] ??
        (s.lines
          .filter((l) => l.status !== 'info')
          .map((l) => l.text)
          .join(' ') ||
          null);
    }
    const value: DoctorResult = { ran_at: new Date().toISOString(), sections, raw: raw.slice(-20_000), error: sections.length ? null : (r.error ?? 'Could not read flutter doctor output') };
    doctorCache = { at: Date.now(), value };
    return value;
  })().finally(() => (doctorInflight = null));
  return doctorInflight;
}
