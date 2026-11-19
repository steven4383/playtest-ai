import fs from 'node:fs';
import path from 'node:path';

/**
 * Deeper read-only insights for a Flutter project, computed from the same parsed sources as the screen flow:
 * per-screen details, a state & data map, assets & strings, and a release checklist. Nothing is executed and
 * secrets are never read (android/key.properties is only checked for existence).
 */

export interface InsightContext {
  dir: string;
  rel: (abs: string) => string;
  /** comment-stripped sources keyed by absolute path */
  sources: Map<string, string>;
  widgetClasses: Map<string, string>;
  screens: { id: string; label: string; file: string; feature: string; route: string | null }[];
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  assets: string[];
  version: string | null;
  android: { application_id: string | null; namespace: string | null; min_sdk: string | null; target_sdk: string | null } | null;
  platforms: string[];
  matchClose: (src: string, open: number) => number;
}

const uniq = <T,>(a: T[]) => [...new Set(a)];
const readText = (p: string, max = 2_000_000) => {
  try {
    const st = fs.statSync(p);
    return st.size > max ? null : fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------- state usage patterns

const STATE_USE: [RegExp, string][] = [
  [/\bref\s*\.\s*(?:watch|read|listen)\s*\(\s*([a-z]\w*)/g, 'riverpod'],
  [/\bcontext\s*\.\s*(?:read|watch|select)\s*<\s*([A-Z]\w*)/g, 'provider/bloc'],
  [/\b(?:BlocBuilder|BlocConsumer|BlocListener|BlocSelector)\s*<\s*([A-Z]\w*)/g, 'bloc'],
  [/\b(?:BlocProvider|RepositoryProvider|Provider)\s*\.\s*of\s*<\s*([A-Z]\w*)/g, 'provider/bloc'],
  [/\bConsumer\s*<\s*([A-Z]\w*)/g, 'provider'],
  [/\bGet\s*\.\s*find\s*<\s*([A-Z]\w*)/g, 'getx'],
];

function stateUsedIn(src: string) {
  const out: { name: string; via: string }[] = [];
  for (const [re, via] of STATE_USE) for (const m of src.matchAll(re)) out.push({ name: m[1], via });
  const seen = new Set<string>();
  return out.filter((x) => (seen.has(x.name) ? false : (seen.add(x.name), true)));
}

// ---------------------------------------------------------------- screen details

function classSpan(src: string, cls: string, matchClose: InsightContext['matchClose']) {
  const m = new RegExp(`class\\s+${cls}\\b[^{]*\\{`).exec(src);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const close = matchClose(src, open);
  return close > 0 ? { start: m.index, end: close } : null;
}

export function screenDetails(ctx: InsightContext) {
  const screenIds = new Set(ctx.screens.map((s) => s.id));
  return ctx.screens.map((s) => {
    const abs = path.join(ctx.dir, s.file);
    const src = ctx.sources.get(abs) ?? '';
    const raw = readText(abs) ?? '';
    const span = classSpan(src, s.id, ctx.matchClose);
    const body = span ? src.slice(span.start, span.end) : src;
    // Constructor parameters: X({super.key, required this.lessonId, this.foo})
    const ctor = new RegExp(`\\b${s.id}\\s*\\(\\s*\\{([^}]*)\\}`).exec(body);
    const params = ctor
      ? ctor[1]
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p && !/super\.key|Key\?\s*key/.test(p))
          .map((p) => ({ name: p.replace(/^required\s+/, '').replace(/^this\.|^super\./, '').split(/[\s=]/)[0], required: /^required\b/.test(p) }))
      : [];
    const kind = /extends\s+(\w+)/.exec(src.slice(span?.start ?? 0))?.[1] ?? null;
    const widgets = uniq([...src.matchAll(/\b([A-Z]\w*)\s*\(/g)].map((m) => m[1])).filter((c) => ctx.widgetClasses.has(c) && c !== s.id && !screenIds.has(c) && !c.startsWith('_'));
    const privateWidgets = uniq([...src.matchAll(/class\s+(_[A-Z]\w*)\s+extends\s+(?:Stateless|Stateful|Consumer)\w*/g)].map((m) => m[1]));
    return {
      id: s.id,
      file: s.file,
      abs_path: abs,
      lines: raw ? raw.split('\n').length : null,
      kind,
      route: s.route,
      route_params: s.route ? [...s.route.matchAll(/:(\w+)/g)].map((m) => m[1]) : [],
      ctor_params: params,
      widgets: widgets.slice(0, 40),
      private_widgets: privateWidgets.slice(0, 30),
      state: stateUsedIn(src).slice(0, 40),
      dialogs: (src.match(/\bshow(?:Dialog|ModalBottomSheet|CupertinoDialog|GeneralDialog)\s*[<(]/g) ?? []).length,
      snackbars: (src.match(/showSnackBar\s*\(/g) ?? []).length,
    };
  });
}

// ---------------------------------------------------------------- state & data map

const PROVIDER_TYPES = /^(?:StateNotifierProvider|NotifierProvider|AsyncNotifierProvider|ChangeNotifierProvider|StateProvider|FutureProvider|StreamProvider|Provider|AutoDisposeProvider|AutoDisposeNotifierProvider|AutoDisposeAsyncNotifierProvider|AutoDisposeFutureProvider|AutoDisposeStreamProvider|AutoDisposeStateNotifierProvider)$/;
const DATA_CLASS = /class\s+(\w+(?:Repository|Repo|Service|Api|ApiClient|Client|Dao|DataSource|Database|Db|Storage|Store))\b/g;

export interface StateNode {
  id: string;
  name: string;
  kind: string;
  file: string;
}

export function stateMap(ctx: InsightContext, details: ReturnType<typeof screenDetails>) {
  const state: (StateNode & { body: string })[] = [];
  const data: StateNode[] = [];
  for (const [abs, src] of ctx.sources) {
    const file = ctx.rel(abs);
    // final xProvider = StateNotifierProvider<…>((ref) …) / Provider.family<…>(…)
    for (const m of src.matchAll(/\bfinal\s+(\w+)\s*=\s*([A-Z]\w*)((?:\.\w+)*)\s*/g)) {
      if (!PROVIDER_TYPES.test(m[2])) continue;
      let i = m.index! + m[0].length;
      if (src[i] === '<') {
        let depth = 0;
        for (; i < src.length; i++) {
          if (src[i] === '<') depth++;
          else if (src[i] === '>' && --depth === 0) {
            i++;
            break;
          }
        }
        while (/\s/.test(src[i] ?? '')) i++;
      }
      if (src[i] !== '(') continue;
      const close = ctx.matchClose(src, i);
      state.push({ id: `p_${m[1]}`, name: m[1], kind: `${m[2]}${m[3] ?? ''}`, file, body: close > 0 ? src.slice(i, close) : '' });
    }
    // riverpod_generator: @riverpod Foo bar(Ref ref) {…} / @riverpod class Bar extends _$Bar {…}
    for (const m of src.matchAll(/@[Rr]iverpod(?:\([^)]*\))?\s+(?:class\s+(\w+)|[\w<>?, ]+?\s+(\w+)\s*\()/g)) {
      const base = m[1] ?? m[2];
      if (!base) continue;
      const name = `${base.charAt(0).toLowerCase()}${base.slice(1)}Provider`;
      const open = src.indexOf('{', m.index!);
      const close = open > 0 ? ctx.matchClose(src, open) : -1;
      state.push({ id: `p_${name}`, name, kind: m[1] ? 'Notifier (@riverpod)' : 'Provider (@riverpod)', file, body: close > 0 ? src.slice(open, close) : '' });
    }
    // Blocs, cubits, ChangeNotifiers, GetX controllers
    for (const m of src.matchAll(/class\s+(\w+)\s+(?:extends\s+(Bloc|Cubit|HydratedBloc|HydratedCubit|ChangeNotifier|GetxController|StateNotifier|Notifier|AsyncNotifier)\b|(?:extends\s+\w+\s+)?with\s+ChangeNotifier\b)/g)) {
      if (state.some((s) => s.name === m[1])) continue;
      const open = src.indexOf('{', m.index!);
      const close = open > 0 ? ctx.matchClose(src, open) : -1;
      state.push({ id: `c_${m[1]}`, name: m[1], kind: m[2] ?? 'ChangeNotifier', file, body: close > 0 ? src.slice(open, close) : '' });
    }
    for (const m of src.matchAll(DATA_CLASS)) {
      if (data.some((d) => d.name === m[1]) || state.some((s) => s.name === m[1])) continue;
      data.push({ id: `d_${m[1]}`, name: m[1], kind: m[1].match(/(Repository|Repo|Service|Api|ApiClient|Client|Dao|DataSource|Database|Db|Storage|Store)$/)?.[1] ?? 'data', file });
    }
  }
  const byName = new Map(state.map((s) => [s.name, s]));
  const edges: { from: string; to: string; kind: 'uses' | 'depends' | 'data' }[] = [];
  const add = (from: string, to: string, kind: 'uses' | 'depends' | 'data') => {
    if (from !== to && !edges.some((e) => e.from === from && e.to === to)) edges.push({ from, to, kind });
  };
  for (const d of details) for (const u of d.state) if (byName.has(u.name)) add(`s_${d.id}`, byName.get(u.name)!.id, 'uses');
  for (const s of state) {
    for (const m of s.body.matchAll(/\bref\s*\.\s*(?:watch|read|listen)\s*\(\s*([a-z]\w*)/g)) if (byName.has(m[1])) add(s.id, byName.get(m[1])!.id, 'depends');
    // A provider that creates a controller class: quizControllerProvider → QuizController
    for (const t of state) if (t !== s && /^[A-Z]/.test(t.name) && new RegExp(`\\b${t.name}\\b`).test(s.body)) add(s.id, t.id, 'depends');
    for (const d of data) if (new RegExp(`\\b${d.name}\\b`).test(s.body)) add(s.id, d.id, 'data');
  }
  const usedScreens = new Set(edges.filter((e) => e.kind === 'uses').map((e) => e.from));
  const usedData = new Set(edges.filter((e) => e.kind === 'data').map((e) => e.to));
  // Unused = never referenced anywhere except its own definition (app.dart, widgets, other providers all count).
  const allSrc = [...ctx.sources.values()].join('\n');
  const unusedState = state
    .filter((s) => !s.name.startsWith('_') && (allSrc.match(new RegExp(`\\b${s.name}\\b`, 'g')) ?? []).length <= 1)
    .map((s) => s.name);

  // Diagram: three columns (Screens → State → Data). To keep it readable:
  //  - a provider and the controller class it creates become one box (quizControllerProvider + QuizController),
  //  - provider→provider links are left out (they are in the table),
  //  - a provider whose only job is to hand out a repository/service points straight at it.
  const safe = (s: string) => s.replace(/[^\w]/g, '_');
  const merged = new Map<string, string>(); // controller id → provider id
  for (const s of state.filter((x) => x.id.startsWith('p_'))) {
    const ctrl = edges.filter((e) => e.from === s.id && e.kind === 'depends' && e.to.startsWith('c_'));
    if (ctrl.length === 1 && edges.filter((e) => e.to === ctrl[0].to).length === 1) merged.set(ctrl[0].to, s.id);
  }
  const node = (id: string) => merged.get(id) ?? id;
  const diag = new Map<string, { from: string; to: string }>();
  for (const e of edges) {
    if (e.kind === 'depends') continue;
    const from = node(e.from);
    const to = node(e.to);
    if (from !== to) diag.set(`${from}>${to}`, { from, to });
  }
  // Controllers merged into a provider pass their repository links up to it.
  for (const [c, p] of merged) for (const e of edges.filter((x) => x.from === c && x.kind === 'data')) diag.set(`${p}>${e.to}`, { from: p, to: e.to });
  const linked = new Set([...diag.values()].flatMap((e) => [e.from, e.to]));
  const lines = ['flowchart LR'];
  const shownScreens = details.filter((d) => linked.has(`s_${d.id}`));
  // No subgraphs: with cross-links Mermaid ignores their direction and sprawls. Colour per layer instead;
  // left-to-right ranking naturally puts screens, state and data in three columns.
  for (const d of shownScreens) lines.push(`  s_${safe(d.id)}["${d.id.replace(/(Screen|Page|View)$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2')}"]:::screen`)
  const shownState = state.filter((s) => linked.has(s.id) && !merged.has(s.id));
  for (const s of shownState) {
    const ctrl = [...merged.entries()].find(([, p]) => p === s.id)?.[0];
    const sub = ctrl ? `→ ${state.find((x) => x.id === ctrl)?.name}` : s.kind.replace(/[<>"]/g, '');
    lines.push(`  ${safe(s.id)}(["${s.name}<br/><small>${sub}</small>"]):::state`);
  }
  const shownData = data.filter((d) => linked.has(d.id));
  for (const d of shownData) lines.push(`  ${safe(d.id)}[("${d.name}")]:::data`);
  for (const e of diag.values()) lines.push(`  ${safe(e.from)} --> ${safe(e.to)}`);
  lines.push('  classDef screen fill:#2f6fe0,color:#fff,stroke:#2f6fe0');
  lines.push('  classDef state fill:#7c3aed,color:#fff,stroke:#7c3aed');
  lines.push('  classDef data fill:#0f9f6e,color:#fff,stroke:#0f9f6e');

  return {
    state: state.map(({ body: _b, ...s }) => ({ ...s, used_by: edges.filter((e) => e.to === s.id && e.kind === 'uses').map((e) => e.from.slice(2)) })),
    data: data.map((d) => ({ ...d, used_by: edges.filter((e) => e.to === d.id).map((e) => byName.get(state.find((s) => s.id === e.from)?.name ?? '')?.name ?? e.from) })),
    edges,
    unused_state: unusedState,
    mermaid: state.length ? lines.join('\n') : '',
  };
}

// ---------------------------------------------------------------- assets & strings

export function assetsAndStrings(ctx: InsightContext) {
  // Declared assets: "dir/" = the files directly inside it (Flutter does not recurse), otherwise a single file.
  const declared: { path: string; size: number }[] = [];
  const missingDeclared: string[] = [];
  for (const a of ctx.assets) {
    const abs = path.join(ctx.dir, a);
    if (a.endsWith('/')) {
      try {
        for (const f of fs.readdirSync(abs, { withFileTypes: true })) if (f.isFile()) declared.push({ path: `${a}${f.name}`, size: fs.statSync(path.join(abs, f.name)).size });
      } catch {
        missingDeclared.push(a);
      }
    } else if (fs.existsSync(abs)) declared.push({ path: a, size: fs.statSync(abs).size });
    else missingDeclared.push(a);
  }
  const allSrc = [...ctx.sources.values()].join('\n');
  const literals = uniq([...allSrc.matchAll(/(['"])((?:assets|images|fonts|res)\/[^'"$]+\.[\w]{2,5})\1/g)].map((m) => m[2]));
  const pubspecText = readText(path.join(ctx.dir, 'pubspec.yaml')) ?? '';
  const status = declared.map((d) => {
    const base = path.posix.basename(d.path);
    const used = literals.includes(d.path) ? 'used' : allSrc.includes(base) || pubspecText.split(/\r?\n/).some((l) => !/^\s+-\s/.test(l) && l.includes(d.path)) ? 'maybe' : 'unused';
    return { ...d, used };
  });
  const declaredSet = new Set(declared.map((d) => d.path));
  const missingReferenced = literals.filter((l) => !declaredSet.has(l) && !fs.existsSync(path.join(ctx.dir, l)));
  const notDeclared = literals.filter((l) => !declaredSet.has(l) && fs.existsSync(path.join(ctx.dir, l)));

  // Localization (.arb files)
  let l10n: { dir: string; template: string; locales: { locale: string; keys: number; missing: string[] }[] } | null = null;
  const l10nYaml = readText(path.join(ctx.dir, 'l10n.yaml'));
  const arbDir = l10nYaml?.match(/arb-dir:\s*(\S+)/)?.[1] ?? 'lib/l10n';
  const arbAbs = path.join(ctx.dir, arbDir);
  if (fs.existsSync(arbAbs)) {
    const files = fs.readdirSync(arbAbs).filter((f) => f.endsWith('.arb'));
    const keysOf = (f: string) => {
      try {
        return Object.keys(JSON.parse(fs.readFileSync(path.join(arbAbs, f), 'utf8'))).filter((k) => !k.startsWith('@'));
      } catch {
        return [];
      }
    };
    const template = l10nYaml?.match(/template-arb-file:\s*(\S+)/)?.[1] ?? files.find((f) => /_en\.arb$/.test(f)) ?? files[0];
    if (template) {
      const tKeys = keysOf(template);
      l10n = {
        dir: arbDir,
        template,
        locales: files.map((f) => {
          const k = new Set(keysOf(f));
          return { locale: f.replace(/^.*?_([\w-]+)\.arb$/, '$1'), keys: k.size, missing: tKeys.filter((x) => !k.has(x)).slice(0, 50) };
        }),
      };
    }
  }

  // Hard-coded UI strings (candidates for localization)
  const hard: { file: string; count: number }[] = [];
  for (const [abs, src] of ctx.sources) {
    const n = (src.match(/\bText\s*\(\s*(['"])[^'"$]{3,}\1/g) ?? []).length + (src.match(/\b(?:title|label|hintText|labelText|tooltip)\s*:\s*(?:const\s+Text\s*\(\s*)?(['"])[^'"$]{3,}\1/g) ?? []).length;
    if (n) hard.push({ file: ctx.rel(abs), count: n });
  }
  hard.sort((a, b) => b.count - a.count);

  // TODO / FIXME / HACK (raw files — comments were stripped from the parsed sources)
  const todos: { file: string; line: number; text: string }[] = [];
  const sizes: { file: string; lines: number }[] = [];
  for (const abs of ctx.sources.keys()) {
    const raw = readText(abs);
    if (!raw) continue;
    const ls = raw.split(/\r?\n/);
    sizes.push({ file: ctx.rel(abs), lines: ls.length });
    ls.forEach((l, i) => {
      const m = l.match(/\/\/\s*(TODO|FIXME|HACK|XXX)\b[:\s(]*(.*)$/);
      if (m && todos.length < 300) todos.push({ file: ctx.rel(abs), line: i + 1, text: `${m[1]}: ${m[2].trim()}`.slice(0, 200) });
    });
  }
  sizes.sort((a, b) => b.lines - a.lines);

  return {
    assets: {
      declared_entries: ctx.assets,
      files: status.sort((a, b) => b.size - a.size),
      total_bytes: declared.reduce((s, d) => s + d.size, 0),
      missing_declared: missingDeclared,
      missing_referenced: missingReferenced,
      referenced_not_declared: notDeclared,
      uses_flutter_gen: !!ctx.devDependencies.flutter_gen_runner || !!ctx.dependencies.flutter_gen,
    },
    l10n,
    hardcoded_strings: { total: hard.reduce((s, h) => s + h.count, 0), files: hard.slice(0, 15) },
    todos,
    biggest_files: sizes.slice(0, 10),
  };
}

// ---------------------------------------------------------------- release checklist

export interface CheckItem {
  id: string;
  group: 'App' | 'Android' | 'iOS' | 'Code';
  label: string;
  status: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
  fix?: string;
}

const NETWORK_PKGS = /^(http|dio|retrofit|chopper|graphql_flutter|graphql|web_socket_channel|supabase_flutter|appwrite|cached_network_image|google_fonts|firebase_\w+|cloud_firestore|cloud_functions|google_mobile_ads|url_launcher|webview_flutter|flutter_inappwebview|video_player)$/;
const ANDROID_PERMS: [RegExp, string[], string][] = [
  [/^(camera|image_picker|mobile_scanner|qr_code_scanner)$/, ['android.permission.CAMERA'], 'camera'],
  [/^(geolocator|location|google_maps_flutter)$/, ['android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION'], 'location'],
  [/^(record|speech_to_text|flutter_sound|audio_waveforms)$/, ['android.permission.RECORD_AUDIO'], 'microphone'],
  [/^(flutter_local_notifications|firebase_messaging|awesome_notifications)$/, ['android.permission.POST_NOTIFICATIONS'], 'notifications (Android 13+)'],
];
const IOS_KEYS: [RegExp, string[]][] = [
  [/^(camera|mobile_scanner|qr_code_scanner)$/, ['NSCameraUsageDescription']],
  [/^image_picker$/, ['NSCameraUsageDescription', 'NSPhotoLibraryUsageDescription']],
  [/^(geolocator|location|google_maps_flutter)$/, ['NSLocationWhenInUseUsageDescription']],
  [/^(record|flutter_sound|audio_waveforms)$/, ['NSMicrophoneUsageDescription']],
  [/^speech_to_text$/, ['NSMicrophoneUsageDescription', 'NSSpeechRecognitionUsageDescription']],
  [/^local_auth$/, ['NSFaceIDUsageDescription']],
  [/^(flutter_contacts|contacts_service)$/, ['NSContactsUsageDescription']],
];

export function releaseChecklist(ctx: InsightContext): CheckItem[] {
  const items: CheckItem[] = [];
  const deps = Object.keys(ctx.dependencies);
  const dev = Object.keys(ctx.devDependencies);

  // ---- App
  const v = ctx.version;
  items.push(
    v && /^\d+\.\d+\.\d+\+\d+$/.test(v)
      ? { id: 'version', group: 'App', label: 'Version & build number', status: 'ok', detail: `${v} — bump the +build number for every Play Store upload` }
      : { id: 'version', group: 'App', label: 'Version & build number', status: 'warn', detail: v ? `${v} has no +build number` : 'No version in pubspec.yaml', fix: 'Set version: 1.0.0+1 in pubspec.yaml' },
  );
  items.push(
    dev.includes('flutter_launcher_icons') || deps.includes('flutter_launcher_icons')
      ? { id: 'icon', group: 'App', label: 'App icon', status: 'ok', detail: 'flutter_launcher_icons is configured' }
      : { id: 'icon', group: 'App', label: 'App icon', status: 'warn', detail: 'No flutter_launcher_icons — the app may still have the default Flutter icon', fix: 'Add flutter_launcher_icons and run dart run flutter_launcher_icons' },
  );
  items.push(
    dev.includes('flutter_native_splash') || deps.includes('flutter_native_splash')
      ? { id: 'splash', group: 'App', label: 'Splash screen', status: 'ok', detail: 'flutter_native_splash is configured' }
      : { id: 'splash', group: 'App', label: 'Splash screen', status: 'info', detail: 'Default white launch screen (optional: flutter_native_splash)' },
  );

  // ---- Android
  if (ctx.platforms.includes('android')) {
    const manifest = readText(path.join(ctx.dir, 'android', 'app', 'src', 'main', 'AndroidManifest.xml')) ?? '';
    const gradle = readText(path.join(ctx.dir, 'android', 'app', 'build.gradle.kts')) ?? readText(path.join(ctx.dir, 'android', 'app', 'build.gradle')) ?? '';
    const perms = new Set([...manifest.matchAll(/uses-permission[^>]*android:name="([^"]+)"/g)].map((m) => m[1]));
    const appId = ctx.android?.application_id ?? null;
    items.push(
      !appId
        ? { id: 'appid', group: 'Android', label: 'Application ID', status: 'warn', detail: 'Could not read applicationId from android/app/build.gradle' }
        : /^com\.example\./.test(appId)
          ? { id: 'appid', group: 'Android', label: 'Application ID', status: 'fail', detail: `${appId} — Google Play rejects com.example.*`, fix: 'Change applicationId (and namespace) in android/app/build.gradle(.kts) to your own reverse domain' }
          : { id: 'appid', group: 'Android', label: 'Application ID', status: 'ok', detail: `${appId} (cannot be changed after the first Play upload)` },
    );
    const label = manifest.match(/android:label="([^"]+)"/)?.[1];
    items.push({ id: 'label', group: 'Android', label: 'App name on the home screen', status: label ? 'ok' : 'warn', detail: label ? `"${label}"` : 'No android:label in AndroidManifest.xml' });

    const network = deps.filter((d) => NETWORK_PKGS.test(d));
    if (network.length)
      items.push(
        perms.has('android.permission.INTERNET')
          ? { id: 'internet', group: 'Android', label: 'INTERNET permission', status: 'ok', detail: `Present — needed by ${network.join(', ')}` }
          : {
              id: 'internet',
              group: 'Android',
              label: 'INTERNET permission',
              status: 'fail',
              detail: `Missing from src/main/AndroidManifest.xml, but ${network.join(', ')} need the network. Debug builds add it automatically, release builds do not — it works while developing and breaks in the store build.${network.includes('google_fonts') ? ' google_fonts downloads fonts at runtime, so text falls back to the default font.' : ''}`,
              fix: 'Add <uses-permission android:name="android.permission.INTERNET"/> above <application> in android/app/src/main/AndroidManifest.xml',
            },
      );
    for (const [re, needed, what] of ANDROID_PERMS) {
      const pk = deps.filter((d) => re.test(d));
      if (!pk.length) continue;
      const missing = needed.filter((p) => !perms.has(p));
      items.push(
        missing.length
          ? { id: `perm-${what}`, group: 'Android', label: `Permission: ${what}`, status: 'warn', detail: `${pk.join(', ')} used but ${missing.map((m) => m.split('.').pop()).join(', ')} not declared`, fix: missing.map((m) => `<uses-permission android:name="${m}"/>`).join('  ') }
          : { id: `perm-${what}`, group: 'Android', label: `Permission: ${what}`, status: 'ok', detail: `Declared for ${pk.join(', ')}` },
      );
    }
    if (/usesCleartextTraffic="true"/.test(manifest))
      items.push({ id: 'cleartext', group: 'Android', label: 'Cleartext HTTP', status: 'warn', detail: 'usesCleartextTraffic="true" allows unencrypted http:// traffic', fix: 'Use https:// and remove usesCleartextTraffic, or limit it with a network security config' });

    const sdk = (v: string | null | undefined) => (!v ? null : v.startsWith('flutter.') ? 'Flutter default' : v);
    const target = sdk(ctx.android?.target_sdk);
    items.push(
      !target
        ? { id: 'target', group: 'Android', label: 'targetSdk', status: 'info', detail: 'Not found' }
        : target === 'Flutter default' || Number(target) >= 35
          ? { id: 'target', group: 'Android', label: 'targetSdk', status: 'ok', detail: `${target} (Google Play requires a recent targetSdk for new apps and updates)` }
          : { id: 'target', group: 'Android', label: 'targetSdk', status: 'fail', detail: `${target} is too old for Google Play`, fix: 'Set targetSdk = flutter.targetSdkVersion (or 35+) and upgrade Flutter' },
    );
    items.push({ id: 'min', group: 'Android', label: 'minSdk', status: 'info', detail: `${sdk(ctx.android?.min_sdk) ?? 'not found'} — devices below this cannot install the app` });

    const releaseBlock = gradle.match(/release\s*\{[^}]*\}/)?.[0] ?? '';
    const debugSigned = /signingConfig\s*=?\s*signingConfigs\.(?:getByName\("debug"\)|debug)/.test(releaseBlock);
    const keyProps = fs.existsSync(path.join(ctx.dir, 'android', 'key.properties'));
    items.push(
      debugSigned
        ? { id: 'signing', group: 'Android', label: 'Release signing', status: 'fail', detail: 'The release build is signed with the debug key — Google Play rejects it', fix: 'Create an upload keystore, add android/key.properties and a release signingConfig (see docs.flutter.dev/deployment/android)' }
        : /signingConfigs[\s\S]*release/.test(gradle)
          ? {
              id: 'signing',
              group: 'Android',
              label: 'Release signing',
              status: keyProps ? 'ok' : 'warn',
              detail: keyProps ? 'Release signingConfig + android/key.properties present (contents not read)' : 'Release signingConfig found, but android/key.properties is missing on this PC',
              fix: keyProps ? undefined : 'Create android/key.properties with storeFile, storePassword, keyAlias, keyPassword',
            }
          : { id: 'signing', group: 'Android', label: 'Release signing', status: 'warn', detail: 'No release signingConfig found in build.gradle', fix: 'Add a release signingConfig (docs.flutter.dev/deployment/android#configure-signing-in-gradle)' },
    );
    if (keyProps) {
      const gi = readText(path.join(ctx.dir, '.gitignore')) ?? '';
      const agi = readText(path.join(ctx.dir, 'android', '.gitignore')) ?? '';
      const ignored = /key\.properties/.test(gi + agi);
      items.push({
        id: 'keyprops-git',
        group: 'Android',
        label: 'Keystore secrets kept out of git',
        status: ignored ? 'ok' : 'fail',
        detail: ignored ? 'key.properties is in .gitignore' : 'key.properties is NOT in .gitignore — your signing passwords could be committed',
        fix: ignored ? undefined : 'Add key.properties and *.jks / *.keystore to android/.gitignore',
      });
    }
    items.push(
      /isMinifyEnabled\s*=\s*true|minifyEnabled\s+true/.test(releaseBlock)
        ? { id: 'r8', group: 'Android', label: 'Code shrinking (R8)', status: 'ok', detail: 'Enabled for release' }
        : { id: 'r8', group: 'Android', label: 'Code shrinking (R8)', status: 'info', detail: 'Flutter enables R8 by default for release; nothing to do unless you turned it off' },
    );
  }

  // ---- iOS
  if (ctx.platforms.includes('ios')) {
    const plist = readText(path.join(ctx.dir, 'ios', 'Runner', 'Info.plist')) ?? '';
    const name = plist.match(/<key>CFBundleDisplayName<\/key>\s*<string>([^<]*)<\/string>/)?.[1];
    items.push({ id: 'ios-name', group: 'iOS', label: 'Display name', status: name ? 'ok' : 'warn', detail: name ? `"${name}"` : 'No CFBundleDisplayName in ios/Runner/Info.plist' });
    for (const [re, keys] of IOS_KEYS) {
      const pk = deps.filter((d) => re.test(d));
      if (!pk.length) continue;
      const missing = keys.filter((k) => !plist.includes(`<key>${k}</key>`));
      items.push(
        missing.length
          ? { id: `ios-${keys[0]}`, group: 'iOS', label: `Usage description for ${pk.join(', ')}`, status: 'fail', detail: `${missing.join(', ')} missing — the app crashes when it asks for the permission, and App Review rejects it`, fix: `Add ${missing.map((k) => `<key>${k}</key><string>Why you need it</string>`).join(' ')} to ios/Runner/Info.plist` }
          : { id: `ios-${keys[0]}`, group: 'iOS', label: `Usage description for ${pk.join(', ')}`, status: 'ok', detail: keys.join(', ') },
      );
    }
  }

  // ---- Code
  const allSrc = [...ctx.sources.values()].join('\n');
  const prints = (allSrc.match(/(^|[^\w.])print\s*\(/gm) ?? []).length;
  items.push(
    prints
      ? { id: 'print', group: 'Code', label: 'print() calls', status: 'warn', detail: `${prints} print() call${prints === 1 ? '' : 's'} — they also run in release builds`, fix: 'Use debugPrint or a logger (or wrap in if (kDebugMode))' }
      : { id: 'print', group: 'Code', label: 'print() calls', status: 'ok', detail: 'None' },
  );
  const lint = dev.some((d) => /^(flutter_lints|lints|very_good_analysis)$/.test(d));
  items.push({ id: 'lints', group: 'Code', label: 'Lints', status: lint ? 'ok' : 'warn', detail: lint ? 'Lint package configured' : 'No lint package', fix: lint ? undefined : 'flutter pub add --dev flutter_lints' });
  const tests = fs.existsSync(path.join(ctx.dir, 'test')) ? fs.readdirSync(path.join(ctx.dir, 'test'), { recursive: true }).filter((f) => String(f).endsWith('_test.dart')).length : 0;
  items.push({ id: 'tests', group: 'Code', label: 'Tests', status: tests ? 'ok' : 'warn', detail: tests ? `${tests} test file${tests === 1 ? '' : 's'} in test/` : 'No *_test.dart files', fix: tests ? undefined : 'Add widget tests for the main screens (flutter test)' });
  return items;
}
