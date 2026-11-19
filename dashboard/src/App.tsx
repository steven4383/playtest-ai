import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { Badge as CBadge, Box, Drawer, Flex, Grid, Heading, HStack, IconButton, Portal, SegmentGroup, Stack, Text, VStack, chakra } from '@chakra-ui/react';
import {
  LuActivity,
  LuBot,
  LuBug,
  LuChevronsLeft,
  LuChevronsRight,
  LuCode,
  LuFileChartColumn,
  LuGauge,
  LuMenu,
  LuMonitor,
  LuMoon,
  LuPackage,
  LuPlay,
  LuSmartphone,
  LuSun,
} from 'react-icons/lu';
import { useLive } from './lib/useLive';
import { useQuery } from '@tanstack/react-query';
import { useAdbDevices, useLiveCacheSync } from './lib/queries';
import { api, type BugStats, type CampaignListItem } from './lib/api';
import { useColorMode, type ThemePref } from './colorMode';
import { Badge, Spinning } from './components/ui';
import { Toaster } from './components/toaster';

const pages = {
  system: () => import('./pages/SystemPage'),
  devices: () => import('./pages/DevicesPage'),
  apks: () => import('./pages/ApksPage'),
  ai: () => import('./pages/AiPage'),
  campaigns: () => import('./pages/CampaignsPage'),
  dev: () => import('./pages/DevPage'),
  live: () => import('./pages/LiveTestingPage'),
  bugs: () => import('./pages/BugsPage'),
  reports: () => import('./pages/ReportsPage'),
};
const SystemPage = lazy(() => pages.system().then((m) => ({ default: m.SystemPage })));
const DevicesPage = lazy(() => pages.devices().then((m) => ({ default: m.DevicesPage })));
const ApksPage = lazy(() => pages.apks().then((m) => ({ default: m.ApksPage })));
const AiPage = lazy(() => pages.ai().then((m) => ({ default: m.AiPage })));
const CampaignsPage = lazy(() => pages.campaigns().then((m) => ({ default: m.CampaignsPage })));
const DevPage = lazy(() => pages.dev().then((m) => ({ default: m.DevPage })));
const LiveTestingPage = lazy(() => pages.live().then((m) => ({ default: m.LiveTestingPage })));
const BugsPage = lazy(() => pages.bugs().then((m) => ({ default: m.BugsPage })));
const ReportsPage = lazy(() => pages.reports().then((m) => ({ default: m.ReportsPage })));
/** After the first page is up, fetch the other pages' code in the background so switching never shows "Loading page…". */
function usePreloadPages() {
  useEffect(() => {
    const t = setTimeout(() => Object.values(pages).forEach((load) => void load().catch(() => {})), 1500);
    return () => clearTimeout(t);
  }, []);
}

type NavItem = { id: string; label: string; icon: ReactNode; ready: boolean; phase?: number };
const GROUPS: { label: string; items: NavItem[] }[] = [
  { label: 'Overview', items: [{ id: 'system', label: 'System & capacity', icon: <LuGauge />, ready: true }] },
  {
    label: 'Develop',
    items: [
      { id: 'dev', label: 'Developer', icon: <LuCode />, ready: true },
      { id: 'devices', label: 'Device Manager', icon: <LuSmartphone />, ready: true },
      { id: 'apks', label: 'APK Manager', icon: <LuPackage />, ready: true },
    ],
  },
  {
    label: 'Test',
    items: [
      { id: 'campaigns', label: 'Test runs', icon: <LuPlay />, ready: true },
      { id: 'live', label: 'Live Testing', icon: <LuActivity />, ready: true },
      { id: 'bugs', label: 'Bug Reports', icon: <LuBug />, ready: true },
      { id: 'reports', label: 'Reports', icon: <LuFileChartColumn />, ready: true },
    ],
  },
  { label: 'Settings', items: [{ id: 'ai', label: 'AI (Gemini)', icon: <LuBot />, ready: true }] },
];
const NAV = GROUPS.flatMap((g) => g.items);
type PageId = string;

const pageFromHash = (): PageId => {
  const id = location.hash.slice(1).split(/[/?]/)[0];
  return NAV.some((n) => n.id === id && n.ready) ? id : 'system';
};

function usePersisted<T>(key: string, initial: T) {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key);
      return s === null ? initial : (JSON.parse(s) as T);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* not remembered */
    }
  }, [key, v]);
  return [v, setV] as const;
}

