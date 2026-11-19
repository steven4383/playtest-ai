import { useQuery } from '@tanstack/react-query';
import { qk } from '../../lib/queries';
import { Box, Button, Code, HStack, SimpleGrid, Stack, Text } from '@chakra-ui/react';
import { LuRefreshCw } from 'react-icons/lu';
import { api, dev, type DeviceInfo } from '../../lib/api';
import { CopyButton, Kv, Loading, Meter, Notice, Stat } from '../../components/ui';

const fmtUptime = (s: number) => {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};

export function InfoTab({ serial }: { serial: string }) {
  // Cached per device, so switching tabs or pages shows it instantly; refreshed in the background after a minute.
  const q = useQuery({ queryKey: qk.deviceInfo(serial), staleTime: 60_000, queryFn: () => api<DeviceInfo>(dev(serial, '/info')) });
  const info = q.data ?? null;
  const error = q.error?.message ?? null;
  const loading = q.isFetching;
  const load = () => void q.refetch();

  if (error && !info) return <Notice tone="error">{error}</Notice>;
  if (!info) return <Loading rows={8} height="6" label="Reading device info" />;

  const val = (v: string | number | null | undefined, copy = false) =>
    v === null || v === undefined || v === '' ? (
      <Text color="fg.subtle">—</Text>
    ) : (
      <HStack gap="1" minW="0">
        <Text truncate title={String(v)}>
          {v}
        </Text>
        {copy && <CopyButton value={String(v)} />}
      </HStack>
    );
  const memPct = info.memory.total_mb && info.memory.available_mb !== null ? ((info.memory.total_mb - info.memory.available_mb) / info.memory.total_mb) * 100 : null;
  const storPct = info.storage.total_mb && info.storage.free_mb !== null ? ((info.storage.total_mb - info.storage.free_mb) / info.storage.total_mb) * 100 : null;

  return (
    <Stack gap="5">
      <SimpleGrid columns={{ base: 2, md: 4 }} gap="4">
        <Stat label="Android" value={info.android_version ?? '?'} hint={info.api_level ? `API ${info.api_level}` : undefined} />
        <Stat label="Battery" value={info.battery.level !== null ? `${info.battery.level}%` : '—'} hint={[info.battery.status, info.battery.temperature_c !== null ? `${info.battery.temperature_c.toFixed(1)}°C` : null].filter(Boolean).join(' · ')} />
        <Stat label="Screen" value={info.screen.override ?? info.screen.physical ?? '—'} hint={info.screen.density ? `${info.screen.density_override ?? info.screen.density} dpi` : undefined} />
        <Stat label="Uptime" value={info.uptime_s !== null ? fmtUptime(info.uptime_s) : '—'} hint={info.connection === 'usb' ? 'USB' : info.connection === 'wifi' ? 'Wi-Fi' : 'Emulator'} />
      </SimpleGrid>

      <SimpleGrid columns={{ base: 1, md: 2 }} gap="4">
        {memPct !== null && <Meter label="RAM used" pct={memPct} detail={`${((info.memory.total_mb! - info.memory.available_mb!) / 1024).toFixed(1)} / ${(info.memory.total_mb! / 1024).toFixed(1)} GB`} />}
        {storPct !== null && <Meter label="Storage used (/data)" pct={storPct} detail={`${(info.storage.free_mb! / 1024).toFixed(1)} GB free of ${(info.storage.total_mb! / 1024).toFixed(0)}`} />}
      </SimpleGrid>

      <Box borderWidth="1px" borderRadius="md" p="4">
        <Kv
          cols
          items={[
            ['Manufacturer', val([info.manufacturer, info.brand && info.brand !== info.manufacturer ? `(${info.brand})` : null].filter(Boolean).join(' '))],
            ['Model', val(info.model, true)],
            ['Device code', val(info.device)],
            ['Serial', val(info.serial, true)],
            ['Security patch', val(info.security_patch)],
            ['Build', val(info.build_id)],
            ['CPU ABIs', val(info.abis.join(', '))],
            ['Hardware', val(info.hardware)],
            ['Physical size', val(info.screen.physical)],
            ['Wi-Fi IP', val(info.wifi_ip, true)],
            ['Charging', val(info.battery.plugged.length ? info.battery.plugged.join(', ') : 'not plugged in')],
            ['Emulator', val(info.is_emulator ? 'yes' : 'no')],
          ]}
        />
      </Box>

      {info.fingerprint && (
        <Stack gap="1">
          <Text fontSize="xs" color="fg.muted">
            Build fingerprint
          </Text>
          <HStack gap="1">
            <Code size="sm" wordBreak="break-all" whiteSpace="normal">
              {info.fingerprint}
            </Code>
            <CopyButton value={info.fingerprint} />
          </HStack>
        </Stack>
      )}
      <Button size="xs" variant="ghost" alignSelf="flex-start" onClick={() => void load()} loading={loading}>
        <LuRefreshCw /> Refresh
      </Button>
    </Stack>
  );
}
