import { useEffect, useRef, useState } from 'react';
import NextLink from 'next/link';
import { useScreen } from '../../lib/screen';
import { BootProgressView, DarkScreenHint, DimmedFrame, ScreenLoading } from '../../components/screen';
import { useQueryClient } from '@tanstack/react-query';
import { qk, useAdbDevices, useBoot, useBooting, useScrcpy } from '../../lib/queries';
import { Badge as CBadge, Box, Button, Center, CloseButton, Dialog, Flex, HStack, IconButton, Image, Portal, SimpleGrid, Stack, Text } from '@chakra-ui/react';
import { LuCable, LuEye, LuMonitorUp, LuPower, LuQrCode, LuRefreshCw, LuRotateCcw, LuSmartphone } from 'react-icons/lu';
import { api, dev, type AdbDevice, type BootProgress } from '../../lib/api';
import type { Live } from '../../lib/useLive';
import { Card, Loading } from '../../components/ui';
import { notify } from '../../components/toaster';
import { LiveScreen } from '../dev/LiveScreen';

const CONN = { usb: 'USB', wifi: 'Wi-Fi', emulator: 'Emulator' } as const;

/**
 * Auto-refreshing screenshot of one device. Fast (~1.5 s) while a test is running on it, slow otherwise.
 * Shares one frame loop per device with every other view, shows the last frame instantly, the boot progress while
 * an emulator starts, and a "screen is dark" hint instead of a plain black tile.
 */
export function LiveThumb({ serial, fast, height = '220px', onClick, label }: { serial: string; fast: boolean; height?: string; onClick?: () => void; label: string }) {
  const { frame, lastGood, error } = useScreen(serial, { interval: fast ? 1500 : 8000, thumb: !fast });
  const boot = useBooting(serial);
  const dark = !!frame?.black && !boot;
  return (
    <Center
      as={onClick ? 'button' : 'div'}
      onClick={onClick}
      h={height}
      w="100%"
      bg="gray.900"
      borderRadius="lg"
      borderWidth="4px"
      borderColor={fast ? 'orange.solid' : 'gray.800'}
      overflow="hidden"
      cursor={onClick ? 'pointer' : 'default'}
      position="relative"
      aria-label={`Screen of ${label}`}
      title={onClick ? 'Open live view (tap / swipe / type)' : undefined}
    >
      {boot ? (
        <>
          {lastGood && <DimmedFrame url={lastGood.url} />}
          <BootProgressView boot={boot} compact />
        </>
      ) : frame && !dark ? (
        <Image src={frame.url} alt={`Screen of ${label}`} h="100%" w="auto" maxW="100%" objectFit="contain" draggable={false} />
      ) : dark ? (
        <>
          {lastGood && <DimmedFrame url={lastGood.url} />}
          <DarkScreenHint compact />
        </>
      ) : error ? (
        <Stack align="center" color="gray.500" gap="1" fontSize="xs" px="2" textAlign="center">
          <LuSmartphone />
          <Text>No screen (locked or busy)</Text>
        </Stack>
      ) : (
        <ScreenLoading compact />
      )}
      {fast && (
        <CBadge position="absolute" top="1.5" left="1.5" size="xs" colorPalette="orange" variant="solid">
          ● LIVE
        </CBadge>
      )}
    </Center>
  );
}

/** Tile for an emulator that is still booting and not usable over ADB yet. */
export function BootTile({ boot, height = '220px' }: { boot: BootProgress; height?: string }) {
  return (
    <Center h={height} w="100%" bg="gray.900" borderRadius="lg" borderWidth="4px" borderColor="green.700" overflow="hidden">
      <BootProgressView boot={boot} compact />
    </Center>
  );
}

