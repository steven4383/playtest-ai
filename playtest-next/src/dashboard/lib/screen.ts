import { useEffect, useReducer } from 'react';
import { API, dev } from './api';

/**
 * One shared screenshot loop per device for every view that shows its screen (live screen, test-run tiles,
 * sidebar thumbnails). It keeps the last frame per device, so opening a page shows the screen instantly
 * instead of a black box, and it notices all-black frames (screen off, still drawing after boot).
 */

export interface Frame {
  url: string;
  blob: Blob;
  /** Real device pixels (0 when unknown). */
  w: number;
  h: number;
  /** Practically all black: screen off, or the emulator has not drawn anything yet. */
  black: boolean;
  at: number;
}

interface Sub {
  interval: number;
  thumb: boolean;
  last: number;
  cb: () => void;
}

interface Entry {
  frame: Frame | null;
  /** Last frame that was not black — shown under the "screen is dark" hint. */
  lastGood: Frame | null;
  error: string | null;
  fps: number | null;
  times: number[];
  subs: Map<number, Sub>;
  running: boolean;
  wake: (() => void) | null;
}

const entries = new Map<string, Entry>();
const MAX_CACHED = 12;
let nextId = 1;
let canvas: HTMLCanvasElement | null = null;

function entry(serial: string): Entry {
  let e = entries.get(serial);
  if (!e) {
    e = { frame: null, lastGood: null, error: null, fps: null, times: [], subs: new Map(), running: false, wake: null };
    entries.set(serial, e);
    // Forget the oldest idle device beyond the cache size.
    for (const [s, old] of entries) {
      if (entries.size <= MAX_CACHED) break;
      if (!old.subs.size && s !== serial) {
        for (const f of [old.frame, old.lastGood]) if (f) URL.revokeObjectURL(f.url);
        entries.delete(s);
      }
    }
  }
  return e;
}

/** Size + "is it black?" from a tiny downscaled copy (a few hundred pixels — cheap even at 4 fps). */
async function inspect(blob: Blob): Promise<{ w: number; h: number; black: boolean }> {
  try {
    const bmp = await createImageBitmap(blob);
    const { width: w, height: h } = bmp;
    canvas ??= document.createElement('canvas');
    canvas.width = 18;
    canvas.height = 32;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return { w, h, black: false };
    ctx.drawImage(bmp, 0, 0, 18, 32);
    bmp.close();
    const d = ctx.getImageData(0, 0, 18, 32).data;
    let max = 0;
    for (let i = 0; i < d.length; i += 4) max = Math.max(max, d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11);
    return { w, h, black: max < 14 };
  } catch {
    return { w: 0, h: 0, black: false };
  }
}

/** Revoke a frame's object URL once nothing shows it any more (a little later, so a painting <img> is not cut off). */
function retire(e: Entry, f: Frame | null) {
  if (f && f !== e.frame && f !== e.lastGood) setTimeout(() => URL.revokeObjectURL(f.url), 3000);
}

function notify(e: Entry, force = false) {
  const now = Date.now();
  for (const s of e.subs.values()) {
    if (force || now - s.last >= s.interval * 0.9) {
      s.last = now;
      s.cb();
    }
  }
}

async function loop(serial: string, e: Entry) {
  e.running = true;
  while (e.subs.size) {
    const subs = [...e.subs.values()];
    const interval = Math.min(...subs.map((s) => s.interval));
    const t0 = performance.now();
    if (document.visibilityState === 'visible') {
      try {
        // Thumbnails alone don't count as "using" the device (RAM saver idle tracking).
        const thumb = subs.every((s) => s.thumb);
        const res = await fetch(`${API}${dev(serial, '/screen')}${thumb ? '?thumb=1' : ''}`, { cache: 'no-store' });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
        const blob = await res.blob();
        const info = await inspect(blob);
        const frame: Frame = { url: URL.createObjectURL(blob), blob, ...info, at: Date.now() };
        const prev = e.frame;
        const prevGood = e.lastGood;
        e.frame = frame;
        if (!frame.black) e.lastGood = frame;
        retire(e, prev);
        if (prevGood !== prev) retire(e, prevGood);
        const hadError = e.error !== null;
        e.error = null;
        e.times.push(performance.now());
        while (e.times.length > 6) e.times.shift();
        e.fps = e.times.length > 1 ? ((e.times.length - 1) * 1000) / (e.times[e.times.length - 1] - e.times[0]) : null;
        notify(e, hadError || !prev);
      } catch (err: any) {
        const changed = e.error !== (err?.message ?? 'error');
        e.error = err?.message ?? 'error';
        e.fps = null;
        if (changed) notify(e, true);
        await sleep(e, Math.max(interval, 1500));
        continue;
      }
    }
    const spent = performance.now() - t0;
    await sleep(e, document.visibilityState === 'visible' ? Math.max(0, interval - spent) : 1000);
  }
  e.running = false;
  e.times = [];
  e.fps = null;
}

function sleep(e: Entry, ms: number) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      e.wake = null;
      resolve();
    }
    e.wake = done;
  });
}

function subscribe(serial: string, interval: number, thumb: boolean, cb: () => void) {
  const e = entry(serial);
  const id = nextId++;
  const fasterThanBefore = !e.subs.size || interval < Math.min(...[...e.subs.values()].map((s) => s.interval));
  e.subs.set(id, { interval, thumb, last: 0, cb });
  if (!e.running) void loop(serial, e);
  else if (fasterThanBefore) e.wake?.();
  return () => {
    e.subs.delete(id);
  };
}

/** Fetch a new frame right away (e.g. just after a tap), instead of waiting for the next tick. */
export function refreshScreen(serial: string) {
  entries.get(serial)?.wake?.();
}

/** Last frame of a device without subscribing (e.g. to show something while a dialog opens). */
export function cachedFrame(serial: string): Frame | null {
  const e = entries.get(serial);
  return e?.lastGood ?? e?.frame ?? null;
}

/**
 * Live frames of one device. `interval` is the wanted gap between frames (ms); the shared loop runs at the fastest
 * interval anyone asked for, and slower views are only re-rendered at their own pace.
 */
export function useScreen(serial: string | null | undefined, opts: { interval: number; thumb?: boolean; enabled?: boolean }) {
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const enabled = opts.enabled !== false;
  useEffect(() => {
    if (!serial || !enabled) return;
    return subscribe(serial, opts.interval, !!opts.thumb, rerender);
  }, [serial, enabled, opts.interval, opts.thumb]);
  const e = serial ? entries.get(serial) : undefined;
  return { frame: e?.frame ?? null, lastGood: e?.lastGood ?? null, error: e?.error ?? null, fps: e?.fps ?? null };
}
