'use client';
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Badge as CBadge, Box, Button, CloseButton, Dialog, Field, Flex, HStack, IconButton, Input, NativeSelect, Portal, SimpleGrid, Stack, Text, Textarea, chakra } from '@chakra-ui/react';
import { LuBug, LuCalendar, LuFlag, LuLightbulb, LuListTodo, LuNotebookPen, LuPencil, LuPlus, LuStickyNote, LuTrash2 } from 'react-icons/lu';
import { api } from '../../lib/api';
import { ago, pk, useNotes, type Note, type NoteKind, type NoteStatus, type Priority, type ProjectComponent } from '../../lib/projects';
import { Card, Empty, Loading } from '../../components/ui';
import { notify } from '../../components/toaster';

const KINDS: { id: NoteKind; label: string; icon: React.ReactNode; palette: string }[] = [
  { id: 'requirement', label: 'Requirement', icon: <LuNotebookPen />, palette: 'purple' },
  { id: 'task', label: 'Task', icon: <LuListTodo />, palette: 'blue' },
  { id: 'bug', label: 'Bug', icon: <LuBug />, palette: 'red' },
  { id: 'idea', label: 'Idea', icon: <LuLightbulb />, palette: 'yellow' },
  { id: 'note', label: 'Note', icon: <LuStickyNote />, palette: 'gray' },
];
const KIND = Object.fromEntries(KINDS.map((k) => [k.id, k])) as Record<NoteKind, (typeof KINDS)[number]>;
const COLUMNS: { id: NoteStatus; label: string }[] = [
  { id: 'todo', label: 'To do' },
  { id: 'doing', label: 'Doing' },
  { id: 'done', label: 'Done' },
];
const PRIORITY_COLOR: Record<Priority, string> = { high: 'red.fg', medium: 'orange.fg', low: 'fg.subtle' };

function Select({ value, onChange, children, label }: { value: string; onChange: (v: string) => void; children: React.ReactNode; label: string }) {
  return (
    <NativeSelect.Root size="sm">
      <NativeSelect.Field value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        {children}
      </NativeSelect.Field>
      <NativeSelect.Indicator />
    </NativeSelect.Root>
  );
}

function NoteCard({ n, part, onEdit, onMove, onDelete }: { n: Note; part?: string; onEdit: () => void; onMove: (s: NoteStatus) => void; onDelete: () => void }) {
  const k = KIND[n.kind];
  const overdue = n.due_date && n.status !== 'done' && n.due_date < new Date().toISOString().slice(0, 10);
  return (
    <Box
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/note-id', n.id)}
      borderWidth="1px"
      borderRadius="lg"
      bg="bg.panel"
      p="3"
      shadow="xs"
      cursor="grab"
      _hover={{ shadow: 'sm', borderColor: `${k.palette}.muted` }}
      borderLeftWidth="3px"
      borderLeftColor={`${k.palette}.solid`}
      opacity={n.status === 'done' ? 0.7 : 1}
    >
      <Flex justify="space-between" gap="2" align="flex-start">
        <HStack gap="1.5" wrap="wrap">
          <CBadge size="xs" variant="subtle" colorPalette={k.palette} gap="1">
            {k.icon} {k.label}
          </CBadge>
          {part && (
            <CBadge size="xs" variant="outline">
              {part}
            </CBadge>
          )}
        </HStack>
        <HStack gap="0">
          <IconButton size="2xs" variant="ghost" aria-label="Edit" onClick={onEdit}>
            <LuPencil />
          </IconButton>
          <IconButton size="2xs" variant="ghost" colorPalette="red" aria-label="Delete" onClick={onDelete}>
            <LuTrash2 />
          </IconButton>
        </HStack>
      </Flex>
      <Text fontWeight="medium" fontSize="sm" mt="1.5" textDecoration={n.status === 'done' ? 'line-through' : undefined} cursor="pointer" onClick={onEdit}>
        {n.title}
      </Text>
      {n.body && (
        <Text fontSize="xs" color="fg.muted" mt="1" lineClamp={3} whiteSpace="pre-wrap">
          {n.body}
        </Text>
      )}
      <Flex justify="space-between" align="center" mt="2" gap="2">
        <HStack gap="2" fontSize="2xs" color="fg.muted">
          <HStack gap="0.5" color={PRIORITY_COLOR[n.priority]} title={`${n.priority} priority`}>
            <LuFlag /> {n.priority}
          </HStack>
          {n.due_date && (
            <HStack gap="0.5" color={overdue ? 'fg.error' : undefined}>
              <LuCalendar /> {n.due_date}
            </HStack>
          )}
        </HStack>
        {n.kind !== 'note' && (
          <HStack gap="0.5">
            {COLUMNS.filter((c) => c.id !== n.status).map((c) => (
              <Button key={c.id} size="2xs" variant="ghost" onClick={() => onMove(c.id)} title={`Move to ${c.label}`}>
                {c.label}
              </Button>
            ))}
          </HStack>
        )}
      </Flex>
    </Box>
  );
}

