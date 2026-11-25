'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Badge as CBadge, Box, Button, Flex, HStack, SimpleGrid, Stack, Text, chakra } from '@chakra-ui/react';
import { LuCircleCheck, LuFlag, LuPencil, LuPlay, LuPlus, LuRocket, LuRotateCcw, LuSparkles, LuTrophy } from 'react-icons/lu';
import { api } from '../../lib/api';
import { CATEGORY, daysUntil, fmtDate, tk, useTimeline, type EntryStatus, type TimelineData, type TimelineEntry, type TimelineRelease, type UpdateResult } from '../../lib/timeline';
import { Empty, Loading, Stat } from '../ui';
import { notify } from '../toaster';
import { EntryDialog } from './EntryDialog';

type Item = { kind: 'entry'; e: TimelineEntry } | { kind: 'release'; r: TimelineRelease };

function groups(d: TimelineData) {
  const active = d.entries.filter((e) => e.status === 'in_progress').sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));
  const next = d.entries.filter((e) => e.status === 'planned').sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));
  const done: Item[] = [
    ...d.entries.filter((e) => e.status === 'achieved').map((e) => ({ kind: 'entry' as const, e })),
    ...d.releases.map((r) => ({ kind: 'release' as const, r })),
  ].sort((a, b) => (b.kind === 'entry' ? (b.e.achieved_at ?? b.e.date ?? '') : b.r.finished_at).localeCompare(a.kind === 'entry' ? (a.e.achieved_at ?? a.e.date ?? '') : a.r.finished_at));
  const dropped = d.entries.filter((e) => e.status === 'dropped');
  return { active, next, done, dropped };
}

function when(e: TimelineEntry) {
  if (e.status === 'achieved') return fmtDate(e.achieved_at ?? e.date);
  const n = daysUntil(e.date);
  if (n === null) return 'No date';
  if (n < 0) return `${fmtDate(e.date)} · ${-n} day${n === -1 ? '' : 's'} late`;
  if (n === 0) return 'Today';
  return `${fmtDate(e.date)} · in ${n} day${n === 1 ? '' : 's'}`;
}

// ================================================================ Classic (matches the rest of the app)

function ClassicRow({ e, onEdit, onStatus }: { e: TimelineEntry; onEdit: () => void; onStatus: (s: EntryStatus) => void }) {
  const c = CATEGORY[e.category];
  const late = e.status !== 'achieved' && (daysUntil(e.date) ?? 0) < 0;
  const achieved = e.status === 'achieved';
  return (
    <Flex gap="3" position="relative">
      <Flex direction="column" align="center" flexShrink={0} w="8">
        <Flex
          w="8"
          h="8"
          borderRadius="full"
          align="center"
          justify="center"
          colorPalette={achieved ? 'green' : c.palette}
          bg={achieved ? 'colorPalette.solid' : e.status === 'in_progress' ? 'colorPalette.subtle' : 'bg.panel'}
          color={achieved ? 'colorPalette.contrast' : 'colorPalette.fg'}
          borderWidth={achieved ? '0' : '2px'}
          borderColor="colorPalette.muted"
          zIndex="1"
        >
          {achieved ? <LuTrophy /> : e.status === 'in_progress' ? <LuPlay /> : <LuFlag />}
        </Flex>
        <Box flex="1" w="2px" bg="border" mt="1" />
      </Flex>
      <Box flex="1" minW="0" pb="5">
        <Box
          borderWidth="1px"
          borderRadius="lg"
          p="3"
          bg={achieved ? 'green.subtle' : 'bg.panel'}
          borderColor={achieved ? 'green.muted' : late ? 'red.muted' : 'border'}
          shadow="xs"
        >
          <Flex justify="space-between" gap="2" align="flex-start">
            <Box minW="0">
              <HStack gap="1.5" wrap="wrap">
                <CBadge size="xs" variant="subtle" colorPalette={c.palette}>
                  {c.label}
                </CBadge>
                {e.project_name && (
                  <CBadge size="xs" variant="outline" colorPalette={e.project_color ?? 'gray'}>
                    {e.project_name}
                  </CBadge>
                )}
                <Text fontSize="xs" color={late ? 'fg.error' : 'fg.muted'}>
                  {when(e)}
                </Text>
              </HStack>
              <Text fontWeight="semibold" mt="1" cursor="pointer" onClick={onEdit}>
                {e.title}
              </Text>
              {e.description && (
                <Text fontSize="sm" color="fg.muted" mt="0.5" lineClamp={3}>
                  {e.description}
                </Text>
              )}
            </Box>
            <HStack gap="1" flexShrink={0}>
              {e.status === 'planned' && (
                <Button size="2xs" variant="outline" onClick={() => onStatus('in_progress')}>
                  <LuPlay /> Start
                </Button>
              )}
              {(e.status === 'planned' || e.status === 'in_progress') && (
                <Button size="2xs" colorPalette="green" onClick={() => onStatus('achieved')}>
                  <LuCircleCheck /> Achieved
                </Button>
              )}
              {achieved && (
                <Button size="2xs" variant="ghost" onClick={() => onStatus('planned')} title="Not done after all">
                  <LuRotateCcw />
                </Button>
              )}
              <Button size="2xs" variant="ghost" onClick={onEdit} aria-label="Edit">
                <LuPencil />
              </Button>
            </HStack>
          </Flex>
        </Box>
      </Box>
    </Flex>
  );
}

