'use client';
import { useMemo, useState } from 'react';
import NextLink from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge as CBadge,
  Box,
  Button,
  CloseButton,
  Code,
  Drawer,
  Flex,
  Grid,
  HStack,
  Image,
  Link,
  NativeSelect,
  Portal,
  SegmentGroup,
  SimpleGrid,
  Stack,
  Table,
  Text,
} from '@chakra-ui/react';
import { LuBug, LuCopy, LuExternalLink, LuFileChartColumn, LuRotateCcw, LuSparkles } from 'react-icons/lu';
import { API, api, type Bug, type BugDetail, type BugSeverity, type BugStats, type BugStatus } from '../lib/api';
import { Card, Empty, Kv, Loading, Notice, Stat, SubHeading } from '../components/ui';
import { notify } from '../components/toaster';

const SEV_PALETTE: Record<BugSeverity, string> = { critical: 'red', high: 'orange', medium: 'yellow', low: 'gray' };
const STATUS_PALETTE: Record<BugStatus, string> = { open: 'blue', confirmed: 'purple', fixed: 'green', ignored: 'gray' };
const CATEGORY: Record<string, string> = {
  crash: 'Crash',
  anr: 'Not responding (ANR)',
  native_crash: 'Native crash',
  install: 'Install',
  compatibility: 'Compatibility',
  launch: 'Launch',
  stability: 'Stability',
  performance: 'Performance',
  functional: 'Functional',
};
/** "logcat", or "logcat 2" when a run saved several (one per cycle). */
export const evidenceLabel = (list: { id: string; type: string }[], e: { id: string; type: string }) => {
  const same = list.filter((x) => x.type === e.type);
  return same.length > 1 ? `${e.type} ${same.indexOf(e) + 1}` : e.type;
};
const SEV_ORDER: BugSeverity[] = ['critical', 'high', 'medium', 'low'];
const when = (iso: string) => new Date(iso).toLocaleString();

export function SeverityBadge({ s }: { s: BugSeverity }) {
  return (
    <CBadge colorPalette={SEV_PALETTE[s]} variant="solid" textTransform="uppercase" fontSize="2xs">
      {s}
    </CBadge>
  );
}

type Group = { signature: string; latest: Bug; count: number; devices: string[]; first: string };

function groupBugs(bugs: Bug[]): Group[] {
  const map = new Map<string, Group>();
  for (const b of bugs) {
    const g = map.get(b.signature);
    if (!g) map.set(b.signature, { signature: b.signature, latest: b, count: 1, devices: b.device_name ? [b.device_name] : [], first: b.created_at });
    else {
      g.count++;
      if (b.device_name && !g.devices.includes(b.device_name)) g.devices.push(b.device_name);
      if (b.created_at < g.first) g.first = b.created_at;
    }
  }
  return [...map.values()].sort((a, b) => SEV_ORDER.indexOf(a.latest.severity) - SEV_ORDER.indexOf(b.latest.severity) || b.latest.created_at.localeCompare(a.latest.created_at));
}

/** GitHub-issue Markdown for a bug. */
function toMarkdown(b: BugDetail) {
  return [
    `## ${b.title}`,
    '',
    `**Severity:** ${b.severity} · **Category:** ${CATEGORY[b.category] ?? b.category} · **Confidence:** ${b.confidence !== null ? `${Math.round(b.confidence * 100)}%` : '?'}`,
    `**App:** ${b.package_name} ${b.app_version ?? ''} · **Device:** ${b.device_name} (Android ${b.android_version ?? '?'}, API ${b.api_level ?? '?'})`,
    `**Seen:** ${b.occurrences.length} time(s) on ${[...new Set(b.occurrences.map((o) => o.device_name))].join(', ')}`,
    '',
    '### Steps to reproduce',
    ...b.steps.map((s, i) => `${i + 1}. ${s}`),
    '',
    `**Expected:** ${b.expected ?? ''}`,
    '',
    `**Actual:** ${b.actual ?? ''}`,
    '',
    ...(b.excerpt ? ['<details><summary>Log excerpt</summary>', '', '```', b.excerpt, '```', '</details>', ''] : []),
    ...(b.hypothesis ? ['### AI hypothesis (not verified)', '', b.hypothesis, ''] : []),
    '_Found by PlayTest AI_',
  ].join('\n');
}

function BugDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['bugs', 'detail', id], enabled: !!id, queryFn: () => api<BugDetail>(`/bugs/${id}`) });
  const [busy, setBusy] = useState<string | null>(null);
  const b = q.data;
  const refresh = () => qc.invalidateQueries({ queryKey: ['bugs'] });

  const setStatus = async (status: BugStatus) => {
    setBusy('status');
    try {
      await api(`/bugs/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      await refresh();
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setBusy(null);
    }
  };
  const retest = async () => {
    setBusy('retest');
    try {
      await api(`/bugs/${id}/retest`, { method: 'POST', body: '{}' });
      notify('ok', 'Re-test started (3 cycles, fresh install) — watch it on Live Testing');
      await refresh();
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setBusy(null);
    }
  };
  const analyze = async () => {
    if (!confirm('Send this bug (title, device, steps and the log excerpt) to Google Gemini for an explanation?')) return;
    setBusy('ai');
    try {
      await api(`/bugs/${id}/analyze`, { method: 'POST', body: '{}' });
      await refresh();
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setBusy(null);
    }
  };
  const copy = async () => {
    if (!b) return;
    await navigator.clipboard.writeText(toMarkdown(b));
    notify('ok', 'Copied as Markdown — paste it into a GitHub / Jira issue');
  };

  const shot = b?.evidence.find((e) => e.type === 'screenshot');
  return (
    <Drawer.Root open={!!id} onOpenChange={(e) => !e.open && onClose()} size="lg">
      <Portal>
        <Drawer.Backdrop />
        <Drawer.Positioner>
          <Drawer.Content>
            <Drawer.Header>
              <Drawer.Title fontFamily="heading" pr="8">
                {b?.title ?? 'Bug'}
              </Drawer.Title>
            </Drawer.Header>
            <Drawer.Body>
              {!b ? (
                <Loading rows={6} height="6" />
              ) : (
                <Stack gap="5">
                  <HStack gap="2" wrap="wrap">
                    <SeverityBadge s={b.severity} />
                    <CBadge variant="outline">{CATEGORY[b.category] ?? b.category}</CBadge>
                    <CBadge colorPalette={STATUS_PALETTE[b.status]} variant="subtle">
                      {b.status}
                    </CBadge>
                    {b.reproducible === 1 && (
                      <CBadge colorPalette="red" variant="subtle">
                        reproduced on re-test
                      </CBadge>
                    )}
                    {b.reproducible === 0 && (
                      <CBadge colorPalette="green" variant="subtle">
                        did not reproduce on re-test
                      </CBadge>
                    )}
                    {b.retest_campaign_id && b.reproducible === null && <CBadge variant="subtle">re-test running…</CBadge>}
                  </HStack>

                  <Flex gap="2" wrap="wrap">
                    <SegmentGroup.Root size="xs" value={b.status} onValueChange={(e) => e.value && void setStatus(e.value as BugStatus)} disabled={busy === 'status'}>
                      <SegmentGroup.Indicator />
                      <SegmentGroup.Items items={(['open', 'confirmed', 'fixed', 'ignored'] as BugStatus[]).map((s) => ({ value: s, label: s.charAt(0).toUpperCase() + s.slice(1) }))} />
                    </SegmentGroup.Root>
                    <Button size="xs" variant="outline" onClick={() => void retest()} loading={busy === 'retest'} title="Run the same APK on the same device 3 times with a fresh install">
                      <LuRotateCcw /> Re-test
                    </Button>
                    <Button size="xs" variant="outline" onClick={() => void copy()}>
                      <LuCopy /> Copy as issue
                    </Button>
                    {b.campaign_id && (
                      <Button asChild size="xs" variant="ghost">
                        <NextLink href={`/reports/${b.campaign_id}`} onClick={onClose}>
                          <LuFileChartColumn /> Run report
                        </NextLink>
                      </Button>
                    )}
                  </Flex>

                  <Kv
                    items={[
                      ['App', `${b.package_name ?? '?'} ${b.app_version ?? ''}`],
                      ['Device', b.device_name ?? '?'],
                      ['Android', b.android_version ? `${b.android_version} (API ${b.api_level})` : '?'],
                      ['Found', when(b.created_at)],
                      ['Confidence', b.confidence !== null ? `${Math.round(b.confidence * 100)}% — strength of the evidence, not a probability` : '?'],
                      ['Seen', `${b.occurrences.length}× on ${[...new Set(b.occurrences.map((o) => o.device_name))].join(', ')}`],
                    ]}
                  />

                  <SimpleGrid columns={{ base: 1, md: 2 }} gap="3">
                    <Box borderWidth="1px" borderRadius="md" p="3">
                      <Text fontSize="2xs" fontWeight="semibold" textTransform="uppercase" color="fg.muted" letterSpacing="wider">
                        Expected
                      </Text>
                      <Text fontSize="sm">{b.expected}</Text>
                    </Box>
                    <Box borderWidth="1px" borderRadius="md" p="3" borderColor="red.muted" bg="red.subtle">
                      <Text fontSize="2xs" fontWeight="semibold" textTransform="uppercase" color="red.fg" letterSpacing="wider">
                        Observed (fact)
                      </Text>
                      <Text fontSize="sm">{b.actual}</Text>
                    </Box>
                  </SimpleGrid>

                  <Stack gap="2">
                    <SubHeading>Steps to reproduce</SubHeading>
                    <Box as="ol" pl="5" fontSize="sm" css={{ '& li': { marginBottom: '4px' } }}>
                      {b.steps.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </Box>
                  </Stack>

                  <Stack gap="2">
                    <SubHeading>Evidence</SubHeading>
                    <Grid templateColumns={{ base: '1fr', md: shot ? '160px minmax(0, 1fr)' : '1fr' }} gap="3" alignItems="start">
                      {shot && (
                        <Link href={`${API}/artifacts/${shot.id}`} target="_blank" rel="noreferrer">
                          <Image src={`${API}/artifacts/${shot.id}`} alt="Screen when it happened" borderRadius="md" borderWidth="1px" w="160px" />
                        </Link>
                      )}
                      <Stack gap="2" minW="0">
                        {b.excerpt && (
                          <Box as="pre" fontFamily="mono" fontSize="11px" bg="gray.950" color="gray.200" p="3" borderRadius="md" maxH="280px" overflow="auto" whiteSpace="pre">
                            {b.excerpt}
                          </Box>
                        )}
                        <HStack gap="2" wrap="wrap">
                          {b.evidence
                            .filter((e) => e.type !== 'screenshot')
                            .map((e) => (
                              <Button key={e.id} asChild size="2xs" variant="outline">
                                <a href={`${API}/artifacts/${e.id}`} target="_blank" rel="noreferrer">
                                  <LuExternalLink /> {evidenceLabel(b.evidence, e)}
                                </a>
                              </Button>
                            ))}
                        </HStack>
                      </Stack>
                    </Grid>
                  </Stack>

                  <Stack gap="2">
                    <SubHeading
                      actions={
                        <Button size="xs" variant="outline" onClick={() => void analyze()} loading={busy === 'ai'}>
                          <LuSparkles /> {b.hypothesis ? 'Ask again' : 'Explain with Gemini'}
                        </Button>
                      }
                    >
                      AI hypothesis
                    </SubHeading>
                    {b.hypothesis ? (
                      <Box borderWidth="1px" borderStyle="dashed" borderRadius="md" p="3">
                        <Text fontSize="2xs" fontWeight="semibold" textTransform="uppercase" color="purple.fg" mb="1">
                          Hypothesis — not verified
                        </Text>
                        <Text fontSize="sm" whiteSpace="pre-wrap">
                          {b.hypothesis}
                        </Text>
                      </Box>
                    ) : (
                      <Text fontSize="xs" color="fg.muted">
                        Optional: Gemini suggests a likely cause and fix from the facts above. It is labelled as a hypothesis — check it against the log.
                      </Text>
                    )}
                  </Stack>

                  {b.occurrences.length > 1 && (
                    <Stack gap="2">
                      <SubHeading>All occurrences</SubHeading>
                      <Table.Root size="sm">
                        <Table.Body>
                          {b.occurrences.map((o) => (
                            <Table.Row key={o.id}>
                              <Table.Cell>{o.device_name}</Table.Cell>
                              <Table.Cell>{o.android_version ? `Android ${o.android_version}` : ''}</Table.Cell>
                              <Table.Cell fontSize="xs" color="fg.muted">
                                {when(o.created_at)}
                              </Table.Cell>
                              <Table.Cell>
                                <Link asChild fontSize="xs" onClick={onClose}><NextLink href={`/reports/${o.campaign_id}`}>
                                  report
                                </NextLink></Link>
                              </Table.Cell>
                            </Table.Row>
                          ))}
                        </Table.Body>
                      </Table.Root>
                    </Stack>
                  )}
                  <Text fontSize="2xs" color="fg.subtle">
                    Signature <Code size="sm">{b.signature}</Code>
                  </Text>
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

const SELECTS = { status: ['active', 'open', 'confirmed', 'fixed', 'ignored', 'all'], severity: ['', ...SEV_ORDER], category: ['', ...Object.keys(CATEGORY)] };

/** Bug Reports: evidence-backed failures from test runs, grouped by problem. */
export function BugsPage() {
  const q = useQuery({ queryKey: ['bugs', 'list'], queryFn: () => api<{ bugs: Bug[]; stats: BugStats }>('/bugs') });
  const [status, setStatus] = useState('active');
  const [severity, setSeverity] = useState('');
  const [category, setCategory] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const groups = useMemo(() => {
    const list = (q.data?.bugs ?? []).filter(
      (b) =>
        (status === 'all' || (status === 'active' ? b.status === 'open' || b.status === 'confirmed' : b.status === status)) &&
        (!severity || b.severity === severity) &&
        (!category || b.category === category),
    );
    return groupBugs(list);
  }, [q.data, status, severity, category]);

  if (!q.data) return q.isError ? <Notice tone="error">{q.error.message}</Notice> : <Loading rows={4} height="10" label="Loading bug reports" />;
  const st = q.data.stats;
  const select = (value: string, set: (v: string) => void, opts: string[], label: string) => (
    <NativeSelect.Root size="sm" w="auto" minW="36">
      <NativeSelect.Field value={value} onChange={(e) => set(e.target.value)} aria-label={label}>
        {opts.map((o) => (
          <option key={o} value={o}>
            {o === '' ? `Any ${label.toLowerCase()}` : o === 'active' ? 'Open + confirmed' : (CATEGORY[o] ?? o.charAt(0).toUpperCase() + o.slice(1))}
          </option>
        ))}
      </NativeSelect.Field>
      <NativeSelect.Indicator />
    </NativeSelect.Root>
  );

  return (
    <Stack gap="5">
      <SimpleGrid columns={{ base: 2, md: 5 }} gap="4" borderWidth="1px" borderRadius="lg" bg="bg.panel" p="4">
        <Stat label="Open problems" value={st.open} hint="unique, open + confirmed" />
        {SEV_ORDER.map((s) => (
          <Stat key={s} label={s.charAt(0).toUpperCase() + s.slice(1)} value={st.by_severity[s] ?? 0} />
        ))}
      </SimpleGrid>

      <Card
        icon={<LuBug />}
        title="Bug reports"
        subtitle="Created automatically when a test fails — with category, steps to reproduce and evidence. The same problem on several devices is one row."
        actions={
          <HStack gap="2" wrap="wrap">
            {select(status, setStatus, SELECTS.status, 'Status')}
            {select(severity, setSeverity, SELECTS.severity, 'Severity')}
            {select(category, setCategory, SELECTS.category, 'Category')}
          </HStack>
        }
      >
        {groups.length === 0 ? (
          <Empty icon={<LuBug />} title={q.data.bugs.length ? 'Nothing matches these filters' : 'No bugs found yet'}>
            {q.data.bugs.length ? 'Try “All” statuses.' : 'Failed test runs create bug reports here automatically.'}
          </Empty>
        ) : (
          <Box overflowX="auto">
            <Table.Root size="sm" interactive>
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader w="90px">Severity</Table.ColumnHeader>
                  <Table.ColumnHeader>Problem</Table.ColumnHeader>
                  <Table.ColumnHeader>Devices</Table.ColumnHeader>
                  <Table.ColumnHeader textAlign="end">Seen</Table.ColumnHeader>
                  <Table.ColumnHeader>Last seen</Table.ColumnHeader>
                  <Table.ColumnHeader>Status</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {groups.map((g) => (
                  <Table.Row key={g.signature} cursor="pointer" onClick={() => setOpen(g.latest.id)}>
                    <Table.Cell>
                      <SeverityBadge s={g.latest.severity} />
                    </Table.Cell>
                    <Table.Cell minW="260px">
                      <Text fontWeight="medium">{g.latest.title}</Text>
                      <Text fontSize="xs" color="fg.muted">
                        {CATEGORY[g.latest.category] ?? g.latest.category} · {g.latest.package_name} {g.latest.app_version ?? ''}
                        {g.latest.reproducible === 1 ? ' · reproduced' : g.latest.reproducible === 0 ? ' · not reproduced' : ''}
                      </Text>
                    </Table.Cell>
                    <Table.Cell fontSize="sm">{g.devices.join(', ')}</Table.Cell>
                    <Table.Cell textAlign="end" className="num">
                      {g.count}×
                    </Table.Cell>
                    <Table.Cell fontSize="xs" color="fg.muted" whiteSpace="nowrap">
                      {when(g.latest.created_at)}
                    </Table.Cell>
                    <Table.Cell>
                      <CBadge colorPalette={STATUS_PALETTE[g.latest.status]} variant="subtle">
                        {g.latest.status}
                      </CBadge>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Box>
        )}
      </Card>
      <BugDrawer id={open} onClose={() => setOpen(null)} />
    </Stack>
  );
}
