import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '../../lib/queries';
import { Box, Button, Checkbox, Code, Field, Flex, Grid, HStack, Input, Stack, Table, Text } from '@chakra-ui/react';
import { LuFolderCog, LuHardDrive } from 'react-icons/lu';
import { api, fmtBytes, type SdkJob, type StorageInfo } from '../../lib/api';
import { Badge, Card, Loading, SubHeading } from '../../components/ui';
import { notify } from '../../components/toaster';
import { JobList } from './SdkPanel';

function FolderForm({
  label,
  placeholder,
  initial,
  busy,
  onSave,
  onCancel,
  children,
}: {
  label: string;
  placeholder: string;
  initial: string;
  busy: boolean;
  onSave: (dir: string) => void;
  onCancel: () => void;
  children?: React.ReactNode;
}) {
  const [dir, setDir] = useState(initial);
  return (
    <Box
      as="form"
      borderWidth="1px"
      borderRadius="md"
      p="3"
      bg="bg.subtle"
      onSubmit={(e: React.FormEvent) => {
        e.preventDefault();
        onSave(dir.trim());
      }}
    >
      <Stack gap="3">
        <Field.Root>
          <Field.Label>{label}</Field.Label>
          <Input size="sm" value={dir} onChange={(e) => setDir(e.target.value)} placeholder={placeholder} spellCheck={false} autoFocus fontFamily="mono" />
          <Field.HelperText>The folder is created if it doesn’t exist.</Field.HelperText>
        </Field.Root>
        {children}
        <HStack gap="2">
          <Button type="submit" size="sm" loading={busy} disabled={!dir.trim()}>
            Save
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </HStack>
      </Stack>
    </Box>
  );
}

function Location({ path, badge, free }: { path: string; badge: React.ReactNode; free: number | null }) {
  return (
    <Flex gap="2" align="center" wrap="wrap">
      <Code size="sm" wordBreak="break-all">
        {path}
      </Code>
      {badge}
      {free !== null && (
        <Text fontSize="xs" color="fg.muted">
          {free.toFixed(1)} GB free
        </Text>
      )}
    </Flex>
  );
}

