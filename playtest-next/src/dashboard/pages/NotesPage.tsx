'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Box, Button, Flex, Grid, HStack, IconButton, Input, NativeSelect, SegmentGroup, Stack, Text, Textarea, chakra } from '@chakra-ui/react';
import { LuEye, LuNotebook, LuPin, LuPinOff, LuPlus, LuSearch, LuSquareCheck, LuSquarePen, LuTrash2 } from 'react-icons/lu';
import { api } from '../lib/api';
import { checklist, nk, noteTitle, useNotebook, type NotebookEntry } from '../lib/notebook';
import { ago, useProjects } from '../lib/projects';
import { Empty, Loading } from '../components/ui';
import { Markdown, toggleChecklistLine } from '../components/Markdown';
import { notify } from '../components/toaster';

const COLORS = ['gray', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'] as const;
const SEL_KEY = 'pt-notes-selected';
const MODE_KEY = 'pt-notes-mode';
const ls = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* not remembered */
    }
  },
};

/** The editor for one note: saves by itself shortly after you stop typing. */
function Editor({ note, onDeleted }: { note: NotebookEntry; onDeleted: () => void }) {
  const qc = useQueryClient();
  const projects = useProjects().data ?? [];
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [mode, setMode] = useState<'edit' | 'preview'>(() => (ls.get(MODE_KEY) === 'preview' && note.body ? 'preview' : 'edit'));
  const [state, setState] = useState<'saved' | 'saving' | 'dirty'>('saved');
  const pending = useRef<Partial<NotebookEntry>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = async () => {
    if (timer.current) clearTimeout(timer.current);
    const patch = pending.current;
    pending.current = {};
    if (!Object.keys(patch).length) return;
    setState('saving');
    try {
      const saved = await api<NotebookEntry>(`/notebook/${note.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      qc.setQueriesData<NotebookEntry[]>({ queryKey: nk.all }, (list) => list?.map((n) => (n.id === saved.id ? saved : n)));
      setState(Object.keys(pending.current).length ? 'dirty' : 'saved');
    } catch (e: any) {
      setState('dirty');
      notify('error', e.message);
    }
  };
  const queue = (patch: Partial<NotebookEntry>, now = false) => {
    pending.current = { ...pending.current, ...patch };
    setState('dirty');
    if (timer.current) clearTimeout(timer.current);
    if (now) void flush();
    else timer.current = setTimeout(() => void flush(), 600);
  };
  // Save what is left when switching notes or leaving the page.
  useEffect(() => () => void flush(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const remove = async () => {
    if (!confirm(`Delete "${noteTitle({ title, body })}"?`)) return;
    try {
      pending.current = {};
      await api(`/notebook/${note.id}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: nk.all });
      onDeleted();
    } catch (e: any) {
      notify('error', e.message);
    }
  };
  const progress = checklist(body);

  return (
    <Stack gap="3" h="100%" minH="0">
      <Flex gap="2" align="center" wrap="wrap">
        <SegmentGroup.Root
          size="xs"
          value={mode}
          onValueChange={(e) => {
            setMode(e.value as 'edit' | 'preview');
            ls.set(MODE_KEY, e.value as string);
          }}
        >
          <SegmentGroup.Indicator />
          <SegmentGroup.Items
            items={[
              { value: 'edit', label: <HStack gap="1"><LuSquarePen /> Write</HStack> },
              { value: 'preview', label: <HStack gap="1"><LuEye /> Preview</HStack> },
            ]}
          />
        </SegmentGroup.Root>
        <IconButton size="xs" variant={note.pinned ? 'subtle' : 'ghost'} aria-label={note.pinned ? 'Unpin' : 'Pin'} title={note.pinned ? 'Unpin' : 'Pin to the top'} onClick={() => queue({ pinned: !note.pinned } as never, true)}>
          {note.pinned ? <LuPinOff /> : <LuPin />}
        </IconButton>
        <HStack gap="1">
          {COLORS.map((c) => (
            <chakra.button
              key={c}
              aria-label={`Color ${c}`}
              w="4"
              h="4"
              borderRadius="full"
              bg={c === 'gray' ? 'bg.emphasized' : `${c}.solid`}
              outline={(note.color ?? 'gray') === c ? '2px solid' : 'none'}
              outlineColor="fg.muted"
              outlineOffset="1px"
              onClick={() => queue({ color: c === 'gray' ? null : c }, true)}
            />
          ))}
        </HStack>
        {projects.length > 0 && (
          <NativeSelect.Root size="xs" w="auto" minW="150px">
            <NativeSelect.Field value={note.project_id ?? ''} onChange={(e) => queue({ project_id: e.target.value || null }, true)} aria-label="Project">
              <option value="">No project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
        )}
        <Text fontSize="xs" color="fg.muted" ms="auto">
          {state === 'saving' ? 'Saving…' : state === 'dirty' ? 'Editing…' : `Saved · ${ago(note.updated_at)}`}
        </Text>
        <IconButton size="xs" variant="ghost" colorPalette="red" aria-label="Delete note" onClick={() => void remove()}>
          <LuTrash2 />
        </IconButton>
      </Flex>
      <Input
        variant="flushed"
        fontSize="xl"
        fontFamily="heading"
        fontWeight="semibold"
        placeholder="Title"
        value={title}
        maxLength={200}
        onChange={(e) => {
          setTitle(e.target.value);
          queue({ title: e.target.value });
        }}
      />
      {progress.total > 0 && (
        <HStack gap="1.5" fontSize="xs" color="fg.muted">
          <LuSquareCheck /> {progress.done}/{progress.total} done
        </HStack>
      )}
      {mode === 'edit' ? (
        <Textarea
          flex="1"
          minH="360px"
          resize="none"
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            queue({ body: e.target.value });
          }}
          placeholder={'# Heading\n- [ ] checklist item\n- bullet\n**bold**  *italic*  `code`\n```\ncode block\n```\n[link](https://…)'}
          fontFamily="mono"
          fontSize="sm"
          lineHeight="1.6"
          autoFocus={!body}
        />
      ) : (
        <Box flex="1" minH="360px" overflowY="auto" borderWidth="1px" borderRadius="md" p="4">
          {body.trim() ? (
            <Markdown
              text={body}
              onToggle={(line) => {
                const next = toggleChecklistLine(body, line);
                setBody(next);
                queue({ body: next }, true);
              }}
            />
          ) : (
            <Text color="fg.muted" fontSize="sm">
              Empty note — switch to Write.
            </Text>
          )}
        </Box>
      )}
    </Stack>
  );
}