function EditDialog({ note, parts, onClose, onSaved }: { note: Partial<Note> | null; parts: ProjectComponent[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<Partial<Note>>({});
  const v = { ...note, ...f };
  const save = async () => {
    try {
      await api(`/notes/${note!.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: v.title, body: v.body ?? null, kind: v.kind, status: v.status, priority: v.priority, component_id: v.component_id || null, due_date: v.due_date || null }),
      });
      setF({});
      onSaved();
      onClose();
    } catch (e: any) {
      notify('error', e.message);
    }
  };
  return (
    <Dialog.Root open={!!note} onOpenChange={(e) => !e.open && (setF({}), onClose())} placement="center" size="lg">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title fontFamily="heading">Edit {v.kind ? KIND[v.kind as NoteKind].label.toLowerCase() : ''}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Stack gap="3">
                <Field.Root required>
                  <Field.Label>Title</Field.Label>
                  <Input value={v.title ?? ''} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={200} />
                </Field.Root>
                <Field.Root>
                  <Field.Label>Details</Field.Label>
                  <Textarea rows={8} value={v.body ?? ''} onChange={(e) => setF({ ...f, body: e.target.value })} placeholder="Acceptance criteria, steps, links, decisions…" fontFamily="mono" fontSize="sm" />
                </Field.Root>
                <SimpleGrid columns={{ base: 2, md: 5 }} gap="2">
                  <Field.Root>
                    <Field.Label>Kind</Field.Label>
                    <Select label="Kind" value={String(v.kind)} onChange={(x) => setF({ ...f, kind: x as NoteKind })}>
                      {KINDS.map((k) => (
                        <option key={k.id} value={k.id}>
                          {k.label}
                        </option>
                      ))}
                    </Select>
                  </Field.Root>
                  <Field.Root>
                    <Field.Label>Status</Field.Label>
                    <Select label="Status" value={String(v.status)} onChange={(x) => setF({ ...f, status: x as NoteStatus })}>
                      {COLUMNS.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label}
                        </option>
                      ))}
                    </Select>
                  </Field.Root>
                  <Field.Root>
                    <Field.Label>Priority</Field.Label>
                    <Select label="Priority" value={String(v.priority)} onChange={(x) => setF({ ...f, priority: x as Priority })}>
                      <option value="high">High</option>
                      <option value="medium">Medium</option>
                      <option value="low">Low</option>
                    </Select>
                  </Field.Root>
                  <Field.Root>
                    <Field.Label>Part</Field.Label>
                    <Select label="Part" value={v.component_id ?? ''} onChange={(x) => setF({ ...f, component_id: x || null })}>
                      <option value="">Whole project</option>
                      {parts.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </Select>
                  </Field.Root>
                  <Field.Root>
                    <Field.Label>Due</Field.Label>
                    <Input size="sm" type="date" value={v.due_date ?? ''} onChange={(e) => setF({ ...f, due_date: e.target.value || null })} />
                  </Field.Root>
                </SimpleGrid>
                {note?.created_at && (
                  <Text fontSize="xs" color="fg.muted">
                    Created {ago(note.created_at)} · updated {ago(note.updated_at)}
                  </Text>
                )}
              </Stack>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="ghost" onClick={() => (setF({}), onClose())}>
                Cancel
              </Button>
              <Button onClick={() => void save()} disabled={!v.title?.trim()}>
                Save
              </Button>
            </Dialog.Footer>
            <Dialog.CloseTrigger asChild>
              <CloseButton size="sm" />
            </Dialog.CloseTrigger>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

/** Your own maintenance space: requirements, tasks, bugs and ideas on a board, plus free notes. */
export function MaintenanceTab({ projectId, parts }: { projectId: string; parts: ProjectComponent[] }) {
  const qc = useQueryClient();
  const q = useNotes(projectId);
  const [draft, setDraft] = useState({ kind: 'task' as NoteKind, title: '', priority: 'medium' as Priority, component_id: '' });
  const [filter, setFilter] = useState<NoteKind | 'all'>('all');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Note | null>(null);
  const [over, setOver] = useState<NoteStatus | null>(null);
  const reload = () => qc.invalidateQueries({ queryKey: pk.notes(projectId) });
  const partName = (id: string | null) => parts.find((p) => p.id === id)?.name;

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api(`/projects/${projectId}/notes`, { method: 'POST', body: JSON.stringify({ ...draft, component_id: draft.component_id || null }) });
      setDraft({ ...draft, title: '' });
      await reload();
    } catch (err: any) {
      notify('error', err.message);
    }
  };
  const move = async (id: string, status: NoteStatus) => {
    // Show the move at once; the server confirms.
    qc.setQueryData<Note[]>(pk.notes(projectId), (list = []) => list.map((n) => (n.id === id ? { ...n, status } : n)));
    try {
      await api(`/notes/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    } catch (err: any) {
      notify('error', err.message);
    }
    void reload();
  };
  const remove = async (n: Note) => {
    if (!confirm(`Delete "${n.title}"?`)) return;
    try {
      await api(`/notes/${n.id}`, { method: 'DELETE' });
      await reload();
    } catch (err: any) {
      notify('error', err.message);
    }
  };

  const notes = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data ?? []).filter((n) => (filter === 'all' || n.kind === filter) && (!s || `${n.title} ${n.body ?? ''}`.toLowerCase().includes(s)));
  }, [q.data, filter, search]);
  const boardItems = notes.filter((n) => n.kind !== 'note');
  const freeNotes = notes.filter((n) => n.kind === 'note');
  const counts = Object.fromEntries(KINDS.map((k) => [k.id, (q.data ?? []).filter((n) => n.kind === k.id && n.status !== 'done').length]));

  return (
    <Stack gap="4">
      <Card icon={<LuPlus />} title="Add to the project" subtitle="Requirements, tasks, bugs, ideas and notes — your own plan for this project">
        <Flex as="form" onSubmit={add} gap="2" wrap="wrap" align="flex-end">
          <Box w={{ base: '100%', sm: '150px' }}>
            <Select label="Kind" value={draft.kind} onChange={(v) => setDraft({ ...draft, kind: v as NoteKind })}>
              {KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </Select>
          </Box>
          <Input size="sm" flex="1" minW="220px" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="e.g. Login with Google must work offline" maxLength={200} aria-label="Title" />
          <Box w="120px">
            <Select label="Priority" value={draft.priority} onChange={(v) => setDraft({ ...draft, priority: v as Priority })}>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </Select>
          </Box>
          {parts.length > 0 && (
            <Box w="170px">
              <Select label="Part" value={draft.component_id} onChange={(v) => setDraft({ ...draft, component_id: v })}>
                <option value="">Whole project</option>
                {parts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Box>
          )}
          <Button size="sm" type="submit" disabled={!draft.title.trim()}>
            <LuPlus /> Add
          </Button>
        </Flex>
      </Card>

      <Flex gap="2" wrap="wrap" align="center">
        {[{ id: 'all', label: 'All', palette: 'gray', icon: null as React.ReactNode }, ...KINDS].map((k) => (
          <chakra.button
            key={k.id}
            onClick={() => setFilter(k.id as NoteKind | 'all')}
            px="3"
            py="1"
            borderRadius="full"
            borderWidth="1px"
            fontSize="sm"
            display="inline-flex"
            alignItems="center"
            gap="1.5"
            colorPalette={k.palette}
            bg={filter === k.id ? 'colorPalette.subtle' : 'bg.panel'}
            borderColor={filter === k.id ? 'colorPalette.muted' : 'border'}
            color={filter === k.id ? 'colorPalette.fg' : 'fg.muted'}
          >
            {k.icon} {k.label}
            {k.id !== 'all' && counts[k.id] ? <Text as="span" fontSize="xs">· {counts[k.id]}</Text> : null}
          </chakra.button>
        ))}
        <Input size="sm" maxW="260px" ml={{ md: 'auto' }} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…" aria-label="Search notes" />
      </Flex>

      {!q.data ? (
        <Loading rows={3} height="20" />
      ) : q.data.length === 0 ? (
        <Empty icon={<LuNotebookPen />} title="Nothing here yet">
          Write down what the app must do (requirements), what you are working on (tasks), bugs you found and ideas for later. Drag cards between columns as you go.
        </Empty>
      ) : (
        <>
          {filter !== 'note' && (
            <SimpleGrid columns={{ base: 1, lg: 3 }} gap="3" alignItems="start">
              {COLUMNS.map((col) => {
                const items = boardItems.filter((n) => n.status === col.id);
                return (
                  <Stack
                    key={col.id}
                    gap="2"
                    p="2.5"
                    borderRadius="xl"
                    bg={over === col.id ? 'colorPalette.subtle' : 'bg.muted'}
                    borderWidth="1px"
                    borderStyle={over === col.id ? 'dashed' : 'solid'}
                    borderColor={over === col.id ? 'colorPalette.solid' : 'transparent'}
                    minH="160px"
                    onDragOver={(e) => (e.preventDefault(), setOver(col.id))}
                    onDragLeave={() => setOver(null)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setOver(null);
                      const id = e.dataTransfer.getData('text/note-id');
                      if (id) void move(id, col.id);
                    }}
                  >
                    <Flex justify="space-between" px="1">
                      <Text fontWeight="semibold" fontSize="sm">
                        {col.label}
                      </Text>
                      <Text fontSize="xs" color="fg.muted" className="num">
                        {items.length}
                      </Text>
                    </Flex>
                    {items.map((n) => (
                      <NoteCard key={n.id} n={n} part={partName(n.component_id)} onEdit={() => setEditing(n)} onMove={(s) => void move(n.id, s)} onDelete={() => void remove(n)} />
                    ))}
                    {!items.length && (
                      <Text fontSize="xs" color="fg.subtle" textAlign="center" py="6">
                        Drop cards here
                      </Text>
                    )}
                  </Stack>
                );
              })}
            </SimpleGrid>
          )}
          {freeNotes.length > 0 && (
            <Stack gap="2">
              <Text fontWeight="semibold" fontSize="sm">
                Notes
              </Text>
              <SimpleGrid columns={{ base: 1, md: 2, xl: 3 }} gap="3">
                {freeNotes.map((n) => (
                  <NoteCard key={n.id} n={n} part={partName(n.component_id)} onEdit={() => setEditing(n)} onMove={() => {}} onDelete={() => void remove(n)} />
                ))}
              </SimpleGrid>
            </Stack>
          )}
        </>
      )}
      <EditDialog note={editing} parts={parts} onClose={() => setEditing(null)} onSaved={() => void reload()} />
    </Stack>
  );
}
