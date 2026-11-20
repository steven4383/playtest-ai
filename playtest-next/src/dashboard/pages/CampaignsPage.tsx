'use client';
import { useLiveContext } from '../LiveContext';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import NextLink from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { qk, useAdbDevices, useApks, useAvds, useProfiles } from '../lib/queries';
import {
  Box,
  Button,
  Checkbox,
  Collapsible,
  Field,
  Flex,
  Grid,
  HStack,
  Image,
  Link,
  List,
  NativeSelect,
  NumberInput,
  Progress,
  SegmentGroup,
  SimpleGrid,
  Stack,
  Text,
  chakra,
} from '@chakra-ui/react';
import { LuCheck, LuChevronDown, LuCircleAlert, LuFileText, LuListChecks, LuMinus, LuPlay, LuTrash2, LuX } from 'react-icons/lu';
import { API, api, fmtDuration, type AdbDevice, type Apk, type Campaign, type CampaignListItem, type Device, type Execution, type ExecutionStatus } from '../lib/api';
import type { Live } from '../lib/useLive';
import { Badge, Card, Empty, Loading, Notice, type Tone } from '../components/ui';
import { notify } from '../components/toaster';
import { LiveDevices, LiveThumb, LiveViewDialog, openMirror } from './campaigns/LiveDevices';

const EXEC_TONE: Record<ExecutionStatus, Tone> = { queued: 'neutral', running: 'warning', passed: 'good', failed: 'critical', error: 'serious', skipped: 'neutral', cancelled: 'neutral' };
const CAMPAIGN_TONE: Record<string, Tone> = { QUEUED: 'neutral', RUNNING: 'warning', COMPLETED: 'good', CANCELLED: 'neutral', INTERRUPTED: 'serious' };
const STEP_COLOR: Record<string, string> = { passed: 'fg.success', failed: 'fg.error', error: 'fg.warning', skipped: 'fg.subtle', running: 'colorPalette.fg' };

interface Limits {
  max_concurrent_emulators: number;
  recommended_concurrent: number;
  busy_devices: string[];
}

const defaultOpts = { mode: 'sequential' as 'sequential' | 'parallel', concurrency: 2, launch_wait_seconds: 8, cycles: 1, fresh_install: false, uninstall_after: false, stop_emulators_after: true };

const secondsBetween = (a: string | null, b: string | null) => (a ? Math.max(0, Math.round(((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 1000)) : null);

function Check({ checked, onChange, children, disabled }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <Checkbox.Root size="sm" checked={checked} disabled={disabled} onCheckedChange={(e) => onChange(!!e.checked)}>
      <Checkbox.HiddenInput />
      <Checkbox.Control />
      <Checkbox.Label>{children}</Checkbox.Label>
    </Checkbox.Root>
  );
}

function NumField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <Field.Root>
      <Field.Label>{label}</Field.Label>
      <NumberInput.Root size="sm" value={String(value)} min={min} max={max} onValueChange={(e) => onChange(Math.max(min, Math.min(max, Number.isFinite(e.valueAsNumber) ? e.valueAsNumber : min)))} w="100%">
        <NumberInput.Control />
        <NumberInput.Input />
      </NumberInput.Root>
    </Field.Root>
  );
}

function Step({ n, title, children, actions }: { n: number; title: React.ReactNode; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <Stack gap="2.5" borderWidth="1px" borderRadius="md" p="3.5">
      <Flex justify="space-between" align="center" gap="2" wrap="wrap">
        <HStack gap="2">
          <Flex w="6" h="6" borderRadius="full" bg="colorPalette.subtle" color="colorPalette.fg" align="center" justify="center" fontSize="xs" fontWeight="bold">
            {n}
          </Flex>
          <Text fontWeight="semibold" fontFamily="heading">
            {title}
          </Text>
        </HStack>
        {actions}
      </Flex>
      {children}
    </Stack>
  );
}

/** Selected test run, kept while you visit other pages. */
let lastSelected: string | null = null;

