import { useCallback, useEffect, useRef, useState } from 'react';
import { API, api, type Capacity, type Metrics, type SdkJob } from './api';

export interface LiveEvent {
  event: string;
  device_id?: string;
  serial?: string;
  message?: string;
  timestamp?: string;
  job?: SdkJob;
  campaign_id?: string;
  execution_id?: string;
  status?: string;
  step?: string;
  /** boot_progress */
  avd_name?: string;
  progress?: number;
  phase?: string | null;
  mode?: 'fast' | 'cold' | 'first' | null;
  elapsed_s?: number;
  eta_s?: number | null;
  booted?: boolean;
  /** release_update */
  release_id?: string;
  component_id?: string;
  project_id?: string | null;
}

const HISTORY = 90; // 3 minutes at 2s

/** Subscribes to /events (SSE): live metrics, capacity and device lifecycle events. */
export function useLive() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [capacity, setCapacity] = useState<Capacity | null>(null);
  const [history, setHistory] = useState<Metrics[]>([]);
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const listeners = useRef(new Set<(e: LiveEvent) => void>());

  useEffect(() => {
    api<Metrics[]>(`/system/metrics/history?limit=${HISTORY}`).then(setHistory).catch(() => {});
    const es = new EventSource(`${API}/events`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener('metrics', (msg) => {
      const d = JSON.parse((msg as MessageEvent).data);
      setMetrics(d.metrics);
      setCapacity(d.capacity);
      setHistory((h) => (h.at(-1)?.ts === d.metrics.ts ? h : [...h, d.metrics].slice(-HISTORY)));
    });
    const noisy = new Set(['sdk_job', 'execution_update', 'campaign_update', 'boot_progress', 'release_update']);
    for (const name of ['device_starting', 'device_ready', 'device_stopped', 'device_error', 'boot_progress', 'apk_uploaded', 'sdk_job', 'campaign_update', 'execution_update', 'bug_found', 'release_update']) {
      es.addEventListener(name, (msg) => {
        const e: LiveEvent = { event: name, ...JSON.parse((msg as MessageEvent).data) };
        // Progress events fire often — deliver to listeners but keep them out of the event history
        if (!noisy.has(name)) setEvents((list) => [e, ...list].slice(0, 30));
        listeners.current.forEach((fn) => fn(e));
      });
    }
    return () => es.close();
  }, []);

  // Stable identity, so effects that subscribe don't resubscribe on every metrics tick.
  const onEvent = useCallback((fn: (e: LiveEvent) => void) => {
    listeners.current.add(fn);
    return () => void listeners.current.delete(fn);
  }, []);

  return { metrics, capacity, history, connected, events, onEvent };
}

export type Live = ReturnType<typeof useLive>;
