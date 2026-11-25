'use client';
import '@fontsource/poppins/800.css';
import { useEffect, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Box, chakra } from '@chakra-ui/react';
import { LuImagePlus, LuLayoutDashboard, LuPlus, LuScrollText, LuSettings2 } from 'react-icons/lu';
import { api } from '../../lib/api';
import { daysUntil, useTimeline, type TimelineStats } from '../../lib/timeline';
import { autoAccent, backdropUrl, bk, DEFAULT_ACCENT, rgbOf, uploadBackdrop, useBackdrops, type Backdrop } from '../../lib/backdrops';
import { EMPTY, LevelUp, Quest, RANK_COLOR, useTimelineActions } from '../timeline/TimelineView';
import { EntryDialog } from '../timeline/EntryDialog';
import { notify } from '../toaster';
import { Chronicle } from './Chronicle';
import { ScenesDialog } from './ScenesDialog';
import { PS_CSS } from './styles';

type View = 'chronicle' | 'status';
const VIEW_KEY = 'pt-personal-view';
const reduceMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Counts up to `v` (from 0 on first show) — instant with reduced motion. */
function useCountUp(v: number, ms = 1100) {
  const [n, setN] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    if (reduceMotion()) return void setN(v);
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      const val = Math.round(a + (v - a) * (1 - (1 - p) ** 3));
      setN(val);
      from.current = val;
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [v, ms]);
  return n;
}

function Stat({ k, v, h, color }: { k: string; v: number; h: string; color?: string }) {
  const n = useCountUp(v);
  return (
    <div className="ps-stat">
      <div className="k">{k}</div>
      <div className="v ps-display" style={{ color }}>
        {n.toLocaleString()}
      </div>
      <div className="h">{h}</div>
    </div>
  );
}

/** Rising embers in the accent color (positions fixed so they never jump between renders). */
function Sparks() {
  return (
    <>
      {Array.from({ length: 22 }, (_, i) => (
        <span
          key={i}
          className="ps-spark"
          style={
            {
              left: `${(i * 37 + 11) % 100}%`,
              width: 2 + (i % 3),
              height: 2 + (i % 3),
              animationDuration: `${9 + ((i * 7) % 9)}s`,
              animationDelay: `-${(i * 1.37) % 14}s`,
              '--drift': `${((i * 29) % 80) - 40}px`,
            } as CSSProperties
          }
        />
      ))}
    </>
  );
}

