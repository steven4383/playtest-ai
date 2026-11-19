import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Box, Button, Checkbox, Collapsible, Field, Flex, HStack, IconButton, Input, NativeSelect, SimpleGrid, Stack, Table, Text } from '@chakra-ui/react';
import { LuCable, LuHardDrive, LuHardDriveDownload, LuLayers, LuListChecks, LuPlay, LuPlus, LuSquare, LuStethoscope, LuTrash2, LuWifi, LuWrench, LuZap } from 'react-icons/lu';
import { api, type Device, type SdkJob, type ToolStatus } from '../lib/api';
import type { Live } from '../lib/useLive';
import { qk, useAvds, useProfiles, useSdkJobs, useTools } from '../lib/queries';
import { Badge, Card, Empty, Loading, Notice, type Tone } from '../components/ui';
import { SectionLayout } from '../components/SectionNav';
import { notify } from '../components/toaster';
import { AdbPanel } from './devices/AdbPanel';
import { SdkPanel } from './devices/SdkPanel';
import { StoragePanel } from './devices/StoragePanel';
import { SpeedCard } from './devices/SpeedCard';

const STATUS: Record<string, Tone> = { online: 'good', starting: 'warning', offline: 'neutral', error: 'critical' };

const emptyForm = { name: '', type: 'emulator', avd_name: '', adb_serial: '', api_level: '', android_version: '', resolution: '', ram_mb: '' };

export function DevicesPage({ live }: { live: Live }) {
  const qc = useQueryClient();
  const profilesQ = useProfiles();
  const devices = profilesQ.isError ? (profilesQ.data ?? []) : (profilesQ.data ?? null);
  const tools = useTools().data ?? null;
  const avds = useAvds().data ?? null;
  const jobs = useSdkJobs().data ?? [];
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
                        <Badge tone={STATUS[d.status] ?? 'neutral'}>{d.status}</Badge>
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
                                onClick={() => act(`s-${d.id}`, () => api(`/devices/${d.id}/start`, { method: 'POST', body: '{}' }), `Booting ${d.name}…`)}
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

      <Card id="dm-avds" icon={<LuLayers />} title="Installed AVDs" subtitle={tools?.sdk_root ? tools.sdk_root : 'Android SDK not detected'}>
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
              return (
                <Flex key={a} justify="space-between" align="center" gap="3" borderWidth="1px" borderRadius="md" px="3" py="2" wrap="wrap">
                  <HStack gap="2" minW="0">
                    <Text fontFamily="mono" fontSize="sm" truncate>
                      {a}
                    </Text>
                    {isRunning && <Badge tone="good">running</Badge>}
                  </HStack>
                  <HStack gap="2">
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
                        confirm(`Delete AVD "${a}" and all its data? The system image stays installed.`) && act(`del-${a}`, () => api(`/sdk/avds/${encodeURIComponent(a)}`, { method: 'DELETE' }), `Deleted ${a}`)
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
    </SectionLayout>
  );
}
