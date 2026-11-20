import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Box, Button, Checkbox, CloseButton, Dialog, Flex, HStack, Portal, Progress, Stack, Text } from '@chakra-ui/react';
import { LuMemoryStick, LuRefreshCw } from 'react-icons/lu';
import { api, dev, type DeviceMemory, type FreeMemoryResult } from '../../lib/api';
import { qk, useDeviceMemory } from '../../lib/queries';
import { Loading, Notice } from '../../components/ui';
import { notify } from '../../components/toaster';

const GROUP_LABEL: Record<string, string> = {
  Cached: 'cached (not running)',
  'B Services': 'old background service',
  'A Services': 'background service',
  Previous: 'previous app',
};

export const fmtMb = (mb: number | null | undefined) => (mb === null || mb === undefined ? '—' : mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);

/** Where the RAM goes, in three plain buckets. */
function buckets(m: DeviceMemory) {
  const sum = (names: string[]) => m.groups.filter((g) => names.includes(g.name)).reduce((s, g) => s + g.mb, 0);
  return [
    { label: 'Android system', mb: sum(['Native', 'System', 'Persistent', 'Persistent Service']), color: 'blue.solid' },
    { label: 'Apps in use', mb: sum(['Foreground', 'Visible', 'Perceptible', 'Perceptible Medium', 'Perceptible Low', 'Home', 'Heavy Weight', 'Backup']), color: 'orange.solid' },
    { label: 'Background (can be closed)', mb: sum(['A Services', 'Previous', 'B Services', 'Cached']), color: 'green.solid' },
  ];
}

/**
 * RAM saver for one device: shows where its memory goes and frees it by closing background apps and their services
 * (force-stop) plus every cached process Android itself would kill first (am kill-all).
 */
