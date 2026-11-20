import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Box, Button, Flex, HStack, IconButton, NativeSelect, Progress, SimpleGrid, Stack, Table, Text } from '@chakra-ui/react';
import { LuMemoryStick, LuPower, LuTimerOff } from 'react-icons/lu';
import { api } from '../../lib/api';
import { qk, useHostRam } from '../../lib/queries';
import { Badge, Card, Loading, SubHeading } from '../../components/ui';
import { notify } from '../../components/toaster';
import { RamSaverDialog, fmtMb } from '../dev/RamSaver';

const IDLE_OPTIONS = [0, 10, 20, 30, 60];
const idle = (s: number) => (s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`);

/**
 * RAM saver for the PC: memory per emulator and per app, idle emulators, and auto-stop for headless emulators
 * nobody is using. Freeing RAM inside an emulator opens the device RAM saver.
 */
export function RamCard({ id }: { id?: string }) {
  const qc = useQueryClient();
  const q = useHostRam(6000);
  const r = q.data;
  const [busy, setBusy] = useState<string | null>(null);
  const [inside, setInside] = useState<{ serial: string; title: string } | null>(null);

  const reload = () => qc.invalidateQueries({ queryKey: qk.hostRam });
  const act = async (key: string, fn: () => Promise<void>) => {
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

  const stopIdle = () =>
    act('idle', async () => {
      const res = await api<{ stopped: string[]; failed: { avd_name: string; error: string }[] }>('/emulators/stop-idle', { method: 'POST', body: JSON.stringify({ idle_minutes: 10 }) });
      if (res.stopped.length) notify('ok', `Stopped ${res.stopped.join(', ')} — RAM is back for other work.`);
      else notify('info', 'No emulator has been idle for 10+ minutes.');
      for (const f of res.failed) notify('error', `${f.avd_name}: ${f.error}`);
    });
  const setAuto = (minutes: number) =>
    act('auto', async () => {
      await api('/emulators/settings', { method: 'PUT', body: JSON.stringify({ idle_stop_minutes: minutes }) });
      notify('ok', minutes ? `Headless emulators now stop after ${minutes} min without use.` : 'Auto-stop is off.');
    });
  const stopOne = (serial: string, name: string) =>
    act(`stop-${serial}`, async () => {
      if (!confirm(`Stop ${name}?`)) return;
      await api(`/adb/devices/${encodeURIComponent(serial)}/emu-stop`, { method: 'POST', body: '{}' });
      notify('ok', `${name} stopped`);
    });

  const tone = (pct: number | null) => (pct === null ? 'gray' : pct >= 90 ? 'red' : pct >= 75 ? 'orange' : 'green');
  const emuTotal = r?.emulators.reduce((s, e) => s + (e.mem_mb ?? 0), 0) ?? 0;

  return (
    <Card
      id={id}
      icon={<LuMemoryStick />}
      title="Memory (RAM saver)"
      subtitle="What uses this PC's RAM, and freeing it — inside emulators too"
      actions={
        r && r.emulators.length > 0 ? (
          <Button size="xs" variant="outline" onClick={() => void stopIdle()} loading={busy === 'idle'} title="Stop every emulator not used for 10+ minutes (never one a test run or flutter run is using)">
            <LuTimerOff /> Stop idle emulators
          </Button>
        ) : undefined
      }
    >
      {!r ? (
        <Loading rows={4} height="6" label="Reading memory use" />
      ) : (
        <Stack gap="5">
          <Stack gap="1.5">
            <Flex justify="space-between" fontSize="sm" gap="2" wrap="wrap">
              <Text fontWeight="medium">
                PC: {fmtMb(r.available_mb)} free of {fmtMb(r.total_mb)}
              </Text>
              <Text color="fg.muted" className="num">
                {r.used_pct ?? '—'} % used{emuTotal ? ` · emulators ${fmtMb(emuTotal)}` : ''}
              </Text>
            </Flex>
            <Progress.Root value={r.used_pct ?? 0} size="sm" colorPalette={tone(r.used_pct)} aria-label="PC memory used">
              <Progress.Track>
                <Progress.Range />
              </Progress.Track>
            </Progress.Root>
            {(r.used_pct ?? 0) >= 85 && (
              <Text fontSize="xs" color="fg.warning">
                RAM is nearly full — emulators get slow and Windows starts compressing memory. Stop idle emulators or close apps below.
              </Text>
            )}
          </Stack>

          <Stack gap="2">
            <SubHeading>Emulators</SubHeading>
            {r.emulators.length === 0 ? (
              <Text fontSize="sm" color="fg.muted">
                No emulator is running.
              </Text>
            ) : (
              <Box overflowX="auto" borderWidth="1px" borderRadius="md">
                <Table.Root size="sm">
                  <Table.Header>
                    <Table.Row>
                      <Table.ColumnHeader>Emulator</Table.ColumnHeader>
                      <Table.ColumnHeader textAlign="end">PC RAM</Table.ColumnHeader>
                      <Table.ColumnHeader>Last used</Table.ColumnHeader>
                      <Table.ColumnHeader aria-label="Actions" />
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {r.emulators.map((e) => (
                      <Table.Row key={e.serial}>
                        <Table.Cell minW="180px">
                          <Text fontWeight="medium">{e.avd_name}</Text>
                          <HStack gap="1" mt="0.5" wrap="wrap">
                            <Badge tone={e.booted ? 'good' : 'warning'}>{e.booted ? 'ready' : 'booting'}</Badge>
                            {e.headless !== null && <Badge tone="neutral">{e.headless ? 'headless' : 'window'}</Badge>}
                            {e.busy && <Badge tone="warning">test run</Badge>}
                            {e.flutter && <Badge tone="warning">flutter run</Badge>}
                          </HStack>
                        </Table.Cell>
                        <Table.Cell textAlign="end" whiteSpace="nowrap" className="num">
                          {fmtMb(e.mem_mb)}
                          <Text fontSize="2xs" color="fg.muted">
                            guest {fmtMb(e.guest_ram_mb)}
                          </Text>
                        </Table.Cell>
                        <Table.Cell whiteSpace="nowrap" fontSize="xs" color={e.idle_s >= 600 && !e.busy && !e.flutter ? 'fg.warning' : 'fg.muted'}>
                          {e.busy || e.flutter ? 'in use' : idle(e.idle_s) === 'just now' ? 'just now' : `${idle(e.idle_s)} ago`}
                        </Table.Cell>
                        <Table.Cell>
                          <HStack gap="1" justify="flex-end">
                            <Button size="2xs" variant="outline" disabled={!e.booted || e.busy} onClick={() => setInside({ serial: e.serial, title: e.avd_name })} title="Close background apps inside this emulator">
                              <LuMemoryStick /> Free RAM inside
                            </Button>
                            <IconButton
                              size="2xs"
                              variant="ghost"
                              colorPalette="red"
                              aria-label={`Stop ${e.avd_name}`}
                              title={e.busy ? 'A test run is using it' : 'Stop this emulator — gives its RAM back to the PC'}
                              disabled={e.busy}
                              loading={busy === `stop-${e.serial}`}
                              onClick={() => void stopOne(e.serial, e.avd_name)}
                            >
                              <LuPower />
                            </IconButton>
                          </HStack>
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Root>
              </Box>
            )}
            <Flex gap="3" align="center" wrap="wrap" fontSize="sm">
              <Text>Auto-stop headless emulators unused for</Text>
              <NativeSelect.Root size="xs" w="auto" disabled={busy === 'auto'}>
                <NativeSelect.Field value={String(r.idle_stop_minutes)} onChange={(e) => void setAuto(Number(e.target.value))} aria-label="Auto-stop after">
                  {[...new Set([...IDLE_OPTIONS, r.idle_stop_minutes])].sort((a, b) => a - b).map((m) => (
                    <option key={m} value={m}>
                      {m ? `${m} min` : 'never (off)'}
                    </option>
                  ))}
                </NativeSelect.Field>
                <NativeSelect.Indicator />
              </NativeSelect.Root>
              <Text fontSize="xs" color="fg.muted">
                Only headless ones PlayTest started — never one with a window, a test run or a flutter run session. They start again in seconds (fast boot).
              </Text>
            </Flex>
          </Stack>

          <Stack gap="2">
            <SubHeading>Biggest apps on this PC</SubHeading>
            <SimpleGrid columns={{ base: 1, md: 2 }} gap="2">
              {r.top.map((t) => (
                <Box key={t.label} borderWidth="1px" borderRadius="md" px="3" py="2">
                  <Flex justify="space-between" gap="2">
                    <Text fontSize="sm" fontWeight="medium" truncate title={t.label}>
                      {t.label}
                      {t.count > 1 && (
                        <Text as="span" color="fg.muted" fontWeight="normal">
                          {' '}
                          · {t.count}
                        </Text>
                      )}
                    </Text>
                    <Text fontSize="sm" className="num" flexShrink={0}>
                      {fmtMb(t.mb)}
                    </Text>
                  </Flex>
                  <Progress.Root value={r.total_mb ? (t.mb / r.total_mb) * 100 : 0} size="xs" mt="1.5" colorPalette="gray">
                    <Progress.Track>
                      <Progress.Range />
                    </Progress.Track>
                  </Progress.Root>
                  {t.tip && (
                    <Text fontSize="xs" color="fg.muted" mt="1">
                      {t.tip}
                    </Text>
                  )}
                </Box>
              ))}
            </SimpleGrid>
            <Text fontSize="xs" color="fg.muted">
              PlayTest only lists these — close them yourself if you don't need them. Lower the RAM per emulator with EMULATOR_RAM_MB, or when creating an AVD.
            </Text>
          </Stack>
        </Stack>
      )}
      {inside && <RamSaverDialog serial={inside.serial} title={inside.title} isEmulator open onClose={() => setInside(null)} />}
    </Card>
  );
}
