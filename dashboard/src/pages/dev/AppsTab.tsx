import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { qk, useApks } from '../../lib/queries';
import {
  Box,
  Button,
  Checkbox,
  CloseButton,
  Code,
  Drawer,
  Field,
  Flex,
  HStack,
  IconButton,
  Input,
  NativeSelect,
  Portal,
  Stack,
  Switch,
  Text,
} from '@chakra-ui/react';
import { LuDownload, LuEraser, LuInfo, LuPlay, LuSearch, LuSquare, LuTrash2, LuUpload } from 'react-icons/lu';
import { API, api, dev, type AppDetails, type AppEntry, type Apk } from '../../lib/api';
import { Badge, Empty, Kv, Loading, Notice, SubHeading, useBusy } from '../../components/ui';
import { notify } from '../../components/toaster';

/** Upload (optional) + install + open — shared by the Apps tab and drag-and-drop on device cards. */
export async function installApkFile(serial: string, file: File) {
  if (!/\.apk$/i.test(file.name)) throw new Error('Only .apk files can be installed');
  const fd = new FormData();
  fd.append('file', file);
  const apk = await api<Apk>('/apks/upload', { method: 'POST', body: fd });
  return api<{ message: string; opened: string | null; package_name: string | null }>(dev(serial, '/install'), { method: 'POST', body: JSON.stringify({ apk_id: apk.id, launch: true }) });
}

