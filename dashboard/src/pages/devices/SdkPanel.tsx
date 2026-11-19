import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Box,
  Button,
  Checkbox,
  Code,
  Collapsible,
  Field,
  Flex,
  Grid,
  HStack,
  Input,
  Link,
  NativeSelect,
  Progress,
  Stack,
  Table,
  Text,
} from '@chakra-ui/react';
import { LuDownload, LuHardDriveDownload, LuLink2, LuRefreshCw } from 'react-icons/lu';
import { api, fmtBytes, type SdkJob, type SystemImage, type ToolStatus } from '../../lib/api';
import { qk, useSdkCatalog, useSdkDefinitions, useSdkInstalled } from '../../lib/queries';
import { Badge, Card, Empty, Loading, Notice, SubHeading, type Tone } from '../../components/ui';
import { notify } from '../../components/toaster';

const JOB_TONE: Record<SdkJob['status'], Tone> = { queued: 'neutral', running: 'warning', done: 'good', error: 'critical' };
const PREFERRED_HW = ['pixel_8', 'pixel_7', 'pixel_6', 'medium_phone', 'pixel_5'];

export function JobList({ jobs }: { jobs: SdkJob[] }) {
  if (!jobs.length) return null;
  return (
    <Stack gap="2" aria-label="SDK jobs">
      {jobs.slice(0, 5).map((j) => (
        <Box key={j.id} borderWidth="1px" borderRadius="md" p="3" bg="bg.subtle">
          <Flex justify="space-between" gap="2" align="center">
            <Text fontWeight="medium" fontSize="sm" truncate>
              {j.title}
            </Text>
            <Badge tone={JOB_TONE[j.status]}>{j.status}</Badge>
          </Flex>
          {(j.status === 'running' || j.status === 'queued') && (
            <Stack gap="1" mt="2">
              <Progress.Root value={j.progress === null ? null : j.progress} size="xs" colorPalette="green" aria-label={j.title}>
                <Progress.Track>
                  <Progress.Range />
                </Progress.Track>
              </Progress.Root>
              <Text fontSize="xs" color="fg.muted" truncate>
                {j.progress !== null && `${Math.floor(j.progress)}% · `}
                {j.step}
              </Text>
            </Stack>
          )}
          {j.status === 'error' && (
            <Text fontSize="xs" color="fg.error" mt="1">
              {j.message}
            </Text>
          )}
          {j.status === 'error' && j.log.length > 0 && (
            <Collapsible.Root>
              <Collapsible.Trigger asChild>
                <Button size="2xs" variant="ghost" mt="1">
                  Show log
                </Button>
              </Collapsible.Trigger>
              <Collapsible.Content>
                <Box as="pre" fontSize="xs" fontFamily="mono" whiteSpace="pre-wrap" maxH="40" overflowY="auto" mt="1">
                  {j.log.join('\n')}
                </Box>
              </Collapsible.Content>
            </Collapsible.Root>
          )}
        </Box>
      ))}
    </Stack>
  );
}

function Select({ value, onChange, children, disabled }: { value: string; onChange: (v: string) => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <NativeSelect.Root size="sm" disabled={disabled}>
      <NativeSelect.Field value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </NativeSelect.Field>
      <NativeSelect.Indicator />
    </NativeSelect.Root>
  );
}

