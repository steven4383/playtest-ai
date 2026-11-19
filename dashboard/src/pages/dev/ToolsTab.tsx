import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Field,
  Flex,
  HStack,
  IconButton,
  Input,
  NativeSelect,
  NumberInput,
  SegmentGroup,
  SimpleGrid,
  Slider,
  Stack,
  Switch,
  Text,
  chakra,
} from '@chakra-ui/react';
import { LuCircleDot, LuDownload, LuExternalLink, LuLink, LuMapPin, LuRotateCw, LuSquare, LuTrash2 } from 'react-icons/lu';
import { API, api, dev, fmtBytes, type Recording, type RecordingStatus, type Toggle } from '../../lib/api';
import { Card, Loading, Notice, useBusy } from '../../components/ui';
import { notify } from '../../components/toaster';

const HISTORY_KEY = 'pt-deeplinks';
const CITIES: { name: string; lat: number; lng: number }[] = [
  { name: 'Chennai', lat: 13.0827, lng: 80.2707 },
  { name: 'Bengaluru', lat: 12.9716, lng: 77.5946 },
  { name: 'Mumbai', lat: 19.076, lng: 72.8777 },
  { name: 'New Delhi', lat: 28.6139, lng: 77.209 },
  { name: 'London', lat: 51.5072, lng: -0.1276 },
  { name: 'New York', lat: 40.7128, lng: -74.006 },
  { name: 'Tokyo', lat: 35.6762, lng: 139.6503 },
  { name: 'San Francisco', lat: 37.7749, lng: -122.4194 },
];

function readHistory(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 10) : [];
  } catch {
    return [];
  }
}

function DeepLink({ serial, pkg }: { serial: string; pkg: string }) {
  const [url, setUrl] = useState('');
  const [target, setTarget] = useState('');
  const [history, setHistory] = useState<string[]>(readHistory);
  const [result, setResult] = useState<{ ok: boolean; activity: string | null; total_time_ms: number | null; error: string | null } | null>(null);
  const { busy, run } = useBusy();

  const open = (u = url) =>
    run('link', async () => {
      try {
        const r = await api<typeof result>(dev(serial, '/deeplink'), { method: 'POST', body: JSON.stringify({ url: u.trim(), package: target.trim() || undefined }) });
        setResult(r);
        const next = [u.trim(), ...history.filter((h) => h !== u.trim())].slice(0, 10);
        setHistory(next);
        try {
          localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
        } catch {
          /* not remembered */
        }
      } catch (e: any) {
        notify('error', e.message);
      }
    });

  return (
    <Card icon={<LuLink />} title="Deep link tester" subtitle="Open a URL or custom scheme the way a tapped link would">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void open();
        }}
      >
        <Stack gap="2">
          <Input size="sm" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/product/42  or  myapp://lesson/7" fontFamily="mono" required aria-label="Deep link URL" />
          <Flex gap="2" wrap="wrap">
            <Input size="sm" flex="1" minW="180px" value={target} onChange={(e) => setTarget(e.target.value)} placeholder={pkg ? `Only open in… (e.g. ${pkg})` : 'Only open in package (optional)'} fontFamily="mono" aria-label="Target package" />
            {pkg && !target && (
              <Button size="sm" variant="ghost" type="button" onClick={() => setTarget(pkg)}>
                Use {pkg.split('.').pop()}
              </Button>
            )}
            <Button size="sm" type="submit" loading={busy === 'link'}>
              <LuExternalLink /> Open on device
            </Button>
          </Flex>
        </Stack>
      </form>
      {result && (
        <Notice tone={result.ok ? 'success' : 'error'} title={result.ok ? 'Opened' : 'Did not open'}>
          {result.ok ? `${result.activity ?? ''}${result.total_time_ms ? ` · ${result.total_time_ms} ms` : ''}` : (result.error ?? 'No activity handles this link')}
        </Notice>
      )}
      {history.length > 0 && (
        <HStack gap="1.5" wrap="wrap">
          {history.map((h) => (
            <Button key={h} size="2xs" variant="outline" borderRadius="full" maxW="280px" onClick={() => (setUrl(h), void open(h))} title={h}>
              <Text truncate fontFamily="mono">
                {h}
              </Text>
            </Button>
          ))}
        </HStack>
      )}
    </Card>
  );
}

const GROUP_LABEL: Record<Toggle['group'], string> = { display: 'Display', debug: 'Developer', power: 'Power', network: 'Network' };

