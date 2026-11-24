'use client';
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import NextLink from 'next/link';
import { usePathname } from 'next/navigation';
import { Badge as CBadge, Box, ChakraProvider, Drawer, Flex, Grid, HStack, IconButton, Portal, SegmentGroup, Stack, Text, chakra } from '@chakra-ui/react';
import { system } from './theme';
import {
  LuActivity,
  LuBot,
  LuBug,
  LuChevronsLeft,
  LuChevronsRight,
  LuCode,
  LuFileChartColumn,
  LuFlaskConical,
  LuFolderKanban,
  LuGauge,
  LuListChecks,
  LuMenu,
  LuMonitor,
  LuMoon,
  LuNotebook,
  LuPackage,
  LuPlay,
  LuRocket,
  LuSmartphone,
  LuSun,
  LuUsers,
  LuWrench,
} from 'react-icons/lu';
import { useLive } from './lib/useLive';
import { useQuery } from '@tanstack/react-query';
import { useAdbDevices, useLiveCacheSync } from './lib/queries';
import { useProjects } from './lib/projects';
import { api, type BugStats, type CampaignListItem } from './lib/api';
import { ColorModeProvider, useColorMode, type ThemePref } from './colorMode';
import { LiveProvider } from './LiveContext';
import { Toaster } from './components/toaster';
import { QuickNote } from './components/QuickNote';

/**
 * Dashboard frame. Five workspaces (left rail) — each with its own pages (second column):
 *   Projects · Developer · Testing · Deployment · Maintenance
 * Clicking a workspace opens the page you used last in it. Renders in the browser only, like the Vite app it replaces.
 */

type PageDef = { id: string; label: string; icon: ReactNode; hint: string };
type Workspace = { id: string; label: string; icon: ReactNode; palette: string; text: string; pages: PageDef[] };

export const WORKSPACES: Workspace[] = [
  {
    id: 'projects',
    label: 'Projects',
    icon: <LuFolderKanban />,
    palette: 'blue',
    text: 'Everything you build',
    pages: [{ id: 'projects', label: 'All projects', icon: <LuFolderKanban />, hint: 'Parts, git, releases, board' }],
  },
  {
    id: 'developer',
    label: 'Developer',
    icon: <LuCode />,
    palette: 'cyan',
    text: 'Devices, emulators, Flutter tools',
    pages: [
      { id: 'dev', label: 'Workbench', icon: <LuCode />, hint: 'Screen, Flutter, logcat, apps' },
      { id: 'devices', label: 'Device Manager', icon: <LuSmartphone />, hint: 'Emulators, images, RAM, storage' },
      { id: 'apks', label: 'APK Manager', icon: <LuPackage />, hint: 'Uploaded builds' },
    ],
  },
  {
    id: 'testing',
    label: 'Testing',
    icon: <LuFlaskConical />,
    palette: 'orange',
    text: 'Automated runs and results',
    pages: [
      { id: 'campaigns', label: 'Test runs', icon: <LuPlay />, hint: 'Start and follow runs' },
      { id: 'live', label: 'Live testing', icon: <LuActivity />, hint: 'Watch running tests' },
      { id: 'bugs', label: 'Bug reports', icon: <LuBug />, hint: 'Crashes, ANRs, evidence' },
      { id: 'reports', label: 'Reports', icon: <LuFileChartColumn />, hint: 'Per run, HTML / PDF' },
    ],
  },
  {
    id: 'deployment',
    label: 'Deployment',
    icon: <LuRocket />,
    palette: 'purple',
    text: 'Google Play releases',
    pages: [
      { id: 'releases', label: 'Releases', icon: <LuRocket />, hint: 'Build, check, upload' },
      { id: 'play', label: 'Closed testing', icon: <LuUsers />, hint: '12 testers × 14 days' },
    ],
  },
  {
    id: 'maintenance',
    label: 'Maintenance',
    icon: <LuWrench />,
    palette: 'green',
    text: 'Notes, tasks, system',
    pages: [
      { id: 'notes', label: 'Notes', icon: <LuNotebook />, hint: 'Notebook and checklists' },
      { id: 'tasks', label: 'Tasks', icon: <LuListChecks />, hint: 'Open items of all projects' },
      { id: 'system', label: 'System', icon: <LuGauge />, hint: 'PC capacity and metrics' },
      { id: 'ai', label: 'AI (Gemini)', icon: <LuBot />, hint: 'API key and model' },
    ],
  },
];

