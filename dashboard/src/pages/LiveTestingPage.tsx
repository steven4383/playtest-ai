import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge as CBadge, Box, Button, Flex, Grid, HStack, Progress, Spinner, Stack, Switch, Table, Text, chakra } from '@chakra-ui/react';
import { LuActivity, LuCircleCheck, LuCircleMinus, LuCircleX, LuFileChartColumn, LuPause, LuPlay, LuSquare, LuTriangleAlert } from 'react-icons/lu';
import { API, api, dev, type AdbDevice, type Campaign, type CampaignListItem, type Execution, type ExecutionStep, type LogLine } from '../lib/api';
import type { Live } from '../lib/useLive';
import { useScrcpy } from '../lib/queries';
import { Badge, Card, Empty, Loading, type Tone } from '../components/ui';
import { notify } from '../components/toaster';
import { LiveThumb, LiveViewDialog, openMirror } from './campaigns/LiveDevices';

const EXEC_TONE: Record<string, Tone> = { passed: 'good', failed: 'critical', error: 'serious', running: 'warning', queued: 'neutral', skipped: 'neutral', cancelled: 'neutral' };
const fmtDur = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
const since = (iso: string | null) => (iso ? Date.now() - new Date(iso).getTime() : 0);

function StepIcon({ status }: { status: ExecutionStep['status'] }) {
  if (status === 'running') return <Spinner size="xs" color="orange.fg" />;
  const map = { passed: [LuCircleCheck, 'green.fg'], failed: [LuCircleX, 'red.fg'], error: [LuTriangleAlert, 'orange.fg'], skipped: [LuCircleMinus, 'fg.subtle'] } as const;
  const [Icon, color] = map[status];
  return (
    <Box color={color} flexShrink={0}>
      <Icon />
    </Box>
  );
}

/** Live app log for the device under test (only this app's lines, or everything). */
function LogTail({ serial, pkg }: { serial: string; pkg: string | null }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [state, setState] = useState('connecting');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setLines([]);
    const q = new URLSearchParams({ tail: '150' });
    if (pkg) q.set('pkg', pkg);
    const es = new EventSource(`${API}${dev(serial, `/logcat?${q}`)}`);
    es.addEventListener('ready', () => setState('live'));
    es.addEventListener('lines', (m) => setLines((l) => [...l, ...(JSON.parse((m as MessageEvent).data) as LogLine[])].slice(-400)));
    es.addEventListener('end', () => {
      setState('ended');
      es.close();
    });
    es.onerror = () => setState('ended');
    return () => es.close();
  }, [serial, pkg]);
  const shown = errorsOnly ? lines.filter((l) => l.level === 'E' || l.level === 'F' || l.level === 'W') : lines;
  useEffect(() => {
    const el = box.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [shown.length]);
  return (
    <Stack gap="1.5" minW="0">
      <Flex justify="space-between" align="center" gap="2" wrap="wrap">
        <Text fontSize="xs" color="fg.muted">
          App log {state === 'live' ? '· live' : state === 'connecting' ? '· connecting…' : '· stopped'}
          {pkg ? ` · ${pkg}` : ''}
        </Text>
        <Switch.Root size="sm" checked={errorsOnly} onCheckedChange={(e) => setErrorsOnly(e.checked)}>
          <Switch.HiddenInput />
          <Switch.Control />
          <Switch.Label fontSize="xs">Warnings & errors only</Switch.Label>
        </Switch.Root>
      </Flex>
      <Box ref={box} h="220px" overflowY="auto" bg="gray.950" color="gray.200" borderRadius="md" p="2" fontFamily="mono" fontSize="11px" lineHeight="1.45">
        {shown.length === 0 ? (
          <Text color="gray.500">{state === 'connecting' ? 'Connecting to logcat…' : 'No log lines yet.'}</Text>
        ) : (
          shown.map((l, i) => (
            <div key={i} className="log-line">
              <chakra.span color={`log.${l.level}`}>{l.level}</chakra.span> <chakra.span color="gray.400">{l.tag}</chakra.span> {l.msg}
            </div>
          ))
        )}
      </Box>
    </Stack>
  );
}

