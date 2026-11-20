import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Box, Code, Flex, HStack, List, NativeSelect, Stack, Text } from '@chakra-ui/react';
import { LuTerminal, LuZap } from 'react-icons/lu';
import { api, type EmulatorSpeed } from '../../lib/api';
import { useAvds, useTools } from '../../lib/queries';
import { Badge, Card, CopyButton, Kv, Loading } from '../../components/ui';

/** One command line to copy, with what it does and how fast it starts. */
function Cmd({ title, speed, tone, cmd, note }: { title: string; speed: string; tone: 'good' | 'warning' | 'critical'; cmd: string; note: string }) {
  return (
    <Box borderWidth="1px" borderRadius="md" p="3">
      <Flex justify="space-between" align="center" gap="2" wrap="wrap">
        <HStack gap="2">
          <Text fontSize="sm" fontWeight="medium">
            {title}
          </Text>
          <Badge tone={tone}>{speed}</Badge>
        </HStack>
        <CopyButton value={cmd} label="Copy" />
      </Flex>
      <Code display="block" whiteSpace="pre-wrap" wordBreak="break-all" fontSize="xs" mt="2" p="2" w="100%">
        {cmd}
      </Code>
      <Text fontSize="xs" color="fg.muted" mt="1.5">
        {note}
      </Text>
    </Box>
  );
}

/** Starting emulators from a terminal: the fast way vs. -no-snapshot (cold boot every time). */
function TerminalCommands({ s }: { s: EmulatorSpeed }) {
  const avds = useAvds().data ?? [];
  const sdk = useTools().data?.sdk_root;
  const [avd, setAvd] = useState('');
  const name = avd || avds[0] || 'Pixel_Test';
  const exe = sdk ? `"${sdk}\\emulator\\emulator.exe"` : 'emulator';
  const common = `-avd ${name} -no-window -no-audio -no-boot-anim -gpu ${s.gpu_mode} -cores ${s.cores} -memory ${s.ram_mb} -netfast`;
  const t = s.boot_times?.[name];
  const measured = (v?: number) => (v ? `${Math.round(v)} s here` : null);
  return (
    <Stack gap="2">
      <Flex justify="space-between" align="center" gap="2" wrap="wrap">
        <HStack gap="2">
          <LuTerminal />
          <Text fontSize="sm" fontWeight="medium">
            Starting an emulator yourself (terminal)
          </Text>
        </HStack>
        {avds.length > 1 && (
          <NativeSelect.Root size="xs" w="auto">
            <NativeSelect.Field value={name} onChange={(e) => setAvd(e.target.value)} aria-label="AVD">
              {avds.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
        )}
      </Flex>
      <Text fontSize="xs" color="fg.muted">
        PlayTest shows the boot progress of emulators started this way too (Developer page, Test runs, live views).
      </Text>
      <Cmd
        title="Fast and clean every time"
        tone="good"
        speed={measured(t?.fast) ?? '~5–15 s'}
        cmd={`${exe} ${common} -snapshot playtest_clean -no-snapshot-save`}
        note="Resumes the clean snapshot PlayTest saves the first time it starts this AVD (start it once from the dashboard). Nothing you change is kept."
      />
      <Cmd
        title="Fast, keeps its state (Quick Boot)"
        tone="good"
        speed="~5–15 s after the first"
        cmd={`${exe} ${common}`}
        note="Without -no-snapshot the emulator saves its state when it closes and resumes it next time. Close it with: adb -s emulator-5554 emu kill (closing the process hard skips the save)."
      />
      <Cmd
        title="Your command: -no-snapshot"
        tone="critical"
        speed={measured(t?.cold ?? t?.first) ?? '1–3 min'}
        cmd={`${exe} -avd ${name} -no-window -no-audio -no-boot-anim -no-snapshot`}
        note="-no-snapshot neither loads nor saves a snapshot, so every start is a full cold boot. It also leaves the GPU, cores and RAM on defaults (headless may fall back to software rendering)."
      />
    </Stack>
  );
}

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
          <TerminalCommands s={s} />
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