const ALL_PAGES = WORKSPACES.flatMap((w) => w.pages.map((p) => ({ ...p, ws: w })));

/** Page and workspace from the URL: /projects/abc → projects; /bugs → bugs (Testing). */
function locate(path: string | null) {
  const id = (path ?? '/').split('/')[1] || 'projects';
  return ALL_PAGES.find((p) => p.id === id) ?? ALL_PAGES[0];
}

const ls = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* not remembered */
    }
  },
};
const lastPageKey = (ws: string) => `pt-ws-last:${ws}`;

/** True only in the browser, after hydration (the dashboard reads localStorage, window and live data). */
const useMounted = () =>
  useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

export function Shell({ children }: { children: ReactNode }) {
  const mounted = useMounted();
  // Plain HTML until the browser takes over (no Chakra/Emotion styles on the server → nothing to mismatch).
  if (!mounted)
    return (
      <div role="status" style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', font: '14px system-ui, sans-serif', opacity: 0.7 }}>
        Loading PlayTest AI…
      </div>
    );
  return (
    <ChakraProvider value={system}>
      <ColorModeProvider>
        <ShellInner>{children}</ShellInner>
      </ColorModeProvider>
    </ChakraProvider>
  );
}

function ShellInner({ children }: { children: ReactNode }) {
  const live = useLive();
  const here = locate(usePathname());
  const [panel, setPanel] = useState(() => ls.get('pt-panel-open') !== '0');
  const [drawer, setDrawer] = useState(false);
  useLiveCacheSync(live);

  // Remember the last page of each workspace, so switching workspaces returns there.
  useEffect(() => {
    ls.set(lastPageKey(here.ws.id), here.id);
    setDrawer(false);
  }, [here.id, here.ws.id]);
  useEffect(() => ls.set('pt-panel-open', panel ? '1' : '0'), [panel]);

  const adb = useAdbDevices(8000);
  const devices = adb.data ? adb.data.devices.filter((d) => d.state === 'device').length : 0;
  const runningTests = useQuery({ queryKey: ['campaigns', 'list'], queryFn: () => api<CampaignListItem[]>('/campaigns') }).data?.filter((c) => c.status === 'RUNNING').length ?? 0;
  const openBugs = useQuery({ queryKey: ['bugs', 'list'], queryFn: () => api<{ stats: BugStats }>('/bugs') }).data?.stats.open ?? 0;
  const emulators = live.metrics?.emulators.running ?? 0;

  const pageBadge: Record<string, ReactNode> = {
    dev: devices || null,
    devices: emulators ? `${emulators} on` : null,
    live: runningTests ? `${runningTests} live` : null,
    bugs: openBugs || null,
  };
  const wsBadge: Record<string, ReactNode> = {
    developer: devices || null,
    testing: runningTests ? `${runningTests}▶` : openBugs || null,
  };

  const m = live.metrics;
  const cap = live.capacity;
  const ws = here.ws;

  const rail = <Rail current={ws.id} badges={wsBadge} connected={live.connected} panel={panel} onPanel={() => setPanel((p) => !p)} />;
  const pages = <PagePanel ws={ws} page={here.id} badges={pageBadge} />;

  return (
    <Grid templateColumns={{ base: '1fr', md: `76px ${panel ? '236px' : '0px'} minmax(0, 1fr)` }} minH="100dvh" transition="grid-template-columns 0.15s">
      <Box as="nav" aria-label="Workspaces" display={{ base: 'none', md: 'block' }} position="sticky" top="0" h="100dvh" borderRightWidth="1px" bg="bg.sidebar">
        {rail}
      </Box>
      <Box as="nav" aria-label={`${ws.label} pages`} display={{ base: 'none', md: 'block' }} position="sticky" top="0" h="100dvh" borderRightWidth={panel ? '1px' : '0'} bg="bg.panel" overflow="hidden">
        {panel && pages}
      </Box>

      <Drawer.Root open={drawer} onOpenChange={(e) => setDrawer(e.open)} placement="start" size="sm">
        <Portal>
          <Drawer.Backdrop />
          <Drawer.Positioner>
            <Drawer.Content bg="bg.panel">
              <Flex h="100%">
                <Box w="76px" flexShrink={0} borderRightWidth="1px" bg="bg.sidebar">
                  {rail}
                </Box>
                <Box flex="1" minW="0">
                  {pages}
                </Box>
              </Flex>
              <Drawer.CloseTrigger />
            </Drawer.Content>
          </Drawer.Positioner>
        </Portal>
      </Drawer.Root>

      <Box as="main" minW="0" colorPalette={ws.palette}>
        <Flex
          as="header"
          position="sticky"
          top="0"
          zIndex="sticky"
          bg="bg.canvas/90"
          backdropFilter="blur(8px)"
          borderBottomWidth="1px"
          px={{ base: '4', md: '6' }}
          py="2.5"
          gap="3"
          align="center"
          justify="space-between"
          wrap="wrap"
        >
          <HStack gap="2" minW="0">
            <IconButton display={{ base: 'inline-flex', md: 'none' }} variant="ghost" size="sm" aria-label="Open menu" onClick={() => setDrawer(true)}>
              <LuMenu />
            </IconButton>
            <HStack gap="1.5" color="colorPalette.fg" fontSize="sm" fontWeight="medium" flexShrink={0}>
              {ws.icon}
              <Text display={{ base: 'none', sm: 'block' }}>{ws.label}</Text>
            </HStack>
            <Text color="fg.subtle" display={{ base: 'none', sm: 'block' }}>
              /
            </Text>
            <Text as="h1" fontFamily="heading" fontWeight="semibold" fontSize="lg" truncate>
              {here.label}
            </Text>
          </HStack>
          <HStack gap={{ base: '2', md: '4' }}>
            {m && cap && (
              <HStack gap="4" fontSize="xs" color="fg.muted" display={{ base: 'none', lg: 'flex' }} aria-label="System summary">
                <TopStat label="CPU" value={`${m.cpu.load_pct.toFixed(0)}%`} />
                <TopStat label="RAM" value={`${m.memory.used_gb.toFixed(1)}/${m.memory.total_gb.toFixed(0)} GB`} />
                <TopStat label="Emulators" value={`${m.emulators.running}/${cap.configured_max}`} />
              </HStack>
            )}
            <QuickNote />
          </HStack>
        </Flex>
        <Box px={{ base: '4', md: '6' }} py="5" maxW="1600px">
          <LiveProvider live={live}>{children}</LiveProvider>
        </Box>
      </Box>
      <Toaster />
    </Grid>
  );
}