function RunningExecution({ e, pkg, canMirror, onView }: { e: Execution; pkg: string | null; canMirror: boolean; onView: (d: AdbDevice) => void }) {
  const current = e.steps.find((s) => s.status === 'running') ?? null;
  const asDevice: AdbDevice | null = e.serial
    ? ({ serial: e.serial, state: 'device', model: e.device_name, avd_name: e.device_name, connection: e.serial.startsWith('emulator-') ? 'emulator' : 'usb', busy: true } as unknown as AdbDevice)
    : null;
  return (
    <Box borderWidth="1px" borderRadius="lg" p="4" bg="bg.subtle">
      <Grid templateColumns={{ base: '1fr', md: '220px minmax(0, 1fr)', xl: '260px minmax(0, 1fr) minmax(0, 1fr)' }} gap="4" alignItems="start">
        <Stack gap="2">
          {e.serial ? (
            <LiveThumb serial={e.serial} fast height="420px" label={e.device_name ?? e.serial} onClick={() => asDevice && onView(asDevice)} />
          ) : (
            <Flex h="200px" align="center" justify="center" borderWidth="1px" borderStyle="dashed" borderRadius="lg" fontSize="xs" color="fg.muted" gap="2">
              <Spinner size="xs" /> Getting the device ready…
            </Flex>
          )}
          {asDevice && (
            <HStack gap="1">
              <Button size="2xs" variant="outline" flex="1" onClick={() => onView(asDevice)}>
                Control
              </Button>
              <Button size="2xs" variant="outline" flex="1" disabled={!canMirror} onClick={() => void openMirror(asDevice)}>
                Mirror
              </Button>
            </HStack>
          )}
        </Stack>
        <Stack gap="3" minW="0">
          <Box>
            <HStack gap="2" wrap="wrap">
              <Text fontFamily="heading" fontWeight="semibold">
                {e.device_name}
              </Text>
              <Badge tone="warning">testing</Badge>
              {e.serial && (
                <Text fontSize="xs" fontFamily="mono" color="fg.muted">
                  {e.serial}
                </Text>
              )}
            </HStack>
            <Text fontSize="xs" color="fg.muted">
              Running for {fmtDur(since(e.started_at))}
            </Text>
          </Box>
          <Box borderWidth="1px" borderColor="orange.muted" bg="orange.subtle" borderRadius="md" px="3" py="2">
            <Text fontSize="2xs" textTransform="uppercase" letterSpacing="wider" color="orange.fg" fontWeight="semibold">
              Current step
            </Text>
            <Text fontWeight="medium">{current ? current.name : 'Waiting for the next step…'}</Text>
            {current?.started_at && (
              <Text fontSize="xs" color="fg.muted">
                {fmtDur(since(current.started_at))}
              </Text>
            )}
          </Box>
          <Stack gap="1.5" as="ol" aria-label="Steps">
            {e.steps.map((s) => (
              <HStack as="li" key={s.id} gap="2" align="flex-start" fontSize="sm">
                <Box mt="0.5">
                  <StepIcon status={s.status} />
                </Box>
                <Box minW="0">
                  <Text fontWeight={s.status === 'running' ? 'semibold' : 'normal'}>
                    {s.name}
                    {s.duration_ms !== null && s.status !== 'running' && (
                      <Text as="span" color="fg.subtle" fontSize="xs">
                        {' '}
                        · {fmtDur(s.duration_ms)}
                      </Text>
                    )}
                  </Text>
                  {s.actual_result && s.status !== 'running' && (
                    <Text fontSize="xs" color={s.status === 'passed' ? 'fg.muted' : 'fg.error'} lineClamp={2}>
                      {s.actual_result}
                    </Text>
                  )}
                </Box>
              </HStack>
            ))}
          </Stack>
        </Stack>
        <Box gridColumn={{ base: 'auto', md: '1 / -1', xl: 'auto' }} minW="0">
          {e.serial ? <LogTail serial={e.serial} pkg={pkg} /> : null}
        </Box>
      </Grid>
    </Box>
  );
}

