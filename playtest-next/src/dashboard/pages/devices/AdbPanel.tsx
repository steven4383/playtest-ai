import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { qk, useAdbDevices } from '../../lib/queries';
import { Box, Button, Center, Code, Field, Flex, Grid, HStack, Image, Input, List, Stack, Table, Tabs, Text } from '@chakra-ui/react';
import { LuCable, LuQrCode, LuRefreshCw, LuRotateCcw, LuUnplug, LuUserPlus, LuWifi } from 'react-icons/lu';
import { api, type AdbDevice, type QrSession, type ToolStatus } from '../../lib/api';
import { Badge, Card, Loading, Notice, type Tone } from '../../components/ui';
import { notify } from '../../components/toaster';

const STATE_TONE: Record<string, Tone> = { device: 'good', unauthorized: 'warning', offline: 'critical', authorizing: 'warning' };
const STATE_LABEL: Record<string, string> = { device: 'ready', unauthorized: 'unauthorized', offline: 'offline', authorizing: 'authorizing' };
const CONN_LABEL = { usb: 'USB', wifi: 'Wi-Fi', emulator: 'Emulator' } as const;

const POLL_MS = 4000;

const QR_TONE: Record<QrSession['status'], Tone> = {
  waiting: 'neutral',
  pairing: 'warning',
  connecting: 'warning',
  connected: 'good',
  failed: 'critical',
  expired: 'neutral',
  cancelled: 'neutral',
};

/** Android Studio-style "Pair device with QR code": show the QR, the backend watches mDNS and pairs + connects. */
function QrPair({ onConnected }: { onConnected: (serial: string) => void }) {
  const [session, setSession] = useState<QrSession | null>(null);
  const [starting, setStarting] = useState(false);
  const [now, setNow] = useState(Date.now());
  const reported = useRef<string | null>(null);

  const start = useCallback(async () => {
    setStarting(true);
    try {
      setSession(await api<QrSession>('/adb/qr-pair', { method: 'POST' }));
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setStarting(false);
    }
  }, []);

  const active = session && ['waiting', 'pairing', 'connecting'].includes(session.status);

  useEffect(() => {
    if (!session || !active) return;
    const t = setInterval(async () => {
      setNow(Date.now());
      try {
        const s = await api<QrSession>(`/adb/qr-pair/${session.id}`);
        setSession(s);
        if (s.status === 'connected' && s.serial && reported.current !== s.id) {
          reported.current = s.id;
          onConnected(s.serial);
        }
      } catch {
        /* keep polling */
      }
    }, 1500);
    return () => clearInterval(t);
  }, [session?.id, active, onConnected]);

  // Cancel the backend session if the panel closes mid-pairing.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  useEffect(
    () => () => {
      const s = sessionRef.current;
      if (s && ['waiting', 'pairing', 'connecting'].includes(s.status)) void api(`/adb/qr-pair/${s.id}`, { method: 'DELETE' }).catch(() => {});
    },
    [],
  );

  const secsLeft = session ? Math.max(0, Math.round((Date.parse(session.expires_at) - now) / 1000)) : 0;
  const showQr = session && !['expired', 'cancelled', 'failed', 'connected'].includes(session.status);

  return (
    <Grid templateColumns={{ base: '1fr', md: '1fr auto' }} gap="5" alignItems="start">
      <Stack gap="2" fontSize="sm">
        <Text fontWeight="medium">Phone and PC must be on the same Wi-Fi. Android 11 or newer.</Text>
        <List.Root as="ol" ps="5" gap="1">
          <List.Item>
            On the phone open <b>Settings → Developer options → Wireless debugging</b> and turn it on.
          </List.Item>
          <List.Item>
            Tap <b>Pair device with QR code</b>.
          </List.Item>
          <List.Item>Scan the code shown here. Pairing and connecting happen automatically.</List.Item>
        </List.Root>
        <Text fontSize="xs" color="fg.muted">
          Stuck on “waiting”? Allow adb.exe through Windows Firewall on private networks (it uses mDNS), and make sure the Wi-Fi isn’t a guest network that isolates devices.
        </Text>
      </Stack>
      <Stack align="center" gap="2" minW="220px">
        <Center w="208px" h="208px" bg="white" borderRadius="lg" borderWidth="1px" overflow="hidden">
          {showQr ? (
            <Image src={`data:image/svg+xml;utf8,${encodeURIComponent(session.qr_svg)}`} alt="QR code for Android wireless debugging pairing" w="196px" h="196px" />
          ) : starting ? (
            <Loading rows={1} height="180px" label="Preparing QR code" />
          ) : (
            <Box color="gray.400" fontSize="5xl">
              {session?.status === 'connected' ? '✓' : <LuQrCode />}
            </Box>
          )}
        </Center>
        {session && (
          <Stack gap="1" align="center" role="status" textAlign="center">
            <Badge tone={QR_TONE[session.status]}>{session.status}</Badge>
            <Text fontSize="xs">{session.message}</Text>
            {session.status === 'waiting' && (
              <Text fontSize="xs" color="fg.muted">
                Expires in {Math.floor(secsLeft / 60)}:{String(secsLeft % 60).padStart(2, '0')}
              </Text>
            )}
          </Stack>
        )}
        <Button size="sm" onClick={() => void start()} loading={starting} disabled={!!active}>
          <LuQrCode /> {session ? 'New QR code' : 'Show QR code'}
        </Button>
      </Stack>
    </Grid>
  );
}