function TopStat({ label, value }: { label: string; value: string }) {
  return (
    <Text>
      {label}{' '}
      <chakra.b color="fg" className="num" fontWeight="semibold">
        {value}
      </chakra.b>
    </Text>
  );
}

/** Left rail: logo, the five workspaces, connection state, theme and the page-panel toggle. */
function Rail({ current, badges, connected, panel, onPanel }: { current: string; badges: Record<string, ReactNode>; connected: boolean; panel: boolean; onPanel: () => void }) {
  const { pref, setPref } = useColorMode();
  return (
    <Flex direction="column" h="100%" align="center" py="3" gap="1">
      <chakra.a asChild mb="3" title="PlayTest AI">
        <NextLink href="/projects">
          <Flex w="10" h="10" align="center" justify="center" borderRadius="xl" bg="blue.solid" color="white" fontSize="lg" shadow="sm">
            <LuPlay />
          </Flex>
        </NextLink>
      </chakra.a>
      {WORKSPACES.map((w) => {
        const active = w.id === current;
        const target = `/${ls.get(lastPageKey(w.id)) && w.pages.some((p) => p.id === ls.get(lastPageKey(w.id))) ? ls.get(lastPageKey(w.id)) : w.pages[0].id}`;
        return (
          <chakra.a
            asChild
            key={w.id}
            colorPalette={w.palette}
            aria-current={active ? 'page' : undefined}
            title={`${w.label} — ${w.text}`}
            position="relative"
            display="flex"
            flexDirection="column"
            alignItems="center"
            gap="0.5"
            w="64px"
            py="2"
            borderRadius="lg"
            color={active ? 'colorPalette.fg' : 'fg.muted'}
            bg={active ? 'colorPalette.subtle' : 'transparent'}
            _hover={{ bg: active ? 'colorPalette.subtle' : 'bg.muted', color: active ? 'colorPalette.fg' : 'fg' }}
            _focusVisible={{ outline: '2px solid', outlineColor: 'colorPalette.focusRing' }}
          >
            <NextLink href={target}>
              {active && <Box position="absolute" left="-6px" top="2" bottom="2" w="3px" borderRadius="full" bg="colorPalette.solid" />}
              <Box fontSize="xl">{w.icon}</Box>
              <Text fontSize="2xs" fontWeight={active ? 'semibold' : 'medium'} lineHeight="1.2">
                {w.label}
              </Text>
              {badges[w.id] !== null && badges[w.id] !== undefined && (
                <CBadge size="xs" variant="solid" colorPalette={w.palette} position="absolute" top="1" right="1" borderRadius="full" px="1.5">
                  {badges[w.id]}
                </CBadge>
              )}
            </NextLink>
          </chakra.a>
        );
      })}
      <Box flex="1" />
      <Box w="2.5" h="2.5" borderRadius="full" bg={connected ? 'green.solid' : 'red.solid'} title={connected ? 'Live — connected to PlayTest' : 'Backend offline'} mb="2" />
      <IconButton
        size="sm"
        variant="ghost"
        aria-label="Switch theme"
        title={`Theme: ${pref} (click to change)`}
        onClick={() => setPref((pref === 'system' ? 'light' : pref === 'light' ? 'dark' : 'system') as ThemePref)}
      >
        {pref === 'light' ? <LuSun /> : pref === 'dark' ? <LuMoon /> : <LuMonitor />}
      </IconButton>
      <IconButton size="sm" variant="ghost" aria-label={panel ? 'Hide pages panel' : 'Show pages panel'} title={panel ? 'Hide pages' : 'Show pages'} onClick={onPanel} display={{ base: 'none', md: 'inline-flex' }}>
        {panel ? <LuChevronsLeft /> : <LuChevronsRight />}
      </IconButton>
    </Flex>
  );
}