function Toggles({ serial }: { serial: string }) {
  const [toggles, setToggles] = useState<Toggle[] | null>(null);
  const { busy, run } = useBusy();
  useEffect(() => {
    setToggles(null);
    api<{ toggles: Toggle[] }>(dev(serial, '/toggles'))
      .then((r) => setToggles(r.toggles))
      .catch((e) => {
        setToggles([]);
        notify('error', e.message);
      });
  }, [serial]);

  const set = (t: Toggle, value: string) =>
    run(t.id, async () => {
      try {
        const r = await api<{ value: string | null }>(dev(serial, '/toggles'), { method: 'PUT', body: JSON.stringify({ id: t.id, value }) });
        setToggles((list) => list?.map((x) => (x.id === t.id ? { ...x, value: r.value } : x)) ?? null);
      } catch (e: any) {
        notify('error', e.message);
      }
    });

  return (
    <Card icon={<LuRotateCw />} title="Quick settings" subtitle="Change device settings without digging through menus">
      {!toggles ? (
        <Loading rows={5} height="8" label="Reading settings" />
      ) : (
        <SimpleGrid columns={{ base: 1, md: 2 }} gap="4">
          {(['display', 'debug', 'power', 'network'] as const).map((g) => {
            const items = toggles.filter((t) => t.group === g);
            if (!items.length) return null;
            return (
              <Stack key={g} gap="2.5" borderWidth="1px" borderRadius="md" p="3">
                <Text fontSize="2xs" fontWeight="semibold" textTransform="uppercase" letterSpacing="wider" color="fg.subtle">
                  {GROUP_LABEL[g]}
                </Text>
                {items.map((t) =>
                  t.options.length === 2 && t.options.every((o) => o.value === 'on' || o.value === 'off') ? (
                    <Switch.Root
                      key={t.id}
                      size="sm"
                      checked={t.value === 'on'}
                      disabled={!!t.disabled || busy === t.id}
                      onCheckedChange={(e) => void set(t, e.checked ? 'on' : 'off')}
                      justifyContent="space-between"
                      w="100%"
                      title={t.disabled ?? t.hint ?? undefined}
                    >
                      <Box>
                        <Switch.Label>{t.label}</Switch.Label>
                        {(t.disabled || t.hint) && (
                          <Text fontSize="xs" color={t.disabled ? 'fg.warning' : 'fg.muted'}>
                            {t.disabled ?? t.hint}
                          </Text>
                        )}
                      </Box>
                      <Switch.HiddenInput />
                      <Switch.Control />
                    </Switch.Root>
                  ) : (
                    <Field.Root key={t.id}>
                      <Field.Label>{t.label}</Field.Label>
                      <NativeSelect.Root size="sm" disabled={busy === t.id}>
                        <NativeSelect.Field value={t.value ?? ''} onChange={(e) => void set(t, e.target.value)}>
                          {!t.options.some((o) => o.value === t.value) && <option value={t.value ?? ''}>{t.value ?? 'unknown'}</option>}
                          {t.options.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </NativeSelect.Field>
                        <NativeSelect.Indicator />
                      </NativeSelect.Root>
                    </Field.Root>
                  ),
                )}
              </Stack>
            );
          })}
        </SimpleGrid>
      )}
    </Card>
  );
}

function Recorder({ serial, title }: { serial: string; title: string }) {
  const [status, setStatus] = useState<RecordingStatus>({ active: false });
  const [seconds, setSeconds] = useState(30);
  const [list, setList] = useState<Recording[] | null>(null);
  const [now, setNow] = useState(Date.now());
  const { busy, run } = useBusy();

  const loadList = () =>
    api<{ recordings: Recording[] }>('/recordings')
      .then((r) => setList(r.recordings))
      .catch(() => setList([]));
  useEffect(() => {
    void loadList();
    api<RecordingStatus>(dev(serial, '/record')).then(setStatus).catch(() => {});
  }, [serial]);

  useEffect(() => {
    if (!status.active) return;
    const t = setInterval(async () => {
      setNow(Date.now());
      const s = await api<RecordingStatus>(dev(serial, '/record')).catch(() => null);
      if (s) {
        setStatus(s);
        if (!s.active) void loadList();
      }
    }, 1000);
    return () => clearInterval(t);
  }, [status.active, serial]);

  const start = () =>
    run('start', async () => {
      try {
        await api(dev(serial, '/record/start'), { method: 'POST', body: JSON.stringify({ seconds, title }) });
        setStatus(await api<RecordingStatus>(dev(serial, '/record')));
      } catch (e: any) {
        notify('error', e.message);
      }
    });
  const stop = () =>
    run('stop', async () => {
      try {
        const r = await api<{ error: string | null }>(dev(serial, '/record/stop'), { method: 'POST', body: '{}' });
        if (r.error) notify('error', r.error);
        else notify('ok', 'Recording saved');
        setStatus({ active: false });
        await loadList();
      } catch (e: any) {
        notify('error', e.message);
      }
    });
  const remove = (id: string) =>
    run(`rm:${id}`, async () => {
      await api(`/recordings/${id}`, { method: 'DELETE' }).catch((e) => notify('error', e.message));
      await loadList();
    });

  const elapsed = status.active && status.started_at ? Math.floor((now - Date.parse(status.started_at)) / 1000) : 0;
  const mine = (list ?? []).filter((r) => r.serial === serial);

  return (
    <Card icon={<LuCircleDot />} title="Screen recording" subtitle="MP4 from the device (max 3 minutes, no audio)">
      <Flex gap="3" align="flex-end" wrap="wrap">
        {!status.active ? (
          <>
            <Field.Root w="140px">
              <Field.Label>Length (s)</Field.Label>
              <NumberInput.Root size="sm" value={String(seconds)} min={5} max={180} onValueChange={(e) => setSeconds(Math.max(5, Math.min(180, e.valueAsNumber || 30)))}>
                <NumberInput.Control />
                <NumberInput.Input />
              </NumberInput.Root>
            </Field.Root>
            <Button size="sm" colorPalette="red" onClick={() => void start()} loading={busy === 'start'}>
              <LuCircleDot /> Start recording
            </Button>
          </>
        ) : (
          <>
            <HStack gap="2" color="fg.error" fontWeight="semibold">
              <Box w="2.5" h="2.5" borderRadius="full" bg="red.solid" animation="pulse 1s infinite" />
              <Text className="num">
                {status.state === 'saving' ? 'Saving…' : `REC ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')} / ${Math.floor((status.seconds ?? 0) / 60)}:${String((status.seconds ?? 0) % 60).padStart(2, '0')}`}
              </Text>
            </HStack>
            <Button size="sm" variant="outline" onClick={() => void stop()} loading={busy === 'stop' || status.state === 'saving'}>
              <LuSquare /> Stop & save
            </Button>
          </>
        )}
      </Flex>
      <Text fontSize="xs" color="fg.muted">
        Turn on “Show taps” in Quick settings to show touches in the video. Apps that block screenshots record as black.
      </Text>
      {list === null ? (
        <Loading rows={1} height="20" />
      ) : (
        mine.length > 0 && (
          <SimpleGrid columns={{ base: 1, sm: 2, xl: 3 }} gap="3">
            {mine.map((r) => (
              <Box key={r.id} borderWidth="1px" borderRadius="md" overflow="hidden">
                <chakra.video controls preload="metadata" src={`${API}/recordings/${r.id}`} w="100%" maxH="260px" bg="black" />
                <Flex justify="space-between" align="center" px="2" py="1.5" gap="1">
                  <Text fontSize="xs" color="fg.muted" truncate>
                    {new Date(r.started_at).toLocaleString()} · {fmtBytes(r.size_bytes)}
                  </Text>
                  <HStack gap="0.5">
                    <IconButton asChild size="2xs" variant="ghost" aria-label="Download recording">
                      <a href={`${API}/recordings/${r.id}?download=true`}>
                        <LuDownload />
                      </a>
                    </IconButton>
                    <IconButton size="2xs" variant="ghost" colorPalette="red" aria-label="Delete recording" loading={busy === `rm:${r.id}`} onClick={() => void remove(r.id)}>
                      <LuTrash2 />
                    </IconButton>
                  </HStack>
                </Flex>
              </Box>
            ))}
          </SimpleGrid>
        )
      )}
    </Card>
  );
}

function EmulatorControls({ serial }: { serial: string }) {
  const [lat, setLat] = useState('13.0827');
  const [lng, setLng] = useState('80.2707');
  const [battery, setBattery] = useState(80);
  const [charging, setCharging] = useState(true);
  const [speed, setSpeed] = useState('full');
  const [delay, setDelay] = useState('none');
  const { busy, run } = useBusy();

  const send = (key: string, body: object, ok: string) =>
    run(key, async () => {
      try {
        await api(dev(serial, '/emu'), { method: 'POST', body: JSON.stringify(body) });
        notify('ok', ok);
      } catch (e: any) {
        notify('error', e.message);
      }
    });

  return (
    <Card icon={<LuMapPin />} title="Emulator controls" subtitle="Fake location, battery and network conditions">
      <SimpleGrid columns={{ base: 1, lg: 3 }} gap="4">
        <Stack gap="2.5" borderWidth="1px" borderRadius="md" p="3">
          <Text fontWeight="medium" fontSize="sm">
            GPS location
          </Text>
          <HStack gap="1" wrap="wrap">
            {CITIES.map((c) => (
              <Button
                key={c.name}
                size="2xs"
                variant="outline"
                borderRadius="full"
                onClick={() => {
                  setLat(String(c.lat));
                  setLng(String(c.lng));
                  void send('geo', { action: 'geo', lat: c.lat, lng: c.lng }, `Location set to ${c.name}`);
                }}
              >
                {c.name}
              </Button>
            ))}
          </HStack>
          <HStack gap="2">
            <Input size="sm" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="Latitude" aria-label="Latitude" inputMode="decimal" />
            <Input size="sm" value={lng} onChange={(e) => setLng(e.target.value)} placeholder="Longitude" aria-label="Longitude" inputMode="decimal" />
          </HStack>
          <Button size="sm" variant="outline" loading={busy === 'geo'} onClick={() => void send('geo', { action: 'geo', lat: Number(lat), lng: Number(lng) }, `Location set to ${lat}, ${lng}`)}>
            Set location
          </Button>
        </Stack>

        <Stack gap="3" borderWidth="1px" borderRadius="md" p="3">
          <Text fontWeight="medium" fontSize="sm">
            Battery
          </Text>
          <Slider.Root size="sm" min={0} max={100} value={[battery]} onValueChange={(e) => setBattery(e.value[0])} onValueChangeEnd={(e) => void send('bat', { action: 'battery', level: e.value[0] }, `Battery set to ${e.value[0]}%`)}>
            <HStack justify="space-between">
              <Slider.Label fontWeight="normal">Level</Slider.Label>
              <Slider.ValueText className="num" />
            </HStack>
            <Slider.Control>
              <Slider.Track>
                <Slider.Range />
              </Slider.Track>
              <Slider.Thumbs />
            </Slider.Control>
          </Slider.Root>
          <Switch.Root
            size="sm"
            checked={charging}
            onCheckedChange={(e) => {
              setCharging(e.checked);
              void send('chg', { action: 'battery', charging: e.checked }, e.checked ? 'Charger connected' : 'Charger disconnected');
            }}
          >
            <Switch.HiddenInput />
            <Switch.Control />
            <Switch.Label>Charging</Switch.Label>
          </Switch.Root>
          <HStack gap="1">
            {[5, 15, 50, 100].map((v) => (
              <Button key={v} size="2xs" variant="outline" onClick={() => (setBattery(v), void send('bat', { action: 'battery', level: v }, `Battery set to ${v}%`))}>
                {v}%
              </Button>
            ))}
          </HStack>
        </Stack>

        <Stack gap="2.5" borderWidth="1px" borderRadius="md" p="3">
          <Text fontWeight="medium" fontSize="sm">
            Network & screen
          </Text>
          <Field.Root>
            <Field.Label>Speed</Field.Label>
            <SegmentGroup.Root size="xs" value={speed} onValueChange={(e) => (setSpeed(e.value!), void send('net', { action: 'network', speed: e.value }, `Network speed: ${e.value}`))}>
              <SegmentGroup.Indicator />
              <SegmentGroup.Items items={['full', 'lte', 'umts', 'edge', 'gprs']} />
            </SegmentGroup.Root>
          </Field.Root>
          <Field.Root>
            <Field.Label>Latency</Field.Label>
            <SegmentGroup.Root size="xs" value={delay} onValueChange={(e) => (setDelay(e.value!), void send('net', { action: 'network', delay: e.value }, `Network latency: ${e.value}`))}>
              <SegmentGroup.Indicator />
              <SegmentGroup.Items items={['none', 'umts', 'edge', 'gprs']} />
            </SegmentGroup.Root>
          </Field.Root>
          <Button size="sm" variant="outline" loading={busy === 'rot'} onClick={() => void send('rot', { action: 'rotate' }, 'Rotated')}>
            <LuRotateCw /> Rotate screen
          </Button>
        </Stack>
      </SimpleGrid>
    </Card>
  );
}

export function ToolsTab({ serial, pkg, title, isEmulator }: { serial: string; pkg: string; title: string; isEmulator: boolean }) {
  return (
    <Stack gap="4">
      <DeepLink serial={serial} pkg={pkg} />
      <Toggles serial={serial} />
      <Recorder serial={serial} title={title} />
      {isEmulator ? (
        <EmulatorControls serial={serial} />
      ) : (
        <Text fontSize="xs" color="fg.muted">
          GPS, battery and network simulation are available when an emulator is selected.
        </Text>
      )}
    </Stack>
  );
}
