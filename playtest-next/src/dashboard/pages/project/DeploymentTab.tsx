'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Box,
  Button,
  Checkbox,
  CloseButton,
  Collapsible,
  Dialog,
  Field,
  Flex,
  HStack,
  Input,
  Link,
  List,
  NativeSelect,
  Portal,
  SegmentGroup,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Textarea,
} from '@chakra-ui/react';
import { LuExternalLink, LuHammer, LuKeyRound, LuRefreshCw, LuRocket, LuShieldCheck, LuUpload } from 'react-icons/lu';
import { api, fmtBytes } from '../../lib/api';
import { ago, pk, trackLabel, usePlayStatus, useReleases, type PlayConfig, type ProjectComponent, type Release, type ReleaseMode } from '../../lib/projects';
import { Badge, Card, Empty, Notice } from '../../components/ui';
import { notify } from '../../components/toaster';
import { MODE_LABEL, RELEASE_TONE, ReleaseView } from './ReleaseView';

type Bump = PlayConfig['bump'];
const TRACKS = ['internal', 'alpha', 'beta', 'production'];

/** Same rule as the server: bump the name, build number above both the current one and Play's highest. */
function preview(version: string | null, bump: Bump, playMax: number) {
  const m = (version ?? '').match(/^(\d+)\.(\d+)\.(\d+)(?:\+(\d+))?$/);
  if (!m) return null;
  let [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const build = m[4] ? Number(m[4]) : 0;
  if (bump === 'major') [a, b, c] = [a + 1, 0, 0];
  else if (bump === 'minor') [b, c] = [b + 1, 0];
  else if (bump === 'patch') c += 1;
  return `${a}.${b}.${c}+${Math.max(build + 1, playMax + 1)}`;
}

function Select({ value, onChange, children, label }: { value: string; onChange: (v: string) => void; children: React.ReactNode; label: string }) {
  return (
    <NativeSelect.Root size="sm">
      <NativeSelect.Field value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        {children}
      </NativeSelect.Field>
      <NativeSelect.Indicator />
    </NativeSelect.Root>
  );
}

// ---------------------------------------------------------------- Google Play setup

function PlaySetup({ comp, onChanged }: { comp: ProjectComponent; onChanged: () => void }) {
  const cfg = comp.play;
  const [form, setForm] = useState({
    package_name: cfg?.package_name ?? comp.package_name ?? '',
    default_track: cfg?.default_track ?? 'internal',
    release_status: cfg?.release_status ?? 'completed',
    user_fraction: cfg?.user_fraction ?? 0.1,
    bump: (cfg?.bump ?? 'patch') as Bump,
    require_clean: cfg ? !!cfg.require_clean : true,
    git_commit: cfg ? !!cfg.git_commit : true,
    git_tag: cfg ? !!cfg.git_tag : true,
    git_push: cfg ? !!cfg.git_push : false,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const status = usePlayStatus(comp.id, false);

  const save = async () => {
    setBusy('save');
    try {
      await api(`/components/${comp.id}/play`, { method: 'PUT', body: JSON.stringify(form) });
      notify('ok', 'Google Play settings saved');
      onChanged();
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setBusy(null);
    }
  };
  const uploadKey = async (f: File) => {
    setBusy('key');
    try {
      if (f.size > 20_000) throw new Error('That file is too big for a service-account key');
      await api(`/components/${comp.id}/play/service-account`, { method: 'POST', body: JSON.stringify({ json: await f.text() }) });
      notify('ok', 'Service-account key saved on this PC');
      onChanged();
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setBusy(null);
      if (file.current) file.current.value = '';
    }
  };
  const check = async () => {
    const r = await status.refetch();
    if (r.error) notify('error', r.error.message);
    else notify('ok', `Connected to Google Play — ${r.data?.tracks.length ?? 0} track(s)`);
  };

  return (
    <Stack gap="4">
      <SimpleGrid columns={{ base: 1, md: 2 }} gap="3">
        <Field.Root required>
          <Field.Label>Package name</Field.Label>
          <Input size="sm" value={form.package_name} onChange={(e) => setForm({ ...form, package_name: e.target.value })} fontFamily="mono" placeholder="com.company.app" />
        </Field.Root>
        <Field.Root>
          <Field.Label>Default track</Field.Label>
          <Select label="Default track" value={form.default_track} onChange={(v) => setForm({ ...form, default_track: v })}>
            {TRACKS.map((t) => (
              <option key={t} value={t}>
                {trackLabel(t)}
              </option>
            ))}
          </Select>
        </Field.Root>
        <Field.Root>
          <Field.Label>Release as</Field.Label>
          <Select label="Release status" value={form.release_status} onChange={(v) => setForm({ ...form, release_status: v as typeof form.release_status })}>
            <option value="completed">Rolled out to everyone on the track</option>
            <option value="inProgress">Staged rollout</option>
            <option value="draft">Draft (finish in Play Console)</option>
          </Select>
          {form.release_status === 'inProgress' && (
            <HStack mt="2" gap="2">
              <Text fontSize="xs">Rollout</Text>
              <Select label="Rollout percent" value={String(form.user_fraction)} onChange={(v) => setForm({ ...form, user_fraction: Number(v) })}>
                {[0.01, 0.05, 0.1, 0.2, 0.5].map((f) => (
                  <option key={f} value={f}>
                    {f * 100}%
                  </option>
                ))}
              </Select>
            </HStack>
          )}
        </Field.Root>
        <Field.Root>
          <Field.Label>Version bump</Field.Label>
          <Select label="Version bump" value={form.bump} onChange={(v) => setForm({ ...form, bump: v as Bump })}>
            <option value="patch">Patch — 1.2.3 → 1.2.4</option>
            <option value="minor">Minor — 1.2.3 → 1.3.0</option>
            <option value="major">Major — 1.2.3 → 2.0.0</option>
            <option value="build">Build number only</option>
          </Select>
          <Field.HelperText>The build number (+N) always goes up, above what Play already has.</Field.HelperText>
        </Field.Root>
      </SimpleGrid>
      <Flex gap="4" wrap="wrap">
        {(
          [
            ['require_clean', 'Only release committed code'],
            ['git_commit', 'Commit the version bump'],
            ['git_tag', 'Tag it (v1.2.4+5)'],
            ['git_push', 'Push to GitHub'],
          ] as const
        ).map(([k, label]) => (
          <Checkbox.Root key={k} size="sm" checked={form[k]} onCheckedChange={(e) => setForm({ ...form, [k]: !!e.checked })} disabled={k !== 'require_clean' && k !== 'git_commit' && !form.git_commit}>
            <Checkbox.HiddenInput />
            <Checkbox.Control />
            <Checkbox.Label>{label}</Checkbox.Label>
          </Checkbox.Root>
        ))}
      </Flex>
      <HStack gap="2" wrap="wrap">
        <Button size="sm" onClick={() => void save()} loading={busy === 'save'} disabled={!form.package_name}>
          Save settings
        </Button>
        <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => e.target.files?.[0] && void uploadKey(e.target.files[0])} />
        <Button size="sm" variant="outline" onClick={() => file.current?.click()} loading={busy === 'key'} disabled={!cfg} title={cfg ? undefined : 'Save the settings first'}>
          <LuKeyRound /> {cfg?.has_service_account ? 'Replace service-account key' : 'Add service-account key (JSON)'}
        </Button>
        {cfg?.has_service_account && (
          <Button size="sm" variant="ghost" onClick={() => void check()} loading={status.isFetching}>
            <LuShieldCheck /> Test connection
          </Button>
        )}
      </HStack>
      {cfg?.has_service_account ? (
        <Text fontSize="xs" color="fg.muted">
          Uses <Text as="span" fontFamily="mono">{cfg.service_account_email}</Text> — the key stays on this PC (storage/secrets) and is never shown again.
        </Text>
      ) : null}
      {status.data && (
        <SimpleGrid columns={{ base: 1, sm: 2, lg: 4 }} gap="2">
          {status.data.tracks.map((t) => (
            <Box key={t.track} borderWidth="1px" borderRadius="md" p="2.5">
              <Text fontSize="xs" color="fg.muted">
                {trackLabel(t.track)}
              </Text>
              {(t.releases ?? []).length === 0 ? (
                <Text fontSize="sm">empty</Text>
              ) : (
                (t.releases ?? []).map((r, i) => (
                  <Text key={i} fontSize="sm">
                    {r.name ?? r.versionCodes?.join(', ')}{' '}
                    <Text as="span" color="fg.muted" fontSize="xs">
                      {r.status}
                      {r.userFraction ? ` ${Math.round(r.userFraction * 100)}%` : ''}
                    </Text>
                  </Text>
                ))
              )}
            </Box>
          ))}
        </SimpleGrid>
      )}
      <Collapsible.Root>
        <Collapsible.Trigger asChild>
          <Button size="xs" variant="ghost" alignSelf="flex-start">
            How to get the service-account key (one time, ~10 min)
          </Button>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <List.Root as="ol" fontSize="sm" ps="5" gap="1.5" mt="1">
            <List.Item>
              In Google Cloud, pick (or create) a project and enable the{' '}
              <Link href="https://console.cloud.google.com/apis/library/androidpublisher.googleapis.com" target="_blank" rel="noreferrer" color="colorPalette.fg">
                Google Play Android Developer API <LuExternalLink />
              </Link>
              .
            </List.Item>
            <List.Item>
              <Link href="https://console.cloud.google.com/iam-admin/serviceaccounts" target="_blank" rel="noreferrer" color="colorPalette.fg">
                IAM → Service accounts <LuExternalLink />
              </Link>{' '}
              → Create service account (no roles needed) → Keys → Add key → JSON. Keep that file private.
            </List.Item>
            <List.Item>
              <Link href="https://play.google.com/console/developers" target="_blank" rel="noreferrer" color="colorPalette.fg">
                Play Console <LuExternalLink />
              </Link>{' '}
              → Users and permissions → Invite new users → the service account&apos;s email → App permissions: this app, with “Release to testing tracks” (and
              “Release to production” if you want that).
            </List.Item>
            <List.Item>Back here: Add service-account key → Test connection. (Google can take a few minutes to apply new permissions.)</List.Item>
            <List.Item>The app must exist in Play Console with one bundle uploaded by hand — Google does not allow the very first upload through the API.</List.Item>
          </List.Root>
        </Collapsible.Content>
      </Collapsible.Root>
    </Stack>
  );
}

// ---------------------------------------------------------------- release dialog

function ReleaseDialog({
  comp,
  mode,
  onClose,
  onStarted,
}: {
  comp: ProjectComponent;
  mode: ReleaseMode | null;
  onClose: () => void;
  onStarted: (id: string) => void;
}) {
  const cfg = comp.play;
  const status = usePlayStatus(comp.id, !!mode && mode !== 'build' && !!cfg?.has_service_account);
  const [track, setTrack] = useState(cfg?.default_track ?? 'internal');
  const [bump, setBump] = useState<Bump>(cfg?.bump ?? 'patch');
  const [rstatus, setRstatus] = useState(cfg?.release_status ?? 'completed');
  const [fraction, setFraction] = useState(cfg?.user_fraction ?? 0.1);
  const [notes, setNotes] = useState('');
  const [confirmProd, setConfirmProd] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (mode) {
      setTrack(cfg?.default_track ?? 'internal');
      setConfirmProd(false);
    }
  }, [mode, cfg?.default_track]);

  const tracks = useMemo(() => [...new Set([...TRACKS, ...(status.data?.tracks.map((t) => t.track) ?? [])])], [status.data]);
  const next = mode === 'build' ? comp.version : preview(comp.version, bump, status.data?.max_version_code ?? 0);
  const prod = mode === 'publish' && track === 'production';

  const start = async () => {
    setBusy(true);
    try {
      const r = await api<Release>(`/components/${comp.id}/releases`, {
        method: 'POST',
        body: JSON.stringify({
          mode,
          track,
          bump,
          release_status: rstatus,
          user_fraction: rstatus === 'inProgress' ? fraction : null,
          notes: notes.trim() || null,
          confirm_production: prod ? confirmProd : undefined,
        }),
      });
      onStarted(r.id);
      onClose();
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={!!mode} onOpenChange={(e) => !e.open && onClose()} placement="center" size="md">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title fontFamily="heading">
                {mode === 'publish' ? 'Release to Google Play' : mode === 'dry_run' ? 'Dry run (nothing is published)' : 'Build a signed App Bundle'}
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Stack gap="4">
                <Box borderWidth="1px" borderRadius="lg" p="3" bg="bg.subtle">
                  <Text fontSize="xs" color="fg.muted">
                    {comp.name}
                  </Text>
                  <Text fontFamily="heading" fontSize="xl" fontWeight="bold" className="num">
                    {comp.version ?? '?'} {mode !== 'build' && <>→ {next ?? '?'}</>}
                  </Text>
                  {mode !== 'build' && (
                    <Text fontSize="xs" color="fg.muted">
                      {status.isFetching ? 'Checking the highest version code on Play…' : status.data ? `Play's highest version code: ${status.data.max_version_code || 'none yet'}` : 'The build number is checked against Play when it starts.'}
                    </Text>
                  )}
                </Box>
                {mode !== 'build' && (
                  <SimpleGrid columns={{ base: 1, sm: 2 }} gap="3">
                    <Field.Root>
                      <Field.Label>Track</Field.Label>
                      <Select label="Track" value={track} onChange={setTrack}>
                        {tracks.map((t) => (
                          <option key={t} value={t}>
                            {trackLabel(t)}
                          </option>
                        ))}
                      </Select>
                    </Field.Root>
                    <Field.Root>
                      <Field.Label>Version bump</Field.Label>
                      <Select label="Version bump" value={bump} onChange={(v) => setBump(v as Bump)}>
                        <option value="patch">Patch</option>
                        <option value="minor">Minor</option>
                        <option value="major">Major</option>
                        <option value="build">Build number only</option>
                      </Select>
                    </Field.Root>
                    <Field.Root>
                      <Field.Label>Release as</Field.Label>
                      <Select label="Release status" value={rstatus} onChange={(v) => setRstatus(v as typeof rstatus)}>
                        <option value="completed">Everyone on the track</option>
                        <option value="inProgress">Staged rollout</option>
                        <option value="draft">Draft</option>
                      </Select>
                    </Field.Root>
                    {rstatus === 'inProgress' && (
                      <Field.Root>
                        <Field.Label>Rollout</Field.Label>
                        <Select label="Rollout percent" value={String(fraction)} onChange={(v) => setFraction(Number(v))}>
                          {[0.01, 0.05, 0.1, 0.2, 0.5].map((f) => (
                            <option key={f} value={f}>
                              {f * 100}% of users
                            </option>
                          ))}
                        </Select>
                      </Field.Root>
                    )}
                  </SimpleGrid>
                )}
                {mode !== 'build' && (
                  <Field.Root>
                    <Field.Label>What&apos;s new (release notes, en-US)</Field.Label>
                    <Textarea size="sm" rows={3} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Bug fixes and performance improvements." />
                    <Field.HelperText>{500 - notes.length} characters left</Field.HelperText>
                  </Field.Root>
                )}
                {prod && (
                  <Notice tone="warning" title="Production">
                    Real users get this version.
                    <Checkbox.Root size="sm" mt="2" checked={confirmProd} onCheckedChange={(e) => setConfirmProd(!!e.checked)}>
                      <Checkbox.HiddenInput />
                      <Checkbox.Control />
                      <Checkbox.Label>I tested this build and want to release it to production</Checkbox.Label>
                    </Checkbox.Root>
                  </Notice>
                )}
                <Text fontSize="xs" color="fg.muted">
                  {mode === 'publish'
                    ? `Steps: checks → pubspec.yaml version → flutter build appbundle → signing check → upload to ${trackLabel(track)} → ${cfg?.git_commit ? `commit${cfg.git_tag ? ' + tag' : ''}${cfg.git_push ? ' + push' : ''}` : 'no git'}. If something fails before the upload, pubspec.yaml is put back.`
                    : mode === 'dry_run'
                      ? 'Builds and uploads to a Play edit that Google validates and then throws away. pubspec.yaml is put back afterwards; no git changes.'
                      : 'Builds the App Bundle with the current version — no version change, no upload, no git.'}
                </Text>
              </Stack>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={() => void start()} loading={busy} disabled={prod && !confirmProd} colorPalette={mode === 'publish' ? 'purple' : undefined}>
                {mode === 'publish' ? <LuRocket /> : mode === 'dry_run' ? <LuShieldCheck /> : <LuHammer />} {mode ? MODE_LABEL[mode] : ''}
              </Button>
            </Dialog.Footer>
            <Dialog.CloseTrigger asChild>
              <CloseButton size="sm" />
            </Dialog.CloseTrigger>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------- one mobile app

function AppDeployment({ comp, onChanged }: { comp: ProjectComponent; onChanged: () => void }) {
  const qc = useQueryClient();
  const releases = useReleases(comp.id);
  const [mode, setMode] = useState<ReleaseMode | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const list = releases.data ?? [];
  const running = list.find((r) => r.status === 'running');
  const shown = viewing ?? running?.id ?? list[0]?.id ?? null;
  const ready = !!comp.play?.has_service_account;
  const isFlutter = comp.framework === 'flutter';

  return (
    <Stack gap="4">
      <Card
        icon={<LuRocket />}
        title={`Release ${comp.name}`}
        subtitle={`${comp.version ? `v${comp.version}` : 'no version'} · ${comp.play ? `${comp.play.package_name} → ${trackLabel(comp.play.default_track)}` : 'Google Play not set up yet'}`}
        actions={
          <HStack gap="2" wrap="wrap">
            <Button size="sm" variant="outline" onClick={() => setMode('build')} disabled={!isFlutter || !!running}>
              <LuHammer /> Build only
            </Button>
            <Button size="sm" variant="outline" onClick={() => setMode('dry_run')} disabled={!isFlutter || !ready || !!running} title={ready ? 'Everything except publishing' : 'Set up Google Play first'}>
              <LuShieldCheck /> Dry run
            </Button>
            <Button size="sm" colorPalette="purple" onClick={() => setMode('publish')} disabled={!isFlutter || !ready || !!running} title={ready ? undefined : 'Set up Google Play first'}>
              <LuUpload /> Release
            </Button>
          </HStack>
        }
      >
        {!isFlutter ? (
          <Notice tone="info">One-click releases are for Flutter apps for now ({comp.framework ?? 'unknown'} detected).</Notice>
        ) : shown ? (
          <ReleaseView key={shown} releaseId={shown} />
        ) : (
          <Empty icon={<LuRocket />} title="No release yet">
            {ready ? 'Start with a Dry run: it builds and checks everything with Google Play without publishing.' : 'Set up Google Play below, then try a Dry run.'}
          </Empty>
        )}
      </Card>

      {list.length > 0 && (
        <Card
          icon={<LuRefreshCw />}
          title="Release history"
          subtitle={`${list.length} release${list.length === 1 ? '' : 's'}`}
          actions={
            <Button size="xs" variant="ghost" onClick={() => void qc.invalidateQueries({ queryKey: pk.releases(comp.id) })}>
              <LuRefreshCw /> Refresh
            </Button>
          }
        >
          <Box overflowX="auto">
            <Table.Root size="sm" interactive>
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>Version</Table.ColumnHeader>
                  <Table.ColumnHeader>Kind</Table.ColumnHeader>
                  <Table.ColumnHeader>Track</Table.ColumnHeader>
                  <Table.ColumnHeader>Result</Table.ColumnHeader>
                  <Table.ColumnHeader textAlign="end">Bundle</Table.ColumnHeader>
                  <Table.ColumnHeader>When</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {list.map((r) => (
                  <Table.Row key={r.id} cursor="pointer" onClick={() => setViewing(r.id)} bg={r.id === shown ? 'colorPalette.subtle' : undefined}>
                    <Table.Cell fontWeight="medium" className="num">
                      {r.version_after ?? r.version_before ?? '—'}
                    </Table.Cell>
                    <Table.Cell>{MODE_LABEL[r.mode]}</Table.Cell>
                    <Table.Cell>{r.mode === 'build' ? '—' : trackLabel(r.track)}</Table.Cell>
                    <Table.Cell>
                      <Badge tone={RELEASE_TONE[r.status]}>{r.status}</Badge>
                    </Table.Cell>
                    <Table.Cell textAlign="end" className="num">
                      {r.aab_bytes ? fmtBytes(r.aab_bytes) : '—'}
                    </Table.Cell>
                    <Table.Cell whiteSpace="nowrap" fontSize="xs" color="fg.muted">
                      {ago(r.started_at)}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Box>
        </Card>
      )}

      {isFlutter && (
        <Card icon={<LuKeyRound />} title="Google Play setup" subtitle={ready ? `Connected as ${comp.play?.service_account_email}` : 'Package, track, service account and git options'}>
          <PlaySetup comp={comp} onChanged={onChanged} />
        </Card>
      )}

      <ReleaseDialog comp={comp} mode={mode} onClose={() => setMode(null)} onStarted={(id) => setViewing(id)} />
    </Stack>
  );
}

/** Deployment: one release panel per mobile app of the project. */
export function DeploymentTab({ components, onChanged }: { components: ProjectComponent[]; onChanged: () => void }) {
  const apps = components.filter((c) => c.kind === 'mobile');
  if (!apps.length)
    return (
      <Empty icon={<LuRocket />} title="No mobile app in this project yet">
        Add your Flutter app folder on the Overview tab — then releases to Google Play run from here.
      </Empty>
    );
  return (
    <Stack gap="6">
      {apps.map((c) => (
        <AppDeployment key={c.id} comp={c} onChanged={onChanged} />
      ))}
    </Stack>
  );
}
