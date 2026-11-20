import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { qk } from '../../lib/queries';
import { Box, Button, Grid, HStack, Input, Stack, Tabs, Text, useBreakpointValue } from '@chakra-ui/react';
import { LuActivity, LuAppWindow, LuCrosshair, LuFolder, LuGauge, LuInfo, LuScrollText, LuSmartphone, LuWrench } from 'react-icons/lu';
import { SiFlutter } from 'react-icons/si';
import { api, dev, type AdbDevice, type AppEntry } from '../../lib/api';
import { Empty } from '../../components/ui';
import { notify } from '../../components/toaster';
import { LiveScreen } from './LiveScreen';
import { InfoTab } from './InfoTab';
import { LogcatTab } from './LogcatTab';
import { AppsTab } from './AppsTab';
import { PerfTab } from './PerfTab';
import { FilesTab } from './FilesTab';
import { ToolsTab } from './ToolsTab';
import { FlutterPanel } from './FlutterPanel';

const TAB_KEY = 'pt-ws-tab';
const get = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const set = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* not remembered */
  }
};

const PKG_TABS = new Set(['logcat', 'apps', 'perf', 'tools']);

/** Which app Logcat / Performance / Tools focus on — remembered per device. */
function PackagePicker({ serial, pkg, onChange }: { serial: string; pkg: string; onChange: (p: string) => void }) {
  const appsQ = useQuery({
    queryKey: qk.deviceApps(serial, false),
    staleTime: 60_000,
    queryFn: () => api<{ apps: AppEntry[] }>(dev(serial, '/apps?system=false')).then((r) => r.apps),
  });
  const apps = useMemo(() => (appsQ.data ?? []).map((a) => a.package), [appsQ.data]);
  const [value, setValue] = useState(pkg);
  const [busy, setBusy] = useState(false);
  useEffect(() => setValue(pkg), [pkg]);
  const foreground = async () => {
    setBusy(true);
    try {
      const r = await api<{ package: string | null }>(dev(serial, '/foreground'));
      if (r.package) onChange(r.package);
      else notify('warning', 'Could not tell which app is in front');
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setBusy(false);
    }
  };
  const listId = `apps-${serial.replace(/[^\w]/g, '')}`;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onChange(value.trim());
      }}
    >
      <HStack gap="2" wrap="wrap">
        <Text fontSize="xs" color="fg.muted" flexShrink={0}>
          App
        </Text>
        <Input
          size="xs"
          flex="1"
          minW="200px"
          maxW="380px"
          list={listId}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => value.trim() !== pkg && onChange(value.trim())}
          placeholder="com.example.app"
          fontFamily="mono"
          aria-label="App package"
        />
        <datalist id={listId}>{apps.map((a) => <option key={a} value={a} />)}</datalist>
        <Button size="xs" variant="outline" onClick={() => void foreground()} loading={busy} title="Use the app currently on screen">
          <LuCrosshair /> App on screen
        </Button>
      </HStack>
    </form>
  );
}