function Hero({
  scene,
  scenes,
  stats,
  view,
  setView,
  onNew,
  onPick,
  onAdd,
  onManage,
  onFiles,
}: {
  scene: Backdrop | null;
  scenes: Backdrop[];
  stats: TimelineStats;
  view: View;
  setView: (v: View) => void;
  onNew: () => void;
  onPick: (b: Backdrop) => void;
  onAdd: () => void;
  onManage: () => void;
  onFiles: (files: File[]) => void;
}) {
  const [drag, setDrag] = useState(false);
  const pct = stats.level_span ? Math.min(100, (stats.level_xp / stats.level_span) * 100) : 0;
  const [fill, setFill] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setFill(pct), 150);
    return () => clearTimeout(t);
  }, [pct]);
  const next = stats.next;
  const nd = next ? daysUntil(next.date) : null;
  const isImages = (e: DragEvent) => Array.from(e.dataTransfer.items ?? []).some((it) => it.kind === 'file' && it.type.startsWith('image/'));

  return (
    <div
      className="ps-hero"
      onDragOver={(e) => {
        if (!isImages(e)) return;
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDrag(false)}
      onDrop={(e) => {
        setDrag(false);
        const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
        if (!files.length) return;
        e.preventDefault();
        onFiles(files);
      }}
    >
      {scene ? (
        <img key={scene.id} className="ps-hero-img" src={backdropUrl(scene)} alt="" style={{ objectPosition: `${scene.focus_x}% ${scene.focus_y}%` }} />
      ) : (
        <div className="ps-mesh" />
      )}
      <div className="ps-shade" />
      <div className="ps-grain" />
      <Sparks />

      <div className="ps-top">
        <div className="ps-kicker">
          <i /> Personal space
        </div>
        <div className="ps-scenes">
          {scene && <span className="ps-scene-name">{scene.name}</span>}
          {scenes.map((b) => (
            <chakra.button key={b.id} className={`ps-scene${b.active ? ' on' : ''}`} onClick={() => onPick(b)} title={b.name} aria-label={`Scene: ${b.name}`}>
              <img src={backdropUrl(b)} alt="" style={{ objectPosition: `${b.focus_x}% ${b.focus_y}%` }} />
            </chakra.button>
          ))}
          <chakra.button className="ps-scene add" onClick={onAdd} title="Add your own image" aria-label="Add a scene">
            <LuImagePlus />
          </chakra.button>
          {scenes.length > 0 && (
            <chakra.button className="ps-scene" onClick={onManage} title="Manage scenes" aria-label="Manage scenes">
              <LuSettings2 />
            </chakra.button>
          )}
        </div>
      </div>

      {!scene && (
        <div className="ps-empty-art" onClick={onAdd} role="button" tabIndex={0} onKeyDown={(k) => k.key === 'Enter' && onAdd()}>
          <Box fontSize="3xl" display="grid" placeItems="center" mb="2" color="rgb(var(--acc-rgb))">
            <LuImagePlus />
          </Box>
          <div style={{ fontWeight: 700 }}>Add your favourite character</div>
          <div style={{ fontSize: 13, color: 'var(--dim)', marginTop: 6 }}>Drop an image here or click. The whole space takes its glow from it.</div>
        </div>
      )}

      <div className="ps-copy">
        <div className="ps-kicker" style={{ color: 'var(--dim)' }}>
          Chronicle · {new Date().getFullYear()}
        </div>
        <div className="ps-levelrow">
          <div className="ps-rank ps-display" style={{ background: `linear-gradient(160deg, ${RANK_COLOR[stats.rank]}, #0b1a3a)` }} title={`Rank ${stats.rank}`}>
            {stats.rank}
          </div>
          <div>
            <div className="ps-level-label">LEVEL</div>
            <div className="ps-level ps-display">{stats.level}</div>
          </div>
        </div>
        <div className="ps-xp">
          <div className="ps-xp-track">
            <div className="ps-xp-fill" style={{ width: `${fill}%` }} />
          </div>
          <div className="ps-xp-text">
            <span>
              {stats.level_xp} / {stats.level_span} XP
            </span>
            <span>
              {stats.level_span - stats.level_xp} XP to level {stats.level + 1}
            </span>
          </div>
        </div>
        <div className="ps-next">
          {next ? (
            <>
              <b>NEXT ▸</b> <span>{next.title}</span> <span className="d">{nd === 0 ? 'D-DAY' : `D-${nd}`}</span>
            </>
          ) : (
            <>
              <b>NEXT ▸</b> <span style={{ color: 'var(--dim)' }}>Give a quest a target date to start a countdown.</span>
            </>
          )}
        </div>
        <div className="ps-actions">
          <chakra.button className="ps-cta" onClick={onNew}>
            <LuPlus /> New quest
          </chakra.button>
          <div className="ps-seg" role="tablist" aria-label="View">
            <chakra.button role="tab" aria-selected={view === 'chronicle'} className={view === 'chronicle' ? 'on' : ''} onClick={() => setView('chronicle')}>
              <LuScrollText /> Chronicle
            </chakra.button>
            <chakra.button role="tab" aria-selected={view === 'status'} className={view === 'status' ? 'on' : ''} onClick={() => setView('status')}>
              <LuLayoutDashboard /> Status window
            </chakra.button>
          </div>
        </div>
      </div>
      {drag && <div className="ps-drop">Drop to add as a scene</div>}
    </div>
  );
}

/**
 * Maintenance → Personal space: your own goals, important days and achievements, separate from projects.
 * A cinematic page themed by your own character art, with two views: the Chronicle (story line) and the Status window (HUD).
 */