/** Notebook: quick notes, checklists, commands and ideas — searchable, pinnable, linkable to a project. */
export function NotesPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  const list = useNotebook(q);
  const notes = list.data ?? null;
  const [selected, setSelected] = useState<string | null>(() => ls.get(SEL_KEY));
  useEffect(() => {
    if (selected) ls.set(SEL_KEY, selected);
  }, [selected]);
  useEffect(() => {
    if (notes && notes.length && !notes.some((n) => n.id === selected)) setSelected(notes[0].id);
  }, [notes, selected]);
  const current = useMemo(() => notes?.find((n) => n.id === selected) ?? null, [notes, selected]);

  const create = async () => {
    try {
      const n = await api<NotebookEntry>('/notebook', { method: 'POST', body: JSON.stringify({}) });
      setSearch('');
      await qc.invalidateQueries({ queryKey: nk.all });
      setSelected(n.id);
    } catch (e: any) {
      notify('error', e.message);
    }
  };

  return (
    <Grid templateColumns={{ base: '1fr', lg: '320px minmax(0, 1fr)' }} gap="4" alignItems="start">
      <Stack gap="3" borderWidth="1px" borderRadius="xl" bg="bg.panel" p="3" position={{ lg: 'sticky' }} top="20" maxH={{ lg: 'calc(100dvh - 120px)' }}>
        <Flex justify="space-between" align="center">
          <HStack gap="2">
            <LuNotebook />
            <Text fontWeight="semibold" fontFamily="heading">
              Notes
            </Text>
            <Text fontSize="xs" color="fg.muted">
              {notes?.length ?? ''}
            </Text>
          </HStack>
          <Button size="xs" onClick={() => void create()}>
            <LuPlus /> New
          </Button>
        </Flex>
        <HStack gap="2" borderWidth="1px" borderRadius="md" px="2">
          <Box color="fg.muted">
            <LuSearch />
          </Box>
          <Input size="sm" variant="flushed" border="none" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search notes" aria-label="Search notes" />
        </HStack>
        <Stack gap="1" overflowY="auto" minH="0" flex="1">
          {notes === null ? (
            <Loading rows={4} height="12" />
          ) : notes.length === 0 ? (
            <Text fontSize="sm" color="fg.muted" p="2">
              {q ? 'No note matches.' : 'No notes yet.'}
            </Text>
          ) : (
            notes.map((n) => {
              const active = n.id === selected;
              const cl = checklist(n.body);
              return (
                <chakra.button
                  key={n.id}
                  onClick={() => setSelected(n.id)}
                  textAlign="left"
                  p="2.5"
                  borderRadius="md"
                  borderLeftWidth="3px"
                  borderLeftColor={n.color ? `${n.color}.solid` : 'transparent'}
                  bg={active ? 'colorPalette.subtle' : 'transparent'}
                  _hover={{ bg: active ? 'colorPalette.subtle' : 'bg.muted' }}
                >
                  <HStack gap="1.5" justify="space-between">
                    <Text fontWeight="medium" fontSize="sm" truncate>
                      {noteTitle(n)}
                    </Text>
                    {n.pinned ? (
                      <Box color="fg.muted" fontSize="xs" flexShrink={0}>
                        <LuPin />
                      </Box>
                    ) : null}
                  </HStack>
                  <Text fontSize="xs" color="fg.muted" lineClamp={2}>
                    {n.body.replace(/\[[ xX]\]/g, '').replace(/[#*`>[\]-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140) || 'Empty'}
                  </Text>
                  <HStack gap="2" fontSize="2xs" color="fg.subtle" mt="1">
                    <Text>{ago(n.updated_at)}</Text>
                    {cl.total > 0 && <Text>· {cl.done}/{cl.total} ✓</Text>}
                    {n.project_name && <Text truncate>· {n.project_name}</Text>}
                  </HStack>
                </chakra.button>
              );
            })
          )}
        </Stack>
      </Stack>

      <Box borderWidth="1px" borderRadius="xl" bg="bg.panel" p={{ base: '3', md: '5' }} minH="520px">
        {current ? (
          <Editor key={current.id} note={current} onDeleted={() => setSelected(null)} />
        ) : notes && notes.length === 0 ? (
          <Empty
            icon={<LuNotebook />}
            title="Your notebook"
            action={
              <Button size="sm" onClick={() => void create()}>
                <LuPlus /> Write the first note
              </Button>
            }
          >
            Commands you keep forgetting, release checklists, ideas, meeting notes. Press Alt+N anywhere for a quick note.
          </Empty>
        ) : (
          <Loading rows={6} height="6" />
        )}
      </Box>
    </Grid>
  );
}
