'use client';
import { useState } from 'react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Box, Button, CloseButton, Dialog, Field, Flex, HStack, Input, Portal, SimpleGrid, Stack, Text, Textarea, chakra } from '@chakra-ui/react';
import { LuArrowRight, LuFolderKanban, LuHammer, LuListTodo, LuPlus, LuRocket, LuWrench } from 'react-icons/lu';
import { api } from '../lib/api';
import { ago, pk, useProjects, type ProjectSummary } from '../lib/projects';
import { Empty, Loading } from '../components/ui';
import { notify } from '../components/toaster';

export const PROJECT_COLORS = ['blue', 'purple', 'teal', 'green', 'orange', 'pink', 'cyan', 'red'] as const;

/** The three stages every project goes through — shown on the Projects home and inside each project. */
export const STAGES = [
  { id: 'development', label: 'Development', icon: <LuHammer />, palette: 'blue', text: 'Code, git, run on devices, test runs' },
  { id: 'deployment', label: 'Deployment', icon: <LuRocket />, palette: 'purple', text: 'Version bump, build, Google Play' },
  { id: 'maintenance', label: 'Maintenance', icon: <LuWrench />, palette: 'green', text: 'Requirements, tasks, bugs, notes' },
] as const;

function WorkflowStrip() {
  return (
    <Flex gap="2" align="stretch" wrap={{ base: 'wrap', md: 'nowrap' }}>
      {STAGES.map((s, i) => (
        <Flex key={s.id} align="center" gap="2" flex="1" minW={{ base: '100%', md: '0' }}>
          <HStack gap="3" flex="1" borderWidth="1px" borderRadius="xl" px="4" py="3" bg="bg.panel" colorPalette={s.palette} minW="0">
            <Flex w="9" h="9" flexShrink={0} align="center" justify="center" borderRadius="lg" bg="colorPalette.subtle" color="colorPalette.fg" fontSize="lg">
              {s.icon}
            </Flex>
            <Box minW="0">
              <Text fontWeight="semibold" fontFamily="heading">
                {s.label}
              </Text>
              <Text fontSize="xs" color="fg.muted" truncate>
                {s.text}
              </Text>
            </Box>
          </HStack>
          {i < STAGES.length - 1 && (
            <Box color="fg.subtle" display={{ base: 'none', md: 'block' }}>
              <LuArrowRight />
            </Box>
          )}
        </Flex>
      ))}
    </Flex>
  );
}

function ProjectCard({ p }: { p: ProjectSummary }) {
  const color = p.color ?? 'blue';
  return (
    <chakra.a
      asChild
      display="block"
      borderWidth="1px"
      borderRadius="xl"
      bg="bg.panel"
      overflow="hidden"
      shadow="xs"
      transition="all 0.15s"
      _hover={{ shadow: 'md', transform: 'translateY(-2px)', borderColor: `${color}.muted` }}
      _focusVisible={{ outline: '2px solid', outlineColor: 'colorPalette.focusRing' }}
    >
      <NextLink href={`/projects/${p.id}`}>
        <Box h="1.5" bg={`${color}.solid`} />
        <Stack gap="3" p="4">
          <HStack gap="3">
            <Flex w="10" h="10" align="center" justify="center" borderRadius="lg" bg={`${color}.subtle`} color={`${color}.fg`} fontWeight="bold" fontFamily="heading" fontSize="lg">
              {p.name.slice(0, 1).toUpperCase()}
            </Flex>
            <Box minW="0">
              <Text fontWeight="semibold" fontFamily="heading" fontSize="lg" truncate>
                {p.name}
              </Text>
              <Text fontSize="xs" color="fg.muted">
                Updated {ago(p.updated_at ?? p.created_at)}
              </Text>
            </Box>
          </HStack>
          <Text fontSize="sm" color="fg.muted" lineClamp={2} minH="10">
            {p.description || 'No description yet.'}
          </Text>
          <HStack gap="4" fontSize="xs" color="fg.muted" wrap="wrap">
            <HStack gap="1">
              <LuFolderKanban /> {p.components} part{p.components === 1 ? '' : 's'}
            </HStack>
            <HStack gap="1">
              <LuListTodo /> {p.open_notes} open
            </HStack>
            <HStack gap="1">
              <LuRocket /> {p.last_release ? `released ${ago(p.last_release)}` : 'no release yet'}
            </HStack>
          </HStack>
        </Stack>
      </NextLink>
    </chakra.a>
  );
}

function NewProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const router = useRouter();
  const [form, setForm] = useState({ name: '', description: '', color: 'blue' });
  const [busy, setBusy] = useState(false);
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const p = await api<{ id: string }>('/projects', { method: 'POST', body: JSON.stringify(form) });
      await qc.invalidateQueries({ queryKey: pk.list });
      notify('ok', `${form.name} created — add its folders next`);
      onClose();
      router.push(`/projects/${p.id}?add=1`);
    } catch (err: any) {
      notify('error', err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={(e) => !e.open && onClose()} placement="center" size="md">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content as="form" onSubmit={create}>
            <Dialog.Header>
              <Dialog.Title fontFamily="heading">New project</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Stack gap="4">
                <Field.Root required>
                  <Field.Label>Name</Field.Label>
                  <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="VM Service" maxLength={80} autoFocus />
                </Field.Root>
                <Field.Root>
                  <Field.Label>What is it?</Field.Label>
                  <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Flutter app + admin web panel for …" maxLength={500} rows={3} />
                </Field.Root>
                <Field.Root>
                  <Field.Label>Color</Field.Label>
                  <HStack gap="2">
                    {PROJECT_COLORS.map((c) => (
                      <chakra.button
                        type="button"
                        key={c}
                        aria-label={c}
                        aria-pressed={form.color === c}
                        w="7"
                        h="7"
                        borderRadius="full"
                        bg={`${c}.solid`}
                        outline={form.color === c ? '3px solid' : 'none'}
                        outlineColor={`${c}.muted`}
                        outlineOffset="2px"
                        onClick={() => setForm({ ...form, color: c })}
                      />
                    ))}
                  </HStack>
                </Field.Root>
              </Stack>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" loading={busy} disabled={!form.name.trim()}>
                Create project
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

/** Home of everything you build: one card per project, and the Development → Deployment → Maintenance flow. */
export function ProjectsPage() {
  const q = useProjects();
  const [creating, setCreating] = useState(false);
  return (
    <Stack gap="5">
      <Flex justify="space-between" align="flex-end" gap="3" wrap="wrap">
        <Box>
          <Text fontFamily="heading" fontSize="2xl" fontWeight="bold">
            Your projects
          </Text>
          <Text color="fg.muted" fontSize="sm">
            Each project groups its mobile app, web panel and backend — from first commit to Google Play and beyond.
          </Text>
        </Box>
        <Button onClick={() => setCreating(true)}>
          <LuPlus /> New project
        </Button>
      </Flex>
      <WorkflowStrip />
      {!q.data ? (
        <Loading rows={2} height="40" label="Loading projects" />
      ) : q.data.length === 0 ? (
        <Empty
          icon={<LuFolderKanban />}
          title="No projects yet"
          action={
            <Button size="sm" onClick={() => setCreating(true)}>
              <LuPlus /> Create your first project
            </Button>
          }
        >
          Add your Flutter app (and its web panel or backend), connect Google Play, and keep requirements and tasks next to the code.
        </Empty>
      ) : (
        <SimpleGrid columns={{ base: 1, md: 2, xl: 3 }} gap="4">
          {q.data.map((p) => (
            <ProjectCard key={p.id} p={p} />
          ))}
        </SimpleGrid>
      )}
      <NewProjectDialog open={creating} onClose={() => setCreating(false)} />
    </Stack>
  );
}
