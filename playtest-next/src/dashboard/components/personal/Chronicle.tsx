'use client';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { chakra } from '@chakra-ui/react';
import { LuActivity, LuBriefcase, LuCalendarHeart, LuCheck, LuFlag, LuGraduationCap, LuHeart, LuPencil, LuPlay, LuPlus, LuRotateCcw, LuTarget } from 'react-icons/lu';
import { CATEGORY, daysUntil, type Category, type EntryStatus, type TimelineData, type TimelineEntry } from '../../lib/timeline';

/** A modern, scroll-revealed story line: what you achieved → NOW → what is ahead → someday. */

const PERSONAL_KINDS: Category[] = ['goal', 'education', 'career', 'personal', 'health', 'event'];
const ICON: Partial<Record<Category, ReactNode>> = {
  goal: <LuTarget />,
  education: <LuGraduationCap />,
  career: <LuBriefcase />,
  personal: <LuHeart />,
  health: <LuActivity />,
  event: <LuCalendarHeart />,
};
const CAT_COLOR: Partial<Record<Category, string>> = {
  goal: '#60a5fa',
  education: '#22d3ee',
  career: '#a78bfa',
  personal: '#f472b6',
  health: '#34d399',
  event: '#fb923c',
};

type Row =
  | { k: 'mark'; label: string; small?: boolean }
  | { k: 'now' }
  | { k: 'entry'; e: TimelineEntry; side: 'l' | 'r'; future: boolean };

const day = (s: string | null) => (s ? s.slice(0, 10) : null);
/** The date an entry sits at on the line. */
const at = (e: TimelineEntry) => (e.status === 'achieved' ? day(e.achieved_at) ?? e.date : e.status === 'dropped' ? e.date ?? day(e.updated_at) : e.date);

function buildRows(entries: TimelineEntry[]): Row[] {
  const past = entries.filter((e) => e.status === 'achieved' || e.status === 'dropped').sort((a, b) => (at(a) ?? '').localeCompare(at(b) ?? ''));
  const open = entries.filter((e) => e.status === 'planned' || e.status === 'in_progress');
  const ahead = open.filter((e) => e.date).sort((a, b) => a.date!.localeCompare(b.date!));
  const someday = open.filter((e) => !e.date).sort((a, b) => (a.status === b.status ? a.created_at.localeCompare(b.created_at) : a.status === 'in_progress' ? -1 : 1));

  const rows: Row[] = [];
  let year = '';
  let i = 0;
  const push = (e: TimelineEntry, future: boolean, withYear: boolean) => {
    const y = (at(e) ?? '').slice(0, 4);
    if (withYear && y && y !== year) {
      rows.push({ k: 'mark', label: y });
      year = y;
    }
    rows.push({ k: 'entry', e, side: i++ % 2 ? 'r' : 'l', future });
  };
  past.forEach((e) => push(e, false, true));
  rows.push({ k: 'now' });
  year = new Date().getFullYear().toString();
  ahead.forEach((e) => push(e, true, true));
  if (someday.length) {
    rows.push({ k: 'mark', label: 'Someday', small: true });
    someday.forEach((e) => push(e, true, false));
  }
  return rows;
}