/** Download system images (sdkmanager) and create AVDs (avdmanager) without opening Android Studio. */
export function SdkPanel({ tools, jobs, onChanged, id }: { tools: ToolStatus | null; jobs: SdkJob[]; onChanged: () => void; id?: string }) {
  const qc = useQueryClient();
  const ready = !!tools?.sdkmanager && !!tools?.avdmanager;
  const installedQ = useSdkInstalled(ready);
  const installed = installedQ.data?.images ?? null;
  const links = installedQ.data?.links ?? {};
  const definitions = useSdkDefinitions(ready).data ?? [];
  const catalogQ = useSdkCatalog();
  const catalog = catalogQ.data ?? null;
  const catalogLoading = catalogQ.isFetching;
  const [showAll, setShowAll] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', package: '', device: '', create_profile: true });

  useEffect(() => {
    if (installedQ.error) notify('error', installedQ.error.message);
  }, [installedQ.error]);
  // Sensible defaults once the lists are known.
  useEffect(() => {
    if (installed?.[0]) setForm((f) => (f.package ? f : { ...f, package: installed[0].package }));
  }, [installed]);
  useEffect(() => {
    if (definitions.length) setForm((f) => (f.device ? f : { ...f, device: PREFERRED_HW.find((h) => definitions.includes(h)) ?? definitions[0] ?? '' }));
  }, [definitions]);

  const installedSet = useMemo(() => new Set((installed ?? []).map((i) => i.package)), [installed]);
  const pendingSet = useMemo(() => new Set(jobs.filter((j) => j.status === 'running' || j.status === 'queued').map((j) => j.title.replace(/^Download /, ''))), [jobs]);

  /** First click loads the catalog (then it stays cached); "Refresh" asks sdkmanager again. */
  const browse = async (refresh = false) => {
    try {
      if (refresh) await qc.fetchQuery({ queryKey: qk.sdkCatalog, staleTime: 0, queryFn: () => api<{ images: SystemImage[] }>('/sdk/images?refresh=true').then((r) => r.images) });
      else await catalogQ.refetch({ throwOnError: true });
    } catch (e: any) {
      notify('error', e.message);
    }
  };

  const visibleCatalog = useMemo(() => {
    if (!catalog) return [];
    return catalog.filter(
      (i) => i.host_compatible && (showAll || ((i.api_level ?? 0) >= 24 && ['google_apis', 'google_apis_playstore', 'default'].includes(i.tag) && !/ps16k|16k|-ext\d+/i.test(i.api_id + i.tag))),
    );
  }, [catalog, showAll]);

  const install = async (pkg: string) => {
    if (!accepted) return notify('warning', 'Tick “I accept the Android SDK License” first.');
    setBusy(pkg);
    try {
      await api('/sdk/images/install', { method: 'POST', body: JSON.stringify({ package: pkg, accept_licenses: true }) });
      notify('info', `Downloading ${pkg} — progress is shown above the lists.`);
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setBusy(null);
    }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('create');
    try {
      await api('/sdk/avds', { method: 'POST', body: JSON.stringify(form) });
      setForm((f) => ({ ...f, name: '' }));
      notify('info', `Creating ${form.name}…`);
      onChanged();
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setBusy(null);
    }
  };

  const suggestName = () => {
    const img = installed?.find((i) => i.package === form.package);
    if (!img || !form.device) return '';
    const hw = form.device.replace(/[^\w]+/g, '_').replace(/^_|_$/g, '');
    return `PT_${hw.charAt(0).toUpperCase()}${hw.slice(1)}_API_${img.api_level ?? img.api_id.replace('android-', '')}`;
  };

  if (!ready) {
    return (
      <Card id={id} icon={<LuHardDriveDownload />} title="System images & emulators" subtitle="sdkmanager / avdmanager">
        <Notice tone="warning" title="Android SDK Command-line Tools not found">
          In Android Studio open Settings → Languages & Frameworks → Android SDK → SDK Tools, tick “Android SDK Command-line Tools (latest)” and apply. Then reload this page.
        </Notice>
      </Card>
    );
  }

  const totalCatalogDownload = (pkg: string) => catalog?.find((c) => c.package === pkg)?.download_bytes;

  return (
    <Card
      id={id}
      icon={<LuHardDriveDownload />}
      title="System images & emulators"
      subtitle={
        <>
          Host ABI <Code size="sm">{tools?.host_abi}</Code> · Java {tools?.java_home ? <Code size="sm">{tools.java_home}</Code> : <Text as="span" color="fg.error">not found — install Android Studio</Text>}
        </>
      }
    >
      <JobList jobs={jobs} />

      <Grid templateColumns={{ base: '1fr', xl: '1fr 1.3fr' }} gap="6" alignItems="start">
        <Stack gap="5">
          <Stack gap="3">
            <SubHeading>Create an emulator (AVD)</SubHeading>
            {installed === null ? (
              <Loading rows={3} height="8" />
            ) : installed.length === 0 ? (
              <Text fontSize="sm" color="fg.muted">
                No system image installed yet — download one first.
              </Text>
            ) : (
              <form onSubmit={create}>
                <Stack gap="3">
                  <Field.Root required>
                    <Field.Label>System image</Field.Label>
                    <Select value={form.package} onChange={(v) => setForm({ ...form, package: v })}>
                      {installed.map((i) => (
                        <option key={i.package} value={i.package} disabled={!i.host_compatible}>
                          Android {i.android_version ?? '?'} (API {i.api_level ?? i.api_id}) · {i.tag_label} · {i.abi}
                        </option>
                      ))}
                    </Select>
                  </Field.Root>
                  <Field.Root required>
                    <Field.Label>Hardware profile</Field.Label>
                    <Select value={form.device} onChange={(v) => setForm({ ...form, device: v })} disabled={!definitions.length}>
                      {definitions.length === 0 && <option value="">Loading…</option>}
                      {definitions.map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </Select>
                  </Field.Root>
                  <Field.Root required>
                    <Field.Label>AVD name</Field.Label>
                    <HStack w="100%">
                      <Input size="sm" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={suggestName() || 'PT_Pixel_8_API_35'} pattern="[\w.\-]+" required />
                      <Button size="sm" variant="outline" type="button" onClick={() => setForm({ ...form, name: suggestName() })} disabled={!suggestName()}>
                        Suggest
                      </Button>
                    </HStack>
                  </Field.Root>
                  <Checkbox.Root size="sm" checked={form.create_profile} onCheckedChange={(e) => setForm({ ...form, create_profile: !!e.checked })}>
                    <Checkbox.HiddenInput />
                    <Checkbox.Control />
                    <Checkbox.Label>Also add a device profile</Checkbox.Label>
                  </Checkbox.Root>
                  <Button type="submit" size="sm" alignSelf="flex-start" loading={busy === 'create'} disabled={!form.package || !form.device}>
                    Create AVD
                  </Button>
                </Stack>
              </form>
            )}
          </Stack>

          <Stack gap="2">
            <SubHeading>Installed system images</SubHeading>
            {installed === null ? (
              <Loading rows={2} />
            ) : installed.length === 0 ? (
              <Text fontSize="sm" color="fg.muted">
                None.
              </Text>
            ) : (
              <Stack gap="1.5">
                {installed.map((i) => (
                  <Flex key={i.package} justify="space-between" align="center" gap="3" borderWidth="1px" borderRadius="md" px="3" py="2" wrap="wrap">
                    <Box minW="0">
                      <Text fontSize="sm" fontWeight="medium">
                        Android {i.android_version ?? '?'}{' '}
                        <Text as="span" color="fg.muted" fontWeight="normal">
                          (API {i.api_level ?? i.api_id}) · {i.tag_label}
                        </Text>
                      </Text>
                      <Text fontSize="xs" color="fg.muted" fontFamily="mono">
                        {i.abi}
                      </Text>
                    </Box>
                    <HStack gap="2">
                      {links[i.package] && (
                        <Badge tone="good">
                          <LuLink2 /> other drive
                        </Badge>
                      )}
                      <Text fontSize="xs" className="num" color="fg.muted" title="Size on disk">
                        {i.disk_bytes ? fmtBytes(i.disk_bytes) : ''}
                      </Text>
                    </HStack>
                  </Flex>
                ))}
              </Stack>
            )}
          </Stack>
        </Stack>

        <Stack gap="3">
          <SubHeading
            actions={
              catalog && (
                <Button size="xs" variant="ghost" onClick={() => void browse(true)} loading={catalogLoading}>
                  <LuRefreshCw /> Refresh
                </Button>
              )
            }
          >
            Download a system image
          </SubHeading>
          <Text fontSize="xs" color="fg.muted">
            Download size is shown per image; unpacked it takes ~1.3× that on disk, and an AVD adds 2–8 GB. Google APIs images are best for testing; Google Play images include the Play
            Store but no root. Images go to the system images folder chosen under Storage.
          </Text>
          <Checkbox.Root size="sm" checked={accepted} onCheckedChange={(e) => setAccepted(!!e.checked)}>
            <Checkbox.HiddenInput />
            <Checkbox.Control />
            <Checkbox.Label>
              I accept the{' '}
              <Link href="https://developer.android.com/studio/terms" target="_blank" rel="noreferrer" color="colorPalette.fg">
                Android SDK License
              </Link>{' '}
              for images I download
            </Checkbox.Label>
          </Checkbox.Root>
          {catalog === null ? (
            catalogLoading ? (
              <Stack gap="2">
                <Text fontSize="xs" color="fg.muted">
                  Fetching Google’s repository… (up to ~40 s)
                </Text>
                <Loading rows={6} height="7" />
              </Stack>
            ) : (
              <Button size="sm" variant="outline" alignSelf="flex-start" onClick={() => void browse()}>
                <LuDownload /> Browse downloadable images
              </Button>
            )
          ) : (
            <>
              <Checkbox.Root size="sm" checked={showAll} onCheckedChange={(e) => setShowAll(!!e.checked)}>
                <Checkbox.HiddenInput />
                <Checkbox.Control />
                <Checkbox.Label>Show all ({catalog.filter((i) => i.host_compatible).length})</Checkbox.Label>
              </Checkbox.Root>
              {visibleCatalog.length === 0 ? (
                <Empty title="No images match" />
              ) : (
                <Box maxH="460px" overflowY="auto" borderWidth="1px" borderRadius="md">
                  <Table.Root size="sm" stickyHeader interactive>
                    <Table.Header>
                      <Table.Row>
                        <Table.ColumnHeader>Android</Table.ColumnHeader>
                        <Table.ColumnHeader>Image</Table.ColumnHeader>
                        <Table.ColumnHeader>ABI</Table.ColumnHeader>
                        <Table.ColumnHeader textAlign="end">Download</Table.ColumnHeader>
                        <Table.ColumnHeader aria-label="Actions" />
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {visibleCatalog.map((i) => {
                        const isInstalled = installedSet.has(i.package);
                        const pending = pendingSet.has(i.package);
                        const size = totalCatalogDownload(i.package);
                        return (
                          <Table.Row key={i.package} title={i.package}>
                            <Table.Cell whiteSpace="nowrap">
                              {i.android_version ?? i.api_id}{' '}
                              <Text as="span" color="fg.muted">
                                (API {i.api_level ?? '?'})
                              </Text>
                            </Table.Cell>
                            <Table.Cell>{i.tag_label}</Table.Cell>
                            <Table.Cell fontFamily="mono" fontSize="xs">
                              {i.abi}
                            </Table.Cell>
                            <Table.Cell textAlign="end" whiteSpace="nowrap" className="num">
                              {size ? fmtBytes(size) : <Text as="span" color="fg.subtle">—</Text>}
                            </Table.Cell>
                            <Table.Cell textAlign="end">
                              {isInstalled ? (
                                <Badge tone="good">installed</Badge>
                              ) : pending ? (
                                <Badge tone="warning">downloading</Badge>
                              ) : (
                                <Button size="2xs" variant="outline" disabled={!accepted} loading={busy === i.package} onClick={() => void install(i.package)}>
                                  <LuDownload /> Get
                                </Button>
                              )}
                            </Table.Cell>
                          </Table.Row>
                        );
                      })}
                    </Table.Body>
                  </Table.Root>
                </Box>
              )}
            </>
          )}
        </Stack>
      </Grid>
    </Card>
  );
}
