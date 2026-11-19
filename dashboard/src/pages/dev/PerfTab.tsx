import { useEffect, useRef, useState } from 'react';
import { Box, Button, Flex, HStack, SimpleGrid, Stack, Text } from '@chakra-ui/react';
import { LuPause, LuPlay, LuRotateCcw } from 'react-icons/lu';
import { api, dev, type PerfSample } from '../../lib/api';
import { Sparkline } from '../../components/Sparkline';
import { Empty, Notice, Spinning } from '../../components/ui';
import { notify } from '../../components/toaster';

interface Point {
  at: string;
  cpu: number | null;
  mem: number | null;
  fps: number | null;
  jank: number | null;
}
const N = 60; // 2 minutes at 2 s

function Metric({ label, value, unit, values, times, max, color }: { label: string; value: number | null; unit: string; values: (number | null)[]; times: string[]; max?: number; color: string }) {
  return (
    <Box borderWidth="1px" borderRadius="md" p="3" minW="0">
      <Flex justify="space-between" align="baseline" mb="1">
        <Text fontSize="xs" color="fg.muted">
          {label}
        </Text>
        <Text fontFamily="heading" fontSize="xl" fontWeight="semibold" className="num">
          {value === null ? '—' : value.toFixed(unit === ' MB' ? 0 : 1)}
          <Text as="span" fontSize="xs" color="fg.muted">
            {unit}
          </Text>
        </Text>
      </Flex>
      <Sparkline label={label} unit={unit} max={max} values={values} times={times} color={color} height={64} />
    </Box>
  );
}

export function PerfTab({ serial, pkg }: { serial: string; pkg: string }) {
  const [points, setPoints] = useState<Point[]>([]);
  const [running, setRunning] = useState<boolean | null>(null);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prev = useRef<Extract<PerfSample, { running: true }> | null>(null);

  useEffect(() => {
    setPoints([]);
    setRunning(null);
    prev.current = null;
  }, [serial, pkg]);

  useEffect(() => {
    if (!pkg || paused) return;
    let stop = false;
    (async () => {
      while (!stop) {
        const t0 = Date.now();
        if (document.visibilityState === 'visible') {
          try {
            const s = await api<PerfSample>(dev(serial, `/perf?pkg=${encodeURIComponent(pkg)}`));
            if (stop) break;
            setError(null);
            setRunning(s.running);
            if (s.running) {
              const p = prev.current && prev.current.pid === s.pid ? prev.current : null;
              const dt = p ? (s.at - p.at) / 1000 : 0;
              let cpu: number | null = s.cpu_pct;
              if (p && s.proc_ticks !== null && p.proc_ticks !== null && s.total_ticks !== null && p.total_ticks !== null && s.total_ticks > p.total_ticks)
                cpu = ((s.proc_ticks - p.proc_ticks) / (s.total_ticks - p.total_ticks)) * 100;
              let fps: number | null = null;
              let jank: number | null = null;
              if (p && s.frames !== null && p.frames !== null && dt > 0) {
                const df = s.frames - p.frames;
                if (df >= 0) {
                  fps = df / dt;
                  const dj = (s.janky_frames ?? 0) - (p.janky_frames ?? 0);
                  jank = df > 0 ? Math.max(0, (dj / df) * 100) : 0;
                }
              }
              prev.current = s;
              const point: Point = { at: new Date(s.at).toISOString(), cpu: p || cpu !== null ? cpu : null, mem: s.pss_kb !== null ? s.pss_kb / 1024 : null, fps, jank };
              setPoints((list) => [...list, point].slice(-N));
            } else {
              prev.current = null;
            }
          } catch (e: any) {
            setError(e.message);
          }
        }
        const wait = 2000 - (Date.now() - t0);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    })();
    return () => {
      stop = true;
    };
  }, [serial, pkg, paused]);

  const reset = async () => {
    try {
      await api(dev(serial, '/perf/reset'), { method: 'POST', body: JSON.stringify({ pkg }) });
      prev.current = null;
      setPoints([]);
    } catch (e: any) {
      notify('error', e.message);
    }
  };

  if (!pkg) return <Empty title="Pick an app first">Use “App” above (or Select on the Apps tab) to choose which app to measure.</Empty>;

  const times = points.map((p) => p.at);
  const last = points.at(-1);
  return (
    <Stack gap="4">
      <Flex justify="space-between" align="center" gap="2" wrap="wrap">
        <Text fontSize="sm" color="fg.muted">
          Sampling <b>{pkg}</b> every 2 s{running === false ? ' — the app is not running; open it to start measuring' : ''}
        </Text>
        <HStack gap="1.5">
          <Button size="xs" variant="outline" onClick={() => setPaused((p) => !p)}>
            {paused ? <LuPlay /> : <LuPause />} {paused ? 'Resume' : 'Pause'}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => void reset()} title="Reset frame counters and charts">
            <LuRotateCcw /> Reset
          </Button>
        </HStack>
      </Flex>
      {error && <Notice tone="error">{error}</Notice>}
      {running === null && !error ? (
        <Spinning label="Taking the first sample…" />
      ) : (
        <SimpleGrid columns={{ base: 1, md: 2 }} gap="3">
          <Metric label="CPU (of whole device)" value={last?.cpu ?? null} unit="%" max={100} values={points.map((p) => p.cpu)} times={times} color="var(--series-1)" />
          <Metric label="Memory (PSS)" value={last?.mem ?? null} unit=" MB" values={points.map((p) => p.mem)} times={times} color="var(--series-2)" />
          <Metric label="Frames per second" value={last?.fps ?? null} unit=" fps" max={120} values={points.map((p) => p.fps)} times={times} color="var(--series-3)" />
          <Metric label="Janky frames" value={last?.jank ?? null} unit="%" max={100} values={points.map((p) => p.jank)} times={times} color="var(--chakra-colors-orange-500)" />
        </SimpleGrid>
      )}
      <Text fontSize="xs" color="fg.muted">
        FPS only counts frames while the screen changes (an idle app renders 0). Flutter draws on its own surface, so for Flutter apps use Flutter DevTools → Performance for frame
        timing; CPU and memory here still apply.
      </Text>
    </Stack>
  );
}
