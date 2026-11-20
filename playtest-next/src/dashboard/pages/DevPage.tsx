'use client';
import { useEffect, useMemo, useState } from 'react';
import NextLink from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { Badge as CBadge, Box, Button, Center, Flex, Grid, HStack, IconButton, Image, Progress, SegmentGroup, Spinner, Stack, Text, chakra } from '@chakra-ui/react';
import { LuChevronsLeft, LuChevronsRight, LuMemoryStick, LuMonitorUp, LuPlay, LuPlus, LuPower, LuRefreshCw, LuSmartphone, LuWifi } from 'react-icons/lu';
import { SiFlutter } from 'react-icons/si';
import { api, dev, startEmulatorProfile, type AdbDevice, type BootProgress, type Device } from '../lib/api';
import { qk, useAdbDevices, useAvds, useBoot, useBooting, useFlutterStatus, useProfiles, useScrcpy } from '../lib/queries';
import { refreshScreen, useScreen } from '../lib/screen';
import { BootProgressView } from '../components/screen';
import { CreateAvdDialog } from './devices/CreateAvd';
import { RamSaverDialog } from './dev/RamSaver';
import { Badge, CopyButton, Loading } from '../components/ui';
import { notify } from '../components/toaster';
import { Workspace } from './dev/Workspace';
import { installApkFile } from './dev/AppsTab';

const CONN = { usb: 'USB', wifi: 'Wi-Fi', emulator: 'Emulator' } as const;
const SERIAL_KEY = 'pt-dev-serial';
const RAIL_KEY = 'pt-dev-rail';
const HEADLESS_KEY = 'pt-dev-headless';
/** Device set seen last time (module scope, so coming back to the page doesn't re-run `flutter devices`). */
let lastSerialKey: string | null = null;
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

/** Sidebar thumbnail: shared frame loop (every 20 s, thumbnails don't count as use), boot % while starting. */
function Thumb({ serial, ok }: { serial: string; ok: boolean }) {
  const { frame, lastGood } = useScreen(serial, { interval: 20_000, thumb: true, enabled: ok });
  const boot = useBooting(serial);
  const shown = frame && !frame.black ? frame : lastGood;
  return (
    <Center w="9" h="16" flexShrink={0} bg="gray.900" borderRadius="md" overflow="hidden" borderWidth="2px" borderColor={boot ? 'green.600' : 'gray.700'} position="relative">
      {boot ? (
        <Text fontSize="2xs" fontWeight="bold" color="white" className="num">
          {Math.round(boot.progress)}%
        </Text>
      ) : ok && shown ? (
        <Image src={shown.url} alt="" w="100%" h="100%" objectFit="cover" />
      ) : ok ? (
        <Spinner size="xs" color="gray.500" />
      ) : (
        <Box color="gray.500">
          <LuSmartphone />
        </Box>
      )}
    </Center>
  );
}

/** An emulator that is still booting (ADB does not list it as ready yet): click to watch it in the workspace. */
function BootingItem({ b, rail, selected, onSelect }: { b: BootProgress; rail: boolean; selected: boolean; onSelect: () => void }) {
  return (
    <chakra.button
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      title={`${b.avd_name} · booting ${Math.round(b.progress)} %`}
      display="flex"
      alignItems="center"
      gap="2.5"
      w="100%"
      p="2"
      borderRadius="md"
      borderWidth="1px"
      textAlign="left"
      borderColor={selected ? 'colorPalette.muted' : 'transparent'}
      bg={selected ? 'colorPalette.subtle' : 'transparent'}
      _hover={{ bg: selected ? 'colorPalette.subtle' : 'bg.muted' }}
      justifyContent={rail ? 'center' : 'flex-start'}
    >
      <Center w="9" h="16" flexShrink={0} bg="gray.900" borderRadius="md" borderWidth="2px" borderColor="green.600">
        <Text fontSize="2xs" fontWeight="bold" color="white" className="num">
          {Math.round(b.progress)}%
        </Text>
      </Center>
      {!rail && (
        <Box flex="1" minW="0">
          <Text fontWeight="medium" fontSize="sm" truncate>
            {b.avd_name}
          </Text>
          <Progress.Root value={b.progress} size="xs" colorPalette="green" striped animated mt="1">
            <Progress.Track>
              <Progress.Range />
            </Progress.Track>
          </Progress.Root>
          <Text fontSize="2xs" color="fg.muted" mt="1" truncate>
            {b.phase}
            {b.eta_s ? ` · ~${b.eta_s}s` : ''}
          </Text>
        </Box>
      )}
    </chakra.button>
  );
}