/** Dialog with the full controllable live screen (same as the Developer page). */
export function LiveViewDialog({ device, canMirror, onMirror, onClose }: { device: AdbDevice | null; canMirror: boolean; onMirror: (d: AdbDevice) => void; onClose: () => void }) {
  const title = device ? (device.avd_name ?? device.model ?? device.serial) : '';
  return (
    <Dialog.Root open={!!device} onOpenChange={(e) => !e.open && onClose()} size="sm" placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content maxH="96dvh" overflowY="auto">
            <Dialog.Header>
              <Dialog.Title fontFamily="heading">{title}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body pb="5">{device && <LiveScreen serial={device.serial} title={title} canMirror={canMirror} onMirror={() => onMirror(device)} />}</Dialog.Body>
            <Dialog.CloseTrigger asChild>
              <CloseButton size="sm" />
            </Dialog.CloseTrigger>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

export async function openMirror(d: AdbDevice) {
  try {
    await api(dev(d.serial, '/mirror'), { method: 'POST', body: JSON.stringify({ title: d.avd_name ?? d.model ?? d.serial, stay_awake: true }) });
    notify('ok', `Mirror window opened for ${d.avd_name ?? d.model ?? d.serial}`);
  } catch (e: any) {
    notify('error', e.message);
  }
}

/** Connected devices with live screens on the Test runs page: watch tests run, open a mirror, connect more. */
export function LiveDevices({ live, onDevices }: { live: Live; onDevices?: (d: AdbDevice[]) => void }) {
  const qc = useQueryClient();
  const adbQ = useAdbDevices(3000);
  const devices = adbQ.data?.devices ?? (adbQ.isError ? [] : null);
  const canMirror = !!useScrcpy().data?.available;
  const [viewing, setViewing] = useState<AdbDevice | null>(null);
  const [restarting, setRestarting] = useState(false);
  const cb = useRef(onDevices);
  cb.current = onDevices;
  useEffect(() => {
    if (adbQ.data) cb.current?.(adbQ.data.devices);
  }, [adbQ.data]);
  // Live events (device / execution updates) refresh the shared device list in useLiveCacheSync.
  const load = () => qc.invalidateQueries({ queryKey: qk.adbDevices });

  const [stopping, setStopping] = useState<string | null>(null);
  const stopEmu = async (d: AdbDevice) => {
    if (!confirm(`Stop ${d.avd_name ?? d.serial}?`)) return;
    setStopping(d.serial);
    try {
      await api(`/adb/devices/${encodeURIComponent(d.serial)}/emu-stop`, { method: 'POST', body: '{}' });
      notify('ok', `${d.avd_name ?? d.serial} stopped`);
      await load();
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setStopping(null);
    }
  };
  const restart = async () => {
    setRestarting(true);
    try {
      await api('/adb/restart', { method: 'POST', body: '{}' });
      notify('ok', 'ADB restarted');
      await load();
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setRestarting(false);
    }
  };

  const booting = (useBoot().data ?? []).filter((b) => !b.booted);
  const bootingSerials = new Set(booting.map((b) => b.serial));
  const ready = (devices ?? []).filter((d) => d.state === 'device');
  const other = (devices ?? []).filter((d) => d.state !== 'device' && !bootingSerials.has(d.serial));
  // Emulators still booting: ADB lists them as offline (or not at all) until Android is up.
  const bootOnly = booting.filter((b) => !ready.some((d) => d.serial === b.serial));
  const testing = ready.filter((d) => d.busy).length;

  return (
    <Card
      icon={<LuSmartphone />}
      title="Live devices"
      subtitle={
        devices === null
          ? 'Looking for devices…'
          : `${ready.length} connected${testing ? ` · ${testing} running a test now (orange, refreshes every 1.5 s)` : ''} · click a screen to control it`
      }
      actions={
        <>
          <Button asChild size="xs" variant="outline">
            <NextLink href="/devices" title="Device Manager → Connect over Wi-Fi (QR code or pairing code)">
              <LuQrCode /> Connect over Wi-Fi
            </NextLink>
          </Button>
          <Button size="xs" variant="ghost" onClick={() => void restart()} loading={restarting} title="Fixes most offline / missing devices">
            <LuRotateCcw /> Restart ADB
          </Button>
          <IconButton size="xs" variant="ghost" aria-label="Refresh" onClick={() => void load()}>
            <LuRefreshCw />
          </IconButton>
        </>
      }
    >
      {devices === null ? (
        <Loading rows={1} height="220px" label="Looking for devices" />
      ) : ready.length === 0 && other.length === 0 && bootOnly.length === 0 ? (
        <Flex gap="4" align="center" borderWidth="1px" borderStyle="dashed" borderRadius="lg" p="4" wrap="wrap">
          <Box color="fg.muted" fontSize="2xl">
            <LuCable />
          </Box>
          <Box flex="1" minW="240px" fontSize="sm">
            <Text fontWeight="medium">No device connected yet.</Text>
            <Text color="fg.muted">
              Plug in a phone with USB debugging on (tap “Allow” on the phone), pair one over Wi-Fi with a QR code, or just start a run — emulators you pick boot by themselves and
              appear here.
            </Text>
          </Box>
          <Button asChild size="sm">
            <NextLink href="/devices">
              <LuQrCode /> Connect a phone
            </NextLink>
          </Button>
        </Flex>
      ) : (
        <SimpleGrid columns={{ base: 2, md: 3, lg: 4, xl: 5, '2xl': 6 }} gap="3">
          {ready.map((d) => {
            const name = d.avd_name ?? d.model ?? d.serial;
            return (
              <Stack key={d.serial} gap="1.5" minW="0">
                <LiveThumb serial={d.serial} fast={d.busy} label={name} onClick={() => setViewing(d)} />
                <Box minW="0">
                  <Text fontSize="sm" fontWeight="medium" truncate title={name}>
                    {name}
                  </Text>
                  <HStack gap="1" wrap="wrap">
                    <CBadge size="xs" variant="subtle" colorPalette={d.busy ? 'orange' : 'green'}>
                      {d.busy ? 'testing now' : 'idle'}
                    </CBadge>
                    <CBadge size="xs" variant="outline">
                      {CONN[d.connection]}
                    </CBadge>
                  </HStack>
                </Box>
                <HStack gap="1">
                  {d.connection === 'emulator' && (
                    <IconButton
                      size="2xs"
                      variant="outline"
                      colorPalette="red"
                      aria-label={`Stop ${name}`}
                      title={d.busy ? 'A test run is using it' : 'Stop this emulator'}
                      disabled={d.busy}
                      loading={stopping === d.serial}
                      onClick={() => void stopEmu(d)}
                    >
                      <LuPower />
                    </IconButton>
                  )}
                  <Button size="2xs" variant="outline" flex="1" onClick={() => setViewing(d)}>
                    <LuEye /> Live
                  </Button>
                  <Button size="2xs" variant="outline" flex="1" disabled={!canMirror} onClick={() => void openMirror(d)} title={canMirror ? 'Smooth mirror window (scrcpy)' : 'Install scrcpy on the Developer page first'}>
                    <LuMonitorUp /> Mirror
                  </Button>
                </HStack>
              </Stack>
            );
          })}
          {bootOnly.map((b) => (
            <Stack key={b.serial} gap="1.5" minW="0">
              <BootTile boot={b} />
              <Text fontSize="sm" fontWeight="medium" truncate title={b.avd_name}>
                {b.avd_name}
              </Text>
              <CBadge size="xs" variant="subtle" colorPalette="green" alignSelf="flex-start">
                booting {Math.round(b.progress)} %
              </CBadge>
            </Stack>
          ))}
          {other.map((d) => (
            <Stack key={d.serial} gap="1.5" minW="0" opacity={0.7}>
              <Center h="220px" bg="bg.muted" borderRadius="lg" borderWidth="1px" borderStyle="dashed" fontSize="xs" color="fg.muted" textAlign="center" p="3">
                {d.state === 'unauthorized' ? 'Unlock the phone and tap “Allow USB debugging”' : `Device is ${d.state} — try Restart ADB or replug`}
              </Center>
              <Text fontSize="sm" fontWeight="medium" truncate>
                {d.model ?? d.serial}
              </Text>
            </Stack>
          ))}
        </SimpleGrid>
      )}
      <LiveViewDialog device={viewing} canMirror={canMirror} onMirror={(d) => void openMirror(d)} onClose={() => setViewing(null)} />
    </Card>
  );
}