export function PersonalSpace() {
  const qc = useQueryClient();
  const q = useTimeline('personal');
  const scenesQ = useBackdrops();
  const scenes = scenesQ.data ?? [];
  const scene = scenes.find((b) => b.active) ?? null;
  const accent = scene?.accent ?? DEFAULT_ACCENT;
  const [view, setViewState] = useState<View>('chronicle');
  const [manage, setManage] = useState(false);
  const [levelUp, setLevelUp] = useState<{ level: number; rank: string } | null>(null);
  const t = useTimelineActions((level, rank) => setLevelUp({ level, rank }));
  const fileRef = useRef<HTMLInputElement>(null);
  const tried = useRef(new Set<string>());

  useEffect(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY);
      if (v === 'status' || v === 'chronicle') setViewState(v);
    } catch {}
  }, []);
  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {}
  };

  // New scenes get their accent color from the image (once).
  useEffect(() => {
    for (const b of scenes) {
      if (b.accent || tried.current.has(b.id)) continue;
      tried.current.add(b.id);
      void autoAccent(b).then((a) => {
        if (a) void qc.invalidateQueries({ queryKey: bk.all });
      });
    }
  }, [scenes, qc]);

  const pick = async (b: Backdrop) => {
    if (b.active) return;
    try {
      await api(`/personal/backdrops/${b.id}`, { method: 'PATCH', body: JSON.stringify({ active: true }) });
      await qc.invalidateQueries({ queryKey: bk.all });
    } catch (e: any) {
      notify('error', e.message);
    }
  };
  const addFiles = async (files: File[]) => {
    let last: Backdrop | null = null;
    for (const f of files) {
      try {
        last = await uploadBackdrop(f);
      } catch (e: any) {
        notify('error', `${f.name}: ${e.message}`);
      }
    }
    if (last && !last.active) await api(`/personal/backdrops/${last.id}`, { method: 'PATCH', body: JSON.stringify({ active: true }) }).catch(() => {});
    if (last) notify('ok', files.length > 1 ? `${files.length} scenes added` : `Scene "${last.name}" added`);
    await qc.invalidateQueries({ queryKey: bk.all });
  };

  const d = q.data ?? EMPTY;
  const s = d.stats;
  return (
    <Box mx={{ base: '-4', md: '-6' }} my="-5" minH="calc(100dvh - 57px)">
      <style>{PS_CSS}</style>
      <div className="ps-root" style={{ '--acc': accent, '--acc-rgb': rgbOf(accent), minHeight: 'calc(100dvh - 57px)' } as CSSProperties}>
        <Hero
          scene={scene}
          scenes={scenes}
          stats={s}
          view={view}
          setView={setView}
          onNew={() => t.setEditing('new')}
          onPick={(b) => void pick(b)}
          onAdd={() => fileRef.current?.click()}
          onManage={() => setManage(true)}
          onFiles={(f) => void addFiles(f)}
        />
        <div className="ps-stats">
          <Stat k="Cleared" v={s.achieved} h="quests completed" color="var(--gold)" />
          <Stat k="Active" v={s.active} h="in progress now" color="rgb(var(--acc-rgb))" />
          <Stat k="Ahead" v={s.upcoming} h={s.overdue ? `${s.overdue} overdue` : 'planned quests'} />
          <Stat k="Total XP" v={s.xp} h={`rank ${s.rank}`} />
        </div>
        {view === 'chronicle' ? (
          <Chronicle d={d} onEdit={t.setEditing} onStatus={(e, st) => void t.setStatus(e, st)} onNew={() => t.setEditing('new')} />
        ) : (
          <Box px={{ base: '0', md: '4' }} pt="8" pb="12">
            <Quest d={d} embedded onEdit={t.setEditing} onStatus={(e, st) => void t.setStatus(e, st)} />
          </Box>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) void addFiles(files);
        }}
      />
      <ScenesDialog open={manage} list={scenes} onClose={() => setManage(false)} onAdd={() => fileRef.current?.click()} />
      <EntryDialog mode="personal" entry={t.editing} onClose={() => t.setEditing(null)} onSaved={(r) => (t.celebrate(r), void t.reload())} />
      {levelUp && <LevelUp level={levelUp.level} rank={levelUp.rank} onDone={() => setLevelUp(null)} />}
    </Box>
  );
}
