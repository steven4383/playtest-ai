'use client';
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Box, Button, Collapsible, Field, Flex, Grid, HStack, IconButton, Input, List, NativeSelect, Progress, SimpleGrid, Stack, Table, Text, Textarea } from '@chakra-ui/react';
import { LuDownload, LuMail, LuTrash2, LuUserPlus, LuUsers } from 'react-icons/lu';
import { API, api } from '../lib/api';
import { useApks } from '../lib/queries';
import { Badge, Card, CopyButton, Empty, Loading, Notice, type Tone } from '../components/ui';
import { notify } from '../components/toaster';

type Status = 'invited' | 'opted_in' | 'left';
interface Tester {
  id: string;
  email: string;
  name: string | null;
  device: string | null;
  status: Status;
  invited_at: string;
  opted_in_at: string | null;
  left_at: string | null;
  notes: string | null;
}
interface Summary {
  required_testers: number;
  required_days: number;
  opted_in: number;
  invited: number;
  left: number;
  need_more: number;
  spare: number;
  clock_started_at: string | null;
  days_done: number;
  eligible_at: string | null;
  met: boolean;
  status: 'met' | 'counting' | 'need_testers';
}
interface PlayTest {
  package_name: string;
  settings: { opt_in_url: string; store_url: string; required_testers: number; required_days: number };
  testers: Tester[];
  summary: Summary;
}

const PKG_KEY = 'pt-play-pkg';
const PKG_RE = /^[a-zA-Z][\w]*(\.[a-zA-Z_][\w]*)+$/;
const STATUS_LABEL: Record<Status, string> = { invited: 'Invited', opted_in: 'Opted in', left: 'Left' };
const STATUS_TONE: Record<Status, Tone> = { invited: 'warning', opted_in: 'good', left: 'neutral' };
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const daysSince = (iso: string | null) => (iso ? Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000)) : 0);
const ls = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* not remembered */
    }
  },
};

function inviteText(t: PlayTest, appName: string) {
  return `Hi! Could you help me test ${appName} before it goes on Google Play? It takes 2 minutes, and I need it to stay installed for 14 days.

1. On your Android phone, open this link while signed in to Google with the email address you gave me:
${t.settings.opt_in_url}
2. Tap "Become a tester".
3. Install the app from Google Play: ${t.settings.store_url}
4. Keep it installed for at least 14 days, open it now and then, and tell me anything that looks wrong.

Thank you!`;
}

