'use client';
import { Fragment, type ReactNode } from 'react';
import { Box, Checkbox, Code, Heading, Link, Stack, Text } from '@chakra-ui/react';

/**
 * A small, safe Markdown view for notes: # headings, - lists, - [ ] checklists (clickable), **bold**, *italic*,
 * `code`, ``` code blocks ```, [links](https://…) and bare URLs. Builds React elements — no HTML is injected.
 */

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|https?:\/\/[^\s)]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${keyBase}-${i++}`;
    if (t.startsWith('**')) out.push(<b key={k}>{t.slice(2, -2)}</b>);
    else if (t.startsWith('`'))
      out.push(
        <Code key={k} size="sm">
          {t.slice(1, -1)}
        </Code>,
      );
    else if (t.startsWith('[')) {
      const [, label, url] = t.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/) ?? [];
      out.push(
        SAFE_URL.test(url ?? '') ? (
          <Link key={k} href={url} target="_blank" rel="noreferrer" color="colorPalette.fg">
            {label}
          </Link>
        ) : (
          label
        ),
      );
    } else if (t.startsWith('http'))
      out.push(
        <Link key={k} href={t} target="_blank" rel="noreferrer" color="colorPalette.fg" wordBreak="break-all">
          {t}
        </Link>,
      );
    else out.push(<i key={k}>{t.slice(1, -1)}</i>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, onToggle }: { text: string; onToggle?: (lineIndex: number) => void }) {
  const lines = text.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) code.push(lines[i++]);
      blocks.push(
        <Box key={i} as="pre" fontFamily="mono" fontSize="xs" bg="bg.muted" borderRadius="md" p="3" overflowX="auto" whiteSpace="pre">
          {code.join('\n')}
        </Box>,
      );
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      blocks.push(
        <Heading key={i} as={h[1].length === 1 ? 'h2' : 'h3'} size={h[1].length === 1 ? 'lg' : h[1].length === 2 ? 'md' : 'sm'} fontFamily="heading" mt="2">
          {inline(h[2], `h${i}`)}
        </Heading>,
      );
      continue;
    }
    const task = line.match(/^(\s*)[-*] \[([ xX])\]\s?(.*)$/);
    if (task) {
      const done = task[2] !== ' ';
      blocks.push(
        <Checkbox.Root key={i} size="sm" checked={done} onCheckedChange={() => onToggle?.(i)} disabled={!onToggle} ps={`${task[1].length * 8}px`} alignItems="flex-start">
          <Checkbox.HiddenInput />
          <Checkbox.Control mt="0.5" />
          <Checkbox.Label textDecoration={done ? 'line-through' : undefined} color={done ? 'fg.muted' : undefined} fontWeight="normal">
            {inline(task[3], `t${i}`)}
          </Checkbox.Label>
        </Checkbox.Root>,
      );
      continue;
    }
    const li = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (li) {
      blocks.push(
        <Text key={i} ps={`${8 + li[1].length * 8}px`}>
          <Text as="span" color="fg.muted" me="2">
            {/\d/.test(li[2]) ? li[2] : '•'}
          </Text>
          {inline(li[3], `l${i}`)}
        </Text>,
      );
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      blocks.push(
        <Text key={i} borderLeftWidth="3px" borderColor="border.emphasized" ps="3" color="fg.muted">
          {inline(line.replace(/^\s*>\s?/, ''), `q${i}`)}
        </Text>,
      );
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      blocks.push(<Box key={i} as="hr" borderColor="border" my="2" />);
      continue;
    }
    blocks.push(line.trim() ? <Text key={i}>{inline(line, `p${i}`)}</Text> : <Box key={i} h="2" />);
  }
  return (
    <Stack gap="1" fontSize="sm" lineHeight="1.6">
      {blocks.map((b, i) => (
        <Fragment key={i}>{b}</Fragment>
      ))}
    </Stack>
  );
}

/** Flip "- [ ]" ↔ "- [x]" on one line of a note body. */
export function toggleChecklistLine(text: string, lineIndex: number) {
  const lines = text.split(/\r?\n/);
  const l = lines[lineIndex];
  if (l !== undefined) lines[lineIndex] = /\[[xX]\]/.test(l) ? l.replace(/\[[xX]\]/, '[ ]') : l.replace('[ ]', '[x]');
  return lines.join('\n');
}
