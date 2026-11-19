import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { qk, useAdbDevices, useScrcpy } from '../../lib/queries';
import { Badge as CBadge, Box, Button, Center, CloseButton, Dialog, Flex, HStack, IconButton, Image, Portal, SimpleGrid, Spinner, Stack, Text } from '@chakra-ui/react';
import { LuCable, LuEye, LuMonitorUp, LuPower, LuQrCode, LuRefreshCw, LuRotateCcw, LuSmartphone } from 'react-icons/lu';
import { API, api, dev, type AdbDevice } from '../../lib/api';
import type { Live } from '../../lib/useLive';
import { Card, Loading } from '../../components/ui';
import { notify } from '../../components/toaster';
import { LiveScreen } from '../dev/LiveScreen';

const CONN = { usb: 'USB', wifi: 'Wi-Fi', emulator: 'Emulator' } as const;

/**
 * Auto-refreshing screenshot of one device. Fast (~1.5 s) while a test is running on it, slow otherwise.
 * Sequential fetches, so a slow device never piles up requests; pauses while the browser tab is hidden.
 */
export function LiveThumb({ serial, fast, height = '220px', onClick, label }: { serial: string; fast: boolean; height?: string; onClick?: () => void; label: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const fastRef = useRef(fast);
  fastRef.current = fast;
  useEffect(() => {
    let stop = false;
    let prev: string | null = null;
    (async () => {
      while (!stop) {
        if (document.visibilityState === 'visible') {
          try {
            const r = await fetch(`${API}${dev(serial, '/screen')}`, { cache: 'no-store' });
            if (!r.ok) throw new Error();
            const url = URL.createObjectURL(await r.blob());
            if (stop) break;
            setSrc(url);
            setError(false);
            if (prev) URL.revokeObjectURL(prev);
            prev = url;
          } catch {
            setError(true);
          }
        }
        await new Promise((r) => setTimeout(r, fastRef.current ? 1500 : 8000));
      }
    })();
    return () => {
      stop = true;
      if (prev) setTimeout(() => URL.revokeObjectURL(prev!), 1000);
    };
  }, [serial]);
  return (
    <Center
      as={onClick ? 'button' : 'div'}
      onClick={onClick}
      h={height}
      w="100%"
      bg="gray.950"
      borderRadius="lg"
      borderWidth="4px"
      borderColor={fast ? 'orange.solid' : 'gray.800'}
      overflow="hidden"
      cursor={onClick ? 'pointer' : 'default'}
      position="relative"
      aria-label={`Screen of ${label}`}
      title={onClick ? 'Open live view (tap / swipe / type)' : undefined}
    >
      {src ? (
        <Image src={src} alt={`Screen of ${label}`} h="100%" w="auto" maxW="100%" objectFit="contain" draggable={false} />
      ) : error ? (
        <Stack align="center" color="gray.500" gap="1" fontSize="xs">
          <LuSmartphone />
          <Text>No screen (locked or busy)</Text>
        </Stack>
      ) : (
        <Spinner color="gray.400" size="sm" />
      )}
      {fast && (
        <CBadge position="absolute" top="1.5" left="1.5" size="xs" colorPalette="orange" variant="solid">
          ● LIVE
        </CBadge>
      )}
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

  const ready = (devices ?? []).filter((d) => d.state === 'device');
  const other = (devices ?? []).filter((d) => d.state !== 'device');
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
            <a href="#devices" title="Device Manager → Connect over Wi-Fi (QR code or pairing code)">
              <LuQrCode /> Connect over Wi-Fi
            </a>
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
      ) : ready.length === 0 && other.length === 0 ? (
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
            <a href="#devices">
              <LuQrCode /> Connect a phone
            </a>
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