export function Workspace({
  device,
  canMirror,
  onMirror,
  flutter,
}: {
  device: AdbDevice | null;
  canMirror: boolean;
  onMirror: (d: AdbDevice) => void;
  flutter: { available: boolean; version: string | null } | null;
}) {
  const wide = useBreakpointValue({ base: false, '2xl': true }) ?? false;
  const [tab, setTab] = useState(() => get(TAB_KEY) ?? 'flutter');
  const serial = device?.serial ?? '';
  const [pkg, setPkgState] = useState('');
  useEffect(() => setPkgState(serial ? (get(`pt-ws-pkg:${serial}`) ?? '') : ''), [serial]);
  const setPkg = (p: string) => {
    setPkgState(p);
    if (serial) set(`pt-ws-pkg:${serial}`, p);
  };
  const choose = (t: string) => {
    setTab(t);
    set(TAB_KEY, t);
  };

  const ready = !!device && device.state === 'device';
  const title = device ? (device.avd_name ?? device.model ?? device.serial) : '';
  const tabs = [
    { id: 'flutter', label: 'Flutter', icon: <SiFlutter />, needsDevice: false },
    ...(wide ? [] : [{ id: 'screen', label: 'Screen', icon: <LuSmartphone />, needsDevice: true }]),
    { id: 'info', label: 'Info', icon: <LuInfo />, needsDevice: true },
    { id: 'logcat', label: 'Logcat', icon: <LuScrollText />, needsDevice: true },
    { id: 'apps', label: 'Apps', icon: <LuAppWindow />, needsDevice: true },
    { id: 'perf', label: 'Performance', icon: <LuGauge />, needsDevice: true },
    { id: 'files', label: 'Files', icon: <LuFolder />, needsDevice: true },
    { id: 'tools', label: 'Tools', icon: <LuWrench />, needsDevice: true },
  ];
  const active = tabs.some((t) => t.id === tab) ? tab : wide && tab === 'screen' ? 'info' : 'flutter';

  const needDevice = (
    <Empty icon={<LuActivity />} title={device ? `${title} is ${device.state}` : 'No device selected'}>
      {device ? 'Accept “Allow USB debugging” on the phone, or reconnect it.' : 'Connect a phone or start an emulator, then pick it in the device list.'}
    </Empty>
  );

  const body = (
    <Tabs.Root value={active} onValueChange={(e) => choose(e.value)} variant="line" size="sm" lazyMount unmountOnExit>
      <Box overflowX="auto" mx="-1" px="1">
        <Tabs.List flexWrap="nowrap" minW="max-content">
          {tabs.map((t) => (
            <Tabs.Trigger key={t.id} value={t.id} disabled={t.needsDevice && !ready} title={t.needsDevice && !ready ? 'Select a ready device first' : undefined}>
              {t.icon} {t.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
      </Box>
      {ready && PKG_TABS.has(active) && (
        <Box pt="3">
          <PackagePicker serial={serial} pkg={pkg} onChange={setPkg} />
        </Box>
      )}
      <Box pt="4">
        <Tabs.Content value="flutter" p="0">
          <FlutterPanel device={device} flutter={flutter} />
        </Tabs.Content>
        {!wide && (
          <Tabs.Content value="screen" p="0">
            {ready ? (
              <Box maxW="420px" mx="auto">
                <LiveScreen serial={serial} title={title} canMirror={canMirror} onMirror={() => onMirror(device!)} />
              </Box>
            ) : (
              needDevice
            )}
          </Tabs.Content>
        )}
        <Tabs.Content value="info" p="0">
          {ready ? <InfoTab serial={serial} /> : needDevice}
        </Tabs.Content>
        <Tabs.Content value="logcat" p="0">
          {ready ? <LogcatTab serial={serial} pkg={pkg} /> : needDevice}
        </Tabs.Content>
        <Tabs.Content value="apps" p="0">
          {ready ? <AppsTab serial={serial} pkg={pkg} onPick={setPkg} /> : needDevice}
        </Tabs.Content>
        <Tabs.Content value="perf" p="0">
          {ready ? <PerfTab serial={serial} pkg={pkg} /> : needDevice}
        </Tabs.Content>
        <Tabs.Content value="files" p="0">
          {ready ? <FilesTab serial={serial} /> : needDevice}
        </Tabs.Content>
        <Tabs.Content value="tools" p="0">
          {ready ? <ToolsTab serial={serial} pkg={pkg} title={title} isEmulator={device!.connection === 'emulator'} /> : needDevice}
        </Tabs.Content>
      </Box>
    </Tabs.Root>
  );

  if (!wide || !ready) return <Box minW="0">{body}</Box>;
  return (
    <Grid templateColumns="340px minmax(0, 1fr)" gap="5" alignItems="start">
      <Box position="sticky" top="20">
        <LiveScreen serial={serial} title={title} canMirror={canMirror} onMirror={() => onMirror(device!)} />
      </Box>
      <Stack minW="0">{body}</Stack>
    </Grid>
  );
}