function DeviceItem({
  d,
  selected,
  rail,
  flutterSees,
  onSelect,
  onDropApk,
  installing,
}: {
  d: AdbDevice;
  selected: boolean;
  rail: boolean;
  flutterSees: boolean;
  onSelect: () => void;
  onDropApk: (f: File) => void;
  installing: boolean;
}) {
  const [drag, setDrag] = useState(false);
  const ok = d.state === 'device';
  const name = d.avd_name ?? d.model ?? d.serial;
  return (
    <chakra.button
      onClick={onSelect}
      onDragOver={(e) => {
        if (!ok) return;
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const f = e.dataTransfer.files[0];
        if (f && ok) onDropApk(f);
      }}
      aria-current={selected ? 'true' : undefined}
      title={rail ? `${name} · ${ok ? CONN[d.connection] : d.state}` : ok ? 'Drop an .apk here to install & open it' : undefined}
      display="flex"
      alignItems="center"
      gap="2.5"
      w="100%"
      p="2"
      borderRadius="md"
      borderWidth="1px"
      textAlign="left"
      position="relative"
      cursor="pointer"
      borderColor={drag ? 'colorPalette.solid' : selected ? 'colorPalette.muted' : 'transparent'}
      borderStyle={drag ? 'dashed' : 'solid'}
      bg={drag || selected ? 'colorPalette.subtle' : 'transparent'}
      _hover={{ bg: selected ? 'colorPalette.subtle' : 'bg.muted' }}
      opacity={ok ? 1 : 0.65}
      justifyContent={rail ? 'center' : 'flex-start'}
    >
      <Thumb serial={d.serial} ok={ok} />
      {!rail && (
        <Box flex="1" minW="0">
          <Text fontWeight="medium" fontSize="sm" truncate>
            {name}
          </Text>
          <Text fontSize="xs" color="fg.muted" fontFamily="mono" truncate>
            {d.serial}
          </Text>
          <HStack gap="1" mt="1" wrap="wrap">
            <Badge tone={ok ? 'good' : 'warning'}>{ok ? CONN[d.connection] : d.state}</Badge>
            {flutterSees && (
              <CBadge size="xs" variant="subtle" colorPalette="cyan" gap="1">
                <SiFlutter /> Flutter
              </CBadge>
            )}
            {d.busy && (
              <CBadge size="xs" variant="subtle" colorPalette="orange">
                testing
              </CBadge>
            )}
          </HStack>
        </Box>
      )}
      {installing && (
        <Center position="absolute" inset="0" bg="bg.panel/80" borderRadius="md" gap="2" fontSize="xs">
          <Spinner size="xs" /> {!rail && 'Installing…'}
        </Center>
      )}
    </chakra.button>
  );
}