export function AppsTab({ serial, pkg, onPick }: { serial: string; pkg: string; onPick: (pkg: string) => void }) {
  const qc = useQueryClient();
  const [system, setSystem] = useState(false);
  const appsQ = useQuery({
    queryKey: qk.deviceApps(serial, system),
    staleTime: 60_000,
    queryFn: () => api<{ apps: AppEntry[] }>(dev(serial, `/apps?system=${system}`)).then((r) => r.apps),
  });
  const apps = appsQ.isError ? (appsQ.data ?? []) : (appsQ.data ?? null);
  const [query, setQuery] = useState('');
  const [details, setDetails] = useState<string | null>(null);
  const libraryQ = useApks();
  const library = useMemo(() => (libraryQ.data ?? []).filter((a) => a.package_name), [libraryQ.data]);
  const [libId, setLibId] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const { busy, run } = useBusy();

  /** After installs / uninstalls: refresh this device's app lists (also the package picker's). */
  const load = () => qc.invalidateQueries({ queryKey: ['dev', serial, 'apps'] });
  useEffect(() => {
    if (appsQ.error) notify('error', appsQ.error.message);
  }, [appsQ.error]);
  useEffect(() => {
    setLibId((cur) => cur || library[0]?.id || '');
  }, [library]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (apps ?? []).filter((a) => !q || a.package.toLowerCase().includes(q));
  }, [apps, query]);

  const action = (p: string, a: 'launch' | 'stop' | 'clear' | 'uninstall') => {
    if (a === 'clear' && !confirm(`Clear all data of ${p}? Logins, settings and local databases are deleted.`)) return;
    if (a === 'uninstall' && !confirm(`Uninstall ${p}?`)) return;
    void run(`${a}:${p}`, async () => {
      try {
        const r = await api<{ message: string }>(dev(serial, `/apps/${encodeURIComponent(p)}/${a}`), { method: 'POST', body: '{}' });
        notify('ok', r.message);
        if (a === 'uninstall') void load();
      } catch (e: any) {
        notify('error', e.message);
      }
    });
  };

  const installLibrary = () =>
    run('install-lib', async () => {
      try {
        const r = await api<{ message: string; opened: string | null }>(dev(serial, '/install'), { method: 'POST', body: JSON.stringify({ apk_id: libId, launch: true }) });
        notify('ok', `${r.message}${r.opened ? ` · ${r.opened}` : ''}`);
        void load();
      } catch (e: any) {
        notify('error', e.message);
      }
    });

  const installFile = (f: File) =>
    run('install-file', async () => {
      try {
        const r = await installApkFile(serial, f);
        notify('ok', `${r.message}${r.opened ? ` · ${r.opened}` : ''}`);
        void load();
      } catch (e: any) {
        notify('error', e.message);
      } finally {
        if (file.current) file.current.value = '';
      }
    });

  return (
    <Stack gap="4">
      <Box borderWidth="1px" borderRadius="md" p="3" bg="bg.subtle">
        <SubHeading>Install an APK</SubHeading>
        <Flex gap="2" mt="2" wrap="wrap" align="center">
          {library.length > 0 && (
            <>
              <NativeSelect.Root size="sm" flex="1" minW="200px">
                <NativeSelect.Field value={libId} onChange={(e) => setLibId(e.target.value)} aria-label="APK from the library">
                  {library.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.package_name} {a.version_name ? `v${a.version_name}` : ''} — {a.filename}
                    </option>
                  ))}
                </NativeSelect.Field>
                <NativeSelect.Indicator />
              </NativeSelect.Root>
              <Button size="sm" onClick={() => void installLibrary()} loading={busy === 'install-lib'} disabled={!libId}>
                <LuDownload /> Install & open
              </Button>
              <Text fontSize="xs" color="fg.muted">
                or
              </Text>
            </>
          )}
          <input ref={file} type="file" accept=".apk" hidden onChange={(e) => e.target.files?.[0] && void installFile(e.target.files[0])} />
          <Button size="sm" variant="outline" onClick={() => file.current?.click()} loading={busy === 'install-file'} loadingText="Installing…">
            <LuUpload /> Choose .apk…
          </Button>
        </Flex>
        <Text fontSize="xs" color="fg.muted" mt="2">
          Tip: drop an .apk onto a device in the left list to install and open it.
        </Text>
      </Box>

      <Flex gap="3" wrap="wrap" align="center">
        <HStack flex="1" minW="200px" gap="1">
          <Box color="fg.muted">
            <LuSearch />
          </Box>
          <Input size="sm" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search packages" aria-label="Search packages" />
        </HStack>
        <Checkbox.Root size="sm" checked={system} onCheckedChange={(e) => setSystem(!!e.checked)}>
          <Checkbox.HiddenInput />
          <Checkbox.Control />
          <Checkbox.Label>Show system apps</Checkbox.Label>
        </Checkbox.Root>
        <Text fontSize="xs" color="fg.muted" className="num">
          {apps ? `${shown.length} of ${apps.length}` : ''}
        </Text>
      </Flex>

      {apps === null ? (
        <Loading rows={6} height="10" label="Listing apps" />
      ) : shown.length === 0 ? (
        <Empty title={apps.length ? 'No app matches' : 'No user apps installed'} />
      ) : (
        <Stack gap="1" maxH="calc(100dvh - 420px)" minH="260px" overflowY="auto" pe="1">
          {shown.map((a) => (
            <Flex
              key={a.package}
              align="center"
              gap="2"
              borderWidth="1px"
              borderRadius="md"
              px="3"
              py="1.5"
              borderColor={a.package === pkg ? 'colorPalette.solid' : 'border'}
              bg={a.package === pkg ? 'colorPalette.subtle' : 'transparent'}
              wrap="wrap"
            >
              <Box flex="1" minW="180px">
                <Text fontFamily="mono" fontSize="sm" truncate title={a.package}>
                  {a.package}
                </Text>
                <Text fontSize="xs" color="fg.muted">
                  {a.version_code ? `versionCode ${a.version_code}` : ''}
                  {a.system ? ' · system' : ''}
                </Text>
              </Box>
              <HStack gap="0.5">
                {a.package !== pkg && (
                  <Button size="2xs" variant="ghost" onClick={() => onPick(a.package)} title="Use this app for Logcat and Performance">
                    Select
                  </Button>
                )}
                <IconButton size="xs" variant="ghost" aria-label={`Open ${a.package}`} title="Open" loading={busy === `launch:${a.package}`} onClick={() => action(a.package, 'launch')}>
                  <LuPlay />
                </IconButton>
                <IconButton size="xs" variant="ghost" aria-label={`Stop ${a.package}`} title="Force stop" loading={busy === `stop:${a.package}`} onClick={() => action(a.package, 'stop')}>
                  <LuSquare />
                </IconButton>
                <IconButton size="xs" variant="ghost" aria-label={`Clear data of ${a.package}`} title="Clear data" loading={busy === `clear:${a.package}`} onClick={() => action(a.package, 'clear')}>
                  <LuEraser />
                </IconButton>
                {!a.system && (
                  <IconButton
                    size="xs"
                    variant="ghost"
                    colorPalette="red"
                    aria-label={`Uninstall ${a.package}`}
                    title="Uninstall"
                    loading={busy === `uninstall:${a.package}`}
                    onClick={() => action(a.package, 'uninstall')}
                  >
                    <LuTrash2 />
                  </IconButton>
                )}
                <IconButton size="xs" variant="outline" aria-label={`Details of ${a.package}`} title="Details & permissions" onClick={() => setDetails(a.package)}>
                  <LuInfo />
                </IconButton>
              </HStack>
            </Flex>
          ))}
        </Stack>
      )}

      <AppDrawer serial={serial} pkg={details} onClose={() => setDetails(null)} />
    </Stack>
  );
}

