import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface Backdrop {
  id: string;
  name: string;
  mime: string;
  accent: string | null;
  focus_x: number;
  focus_y: number;
  active: boolean;
  created_at: string;
}

export const bk = { all: ['personal-backdrops'] as const };
export const useBackdrops = () => useQuery({ queryKey: bk.all, queryFn: () => api<Backdrop[]>('/personal/backdrops') });
export const backdropUrl = (b: Pick<Backdrop, 'id'>) => `/api/v1/personal/backdrops/${b.id}/image`;

export const DEFAULT_ACCENT = '#5cc8ff';

export async function uploadBackdrop(file: File) {
  const fd = new FormData();
  fd.append('file', file);
  return api<Backdrop>('/personal/backdrops', { method: 'POST', body: fd });
}

/** Work out a backdrop's accent color from its image and save it. */
export function autoAccent(b: Pick<Backdrop, 'id'>): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const accent = extractAccent(img);
      if (!accent) return resolve(null);
      api(`/personal/backdrops/${b.id}`, { method: 'PATCH', body: JSON.stringify({ accent }) })
        .then(() => resolve(accent))
        .catch(() => resolve(null));
    };
    img.onerror = () => resolve(null);
    img.src = backdropUrl(b);
  });
}

/** "r, g, b" of a #rrggbb color, for rgba(var(--acc-rgb), a). */
export function rgbOf(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToHex(h: number, s: number, l: number) {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * The image's most "glowing" color: hues weighted by saturation and brightness (dark and grey pixels ignored),
 * then lifted so it reads well on the dark page. Runs in the browser on a 64 px copy of the image.
 */
export function extractAccent(img: HTMLImageElement): string | null {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, 64, 64);
    const px = ctx.getImageData(0, 0, 64, 64).data;
    const bins = Array.from({ length: 36 }, () => ({ w: 0, h: 0, s: 0 }));
    for (let i = 0; i < px.length; i += 4) {
      const [h, s, l] = rgbToHsl(px[i], px[i + 1], px[i + 2]);
      if (s < 0.25 || l < 0.12 || l > 0.92) continue;
      // Bright, saturated pixels (glows, eyes, light) count most.
      const w = s * s * (1 - Math.abs(l - 0.55) * 1.4);
      if (w <= 0) continue;
      const b = bins[Math.floor(h / 10) % 36];
      b.w += w;
      b.h += h * w;
      b.s += s * w;
    }
    // Smooth over neighbouring hue bins, then pick the strongest.
    let best = -1;
    let bestW = 0;
    for (let i = 0; i < 36; i++) {
      const w = bins[(i + 35) % 36].w * 0.5 + bins[i].w + bins[(i + 1) % 36].w * 0.5;
      if (w > bestW) {
        bestW = w;
        best = i;
      }
    }
    if (best < 0 || bins[best].w === 0) return null;
    const b = bins[best];
    return hslToHex(b.h / b.w, Math.min(0.95, Math.max(0.6, b.s / b.w)), 0.62);
  } catch {
    return null;
  }
}