function ReleaseRow({ r }: { r: TimelineRelease }) {
  return (
    <Flex gap="3">
      <Flex direction="column" align="center" flexShrink={0} w="8">
        <Flex w="8" h="8" borderRadius="full" align="center" justify="center" bg="purple.solid" color="white" zIndex="1">
          <LuRocket />
        </Flex>
        <Box flex="1" w="2px" bg="border" mt="1" />
      </Flex>
      <Box flex="1" minW="0" pb="5">
        <Box borderWidth="1px" borderRadius="lg" p="3" bg="purple.subtle" borderColor="purple.muted">
          <HStack gap="1.5" wrap="wrap">
            <CBadge size="xs" variant="solid" colorPalette="purple">
              Release
            </CBadge>
            <CBadge size="xs" variant="outline" colorPalette={r.project_color ?? 'gray'}>
              {r.project_name}
            </CBadge>
            <Text fontSize="xs" color="fg.muted">
              {fmtDate(r.finished_at)}
            </Text>
          </HStack>
          <Text fontWeight="semibold" mt="1">
            {r.app} {r.version_after} released to {r.track}
          </Text>
        </Box>
      </Box>
    </Flex>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  if (!count) return null;
  return (
    <Stack gap="2">
      <HStack gap="2">
        <Text fontFamily="heading" fontWeight="semibold">
          {title}
        </Text>
        <Text fontSize="xs" color="fg.muted">
          {count}
        </Text>
      </HStack>
      <Box>{children}</Box>
    </Stack>
  );
}

function Classic({ d, onEdit, onStatus }: { d: TimelineData; onEdit: (e: TimelineEntry) => void; onStatus: (e: TimelineEntry, s: EntryStatus) => void }) {
  const g = groups(d);
  const s = d.stats;
  return (
    <Stack gap="6">
      <SimpleGrid columns={{ base: 2, md: 5 }} gap="3">
        <Stat label="Achieved" value={s.achieved} />
        <Stat label="In progress" value={s.active} />
        <Stat label="Next up" value={s.upcoming} />
        <Stat label="Overdue" value={s.overdue} />
        <Stat label="Level" value={s.level} hint={`Rank ${s.rank} · ${s.xp} XP`} />
      </SimpleGrid>
      <Section title="In progress" count={g.active.length}>
        {g.active.map((e) => (
          <ClassicRow key={e.id} e={e} onEdit={() => onEdit(e)} onStatus={(st) => onStatus(e, st)} />
        ))}
      </Section>
      <Section title="Next up" count={g.next.length}>
        {g.next.map((e) => (
          <ClassicRow key={e.id} e={e} onEdit={() => onEdit(e)} onStatus={(st) => onStatus(e, st)} />
        ))}
      </Section>
      <Section title="Achieved" count={g.done.length}>
        {g.done.map((it) => (it.kind === 'entry' ? <ClassicRow key={it.e.id} e={it.e} onEdit={() => onEdit(it.e)} onStatus={(st) => onStatus(it.e, st)} /> : <ReleaseRow key={it.r.id} r={it.r} />))}
      </Section>
      <Section title="Dropped" count={g.dropped.length}>
        {g.dropped.map((e) => (
          <Box key={e.id} opacity={0.6}>
            <ClassicRow e={e} onEdit={() => onEdit(e)} onStatus={(st) => onStatus(e, st)} />
          </Box>
        ))}
      </Section>
    </Stack>
  );
}

// ================================================================ Quest (game HUD look — original design)

const HUD = {
  bg: '#060b18',
  panel: 'rgba(10, 22, 48, 0.88)',
  line: 'rgba(96, 165, 250, 0.45)',
  glow: '0 0 0 1px rgba(96,165,250,.35), 0 0 18px rgba(56,189,248,.25), inset 0 0 22px rgba(56,189,248,.08)',
  text: '#e6f1ff',
  dim: '#8fb3d9',
  accent: '#5cc8ff',
  gold: '#ffd166',
  red: '#ff6b81',
};
export const RANK_COLOR: Record<string, string> = { E: '#9ca3af', D: '#60a5fa', C: '#34d399', B: '#a78bfa', A: '#f472b6', S: '#ffd166' };
const clip = 'polygon(12px 0, 100% 0, 100% calc(100% - 12px), calc(100% - 12px) 100%, 0 100%, 0 12px)';

function HudPanel({ title, children, accent = HUD.accent }: { title?: string; children: ReactNode; accent?: string }) {
  return (
    <Box position="relative" bg={HUD.panel} style={{ clipPath: clip, boxShadow: HUD.glow }} border="1px solid" borderColor={HUD.line} p="4" backdropFilter="blur(6px)">
      {title && (
        <HStack gap="2" mb="3">
          <Box w="2" h="2" bg={accent} transform="rotate(45deg)" boxShadow={`0 0 10px ${accent}`} />
          <Text fontFamily="heading" fontWeight="bold" letterSpacing="0.2em" fontSize="xs" color={accent} textTransform="uppercase">
            {title}
          </Text>
          <Box flex="1" h="1px" bg={`linear-gradient(90deg, ${accent}, transparent)`} />
        </HStack>
      )}
      {children}
    </Box>
  );
}

function QuestCard({ e, onEdit, onStatus }: { e: TimelineEntry; onEdit: () => void; onStatus: (s: EntryStatus) => void }) {
  const c = CATEGORY[e.category];
  const n = daysUntil(e.date);
  const cleared = e.status === 'achieved';
  const late = !cleared && n !== null && n < 0;
  const edge = cleared ? HUD.gold : late ? HUD.red : e.status === 'in_progress' ? HUD.accent : HUD.line;
  return (
    <Box
      position="relative"
      p="3"
      bg="rgba(8, 18, 40, 0.9)"
      border="1px solid"
      borderColor={edge}
      style={{ clipPath: clip, boxShadow: cleared ? `0 0 16px ${HUD.gold}40` : e.status === 'in_progress' ? `0 0 16px ${HUD.accent}40` : undefined }}
      className={e.status === 'in_progress' ? 'pt-quest-pulse' : undefined}
    >
      <Flex justify="space-between" gap="3" align="flex-start">
        <Box minW="0">
          <HStack gap="2" fontSize="2xs" letterSpacing="0.15em" textTransform="uppercase" color={HUD.dim}>
            <Text color={cleared ? HUD.gold : HUD.accent} fontWeight="bold">
              {cleared ? 'Cleared' : e.status === 'in_progress' ? 'Active quest' : late ? 'Overdue' : 'Quest'}
            </Text>
            <Text>· {c.label}</Text>
            {e.project_name && <Text>· {e.project_name}</Text>}
          </HStack>
          <Text color={HUD.text} fontWeight="semibold" mt="1" cursor="pointer" onClick={onEdit} textDecoration={cleared ? 'none' : undefined}>
            {e.title}
          </Text>
          {e.description && (
            <Text fontSize="xs" color={HUD.dim} mt="0.5" lineClamp={2}>
              {e.description}
            </Text>
          )}
          <HStack gap="3" mt="2" fontSize="xs">
            <Text color={late ? HUD.red : HUD.dim}>{cleared ? fmtDate(e.achieved_at ?? e.date) : n === null ? 'No deadline' : n < 0 ? `D+${-n}` : n === 0 ? 'D-DAY' : `D-${n}`}</Text>
            <Text color={HUD.gold} fontWeight="bold">
              {cleared ? `+${c.xp} XP earned` : `Reward +${c.xp} XP`}
            </Text>
          </HStack>
        </Box>
        <Stack gap="1" flexShrink={0} align="flex-end">
          {e.status === 'planned' && (
            <chakra.button className="pt-hud-btn" onClick={() => onStatus('in_progress')}>
              Accept
            </chakra.button>
          )}
          {(e.status === 'planned' || e.status === 'in_progress') && (
            <chakra.button className="pt-hud-btn pt-hud-btn-gold" onClick={() => onStatus('achieved')}>
              Complete
            </chakra.button>
          )}
          <chakra.button className="pt-hud-btn pt-hud-btn-ghost" onClick={onEdit} aria-label="Edit">
            <LuPencil />
          </chakra.button>
        </Stack>
      </Flex>
    </Box>
  );
}

/** The game-HUD status window. `embedded`: inside another full-page view (no page bleed / own background). */
export function Quest({
  d,
  onEdit,
  onStatus,
  header,
  embedded,
}: {
  d: TimelineData;
  onEdit: (e: TimelineEntry) => void;
  onStatus: (e: TimelineEntry, s: EntryStatus) => void;
  header?: ReactNode;
  embedded?: boolean;
}) {
  const g = groups(d);
  // Important days still ahead (next 60 days), soonest first.
  const days = d.entries
    .filter((e) => e.category === 'event' && e.status !== 'achieved' && e.status !== 'dropped' && (daysUntil(e.date) ?? -1) >= 0 && (daysUntil(e.date) ?? 99) <= 60)
    .sort((a, b) => a.date!.localeCompare(b.date!));
  const s = d.stats;
  const next = s.next;
  const pct = s.level_span ? (s.level_xp / s.level_span) * 100 : 0;
  return (
    <Box
      position="relative"
      mx={embedded ? undefined : { base: '-4', md: '-6' }}
      my={embedded ? undefined : '-5'}
      minH={embedded ? undefined : 'calc(100dvh - 57px)'}
      p={{ base: '4', md: '6' }}
      color={HUD.text}
      bg={embedded ? 'transparent' : HUD.bg}
      overflow="hidden"
      css={{
        backgroundImage: embedded
          ? `linear-gradient(rgba(96,165,250,.05) 1px, transparent 1px), linear-gradient(90deg, rgba(96,165,250,.05) 1px, transparent 1px)`
          : `radial-gradient(ellipse at 20% 0%, rgba(56,189,248,.18), transparent 55%), radial-gradient(ellipse at 100% 100%, rgba(129,140,248,.14), transparent 50%),
          linear-gradient(rgba(96,165,250,.06) 1px, transparent 1px), linear-gradient(90deg, rgba(96,165,250,.06) 1px, transparent 1px)`,
        backgroundSize: embedded ? '32px 32px, 32px 32px' : 'auto, auto, 32px 32px, 32px 32px',
        '& .pt-hud-btn': {
          fontSize: '11px',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          fontWeight: 700,
          padding: '4px 10px',
          color: HUD.accent,
          border: `1px solid ${HUD.accent}`,
          background: 'rgba(56,189,248,.08)',
          clipPath: 'polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px)',
          transition: 'background .15s, box-shadow .15s',
        },
        '& .pt-hud-btn:hover': { background: 'rgba(56,189,248,.2)', boxShadow: `0 0 12px ${HUD.accent}` },
        '& .pt-hud-btn-gold': { color: HUD.gold, borderColor: HUD.gold, background: 'rgba(255,209,102,.08)' },
        '& .pt-hud-btn-gold:hover': { background: 'rgba(255,209,102,.2)', boxShadow: `0 0 12px ${HUD.gold}` },
        '& .pt-hud-btn-ghost': { color: HUD.dim, borderColor: 'transparent', background: 'transparent' },
        '@keyframes pt-pulse': { '0%,100%': { boxShadow: '0 0 6px rgba(92,200,255,.25)' }, '50%': { boxShadow: '0 0 22px rgba(92,200,255,.55)' } },
        '& .pt-quest-pulse': { animation: 'pt-pulse 2.4s ease-in-out infinite' },
        '@media (prefers-reduced-motion: reduce)': { '& .pt-quest-pulse': { animation: 'none' } },
      }}
    >
      <Stack gap="4">
        {header}
        <SimpleGrid columns={{ base: 1, lg: 3 }} gap="4">
          <HudPanel title="Status">
            <Flex gap="4" align="center">
              <Flex
                w="20"
                h="20"
                align="center"
                justify="center"
                flexShrink={0}
                style={{ clipPath: 'polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%)', background: `linear-gradient(160deg, ${RANK_COLOR[s.rank]}, #0b1a3a)` }}
              >
                <Text fontFamily="heading" fontWeight="black" fontSize="4xl" color="#06101f">
                  {s.rank}
                </Text>
              </Flex>
              <Box flex="1" minW="0">
                <Text fontSize="xs" letterSpacing="0.2em" color={HUD.dim}>
                  LEVEL
                </Text>
                <Text fontFamily="heading" fontWeight="black" fontSize="5xl" lineHeight="1" style={{ textShadow: `0 0 18px ${HUD.accent}` }}>
                  {s.level}
                </Text>
                <Box mt="2" h="2" bg="rgba(96,165,250,.15)" border="1px solid" borderColor={HUD.line}>
                  <Box h="100%" w={`${pct}%`} bg={`linear-gradient(90deg, ${HUD.accent}, #a5f3fc)`} boxShadow={`0 0 10px ${HUD.accent}`} transition="width .6s" />
                </Box>
                <Text fontSize="xs" color={HUD.dim} mt="1">
                  {s.level_xp} / {s.level_span} XP to level {s.level + 1}
                </Text>
              </Box>
            </Flex>
          </HudPanel>
          <HudPanel title="Stats">
            <SimpleGrid columns={2} gap="3">
              {[
                ['Cleared', s.achieved, HUD.gold],
                ['Active', s.active, HUD.accent],
                ['Upcoming', s.upcoming, HUD.text],
                ['Overdue', s.overdue, s.overdue ? HUD.red : HUD.dim],
              ].map(([label, v, color]) => (
                <Box key={label as string}>
                  <Text fontSize="2xs" letterSpacing="0.18em" color={HUD.dim} textTransform="uppercase">
                    {label}
                  </Text>
                  <Text fontFamily="heading" fontWeight="bold" fontSize="2xl" color={color as string}>
                    {v as number}
                  </Text>
                </Box>
              ))}
            </SimpleGrid>
            <Text fontSize="xs" color={HUD.dim} mt="2">
              Total {s.xp} XP
            </Text>
          </HudPanel>
          <HudPanel title="Next quest" accent={HUD.gold}>
            {next ? (
              <Box>
                <Text fontWeight="semibold" lineClamp={2}>
                  {next.title}
                </Text>
                <Text fontFamily="heading" fontWeight="black" fontSize="3xl" color={HUD.gold} mt="1" style={{ textShadow: `0 0 14px ${HUD.gold}80` }}>
                  {(() => {
                    const n = daysUntil(next.date) ?? 0;
                    return n === 0 ? 'D-DAY' : `D-${n}`;
                  })()}
                </Text>
                <Text fontSize="xs" color={HUD.dim}>
                  {fmtDate(next.date)} · {CATEGORY[next.category].label} · +{CATEGORY[next.category].xp} XP
                </Text>
              </Box>
            ) : (
              <Text fontSize="sm" color={HUD.dim}>
                No dated quest. Add a goal with a target date.
              </Text>
            )}
          </HudPanel>
        </SimpleGrid>

        {days.length > 0 && (
          <HudPanel title="Important days" accent="#f472b6">
            <Flex gap="3" wrap="wrap">
              {days.map((e) => {
                const n = daysUntil(e.date)!;
                return (
                  <chakra.button key={e.id} onClick={() => onEdit(e)} textAlign="left" px="3" py="2" border="1px solid" borderColor="rgba(244,114,182,.5)" bg="rgba(244,114,182,.08)" style={{ clipPath: clip }}>
                    <Text fontFamily="heading" fontWeight="black" color="#f9a8d4" fontSize="lg">
                      {n === 0 ? 'TODAY' : `D-${n}`}
                    </Text>
                    <Text fontSize="sm" fontWeight="semibold">
                      {e.title}
                    </Text>
                    <Text fontSize="xs" color={HUD.dim}>
                      {fmtDate(e.date)}
                    </Text>
                  </chakra.button>
                );
              })}
            </Flex>
          </HudPanel>
        )}

        <SimpleGrid columns={{ base: 1, lg: 2 }} gap="4" alignItems="start">
          <Stack gap="4">
            <HudPanel title={`Active quests · ${g.active.length}`}>
              <Stack gap="2">
                {g.active.length ? g.active.map((e) => <QuestCard key={e.id} e={e} onEdit={() => onEdit(e)} onStatus={(st) => onStatus(e, st)} />) : <Text fontSize="sm" color={HUD.dim}>No active quest — accept one below.</Text>}
              </Stack>
            </HudPanel>
            <HudPanel title={`Quest log · ${g.next.length}`}>
              <Stack gap="2">
                {g.next.length ? g.next.map((e) => <QuestCard key={e.id} e={e} onEdit={() => onEdit(e)} onStatus={(st) => onStatus(e, st)} />) : <Text fontSize="sm" color={HUD.dim}>Empty. Add your next goal.</Text>}
              </Stack>
            </HudPanel>
          </Stack>
          <HudPanel title={`Achievements · ${g.done.length}`} accent={HUD.gold}>
            <Stack gap="2">
              {g.done.length ? (
                g.done.map((it) =>
                  it.kind === 'entry' ? (
                    <QuestCard key={it.e.id} e={it.e} onEdit={() => onEdit(it.e)} onStatus={(st) => onStatus(it.e, st)} />
                  ) : (
                    <Box key={it.r.id} p="3" border="1px solid" borderColor={HUD.gold} bg="rgba(8,18,40,.9)" style={{ clipPath: clip }}>
                      <HStack gap="2" fontSize="2xs" letterSpacing="0.15em" color={HUD.gold} fontWeight="bold">
                        <LuRocket /> <Text>RELEASE · {it.r.project_name}</Text>
                      </HStack>
                      <Text fontWeight="semibold" mt="1">
                        {it.r.app} {it.r.version_after} → {it.r.track}
                      </Text>
                      <Text fontSize="xs" color={HUD.dim}>
                        {fmtDate(it.r.finished_at)} · <Text as="span" color={HUD.gold}>+100 XP earned</Text>
                      </Text>
                    </Box>
                  ),
                )
              ) : (
                <Text fontSize="sm" color={HUD.dim}>
                  Nothing cleared yet. Every finished goal and every Play release lands here.
                </Text>
              )}
            </Stack>
          </HudPanel>
        </SimpleGrid>
      </Stack>
    </Box>
  );
}

/** The "level up" moment (Quest view). Respects reduced-motion. */
export function LevelUp({ level, rank, onDone }: { level: number; rank: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2600);
    return () => clearTimeout(t);
  }, [onDone]);
  return (
    <Flex
      position="fixed"
      inset="0"
      zIndex="modal"
      align="center"
      justify="center"
      bg="rgba(2,6,18,.55)"
      onClick={onDone}
      css={{
        '@keyframes pt-lvl': { '0%': { transform: 'scale(.7)', opacity: 0 }, '18%': { transform: 'scale(1.06)', opacity: 1 }, '30%': { transform: 'scale(1)' }, '85%': { opacity: 1 }, '100%': { opacity: 0 } },
        '& > div': { animation: 'pt-lvl 2.6s ease-out forwards' },
        '@media (prefers-reduced-motion: reduce)': { '& > div': { animation: 'none' } },
      }}
    >
      <Box px="12" py="8" textAlign="center" color={HUD.text} bg="rgba(8,18,40,.95)" border="1px solid" borderColor={HUD.accent} style={{ clipPath: clip, boxShadow: `0 0 60px ${HUD.accent}80` }}>
        <HStack justify="center" gap="2" color={HUD.accent} letterSpacing="0.3em" fontSize="sm" fontWeight="bold">
          <LuSparkles /> <Text>LEVEL UP</Text> <LuSparkles />
        </HStack>
        <Text fontFamily="heading" fontWeight="black" fontSize="7xl" lineHeight="1" mt="2" style={{ textShadow: `0 0 24px ${HUD.accent}` }}>
          {level}
        </Text>
        <Text letterSpacing="0.2em" fontSize="sm" color={RANK_COLOR[rank]} mt="2" fontWeight="bold">
          RANK {rank}
        </Text>
      </Box>
    </Flex>
  );
}