function AppDrawer({ serial, pkg, onClose }: { serial: string; pkg: string | null; onClose: () => void }) {
  const [d, setD] = useState<AppDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locale, setLocale] = useState('');
  const { busy, run } = useBusy();

  const load = async (p: string) => {
    try {
      const r = await api<AppDetails>(dev(serial, `/apps/${encodeURIComponent(p)}`));
      setD(r);
      setLocale(r.app_locale ?? '');
    } catch (e: any) {
      setError(e.message);
    }
  };
  useEffect(() => {
    setD(null);
    setError(null);
    if (pkg) void load(pkg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pkg, serial]);

  const setPerm = (name: string, grant: boolean) =>
    run(`perm:${name}`, async () => {
      try {
        await api(dev(serial, `/apps/${encodeURIComponent(pkg!)}/permission`), { method: 'POST', body: JSON.stringify({ permission: name, grant }) });
        setD((cur) => cur && { ...cur, permissions: { ...cur.permissions, runtime: cur.permissions.runtime.map((p) => (p.name === name ? { ...p, granted: grant } : p)) } });
      } catch (e: any) {
        notify('error', e.message);
      }
    });

  const saveLocale = () =>
    run('locale', async () => {
      try {
        await api(dev(serial, `/apps/${encodeURIComponent(pkg!)}/locale`), { method: 'POST', body: JSON.stringify({ locale }) });
        notify('ok', locale ? `App language set to ${locale}` : 'App language reset to system default');
      } catch (e: any) {
        notify('error', e.message);
      }
    });

  return (
    <Drawer.Root open={!!pkg} onOpenChange={(e) => !e.open && onClose()} size="md">
      <Portal>
        <Drawer.Backdrop />
        <Drawer.Positioner>
          <Drawer.Content>
            <Drawer.Header>
              <Drawer.Title fontFamily="mono" fontSize="md" wordBreak="break-all">
                {pkg}
              </Drawer.Title>
            </Drawer.Header>
            <Drawer.Body>
              {error ? (
                <Notice tone="error">{error}</Notice>
              ) : !d ? (
                <Loading rows={8} />
              ) : (
                <Stack gap="5">
                  <HStack gap="2" wrap="wrap">
                    {d.running_pid ? <Badge tone="good">{`running · pid ${d.running_pid}`}</Badge> : <Badge tone="neutral">not running</Badge>}
                    {d.debuggable && <Badge tone="warning">debuggable</Badge>}
                    {d.split_apks && <Badge tone="neutral">split APKs</Badge>}
                  </HStack>
                  <Kv
                    items={[
                      ['Version', `${d.version_name ?? '?'} (${d.version_code ?? '?'})`],
                      ['SDK min / target', `${d.min_sdk ?? '?'} / ${d.target_sdk ?? '?'}`],
                      ['Installed', d.first_install ?? '—'],
                      ['Updated', d.last_update ?? '—'],
                      ['Installer', d.installer && d.installer !== 'null' ? d.installer : '—'],
                    ]}
                  />
                  <Button asChild size="sm" variant="outline" alignSelf="flex-start">
                    <a href={`${API}${dev(serial, `/apps/${encodeURIComponent(d.package)}/apk`)}`} download>
                      <LuDownload /> Download base APK{d.split_apks ? ' (split app — base only)' : ''}
                    </a>
                  </Button>

                  <Stack gap="2">
                    <SubHeading>Runtime permissions</SubHeading>
                    {d.permissions.runtime.length === 0 ? (
                      <Text fontSize="sm" color="fg.muted">
                        None requested.
                      </Text>
                    ) : (
                      d.permissions.runtime.map((p) => (
                        <Switch.Root key={p.name} size="sm" checked={p.granted} disabled={busy === `perm:${p.name}`} onCheckedChange={(e) => void setPerm(p.name, e.checked)} justifyContent="space-between" w="100%">
                          <Switch.Label fontFamily="mono" fontSize="xs" wordBreak="break-all">
                            {p.name.replace(/^android\.permission\./, '')}
                          </Switch.Label>
                          <Switch.HiddenInput />
                          <Switch.Control />
                        </Switch.Root>
                      ))
                    )}
                    {d.permissions.install.length > 0 && (
                      <Text fontSize="xs" color="fg.muted">
                        Also {d.permissions.install.length} install-time permission{d.permissions.install.length === 1 ? '' : 's'} (granted automatically).
                      </Text>
                    )}
                  </Stack>

                  <Stack gap="2">
                    <SubHeading>App language</SubHeading>
                    {d.app_locale === null ? (
                      <Text fontSize="sm" color="fg.muted">
                        Per-app language needs Android 13 or newer.
                      </Text>
                    ) : (
                      <Field.Root>
                        <HStack w="100%">
                          <Input size="sm" value={locale} onChange={(e) => setLocale(e.target.value)} placeholder="e.g. ta-IN, hi-IN, en-US (empty = system)" />
                          <Button size="sm" onClick={() => void saveLocale()} loading={busy === 'locale'}>
                            Apply
                          </Button>
                        </HStack>
                        <Field.HelperText>Test translations without changing the phone’s language.</Field.HelperText>
                      </Field.Root>
                    )}
                  </Stack>

                  {d.apk_paths.length > 0 && (
                    <Stack gap="1">
                      <Text fontSize="xs" color="fg.muted">
                        APK path{d.apk_paths.length > 1 ? 's' : ''}
                      </Text>
                      {d.apk_paths.map((p) => (
                        <Code key={p} size="sm" wordBreak="break-all" whiteSpace="normal">
                          {p}
                        </Code>
                      ))}
                    </Stack>
                  )}
                </Stack>
              )}
            </Drawer.Body>
            <Drawer.CloseTrigger asChild>
              <CloseButton size="sm" />
            </Drawer.CloseTrigger>
          </Drawer.Content>
        </Drawer.Positioner>
      </Portal>
    </Drawer.Root>
  );
}