/** Second column: the pages of the current workspace (plus recent projects in Projects). */
function PagePanel({ ws, page, badges }: { ws: Workspace; page: string; badges: Record<string, ReactNode> }) {
  const projects = useProjects();
  const pathname = usePathname();
  const { pref, setPref } = useColorMode();
  return (
    <Flex direction="column" h="100%" w="236px" colorPalette={ws.palette} overflowY="auto">
      <Box px="4" pt="5" pb="3">
        <HStack gap="2" color="colorPalette.fg">
          <Box fontSize="lg">{ws.icon}</Box>
          <Text fontFamily="heading" fontWeight="bold" fontSize="lg">
            {ws.label}
          </Text>
        </HStack>
        <Text fontSize="xs" color="fg.muted" mt="0.5">
          {ws.text}
        </Text>
      </Box>
      <Stack gap="0.5" px="2">
        {ws.pages.map((p) => {
          const active = p.id === page;
          return (
            <chakra.a
              asChild
              key={p.id}
              aria-current={active ? 'page' : undefined}
              display="flex"
              alignItems="center"
              gap="2.5"
              px="2.5"
              py="2"
              borderRadius="md"
              bg={active ? 'colorPalette.subtle' : 'transparent'}
              color={active ? 'colorPalette.fg' : 'fg'}
              _hover={{ bg: active ? 'colorPalette.subtle' : 'bg.muted' }}
              _focusVisible={{ outline: '2px solid', outlineColor: 'colorPalette.focusRing' }}
            >
              <NextLink href={`/${p.id}`}>
                <Box fontSize="md" color={active ? 'colorPalette.fg' : 'fg.muted'} flexShrink={0}>
                  {p.icon}
                </Box>
                <Box flex="1" minW="0">
                  <Text fontSize="sm" fontWeight={active ? 'semibold' : 'medium'} truncate>
                    {p.label}
                  </Text>
                  <Text fontSize="2xs" color="fg.muted" truncate>
                    {p.hint}
                  </Text>
                </Box>
                {badges[p.id] !== null && badges[p.id] !== undefined && (
                  <CBadge size="xs" variant="solid" borderRadius="full">
                    {badges[p.id]}
                  </CBadge>
                )}
              </NextLink>
            </chakra.a>
          );
        })}
      </Stack>

      {ws.id === 'projects' && (projects.data?.length ?? 0) > 0 && (
        <Stack gap="0.5" px="2" mt="5">
          <Text px="2.5" pb="1" fontSize="2xs" fontWeight="semibold" textTransform="uppercase" letterSpacing="wider" color="fg.subtle">
            Recent
          </Text>
          {projects.data!.slice(0, 8).map((p) => {
            const active = pathname === `/projects/${p.id}`;
            return (
              <chakra.a
                asChild
                key={p.id}
                display="flex"
                alignItems="center"
                gap="2.5"
                px="2.5"
                py="1.5"
                borderRadius="md"
                bg={active ? 'colorPalette.subtle' : 'transparent'}
                _hover={{ bg: active ? 'colorPalette.subtle' : 'bg.muted' }}
              >
                <NextLink href={`/projects/${p.id}`}>
                  <Flex w="6" h="6" flexShrink={0} align="center" justify="center" borderRadius="md" bg={`${p.color ?? 'blue'}.solid`} color="white" fontSize="xs" fontWeight="bold">
                    {p.name.slice(0, 1).toUpperCase()}
                  </Flex>
                  <Text fontSize="sm" truncate flex="1" fontWeight={active ? 'semibold' : 'normal'}>
                    {p.name}
                  </Text>
                  {p.open_notes > 0 && (
                    <Text fontSize="2xs" color="fg.muted">
                      {p.open_notes}
                    </Text>
                  )}
                </NextLink>
              </chakra.a>
            );
          })}
        </Stack>
      )}

      <Box flex="1" />
      <Box px="3" pb="4" pt="3">
        <SegmentGroup.Root size="xs" w="full" value={pref} onValueChange={(e) => setPref(e.value as ThemePref)} aria-label="Theme">
          <SegmentGroup.Indicator />
          <SegmentGroup.Items
            flex="1"
            justifyContent="center"
            items={[
              { value: 'system', label: <HStack gap="1"><LuMonitor /> Auto</HStack> },
              { value: 'light', label: <HStack gap="1"><LuSun /> Light</HStack> },
              { value: 'dark', label: <HStack gap="1"><LuMoon /> Dark</HStack> },
            ]}
          />
        </SegmentGroup.Root>
      </Box>
    </Flex>
  );
}