/** Live `adb devices` list + USB / Wi-Fi connection helpers. */
export function AdbPanel({ tools, onProfilesChanged, id, wifiId }: { tools: ToolStatus | null; onProfilesChanged: () => void; id?: string; wifiId?: string }) {
  const qc = useQueryClient();
  const adbQ = useAdbDevices(POLL_MS);
  const devices: AdbDevice[] = adbQ.data?.devices ?? [];
  const adbError = adbQ.error?.message ?? adbQ.data?.error ?? null;
  const loaded = adbQ.data !== undefined || adbQ.isError;
  const [busy, setBusy] = useState<string | null>(null);
  const [pairAddr, setPairAddr] = useState('');
  const [pairCode, setPairCode] = useState('');
  const [connAddr, setConnAddr] = useState('');

  const load = () => qc.invalidateQueries({ queryKey: qk.adbDevices });

  const act = async (key: string, fn: () => Promise<{ message?: string } | unknown>, okText?: string) => {
    setBusy(key);
    try {
      const r = (await fn()) as { message?: string } | undefined;
      notify('ok', okText ?? r?.message ?? 'Done');
      await load();
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setBusy(null);
    }
  };

  const post = (path: string, body?: unknown) => api<{ message?: string }>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

  const addProfile = (d: AdbDevice) =>
    act(
      `p-${d.serial}`,
      async () => {
        await post(`/adb/devices/${encodeURIComponent(d.serial)}/profile`);
        onProfilesChanged();
      },
      `Added ${d.model ?? d.serial} as a device profile`,
    );

  const pair = (e: React.FormEvent) => {
    e.preventDefault();
    void act('pair', async () => {
      const r = await post('/adb/pair', { address: pairAddr.trim(), code: pairCode.trim() });
      setPairCode('');
      // The connect port differs from the pairing port — prefill the IP and let the user add the port.
      if (!connAddr) setConnAddr(`${pairAddr.trim().split(':')[0]}:`);
      return r;
    });
  };

  const connect = (e: React.FormEvent) => {
    e.preventDefault();
    void act('connect', () => post('/adb/connect', { address: connAddr.trim() }));
  };

  const unauthorized = devices.some((d) => d.state === 'unauthorized');

  return (
    <>
      <Card
        id={id}
        icon={<LuCable />}
        title="Connected via ADB"
        subtitle={`${tools?.adb.version ?? 'adb not available'} · refreshes every ${POLL_MS / 1000}s`}
        actions={
          <>
            <Button size="xs" variant="outline" loading={busy === 'restart'} onClick={() => act('restart', () => post('/adb/restart'), 'ADB server restarted')} title="Fixes most offline / stuck devices">
              <LuRotateCcw /> Restart ADB
            </Button>
            <Button size="xs" variant="ghost" onClick={() => void load()} aria-label="Refresh">
              <LuRefreshCw />
            </Button>
          </>
        }
      >
        {adbError && <Notice tone="error">{adbError}</Notice>}

        {!loaded ? (
          <Loading rows={3} height="8" label="Checking ADB" />
        ) : devices.length === 0 ? (
          <Box borderWidth="1px" borderStyle="dashed" borderRadius="lg" p="4" fontSize="sm">
            <Text fontWeight="medium" mb="2">
              No devices connected. Boot an emulator from the profiles above, or connect a phone:
            </Text>
            <List.Root as="ol" ps="5" gap="1">
              <List.Item>
                On the phone, open <b>Settings → About phone</b> and tap <b>Build number</b> 7 times.
              </List.Item>
              <List.Item>
                Open <b>Developer options</b> and turn on <b>USB debugging</b>.
              </List.Item>
              <List.Item>
                Plug it in with a data USB cable and tap <b>Allow</b> on the “Allow USB debugging?” prompt.
              </List.Item>
              <List.Item>It shows up here within a few seconds. Or pair over Wi-Fi below.</List.Item>
            </List.Root>
            <Text fontSize="xs" color="fg.muted" mt="2">
              Not showing up? Try another cable or port, set USB mode to “File transfer”, install your phone maker’s USB driver (Windows), then press Restart ADB.
            </Text>
          </Box>
        ) : (
          <>
            <Box overflowX="auto">
              <Table.Root size="sm">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>Device</Table.ColumnHeader>
                    <Table.ColumnHeader>Serial</Table.ColumnHeader>
                    <Table.ColumnHeader>Link</Table.ColumnHeader>
                    <Table.ColumnHeader>State</Table.ColumnHeader>
                    <Table.ColumnHeader aria-label="Actions" />
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {devices.map((d) => (
                    <Table.Row key={d.serial}>
                      <Table.Cell>
                        <Text fontWeight="medium">{d.avd_name ?? d.model ?? (d.is_emulator ? 'Emulator' : '—')}</Text>
                        {d.avd_name && d.model && (
                          <Text fontSize="xs" color="fg.muted">
                            {d.model}
                          </Text>
                        )}
                        {d.busy && (
                          <Text fontSize="xs" color="fg.warning">
                            testing now
                          </Text>
                        )}
                      </Table.Cell>
                      <Table.Cell fontFamily="mono" fontSize="xs">
                        {d.serial}
                      </Table.Cell>
                      <Table.Cell>{CONN_LABEL[d.connection]}</Table.Cell>
                      <Table.Cell>
                        <Badge tone={STATE_TONE[d.state] ?? 'neutral'}>{STATE_LABEL[d.state] ?? d.state}</Badge>
                      </Table.Cell>
                      <Table.Cell>
                        <HStack gap="2" justify="flex-end">
                          {d.profile_id ? (
                            <Badge tone="good">in profiles</Badge>
                          ) : (
                            !d.is_emulator && (
                              <Button size="2xs" disabled={!!busy || d.state !== 'device'} loading={busy === `p-${d.serial}`} onClick={() => void addProfile(d)}>
                                <LuUserPlus /> Add as profile
                              </Button>
                            )
                          )}
                          {d.connection === 'wifi' && (
                            <Button
                              size="2xs"
                              variant="ghost"
                              disabled={!!busy}
                              loading={busy === `x-${d.serial}`}
                              onClick={() => act(`x-${d.serial}`, () => post(`/adb/devices/${encodeURIComponent(d.serial)}/disconnect`))}
                            >
                              <LuUnplug /> Disconnect
                            </Button>
                          )}
                        </HStack>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Box>
            {unauthorized && (
              <Notice tone="warning">
                Unauthorized: unlock the phone and accept “Allow USB debugging”. If no prompt appears, revoke USB debugging authorizations in Developer options and replug.
              </Notice>
            )}
          </>
        )}
      </Card>

      <Card id={wifiId} icon={<LuWifi />} title="Connect over Wi-Fi" subtitle="Wireless debugging — QR code (like Android Studio) or pairing code">
        <Tabs.Root defaultValue="qr" variant="enclosed" size="sm" lazyMount>
          <Tabs.List>
            <Tabs.Trigger value="qr">
              <LuQrCode /> QR code
            </Tabs.Trigger>
            <Tabs.Trigger value="code">
              <LuWifi /> Pairing code / IP
            </Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="qr" pt="4">
            <QrPair
              onConnected={(serial) => {
                notify('ok', `Connected ${serial} over Wi-Fi — press “Add as profile” to use it for tests.`);
                void load();
              }}
            />
          </Tabs.Content>
          <Tabs.Content value="code" pt="4">
            <Stack gap="4">
              <Text fontSize="sm" color="fg.muted">
                Phone and PC on the same Wi-Fi. On the phone (Android 11+): <b>Developer options → Wireless debugging → Pair device with pairing code</b>. Pair once, then connect with
                the IP:port shown on the Wireless debugging screen (it differs from the pairing port). Android 10 and older: connect by USB once, then use <b>Switch to Wi-Fi</b> on
                the Developer page (or <Code size="sm">adb tcpip 5555</Code>).
              </Text>
              <form onSubmit={pair}>
                <Flex gap="3" align="flex-end" wrap="wrap">
                  <Field.Root flex="2" minW="200px">
                    <Field.Label>Pairing IP:port</Field.Label>
                    <Input size="sm" value={pairAddr} onChange={(e) => setPairAddr(e.target.value)} placeholder="192.168.1.23:37211" required inputMode="url" />
                  </Field.Root>
                  <Field.Root flex="1" minW="120px">
                    <Field.Label>Pairing code</Field.Label>
                    <Input size="sm" value={pairCode} onChange={(e) => setPairCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="123456" required inputMode="numeric" pattern="\d{6}" />
                  </Field.Root>
                  <Button type="submit" size="sm" variant="outline" loading={busy === 'pair'}>
                    1. Pair
                  </Button>
                </Flex>
              </form>
              <form onSubmit={connect}>
                <Flex gap="3" align="flex-end" wrap="wrap">
                  <Field.Root flex="2" minW="200px">
                    <Field.Label>Device IP:port</Field.Label>
                    <Input size="sm" value={connAddr} onChange={(e) => setConnAddr(e.target.value)} placeholder="192.168.1.23:41095" required inputMode="url" />
                  </Field.Root>
                  <Button type="submit" size="sm" loading={busy === 'connect'}>
                    2. Connect
                  </Button>
                </Flex>
              </form>
            </Stack>
          </Tabs.Content>
        </Tabs.Root>
      </Card>
    </>
  );
}
