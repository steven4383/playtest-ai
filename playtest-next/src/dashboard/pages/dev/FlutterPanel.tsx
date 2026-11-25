import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderInput } from '../../components/FolderPicker';
import NextLink from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '../../lib/queries';
import {
  Badge as CBadge,
  Box,
  Button,
  Code,
  Collapsible,
  Flex,
  Grid,
  HStack,
  IconButton,
  Input,
  Link,
  List,
  NativeSelect,
  SimpleGrid,
  Spinner,
  Stack,
  Table,
  Tabs,
  Text,
  chakra,
} from '@chakra-ui/react';
import {
  LuBookOpen,
  LuChevronDown,
  LuExternalLink,
  LuFlame,
  LuFolderOpen,
  LuGitBranch,
  LuPlay,
  LuPlus,
  LuRefreshCw,
  LuRotateCcw,
  LuSparkles,
  LuSquare,
  LuTerminal,
  LuX,
} from 'react-icons/lu';
import { API, api, type AdbDevice } from '../../lib/api';
import { Badge, Card, CopyButton, Empty, Kv, Loading, Notice, Spinning, SubHeading, type Tone } from '../../components/ui';
import { notify } from '../../components/toaster';
import { MermaidView } from './MermaidView';
import { AssetsPanel, DoctorPanel, ReleasePanel, ScreenDrawer, StatePanel, type CheckItem, type Insights, type ScreenDetail, type StateMapData } from './FlutterInsights';

interface ProjectRef {
  path: string;
  name: string;
  description: string | null;
  modified: string | null;
  remembered: boolean;
}
interface Analysis {
  path: string;
  pubspec: { name: string; description: string | null; version: string | null; sdk: string | null; flutter: string | null; assets: number };
  packages: { groups: Record<string, string[]>; dev_groups: Record<string, string[]>; count: number; dev_count: number };
  platforms: string[];
  android: { application_id: string | null; namespace: string | null; min_sdk: string | null; target_sdk: string | null } | null;
  structure: { dart_files: number; lines_of_code: number; feature_dir: string | null; architecture: string[]; truncated: boolean };
  navigation: { router: string | null; initial_location: string | null; initial_screen: string | null; guard: boolean; routes: { path: string; screen: string | null; file: string }[] };
  screens: { id: string; label: string; file: string; feature: string; route: string | null }[];
  edges: { from: string; to: string; kind: 'push' | 'go' | 'dynamic' }[];
  tabs: string[][];
  unreached: string[];
  brief: string[];
  mermaid: string;
  screen_details: ScreenDetail[];
  state_map: StateMapData;
  insights: Insights;
  release: CheckItem[];
}
interface RunSession {
  id: string;
  project: string;
  name: string;
  serial: string;
  status: 'launching' | 'running' | 'reloading' | 'stopping' | 'stopped' | 'error';
  message: string | null;
  started_at: string;
  devtools: string | null;
}
interface RunLine {
  t: number;
  kind: 'log' | 'progress' | 'error' | 'info';
  text: string;
}

const PLATFORM: Record<string, string> = { android: 'Android', ios: 'iOS', web: 'Web', windows: 'Windows', macos: 'macOS', linux: 'Linux' };
/** build.gradle often says flutter.minSdkVersion — that means "whatever this Flutter version defaults to". */
const sdkVal = (v: string | null) => (!v ? '?' : v.startsWith('flutter.') ? 'Flutter default' : v);
const RUN_TONE: Record<RunSession['status'], Tone> = { launching: 'warning', running: 'good', reloading: 'warning', stopping: 'neutral', stopped: 'neutral', error: 'critical' };
const KEY = 'pt-flutter-project';
const read = () => {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
};
const save = (p: string) => {
  try {
    localStorage.setItem(KEY, p);
  } catch {
    /* not remembered */
  }
};

