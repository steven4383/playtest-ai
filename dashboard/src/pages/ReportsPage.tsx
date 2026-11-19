import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge as CBadge, Box, Button, Flex, Grid, HStack, Image, Link, Progress, SimpleGrid, Stack, Table, Text } from '@chakra-ui/react';
import { LuArrowLeft, LuBraces, LuDownload, LuFileChartColumn, LuPrinter, LuSmartphone } from 'react-icons/lu';
import { API, api, fmtBytes, type Report, type ReportsOverview } from '../lib/api';
import { Badge, Card, Empty, Kv, Loading, Notice, Stat, type Tone } from '../components/ui';
import { evidenceLabel, SeverityBadge } from './BugsPage';

const TONE: Record<string, Tone> = { passed: 'good', failed: 'critical', error: 'serious', skipped: 'neutral', cancelled: 'neutral', running: 'warning', queued: 'neutral' };
const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
const dur = (ms: number | null) => (ms === null ? '—' : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
const sqlDate = (s: string) => new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`).toLocaleString();

/** `#reports/<id>` opens one report; `#reports` the overview. */
function useReportId() {
  const read = () => location.hash.match(/^#reports\/([\w-]+)/)?.[1] ?? null;
  const [id, setId] = useState(read);
  useEffect(() => {
    const on = () => setId(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return id;
}

function PassBar({ value, palette = 'green' }: { value: number; palette?: string }) {
  return (
    <Progress.Root value={Math.round(value * 100)} size="xs" colorPalette={palette} w="120px" aria-label={`${Math.round(value * 100)}%`}>
      <Progress.Track>
        <Progress.Range />
      </Progress.Track>
    </Progress.Root>
  );
}

function Overview() {
  const q = useQuery({ queryKey: ['reports', 'overview'], queryFn: () => api<ReportsOverview>('/reports/overview') });
  if (!q.data) return q.isError ? <Notice tone="error">{q.error.message}</Notice> : <Loading rows={4} height="10" label="Loading reports" />;
  const o = q.data;
  if (!o.runs)
    return (
      <Card icon={<LuFileChartColumn />} title="Reports">
        <Empty
          icon={<LuFileChartColumn />}
          title="No test runs yet"
          action={
            <Button asChild size="sm">
              <a href="#campaigns">Start a test run</a>
            </Button>
          }
        >
          Every finished run gets a report with per-device results, bugs and evidence.
        </Empty>
      </Card>
    );
  return (
    <Stack gap="5">
      <SimpleGrid columns={{ base: 2, md: 4 }} gap="4" borderWidth="1px" borderRadius="lg" bg="bg.panel" p="4">
        <Stat label="Test runs" value={o.runs} />
        <Stat label="Device tests" value={o.executions} hint={`${o.by_status.passed ?? 0} passed · ${o.by_status.failed ?? 0} failed · ${o.by_status.error ?? 0} errors`} />
        <Stat label="Pass rate" value={pct(o.pass_rate)} hint="passed ÷ (passed + failed)" />
        <Stat label="Open bugs" value={o.bugs.open} hint={o.bugs.by_severity.critical ? `${o.bugs.by_severity.critical} critical` : undefined} />
      </SimpleGrid>

      <Grid templateColumns={{ base: '1fr', '2xl': 'minmax(0, 1.3fr) minmax(0, 1fr)' }} gap="5" alignItems="start">
        <Card icon={<LuFileChartColumn />} title="Test runs" subtitle="Open a report for per-device results, bugs and evidence; download it as HTML or PDF">
          <Box overflowX="auto">
            <Table.Root size="sm" interactive>
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>Run</Table.ColumnHeader>
                  <Table.ColumnHeader>Result</Table.ColumnHeader>
                  <Table.ColumnHeader>Pass rate</Table.ColumnHeader>
                  <Table.ColumnHeader>When</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {o.recent.map((r) => {
                  const s = r.summary;
                  const judged = s ? s.passed + s.failed : 0;
                  return (
                    <Table.Row key={r.id} cursor="pointer" onClick={() => (location.hash = `reports/${r.id}`)}>
                      <Table.Cell minW="220px">
                        <Text fontWeight="medium">{r.name}</Text>
                        <Text fontSize="xs" color="fg.muted">
                          {r.package_name} {r.version_name ?? ''}
                        </Text>
                      </Table.Cell>
                      <Table.Cell>
                        <HStack gap="1" wrap="wrap">
                          {s && s.passed > 0 && (
                            <CBadge colorPalette="green" variant="subtle">
                              {s.passed} passed
                            </CBadge>
                          )}
                          {s && s.failed > 0 && (
                            <CBadge colorPalette="red" variant="subtle">
                              {s.failed} failed
                            </CBadge>
                          )}
                          {s && s.error > 0 && (
                            <CBadge colorPalette="orange" variant="subtle">
                              {s.error} errors
                            </CBadge>
                          )}
                          {r.status !== 'COMPLETED' && <CBadge variant="outline">{r.status.toLowerCase()}</CBadge>}
                        </HStack>
                      </Table.Cell>
                      <Table.Cell>{judged ? <PassBar value={s!.passed / judged} /> : <Text color="fg.subtle">—</Text>}</Table.Cell>
                      <Table.Cell fontSize="xs" color="fg.muted" whiteSpace="nowrap">
                        {sqlDate(r.created_at)}
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Root>
          </Box>
        </Card>

        <Card icon={<LuSmartphone />} title="Device comparison" subtitle="All runs: how the app does on each device profile">
          <Box overflowX="auto">
            <Table.Root size="sm">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>Device</Table.ColumnHeader>
                  <Table.ColumnHeader>Pass rate</Table.ColumnHeader>
                  <Table.ColumnHeader textAlign="end">Tests</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {o.per_device.map((d) => {
                  const judged = d.passed + d.failed;
                  return (
                    <Table.Row key={d.device_id}>
                      <Table.Cell fontWeight="medium">{d.device_name}</Table.Cell>
                      <Table.Cell>
                        {judged ? (
                          <HStack gap="2">
                            <PassBar value={d.passed / judged} palette={d.failed ? 'orange' : 'green'} />
                            <Text fontSize="xs" className="num">
                              {pct(d.passed / judged)}
                            </Text>
                          </HStack>
                        ) : (
                          <Text fontSize="xs" color="fg.subtle">
                            only infrastructure errors
                          </Text>
                        )}
                      </Table.Cell>
                      <Table.Cell textAlign="end" className="num" fontSize="xs">
                        {d.passed}✓ {d.failed}✗ {d.error ? `${d.error}!` : ''}
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Root>
          </Box>
        </Card>
      </Grid>
    </Stack>
  );
}

function ReportView({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['reports', 'detail', id], queryFn: () => api<Report>(`/reports/${id}`) });
  if (!q.data) return q.isError ? <Notice tone="error">{q.error.message}</Notice> : <Loading rows={5} height="10" label="Building the report" />;
  const r = q.data;
  const t = r.totals;
  const maxLaunch = Math.max(1, ...r.devices.map((d) => d.avg_launch_ms ?? 0));
  const downloadJson = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' }));
    a.download = `playtest-report-${r.campaign.id}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return (
    <Stack gap="5">
      <Flex justify="space-between" align="center" gap="3" wrap="wrap">
        <Button asChild size="sm" variant="ghost">
          <a href="#reports">
            <LuArrowLeft /> All reports
          </a>
        </Button>
        <HStack gap="2" wrap="wrap">
          <Button asChild size="sm" variant="outline">
            <a href={`${API}/reports/${id}/html?download=1`}>
              <LuDownload /> HTML
            </a>
          </Button>
          <Button asChild size="sm" variant="outline">
            <a href={`${API}/reports/${id}/html?print=1`} target="_blank" rel="noreferrer" title="Opens the report and the print dialog — choose “Save as PDF”">
              <LuPrinter /> PDF
            </a>
          </Button>
          <Button size="sm" variant="ghost" onClick={downloadJson}>
            <LuBraces /> JSON
          </Button>
        </HStack>
      </Flex>

      <Card icon={<LuFileChartColumn />} title={r.campaign.name} subtitle={`${r.campaign.status.toLowerCase()} · started ${r.campaign.started_at ? new Date(r.campaign.started_at).toLocaleString() : '—'} · took ${dur(r.campaign.duration_ms)}`}>
        <SimpleGrid columns={{ base: 2, md: 6 }} gap="4">
          <Stat label="Pass rate" value={pct(t.pass_rate)} />
          <Stat label="Devices" value={t.total} />
          <Stat label="Passed" value={t.passed} />
          <Stat label="Failed" value={t.failed} />
          <Stat label="Infra errors" value={t.error} hint="device / emulator problems" />
          <Stat label="Bugs" value={r.bugs.length} />
        </SimpleGrid>
        {r.apk && (
          <Kv
            items={[
              ['App', `${r.apk.package_name ?? '?'} ${r.apk.version_name ?? ''} (code ${r.apk.version_code ?? '?'})`],
              ['File', `${r.apk.filename} · ${fmtBytes(r.apk.size_bytes)}`],
              ['SDK', `min ${r.apk.min_sdk ?? '?'} · target ${r.apk.target_sdk ?? '?'}`],
              ['SHA-256', <Text as="span" fontFamily="mono" fontSize="xs" wordBreak="break-all">{r.apk.sha256}</Text>],
              ['Test', `${r.campaign.config?.flow ?? ''} · ${r.campaign.config?.mode ?? ''} · wait ${r.campaign.config?.launch_wait_seconds ?? ''} s · ${r.campaign.config?.cycles ?? 1} cycle(s)`],
            ]}
          />
        )}
      </Card>

      <Card icon={<LuSmartphone />} title="Device comparison">
        <Box overflowX="auto">
          <Table.Root size="sm">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>Device</Table.ColumnHeader>
                <Table.ColumnHeader>Android</Table.ColumnHeader>
                <Table.ColumnHeader>Result</Table.ColumnHeader>
                <Table.ColumnHeader>Install</Table.ColumnHeader>
                <Table.ColumnHeader>Avg launch</Table.ColumnHeader>
                <Table.ColumnHeader>Duration</Table.ColumnHeader>
                <Table.ColumnHeader>Problem</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {r.devices.map((d) => (
                <Table.Row key={d.execution_id}>
                  <Table.Cell minW="150px">
                    <Text fontWeight="medium">{d.device_name}</Text>
                    <Text fontSize="xs" color="fg.muted">
                      {[d.type, d.model, d.resolution].filter(Boolean).join(' · ')}
                    </Text>
                  </Table.Cell>
                  <Table.Cell whiteSpace="nowrap">{d.android_version ? `${d.android_version} (API ${d.api_level})` : '—'}</Table.Cell>
                  <Table.Cell>
                    <Badge tone={TONE[d.status] ?? 'neutral'}>{d.status}</Badge>
                  </Table.Cell>
                  <Table.Cell className="num">{dur(d.install_ms)}</Table.Cell>
                  <Table.Cell>
                    {d.avg_launch_ms ? (
                      <Stack gap="0.5">
                        <PassBar value={d.avg_launch_ms / maxLaunch} palette={d.slow_start ? 'orange' : 'blue'} />
                        <Text fontSize="xs" className="num">
                          {(d.avg_launch_ms / 1000).toFixed(2)} s{d.slow_start ? ' · slow' : ''}
                        </Text>
                      </Stack>
                    ) : (
                      '—'
                    )}
                  </Table.Cell>
                  <Table.Cell className="num">{dur(d.duration_ms)}</Table.Cell>
                  <Table.Cell fontSize="xs" color="fg.error" maxW="320px">
                    {d.error_summary}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Box>
      </Card>

      <Card title="Bugs" subtitle="Observed facts from this run — open one on Bug Reports for steps, evidence and re-test">
        {r.bugs.length === 0 ? (
          <Text fontSize="sm" color="fg.muted">
            No bugs found in this run.
          </Text>
        ) : (
          <Stack gap="2">
            {r.bugs.map((b) => (
              <Flex key={b.id} gap="3" align="center" wrap="wrap" borderBottomWidth="1px" pb="2" _last={{ borderBottomWidth: 0 }}>
                <SeverityBadge s={b.severity} />
                <Box flex="1" minW="200px">
                  <Text fontWeight="medium">{b.title}</Text>
                  <Text fontSize="xs" color="fg.muted">
                    {b.device_name} · confidence {b.confidence !== null ? `${Math.round(b.confidence * 100)}%` : '?'} · {b.status}
                  </Text>
                </Box>
                <Link href="#bugs" fontSize="xs">
                  Bug Reports →
                </Link>
              </Flex>
            ))}
          </Stack>
        )}
      </Card>

      <Card title="Evidence per device" subtitle="Steps, timings and the screen at the end of each test">
        <SimpleGrid columns={{ base: 1, xl: 2 }} gap="4">
          {r.devices.map((d) => {
            const shot = d.evidence.find((e) => e.type === 'screenshot');
            return (
              <Grid key={d.execution_id} templateColumns={shot ? 'minmax(0, 1fr) 120px' : '1fr'} gap="3" borderWidth="1px" borderRadius="md" p="3" alignItems="start">
                <Stack gap="2" minW="0">
                  <HStack gap="2">
                    <Text fontWeight="semibold">{d.device_name}</Text>
                    <Badge tone={TONE[d.status] ?? 'neutral'}>{d.status}</Badge>
                  </HStack>
                  <Box as="ol" pl="4" fontSize="xs">
                    {d.steps.map((s) => (
                      <li key={s.id}>
                        <Text as="span" fontWeight="medium" color={s.status === 'passed' ? undefined : 'fg.error'}>
                          {s.name}
                        </Text>{' '}
                        — {s.status}
                        {s.duration_ms ? ` · ${dur(s.duration_ms)}` : ''}
                        {s.actual_result && (
                          <Text color="fg.muted" lineClamp={2}>
                            {s.actual_result}
                          </Text>
                        )}
                      </li>
                    ))}
                  </Box>
                  <HStack gap="1" wrap="wrap">
                    {d.evidence
                      .filter((e) => e.type !== 'screenshot')
                      .map((e) => (
                        <Button key={e.id} asChild size="2xs" variant="outline">
                          <a href={`${API}/artifacts/${e.id}`} target="_blank" rel="noreferrer">
                            {evidenceLabel(d.evidence, e)}
                          </a>
                        </Button>
                      ))}
                  </HStack>
                </Stack>
                {shot && (
                  <Link href={`${API}/artifacts/${shot.id}`} target="_blank" rel="noreferrer">
                    <Image src={`${API}/artifacts/${shot.id}`} alt={`Screen on ${d.device_name}`} borderRadius="md" borderWidth="1px" w="120px" loading="lazy" />
                  </Link>
                )}
              </Grid>
            );
          })}
        </SimpleGrid>
      </Card>
    </Stack>
  );
}

/** Reports: overview across runs, and a per-run report with HTML / PDF / JSON export. */
export function ReportsPage() {
  const id = useReportId();
  return id ? <ReportView id={id} /> : <Overview />;
}
