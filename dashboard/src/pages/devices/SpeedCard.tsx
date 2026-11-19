import { useQuery } from '@tanstack/react-query';
import { Code, List, Stack, Text } from '@chakra-ui/react';
import { LuZap } from 'react-icons/lu';
import { api, type EmulatorSpeed } from '../../lib/api';
import { Badge, Card, Kv, Loading } from '../../components/ui';

/** How emulators are tuned on this PC, and what else helps them run smoothly. */
export function SpeedCard({ id }: { id?: string }) {
  const q = useQuery({ queryKey: ['emulators', 'speed'], staleTime: 10 * 60_000, queryFn: () => api<EmulatorSpeed>('/emulators/speed') });
  const s = q.data;
  return (
    <Card id={id} icon={<LuZap />} title="Emulator speed" subtitle="Settings PlayTest uses for every emulator it starts (backend/.env)">
      {!s ? (
        <Loading rows={3} height="5" label="Checking hardware acceleration" />
      ) : (
        <Stack gap="4">
          <Kv
            items={[
              ['Acceleration', <Badge tone={s.acceleration.ok ? 'good' : 'critical'}>{s.acceleration.detail}</Badge>],
              [
                'Fast boot',
                s.fast_boot ? (
                  <Text>
                    On — starts from a clean snapshot in ~5–10 s (the first start of each AVD saves it){' '}
                    <Code size="sm">EMULATOR_FAST_BOOT</Code>
                  </Text>
                ) : (
                  <Text color="fg.warning">Off — every start is a 1–2 min cold boot</Text>
                ),
              ],
              ['CPU cores', `${s.cores} per emulator (PC has ${s.host_threads} threads) · EMULATOR_CORES`],
              ['Memory', `${s.ram_mb} MB per emulator · EMULATOR_RAM_MB`],
              ['Graphics', `${s.gpu_mode === 'host' ? 'host (your GPU)' : s.gpu_mode} · EMULATOR_GPU_MODE`],
              ['Test runs', `${s.headless_default ? 'headless (no window)' : 'with a window'} · animations off · no audio · EMULATOR_HEADLESS`],
            ]}
          />
          <Stack gap="1">
            <Text fontSize="sm" fontWeight="medium">
              For smoother emulators
            </Text>
            <List.Root fontSize="sm" color="fg.muted" ps="4" gap="1">
              <List.Item>Run one emulator at a time when RAM is above ~80 % (System page), and close Android Studio's own emulator.</List.Item>
              <List.Item>Keep emulators running between test runs (untick “Stop emulators after”) — reusing one is instant.</List.Item>
              <List.Item>Prefer x86_64 Google APIs images; Play Store images are heavier. API 33–35 are the smoothest on WHPX.</List.Item>
              <List.Item>Put AVDs and system images on an SSD (Storage section) — a slow disk makes boots and snapshot loads crawl.</List.Item>
              {!s.acceleration.ok && <List.Item color="fg.error">Turn on “Windows Hypervisor Platform” in Windows Features, then restart — without it emulators are 5–10× slower.</List.Item>}
            </List.Root>
          </Stack>
        </Stack>
      )}
    </Card>
  );
}