/** Last analyses (newest first), kept in the browser so a page refresh doesn't need to re-read the project. */
const ANALYSIS_KEY = 'pt-flutter-analyses';
const MAX_SAVED = 5;
type SavedAnalysis = { path: string; at: number; data: Analysis };
const savedAnalyses = (): SavedAnalysis[] => {
  try {
    return JSON.parse(localStorage.getItem(ANALYSIS_KEY) ?? '[]') as SavedAnalysis[];
  } catch {
    return [];
  }
};
const savedAnalysis = (path: string) => savedAnalyses().find((x) => x.path === path);
const keepAnalysis = (path: string, data: Analysis) => {
  try {
    const list = [{ path, at: Date.now(), data }, ...savedAnalyses().filter((x) => x.path !== path)].slice(0, MAX_SAVED);
    localStorage.setItem(ANALYSIS_KEY, JSON.stringify(list));
  } catch {
    /* storage full or blocked: still cached in memory */
  }
};
const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

function Console({ run }: { run: RunSession }) {
  const [lines, setLines] = useState<RunLine[]>([]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setLines([]);
    const es = new EventSource(`${API}/flutter/runs/${run.id}/stream`);
    es.addEventListener('lines', (m) => setLines((l) => [...l, ...(JSON.parse((m as MessageEvent).data) as RunLine[])].slice(-1500)));
    return () => es.close();
  }, [run.id]);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines]);
  return (
    <Box ref={box} bg="gray.950" color="gray.100" borderRadius="md" px="3" py="2" h="300px" overflowY="auto" fontFamily="mono" fontSize="xs" lineHeight="1.5">
      {lines.length === 0 ? (
        <Text color="gray.400">Waiting for output…</Text>
      ) : (
        lines.map((l, i) => (
          <Box key={i} whiteSpace="pre-wrap" wordBreak="break-word" color={l.kind === 'error' ? 'red.300' : l.kind === 'progress' ? 'blue.300' : l.kind === 'info' ? 'green.300' : undefined}>
            {l.text}
          </Box>
        ))
      )}
    </Box>
  );
}