export function RamSaverDialog({ serial, title, isEmulator, open, onClose }: { serial: string; title: string; isEmulator: boolean; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useDeviceMemory(serial, open);
  const m = q.data;
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<FreeMemoryResult | null>(null);
  const [busy, setBusy] = useState(false);

  // Emulators: pre-select every background app (nothing personal there). Phones: let the user choose.
  useEffect(() => {
    if (m) setPicked(new Set(isEmulator ? m.closable.map((c) => c.package) : []));
  }, [m, isEmulator]);
  useEffect(() => {
    if (!open) setResult(null);
  }, [open]);

  const free = async () => {
    if (!m) return;
    if (!isEmulator && picked.size && !confirm(`Close ${picked.size} app${picked.size === 1 ? '' : 's'} on ${title}? They lose unsaved state and start fresh next time.`)) return;
    setBusy(true);
    try {
      const r = await api<FreeMemoryResult>(dev(serial, '/memory/free'), { method: 'POST', body: JSON.stringify({ packages: [...picked] }) });
      setResult(r);
      notify('ok', r.freed_mb !== null ? `Freed ${fmtMb(r.freed_mb)} on ${title}` : `Closed ${r.stopped.length} apps on ${title}`);
      await qc.invalidateQueries({ queryKey: qk.deviceMemory(serial) });
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (pkg: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(pkg)) n.delete(pkg);
      else n.add(pkg);
      return n;
    });

  const pickedMb = m ? m.closable.filter((c) => picked.has(c.package)).reduce((s, c) => s + c.mb, 0) : 0;

  return (
    <Dialog.Root open={open} onOpenChange={(e) => !e.open && onClose()} size="md" placement="center" scrollBehavior="inside">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <HStack gap="2">
                <LuMemoryStick />
                <Dialog.Title fontFamily="heading">RAM saver · {title}</Dialog.Title>
              </HStack>
            </Dialog.Header>
            <Dialog.Body pb="5">
              {!m ? (
                <Stack gap="2">
                  <Text fontSize="xs" color="fg.muted">
                    Reading memory use — dumpsys meminfo takes a few seconds on a phone, up to ~30 s on a busy emulator…
                  </Text>
                  <Loading rows={5} height="7" />
                  {q.error && <Notice tone="error">{q.error.message}</Notice>}
                </Stack>
              ) : (
                <Stack gap="4">
                  <Stack gap="1.5">
                    <Flex justify="space-between" fontSize="sm">
                      <Text fontWeight="medium">
                        {fmtMb(m.available_mb)} free of {fmtMb(m.total_mb)}
                      </Text>
                      <Text color="fg.muted" className="num">
                        {m.used_pct ?? '—'} % used
                      </Text>
                    </Flex>
                    <Flex h="2.5" borderRadius="full" overflow="hidden" bg="bg.muted" aria-label="Memory by kind">
                      {buckets(m).map((b) => (
                        <Box key={b.label} w={`${m.total_mb ? (b.mb / m.total_mb) * 100 : 0}%`} bg={b.color} title={`${b.label}: ${fmtMb(b.mb)}`} />
                      ))}
                    </Flex>
                    <HStack gap="3" wrap="wrap" fontSize="xs" color="fg.muted">
                      {buckets(m).map((b) => (
                        <HStack key={b.label} gap="1">
                          <Box w="2" h="2" borderRadius="full" bg={b.color} />
                          <Text>
                            {b.label} {fmtMb(b.mb)}
                          </Text>
                        </HStack>
                      ))}
                      {m.swap_total_mb > 0 && <Text>· swap {fmtMb(m.swap_used_mb)} / {fmtMb(m.swap_total_mb)}</Text>}
                    </HStack>
                  </Stack>

                  {result && (
                    <Notice tone="success" title={result.freed_mb !== null ? `Freed ${fmtMb(result.freed_mb)}` : 'Done'}>
                      {fmtMb(result.before_mb)} → {fmtMb(result.after_mb)} available · closed {result.stopped.length} app{result.stopped.length === 1 ? '' : 's'} and every
                      cached process{result.skipped.length ? ` · kept ${result.skipped.length} that must stay open` : ''}.
                    </Notice>
                  )}
                  {m.busy && <Notice tone="warning">A test run is using this device — free RAM after it finishes, so the run is not disturbed.</Notice>}

                  <Stack gap="2">
                    <Flex justify="space-between" align="center">
                      <Text fontSize="sm" fontWeight="medium">
                        Background apps ({m.closable.length}) · {fmtMb(m.closable_mb)}
                      </Text>
                      {m.closable.length > 0 && (
                        <Button size="2xs" variant="ghost" onClick={() => setPicked(picked.size === m.closable.length ? new Set() : new Set(m.closable.map((c) => c.package)))}>
                          {picked.size === m.closable.length ? 'Select none' : 'Select all'}
                        </Button>
                      )}
                    </Flex>
                    {m.closable.length === 0 ? (
                      <Text fontSize="sm" color="fg.muted">
                        Nothing in the background to close — memory is already lean.
                      </Text>
                    ) : (
                      <Stack gap="0" maxH="280px" overflowY="auto" borderWidth="1px" borderRadius="md">
                        {m.closable.map((c) => (
                          <Checkbox.Root
                            key={c.package}
                            size="sm"
                            checked={picked.has(c.package)}
                            onCheckedChange={() => toggle(c.package)}
                            px="3"
                            py="1.5"
                            borderBottomWidth="1px"
                            _last={{ borderBottomWidth: 0 }}
                            w="100%"
                          >
                            <Checkbox.HiddenInput />
                            <Checkbox.Control />
                            <Checkbox.Label flex="1" minW="0">
                              <Flex justify="space-between" gap="2">
                                <Box minW="0">
                                  <Text fontSize="sm" fontFamily="mono" truncate>
                                    {c.package}
                                  </Text>
                                  <Text fontSize="2xs" color="fg.muted">
                                    {GROUP_LABEL[c.group] ?? c.group}
                                    {c.processes > 1 ? ` · ${c.processes} processes` : ''}
                                  </Text>
                                </Box>
                                <Text fontSize="sm" className="num" flexShrink={0}>
                                  {fmtMb(c.mb)}
                                </Text>
                              </Flex>
                            </Checkbox.Label>
                          </Checkbox.Root>
                        ))}
                      </Stack>
                    )}
                  </Stack>

                  <Stack gap="1">
                    <Text fontSize="xs" color="fg.subtle" textTransform="uppercase" letterSpacing="wider" fontWeight="semibold">
                      Biggest users
                    </Text>
                    {m.top.slice(0, 6).map((p) => (
                      <Flex key={`${p.name}-${p.pid}`} justify="space-between" gap="2" fontSize="xs">
                        <Text fontFamily="mono" truncate title={p.name}>
                          {p.name}
                        </Text>
                        <HStack gap="2" flexShrink={0} color="fg.muted">
                          <Text>{p.group.toLowerCase()}</Text>
                          <Box w="16">
                            <Progress.Root value={m.total_mb ? Math.min(100, (p.mb / (m.top[0]?.mb || 1)) * 100) : 0} size="xs" colorPalette={p.closable ? 'green' : 'gray'}>
                              <Progress.Track>
                                <Progress.Range />
                              </Progress.Track>
                            </Progress.Root>
                          </Box>
                          <Text className="num" minW="14" textAlign="end">
                            {fmtMb(p.mb)}
                          </Text>
                        </HStack>
                      </Flex>
                    ))}
                  </Stack>

                  <Text fontSize="xs" color="fg.muted">
                    Closes the ticked apps (and their services), then every cached process Android would remove first. The app on screen
                    {m.foreground ? ` (${m.foreground})` : ''}, the launcher, the keyboard and system apps are never closed. Closed apps start normally next time.
                  </Text>
                  <HStack gap="2">
                    <Button size="sm" colorPalette="green" onClick={() => void free()} loading={busy} loadingText="Freeing RAM" disabled={m.busy}>
                      <LuMemoryStick /> Free up RAM{picked.size ? ` (~${fmtMb(pickedMb)}+)` : ''}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void q.refetch()} loading={q.isFetching && !busy}>
                      <LuRefreshCw /> Re-check
                    </Button>
                  </HStack>
                </Stack>
              )}
            </Dialog.Body>
            <Dialog.CloseTrigger asChild>
              <CloseButton size="sm" />
            </Dialog.CloseTrigger>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