/** Developer page: device list on the left, a full workspace (screen, Flutter, logcat, apps…) for the selected device. */
export function DevPage() {
  const qc = useQueryClient();
  const adbQ = useAdbDevices(4000);
  const adbDevices = adbQ.data?.devices ?? null;
  const profiles = useProfiles().data ?? [];
  const avds = useAvds().data ?? [];
  const flutter = useFlutterStatus().data ?? null;
  const scrcpy = useScrcpy().data ?? null;
  const [selected, setSelected] = useState<string | null>(() => ls.get(SERIAL_KEY));
  const [rail, setRail] = useState(() => ls.get(RAIL_KEY) === '1');
  const [headless, setHeadless] = useState(() => ls.get(HEADLESS_KEY) === '1');
  const [installing, setInstalling] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [ramFor, setRamFor] = useState<AdbDevice | null>(null);
  const booting = (useBoot().data ?? []).filter((b) => !b.booted);

  const loadDevices = () => {
    for (const key of [qk.adbDevices, qk.profiles, qk.avds]) void qc.invalidateQueries({ queryKey: key });
  };
  const loadScrcpy = () => qc.invalidateQueries({ queryKey: qk.scrcpy });


  // Re-check `flutter devices` only when the set of connected devices really changes.
  const serialKey = adbDevices ? adbDevices.map((d) => `${d.serial}:${d.state}`).join(',') : null;
  useEffect(() => {
    if (serialKey === null) return;
    if (lastSerialKey !== null && lastSerialKey !== serialKey) void qc.invalidateQueries({ queryKey: qk.flutter });
    lastSerialKey = serialKey;
  }, [serialKey, qc]);

  // Keep a valid selection: the remembered device if connected, else the first ready one.
  const sorted = useMemo(() => [...(adbDevices ?? [])].sort((a, b) => Number(b.state === 'device') - Number(a.state === 'device')), [adbDevices]);
  useEffect(() => {
    if (!adbDevices) return;
    if (selected && (adbDevices.some((d) => d.serial === selected) || booting.some((b) => b.serial === selected))) return;
    const next = sorted.find((d) => d.state === 'device')?.serial ?? sorted[0]?.serial ?? null;
    if (next !== selected) setSelected(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adbDevices, sorted, selected, booting.length]);
  useEffect(() => {
    if (selected) ls.set(SERIAL_KEY, selected);
  }, [selected]);

  const device = sorted.find((d) => d.serial === selected) ?? null;
  const readySerials = new Set(sorted.filter((d) => d.state === 'device').map((d) => d.serial));
  // Booting emulators ADB does not list as ready yet get their own item (with the 1 → 100 % bar).
  const bootOnly = booting.filter((b) => !readySerials.has(b.serial));
  const bootingSelected = !device || device.state !== 'device' ? (booting.find((b) => b.serial === selected) ?? null) : null;
  const flutterIds = new Set(flutter?.devices.map((d) => d.id) ?? []);
  const startable = profiles.filter((p) => p.type === 'emulator' && p.avd_name && avds.includes(p.avd_name) && !p.running);

  const mirror = async (d: AdbDevice) => {
    try {
      await api(dev(d.serial, '/mirror'), { method: 'POST', body: JSON.stringify({ title: d.avd_name ?? d.model ?? d.serial, stay_awake: true }) });
      notify('ok', `Mirror window opened for ${d.avd_name ?? d.model ?? d.serial}`);
    } catch (e: any) {
      notify('error', e.message);
    }
  };
  const installScrcpy = async () => {
    if (!confirm('Install scrcpy (open-source screen mirroring by Genymobile) with winget? This accepts the winget source and package agreements.')) return;
    try {
      await api('/devtools/scrcpy/install', { method: 'POST', body: '{}' });
      await loadScrcpy();
    } catch (e: any) {
      notify('error', e.message);
    }
  };
  const dropInstall = async (d: AdbDevice, f: File) => {
    setInstalling(d.serial);
    try {
      const r = await installApkFile(d.serial, f);
      notify('ok', `${r.message}${r.opened ? ` · ${r.opened}` : ''}`, d.avd_name ?? d.model ?? d.serial);
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setInstalling(null);
    }
  };
  const wireless = async (d: AdbDevice) => {
    setBusy('wifi');
    try {
      const r = await api<{ serial: string; message: string }>(dev(d.serial, '/wireless'), { method: 'POST', body: '{}' });
      notify('ok', r.message);
      loadDevices();
      setSelected(r.serial);
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setBusy(null);
    }
  };
  const startEmulator = async (p: Device) => {
    setBusy(p.id);
    try {
      const r = await startEmulatorProfile(p.id, `window=${headless ? 'false' : 'true'}`);
      if (!r) return;
      notify('ok', headless ? `Booting ${p.name} headless (no window, less RAM/GPU) — progress is shown in the list.` : `Booting ${p.name} with a window — progress is shown in the list.`);
      if (r?.serial) setSelected(r.serial);
      loadDevices();
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setBusy(null);
    }
  };
  const stopEmulator = async (d: AdbDevice) => {
    if (!confirm(`Stop ${d.avd_name ?? d.serial}?`)) return;
    setBusy('stop');
    try {
      await api(`/adb/devices/${encodeURIComponent(d.serial)}/emu-stop`, { method: 'POST', body: '{}' });
      notify('ok', `${d.avd_name ?? d.serial} stopped`);
      loadDevices();
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setBusy(null);
    }
  };
  const toggleHeadless = (v: boolean) => {
    setHeadless(v);
    ls.set(HEADLESS_KEY, v ? '1' : '0');
  };
  const toggleRail = () => {
    setRail((r) => {
      ls.set(RAIL_KEY, r ? '0' : '1');
      return !r;
    });
  };

  const title = device ? (device.avd_name ?? device.model ?? device.serial) : null;

  return (
    <Grid templateColumns={{ base: '1fr', lg: `${rail ? '76px' : '264px'} minmax(0, 1fr)` }} gap="5" alignItems="start">
      {/* ------- device sidebar ------- */}
      <Box
        as="aside"
        aria-label="Devices"
        position={{ lg: 'sticky' }}
        top="20"
        maxH={{ lg: 'calc(100dvh - 100px)' }}
        overflowY={{ lg: 'auto' }}
        borderWidth="1px"
        borderRadius="lg"
        bg="bg.panel"
        p="2"
      >
        <Flex align="center" justify={rail ? 'center' : 'space-between'} px={rail ? '0' : '1'} pb="2" gap="1" direction={rail ? 'column' : 'row'}>
          {!rail && (
            <Text fontSize="2xs" fontWeight="semibold" textTransform="uppercase" letterSpacing="wider" color="fg.subtle">
              Devices {adbDevices ? `(${adbDevices.filter((d) => d.state === 'device').length})` : ''}
            </Text>
          )}
          <HStack gap="0.5" flexDirection={rail ? 'column' : 'row'}>
            <IconButton size="2xs" variant="ghost" aria-label="Refresh devices" title="Refresh" onClick={() => (loadDevices(), (adbDevices ?? []).forEach((d) => refreshScreen(d.serial)))}>
              <LuRefreshCw />
            </IconButton>
            <IconButton size="2xs" variant="ghost" aria-label={rail ? 'Expand device list' : 'Minimise device list'} title={rail ? 'Expand' : 'Minimise'} onClick={toggleRail} display={{ base: 'none', lg: 'inline-flex' }}>
              {rail ? <LuChevronsRight /> : <LuChevronsLeft />}
            </IconButton>
          </HStack>
        </Flex>

        {bootOnly.length > 0 && (
          <Stack gap="1" mb="1">
            {bootOnly.map((b) => (
              <BootingItem key={b.serial} b={b} rail={rail} selected={b.serial === selected} onSelect={() => setSelected(b.serial)} />
            ))}
          </Stack>
        )}
        {adbDevices === null ? (
          <Loading rows={3} height="16" label="Looking for devices" />
        ) : sorted.length === 0 && bootOnly.length === 0 ? (
          !rail && (
            <Text fontSize="xs" color="fg.muted" px="1" pb="2">
              No devices. Plug in a phone with USB debugging on, pair over Wi-Fi on{' '}
              <chakra.a asChild color="colorPalette.fg"><NextLink href="/devices">
                Device Manager
              </NextLink></chakra.a>
              , or start an emulator below.
            </Text>
          )
        ) : (
          <Stack gap="1" direction={{ base: 'row', lg: 'column' }} overflowX={{ base: 'auto', lg: 'visible' }}>
            {sorted.filter((d) => d.state === 'device' || !bootOnly.some((b) => b.serial === d.serial)).map((d) => (
              <Box key={d.serial} minW={{ base: '220px', lg: 'auto' }}>
                <DeviceItem
                  d={d}
                  selected={d.serial === selected}
                  rail={rail}
                  flutterSees={!!flutter?.available && flutterIds.has(d.serial)}
                  onSelect={() => setSelected(d.serial)}
                  onDropApk={(f) => void dropInstall(d, f)}
                  installing={installing === d.serial}
                />
              </Box>
            ))}
          </Stack>
        )}

        {!rail && (
          <Stack gap="1" mt="3" pt="3" borderTopWidth="1px">
            <Stack gap="1.5" px="1">
              <Text fontSize="2xs" fontWeight="semibold" textTransform="uppercase" letterSpacing="wider" color="fg.subtle">
                Start emulator
              </Text>
              <SegmentGroup.Root size="xs" w="full" value={headless ? 'headless' : 'window'} onValueChange={(e) => toggleHeadless(e.value === 'headless')} aria-label="Emulator mode">
                <SegmentGroup.Indicator />
                <SegmentGroup.Items flex="1" justifyContent="center" items={[{ value: 'window', label: 'With window' }, { value: 'headless', label: 'Headless' }]} />
              </SegmentGroup.Root>
              <Text fontSize="2xs" color="fg.muted">
                {headless ? 'No window, less RAM/GPU — see it in Screen or Mirror.' : 'Opens the emulator window (best for flutter run).'}
              </Text>
            </Stack>
            {startable.map((p) => (
              <Button key={p.id} size="xs" variant="ghost" justifyContent="flex-start" loading={busy === p.id} onClick={() => void startEmulator(p)} title={headless ? 'Boots without a window (saves RAM/GPU) — watch it in the live screen or Mirror' : 'Boots with a window, for flutter run / Android Studio'}>
                <LuPlay /> <Text truncate>{p.name}</Text>
              </Button>
            ))}
            {startable.length === 0 && (
              <Text fontSize="2xs" color="fg.muted" px="1">
                {profiles.some((p) => p.type === 'emulator' && p.running) ? 'Every emulator profile is running.' : 'No emulator to start yet.'}
              </Text>
            )}
            <Button size="xs" variant="outline" justifyContent="flex-start" onClick={() => setCreating(true)} title="Create a new AVD from an installed system image">
              <LuPlus /> New emulator
            </Button>
          </Stack>
        )}

        {!rail && (
          <Stack gap="2" mt="3" pt="3" borderTopWidth="1px" px="1" fontSize="xs">
            <HStack gap="2" justify="space-between">
              <HStack gap="1.5" color="fg.muted">
                <SiFlutter />
                <Text>Flutter</Text>
              </HStack>
              {flutter === null ? <Spinner size="xs" /> : flutter.available ? <Text className="num">{flutter.version}</Text> : <Text color="fg.warning">not found</Text>}
            </HStack>
            <HStack gap="2" justify="space-between">
              <HStack gap="1.5" color="fg.muted">
                <LuMonitorUp />
                <Text>Mirror (scrcpy)</Text>
              </HStack>
              {scrcpy === null ? (
                <Spinner size="xs" />
              ) : scrcpy.available ? (
                <Text className="num">{scrcpy.version ?? 'ready'}</Text>
              ) : scrcpy.install.state === 'installing' ? (
                <HStack gap="1">
                  <Spinner size="xs" /> <Text>installing</Text>
                </HStack>
              ) : scrcpy.can_install ? (
                <Button size="2xs" variant="outline" onClick={() => void installScrcpy()}>
                  Install
                </Button>
              ) : (
                <Text color="fg.subtle">not installed</Text>
              )}
            </HStack>
            {scrcpy?.install.state === 'error' && <Text color="fg.error">{scrcpy.install.message}</Text>}
          </Stack>
        )}
      </Box>

      {/* ------- workspace ------- */}
      <Stack gap="4" minW="0">
        {device && (
          <Flex justify="space-between" align="center" gap="3" wrap="wrap" borderWidth="1px" borderRadius="lg" bg="bg.panel" px="4" py="3">
            <Box minW="0">
              <HStack gap="2" wrap="wrap">
                <Text fontFamily="heading" fontWeight="semibold" fontSize="lg" truncate>
                  {title}
                </Text>
                <Badge tone={device.state === 'device' ? 'good' : 'warning'}>{device.state === 'device' ? CONN[device.connection] : device.state}</Badge>
                {device.busy && <Badge tone="warning">test run using it</Badge>}
              </HStack>
              <HStack gap="1" fontSize="xs" color="fg.muted">
                <Text fontFamily="mono">{device.serial}</Text>
                <CopyButton value={device.serial} />
                {device.avd_name && device.model && <Text>· {device.model}</Text>}
              </HStack>
            </Box>
            {device.state === 'device' && (
              <HStack gap="1.5" wrap="wrap">
                {flutter?.available && <CopyButton value={`flutter run -d ${device.serial}`} label="flutter run -d" />}
                {device.connection === 'usb' && (
                  <Button size="xs" variant="outline" onClick={() => void wireless(device)} loading={busy === 'wifi'} title="Enable wireless debugging (adb tcpip) so you can unplug the cable">
                    <LuWifi /> Switch to Wi-Fi
                  </Button>
                )}
                <Button size="xs" variant="outline" onClick={() => setRamFor(device)} title="See what uses this device's RAM and close background apps">
                  <LuMemoryStick /> RAM saver
                </Button>
                {device.connection === 'emulator' && (
                  <Button size="xs" variant="outline" colorPalette="red" onClick={() => void stopEmulator(device)} loading={busy === 'stop'} disabled={device.busy} title={device.busy ? 'A test run is using it' : 'Shut this emulator down (works for headless ones too)'}>
                    <LuPower /> Stop
                  </Button>
                )}
                <Button size="xs" onClick={() => void mirror(device)} disabled={!scrcpy?.available} title={scrcpy?.available ? 'Smooth 60 fps window with mouse & keyboard' : 'Install scrcpy first (left panel)'}>
                  <LuMonitorUp /> Mirror
                </Button>
              </HStack>
            )}
          </Flex>
        )}
        {bootingSelected ? (
          <Stack gap="4">
            <Flex justify="space-between" align="center" gap="3" wrap="wrap" borderWidth="1px" borderRadius="lg" bg="bg.panel" px="4" py="3">
              <Box minW="0">
                <HStack gap="2">
                  <Text fontFamily="heading" fontWeight="semibold" fontSize="lg" truncate>
                    {bootingSelected.avd_name}
                  </Text>
                  <Badge tone="warning">booting</Badge>
                </HStack>
                <Text fontSize="xs" color="fg.muted" fontFamily="mono">
                  {bootingSelected.serial}
                </Text>
              </Box>
            </Flex>
            <Center bg="gray.900" borderRadius="xl" borderWidth="6px" borderColor="gray.800" minH="420px" maxW="420px" w="100%" mx={{ base: 'auto', lg: '0' }}>
              <BootProgressView boot={bootingSelected} />
            </Center>
            <Text fontSize="sm" color="fg.muted">
              The screen, logcat, apps and the other tools open here by themselves once Android is ready.
            </Text>
          </Stack>
        ) : (
          <Workspace device={device} canMirror={!!scrcpy?.available} onMirror={(d) => void mirror(d)} flutter={flutter} />
        )}
      </Stack>
      <CreateAvdDialog open={creating} onClose={() => setCreating(false)} />
      {ramFor && <RamSaverDialog serial={ramFor.serial} title={ramFor.avd_name ?? ramFor.model ?? ramFor.serial} isEmulator={ramFor.connection === 'emulator'} open onClose={() => setRamFor(null)} />}
    </Grid>
  );
}
