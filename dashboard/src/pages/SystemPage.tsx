import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Box, Checkbox, Flex, Grid, HStack, List, SimpleGrid, Slider, Stack, Table, Text } from '@chakra-ui/react';
import { LuCpu, LuGauge, LuHardDrive, LuMemoryStick, LuMonitorSmartphone, LuServer, LuTimer } from 'react-icons/lu';
import { api, fmtDuration, type Estimate, type SystemInfo } from '../lib/api';
import type { Live } from '../lib/useLive';
import { Sparkline } from '../components/Sparkline';
import { Badge, Card, Kv, Loading, Meter, Spinning, Stat, type Tone } from '../components/ui';

const STATUS_TONE: Record<string, Tone> = { comfortable: 'good', tight: 'warning', insufficient: 'critical' };
const FACTOR_LABEL = { ram: 'RAM', cpu: 'CPU threads', vram: 'GPU memory' } as const;

function Big({ children, sub }: { children: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <Flex align="baseline" gap="2" wrap="wrap">
      <Text fontFamily="heading" fontSize="2xl" fontWeight="semibold" className="num">
        {children}
      </Text>
      {sub && (
        <Text fontSize="xs" color="fg.muted">
          {sub}
        </Text>
      )}
    </Flex>
  );
}

export function SystemPage({ live }: { live: Live }) {
  const { metrics: m, capacity: cap, history } = live;
  // Hardware info doesn't change while the app runs: fetch once per session.
  const info = useQuery({ queryKey: ['system', 'info'], staleTime: Infinity, queryFn: () => api<SystemInfo>('/system/info') }).data ?? null;

  if (!m || !cap) return <Spinning label="Waiting for the first metrics sample from the backend…" />;

  const times = history.map((h) => h.ts);
  const gpu = m.gpu.find((g) => g.is_discrete) ?? m.gpu[0];
  const vramPct = gpu?.vram_mb && gpu.vram_used_mb !== null ? (gpu.vram_used_mb / gpu.vram_mb) * 100 : null;
  const otherGb = Math.max(0, m.memory.used_gb - (m.processes.emulator_mem_gb ?? 0) - m.processes.backend_rss_mb / 1024);
  const limitMax = Math.max(cap.limits.ram, cap.limits.cpu, cap.limits.vram ?? 0, 1);

  return (
    <Stack gap="5">
      <Grid templateColumns={{ base: '1fr', xl: '2fr 1fr' }} gap="5" alignItems="start">
        <Card
          icon={<LuGauge />}
          title="Device capacity"
          subtitle="How many Android emulators this machine can run at the same time"
          actions={<Badge tone={STATUS_TONE[cap.status]}>{cap.status}</Badge>}
        >
          <Grid templateColumns={{ base: '1fr', md: 'auto 1fr' }} gap="6" alignItems="center">
            <HStack gap="3">
              <Text fontFamily="heading" fontSize="6xl" fontWeight="bold" lineHeight="1" color="colorPalette.fg" className="num">
                {cap.recommended_concurrent}
              </Text>
              <Text color="fg.muted" fontSize="sm">
                concurrent emulator{cap.recommended_concurrent === 1 ? '' : 's'}
                <br />
                limited by <b>{FACTOR_LABEL[cap.limiting_factor]}</b>
              </Text>
            </HStack>
            <Stack gap="2.5">
              {(
                [
                  ['RAM', cap.limits.ram, `${m.memory.total_gb.toFixed(1)} GB total − ${info?.limits.reserved_ram_gb ?? 4.5} GB reserved ÷ ${cap.per_emulator.ram_gb} GB each`],
                  ['CPU', cap.limits.cpu, `${info?.cpu.threads ?? '?'} threads ÷ 2 per emulator − 1 for host`],
                  ['GPU', cap.limits.vram, gpu?.vram_mb ? `${gpu.vram_mb} MB VRAM ÷ ~${cap.per_emulator.vram_mb} MB each` : 'No discrete GPU detected'],
                ] as const
              ).map(([name, val, why]) => {
                const isLimit = FACTOR_LABEL[cap.limiting_factor].startsWith(name);
                return (
                  <Grid key={name} templateColumns="40px 1fr 28px" gap="2" alignItems="center" title={why}>
                    <Text fontSize="xs" fontWeight="medium">
                      {name}
                    </Text>
                    <Box>
                      <Box h="2" bg="bg.muted" borderRadius="full" overflow="hidden">
                        {val !== null && <Box h="100%" w={`${(Math.min(val, limitMax) / limitMax) * 100}%`} bg={isLimit ? 'orange.solid' : 'colorPalette.solid'} borderRadius="full" />}
                      </Box>
                      <Text fontSize="2xs" color="fg.muted" mt="0.5" truncate>
                        {why}
                      </Text>
                    </Box>
                    <Text className="num" fontWeight="semibold" textAlign="right">
                      {val ?? '—'}
                    </Text>
                  </Grid>
                );
              })}
            </Stack>
          </Grid>
          <SimpleGrid columns={{ base: 2, md: 4 }} gap="4" pt="2" borderTopWidth="1px">
            <Stat label="Can start right now" value={cap.startable_now} hint={`${m.memory.available_gb.toFixed(1)} GB free`} />
            <Stat label="Running / limit" value={`${m.emulators.running} / ${cap.configured_max}`} hint="MAX_CONCURRENT_EMULATORS" />
            <Stat label="Each emulator costs" value={cap.per_emulator.ram_gb} unit=" GB" hint={`${cap.per_emulator.cpu_threads} threads · ${cap.per_emulator.disk_gb} GB disk`} />
            <Stat label="Device profiles" value="12" hint="configurable, run in a queue" />
          </SimpleGrid>
          {cap.advice.length > 0 && (
            <List.Root gap="1" fontSize="sm" color="fg.muted" ps="4">
              {cap.advice.map((a) => (
                <List.Item key={a}>{a}</List.Item>
              ))}
            </List.Root>
          )}
          {cap.upgrade_paths.length > 0 && (
            <Box>
              <Text fontSize="xs" color="fg.muted" mb="1">
                If you upgrade RAM (same CPU and GPU)
              </Text>
              <Table.Root size="sm" variant="outline">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>RAM</Table.ColumnHeader>
                    <Table.ColumnHeader textAlign="end">Emulators at once</Table.ColumnHeader>
                    <Table.ColumnHeader>Then limited by</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {cap.upgrade_paths.map((u) => (
                    <Table.Row key={u.ram_gb}>
                      <Table.Cell>{u.ram_gb} GB</Table.Cell>
                      <Table.Cell textAlign="end">{u.concurrent}</Table.Cell>
                      <Table.Cell>{FACTOR_LABEL[u.limited_by as keyof typeof FACTOR_LABEL]}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Box>
          )}
        </Card>
        <Estimator recommended={Math.min(cap.recommended_concurrent, cap.configured_max)} />
      </Grid>

      <SimpleGrid columns={{ base: 1, md: 2, '2xl': 4 }} gap="5">
        <Card icon={<LuCpu />} title="CPU" subtitle={info?.cpu.brand}>
          <Big sub={`${m.cpu.speed_ghz ? `${m.cpu.speed_ghz.toFixed(2)} GHz` : ''}${m.cpu.temperature_c ? ` · ${m.cpu.temperature_c.toFixed(0)}°C` : ''}`}>{m.cpu.load_pct.toFixed(0)}%</Big>
          <Sparkline label="CPU load" unit="%" max={100} values={history.map((h) => h.cpu.load_pct)} times={times} />
          <HStack gap="0.5" h="8" align="flex-end" aria-label="Per-core load">
            {m.cpu.per_core.map((c, i) => (
              <Box key={i} flex="1" h="100%" bg="bg.muted" borderRadius="xs" display="flex" alignItems="flex-end" title={`Thread ${i}: ${c.toFixed(0)}%`}>
                <Box w="100%" h={`${Math.max(4, c)}%`} bg="series.1" borderRadius="xs" />
              </Box>
            ))}
          </HStack>
        </Card>

        <Card icon={<LuMemoryStick />} title="Memory (RAM)" subtitle={`${m.memory.total_gb.toFixed(1)} GB installed`}>
          <Big sub={`${m.memory.available_gb.toFixed(1)} GB free`}>
            {m.memory.used_gb.toFixed(1)}
            <Text as="span" fontSize="sm" color="fg.muted">
              {' '}
              / {m.memory.total_gb.toFixed(1)} GB
            </Text>
          </Big>
          <Sparkline label="RAM used" unit=" GB" max={m.memory.total_gb} values={history.map((h) => h.memory.used_gb)} times={times} />
          <Kv
            items={[
              ['Emulators', <span className="num">{m.processes.emulator_mem_gb === null ? '—' : `${m.processes.emulator_mem_gb.toFixed(2)} GB`}</span>],
              ['PlayTest backend', <span className="num">{m.processes.backend_rss_mb} MB</span>],
              ['Windows + other apps', <span className="num">{otherGb.toFixed(2)} GB</span>],
              ['Swap / page file', <span className="num">{`${m.memory.swap_used_gb.toFixed(1)} / ${m.memory.swap_total_gb.toFixed(1)} GB`}</span>],
            ]}
          />
        </Card>

        <Card icon={<LuMonitorSmartphone />} title="GPU" subtitle={gpu ? gpu.model : 'Not detected'}>
          {gpu ? (
            <>
              <Big sub={gpu.temperature_c ? `${gpu.temperature_c}°C` : gpu.is_discrete ? 'discrete' : 'integrated'}>{gpu.utilization_pct === null ? '—' : `${gpu.utilization_pct.toFixed(0)}%`}</Big>
              <Sparkline label="GPU utilization" unit="%" max={100} values={history.map((h) => h.gpu.find((g) => g.model === gpu.model)?.utilization_pct ?? null)} times={times} />
              {vramPct !== null ? (
                <Meter label="VRAM" pct={vramPct} detail={`${gpu.vram_used_mb} / ${gpu.vram_mb} MB`} />
              ) : (
                <Text fontSize="xs" color="fg.muted">
                  VRAM: {gpu.vram_mb ? `${gpu.vram_mb} MB` : 'unknown'}. Live GPU usage needs NVIDIA drivers (nvidia-smi).
                </Text>
              )}
              <Text fontSize="xs" color="fg.muted">
                Used for emulator screen rendering (-gpu {info?.limits.emulator_gpu_mode ?? 'host'}). AI runs on the Gemini API, not locally.
              </Text>
            </>
          ) : (
            <Text color="fg.muted">No GPU reported. Emulators will fall back to software rendering on the CPU.</Text>
          )}
        </Card>

        <Card icon={<LuHardDrive />} title="Disk" subtitle="AVDs need 6–10 GB each">
          {m.disk.length === 0 && <Loading rows={3} height="8" label="Collecting disk usage" />}
          {m.disk.slice(0, 4).map((d) => (
            <Meter key={d.mount} label={d.mount} pct={d.used_pct} detail={`${d.free_gb.toFixed(0)} GB free of ${d.size_gb.toFixed(0)}`} />
          ))}
        </Card>
      </SimpleGrid>

      <Card icon={<LuServer />} title="Host machine">
        {!info ? (
          <Loading rows={4} />
        ) : (
          <Kv
            cols
            items={[
              ['Computer', [info.host.manufacturer, info.host.model].filter(Boolean).join(' ') || info.host.hostname],
              ['OS', `${info.os.distro} ${info.os.release} (${info.os.arch})`],
              ['CPU', `${info.cpu.brand} · ${info.cpu.physical_cores} cores / ${info.cpu.threads} threads${info.cpu.max_ghz ? ` · up to ${info.cpu.max_ghz} GHz` : ''}`],
              [
                'Virtualization',
                info.cpu.virtualization === null ? <Badge tone="neutral">unknown</Badge> : info.cpu.virtualization ? <Badge tone="good">enabled</Badge> : <Badge tone="critical">disabled — enable SVM in BIOS</Badge>,
              ],
              [
                'RAM',
                `${info.memory.total_gb} GB${info.memory.modules.some((mm) => mm.type) ? ` (${info.memory.modules.map((mm) => `${mm.size_gb} GB ${mm.type}${mm.clock_mhz ? ` ${mm.clock_mhz} MHz` : ''}`).join(' + ')})` : ''}`,
              ],
              ['GPUs', info.gpus.map((g) => `${g.model}${g.vram_mb ? ` (${g.vram_mb} MB)` : ''}`).join(', ') || 'none detected'],
              ['Runtime', `Node.js ${info.node.version}`],
              ['Emulator settings', `${info.limits.emulator_ram_mb} MB guest RAM · GPU ${info.limits.emulator_gpu_mode} · max ${info.limits.max_concurrent_emulators} at once`],
            ]}
          />
        )}
      </Card>
    </Stack>
  );
}

function RangeField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <Slider.Root min={min} max={max} value={[value]} onValueChange={(e) => onChange(e.value[0])} size="sm">
      <HStack justify="space-between">
        <Slider.Label fontWeight="normal">{label}</Slider.Label>
        <Slider.ValueText className="num" fontWeight="semibold" />
      </HStack>
      <Slider.Control>
        <Slider.Track>
          <Slider.Range />
        </Slider.Track>
        <Slider.Thumbs />
      </Slider.Control>
    </Slider.Root>
  );
}

function Estimator({ recommended }: { recommended: number }) {
  const [devices, setDevices] = useState(4);
  const [tests, setTests] = useState(10);
  const [snapshot, setSnapshot] = useState(true);
  const [est, setEst] = useState<Estimate | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      api<Estimate>(`/system/estimate?devices=${devices}&tests=${tests}&snapshot=${snapshot}`).then(setEst).catch(() => {});
    }, 150);
    return () => clearTimeout(t);
  }, [devices, tests, snapshot, recommended]);

  return (
    <Card icon={<LuTimer />} title="Campaign time estimate" subtitle={`Using ${recommended} emulator${recommended === 1 ? '' : 's'} at a time`}>
      <Stack gap="4">
        <RangeField label="Devices enabled" value={devices} min={1} max={12} onChange={setDevices} />
        <RangeField label="Test cases per device" value={tests} min={1} max={50} onChange={setTests} />
        <Checkbox.Root checked={snapshot} onCheckedChange={(e) => setSnapshot(!!e.checked)} size="sm">
          <Checkbox.HiddenInput />
          <Checkbox.Control />
          <Checkbox.Label>Quick-boot snapshots</Checkbox.Label>
        </Checkbox.Root>
      </Stack>
      {!est ? (
        <Loading rows={2} />
      ) : (
        <>
          <Big>
            {fmtDuration(est.total_seconds[0])} – {fmtDuration(est.total_seconds[1])}
          </Big>
          <Text fontSize="xs" color="fg.muted">
            {fmtDuration(est.per_device_seconds[0])}–{fmtDuration(est.per_device_seconds[1])} per device · {est.waves} wave{est.waves === 1 ? '' : 's'} of {est.concurrency}. Estimates — real
            times are recorded per test run.
          </Text>
        </>
      )}
    </Card>
  );
}