function RunPanel({ id, canMirror, onView }: { id: string; canMirror: boolean; onView: (d: AdbDevice) => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['campaigns', 'detail', id], queryFn: () => api<Campaign & { paused?: boolean }>(`/campaigns/${id}`), refetchInterval: 3000, staleTime: 1000 });
  const [busy, setBusy] = useState<string | null>(null);
  const c = q.data;
  if (!c) return <Loading rows={2} height="24" label="Loading the test run" />;
  const s = c.summary;
  const done = s ? s.total - s.running - s.queued : 0;
  const pct = s && s.total ? (done / s.total) * 100 : 0;
  const act = async (what: 'pause' | 'resume' | 'cancel') => {
    if (what === 'cancel' && !confirm('Cancel this test run? The current device stops after its step.')) return;
    setBusy(what);
    try {
      await api(`/campaigns/${id}/${what}`, { method: 'POST', body: '{}' });
      notify('ok', what === 'pause' ? 'Pausing after the current step' : what === 'resume' ? 'Resumed' : 'Cancelling…');
      await qc.invalidateQueries({ queryKey: ['campaigns'] });
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setBusy(null);
    }
  };
  const running = c.executions.filter((e) => e.status === 'running');
  const rest = c.executions.filter((e) => e.status !== 'running');
  return (
    <Card
      icon={<LuActivity />}
      title={c.name}
      subtitle={`${c.package_name ?? ''} ${c.version_name ?? ''} · ${c.config?.mode ?? ''} · ${done} of ${s?.total ?? 0} devices done${c.started_at ? ` · ${fmtDur(since(c.started_at))}` : ''}`}
      actions={
        <>
          {c.paused ? (
            <Button size="xs" colorPalette="green" onClick={() => void act('resume')} loading={busy === 'resume'}>
              <LuPlay /> Resume
            </Button>
          ) : (
            <Button size="xs" variant="outline" onClick={() => void act('pause')} loading={busy === 'pause'} title="Finish the current step, then wait">
              <LuPause /> Pause
            </Button>
          )}
          <Button size="xs" variant="outline" colorPalette="red" onClick={() => void act('cancel')} loading={busy === 'cancel'}>
            <LuSquare /> Cancel
          </Button>
        </>
      }
    >
      <Stack gap="1">
        <Progress.Root value={pct} size="sm" colorPalette={c.paused ? 'yellow' : 'blue'} aria-label="Progress">
          <Progress.Track>
            <Progress.Range />
          </Progress.Track>
        </Progress.Root>
        <HStack gap="2" fontSize="xs" color="fg.muted" wrap="wrap">
          {c.paused && <Badge tone="warning">Paused — resumes from the next step</Badge>}
          {s && (
            <>
              <Text>{s.passed} passed</Text>·<Text color={s.failed ? 'fg.error' : undefined}>{s.failed} failed</Text>·<Text>{s.error} errors</Text>·<Text>{s.queued} waiting</Text>
            </>
          )}
        </HStack>
      </Stack>
      {running.map((e) => (
        <RunningExecution key={e.id} e={e} pkg={c.package_name} canMirror={canMirror} onView={onView} />
      ))}
      {running.length === 0 && (
        <Flex gap="2" align="center" fontSize="sm" color="fg.muted">
          <Spinner size="xs" /> {c.paused ? 'Paused between devices.' : 'Starting the next device…'}
        </Flex>
      )}
      {rest.length > 0 && (
        <Box overflowX="auto">
          <Table.Root size="sm">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>Device</Table.ColumnHeader>
                <Table.ColumnHeader>Result</Table.ColumnHeader>
                <Table.ColumnHeader>Took</Table.ColumnHeader>
                <Table.ColumnHeader>Problem</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rest.map((e) => (
                <Table.Row key={e.id}>
                  <Table.Cell fontWeight="medium">{e.device_name}</Table.Cell>
                  <Table.Cell>
                    <Badge tone={EXEC_TONE[e.status] ?? 'neutral'}>{e.status === 'queued' ? 'waiting' : e.status}</Badge>
                  </Table.Cell>
                  <Table.Cell className="num">{e.started_at && e.completed_at ? fmtDur(new Date(e.completed_at).getTime() - new Date(e.started_at).getTime()) : '—'}</Table.Cell>
                  <Table.Cell color="fg.error" fontSize="xs" maxW="420px">
                    {e.error_summary}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Box>
      )}
    </Card>
  );
}

/** Live Testing: what every running test run is doing right now — screen, step, log, progress, pause / cancel. */
export function LiveTestingPage(_props: { live: Live }) {
  const list = useQuery({ queryKey: ['campaigns', 'list'], queryFn: () => api<CampaignListItem[]>('/campaigns'), refetchInterval: 5000 });
  const canMirror = !!useScrcpy().data?.available;
  const [viewing, setViewing] = useState<AdbDevice | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  if (!list.data) return <Loading rows={3} height="32" label="Looking for running tests" />;
  const running = list.data.filter((c) => c.status === 'RUNNING' || c.status === 'QUEUED');
  const recent = list.data.filter((c) => c.status !== 'RUNNING' && c.status !== 'QUEUED').slice(0, 5);

  return (
    <Stack gap="5">
      {running.length === 0 ? (
        <Card icon={<LuActivity />} title="Live Testing" subtitle="Watch a test run while it happens: the device screen, the current step, the app log and progress.">
          <Empty
            icon={<LuActivity />}
            title="No test is running right now"
            action={
              <Button asChild size="sm">
                <a href="#campaigns">
                  <LuPlay /> Start a test run
                </a>
              </Button>
            }
          >
            Start one on Test runs and it shows up here automatically, with Pause and Cancel.
          </Empty>
        </Card>
      ) : (
        running.map((c) => <RunPanel key={c.id} id={c.id} canMirror={canMirror} onView={setViewing} />)
      )}
      {recent.length > 0 && (
        <Card icon={<LuFileChartColumn />} title="Recently finished" subtitle="Open a report to see per-device results, bugs and evidence">
          <Stack gap="2">
            {recent.map((c) => {
              const s = c.summary;
              return (
                <Flex key={c.id} justify="space-between" align="center" gap="3" wrap="wrap" borderBottomWidth="1px" pb="2" _last={{ borderBottomWidth: 0, pb: 0 }}>
                  <Box minW="0">
                    <Text fontWeight="medium" truncate>
                      {c.name}
                    </Text>
                    <Text fontSize="xs" color="fg.muted">
                      {new Date(c.created_at.replace(' ', 'T') + (c.created_at.includes('Z') ? '' : 'Z')).toLocaleString()} · {c.status.toLowerCase()}
                    </Text>
                  </Box>
                  <HStack gap="2">
                    {s && (
                      <>
                        <CBadge colorPalette="green" variant="subtle">
                          {s.passed} passed
                        </CBadge>
                        {s.failed > 0 && (
                          <CBadge colorPalette="red" variant="subtle">
                            {s.failed} failed
                          </CBadge>
                        )}
                      </>
                    )}
                    <Button asChild size="xs" variant="outline">
                      <a href={`#reports/${c.id}`}>Report</a>
                    </Button>
                  </HStack>
                </Flex>
              );
            })}
          </Stack>
        </Card>
      )}
      <LiveViewDialog device={viewing} canMirror={canMirror} onMirror={(d) => void openMirror(d)} onClose={() => setViewing(null)} />
    </Stack>
  );
}