function RunCard({ project, device, flutterOk }: { project: Analysis; device: AdbDevice | null; flutterOk: boolean | null }) {
  const [run, setRun] = useState<RunSession | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await api<{ runs: RunSession[] }>('/flutter/runs').catch(() => ({ runs: [] as RunSession[] }));
    const mine = r.runs.filter((x) => x.project === project.path && (!device || x.serial === device.serial));
    setRun(mine.find((x) => !['stopped', 'error'].includes(x.status)) ?? mine[0] ?? null);
  }, [project.path, device?.serial]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Follow status while a run is alive.
  useEffect(() => {
    if (!run || ['stopped', 'error'].includes(run.status)) return;
    const es = new EventSource(`${API}/flutter/runs/${run.id}/stream`);
    es.addEventListener('status', (m) => {
      const s = JSON.parse((m as MessageEvent).data) as RunSession | undefined;
      if (s) setRun((cur) => (cur && cur.id === s.id ? { ...cur, ...s } : cur));
    });
    return () => es.close();
  }, [run?.id, run?.status === 'stopped' || run?.status === 'error']);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setBusy(null);
    }
  };

  const start = () =>
    act('run', async () => {
      const s = await api<RunSession>('/flutter/run', { method: 'POST', body: JSON.stringify({ path: project.path, serial: device!.serial }) });
      setRun(s);
    });
  const terminal = () =>
    act('term', async () => {
      const r = await api<{ message: string }>('/flutter/terminal', { method: 'POST', body: JSON.stringify({ path: project.path, serial: device!.serial }) });
      notify('ok', r.message);
    });
  const call = (what: 'reload' | 'restart' | 'stop') =>
    act(what, async () => {
      const r = await api<{ message?: string }>(`/flutter/runs/${run!.id}/${what}`, { method: 'POST', body: '{}' });
      if (what !== 'stop' && r.message) notify('ok', r.message);
      await refresh();
    });

  const alive = run && !['stopped', 'error'].includes(run.status);
  const cmd = `cd "${project.path}" && flutter run${device ? ` -d ${device.serial}` : ''}`;

  return (
    <Card
      icon={<LuPlay />}
      title={device ? `Run on ${device.avd_name ?? device.model ?? device.serial}` : 'Run the app'}
      subtitle={`flutter run from ${project.pubspec.name} — hot reload without a terminal`}
      actions={run && <Badge tone={RUN_TONE[run.status]}>{run.status}</Badge>}
    >
      {flutterOk === null ? (
        <HStack gap="2" fontSize="sm" color="fg.muted">
          <Spinner size="xs" /> <Text>Checking the Flutter SDK…</Text>
        </HStack>
      ) : !flutterOk ? (
        <Notice tone="warning">Flutter SDK not found. Add flutter\bin to PATH or set FLUTTER_ROOT in backend/.env.</Notice>
      ) : !device ? (
        <Notice tone="info">Pick a connected device in the list on the left.</Notice>
      ) : device.state !== 'device' ? (
        <Notice tone="warning">This device is {device.state} — it must be ready to run the app.</Notice>
      ) : (
        <>
          <Flex gap="2" wrap="wrap" align="center">
            {!alive ? (
              <>
                <Button size="sm" onClick={() => void start()} loading={busy === 'run'}>
                  <LuPlay /> Run here
                </Button>
                <Button size="sm" variant="outline" onClick={() => void terminal()} loading={busy === 'term'} title="Opens a console window; type r / R there">
                  <LuTerminal /> Open in terminal
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" colorPalette="orange" onClick={() => void call('reload')} loading={busy === 'reload' || run!.status === 'reloading'} disabled={run!.status !== 'running' && run!.status !== 'reloading'}>
                  <LuFlame /> Hot reload
                </Button>
                <Button size="sm" variant="outline" onClick={() => void call('restart')} loading={busy === 'restart'} disabled={run!.status !== 'running'}>
                  <LuRotateCcw /> Hot restart
                </Button>
                <Button size="sm" variant="ghost" colorPalette="red" onClick={() => void call('stop')} loading={busy === 'stop' || run!.status === 'stopping'}>
                  <LuSquare /> Stop
                </Button>
                {run!.devtools && (
                  <Button asChild size="sm" variant="ghost">
                    <a href={run!.devtools} target="_blank" rel="noreferrer">
                      <LuExternalLink /> DevTools
                    </a>
                  </Button>
                )}
              </>
            )}
          </Flex>
          {run && (
            <HStack gap="2" fontSize="xs" color={run.status === 'error' ? 'fg.error' : 'fg.muted'}>
              {(run.status === 'launching' || run.status === 'reloading') && <Spinner size="xs" />}
              <Text>{run.message}</Text>
              {run.status === 'launching' && <Text color="fg.subtle">· the first build can take a few minutes</Text>}
            </HStack>
          )}
          {run && <Console run={run} />}
        </>
      )}
      <HStack gap="1" fontSize="xs" color="fg.muted" wrap="wrap">
        <Text>Or in your own terminal:</Text>
        <Code size="sm" whiteSpace="normal" wordBreak="break-all" maxW="100%">{cmd}</Code>
        <CopyButton value={cmd} />
      </HStack>
    </Card>
  );
}

function Brief({ a }: { a: Analysis }) {
  const groups = Object.entries(a.packages.groups).filter(([g]) => g !== 'Other');
  const other = a.packages.groups.Other ?? [];
  return (
    <Card icon={<LuBookOpen />} title={`${a.pubspec.name}${a.pubspec.version ? ` ${a.pubspec.version}` : ''}`} subtitle={a.pubspec.description ?? 'Project brief'}>
      <Stack gap="1.5" fontSize="sm">
        {a.brief.slice(1).map((s, i) => (
          <Text key={i}>{s}</Text>
        ))}
      </Stack>
      <HStack gap="1.5" wrap="wrap">
        {a.platforms.map((p) => (
          <CBadge key={p} variant="outline" size="sm">
            {PLATFORM[p] ?? p}
          </CBadge>
        ))}
      </HStack>
      <Grid templateColumns={{ base: '1fr', md: '1fr 1fr' }} gap="5" alignItems="start">
        <Kv
          items={[
            ['Dart SDK', a.pubspec.sdk ?? '—'],
            ['Android id', a.android?.application_id ? <HStack gap="1">{a.android.application_id}<CopyButton value={a.android.application_id} /></HStack> : '—'],
            ['min / target SDK', a.android ? `${sdkVal(a.android.min_sdk)} / ${sdkVal(a.android.target_sdk)}` : '—'],
            ['Code', `${a.structure.dart_files} Dart files · ${a.structure.lines_of_code.toLocaleString()} lines${a.structure.truncated ? ' (first 3000 files)' : ''}`],
            ['Structure', a.structure.architecture.join(', ')],
            ['Navigation', `${a.navigation.router ?? 'Navigator push'}${a.navigation.initial_location ? ` · starts at ${a.navigation.initial_location}` : ''}${a.navigation.guard ? ' · redirect guard' : ''}`],
          ]}
        />
        <Stack gap="2">
          {groups.map(([g, list]) => (
            <Box key={g}>
              <Text fontSize="xs" color="fg.muted" mb="1">
                {g}
              </Text>
              <HStack gap="1" wrap="wrap">
                {list.map((p) => (
                  <CBadge key={p} size="sm" variant="subtle" colorPalette="blue" fontFamily="mono">
                    {p}
                  </CBadge>
                ))}
              </HStack>
            </Box>
          ))}
          {other.length > 0 && (
            <Text fontSize="xs" color="fg.muted">
              Other: {other.join(', ')}
            </Text>
          )}
        </Stack>
      </Grid>
    </Card>
  );
}

