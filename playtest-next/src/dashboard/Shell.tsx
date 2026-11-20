'use client';
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import NextLink from 'next/link';
import { usePathname } from 'next/navigation';
import { Badge as CBadge, Box, ChakraProvider, Drawer, Flex, Grid, Heading, HStack, IconButton, Portal, SegmentGroup, Stack, Text, VStack, chakra } from '@chakra-ui/react';
import { system } from './theme';
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
  LuUsers,
} from 'react-icons/lu';
import { useLive } from './lib/useLive';
import { useQuery } from '@tanstack/react-query';
import { useAdbDevices, useLiveCacheSync } from './lib/queries';
import { api, type BugStats, type CampaignListItem } from './lib/api';
import { ColorModeProvider, useColorMode, type ThemePref } from './colorMode';
import { LiveProvider } from './LiveContext';
import { Badge } from './components/ui';
import { Toaster } from './components/toaster';

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
      { id: 'play', label: 'Closed testing', icon: <LuUsers />, ready: true },
    ],
  },
  { label: 'Settings', items: [{ id: 'ai', label: 'AI (Gemini)', icon: <LuBot />, ready: true }] },
];
const NAV = GROUPS.flatMap((g) => g.items);
type PageId = string;

/** Page id from the URL: /reports/abc → reports. */
const pageFromPath = (path: string | null): PageId => {
  const id = (path ?? '/').split('/')[1] || 'system';
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

/** True only in the browser, after hydration (the dashboard reads localStorage, window and live data). */
const useMounted = () =>
  useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

/**
 * Dashboard frame for every page: sidebar, header with live system stats, mobile drawer, toasts, and the one
 * live connection pages read through LiveContext. Renders in the browser only — like the Vite app it replaces.
 */
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
  const page = pageFromPath(usePathname());
  const [collapsed, setCollapsed] = usePersisted('pt-nav-collapsed', false);
  const [drawer, setDrawer] = useState(false);
  useLiveCacheSync(live);
  const adb = useAdbDevices(8000);
  const devices = adb.data ? adb.data.devices.filter((d) => d.state === 'device').length : null;
  const runningTests = useQuery({ queryKey: ['campaigns', 'list'], queryFn: () => api<CampaignListItem[]>('/campaigns') }).data?.filter((c) => c.status === 'RUNNING').length ?? 0;
  const openBugs = useQuery({ queryKey: ['bugs', 'list'], queryFn: () => api<{ stats: BugStats }>('/bugs') }).data?.stats.open ?? 0;

  // Close the mobile menu after navigating.
  useEffect(() => setDrawer(false), [page]);

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
        <Sidebar page={page} collapsed={collapsed} onCollapse={() => setCollapsed(!collapsed)} badges={badges} connected={live.connected} />
      </Box>

      <Drawer.Root open={drawer} onOpenChange={(e) => setDrawer(e.open)} placement="start" size="xs">
        <Portal>
          <Drawer.Backdrop />
          <Drawer.Positioner>
            <Drawer.Content bg="bg.sidebar">
              <Sidebar page={page} collapsed={false} badges={badges} connected={live.connected} />
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

function Sidebar({
  page,
  collapsed,
  onCollapse,
  badges,
  connected,
}: {
  page: string;
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
                <chakra.a
                  asChild
                  key={n.id}
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
                  <NextLink href={`/${n.id}`}>
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
                  </NextLink>
                </chakra.a>
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
