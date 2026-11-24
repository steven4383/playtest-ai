'use client';
import { useMemo, useState } from 'react';
import NextLink from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { Badge as CBadge, Box, Button, Flex, HStack, NativeSelect, SimpleGrid, Stack, Text, chakra } from '@chakra-ui/react';
import { LuBug, LuCalendar, LuFlag, LuLightbulb, LuListChecks, LuListTodo, LuNotebookPen } from 'react-icons/lu';
import { api } from '../lib/api';
import { nk, useProjectItems, type ProjectItem } from '../lib/notebook';
import { pk, type NoteKind, type NoteStatus } from '../lib/projects';
import { Empty, Loading } from '../components/ui';
import { notify } from '../components/toaster';

const KIND: Record<Exclude<NoteKind, 'note'>, { label: string; icon: React.ReactNode; palette: string }> = {
  requirement: { label: 'Requirement', icon: <LuNotebookPen />, palette: 'purple' },
  task: { label: 'Task', icon: <LuListTodo />, palette: 'blue' },
  bug: { label: 'Bug', icon: <LuBug />, palette: 'red' },
  idea: { label: 'Idea', icon: <LuLightbulb />, palette: 'yellow' },
};
const COLUMNS: { id: NoteStatus; label: string }[] = [
  { id: 'todo', label: 'To do' },
  { id: 'doing', label: 'Doing' },
  { id: 'done', label: 'Done' },
];
const PRIORITY: Record<string, string> = { high: 'red.fg', medium: 'orange.fg', low: 'fg.subtle' };

/** Opens the project straight on its Maintenance tab. */
const openOnMaintenance = (projectId: string) => {
  try {
    localStorage.setItem(`pt-project-tab:${projectId}`, 'maintenance');
  } catch {
    /* opens on the last tab instead */
  }
};

/** Every project's requirements, tasks, bugs and ideas in one board. */
export function TasksPage() {
  const qc = useQueryClient();
  const q = useProjectItems();
  const [project, setProject] = useState('');
  const [kind, setKind] = useState<NoteKind | ''>('');
  const [showDone, setShowDone] = useState(false);
  const items = q.data ?? null;
  const projects = useMemo(() => [...new Map((items ?? []).map((i) => [i.project_id, i.project_name])).entries()], [items]);
  const shown = (items ?? []).filter((i) => (!project || i.project_id === project) && (!kind || i.kind === kind));
  const today = new Date().toISOString().slice(0, 10);

  const move = async (it: ProjectItem, status: NoteStatus) => {
    qc.setQueryData<ProjectItem[]>(nk.items, (list = []) => list.map((x) => (x.id === it.id ? { ...x, status } : x)));
    try {
      await api(`/notes/${it.id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      void qc.invalidateQueries({ queryKey: pk.notes(it.project_id) });
    } catch (e: any) {
      notify('error', e.message);
    }
    void qc.invalidateQueries({ queryKey: nk.items });
  };

  const sel = (value: string, onChange: (v: string) => void, children: React.ReactNode, label: string) => (
    <NativeSelect.Root size="sm" w="auto" minW="160px">
      <NativeSelect.Field value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        {children}
      </NativeSelect.Field>
      <NativeSelect.Indicator />
    </NativeSelect.Root>
  );

  return (
    <Stack gap="4">
      <Flex gap="2" wrap="wrap" align="center">
        {sel(
          project,
          setProject,
          <>
            <option value="">All projects</option>
            {projects.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </>,
          'Project',
        )}
        {sel(
          kind,
          (v) => setKind(v as NoteKind | ''),
          <>
            <option value="">Everything</option>
            {Object.entries(KIND).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}s
              </option>
            ))}
          </>,
          'Kind',
        )}
        <Button size="sm" variant={showDone ? 'subtle' : 'ghost'} onClick={() => setShowDone((s) => !s)}>
          {showDone ? 'Hide done' : 'Show done'}
        </Button>
        <Text fontSize="sm" color="fg.muted" ms="auto">
          Add items inside a project (Projects → a project → Maintenance).
        </Text>
      </Flex>
      {items === null ? (
        <Loading rows={3} height="24" />
      ) : items.length === 0 ? (
        <Empty icon={<LuListChecks />} title="No requirements or tasks yet">
          Open a project and add them on its Maintenance tab — they all show up here.
        </Empty>
      ) : (
        <SimpleGrid columns={{ base: 1, lg: showDone ? 3 : 2 }} gap="3" alignItems="start">
          {COLUMNS.filter((c) => showDone || c.id !== 'done').map((col) => {
            const list = shown.filter((i) => i.status === col.id);
            return (
              <Stack key={col.id} gap="2" p="2.5" borderRadius="xl" bg="bg.muted" minH="140px">
                <Flex justify="space-between" px="1">
                  <Text fontWeight="semibold" fontSize="sm">
                    {col.label}
                  </Text>
                  <Text fontSize="xs" color="fg.muted">
                    {list.length}
                  </Text>
                </Flex>
                {list.map((it) => {
                  const k = KIND[it.kind as Exclude<NoteKind, 'note'>];
                  return (
                    <Box key={it.id} borderWidth="1px" borderRadius="lg" bg="bg.panel" p="3" borderLeftWidth="3px" borderLeftColor={`${k?.palette ?? 'gray'}.solid`}>
                      <HStack gap="1.5" wrap="wrap">
                        <CBadge size="xs" variant="subtle" colorPalette={k?.palette} gap="1">
                          {k?.icon} {k?.label}
                        </CBadge>
                        <CBadge size="xs" variant="outline" colorPalette={it.project_color ?? 'gray'}>
                          {it.project_name}
                          {it.component_name ? ` · ${it.component_name}` : ''}
                        </CBadge>
                      </HStack>
                      <chakra.a asChild display="block" mt="1.5" fontWeight="medium" fontSize="sm" _hover={{ textDecoration: 'underline' }}>
                        <NextLink href={`/projects/${it.project_id}`} onClick={() => openOnMaintenance(it.project_id)}>
                          {it.title}
                        </NextLink>
                      </chakra.a>
                      <Flex justify="space-between" align="center" mt="2" gap="2">
                        <HStack gap="2" fontSize="2xs" color="fg.muted">
                          <HStack gap="0.5" color={PRIORITY[it.priority]}>
                            <LuFlag /> {it.priority}
                          </HStack>
                          {it.due_date && (
                            <HStack gap="0.5" color={it.due_date < today && it.status !== 'done' ? 'fg.error' : undefined}>
                              <LuCalendar /> {it.due_date}
                            </HStack>
                          )}
                        </HStack>
                        <HStack gap="0.5">
                          {COLUMNS.filter((c) => c.id !== it.status).map((c) => (
                            <Button key={c.id} size="2xs" variant="ghost" onClick={() => void move(it, c.id)}>
                              {c.label}
                            </Button>
                          ))}
                        </HStack>
                      </Flex>
                    </Box>
                  );
                })}
                {!list.length && (
                  <Text fontSize="xs" color="fg.subtle" textAlign="center" py="6">
                    Nothing here
                  </Text>
                )}
              </Stack>
            );
          })}
        </SimpleGrid>
      )}
    </Stack>
  );
}
