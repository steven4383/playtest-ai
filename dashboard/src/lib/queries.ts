import { useEffect } from 'react';
import { QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type AdbDevice, type Apk, type Device, type SdkJob, type SystemImage, type ToolStatus } from './api';
import type { Live } from './useLive';

/**
 * Shared server-state cache (TanStack Query). Pages read from here instead of fetching on every mount,
 * so switching pages shows the last data instantly and only refreshes in the background.
 * Live SSE events (device / SDK job / campaign) keep the cache fresh — see useLiveCacheSync.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 60 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

export const qk = {
  adbDevices: ['adb', 'devices'] as const,
  profiles: ['devices'] as const,
  avds: ['emulators', 'avds'] as const,
  tools: ['tools'] as const,
  sdkJobs: ['sdk', 'jobs'] as const,
  sdkInstalled: ['sdk', 'installed'] as const,
  sdkCatalog: ['sdk', 'catalog'] as const,
  sdkDefinitions: ['sdk', 'definitions'] as const,
  sdkStorage: ['sdk', 'storage'] as const,
  flutter: ['devtools', 'flutter'] as const,
  scrcpy: ['devtools', 'scrcpy'] as const,
  apks: ['apks'] as const,
  flutterProjects: ['flutter', 'projects'] as const,
  flutterAnalysis: (path: string) => ['flutter', 'analysis', path] as const,
  flutterDoctor: ['flutter', 'doctor'] as const,
  deviceInfo: (serial: string) => ['dev', serial, 'info'] as const,
  deviceApps: (serial: string, system: boolean) => ['dev', serial, 'apps', system] as const,
};

export interface FlutterStatus {
  available: boolean;
  path: string | null;
  version: string | null;
  channel: string | null;
  devices: { id: string; name: string; sdk: string }[];
  error: string | null;
}
export interface ScrcpyStatus {
  available: boolean;
  version: string | null;
  can_install: boolean;
  install: { state: 'idle' | 'installing' | 'done' | 'error'; message: string | null };
}

/** Connected ADB devices, polled while any page that shows them is open (paused in background tabs). */
export function useAdbDevices(pollMs = 4000) {
  return useQuery({
    queryKey: qk.adbDevices,
    queryFn: () => api<{ devices: AdbDevice[]; error?: string }>('/adb/devices'),
    staleTime: 2_000,
    refetchInterval: pollMs,
  });
}

export const useProfiles = () => useQuery({ queryKey: qk.profiles, queryFn: () => api<Device[]>('/devices') });
export const useAvds = () => useQuery({ queryKey: qk.avds, queryFn: () => api<{ avds: string[] }>('/emulators/avds').then((r) => r.avds) });
export const useTools = () => useQuery({ queryKey: qk.tools, queryFn: () => api<ToolStatus>('/tools'), staleTime: 5 * 60_000 });
export const useApks = () => useQuery({ queryKey: qk.apks, queryFn: () => api<Apk[]>('/apks') });

/** SDK jobs: loaded once, then kept current by `sdk_job` live events (no polling). */
export const useSdkJobs = () => useQuery({ queryKey: qk.sdkJobs, queryFn: () => api<SdkJob[]>('/sdk/jobs'), staleTime: Infinity });

/** Installed system images + whether each one lives in the custom images folder. */
export function useSdkInstalled(enabled: boolean) {
  return useQuery({
    queryKey: qk.sdkInstalled,
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const [r, st] = await Promise.all([
        api<{ images: SystemImage[] }>('/sdk/images/installed'),
        api<{ images: { images: { package: string; linked: boolean }[] } | null }>('/sdk/storage').catch(() => null),
      ]);
      return { images: r.images, links: Object.fromEntries((st?.images?.images ?? []).map((i) => [i.package, i.linked])) as Record<string, boolean> };
    },
  });
}

export const useSdkDefinitions = (enabled: boolean) =>
  useQuery({ queryKey: qk.sdkDefinitions, enabled, staleTime: Infinity, queryFn: () => api<{ definitions: string[] }>('/sdk/device-definitions').then((r) => r.definitions) });

/** The downloadable catalog is slow (sdkmanager --list), so it only loads when asked and then stays cached. */
export const useSdkCatalog = () =>
  useQuery({ queryKey: qk.sdkCatalog, enabled: false, staleTime: Infinity, queryFn: () => api<{ images: SystemImage[] }>('/sdk/images').then((r) => r.images) });

let flutterChecked = false;
/** Flutter SDK + `flutter devices`. The first load uses the backend cache; later refreshes re-run `flutter devices`. */
export const useFlutterStatus = () =>
  useQuery({
    queryKey: qk.flutter,
    staleTime: 5 * 60_000,
    queryFn: () => {
      const refresh = flutterChecked;
      flutterChecked = true;
      return api<FlutterStatus>(`/devtools/flutter${refresh ? '?refresh=true' : ''}`);
    },
  });

export const useScrcpy = () =>
  useQuery({
    queryKey: qk.scrcpy,
    staleTime: 5 * 60_000,
    queryFn: () => api<ScrcpyStatus>('/devtools/scrcpy'),
    refetchInterval: (q) => (q.state.data?.install.state === 'installing' ? 3000 : false),
  });

/** Keeps the cache in step with backend events, once for the whole app. */
export function useLiveCacheSync(live: Live) {
  const qc = useQueryClient();
  useEffect(
    () =>
      live.onEvent((e) => {
        if (e.event.startsWith('device_')) {
          void qc.invalidateQueries({ queryKey: qk.adbDevices });
          void qc.invalidateQueries({ queryKey: qk.profiles });
          if (e.event === 'device_ready' || e.event === 'device_stopped') void qc.invalidateQueries({ queryKey: qk.flutter });
        }
        if (e.event === 'execution_update' || e.event === 'campaign_update') {
          void qc.invalidateQueries({ queryKey: qk.adbDevices });
          void qc.invalidateQueries({ queryKey: qk.profiles });
          void qc.invalidateQueries({ queryKey: ['campaigns'] });
        }
        if (e.event === 'bug_found' || e.event === 'campaign_update') {
          void qc.invalidateQueries({ queryKey: ['bugs'] });
          void qc.invalidateQueries({ queryKey: ['reports'] });
        }
        if (e.event === 'apk_uploaded') void qc.invalidateQueries({ queryKey: qk.apks });
        if (e.event === 'sdk_job' && e.job) {
          const job = e.job;
          qc.setQueryData<SdkJob[]>(qk.sdkJobs, (list = []) => [job, ...list.filter((j) => j.id !== job.id)].sort((a, b) => b.created_at.localeCompare(a.created_at)));
          if (job.status === 'done' || job.status === 'error') {
            for (const key of [qk.profiles, qk.avds, qk.sdkInstalled, qk.sdkStorage]) void qc.invalidateQueries({ queryKey: key });
          }
        }
      }),
    [live.onEvent, qc],
  );
}