export function CampaignsPage() {
  const live = useLiveContext();
  const qc = useQueryClient();
  // Shared cache: coming back to this page shows the last data at once and refreshes in the background.
  const apksQ = useApks();
  const apks = apksQ.data ?? (apksQ.isError ? [] : null);
  const devices = useProfiles().data ?? [];
  const avds = useAvds().data ?? [];
  const adbDevices = useAdbDevices(3000).data?.devices ?? [];
  const limits = useQuery({ queryKey: ['campaigns', 'limits'], staleTime: 5 * 60_000, queryFn: () => api<Limits>('/campaigns/limits') }).data ?? null;
  const campaignsQ = useQuery({ queryKey: ['campaigns', 'list'], queryFn: () => api<CampaignListItem[]>('/campaigns') });
  const campaigns = campaignsQ.data ?? (campaignsQ.isError ? [] : null);
  const [selectedId, setSelectedIdState] = useState<string | null>(() => lastSelected);
  const setSelectedId = (id: string | null) => {
    lastSelected = id;
    setSelectedIdState(id);
  };
  const detailQ = useQuery({ queryKey: ['campaigns', 'detail', selectedId], enabled: !!selectedId, staleTime: 5_000, queryFn: () => api<Campaign>(`/campaigns/${selectedId}`) });
  const detail = selectedId ? (detailQ.data ?? null) : null;
  const detailLoading = detailQ.isFetching;
  const [apkId, setApkId] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [opts, setOpts] = useState(defaultOpts);
  const [busy, setBusy] = useState<string | null>(null);

  const loadSetup = () => Promise.all([qk.apks, qk.profiles, qk.avds, qk.adbDevices].map((queryKey) => qc.invalidateQueries({ queryKey })));
  const loadCampaigns = () => qc.invalidateQueries({ queryKey: ['campaigns', 'list'] });
  const loadDetail = (id: string) => qc.invalidateQueries({ queryKey: ['campaigns', 'detail', id] });

  useEffect(() => {
    setApkId((cur) => cur || apks?.[0]?.id || '');
  }, [apks]);
  useEffect(() => {
    if (!campaigns) return;
    if (!selectedId || !campaigns.some((c) => c.id === selectedId)) setSelectedId(campaigns[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaigns]);
  useEffect(() => {
    const err = apksQ.error ?? campaignsQ.error ?? detailQ.error;
    if (err) notify('error', err.message);
  }, [apksQ.error, campaignsQ.error, detailQ.error]);

  // Live updates: refetch at most once a second while events stream in.
  const pending = useRef<number | null>(null);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  useEffect(() => {
    const off = live.onEvent((e) => {
      if (e.event !== 'campaign_update' && e.event !== 'execution_update') return;
      if (pending.current) return;
      pending.current = window.setTimeout(() => {
        pending.current = null;
        void loadCampaigns();
        if (selectedRef.current && e.campaign_id === selectedRef.current) void loadDetail(selectedRef.current);
        if (e.event === 'campaign_update') void loadSetup();
      }, 800);
    });
    return () => void off();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.onEvent]);

  // Tick once a second so running durations update.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (detail?.status !== 'RUNNING') return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [detail?.status]);

  const apk = apks?.find((a) => a.id === apkId);

  /** Why a device can or cannot be picked right now. */
  const availability = useCallback(
    (d: Device): { ok: boolean; note: string; tone: Tone } => {
      if (apk?.min_sdk && d.api_level && d.api_level < apk.min_sdk) return { ok: false, note: `API ${d.api_level} < minSdk ${apk.min_sdk}`, tone: 'neutral' };
      if (d.type === 'emulator') {
        if (!d.avd_name || !avds.includes(d.avd_name)) return { ok: false, note: 'AVD not installed', tone: 'warning' };
        if (limits?.busy_devices.includes(d.id)) return { ok: true, note: 'busy — will wait', tone: 'warning' };
        return { ok: true, note: d.running ? 'running' : 'boots automatically', tone: 'good' };
      }
      const a = adbDevices.find((x) => x.serial === d.adb_serial);
      if (!a) return { ok: true, note: 'not connected now', tone: 'warning' };
      if (a.state !== 'device') return { ok: true, note: a.state, tone: 'warning' };
      return { ok: true, note: 'connected', tone: 'good' };
    },
    [apk, avds, adbDevices, limits],
  );

  const pickable = useMemo(() => devices.filter((d) => availability(d).ok), [devices, availability]);
  const pickedDevices = devices.filter((d) => picked.has(d.id));
  const emulatorsPicked = pickedDevices.filter((d) => d.type === 'emulator').length;
  const maxParallel = Math.max(2, Math.min(10, pickedDevices.length || 2));

  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const start = async () => {
    if (!apk) return notify('warning', 'Upload an APK on the APK Manager page first.');
    if (!picked.size) return notify('warning', 'Pick at least one device.');
    setBusy('start');
    try {
      const c = await api<Campaign>('/campaigns', {
        method: 'POST',
        body: JSON.stringify({ apk_id: apk.id, device_ids: [...picked], flow: 'open_close', ...opts, concurrency: opts.mode === 'parallel' ? opts.concurrency : 1 }),
      });
      setSelectedId(c.id);
      notify('ok', `Test run started on ${picked.size} device${picked.size === 1 ? '' : 's'}`);
      await loadCampaigns();
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setBusy(null);
    }
  };

  const cancel = async (id: string) => {
    setBusy('cancel');
    try {
      await api(`/campaigns/${id}/cancel`, { method: 'POST', body: '{}' });
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this test run and its screenshots / logs?')) return;
    try {
      await api(`/campaigns/${id}`, { method: 'DELETE' });
      setSelectedId(null);
      qc.removeQueries({ queryKey: ['campaigns', 'detail', id] });
      await loadCampaigns();
    } catch (e: any) {
      notify('error', e.message);
    }
  };

  const emuSlots = limits?.max_concurrent_emulators ?? 1;
  const parallelNote =
    opts.mode === 'parallel' && emulatorsPicked > 1 && opts.concurrency > emuSlots
      ? `Emulators are limited to ${emuSlots} at a time (MAX_CONCURRENT_EMULATORS); the others queue. Physical phones are not limited.`
      : opts.mode === 'parallel' && limits && opts.concurrency > limits.recommended_concurrent && emulatorsPicked > 1
        ? `This machine is rated for ${limits.recommended_concurrent} emulator(s) at once — expect slowdowns above that.`
        : null;

  return (
    <Stack gap="5">
      <LiveDevices live={live} />
      <Grid templateColumns={{ base: '1fr', xl: 'minmax(0, 1.6fr) minmax(300px, 1fr)' }} gap="5" alignItems="start">
        <Card icon={<LuPlay />} title="New test run" subtitle="Install the APK, open it, check it stays up without crashing, then close it — on every device you pick">
          {apks === null ? (
            <Loading rows={6} height="9" />
          ) : (
            <Stack gap="3">
              <Step n={1} title="App">
                {apks.length === 0 ? (
                  <Text fontSize="sm" color="fg.muted">
                    No APK uploaded yet — open{' '}
                    <Link asChild color="colorPalette.fg"><NextLink href="/apks">
                      APK Manager
                    </NextLink></Link>{' '}
                    and upload one.
                  </Text>
                ) : (
                  <>
                    <NativeSelect.Root size="sm">
                      <NativeSelect.Field value={apkId} onChange={(e) => setApkId(e.target.value)} aria-label="APK">
                        {apks.map((a) => (
                          <option key={a.id} value={a.id} disabled={!a.package_name}>
                            {a.package_name ?? '(unreadable)'} {a.version_name ? `v${a.version_name}` : ''} — {a.filename}
                          </option>
                        ))}
                      </NativeSelect.Field>
                      <NativeSelect.Indicator />
                    </NativeSelect.Root>
                    {apk && (
                      <Text fontSize="xs" color="fg.muted">
                        minSdk {apk.min_sdk ?? '?'} · targetSdk {apk.target_sdk ?? '?'}
                      </Text>
                    )}
                  </>
                )}
              </Step>

              <Step
                n={2}
                title={`Devices (${picked.size} selected)`}
                actions={
                  <HStack gap="1.5">
                    <Button size="2xs" variant="outline" onClick={() => setPicked(new Set(pickable.filter((d) => d.enabled).map((d) => d.id)))} disabled={!pickable.length}>
                      All enabled
                    </Button>
                    <Button size="2xs" variant="ghost" onClick={() => setPicked(new Set())} disabled={!picked.size}>
                      Clear
                    </Button>
                  </HStack>
                }
              >
                {devices.length === 0 ? (
                  <Text fontSize="sm" color="fg.muted">
                    No device profiles — add some on{' '}
                    <Link asChild color="colorPalette.fg"><NextLink href="/devices">
                      Device Manager
                    </NextLink></Link>
                    .
                  </Text>
                ) : (
                  <SimpleGrid columns={{ base: 1, md: 2 }} gap="2">
                    {devices.map((d) => {
                      const av = availability(d);
                      const on = picked.has(d.id);
                      return (
                        <chakra.label
                          key={d.id}
                          display="flex"
                          alignItems="center"
                          gap="2.5"
                          borderWidth="1px"
                          borderRadius="md"
                          px="3"
                          py="2"
                          cursor={av.ok ? 'pointer' : 'not-allowed'}
                          opacity={av.ok ? 1 : 0.55}
                          borderColor={on ? 'colorPalette.solid' : 'border'}
                          bg={on ? 'colorPalette.subtle' : 'transparent'}
                          transition="all 0.12s"
                        >
                          <Checkbox.Root size="sm" checked={on} disabled={!av.ok} onCheckedChange={() => toggle(d.id)}>
                            <Checkbox.HiddenInput />
                            <Checkbox.Control />
                          </Checkbox.Root>
                          <Box flex="1" minW="0">
                            <Text fontWeight="medium" fontSize="sm" truncate>
                              {d.name}
                            </Text>
                            <Text fontSize="xs" color="fg.muted" truncate>
                              {d.type === 'emulator' ? 'Emulator' : 'Phone'} · Android {d.android_version ?? '?'}
                              {d.api_level ? ` (API ${d.api_level})` : ''}
                            </Text>
                          </Box>
                          <Badge tone={av.tone}>{av.note}</Badge>
                        </chakra.label>
                      );
                    })}
                  </SimpleGrid>
                )}
              </Step>

              <Step n={3} title="How to run">
                <SegmentGroup.Root size="sm" value={opts.mode} onValueChange={(e) => setOpts({ ...opts, mode: e.value as 'sequential' | 'parallel' })} aria-label="Run mode" alignSelf="flex-start">
                  <SegmentGroup.Indicator />
                  <SegmentGroup.Items
                    items={[
                      { value: 'sequential', label: 'One device at a time' },
                      { value: 'parallel', label: 'Several at once' },
                    ]}
                  />
                </SegmentGroup.Root>
                {opts.mode === 'parallel' && (
                  <Box maxW="220px">
                    <NumField label="Devices at the same time" value={opts.concurrency} min={2} max={maxParallel} onChange={(v) => setOpts({ ...opts, concurrency: v })} />
                  </Box>
                )}
                <Text fontSize="xs" color="fg.muted">
                  Emulator slots: {emuSlots} (machine recommends {limits?.recommended_concurrent ?? '?'}). Emulators boot one by one; physical phones run in parallel.
                </Text>
                {parallelNote && <Notice tone="warning">{parallelNote}</Notice>}
              </Step>

              <Step n={4} title="Test flow: open & close app">
                <List.Root as="ol" ps="5" gap="0.5" fontSize="sm" color="fg.muted">
                  <List.Item>Boot emulator / check phone is connected</List.Item>
                  <List.Item>Install APK{opts.fresh_install ? ' (clean install)' : ''}</List.Item>
                  <List.Item>Open the app (measures cold-start time)</List.Item>
                  <List.Item>Keep it open {opts.launch_wait_seconds}s — must stay running, no crash / ANR; screenshot + logcat saved</List.Item>
                  <List.Item>Close the app (force-stop){opts.cycles > 1 ? ` — repeat ${opts.cycles}×` : ''}</List.Item>
                </List.Root>
                <SimpleGrid columns={{ base: 1, sm: 2 }} gap="3" maxW="420px">
                  <NumField label="Keep open (s)" value={opts.launch_wait_seconds} min={2} max={120} onChange={(v) => setOpts({ ...opts, launch_wait_seconds: v })} />
                  <NumField label="Open/close cycles" value={opts.cycles} min={1} max={10} onChange={(v) => setOpts({ ...opts, cycles: v })} />
                </SimpleGrid>
                <Stack gap="2">
                  <Check checked={opts.fresh_install} onChange={(v) => setOpts({ ...opts, fresh_install: v })}>
                    Clean install (uninstall the old version first)
                  </Check>
                  <Check checked={opts.uninstall_after} onChange={(v) => setOpts({ ...opts, uninstall_after: v })}>
                    Uninstall when done
                  </Check>
                  <Check checked={opts.stop_emulators_after} onChange={(v) => setOpts({ ...opts, stop_emulators_after: v })}>
                    Shut down emulators after their test (frees RAM)
                  </Check>
                </Stack>
              </Step>

              <Button size="md" onClick={() => void start()} loading={busy === 'start'} loadingText="Starting…" disabled={!apk || !picked.size}>
                <LuPlay />
                {`Run on ${picked.size || '…'} device${picked.size === 1 ? '' : 's'}${opts.mode === 'parallel' && picked.size > 1 ? `, ${Math.min(opts.concurrency, picked.size)} at once` : ''}`}
              </Button>
            </Stack>
          )}
        </Card>

        <Card icon={<LuListChecks />} title="Test runs" subtitle={campaigns ? `${campaigns.length} run${campaigns.length === 1 ? '' : 's'}` : 'Loading…'}>
          {campaigns === null ? (
            <Loading rows={4} height="12" />
          ) : campaigns.length === 0 ? (
            <Empty icon={<LuListChecks />} title="No runs yet">
              Start one on the left.
            </Empty>
          ) : (
            <Stack gap="1.5" maxH={{ xl: '720px' }} overflowY="auto">
              {campaigns.map((c) => {
                const on = c.id === selectedId;
                return (
                  <chakra.button
                    key={c.id}
                    onClick={() => setSelectedId(c.id)}
                    textAlign="left"
                    borderWidth="1px"
                    borderRadius="md"
                    px="3"
                    py="2.5"
                    borderColor={on ? 'colorPalette.solid' : 'border'}
                    bg={on ? 'colorPalette.subtle' : 'transparent'}
                    _hover={{ bg: on ? 'colorPalette.subtle' : 'bg.muted' }}
                    cursor="pointer"
                  >
                    <Flex justify="space-between" gap="2" align="center">
                      <Text fontWeight="medium" fontSize="sm" truncate>
                        {c.package_name ?? c.name}
                      </Text>
                      <Badge tone={CAMPAIGN_TONE[c.status] ?? 'neutral'}>{c.status.toLowerCase()}</Badge>
                    </Flex>
                    <Text fontSize="xs" color="fg.muted" mt="0.5">
                      {new Date(c.created_at + (c.created_at.endsWith('Z') ? '' : 'Z')).toLocaleString()} · {c.summary?.total ?? 0} device(s)
                      {c.summary && ` · ${c.summary.passed} passed`}
                      {c.summary && c.summary.failed > 0 && ` · ${c.summary.failed} failed`}
                      {c.summary && c.summary.error > 0 && ` · ${c.summary.error} errors`}
                    </Text>
                  </chakra.button>
                );
              })}
            </Stack>
          )}
        </Card>
      </Grid>

      {detailLoading && !detail ? (
        <Card title="Loading run…">
          <Loading rows={4} height="12" />
        </Card>
      ) : (
        detail && <CampaignDetail c={detail} busy={busy === 'cancel'} onCancel={() => void cancel(detail.id)} onDelete={() => void remove(detail.id)} />
      )}
    </Stack>
  );
}

function CampaignDetail({ c, busy, onCancel, onDelete }: { c: Campaign; busy: boolean; onCancel: () => void; onDelete: () => void }) {
  const s = c.summary;
  const elapsed = secondsBetween(c.started_at ? c.started_at : null, c.completed_at);
  const done = s ? s.total - s.queued - s.running : 0;
  const stat = (n: number, label: string, color: string) => (
    <Box>
      <Text fontFamily="heading" fontSize="2xl" fontWeight="semibold" color={color} className="num" lineHeight="1.1">
        {n}
      </Text>
      <Text fontSize="xs" color="fg.muted">
        {label}
      </Text>
    </Box>
  );
  return (
    <Card
      icon={<LuListChecks />}
      title={c.name}
      subtitle={`${c.package_name ?? ''} ${c.version_name ? `v${c.version_name}` : ''} · ${c.config?.mode === 'parallel' ? `${c.config.concurrency} at once` : 'one device at a time'} · open ${c.config?.launch_wait_seconds}s × ${c.config?.cycles}${elapsed !== null ? ` · ${fmtDuration(elapsed)}` : ''}`}
      actions={
        <>
          <Badge tone={CAMPAIGN_TONE[c.status] ?? 'neutral'}>{c.status.toLowerCase()}</Badge>
          {c.active ? (
            <>
              <Button asChild size="xs" variant="outline">
                <NextLink href="/live">Live view</NextLink>
              </Button>
              <Button size="xs" variant="outline" colorPalette="red" loading={busy} onClick={onCancel}>
                <LuX /> Cancel
              </Button>
            </>
          ) : (
            <Button asChild size="xs" variant="outline">
              <NextLink href={`/reports/${c.id}`}>
                <LuFileText /> Report
              </NextLink>
            </Button>
          )}
          {!c.active && (
            <Button size="xs" variant="ghost" colorPalette="red" onClick={onDelete} aria-label="Delete run">
              <LuTrash2 /> Delete
            </Button>
          )}
        </>
      }
    >
      {s && (
        <Stack gap="3">
          <HStack gap="8" wrap="wrap">
            {stat(s.passed, 'passed', 'fg.success')}
            {stat(s.failed, 'failed', 'fg.error')}
            {stat(s.error, 'errors', 'fg.warning')}
            {s.skipped > 0 && stat(s.skipped, 'skipped', 'fg.muted')}
            {s.cancelled > 0 && stat(s.cancelled, 'cancelled', 'fg.muted')}
            <Text fontSize="sm" color="fg.muted" ms="auto">
              {done}/{s.total} done
            </Text>
          </HStack>
          <Progress.Root value={s.total ? (done / s.total) * 100 : 0} size="sm" colorPalette="green" aria-label="Run progress">
            <Progress.Track>
              <Progress.Range />
            </Progress.Track>
          </Progress.Root>
        </Stack>
      )}
      <Stack gap="2">
        {c.executions.map((e) => (
          <ExecutionCard key={e.id} e={e} />
        ))}
      </Stack>
      <Text fontSize="xs" color="fg.muted">
        <b>failed</b> = the app misbehaved (install failure, crash, ANR, exited). <b>error</b> = the device or emulator had a problem, not the app.
      </Text>
    </Card>
  );
}

const STATUS_BORDER: Partial<Record<ExecutionStatus, string>> = { passed: 'green.solid', failed: 'red.solid', error: 'orange.solid', running: 'blue.solid' };

function ExecutionCard({ e }: { e: Execution }) {
  const [open, setOpen] = useState(e.status === 'failed' || e.status === 'running');
  const screenshots = e.artifacts.filter((a) => a.type === 'screenshot');
  const logs = e.artifacts.filter((a) => a.type !== 'screenshot');
  const running = e.steps.find((s) => s.status === 'running');
  const secs = secondsBetween(e.started_at, e.completed_at);
  const [viewing, setViewing] = useState(false);
  useEffect(() => {
    if (e.status === 'running') setOpen(true);
  }, [e.status]);
  const liveDevice = e.serial ? ({ serial: e.serial, state: 'device', model: e.metrics?.model, is_emulator: e.serial.startsWith('emulator-'), connection: e.serial.startsWith('emulator-') ? 'emulator' : 'usb', profile_id: e.device_id, avd_name: null, busy: true } as AdbDevice) : null;
  return (
    <Collapsible.Root open={open} onOpenChange={(d) => setOpen(d.open)}>
      <Box borderWidth="1px" borderRadius="md" borderInlineStartWidth="3px" borderInlineStartColor={STATUS_BORDER[e.status] ?? 'border'} overflow="hidden">
        <Collapsible.Trigger asChild>
          <chakra.button w="100%" display="flex" alignItems="center" gap="3" px="3.5" py="2.5" textAlign="left" cursor="pointer" _hover={{ bg: 'bg.muted' }} flexWrap="wrap">
            <Box flex="1" minW="180px">
              <Text fontWeight="medium" fontSize="sm">
                {e.device_name ?? e.device_id}
              </Text>
              <Text fontSize="xs" color="fg.muted" truncate>
                {e.metrics?.model ?? ''}
                {e.metrics?.android_version ? ` · Android ${e.metrics.android_version}` : ''}
                {e.serial ? ` · ${e.serial}` : ''}
              </Text>
            </Box>
            <HStack gap="3" fontSize="xs">
              {e.metrics?.avg_launch_ms !== undefined && <Text>start {e.metrics.avg_launch_ms} ms</Text>}
              {secs !== null && <Text color="fg.muted">{fmtDuration(secs)}</Text>}
              <Badge tone={EXEC_TONE[e.status]}>{e.status}</Badge>
              <Box transform={open ? 'rotate(180deg)' : undefined} transition="transform 0.15s" color="fg.muted">
                <LuChevronDown />
              </Box>
            </HStack>
          </chakra.button>
        </Collapsible.Trigger>
        {e.status === 'running' && running && (
          <Text fontSize="xs" color="colorPalette.fg" px="3.5" pb="2">
            Now: {running.name}…
          </Text>
        )}
        {e.error_summary && e.status !== 'passed' && (
          <Text fontSize="xs" color="fg.error" px="3.5" pb="2">
            {e.error_summary}
          </Text>
        )}
        <Collapsible.Content>
          <Grid templateColumns={{ base: '1fr', lg: 'minmax(0, 1fr) auto' }} gap="4" px="3.5" pb="3.5" pt="1" borderTopWidth="1px">
            <Stack as="ol" gap="1.5" pt="2.5" listStyleType="none">
              {e.steps.map((st) => (
                <HStack as="li" key={st.id} gap="2.5" align="flex-start">
                  <Box color={STEP_COLOR[st.status] ?? 'fg.muted'} mt="0.5" aria-hidden>
                    {st.status === 'passed' ? <LuCheck /> : st.status === 'failed' ? <LuX /> : st.status === 'error' ? <LuCircleAlert /> : st.status === 'running' ? '…' : <LuMinus />}
                  </Box>
                  <Box flex="1" minW="0">
                    <Text fontSize="sm">
                      {st.name}{' '}
                      <chakra.span srOnly>({st.status})</chakra.span>
                    </Text>
                    {st.actual_result && (
                      <Text fontSize="xs" color="fg.muted">
                        {st.actual_result}
                      </Text>
                    )}
                  </Box>
                  {st.duration_ms !== null && (
                    <Text fontSize="xs" color="fg.muted" className="num">
                      {(st.duration_ms / 1000).toFixed(1)}s
                    </Text>
                  )}
                </HStack>
              ))}
            </Stack>
            {e.status === 'running' && liveDevice && (
              <Stack gap="1.5" pt="2.5" w={{ base: '100%', lg: '200px' }}>
                <LiveThumb serial={liveDevice.serial} fast label={e.device_name ?? liveDevice.serial} height="340px" onClick={() => setViewing(true)} />
                <HStack gap="1">
                  <Button size="2xs" variant="outline" flex="1" onClick={() => setViewing(true)}>
                    Live view
                  </Button>
                  <Button size="2xs" variant="outline" flex="1" onClick={() => void openMirror(liveDevice)}>
                    Mirror
                  </Button>
                </HStack>
                <LiveViewDialog device={viewing ? liveDevice : null} canMirror onMirror={(d) => void openMirror(d)} onClose={() => setViewing(false)} />
              </Stack>
            )}
            {e.status !== 'running' && (screenshots.length > 0 || logs.length > 0) && (
              <Stack gap="2" pt="2.5">
                <HStack gap="2" wrap="wrap">
                  {screenshots.map((a, i) => (
                    <Link key={a.id} href={`${API}/artifacts/${a.id}`} target="_blank" rel="noreferrer" title="Open full size">
                      <Image src={`${API}/artifacts/${a.id}`} alt={`Screenshot ${i + 1} on ${e.device_name}`} loading="lazy" h="200px" borderRadius="md" borderWidth="1px" />
                    </Link>
                  ))}
                </HStack>
                <HStack gap="1.5" wrap="wrap">
                  {logs.map((a) => (
                    <Button key={a.id} asChild size="2xs" variant="outline">
                      <a href={`${API}/artifacts/${a.id}`} target="_blank" rel="noreferrer">
                        <LuFileText />
                        {a.type === 'logcat' ? 'Logcat' : a.type === 'crash' ? 'Crash log' : a.type === 'anr' ? 'ANR log' : a.type === 'native_crash' ? 'Native crash' : a.type}
                      </a>
                    </Button>
                  ))}
                </HStack>
              </Stack>
            )}
          </Grid>
        </Collapsible.Content>
      </Box>
    </Collapsible.Root>
  );
}