/** Fades/slides its child in the first time it scrolls into view. */
function Reveal({ dx, children }: { dx: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return void setShown(true);
    const io = new IntersectionObserver(
      ([en]) => {
        if (en?.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className={`ps-reveal${shown ? ' in' : ''}`} style={{ '--dx': dx } as CSSProperties}>
      {children}
    </div>
  );
}

const MONTH = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }).toUpperCase();

function Card({ e, onEdit, onStatus }: { e: TimelineEntry; onEdit: () => void; onStatus: (s: EntryStatus) => void }) {
  const c = CATEGORY[e.category];
  const d = at(e);
  const n = daysUntil(e.date);
  const open = e.status === 'planned' || e.status === 'in_progress';
  const late = open && n !== null && n < 0;
  const when =
    e.status === 'achieved' ? (
      <div className="ps-when gold">✦ Cleared</div>
    ) : e.status === 'dropped' ? (
      <div className="ps-when">Dropped</div>
    ) : e.status === 'in_progress' ? (
      <div className="ps-when live">● In progress{n !== null ? ` · ${n < 0 ? `${-n}d late` : n === 0 ? 'due today' : `${n}d left`}` : ''}</div>
    ) : (
      <div className={`ps-when${late ? ' late' : ''}`}>{n === null ? 'No date yet' : n < 0 ? `${-n} day${n === -1 ? '' : 's'} late` : n === 0 ? 'Today' : `in ${n} day${n === 1 ? '' : 's'}`}</div>
    );
  return (
    <div className={`ps-card ${e.status}${late ? ' late' : ''}`} style={{ '--cat': CAT_COLOR[e.category] ?? 'rgb(var(--acc-rgb))' } as CSSProperties}>
      <div className="ps-card-top">
        <div>
          <div className="ps-date ps-display">
            {d ? MONTH(d) : 'SOMEDAY'}
            {d && <small>{d.slice(0, 4)}</small>}
          </div>
          {when}
        </div>
        <span className="ps-chip">
          {ICON[e.category] ?? <LuFlag />} {c.label}
        </span>
      </div>
      <div className="ps-title" onClick={onEdit} role="button" tabIndex={0} onKeyDown={(k) => k.key === 'Enter' && onEdit()}>
        {e.title}
      </div>
      {e.description && <div className="ps-desc">{e.description}</div>}
      <div className="ps-foot">
        <span className="ps-xpchip">{e.status === 'achieved' ? `+${c.xp} XP earned` : `+${c.xp} XP`}</span>
        <div className="acts">
          {e.status === 'planned' && (
            <chakra.button className="ps-btn" onClick={() => onStatus('in_progress')}>
              <LuPlay /> Start
            </chakra.button>
          )}
          {open && (
            <chakra.button className="ps-btn gold" onClick={() => onStatus('achieved')}>
              <LuCheck /> Complete
            </chakra.button>
          )}
          {e.status === 'achieved' && (
            <chakra.button className="ps-btn icon" onClick={() => onStatus('planned')} title="Not done after all" aria-label="Undo">
              <LuRotateCcw />
            </chakra.button>
          )}
          <chakra.button className="ps-btn icon" onClick={onEdit} aria-label="Edit" title="Edit">
            <LuPencil />
          </chakra.button>
        </div>
      </div>
    </div>
  );
}

export function Chronicle({
  d,
  onEdit,
  onStatus,
  onNew,
}: {
  d: TimelineData;
  onEdit: (e: TimelineEntry) => void;
  onStatus: (e: TimelineEntry, s: EntryStatus) => void;
  onNew: () => void;
}) {
  const [filter, setFilter] = useState<Category | 'all'>('all');
  const counts = useMemo(() => {
    const m = new Map<Category, number>();
    for (const e of d.entries) m.set(e.category, (m.get(e.category) ?? 0) + 1);
    return m;
  }, [d.entries]);
  const kinds = PERSONAL_KINDS.filter((k) => counts.get(k));
  // Older entries of another kind still show (under "All").
  const shown = useMemo(() => (filter === 'all' ? d.entries : d.entries.filter((e) => e.category === filter)), [d.entries, filter]);
  const rows = useMemo(() => buildRows(shown), [shown]);
  const days = d.entries
    .filter((e) => e.category === 'event' && (e.status === 'planned' || e.status === 'in_progress') && (daysUntil(e.date) ?? -1) >= 0 && (daysUntil(e.date) ?? 999) <= 60)
    .sort((a, b) => a.date!.localeCompare(b.date!));
  const today = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  const entryRows = rows.filter((r) => r.k === 'entry').length;

  return (
    <>
      <section className="ps-section">
        <div className="ps-watermark ps-display" aria-hidden>
          CHRONICLE
        </div>
        <div className="ps-eyebrow">
          <i style={{ width: 7, height: 7, transform: 'rotate(45deg)', background: 'currentColor', display: 'inline-block' }} /> Your story
        </div>
        <h2 className="ps-h2 ps-display">
          Every goal. Every win. <span>One line.</span>
        </h2>
        <p className="ps-sub">Achievements above NOW, quests ahead below it. Complete a quest to earn XP and climb the ranks.</p>
        {kinds.length > 0 && (
          <div className="ps-filters">
            <chakra.button className={`ps-filter${filter === 'all' ? ' on' : ''}`} onClick={() => setFilter('all')}>
              All <small>{d.entries.length}</small>
            </chakra.button>
            {kinds.map((k) => (
              <chakra.button key={k} className={`ps-filter${filter === k ? ' on' : ''}`} onClick={() => setFilter(k)}>
                {ICON[k]} {CATEGORY[k].label} <small>{counts.get(k)}</small>
              </chakra.button>
            ))}
          </div>
        )}
      </section>

      {days.length > 0 && filter === 'all' && (
        <div className="ps-count">
          {days.map((e) => {
            const n = daysUntil(e.date)!;
            return (
              <chakra.button key={e.id} className="ps-countcard" onClick={() => onEdit(e)}>
                <div className="d ps-display">{n === 0 ? 'TODAY' : `D-${n}`}</div>
                <div style={{ fontWeight: 700, marginTop: 8 }}>{e.title}</div>
                <div style={{ fontSize: 12, color: 'var(--dim)' }}>{MONTH(e.date!)} · important day</div>
              </chakra.button>
            );
          })}
        </div>
      )}

      <div className="ps-line">
        {rows.map((r, i) => {
          const pos = `${i === 0 ? ' first' : ''}${i === rows.length - 1 ? ' last' : ''}`;
          if (r.k === 'mark')
            return (
              <div key={`m${r.label}`} className={`ps-row mark${rows[i + 1]?.k === 'entry' && (rows[i + 1] as { future: boolean }).future ? ' future' : ''}${pos}`}>
                <div className="ps-axis">
                  <span className="ps-tick" />
                </div>
                <div className="ps-body">
                  <span className={`ps-mark ps-display${r.small ? ' small' : ''}`}>{r.label}</span>
                </div>
              </div>
            );
          if (r.k === 'now')
            return (
              <div key="now" className={`ps-row mark now${pos}`}>
                <div className="ps-axis" />
                <div className="ps-body">
                  <span className="ps-now">
                    <b className="ps-display">NOW</b>
                    <span>{today}</span>
                  </span>
                  {entryRows === 0 && (
                    <div style={{ marginTop: 18, color: 'var(--dim)', fontSize: 14 }}>
                      {filter === 'all' ? 'Your chronicle starts here — add your first quest.' : `No ${CATEGORY[filter].label.toLowerCase()} entries yet.`}
                    </div>
                  )}
                </div>
              </div>
            );
          const late = (r.e.status === 'planned' || r.e.status === 'in_progress') && (daysUntil(r.e.date) ?? 0) < 0;
          return (
            <div key={r.e.id} className={`ps-row ${r.side}${r.future ? ' future' : ''}${pos}`}>
              <div className="ps-axis">
                <span className={`ps-node ${r.e.status}${r.e.category === 'event' ? ' event' : ''}${late ? ' late' : ''}`} />
              </div>
              <div className="ps-body">
                <Reveal dx={r.side === 'l' ? '-36px' : '36px'}>
                  <Card e={r.e} onEdit={() => onEdit(r.e)} onStatus={(s) => onStatus(r.e, s)} />
                </Reveal>
              </div>
            </div>
          );
        })}
      </div>

      <div className="ps-endcap">
        <p>The story continues.</p>
        <chakra.button className="ps-cta" onClick={onNew}>
          <LuPlus /> Write the next chapter
        </chakra.button>
      </div>
    </>
  );
}