function Flow({ a, onScreen }: { a: Analysis; onScreen: (id: string) => void }) {
  const [table, setTable] = useState(true);
  return (
    <Card
      icon={<LuGitBranch />}
      title="Screen flow"
      subtitle={`${a.screens.length} screens · ${a.edges.length} navigation links, read from your routes and push/go calls · click a screen for details`}
      actions={<CopyButton value={a.mermaid} label="Copy Mermaid" />}
    >
      {a.screens.length === 0 ? (
        <Empty title="No screens found">Screens are widget classes in *_screen / *_page files (or that your routes point to).</Empty>
      ) : (
        <>
          <MermaidView code={a.mermaid} title={`Screen flow — ${a.pubspec.name}`} fileName={`${a.pubspec.name}-flow`} onNodeClick={(id) => a.screens.some((x) => x.id === id) && onScreen(id)} />
          <HStack gap="4" fontSize="xs" color="fg.muted" wrap="wrap">
            <Text>
              <b>→</b> push (back returns)
            </Text>
            <Text>
              <b>⇒</b> go / replace (new stack)
            </Text>
            <Text>
              <b>⇢</b> dynamic (route chosen at runtime, e.g. a menu)
            </Text>
            {a.tabs.length > 0 && <Text>⬡ bottom tabs</Text>}
          </HStack>
          {a.unreached.length > 0 && (
            <Notice tone="warning" title={`${a.unreached.length} screen${a.unreached.length === 1 ? '' : 's'} with no detected way in`}>
              {a.unreached.join(', ')} — maybe opened with a variable route or a result callback; or dead code worth checking.
            </Notice>
          )}
          <Collapsible.Root open={table} onOpenChange={(e) => setTable(e.open)}>
            <Collapsible.Trigger asChild>
              <Button size="xs" variant="ghost" alignSelf="flex-start">
                <LuChevronDown style={{ transform: table ? 'rotate(180deg)' : undefined }} /> {table ? 'Hide' : 'Show'} screens table
              </Button>
            </Collapsible.Trigger>
            <Collapsible.Content>
              <Box overflowX="auto" borderWidth="1px" borderRadius="md" mt="2">
                <Table.Root size="sm">
                  <Table.Header>
                    <Table.Row>
                      <Table.ColumnHeader>Screen</Table.ColumnHeader>
                      <Table.ColumnHeader>Route</Table.ColumnHeader>
                      <Table.ColumnHeader>Feature</Table.ColumnHeader>
                      <Table.ColumnHeader>File</Table.ColumnHeader>
                      <Table.ColumnHeader textAlign="end">Links out</Table.ColumnHeader>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {a.screens.map((s) => (
                      <Table.Row key={s.id} cursor="pointer" onClick={() => onScreen(s.id)} _hover={{ bg: 'bg.muted' }}>
                        <Table.Cell fontWeight="medium">
                          {s.label}
                          {s.id === a.navigation.initial_screen && (
                            <CBadge size="xs" ms="2" colorPalette="blue">
                              start
                            </CBadge>
                          )}
                        </Table.Cell>
                        <Table.Cell fontFamily="mono" fontSize="xs">
                          {s.route ?? '—'}
                        </Table.Cell>
                        <Table.Cell>{s.feature}</Table.Cell>
                        <Table.Cell fontFamily="mono" fontSize="xs" color="fg.muted">
                          {s.file}
                        </Table.Cell>
                        <Table.Cell textAlign="end">{a.edges.filter((e) => e.from === s.id).length}</Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Root>
              </Box>
            </Collapsible.Content>
          </Collapsible.Root>
        </>
      )}
    </Card>
  );
}

function Explain({ a }: { a: Analysis }) {
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!confirm('Send the project structure (screen names, routes, package names and counts — not your source code) to Google Gemini for an explanation?')) return;
    setBusy(true);
    try {
      setText((await api<{ text: string }>('/flutter/explain', { method: 'POST', body: JSON.stringify({ path: a.path }) })).text);
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      icon={<LuSparkles />}
      title="Explain with Gemini"
      subtitle="Optional: a plain-English overview, main user flows and what to test"
      actions={
        <Button size="xs" variant="outline" onClick={() => void go()} loading={busy} loadingText="Thinking…">
          <LuSparkles /> {text ? 'Ask again' : 'Explain this app'}
        </Button>
      }
    >
      {busy && !text ? (
        <Loading rows={4} />
      ) : text ? (
        <Box whiteSpace="pre-wrap" fontSize="sm" bg="bg.subtle" borderWidth="1px" borderRadius="md" p="3" maxH="420px" overflowY="auto">
          {text.replace(/\*\*(.+?)\*\*/g, '$1')}
        </Box>
      ) : (
        <Text fontSize="sm" color="fg.muted">
          Uses the Gemini key from the AI page. Only the analysis facts are sent, never your code.{' '}
          <Link asChild color="colorPalette.fg"><NextLink href="/ai">
            Set up the key
          </NextLink></Link>
          .
        </Text>
      )}
    </Card>
  );
}

function Guide() {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible.Root open={open} onOpenChange={(e) => setOpen(e.open)}>
      <Box borderWidth="1px" borderRadius="lg" bg="bg.panel">
        <Collapsible.Trigger asChild>
          <chakra.button w="100%" display="flex" alignItems="center" justifyContent="space-between" px="4" py="3" cursor="pointer">
            <HStack gap="2">
              <LuBookOpen />
              <Text fontWeight="semibold" fontFamily="heading">
                Quick guide for Flutter developers
              </Text>
            </HStack>
            <LuChevronDown style={{ transform: open ? 'rotate(180deg)' : undefined }} />
          </chakra.button>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <List.Root as="ol" ps="9" pe="4" pb="4" gap="1.5" fontSize="sm">
            <List.Item>
              <b>Connect a device</b> — USB (turn on USB debugging), Wi-Fi QR pairing on Device Manager, or start an emulator from the left list.
            </List.Item>
            <List.Item>
              <b>Select it</b> in the device list. Everything here (Run, Logcat, Apps, Files…) acts on that device.
            </List.Item>
            <List.Item>
              <b>Pick your project</b> above and press <b>Run here</b>. Save a file in your editor, then press <b>Hot reload</b> (keeps state) or <b>Hot restart</b> (resets
              state).
            </List.Item>
            <List.Item>
              <b>Debug</b>: the <b>Logcat</b> tab with “My app only” shows your <Code size="sm">print</Code>/<Code size="sm">debugPrint</Code> output and native errors;{' '}
              <b>Performance</b> shows CPU and memory; <b>Tools</b> toggles dark mode, font size, show taps and records the screen.
            </List.Item>
            <List.Item>
              VS Code and Android Studio see the same devices (one shared ADB server) — you can keep debugging with breakpoints there and use this page for the rest.
            </List.Item>
            <List.Item>
              Release check: build with <Code size="sm">flutter build apk</Code>, upload it on APK Manager, and start an open/close <b>Test run</b> on many devices.
            </List.Item>
          </List.Root>
        </Collapsible.Content>
      </Box>
    </Collapsible.Root>
  );
}

/** Flutter tab: pick a project → brief, flow diagram, run with hot reload, optional Gemini explanation. */
export function FlutterPanel({ device, flutter }: { device: AdbDevice | null; flutter: { available: boolean; version: string | null } | null }) {
  const qc = useQueryClient();
  // Cached across page visits: the project list for the session, each analysis until Re-analyse.
  const projectsQ = useQuery({
    queryKey: qk.flutterProjects,
    staleTime: 10 * 60_000,
    queryFn: () => api<{ projects: ProjectRef[] }>('/flutter/projects').then((r) => r.projects),
  });
  const projects = projectsQ.isError ? (projectsQ.data ?? []) : (projectsQ.data ?? null);
  const [scanning, setScanning] = useState(false);
  const [selected, setSelected] = useState(read);
  const [custom, setCustom] = useState('');
  // Kept until you press Re-analyse (also across browser refreshes), so the screen flow never reloads on its own.
  const analysisQ = useQuery({
    queryKey: qk.flutterAnalysis(selected),
    enabled: !!selected,
    staleTime: Infinity,
    retry: false,
    initialData: () => savedAnalysis(selected)?.data,
    initialDataUpdatedAt: () => savedAnalysis(selected)?.at,
    queryFn: async () => {
      const data = await api<Analysis>('/flutter/analyze', { method: 'POST', body: JSON.stringify({ path: selected }) });
      keepAnalysis(selected, data);
      return data;
    },
  });
  const analysis = analysisQ.data ?? null;
  const analyzing = analysisQ.isFetching;
  const error = analysisQ.error?.message ?? null;

  useEffect(() => {
    if (projectsQ.error) notify('error', projectsQ.error.message);
  }, [projectsQ.error]);
  useEffect(() => {
    if (!selected && projects?.[0]) setSelected(projects[0].path);
  }, [projects, selected]);
  useEffect(() => {
    if (selected) save(selected);
  }, [selected]);

  /** Rescan the disk for projects (bypasses the backend's 5-minute cache). */
  const scan = async (refresh = false) => {
    setScanning(true);
    try {
      const r = await api<{ projects: ProjectRef[] }>(`/flutter/projects${refresh ? '?refresh=true' : ''}`);
      qc.setQueryData(qk.flutterProjects, r.projects);
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setScanning(false);
    }
  };

  const add = async () => {
    try {
      const p = await api<ProjectRef>('/flutter/projects', { method: 'POST', body: JSON.stringify({ path: custom.trim() }) });
      setCustom('');
      await scan();
      setSelected(p.path);
    } catch (e: any) {
      notify('error', e.message);
    }
  };
  const forget = async (p: string) => {
    await api('/flutter/projects', { method: 'DELETE', body: JSON.stringify({ path: p }) }).catch(() => {});
    void scan();
  };

  const current = projects?.find((p) => p.path === selected);

  return (
    <Stack gap="4">
      <Card
        icon={<LuFolderOpen />}
        title="Flutter project"
        subtitle={
          flutter === null
            ? 'Checking the Flutter SDK…'
            : flutter.available
              ? analysis && analysisQ.dataUpdatedAt
                ? `Flutter ${flutter.version ?? ''} · analysed ${ago(analysisQ.dataUpdatedAt)} — press Re-analyse after code changes`
                : `Flutter ${flutter.version ?? ''} · projects found in Downloads, Documents, StudioProjects, dev…`
              : 'Flutter SDK not found on this PC — set FLUTTER_ROOT in backend/.env'
        }
        actions={
          <>
            {analysis && (
              <Button size="xs" variant="ghost" onClick={() => void analysisQ.refetch()} loading={analyzing} title="Read the project again after you changed code">
                <LuRotateCcw /> Re-analyse
              </Button>
            )}
            <IconButton size="xs" variant="ghost" aria-label="Rescan for projects" title="Rescan" onClick={() => void scan(true)} loading={scanning}>
              <LuRefreshCw />
            </IconButton>
          </>
        }
      >
        {projects === null ? (
          <Loading rows={1} height="9" label="Looking for Flutter projects" />
        ) : (
          <SimpleGrid columns={{ base: 1, lg: 2 }} gap="3">
            <Stack gap="1">
              <NativeSelect.Root size="sm" disabled={!projects.length}>
                <NativeSelect.Field value={selected} onChange={(e) => setSelected(e.target.value)} aria-label="Project">
                  {!projects.length && <option value="">No Flutter projects found — add one →</option>}
                  {projects.map((p) => (
                    <option key={p.path} value={p.path}>
                      {p.name} — {p.path}
                    </option>
                  ))}
                </NativeSelect.Field>
                <NativeSelect.Indicator />
              </NativeSelect.Root>
              {current?.remembered && (
                <Button size="2xs" variant="ghost" alignSelf="flex-start" onClick={() => void forget(current.path)}>
                  <LuX /> Remove from list
                </Button>
              )}
            </Stack>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void add();
              }}
            >
              <HStack gap="2">
                <FolderInput value={custom} onChange={setCustom} placeholder="Or choose a project folder…" title="Choose a Flutter project folder" />
                <Button size="sm" type="submit" variant="outline" disabled={custom.trim().length < 3}>
                  <LuPlus /> Add
                </Button>
              </HStack>
            </form>
          </SimpleGrid>
        )}
      </Card>

      {error && <Notice tone="error">{error}</Notice>}
      {analyzing && !analysis ? (
        <Card title="Analysing project…">
          <Spinning label="Reading pubspec, routes and screens…" />
        </Card>
      ) : (
        analysis && <ProjectTabs a={analysis} device={device} flutterOk={flutter === null ? null : flutter.available} />
      )}
      {!analysis && !analyzing && <DoctorPanel />}
      <Guide />
    </Stack>
  );
}

