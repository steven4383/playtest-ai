'use client';
import { useEffect, useRef, useState } from 'react';
import { Box, Button, Flex, HStack, Spinner, Stack, Text } from '@chakra-ui/react';
import { LuCircleCheck, LuCircleDashed, LuCircleSlash, LuCircleX, LuSquare } from 'react-icons/lu';
import { API, api } from '../../lib/api';
import { trackLabel, type Release, type ReleaseStep } from '../../lib/projects';
import { Badge, Notice, type Tone } from '../../components/ui';
import { notify } from '../../components/toaster';

export const RELEASE_TONE: Record<Release['status'], Tone> = { running: 'warning', succeeded: 'good', failed: 'critical', cancelled: 'neutral' };
export const MODE_LABEL: Record<Release['mode'], string> = { publish: 'Release', dry_run: 'Dry run', build: 'Build only' };
const secs = (ms?: number) => (ms === undefined ? '' : ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

function StepIcon({ state }: { state: ReleaseStep['state'] }) {
  if (state === 'running') return <Spinner size="sm" color="colorPalette.fg" />;
  if (state === 'done') return <Box color="green.fg"><LuCircleCheck /></Box>;
  if (state === 'failed') return <Box color="red.fg"><LuCircleX /></Box>;
  if (state === 'skipped') return <Box color="fg.subtle"><LuCircleSlash /></Box>;
  return <Box color="fg.subtle"><LuCircleDashed /></Box>;
}

/** The pipeline of one release as a row of steps — compact, used in the live view and history. */
export function Steps({ steps }: { steps: ReleaseStep[] }) {
  return (
    <Flex gap="2" wrap="wrap">
      {steps.map((s) => (
        <HStack
          key={s.id}
          gap="2"
          borderWidth="1px"
          borderRadius="lg"
          px="3"
          py="2"
          flex="1"
          minW="150px"
          colorPalette="purple"
          bg={s.state === 'running' ? 'colorPalette.subtle' : s.state === 'failed' ? 'red.subtle' : 'bg.panel'}
          borderColor={s.state === 'running' ? 'colorPalette.muted' : s.state === 'failed' ? 'red.muted' : 'border'}
          title={s.detail}
          align="flex-start"
        >
          <Box pt="0.5" fontSize="md">
            <StepIcon state={s.state} />
          </Box>
          <Box minW="0">
            <Text fontSize="sm" fontWeight="medium">
              {s.label}
            </Text>
            <Text fontSize="2xs" color={s.state === 'failed' ? 'fg.error' : 'fg.muted'} lineClamp={2}>
              {s.detail ?? (s.state === 'pending' ? 'Waiting' : s.state === 'running' ? 'Working…' : '')}
              {s.ms !== undefined && s.state !== 'pending' && s.state !== 'skipped' ? ` · ${secs(s.ms)}` : ''}
            </Text>
          </Box>
        </HStack>
      ))}
    </Flex>
  );
}

/** Live view of a release: steps, result and the full build log (streamed while it runs). */
export function ReleaseView({ releaseId }: { releaseId: string }) {
  const [rel, setRel] = useState<Release | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setRel(null);
    setLines([]);
    const es = new EventSource(`${API}/releases/${releaseId}/stream`);
    es.addEventListener('release', (m) => setRel(JSON.parse((m as MessageEvent).data)));
    es.addEventListener('lines', (m) => {
      const add = JSON.parse((m as MessageEvent).data) as string[];
      setLines((l) => [...l, ...add].slice(-3000));
    });
    es.onerror = () => es.close(); // finished releases end the stream
    return () => es.close();
  }, [releaseId]);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, follow]);

  const cancel = async () => {
    try {
      await api(`/releases/${releaseId}/cancel`, { method: 'POST', body: '{}' });
    } catch (e: any) {
      notify('error', e.message);
    }
  };

  if (!rel) return <Text fontSize="sm" color="fg.muted">Connecting…</Text>;
  const target = rel.mode === 'build' ? 'local build' : `${trackLabel(rel.track)}${rel.release_status === 'inProgress' && rel.user_fraction ? ` · ${Math.round(rel.user_fraction * 100)}% rollout` : rel.release_status === 'draft' ? ' · draft' : ''}`;
  return (
    <Stack gap="3">
      <Flex justify="space-between" align="center" gap="2" wrap="wrap">
        <HStack gap="2" wrap="wrap">
          <Badge tone={RELEASE_TONE[rel.status]}>{rel.status === 'running' ? 'running' : rel.status}</Badge>
          <Text fontWeight="semibold">
            {MODE_LABEL[rel.mode]} {rel.version_after ?? rel.version_before ?? ''}
          </Text>
          <Text fontSize="sm" color="fg.muted">
            → {target}
          </Text>
        </HStack>
        {rel.status === 'running' && (
          <Button size="xs" variant="outline" colorPalette="red" onClick={() => void cancel()}>
            <LuSquare /> Cancel
          </Button>
        )}
      </Flex>
      <Steps steps={rel.steps} />
      {rel.status === 'succeeded' && (
        <Notice tone="success" title={rel.mode === 'publish' ? `Version ${rel.version_after} is on ${trackLabel(rel.track)}` : rel.mode === 'dry_run' ? 'Dry run passed' : 'Build ready'}>
          {rel.mode === 'publish'
            ? 'Testers on that track get it once Google finishes processing (usually minutes; production may need review).'
            : rel.mode === 'dry_run'
              ? 'Google Play accepted everything — a real release with these settings will work. Nothing was published and pubspec.yaml is unchanged.'
              : 'The signed App Bundle is saved with this release.'}
        </Notice>
      )}
      {rel.warning && <Notice tone="warning">{rel.warning}</Notice>}
      {rel.status === 'failed' && rel.error && <Notice tone="error" title="Release stopped">{rel.error}</Notice>}
      <Box>
        <Flex justify="space-between" align="center" mb="1">
          <Text fontSize="xs" color="fg.muted">
            Log ({lines.length} lines)
          </Text>
          <Button size="2xs" variant="ghost" onClick={() => setFollow((f) => !f)}>
            {follow ? 'Stop following' : 'Follow'}
          </Button>
        </Flex>
        <Box
          ref={box}
          as="pre"
          fontFamily="mono"
          fontSize="xs"
          bg="gray.950"
          color="gray.100"
          borderRadius="md"
          p="3"
          h="280px"
          overflow="auto"
          whiteSpace="pre-wrap"
          wordBreak="break-word"
          onScroll={(e) => {
            const el = e.currentTarget;
            if (el.scrollHeight - el.scrollTop - el.clientHeight > 40) setFollow(false);
          }}
        >
          {lines.map((l, i) => (
            <Box key={i} color={l.startsWith('──') ? 'purple.300' : l.startsWith('✖') ? 'red.300' : /^(Uploaded|Committed|Released|Dry run)/.test(l) ? 'green.300' : undefined}>
              {l}
            </Box>
          ))}
        </Box>
      </Box>
    </Stack>
  );
}
