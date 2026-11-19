import { EventEmitter } from 'node:events';

/** In-process event bus. Dashboard receives these over Server-Sent Events. */
export type AppEvent =
  | { event: 'metrics'; data: unknown }
  | { event: 'device_starting' | 'device_ready' | 'device_stopped' | 'device_error'; data: { device_id: string; message?: string; serial?: string } }
  | { event: 'apk_uploaded'; data: { apk_id: string; package_name: string | null } }
  | { event: 'sdk_job'; data: { job: unknown } }
  | { event: 'campaign_update'; data: { campaign_id: string; status: string; summary: unknown; paused?: boolean } }
  | { event: 'bug_found'; data: { campaign_id: string; execution_id: string } }
  | { event: 'execution_update'; data: { campaign_id: string; execution_id: string; status: string; step?: string } };

class Bus extends EventEmitter {
  publish(e: AppEvent) {
    this.emit('event', { ...e, timestamp: new Date().toISOString() });
  }
}

export const bus = new Bus();
bus.setMaxListeners(100);
