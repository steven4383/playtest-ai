import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge as CBadge, Box, Button, Checkbox, Flex, HStack, IconButton, Input, Text, chakra } from '@chakra-ui/react';
import { LuArrowDownToLine, LuDownload, LuEraser, LuPause, LuPlay, LuSearch } from 'react-icons/lu';
import { API, api, dev, type LogLine } from '../../lib/api';
import { notify } from '../../components/toaster';

const LEVELS = ['V', 'D', 'I', 'W', 'E', 'F'] as const;
const LEVEL_NAME: Record<string, string> = { V: 'Verbose', D: 'Debug', I: 'Info', W: 'Warn', E: 'Error', F: 'Fatal' };
const RANK: Record<string, number> = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5, A: 5 };
const MAX = 5000;

function highlight(text: string, q: string) {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

/** Live logcat over SSE. Filtering by package happens on the server (follows the app's pid across restarts). */
export function LogcatTab({ serial, pkg }: { serial: string; pkg: string }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [minLevel, setMinLevel] = useState<string>('V');
  const [mine, setMine] = useState(!!pkg);
  const [query, setQuery] = useState('');
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [status, setStatus] = useState<{ state: 'connecting' | 'live' | 'ended'; note?: string; running?: boolean }>({ state: 'connecting' });
  const box = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const buffer = useRef<LogLine[]>([]);

  useEffect(() => setMine(!!pkg), [pkg]);

  useEffect(() => {
    setLines([]);
    buffer.current = [];
    setStatus({ state: 'connecting' });
    const q = new URLSearchParams({ tail: '400' });
    if (mine && pkg) q.set('pkg', pkg);
    const es = new EventSource(`${API}${dev(serial, `/logcat?${q}`)}`);
    es.addEventListener('ready', () => setStatus((s) => ({ ...s, state: 'live' })));
    es.addEventListener('status', (m) => {
      const d = JSON.parse((m as MessageEvent).data);
      setStatus((s) => ({ ...s, running: d.running }));
    });
    es.addEventListener('lines', (m) => {
      const batch = JSON.parse((m as MessageEvent).data) as LogLine[];
      buffer.current = [...buffer.current, ...batch].slice(-MAX);
      if (!pausedRef.current) setLines(buffer.current);
    });
    es.addEventListener('end', (m) => {
      setStatus({ state: 'ended', note: JSON.parse((m as MessageEvent).data).reason });
      es.close();
    });
    es.onerror = () => setStatus((s) => (s.state === 'ended' ? s : { state: 'ended', note: 'Connection lost' }));
    return () => es.close();
  }, [serial, pkg, mine]);

  useEffect(() => {
    if (!paused) setLines(buffer.current);
  }, [paused]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const min = RANK[minLevel];
    return lines.filter((l) => (RANK[l.level] ?? 0) >= min && (!q || l.msg.toLowerCase().includes(q) || l.tag.toLowerCase().includes(q)));
  }, [lines, minLevel, query]);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown, follow]);

  const clear = async () => {
    try {
      await api(dev(serial, '/logcat/clear'), { method: 'POST', body: '{}' });
      buffer.current = [];
      setLines([]);
    } catch (e: any) {
      notify('error', e.message);
    }
  };

  const download = () => {
    const text = shown.map((l) => `${l.ts} ${String(l.pid).padStart(5)} ${String(l.tid).padStart(5)} ${l.level} ${l.tag}: ${l.msg}`).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = `logcat-${serial.replace(/[^\w.-]/g, '_')}-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <Flex direction="column" gap="3" h={{ base: '70dvh', lg: 'calc(100dvh - 260px)' }} minH="420px">
      <Flex gap="2" wrap="wrap" align="center">
        <HStack gap="1" role="radiogroup" aria-label="Minimum level">
          {LEVELS.map((l) => (
            <Button
              key={l}
              size="2xs"
              role="radio"
              aria-checked={minLevel === l}
              title={`${LEVEL_NAME[l]} and above`}
              variant={minLevel === l ? 'solid' : 'outline'}
              onClick={() => setMinLevel(l)}
              minW="7"
              fontFamily="mono"
              color={minLevel === l ? undefined : `log.${l}`}
            >
              {l}
            </Button>
          ))}
        </HStack>
        <HStack flex="1" minW="160px" gap="1">
          <Box color="fg.muted">
            <LuSearch />
          </Box>
          <Input size="xs" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tag or message" aria-label="Search logs" />
        </HStack>
        <Checkbox.Root size="sm" checked={mine} disabled={!pkg} onCheckedChange={(e) => setMine(!!e.checked)} title={pkg ? `Only ${pkg}` : 'Pick an app above first'}>
          <Checkbox.HiddenInput />
          <Checkbox.Control />
          <Checkbox.Label>My app only</Checkbox.Label>
        </Checkbox.Root>
        <HStack gap="1">
          <IconButton size="xs" variant="outline" aria-label={paused ? 'Resume' : 'Pause'} title={paused ? 'Resume' : 'Pause'} onClick={() => setPaused((p) => !p)}>
            {paused ? <LuPlay /> : <LuPause />}
          </IconButton>
          <IconButton size="xs" variant={follow ? 'subtle' : 'outline'} aria-label="Auto-scroll" title="Auto-scroll to newest" onClick={() => setFollow((f) => !f)}>
            <LuArrowDownToLine />
          </IconButton>
          <IconButton size="xs" variant="outline" aria-label="Clear device log" title="Clear the device log buffer" onClick={() => void clear()}>
            <LuEraser />
          </IconButton>
          <IconButton size="xs" variant="outline" aria-label="Download" title="Download shown lines" onClick={download} disabled={!shown.length}>
            <LuDownload />
          </IconButton>
        </HStack>
      </Flex>

      <Flex justify="space-between" fontSize="xs" color="fg.muted" gap="2" wrap="wrap">
        <HStack gap="2">
          <CBadge size="xs" colorPalette={status.state === 'live' ? (paused ? 'yellow' : 'green') : status.state === 'connecting' ? 'gray' : 'red'} variant="subtle">
            {status.state === 'live' ? (paused ? 'paused' : 'live') : status.state}
          </CBadge>
          {mine && pkg && <Text>{status.running === false ? `${pkg} is not running — start it to see its logs` : `filtered to ${pkg}`}</Text>}
          {status.note && <Text color="fg.error">{status.note}</Text>}
        </HStack>
        <Text className="num">
          {shown.length.toLocaleString()} / {lines.length.toLocaleString()} lines
        </Text>
      </Flex>

      <Box
        ref={box}
        flex="1"
        overflowY="auto"
        bg="bg.subtle"
        borderWidth="1px"
        borderRadius="md"
        px="3"
        py="2"
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (!atBottom && follow) setFollow(false);
        }}
      >
        {shown.length === 0 ? (
          <Text fontSize="sm" color="fg.muted" py="6" textAlign="center">
            {status.state === 'connecting' ? 'Connecting to logcat…' : 'No log lines yet.'}
          </Text>
        ) : (
          shown.map((l, i) => (
            <div key={i} className="log-line">
              <chakra.span color="fg.subtle">{l.ts.slice(6)} </chakra.span>
              <chakra.span color={`log.${l.level === 'A' ? 'F' : l.level}`} fontWeight="bold">
                {l.level}{' '}
              </chakra.span>
              <chakra.span color="fg.muted">{highlight(l.tag, query.trim())}: </chakra.span>
              <chakra.span color={l.level === 'E' || l.level === 'F' ? `log.${l.level}` : undefined}>{highlight(l.msg, query.trim())}</chakra.span>
            </div>
          ))
        )}
      </Box>
    </Flex>
  );
}
