'use client';
import { useLiveContext } from '../LiveContext';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Box, Button, Checkbox, Collapsible, Field, Flex, HStack, IconButton, Input, NativeSelect, Progress, SimpleGrid, Stack, Table, Text } from '@chakra-ui/react';
import { LuCable, LuEraser, LuHardDrive, LuHardDriveDownload, LuLayers, LuListChecks, LuMemoryStick, LuPlay, LuPlus, LuSquare, LuStethoscope, LuTrash2, LuWifi, LuWrench, LuZap } from 'react-icons/lu';
import { api, fmtBytes, startEmulatorProfile, type BootProgress, type Device, type SdkJob, type ToolStatus } from '../lib/api';
import { qk, useAvds, useBoot, useProfiles, useSdkJobs, useSdkStorage, useTools } from '../lib/queries';
import { Badge, Card, Empty, Loading, Notice, type Tone } from '../components/ui';
import { SectionLayout } from '../components/SectionNav';
import { notify } from '../components/toaster';
import { AdbPanel } from './devices/AdbPanel';
import { SdkPanel } from './devices/SdkPanel';
import { StoragePanel } from './devices/StoragePanel';
import { SpeedCard } from './devices/SpeedCard';
import { RamCard } from './devices/RamCard';
import { CreateAvdDialog } from './devices/CreateAvd';

/** Size of an AVD's internal storage as config.ini writes it (bytes or "6G"). */
const partition = (v: string | null) => {
  if (!v) return null;
  if (/^\d+$/.test(v)) return fmtBytes(Number(v));
  return v.replace(/^(\d+)\s*([MG])B?$/i, (_m, n, u) => `${n} ${u.toUpperCase()}B`);
};

/** Small 1 → 100 % bar for a profile whose emulator is booting. */
function BootBar({ boot }: { boot: BootProgress }) {
  return (
    <Stack gap="0.5" mt="1" minW="140px" maxW="200px">
      <Progress.Root value={boot.progress} size="xs" colorPalette="green" striped animated aria-label={`Boot progress ${Math.round(boot.progress)} %`}>
        <Progress.Track>
          <Progress.Range />
        </Progress.Track>
      </Progress.Root>
      <Text fontSize="2xs" color="fg.muted" truncate title={boot.phase ?? ''}>
        {Math.round(boot.progress)} % · {boot.phase}
        {boot.eta_s ? ` · ~${boot.eta_s}s` : ''}
      </Text>
    </Stack>
  );
}

const STATUS: Record<string, Tone> = { online: 'good', starting: 'warning', offline: 'neutral', error: 'critical' };

const emptyForm = { name: '', type: 'emulator', avd_name: '', adb_serial: '', api_level: '', android_version: '', resolution: '', ram_mb: '' };