const SUB_KEY = 'pt-flutter-subtab';

/** Run card on top, then the project broken into sub-tabs. */
function ProjectTabs({ a, device, flutterOk }: { a: Analysis; device: AdbDevice | null; flutterOk: boolean | null }) {
  const [tab, setTab] = useState(() => {
    try {
      return localStorage.getItem(SUB_KEY) ?? 'overview';
    } catch {
      return 'overview';
    }
  });
  const [screen, setScreen] = useState<string | null>(null);
  const choose = (t: string) => {
    setTab(t);
    try {
      localStorage.setItem(SUB_KEY, t);
    } catch {
      /* not remembered */
    }
  };
  const label = (id: string) => a.screens.find((x) => x.id === id)?.label ?? id;
  const detail = a.screen_details.find((d) => d.id === screen) ?? null;
  const fails = a.release.filter((r) => r.status === 'fail').length;
  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'screens', label: `Screens (${a.screens.length})` },
    { id: 'state', label: 'State & data' },
    { id: 'assets', label: 'Assets & strings' },
    { id: 'release', label: 'Release checklist', badge: fails ? String(fails) : null },
    { id: 'doctor', label: 'Doctor' },
  ];
  return (
    <Stack gap="4">
      <RunCard project={a} device={device} flutterOk={flutterOk} />
      <Tabs.Root value={tab} onValueChange={(e) => choose(e.value)} variant="enclosed" size="sm" lazyMount>
        <Box overflowX="auto">
          <Tabs.List minW="max-content">
            {tabs.map((t) => (
              <Tabs.Trigger key={t.id} value={t.id}>
                {t.label}
                {t.badge && (
                  <CBadge size="xs" colorPalette="red" variant="solid" borderRadius="full">
                    {t.badge}
                  </CBadge>
                )}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
        </Box>
        <Box pt="4">
          <Tabs.Content value="overview" p="0">
            <Stack gap="4">
              <Brief a={a} />
              <Explain a={a} />
            </Stack>
          </Tabs.Content>
          <Tabs.Content value="screens" p="0">
            <Flow a={a} onScreen={setScreen} />
          </Tabs.Content>
          <Tabs.Content value="state" p="0">
            <StatePanel map={a.state_map} projectName={a.pubspec.name} onScreen={setScreen} />
          </Tabs.Content>
          <Tabs.Content value="assets" p="0">
            <AssetsPanel i={a.insights} projectPath={a.path} />
          </Tabs.Content>
          <Tabs.Content value="release" p="0">
            <ReleasePanel items={a.release} />
          </Tabs.Content>
          <Tabs.Content value="doctor" p="0">
            <DoctorPanel />
          </Tabs.Content>
        </Box>
      </Tabs.Root>
      <ScreenDrawer
        screen={detail}
        label={label}
        outgoing={a.edges.filter((e) => e.from === screen).map((e) => ({ to: e.to, kind: e.kind }))}
        incoming={a.edges.filter((e) => e.to === screen).map((e) => ({ from: e.from, kind: e.kind }))}
        onClose={() => setScreen(null)}
        onOpen={setScreen}
      />
    </Stack>
  );
}