export function App() {
  const live = useLive();
  const [page, setPage] = useState<PageId>(pageFromHash);
  const [collapsed, setCollapsed] = usePersisted('pt-nav-collapsed', false);
  const [drawer, setDrawer] = useState(false);
  useLiveCacheSync(live);
  usePreloadPages();
  const adb = useAdbDevices(8000);
  const devices = adb.data ? adb.data.devices.filter((d) => d.state === 'device').length : null;
  const runningTests = useQuery({ queryKey: ['campaigns', 'list'], queryFn: () => api<CampaignListItem[]>('/campaigns') }).data?.filter((c) => c.status === 'RUNNING').length ?? 0;
  const openBugs = useQuery({ queryKey: ['bugs', 'list'], queryFn: () => api<{ stats: BugStats }>('/bugs') }).data?.stats.open ?? 0;

  useEffect(() => {
    if (location.hash.slice(1).split(/[/?]/)[0] !== page) location.hash = page;
  }, [page]);
  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = (id: string) => {
    setPage(id);
    if (location.hash.slice(1) !== id) location.hash = id;
    setDrawer(false);
  };
  const badges: Record<string, ReactNode> = {
    dev: devices ? devices : null,
    devices: live.metrics?.emulators.running ? `${live.metrics.emulators.running} on` : null,
    live: runningTests ? `${runningTests} live` : null,
    bugs: openBugs || null,
  };
  const m = live.metrics;
  const cap = live.capacity;
  const current = NAV.find((n) => n.id === page);

  return (
    <Grid templateColumns={{ base: '1fr', md: `${collapsed ? '68px' : '248px'} 1fr` }} minH="100dvh" transition="grid-template-columns 0.15s">
      <Box as="nav" aria-label="Main" display={{ base: 'none', md: 'block' }} position="sticky" top="0" h="100dvh" borderRightWidth="1px" bg="bg.sidebar">
        <Sidebar page={page} go={go} collapsed={collapsed} onCollapse={() => setCollapsed(!collapsed)} badges={badges} connected={live.connected} />
      </Box>

      <Drawer.Root open={drawer} onOpenChange={(e) => setDrawer(e.open)} placement="start" size="xs">
        <Portal>
          <Drawer.Backdrop />
          <Drawer.Positioner>
            <Drawer.Content bg="bg.sidebar">
              <Sidebar page={page} go={go} collapsed={false} badges={badges} connected={live.connected} />
              <Drawer.CloseTrigger />
            </Drawer.Content>
          </Drawer.Positioner>
        </Portal>
      </Drawer.Root>

      <Box as="main" minW="0">
        <Flex
          as="header"
          position="sticky"
          top="0"
          zIndex="sticky"
          bg="bg.canvas/90"
          backdropFilter="blur(8px)"
          borderBottomWidth="1px"
          px={{ base: '4', md: '6' }}
          py="3"
          gap="3"
          align="center"
          justify="space-between"
          wrap="wrap"
        >
          <HStack gap="2" minW="0">
            <IconButton display={{ base: 'inline-flex', md: 'none' }} variant="ghost" size="sm" aria-label="Open menu" onClick={() => setDrawer(true)}>
              <LuMenu />
            </IconButton>
            <Heading as="h1" size="lg" fontFamily="heading" truncate>
              {current?.label}
            </Heading>
          </HStack>
          {m && cap && (
            <HStack gap={{ base: '3', md: '5' }} fontSize="xs" color="fg.muted" aria-label="System summary" wrap="wrap">
              <TopStat label="CPU" value={`${m.cpu.load_pct.toFixed(0)}%`} />
              <TopStat label="RAM" value={`${m.memory.used_gb.toFixed(1)}/${m.memory.total_gb.toFixed(1)} GB`} />
              {m.gpu[0] && <TopStat label="GPU" value={m.gpu[0].utilization_pct === null ? '—' : `${m.gpu[0].utilization_pct.toFixed(0)}%`} />}
              <TopStat label="Emulators" value={`${m.emulators.running}/${cap.configured_max}`} />
            </HStack>
          )}
        </Flex>
        <Box px={{ base: '4', md: '6' }} py="5" maxW="1600px">
          <Suspense fallback={<Spinning label="Loading page…" />}>
            {page === 'system' && <SystemPage live={live} />}
            {page === 'dev' && <DevPage live={live} />}
            {page === 'devices' && <DevicesPage live={live} />}
            {page === 'apks' && <ApksPage />}
            {page === 'campaigns' && <CampaignsPage live={live} />}
            {page === 'ai' && <AiPage />}
            {page === 'live' && <LiveTestingPage live={live} />}
            {page === 'bugs' && <BugsPage />}
            {page === 'reports' && <ReportsPage />}
          </Suspense>
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

function Sidebar({
  page,
  go,
  collapsed,
  onCollapse,
  badges,
  connected,
}: {
  page: string;
  go: (id: string) => void;
  collapsed: boolean;
  onCollapse?: () => void;
  badges: Record<string, ReactNode>;
  connected: boolean;
}) {
  const { pref, setPref } = useColorMode();
  return (
    <Flex direction="column" h="100%" py="4" px={collapsed ? '2' : '3'} gap="4" overflowY="auto">
      <HStack gap="2.5" px={collapsed ? '0' : '2'} justify={collapsed ? 'center' : 'flex-start'}>
        <Flex w="9" h="9" flexShrink={0} align="center" justify="center" borderRadius="lg" bg="colorPalette.solid" color="colorPalette.contrast" fontSize="md" aria-hidden>
          <LuPlay />
        </Flex>
        {!collapsed && (
          <Box minW="0">
            <Text fontFamily="heading" fontWeight="semibold" fontSize="md" lineHeight="1.2">
              PlayTest AI
            </Text>
            <Text fontSize="xs" color="fg.muted">
              Android dev & QA
            </Text>
          </Box>
        )}
      </HStack>

      <Stack gap="4" flex="1">
        {GROUPS.map((g) => (
          <Stack key={g.label} gap="0.5">
            {!collapsed ? (
              <Text px="2" pb="1" fontSize="2xs" fontWeight="semibold" textTransform="uppercase" letterSpacing="wider" color="fg.subtle">
                {g.label}
              </Text>
            ) : (
              <Box h="1px" bg="border" mx="2" mb="1" />
            )}
            {g.items.map((n) => {
              const active = page === n.id;
              return (
                <chakra.button
                  key={n.id}
                  onClick={() => n.ready && go(n.id)}
                  disabled={!n.ready}
                  aria-current={active ? 'page' : undefined}
                  title={collapsed ? `${n.label}${n.ready ? '' : ` (phase ${n.phase})`}` : n.ready ? undefined : `Coming in phase ${n.phase}`}
                  display="flex"
                  alignItems="center"
                  gap="2.5"
                  w="100%"
                  px="2.5"
                  py="2"
                  borderRadius="md"
                  fontSize="sm"
                  textAlign="left"
                  justifyContent={collapsed ? 'center' : 'flex-start'}
                  position="relative"
                  color={active ? 'colorPalette.fg' : n.ready ? 'fg.muted' : 'fg.subtle'}
                  bg={active ? 'colorPalette.subtle' : 'transparent'}
                  fontWeight={active ? 'semibold' : 'normal'}
                  cursor={n.ready ? 'pointer' : 'not-allowed'}
                  _hover={n.ready && !active ? { bg: 'bg.muted', color: 'fg' } : undefined}
                  _focusVisible={{ outline: '2px solid', outlineColor: 'colorPalette.focusRing' }}
                >
                  <Box fontSize="md" flexShrink={0}>
                    {n.icon}
                  </Box>
                  {!collapsed && (
                    <Text flex="1" truncate>
                      {n.label}
                    </Text>
                  )}
                  {!collapsed && !n.ready && (
                    <CBadge size="xs" variant="outline">
                      P{n.phase}
                    </CBadge>
                  )}
                  {badges[n.id] !== null && badges[n.id] !== undefined && (
                    <CBadge
                      size="xs"
                      variant="solid"
                      colorPalette={n.id === 'dev' ? 'green' : 'blue'}
                      position={collapsed ? 'absolute' : 'static'}
                      top="0.5"
                      right="0.5"
                      borderRadius="full"
                    >
                      {badges[n.id]}
                    </CBadge>
                  )}
                </chakra.button>
              );
            })}
          </Stack>
        ))}
      </Stack>

      <VStack gap="3" align="stretch">
        <Box textAlign={collapsed ? 'center' : 'left'} px={collapsed ? '0' : '2'}>
          {connected ? <Badge tone="good">{collapsed ? '' : 'Live'}</Badge> : <Badge tone="critical">{collapsed ? '' : 'Backend offline'}</Badge>}
        </Box>
        {collapsed ? (
          <IconButton
            size="sm"
            variant="ghost"
            aria-label="Switch theme"
            title={`Theme: ${pref}`}
            onClick={() => setPref(pref === 'system' ? 'light' : pref === 'light' ? 'dark' : 'system')}
          >
            {pref === 'light' ? <LuSun /> : pref === 'dark' ? <LuMoon /> : <LuMonitor />}
          </IconButton>
        ) : (
          <SegmentGroup.Root size="xs" value={pref} onValueChange={(e) => setPref(e.value as ThemePref)} aria-label="Theme">
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
        )}
        {onCollapse && (
          <IconButton size="sm" variant="ghost" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={collapsed ? 'Expand' : 'Collapse'} onClick={onCollapse} alignSelf={collapsed ? 'center' : 'flex-end'}>
            {collapsed ? <LuChevronsRight /> : <LuChevronsLeft />}
          </IconButton>
        )}
      </VStack>
    </Flex>
  );
}
