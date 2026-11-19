import { useMemo, useRef, useState } from 'react';

interface Props {
  values: (number | null)[];
  times: string[];
  max?: number;
  unit: string;
  label: string;
  height?: number;
  color?: string;
}

/**
 * Single-series live line (2px) with a soft area, fixed y-domain and a
 * crosshair + tooltip on hover. Single series => the card title names it, no legend.
 */
export function Sparkline({ values, times, max, unit, label, height = 72, color = 'var(--series-1)' }: Props) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 300;
  const H = height;
  const pad = 2;

  const domainMax = useMemo(() => {
    if (max) return max;
    const m = Math.max(1, ...values.filter((v): v is number => v !== null));
    return m * 1.15;
  }, [values, max]);

  const n = values.length;
  const x = (i: number) => (n <= 1 ? W : (i / (n - 1)) * W);
  const y = (v: number) => H - pad - (Math.min(v, domainMax) / domainMax) * (H - pad * 2);

  const segments = useMemo(() => {
    let line = '';
    let started = false;
    values.forEach((v, i) => {
      if (v === null) {
        started = false;
        return;
      }
      line += `${started ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      started = true;
    });
    return line;
  }, [values, domainMax]);

  const firstIdx = values.findIndex((v) => v !== null);
  const lastIdx = values.length - 1 - [...values].reverse().findIndex((v) => v !== null);
  const area =
    firstIdx >= 0 && values.every((v) => v !== null)
      ? `${segments}L${x(lastIdx)},${H}L${x(firstIdx)},${H}Z`
      : '';

  const onMove = (e: React.PointerEvent) => {
    const rect = ref.current!.getBoundingClientRect();
    const rel = (e.clientX - rect.left) / rect.width;
    setHover(Math.max(0, Math.min(n - 1, Math.round(rel * (n - 1)))));
  };

  const hv = hover !== null ? values[hover] : null;

  return (
    <div className="spark">
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label} over the last ${n} samples`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {[0.5].map((t) => (
          <line key={t} x1={0} x2={W} y1={y(domainMax * t)} y2={y(domainMax * t)} className="grid" />
        ))}
        {area && <path d={area} fill={color} opacity={0.12} />}
        <path d={segments} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        {hover !== null && (
          <line x1={x(hover)} x2={x(hover)} y1={0} y2={H} className="crosshair" vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      {hover !== null && (
        <div className="tooltip" style={{ left: `${(x(hover) / W) * 100}%` }}>
          <strong>{hv === null ? '—' : `${hv.toFixed(1)}${unit}`}</strong>
          <span>{new Date(times[hover]).toLocaleTimeString()}</span>
        </div>
      )}
    </div>
  );
}