/** Shared: change status (with XP / level-up feedback) and edit. */
export function useTimelineActions(onLevelUp: (level: number, rank: string) => void) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<TimelineEntry | 'new' | null>(null);
  const reload = () => qc.invalidateQueries({ queryKey: tk.all });
  const celebrate = (r?: UpdateResult) => {
    if (!r) return;
    if (r.level_after > r.level_before) onLevelUp(r.level_after, r.rank);
    else if (r.xp_gained > 0) notify('ok', `Achieved — +${r.xp_gained} XP`);
  };
  const setStatus = async (e: TimelineEntry, status: EntryStatus) => {
    try {
      celebrate(await api<UpdateResult>(`/timeline/${e.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }));
      await reload();
    } catch (err: any) {
      notify('error', err.message);
    }
  };
  return { editing, setEditing, reload, celebrate, setStatus };
}

/** Projects → Timeline (and a project's Timeline tab): project milestones and Play releases, in the app's own style. */
export function ProjectTimeline({ projectId }: { projectId?: string }) {
  const q = useTimeline('project', projectId);
  const t = useTimelineActions((level, rank) => notify('ok', `Level up! You are level ${level} (rank ${rank})`));
  return (
    <Stack gap="4">
      <Flex gap="2" wrap="wrap" align="center">
        <Text fontSize="sm" color="fg.muted">
          Milestones from planning to completion, and every release to Google Play. Your own goals live in Maintenance → Personal space.
        </Text>
        <Button size="sm" ms="auto" onClick={() => t.setEditing('new')}>
          <LuPlus /> Add milestone
        </Button>
      </Flex>
      {!q.data ? (
        <Loading rows={4} height="16" label="Loading the timeline" />
      ) : q.data.entries.length === 0 && q.data.releases.length === 0 ? (
        <Empty
          icon={<LuFlag />}
          title={projectId ? 'No milestones for this project yet' : 'No project milestones yet'}
          action={
            <Button size="sm" onClick={() => t.setEditing('new')}>
              <LuPlus /> Add the first milestone
            </Button>
          }
        >
          Planning, development, testing, deployment, completion — with target dates. Play releases appear here by themselves.
        </Empty>
      ) : (
        <Classic d={q.data} onEdit={t.setEditing} onStatus={(e, s) => void t.setStatus(e, s)} />
      )}
      <EntryDialog mode="project" entry={t.editing} projectId={projectId} onClose={() => t.setEditing(null)} onSaved={(r) => (t.celebrate(r), void t.reload())} />
    </Stack>
  );
}

export const EMPTY: TimelineData = {
  entries: [],
  releases: [],
  stats: { level: 1, rank: 'E', xp: 0, level_xp: 0, level_span: 50, achieved: 0, active: 0, upcoming: 0, overdue: 0, next: null },
};