/** Name / phone fields in the table: saved when you leave the field. */
function InlineEdit({ value, placeholder, onSave, label }: { value: string | null; placeholder: string; onSave: (v: string) => void; label: string }) {
  const [v, setV] = useState(value ?? '');
  useEffect(() => setV(value ?? ''), [value]);
  return (
    <Input
      size="xs"
      variant="flushed"
      value={v}
      placeholder={placeholder}
      aria-label={label}
      maxLength={100}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v.trim() !== (value ?? '') && onSave(v.trim())}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

/**
 * Google Play closed testing: new personal developer accounts need at least 12 testers opted in for 14 days in a
 * row before they can apply for production. Play counts the Google accounts of real people who opt in on their own
 * phones — this page keeps that list, the 14-day clock, the invite message and the email list for Play Console.
 */
export function PlayTestingPage() {
  const qc = useQueryClient();
  const apks = useApks().data ?? [];
  const appsQ = useQuery({ queryKey: ['play', 'apps'], queryFn: () => api<{ apps: { package_name: string }[] }>('/play/apps').then((r) => r.apps) });
  const [pkg, setPkg] = useState<string>(() => ls.get(PKG_KEY) ?? '');
  const [otherPkg, setOtherPkg] = useState('');
  const [form, setForm] = useState({ email: '', name: '', device: '' });
  const [paste, setPaste] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [url, setUrl] = useState('');

  const packages = useMemo(() => {
    const set = new Set<string>();
    for (const a of appsQ.data ?? []) set.add(a.package_name);
    for (const a of apks) if (a.package_name) set.add(a.package_name);
    return [...set].sort();
  }, [appsQ.data, apks]);
  useEffect(() => {
    if (!pkg && packages[0]) setPkg(packages[0]);
  }, [pkg, packages]);
  useEffect(() => {
    if (pkg) ls.set(PKG_KEY, pkg);
  }, [pkg]);

  const q = useQuery({ queryKey: ['play', 'app', pkg], enabled: PKG_RE.test(pkg), queryFn: () => api<PlayTest>(`/play/${encodeURIComponent(pkg)}`) });
  const t = q.data;
  useEffect(() => {
    if (t) setUrl(t.settings.opt_in_url);
  }, [t]);
  const reload = () => Promise.all([qc.invalidateQueries({ queryKey: ['play', 'app', pkg] }), qc.invalidateQueries({ queryKey: ['play', 'apps'] })]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
      await reload();
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setBusy(null);
    }
  };
  const base = `/play/${encodeURIComponent(pkg)}`;
  const add = (e: React.FormEvent) => {
    e.preventDefault();
    void run('add', async () => {
      await api(`${base}/testers`, { method: 'POST', body: JSON.stringify({ email: form.email, name: form.name || null, device: form.device || null }) });
      notify('ok', `${form.email} added — add the same address to the email list in Play Console.`);
      setForm({ email: '', name: '', device: '' });
    });
  };
  const importList = () =>
    run('import', async () => {
      const r = await api<{ added: string[]; skipped: string[] }>(`${base}/testers/import`, { method: 'POST', body: JSON.stringify({ text: paste }) });
      notify('ok', `Added ${r.added.length} tester${r.added.length === 1 ? '' : 's'}${r.skipped.length ? ` · ${r.skipped.length} already on the list` : ''}`);
      setPaste('');
    });
  const patch = (id: string, body: Partial<Tester>) => run(`t-${id}`, async () => void (await api(`/play/testers/${id}`, { method: 'PATCH', body: JSON.stringify(body) })));
  const remove = (x: Tester) =>
    confirm(`Remove ${x.email} from the list? (Remove them from the email list in Play Console too.)`) &&
    run(`t-${x.id}`, async () => void (await api(`/play/testers/${x.id}`, { method: 'DELETE' })));
  const saveUrl = () => run('url', async () => void (await api(`${base}/settings`, { method: 'PUT', body: JSON.stringify({ opt_in_url: url }) })));

  const s = t?.summary;
  const apk = apks.find((a) => a.package_name === pkg);
  const appName = apk?.package_name || pkg ? `my app (${pkg.split('.').pop()})` : 'my app';
  const activeEmails = (t?.testers ?? []).filter((x) => x.status !== 'left').map((x) => x.email);

  return (
    <Stack gap="5">
      <Card
        icon={<LuUsers />}
        title="Google Play closed testing"
        subtitle="New personal developer accounts need 12+ testers opted in for 14 days in a row before applying for production"
      >
        <Flex gap="3" align="flex-end" wrap="wrap">
          <Field.Root maxW="420px" flex="1" minW="240px">
            <Field.Label>App</Field.Label>
            <NativeSelect.Root size="sm">
              <NativeSelect.Field value={packages.includes(pkg) ? pkg : ''} onChange={(e) => setPkg(e.target.value)}>
                {!packages.includes(pkg) && <option value="">{pkg || 'Choose an app'}</option>}
                {packages.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </NativeSelect.Field>
              <NativeSelect.Indicator />
            </NativeSelect.Root>
          </Field.Root>
          <HStack as="form" gap="2" onSubmit={(e) => (e.preventDefault(), PKG_RE.test(otherPkg.trim()) ? (setPkg(otherPkg.trim()), setOtherPkg('')) : notify('warning', 'Enter a package name like com.company.app'))}>
            <Input size="sm" w="240px" value={otherPkg} onChange={(e) => setOtherPkg(e.target.value)} placeholder="or another package name" fontFamily="mono" aria-label="Package name" />
            <Button size="sm" variant="outline" type="submit">
              Track
            </Button>
          </HStack>
        </Flex>

        {!pkg ? (
          <Empty icon={<LuUsers />} title="Pick the app you are testing">
            Upload its APK on the APK Manager page, or type its package name.
          </Empty>
        ) : !t || !s ? (
          <Loading rows={3} height="10" />
        ) : (
          <Stack gap="4">
            <SimpleGrid columns={{ base: 1, md: 2 }} gap="4">
              <Box borderWidth="1px" borderRadius="lg" p="4">
                <Flex justify="space-between" align="baseline">
                  <Text fontSize="sm" color="fg.muted">
                    Testers opted in
                  </Text>
                  <Text fontFamily="heading" fontWeight="bold" fontSize="2xl" className="num">
                    {s.opted_in}
                    <Text as="span" fontSize="md" color="fg.muted">
                      {' '}
                      / {s.required_testers}
                    </Text>
                  </Text>
                </Flex>
                <Progress.Root value={Math.min(100, (s.opted_in / s.required_testers) * 100)} size="sm" colorPalette={s.need_more ? 'orange' : 'green'} mt="2">
                  <Progress.Track>
                    <Progress.Range />
                  </Progress.Track>
                </Progress.Root>
                <Text fontSize="xs" color="fg.muted" mt="2">
                  {s.need_more ? `${s.need_more} more needed` : s.spare ? `${s.spare} spare — good, in case someone leaves` : 'Exactly enough — add 2–3 spare testers in case someone leaves'}
                  {s.invited ? ` · ${s.invited} invited, not opted in yet` : ''}
                </Text>
              </Box>
              <Box borderWidth="1px" borderRadius="lg" p="4">
                <Flex justify="space-between" align="baseline">
                  <Text fontSize="sm" color="fg.muted">
                    Days with {s.required_testers}+ testers
                  </Text>
                  <Text fontFamily="heading" fontWeight="bold" fontSize="2xl" className="num">
                    {s.days_done}
                    <Text as="span" fontSize="md" color="fg.muted">
                      {' '}
                      / {s.required_days}
                    </Text>
                  </Text>
                </Flex>
                <Progress.Root value={(s.days_done / s.required_days) * 100} size="sm" colorPalette={s.met ? 'green' : 'blue'} mt="2">
                  <Progress.Track>
                    <Progress.Range />
                  </Progress.Track>
                </Progress.Root>
                <Text fontSize="xs" color="fg.muted" mt="2">
                  {s.clock_started_at ? `Counting since ${day(s.clock_started_at)}` : `Starts when the ${s.required_testers}th tester opts in`}
                </Text>
              </Box>
            </SimpleGrid>
            {s.status === 'met' ? (
              <Notice tone="success" title={`Requirement met on ${day(s.eligible_at)}`}>
                In Play Console open Dashboard → Apply for production. Google asks how testers used the app and what you changed from their feedback — keep notes of it.
              </Notice>
            ) : s.status === 'counting' ? (
              <Notice tone="info" title={`You can apply for production on ${day(s.eligible_at)}`}>
                If all {s.required_testers} stay opted in. If someone leaves and you drop below {s.required_testers}, the 14 days start again when you are back to{' '}
                {s.required_testers}.
              </Notice>
            ) : (
              <Notice tone="warning" title={`${s.need_more} more tester${s.need_more === 1 ? '' : 's'} must opt in`}>
                The {s.required_days} days only start counting once {s.required_testers} testers are opted in at the same time.
              </Notice>
            )}
            <Text fontSize="xs" color="fg.muted">
              Play Console is the source of truth — its Dashboard shows how many testers opted in. Mark testers here when they confirm, so you know who to remind.
            </Text>
          </Stack>
        )}
      </Card>

      {t && (
        <Grid templateColumns={{ base: '1fr', xl: '1fr 1.4fr' }} gap="5" alignItems="start">
          <Card icon={<LuMail />} title="Invite testers" subtitle="Each tester opts in on their own Android phone with their own Google account">
            <Stack gap="4">
              <Field.Root>
                <Field.Label>Opt-in link</Field.Label>
                <HStack w="100%">
                  <Input size="sm" value={url} onChange={(e) => setUrl(e.target.value)} fontFamily="mono" aria-label="Opt-in link" />
                  {url !== t.settings.opt_in_url && (
                    <Button size="sm" onClick={() => void saveUrl()} loading={busy === 'url'}>
                      Save
                    </Button>
                  )}
                  <CopyButton value={t.settings.opt_in_url} />
                </HStack>
                <Field.HelperText>From Play Console → Testing → Closed testing → Testers → “Join on Android”.</Field.HelperText>
              </Field.Root>
              <Stack gap="1.5">
                <Flex justify="space-between" align="center">
                  <Text fontSize="sm" fontWeight="medium">
                    Message to send
                  </Text>
                  <CopyButton value={inviteText(t, appName)} label="Copy message" />
                </Flex>
                <Box as="pre" fontSize="xs" whiteSpace="pre-wrap" bg="bg.subtle" borderWidth="1px" borderRadius="md" p="3" maxH="220px" overflowY="auto">
                  {inviteText(t, appName)}
                </Box>
              </Stack>
              <Stack gap="1.5">
                <Text fontSize="sm" fontWeight="medium">
                  Email list for Play Console ({activeEmails.length})
                </Text>
                <HStack gap="2" wrap="wrap">
                  <CopyButton value={activeEmails.join(', ')} label="Copy emails" disabled={!activeEmails.length} />
                  <Button asChild size="xs" variant="outline" disabled={!activeEmails.length}>
                    <a href={`${API}${base}/testers.csv`} download>
                      <LuDownload /> Download CSV
                    </a>
                  </Button>
                </HStack>
                <Text fontSize="xs" color="fg.muted">
                  Play Console → Testing → Closed testing → Testers → Create email list → paste or Upload CSV. Testers who left are not included.
                </Text>
              </Stack>
              <Stack gap="1">
                <Text fontSize="sm" fontWeight="medium">
                  Good to know
                </Text>
                <List.Root fontSize="xs" color="fg.muted" ps="4" gap="1">
                  <List.Item>Play counts Google accounts that opted in — each tester uses their own account on their own phone.</List.Item>
                  <List.Item>Ask testers to keep the app installed and open it now and then; Google looks at engagement when you apply.</List.Item>
                  <List.Item>Keep 2–3 spare testers: dropping below 12 restarts the 14 days.</List.Item>
                  <List.Item>Note feedback and what you fixed — the production application asks about it.</List.Item>
                </List.Root>
              </Stack>
            </Stack>
          </Card>

          <Card
            icon={<LuUsers />}
            title={`Testers (${t.testers.length})`}
            subtitle={`${s?.opted_in ?? 0} opted in · ${s?.invited ?? 0} invited · ${s?.left ?? 0} left`}
            actions={
              t.testers.length > 0 ? (
                <Button size="xs" variant="ghost" colorPalette="red" onClick={() => confirm(`Forget the whole tester list for ${pkg}?`) && void run('forget', async () => void (await api(base, { method: 'DELETE' })))}>
                  Clear list
                </Button>
              ) : undefined
            }
          >
            <Stack gap="3">
              <Box as="form" onSubmit={add} borderWidth="1px" borderRadius="md" p="3" bg="bg.subtle">
                <SimpleGrid columns={{ base: 1, md: 3 }} gap="2">
                  <Input size="sm" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="tester@gmail.com" aria-label="Tester email" />
                  <Input size="sm" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Name (optional)" aria-label="Tester name" maxLength={100} />
                  <Input size="sm" value={form.device} onChange={(e) => setForm({ ...form, device: e.target.value })} placeholder="Their phone (optional)" aria-label="Tester phone" maxLength={100} />
                </SimpleGrid>
                <HStack mt="2" gap="2" wrap="wrap">
                  <Button size="xs" type="submit" loading={busy === 'add'}>
                    <LuUserPlus /> Add tester
                  </Button>
                  <Collapsible.Root>
                    <Collapsible.Trigger asChild>
                      <Button size="xs" variant="ghost" type="button">
                        Paste many…
                      </Button>
                    </Collapsible.Trigger>
                    <Collapsible.Content>
                      <Stack gap="2" mt="2" minW={{ base: '100%', md: '420px' }}>
                        <Textarea size="sm" rows={4} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Paste emails — one per line, or separated by commas" aria-label="Emails to add" />
                        <Button size="xs" alignSelf="flex-start" type="button" onClick={() => void importList()} loading={busy === 'import'} disabled={!paste.trim()}>
                          Add all
                        </Button>
                      </Stack>
                    </Collapsible.Content>
                  </Collapsible.Root>
                </HStack>
              </Box>

              {t.testers.length === 0 ? (
                <Empty icon={<LuUsers />} title="No testers yet">
                  Add the Google account email of each person who agreed to test.
                </Empty>
              ) : (
                <Box overflowX="auto" borderWidth="1px" borderRadius="md">
                  <Table.Root size="sm">
                    <Table.Header>
                      <Table.Row>
                        <Table.ColumnHeader>Tester</Table.ColumnHeader>
                        <Table.ColumnHeader>Their phone</Table.ColumnHeader>
                        <Table.ColumnHeader>Status</Table.ColumnHeader>
                        <Table.ColumnHeader>Opted in</Table.ColumnHeader>
                        <Table.ColumnHeader aria-label="Actions" />
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {t.testers.map((x) => (
                        <Table.Row key={x.id} opacity={x.status === 'left' ? 0.6 : 1}>
                          <Table.Cell minW="200px">
                            <InlineEdit value={x.name} placeholder="Add name" label={`Name of ${x.email}`} onSave={(v) => void patch(x.id, { name: v })} />
                            <Text fontSize="xs" color="fg.muted" fontFamily="mono" truncate title={x.email}>
                              {x.email}
                            </Text>
                          </Table.Cell>
                          <Table.Cell minW="130px">
                            <InlineEdit value={x.device} placeholder="e.g. Galaxy A14" label={`Phone of ${x.email}`} onSave={(v) => void patch(x.id, { device: v })} />
                          </Table.Cell>
                          <Table.Cell minW="130px">
                            <NativeSelect.Root size="xs" disabled={busy === `t-${x.id}`}>
                              <NativeSelect.Field value={x.status} onChange={(e) => void patch(x.id, { status: e.target.value as Status })} aria-label={`Status of ${x.email}`}>
                                {(Object.keys(STATUS_LABEL) as Status[]).map((k) => (
                                  <option key={k} value={k}>
                                    {STATUS_LABEL[k]}
                                  </option>
                                ))}
                              </NativeSelect.Field>
                              <NativeSelect.Indicator />
                            </NativeSelect.Root>
                          </Table.Cell>
                          <Table.Cell whiteSpace="nowrap">
                            {x.status === 'opted_in' && x.opted_in_at ? (
                              <Stack gap="0.5">
                                <Input
                                  size="xs"
                                  type="date"
                                  w="140px"
                                  value={x.opted_in_at.slice(0, 10)}
                                  max={new Date().toISOString().slice(0, 10)}
                                  onChange={(e) => e.target.value && void patch(x.id, { opted_in_at: e.target.value })}
                                  aria-label={`Opt-in date of ${x.email}`}
                                />
                                <Text fontSize="2xs" color="fg.muted">
                                  day {daysSince(x.opted_in_at)}
                                </Text>
                              </Stack>
                            ) : (
                              <Badge tone={STATUS_TONE[x.status]}>{x.status === 'left' ? `left ${day(x.left_at)}` : 'not yet'}</Badge>
                            )}
                          </Table.Cell>
                          <Table.Cell>
                            <IconButton size="2xs" variant="ghost" colorPalette="red" aria-label={`Remove ${x.email}`} onClick={() => void remove(x)} loading={busy === `t-${x.id}`}>
                              <LuTrash2 />
                            </IconButton>
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table.Root>
                </Box>
              )}
            </Stack>
          </Card>
        </Grid>
      )}
    </Stack>
  );
}