export function DevicesPage() {
  const live = useLiveContext();
  const qc = useQueryClient();
  const profilesQ = useProfiles();
  const devices = profilesQ.isError ? (profilesQ.data ?? []) : (profilesQ.data ?? null);
  const tools = useTools().data ?? null;
  const avds = useAvds().data ?? null;
  const jobs = useSdkJobs().data ?? [];
  const bootList = useBoot().data ?? [];
  const bootOf = (id: string) => bootList.find((b) => b.device_id === id && !b.booted) ?? null;
  const storage = useSdkStorage(!!tools?.avdmanager).data ?? null;
  const [creating, setCreating] = useState(false);
  /** profile id → provision job id, so the row can show its own progress */
  const [provisioning, setProvisioning] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [showForm, setShowForm] = useState(false);

  /** Refetch profiles, tools and AVDs (cached data stays on screen meanwhile). */
  const load = async () => {
    await Promise.all([qk.profiles, qk.tools, qk.avds].map((queryKey) => qc.invalidateQueries({ queryKey })));
  };
  useEffect(() => {
    if (profilesQ.error) notify('error', profilesQ.error.message);
  }, [profilesQ.error]);

  const list = devices ?? [];
  const jobById = (id?: string) => (id ? jobs.find((j) => j.id === id) : undefined);
  const avdMissing = (d: Device) => d.type === 'emulator' && !!d.avd_name && avds !== null && !avds.includes(d.avd_name);
  const activeJob = (d: Device) => {
    const j = jobById(provisioning[d.id]);
    return j && (j.status === 'queued' || j.status === 'running') ? j : undefined;
  };

  const act = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) notify('ok', ok);
      await load();
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setBusy(null);
    }
  };

  const startProvision = async (d: Device) => {
    const job = await api<SdkJob>(`/devices/${d.id}/provision`, { method: 'POST', body: JSON.stringify({ accept_licenses: true }) });
    setProvisioning((p) => ({ ...p, [d.id]: job.id }));
  };

  const provision = (d: Device) => {
    if (!confirm(`Set up "${d.name}"? Creates AVD ${d.avd_name}, downloading the Android API ${d.api_level} system image (~1.5–2 GB) if it is not installed. This accepts the Android SDK License (developer.android.com/studio/terms).`))
      return;
    void act(`v-${d.id}`, () => startProvision(d));
  };

  const missingEnabled = list.filter((d) => d.enabled && avdMissing(d) && d.api_level && !activeJob(d));
  const provisionAll = () => {
    const apis = [...new Set(missingEnabled.map((d) => d.api_level))].join(', ');
    if (!confirm(`Set up ${missingEnabled.length} emulator(s)? This downloads Android system images for API ${apis} (~1.5–2 GB each, skipped if already installed) and accepts the Android SDK License (developer.android.com/studio/terms).`))
      return;
    void act('provision-all', async () => {
      for (const d of missingEnabled) await startProvision(d);
    });
  };

  const toggle = (d: Device) => act(`t-${d.id}`, () => api(`/devices/${d.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !d.enabled }) }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const num = (s: string) => (s ? Number(s) : undefined);
    const body = {
      name: form.name,
      type: form.type,
      avd_name: form.avd_name || undefined,
      adb_serial: form.adb_serial || undefined,
      api_level: num(form.api_level),
      android_version: form.android_version || undefined,
      resolution: form.resolution || undefined,
      ram_mb: num(form.ram_mb),
    };
    void act(
      'create',
      async () => {
        await api('/devices', { method: 'POST', body: JSON.stringify(body) });
        setForm(emptyForm);
        setShowForm(false);
      },
      `Profile “${form.name}” added`,
    );
  };

  const enabled = list.filter((d) => d.enabled).length;
  const cap = live.capacity;
  const knownAvds = new Set(list.map((d) => d.avd_name));
  const runningJobs = jobs.filter((j) => j.status === 'running' || j.status === 'queued').length;
  const field = (key: keyof typeof emptyForm, label: string, placeholder: string, type = 'text', extra?: Record<string, unknown>) => (
    <Field.Root required={key === 'name'}>
      <Field.Label>{label}</Field.Label>
      <Input size="sm" type={type} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} placeholder={placeholder} {...extra} />
    </Field.Root>
  );

  return (
    <SectionLayout
      sections={[
        { id: 'dm-profiles', label: 'Device profiles', icon: <LuListChecks />, badge: devices ? devices.length : undefined },
        { id: 'dm-avds', label: 'Installed AVDs', icon: <LuLayers />, badge: avds?.length },
        { id: 'dm-speed', label: 'Emulator speed', icon: <LuZap /> },
        { id: 'dm-ram', label: 'Memory (RAM saver)', icon: <LuMemoryStick /> },
        { id: 'dm-adb', label: 'Connected (ADB)', icon: <LuCable /> },
        { id: 'dm-wifi', label: 'Wi-Fi / QR pairing', icon: <LuWifi /> },
        { id: 'dm-sdk', label: 'System images', icon: <LuHardDriveDownload />, badge: runningJobs || undefined },
        { id: 'dm-storage', label: 'Storage', icon: <LuHardDrive /> },
      ]}
    >
      {tools && (!tools.adb.available || !tools.emulator.available) && (
        <Notice tone="warning" title="Android SDK tools not found">
          Install Android Studio (SDK platform-tools + emulator) or set ANDROID_SDK_ROOT in backend/.env. Device profiles still work; start/stop and health checks need ADB and the emulator.
        </Notice>
      )}

      <Card
        id="dm-profiles"
        icon={<LuListChecks />}
        title="Device profiles"
        subtitle={`${list.length} configured · ${enabled} enabled · runs ${cap?.configured_max ?? 1} at a time${cap ? ` · machine supports ${cap.recommended_concurrent}` : ''}`}
        actions={
          <>
            {devices?.length === 0 && (
              <Button size="xs" variant="outline" loading={busy === 'seed'} onClick={() => act('seed', () => api('/devices/seed', { method: 'POST', body: '{}' }), 'Loaded 12 default profiles')}>
                Load 12 default profiles
              </Button>
            )}
            {missingEnabled.length > 0 && tools?.sdkmanager && (
              <Button size="xs" variant="outline" disabled={!!busy} loading={busy === 'provision-all'} onClick={provisionAll} title="Download system images and create the AVDs for enabled profiles">
                <LuWrench /> Set up {missingEnabled.length} missing
              </Button>
            )}
            <Button size="xs" variant={showForm ? 'ghost' : 'solid'} onClick={() => setShowForm((s) => !s)}>
              {showForm ? 'Cancel' : (
                <>
                  <LuPlus /> Add profile
                </>
              )}
            </Button>
          </>
        }
      >
        <Collapsible.Root open={showForm}>
          <Collapsible.Content>
            <Box as="form" onSubmit={submit} borderWidth="1px" borderRadius="md" p="4" bg="bg.subtle" mb="2">
              <SimpleGrid columns={{ base: 1, sm: 2, lg: 4 }} gap="3">
                {field('name', 'Name', 'Pixel 6 API 33')}
                <Field.Root>
                  <Field.Label>Type</Field.Label>
                  <NativeSelect.Root size="sm">
                    <NativeSelect.Field value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                      <option value="emulator">Emulator</option>
                      <option value="physical">Physical (USB)</option>
                      <option value="remote">Remote</option>
                    </NativeSelect.Field>
                    <NativeSelect.Indicator />
                  </NativeSelect.Root>
                </Field.Root>
                {form.type === 'emulator' ? (
                  <Field.Root>
                    <Field.Label>AVD name</Field.Label>
                    <Input size="sm" list="avd-list" value={form.avd_name} onChange={(e) => setForm({ ...form, avd_name: e.target.value })} placeholder="PT_Pixel_6" />
                    <datalist id="avd-list">{(avds ?? []).map((a) => <option key={a} value={a} />)}</datalist>
                  </Field.Root>
                ) : (
                  field('adb_serial', 'ADB serial', 'R58M123ABC')
                )}
                {field('api_level', 'API level', '33', 'number')}
                {field('android_version', 'Android', '13')}
                {field('resolution', 'Resolution', '1080x2400')}
                {field('ram_mb', 'Guest RAM (MB)', '2048', 'number')}
                <Flex align="flex-end">
                  <Button type="submit" size="sm" w="100%" loading={busy === 'create'}>
                    Save profile
                  </Button>
                </Flex>
              </SimpleGrid>
            </Box>
          </Collapsible.Content>
        </Collapsible.Root>

        {devices === null ? (
          <Loading rows={5} height="9" />
        ) : list.length === 0 ? (
          <Empty icon={<LuListChecks />} title="No device profiles yet">
            Load the 12 defaults or add your own.
          </Empty>
        ) : (
          <Box overflowX="auto">
            <Table.Root size="sm" interactive>
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader w="8">#</Table.ColumnHeader>
                  <Table.ColumnHeader w="10" aria-label="Enabled" />
                  <Table.ColumnHeader>Profile</Table.ColumnHeader>
                  <Table.ColumnHeader>Android</Table.ColumnHeader>
                  <Table.ColumnHeader>Resolution</Table.ColumnHeader>
                  <Table.ColumnHeader textAlign="end">RAM</Table.ColumnHeader>
                  <Table.ColumnHeader>Status</Table.ColumnHeader>
                  <Table.ColumnHeader>Serial</Table.ColumnHeader>
                  <Table.ColumnHeader aria-label="Actions" />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {list.map((d) => {
                  const running = !!d.running;
                  const missing = avdMissing(d);
                  const job = activeJob(d);
                  return (
                    <Table.Row key={d.id} opacity={d.enabled ? 1 : 0.55}>
                      <Table.Cell className="num" color="fg.muted">
                        {d.priority}
                      </Table.Cell>
                      <Table.Cell>
                        <Checkbox.Root size="sm" checked={d.enabled} onCheckedChange={() => void toggle(d)} aria-label={`Enable ${d.name}`}>
                          <Checkbox.HiddenInput />
                          <Checkbox.Control />
                        </Checkbox.Root>
                      </Table.Cell>
                      <Table.Cell minW="180px">
                        <Text fontWeight="medium">{d.name}</Text>
                        <Text fontSize="xs" color="fg.muted">
                          {d.type}
                          {d.avd_name && ` · ${d.avd_name}`}
                          {missing && !job && (
                            <Text as="span" color="fg.warning">
                              {' '}
                              · AVD not installed
                            </Text>
                          )}
                        </Text>
                        {job && (
                          <Text fontSize="xs" color="colorPalette.fg">
                            Setting up{job.progress !== null ? ` ${Math.floor(job.progress)}%` : '…'} · {job.step}
                          </Text>
                        )}
                      </Table.Cell>
                      <Table.Cell whiteSpace="nowrap">
                        {d.android_version ?? '—'}{' '}
                        {d.api_level && (
                          <Text as="span" color="fg.muted">
                            (API {d.api_level})
                          </Text>
                        )}
                      </Table.Cell>
                      <Table.Cell>{d.resolution ?? '—'}</Table.Cell>
                      <Table.Cell textAlign="end" whiteSpace="nowrap">{`${d.ram_mb ?? 2048} MB`}</Table.Cell>
                      <Table.Cell>
                        <Badge tone={STATUS[d.status] ?? 'neutral'}>{bootOf(d.id) ? 'booting' : d.status}</Badge>
                        {bootOf(d.id) && <BootBar boot={bootOf(d.id)!} />}
                        {d.last_error && (
                          <Text fontSize="xs" color="fg.error" title={d.last_error} maxW="220px" truncate>
                            {d.last_error}
                          </Text>
                        )}
                      </Table.Cell>
                      <Table.Cell fontFamily="mono" fontSize="xs">
                        {d.running?.serial ?? d.adb_serial ?? '—'}
                      </Table.Cell>
                      <Table.Cell>
                        <HStack gap="1.5" justify="flex-end">
                          {missing && tools?.sdkmanager && (
                            <Button
                              size="2xs"
                              disabled={!!busy || !!job || !d.api_level}
                              loading={!!job || busy === `v-${d.id}`}
                              loadingText="Setting up"
                              title={d.api_level ? 'Download the system image and create this AVD' : 'Set an API level on the profile first'}
                              onClick={() => provision(d)}
                            >
                              <LuWrench /> Set up
                            </Button>
                          )}
                          {d.type === 'emulator' &&
                            !missing &&
                            (running ? (
                              <Button size="2xs" variant="outline" disabled={!!busy} loading={busy === `s-${d.id}`} onClick={() => act(`s-${d.id}`, () => api(`/devices/${d.id}/stop`, { method: 'POST', body: '{}' }))}>
                                <LuSquare /> Stop
                              </Button>
                            ) : (
                              <Button
                                size="2xs"
                                disabled={!!busy || !d.avd_name}
                                loading={busy === `s-${d.id}`}
                                title={cap && !cap.can_start_now ? 'Limit reached or not enough free RAM' : 'Boot emulator'}
                                onClick={() =>
                                  act(`s-${d.id}`, async () => {
                                    if (await startEmulatorProfile(d.id)) notify('ok', `Booting ${d.name}… progress is shown in the Status column.`);
                                  })
                                }
                              >
                                <LuPlay /> Start
                              </Button>
                            ))}
                          <Button size="2xs" variant="ghost" disabled={!!busy} loading={busy === `h-${d.id}`} onClick={() => act(`h-${d.id}`, () => api(`/devices/${d.id}/health`, { method: 'POST', body: '{}' }), `Checked ${d.name}`)}>
                            <LuStethoscope /> Check
                          </Button>
                          <IconButton
                            size="2xs"
                            variant="ghost"
                            colorPalette="red"
                            disabled={!!busy}
                            onClick={() => confirm(`Delete profile "${d.name}"?`) && act(`d-${d.id}`, () => api(`/devices/${d.id}`, { method: 'DELETE' }))}
                            aria-label={`Delete ${d.name}`}
                          >
                            <LuTrash2 />
                          </IconButton>
                        </HStack>
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Root>
          </Box>
        )}
      </Card>

      <Card
        id="dm-avds"
        icon={<LuLayers />}
        title="Installed AVDs"
        subtitle={storage ? `${fmtBytes(storage.total_avd_bytes)} on disk · ${storage.effective_dir}` : tools?.sdk_root ? tools.sdk_root : 'Android SDK not detected'}
        actions={
          tools?.avdmanager ? (
            <Button size="xs" onClick={() => setCreating(true)}>
              <LuPlus /> New AVD
            </Button>
          ) : undefined
        }
      >
        {avds === null ? (
          <Loading rows={2} height="8" />
        ) : !avds.length ? (
          <Text color="fg.muted" fontSize="sm">
            No AVDs yet. Press “Set up” on a profile above, or create one under System images.
          </Text>
        ) : (
          <Stack gap="1.5">
            {avds.map((a) => {
              const isRunning = list.some((d) => d.avd_name === a && d.running);
              const loc = storage?.avds.find((x) => x.name === a);
              const img = loc?.image?.split(';');
              return (
                <Flex key={a} justify="space-between" align="center" gap="3" borderWidth="1px" borderRadius="md" px="3" py="2" wrap="wrap">
                  <Box minW="0">
                    <HStack gap="2" minW="0">
                      <Text fontFamily="mono" fontSize="sm" truncate>
                        {a}
                      </Text>
                      {isRunning && <Badge tone="good">running</Badge>}
                    </HStack>
                    {loc && (
                      <Text fontSize="xs" color="fg.muted">
                        {fmtBytes(loc.size_bytes)} on disk
                        {loc.snapshot_bytes > 0 && ` (fast-boot snapshot ${fmtBytes(loc.snapshot_bytes)})`}
                        {img && ` · ${img[1]} ${img[2].replace(/_/g, ' ')}`}
                        {loc.ram_mb && ` · RAM ${loc.ram_mb >= 1024 ? `${loc.ram_mb / 1024} GB` : `${loc.ram_mb} MB`}`}
                        {partition(loc.data_partition) && ` · storage ${partition(loc.data_partition)}`}
                      </Text>
                    )}
                  </Box>
                  <HStack gap="2">
                    {loc && loc.wipeable_bytes > 64 * 1024 ** 2 && (
                      <Button
                        size="2xs"
                        variant="ghost"
                        disabled={!!busy || isRunning}
                        loading={busy === `wipe-${a}`}
                        title={isRunning ? 'Stop the emulator first' : 'Reset to factory state: frees user data, cache and the fast-boot snapshot. The next start is a first boot (~1 min).'}
                        onClick={() =>
                          confirm(
                            `Wipe data of "${a}"? This frees ${fmtBytes(loc.wipeable_bytes)}: installed apps, their data and the fast-boot snapshot are deleted. The AVD stays and its next start is a fresh first boot (~1 min).`,
                          ) &&
                          act(`wipe-${a}`, async () => {
                            const r = await api<{ freed_bytes: number }>(`/sdk/avds/${encodeURIComponent(a)}/wipe`, { method: 'POST', body: '{}' });
                            notify('ok', `Wiped ${a} — freed ${fmtBytes(r.freed_bytes)}`);
                            void qc.invalidateQueries({ queryKey: qk.sdkStorage });
                          })
                        }
                      >
                        <LuEraser /> Wipe data ({fmtBytes(loc.wipeable_bytes)})
                      </Button>
                    )}
                    {knownAvds.has(a) ? (
                      <Badge tone="neutral">profile exists</Badge>
                    ) : (
                      <Button
                        size="2xs"
                        variant="outline"
                        disabled={!!busy}
                        loading={busy === `a-${a}`}
                        onClick={() => act(`a-${a}`, () => api('/devices', { method: 'POST', body: JSON.stringify({ name: a.replace(/_/g, ' '), type: 'emulator', avd_name: a }) }), `Profile for ${a} added`)}
                      >
                        <LuPlus /> Create profile
                      </Button>
                    )}
                    <IconButton
                      size="2xs"
                      variant="ghost"
                      colorPalette="red"
                      disabled={!!busy || isRunning}
                      title={isRunning ? 'Stop the emulator first' : 'Delete this AVD and its data'}
                      aria-label={`Delete AVD ${a}`}
                      onClick={() =>
                        confirm(`Delete AVD "${a}" and all its data${loc ? ` (${fmtBytes(loc.size_bytes)})` : ''}? The system image stays installed.`) &&
                        act(
                          `del-${a}`,
                          async () => {
                            await api(`/sdk/avds/${encodeURIComponent(a)}`, { method: 'DELETE' });
                            void qc.invalidateQueries({ queryKey: qk.sdkStorage });
                            void qc.invalidateQueries({ queryKey: qk.sdkInstalled });
                          },
                          `Deleted ${a}`,
                        )
                      }
                    >
                      <LuTrash2 />
                    </IconButton>
                  </HStack>
                </Flex>
              );
            })}
          </Stack>
        )}
      </Card>

      <SpeedCard id="dm-speed" />
      <RamCard id="dm-ram" />
      <AdbPanel id="dm-adb" wifiId="dm-wifi" tools={tools} onProfilesChanged={() => void load()} />
      <SdkPanel id="dm-sdk" tools={tools} jobs={jobs.filter((j) => j.kind !== 'move_avds' && j.kind !== 'move_images')} onChanged={() => void load()} />
      {tools?.avdmanager ? (
        <StoragePanel id="dm-storage" jobs={jobs} onChanged={() => void load()} />
      ) : (
        <Card id="dm-storage" icon={<LuHardDrive />} title="Storage">
          <Text fontSize="sm" color="fg.muted">
            Needs the Android SDK Command-line Tools.
          </Text>
        </Card>
      )}
      <CreateAvdDialog open={creating} onClose={() => setCreating(false)} />
    </SectionLayout>
  );
}