/** Where emulator data (AVDs) and system images live — e.g. a bigger M: drive — and move existing ones there. */
export function StoragePanel({ jobs, onChanged, id }: { jobs: SdkJob[]; onChanged: () => void; id?: string }) {
  const qc = useQueryClient();
  const storageQ = useQuery({ queryKey: qk.sdkStorage, queryFn: () => api<StorageInfo>('/sdk/storage') });
  const info = storageQ.data ?? null;
  const setInfo = (v: StorageInfo) => qc.setQueryData(qk.sdkStorage, v);
  const [editing, setEditing] = useState<'avd' | 'images' | null>(null);
  const [move, setMove] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (storageQ.error) notify('error', storageQ.error.message);
  }, [storageQ.error]);
  // Finished move jobs refresh this through useLiveCacheSync.
  const moveJobs = jobs.filter((j) => j.kind === 'move_avds' || j.kind === 'move_images');

  const saveAvd = async (target: string | null) => {
    setBusy(true);
    try {
      const r = await api<{ storage: StorageInfo; job: SdkJob | null }>('/sdk/storage', { method: 'PUT', body: JSON.stringify({ avd_storage_dir: target, move_existing: move }) });
      setInfo(r.storage);
      setEditing(null);
      notify('ok', `New AVDs will be stored in ${r.storage.effective_dir}.${r.job ? ' Moving existing AVDs in the background.' : ''}`);
      onChanged();
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setBusy(false);
    }
  };

  const saveImages = async (target: string | null) => {
    if (target === null && !confirm('Move all system images back into the Android SDK folder?')) return;
    setBusy(true);
    try {
      const r = await api<{ storage: StorageInfo; job: SdkJob | null }>('/sdk/storage/images', { method: 'PUT', body: JSON.stringify({ dir: target }) });
      setInfo(r.storage);
      setEditing(null);
      notify('ok', target ? `System images will be kept in ${target}.${r.job ? ' Moving installed images in the background.' : ''}` : 'Moving system images back into the SDK.');
      onChanged();
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!info)
    return (
      <Card id={id} icon={<LuHardDrive />} title="Storage">
        <Loading rows={4} />
      </Card>
    );

  const toMove = info.avds.filter((a) => a.exists && !a.in_storage_dir);
  const toMoveBytes = toMove.reduce((s, a) => s + a.size_bytes, 0);
  const anyInUse = info.avds.some((a) => a.in_use);
  const img = info.images;

  return (
    <Card id={id} icon={<LuHardDrive />} title="Storage" subtitle="Keep emulator data and system images on a bigger drive (e.g. M:)">
      <JobList jobs={moveJobs} />

      <Grid templateColumns={{ base: '1fr', xl: '1fr 1fr' }} gap="6" alignItems="start">
        <Stack gap="3">
          <SubHeading
            actions={
              editing !== 'avd' && (
                <Button size="xs" variant="outline" onClick={() => setEditing('avd')}>
                  <LuFolderCog /> Change folder
                </Button>
              )
            }
          >
            Emulator data (AVDs)
          </SubHeading>
          <Location path={info.effective_dir} badge={info.avd_storage_dir ? <Badge tone="good">custom</Badge> : <Badge tone="neutral">default</Badge>} free={info.effective_free_gb} />
          <Text fontSize="xs" color="fg.muted">
            {info.avds.length} AVD{info.avds.length === 1 ? '' : 's'} · {fmtBytes(info.total_avd_bytes)}. Each AVD grows to 2–8 GB. Android Studio keeps seeing them (pointer files stay in{' '}
            {info.avd_home}).
          </Text>
          {editing === 'avd' && (
            <FolderForm label="Folder for AVDs" placeholder="M:\Android\avd" initial={info.avd_storage_dir ?? ''} busy={busy} onSave={(d) => void saveAvd(d || null)} onCancel={() => setEditing(null)}>
              <Checkbox.Root size="sm" checked={move} onCheckedChange={(e) => setMove(!!e.checked)}>
                <Checkbox.HiddenInput />
                <Checkbox.Control />
                <Checkbox.Label>
                  Move existing AVDs there too{toMove.length > 0 && ` (${toMove.length}, ${fmtBytes(toMoveBytes)})`}
                  {anyInUse && (
                    <Text as="span" color="fg.warning">
                      {' '}
                      — running emulators are skipped
                    </Text>
                  )}
                </Checkbox.Label>
              </Checkbox.Root>
              {info.avd_storage_dir && (
                <Button size="xs" variant="ghost" alignSelf="flex-start" disabled={busy} onClick={() => void saveAvd(null)}>
                  Use default ({info.avd_home})
                </Button>
              )}
            </FolderForm>
          )}
        </Stack>

        <Stack gap="3">
          <SubHeading
            actions={
              img &&
              editing !== 'images' && (
                <HStack gap="2">
                  {img.dir && (
                    <Button size="xs" variant="ghost" disabled={busy} onClick={() => void saveImages(null)}>
                      Move back to SDK
                    </Button>
                  )}
                  <Button size="xs" variant="outline" onClick={() => setEditing('images')}>
                    <LuFolderCog /> {img.dir ? 'Change folder' : 'Use another drive'}
                  </Button>
                </HStack>
              )
            }
          >
            System images
          </SubHeading>
          {!img ? (
            <Text fontSize="sm" color="fg.muted">
              Android SDK not found.
            </Text>
          ) : (
            <>
              <Location path={img.dir ?? img.sdk_path} badge={img.dir ? <Badge tone="good">custom</Badge> : <Badge tone="neutral">inside SDK</Badge>} free={img.free_gb} />
              <Text fontSize="xs" color="fg.muted">
                {img.images.length} image{img.images.length === 1 ? '' : 's'}
                {img.elsewhere_bytes > 0 && ` · ${fmtBytes(img.elsewhere_bytes)} on the custom drive`}
                {img.in_sdk_bytes > 0 && ` · ${fmtBytes(img.in_sdk_bytes)} inside the SDK (${info.sdk_free_gb?.toFixed(1) ?? '?'} GB free there)`}
              </Text>
              <Text fontSize="xs" color="fg.muted">
                Each image is moved to this folder and linked back into the SDK, so sdkmanager, the emulator and Android Studio keep working. New downloads land in the SDK first
                (sdkmanager unpacks there — keep ~4 GB free) and are moved automatically.
              </Text>
              {img.dir && img.in_sdk_bytes > 0 && (
                <Button size="xs" variant="outline" alignSelf="flex-start" loading={busy} onClick={() => void saveImages(img.dir)}>
                  Move the remaining {fmtBytes(img.in_sdk_bytes)} now
                </Button>
              )}
              {editing === 'images' && (
                <FolderForm
                  label="Folder for system images"
                  placeholder="M:\Android\system-images"
                  initial={img.dir ?? ''}
                  busy={busy}
                  onSave={(d) => void saveImages(d || null)}
                  onCancel={() => setEditing(null)}
                >
                  <Text fontSize="xs" color="fg.muted">
                    Installed images ({fmtBytes(img.in_sdk_bytes + img.elsewhere_bytes)}) are moved now. Stop running emulators first.
                  </Text>
                </FolderForm>
              )}
            </>
          )}
        </Stack>
      </Grid>

      {info.avds.length > 0 && (
        <Box overflowX="auto" borderWidth="1px" borderRadius="md">
          <Table.Root size="sm">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>AVD</Table.ColumnHeader>
                <Table.ColumnHeader>Data folder</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end">Size</Table.ColumnHeader>
                <Table.ColumnHeader aria-label="State" />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {info.avds.map((a) => (
                <Table.Row key={a.name}>
                  <Table.Cell fontFamily="mono" fontSize="xs">
                    {a.name}
                  </Table.Cell>
                  <Table.Cell fontFamily="mono" fontSize="xs" title={a.data_path} wordBreak="break-all">
                    {a.data_path}
                  </Table.Cell>
                  <Table.Cell textAlign="end" whiteSpace="nowrap">
                    {a.exists ? fmtBytes(a.size_bytes) : '—'}
                  </Table.Cell>
                  <Table.Cell textAlign="end">{!a.exists ? <Badge tone="critical">folder missing</Badge> : a.in_use ? <Badge tone="warning">in use</Badge> : null}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Box>
      )}
    </Card>
  );
}
