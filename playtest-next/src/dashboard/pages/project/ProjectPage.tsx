'use client';
import { useEffect, useState } from 'react';
import NextLink from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Box, Button, CloseButton, Dialog, Field, Flex, HStack, IconButton, Input, Portal, SimpleGrid, Stack, Text, Textarea, chakra } from '@chakra-ui/react';
import { LuArrowLeft, LuExternalLink, LuFolderKanban, LuLayoutDashboard, LuPencil, LuTrash2 } from 'react-icons/lu';
import { api } from '../../lib/api';
import { ago, KIND_LABEL, pk, useNotes, useProject, trackLabel, type ProjectComponent } from '../../lib/projects';
import { Badge, Card, Empty, Loading, Notice } from '../../components/ui';
import { notify } from '../../components/toaster';
import { PROJECT_COLORS, STAGES } from '../ProjectsPage';
import { AddPartForm, frameworkLabel } from './AddPart';
import { DevelopmentTab } from './DevelopmentTab';
import { DeploymentTab } from './DeploymentTab';
import { MaintenanceTab } from './MaintenanceTab';
import { RELEASE_TONE } from './ReleaseView';

type Tab = 'overview' | 'development' | 'deployment' | 'maintenance';
const tabKey = (id: string) => `pt-project-tab:${id}`;

function EditProject({ open, project, onClose, onSaved }: { open: boolean; project: { id: string; name: string; description: string | null; color: string | null }; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: project.name, description: project.description ?? '', color: project.color ?? 'blue' });
  useEffect(() => setF({ name: project.name, description: project.description ?? '', color: project.color ?? 'blue' }), [project, open]);
  const save = async () => {
    try {
      await api(`/projects/${project.id}`, { method: 'PATCH', body: JSON.stringify(f) });
      onSaved();
      onClose();
    } catch (e: any) {
      notify('error', e.message);
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={(e) => !e.open && onClose()} placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title fontFamily="heading">Edit project</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Stack gap="3">
                <Field.Root required>
                  <Field.Label>Name</Field.Label>
                  <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} />
                </Field.Root>
                <Field.Root>
                  <Field.Label>Description</Field.Label>
                  <Textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={500} />
                </Field.Root>
                <HStack gap="2">
                  {PROJECT_COLORS.map((c) => (
                    <chakra.button key={c} type="button" aria-label={c} w="6" h="6" borderRadius="full" bg={`${c}.solid`} outline={f.color === c ? '3px solid' : 'none'} outlineColor={`${c}.muted`} outlineOffset="2px" onClick={() => setF({ ...f, color: c })} />
                  ))}
                </HStack>
              </Stack>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={() => void save()} disabled={!f.name.trim()}>
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

function PartRow({ c, onRemove }: { c: ProjectComponent; onRemove: () => void }) {
  const r = c.last_release;
  return (
    <Flex gap="3" align="center" borderWidth="1px" borderRadius="lg" p="3" wrap="wrap" bg="bg.panel">
      <Box flex="1" minW="220px">
        <HStack gap="2" wrap="wrap">
          <Text fontWeight="semibold">{c.name}</Text>
          <Badge tone="neutral">{KIND_LABEL[c.kind]}</Badge>
          <Badge tone="good">{frameworkLabel(c.framework)}</Badge>
          {c.version && (
            <Text fontSize="sm" color="fg.muted" className="num">
              v{c.version}
            </Text>
          )}
        </HStack>
        <Text fontSize="xs" color="fg.muted" fontFamily="mono" truncate title={c.path}>
          {c.path}
        </Text>
      </Box>
      <HStack gap="3" fontSize="xs" color="fg.muted" wrap="wrap">
        {c.git.repo ? <Text>{c.git.branch} · {c.git.changed.length ? `${c.git.changed.length} changed` : 'clean'}</Text> : <Text>no git</Text>}
        {c.kind === 'mobile' && (r ? <Badge tone={RELEASE_TONE[r.status]}>{`${r.version_after ?? r.version_before} ${r.mode === 'publish' ? trackLabel(r.track) : r.mode === 'dry_run' ? 'dry run' : 'build'}`}</Badge> : <Text>no release</Text>)}
        {c.git.web_url && (
          <chakra.a href={c.git.web_url} target="_blank" rel="noreferrer" display="inline-flex" alignItems="center" gap="1" color="colorPalette.fg">
            <LuExternalLink /> repo
          </chakra.a>
        )}
      </HStack>
      <IconButton size="xs" variant="ghost" colorPalette="red" aria-label={`Remove ${c.name}`} title="Remove from the project (files stay)" onClick={onRemove}>
        <LuTrash2 />
      </IconButton>
    </Flex>
  );
}

/** One project: Overview, then the Development → Deployment → Maintenance workflow. */
export function ProjectPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
  const router = useRouter();
  const qc = useQueryClient();
  const q = useProject(id);
  const notes = useNotes(id);
  const [tab, setTab] = useState<Tab>(() => {
    try {
      return (localStorage.getItem(tabKey(id)) as Tab) || 'overview';
    } catch {
      return 'overview';
    }
  });
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem(tabKey(id), tab);
    } catch {
      /* not remembered */
    }
  }, [id, tab]);
  // Arriving from "New project": open the add-a-folder form.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('add') === '1') {
      setTab('overview');
      setAdding(true);
      router.replace(`/projects/${id}`);
    }
  }, [id, router]);

  const reload = () => qc.invalidateQueries({ queryKey: pk.detail(id) });

  if (q.isError) return <Notice tone="error" title="Project not found">{q.error.message}</Notice>;
  if (!q.data) return <Loading rows={4} height="16" label="Loading project" />;
  const p = q.data;
  const color = p.color ?? 'blue';
  const parts = p.components;
  const apps = parts.filter((c) => c.kind === 'mobile');
  const changes = parts.reduce((s, c) => s + c.git.changed.length, 0);
  const last = apps.map((c) => c.last_release).filter(Boolean).sort((a, b) => b!.started_at.localeCompare(a!.started_at))[0] ?? null;
  const open = (notes.data ?? []).filter((n) => n.status !== 'done' && n.kind !== 'note').length;

  const stageInfo: Record<string, string> = {
    development: parts.length ? `${parts.length} part${parts.length === 1 ? '' : 's'} · ${changes ? `${changes} uncommitted` : 'all committed'}` : 'Add your folders',
    deployment: last ? `${last.version_after ?? last.version_before} · ${last.status} · ${ago(last.started_at)}` : apps.length ? 'No release yet' : 'No mobile app',
    maintenance: `${open} open item${open === 1 ? '' : 's'}`,
  };

  const removeProject = async () => {
    if (!confirm(`Remove "${p.name}" from PlayTest? Its release history and notes are deleted — your project folders are not touched.`)) return;
    try {
      await api(`/projects/${p.id}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: pk.list });
      router.push('/projects');
    } catch (e: any) {
      notify('error', e.message);
    }
  };
  const removePart = async (c: ProjectComponent) => {
    if (!confirm(`Remove "${c.name}" from this project? The folder ${c.path} is not touched.`)) return;
    try {
      await api(`/components/${c.id}`, { method: 'DELETE' });
      await reload();
    } catch (e: any) {
      notify('error', e.message);
    }
  };

  return (
    <Stack gap="5" colorPalette={color}>
      <Box>
        <Button asChild size="xs" variant="ghost" mb="2">
          <NextLink href="/projects">
            <LuArrowLeft /> All projects
          </NextLink>
        </Button>
        <Flex gap="4" align="center" wrap="wrap">
          <Flex w="14" h="14" align="center" justify="center" borderRadius="xl" bg="colorPalette.solid" color="colorPalette.contrast" fontFamily="heading" fontWeight="bold" fontSize="2xl" flexShrink={0}>
            {p.name.slice(0, 1).toUpperCase()}
          </Flex>
          <Box flex="1" minW="200px">
            <Text fontFamily="heading" fontSize="2xl" fontWeight="bold" lineHeight="1.2">
              {p.name}
            </Text>
            <Text color="fg.muted" fontSize="sm">
              {p.description || 'No description'}
            </Text>
          </Box>
          <HStack gap="1">
            <IconButton size="sm" variant="ghost" aria-label="Edit project" onClick={() => setEditing(true)}>
              <LuPencil />
            </IconButton>
            <IconButton size="sm" variant="ghost" colorPalette="red" aria-label="Remove project" onClick={() => void removeProject()}>
              <LuTrash2 />
            </IconButton>
          </HStack>
        </Flex>
      </Box>

      {/* Overview + the three workflow stages as big tabs */}
      <SimpleGrid columns={{ base: 2, md: 4 }} gap="2" role="tablist" aria-label="Project sections">
        {[{ id: 'overview', label: 'Overview', icon: <LuLayoutDashboard />, palette: 'gray', text: `${parts.length} part${parts.length === 1 ? '' : 's'}` }, ...STAGES.map((s) => ({ ...s, text: stageInfo[s.id] }))].map((s) => {
          const active = tab === s.id;
          return (
            <chakra.button
              key={s.id}
              role="tab"
              aria-selected={active}
              onClick={() => setTab(s.id as Tab)}
              colorPalette={s.palette}
              textAlign="left"
              borderWidth="1px"
              borderRadius="xl"
              px="3.5"
              py="3"
              bg={active ? 'colorPalette.subtle' : 'bg.panel'}
              borderColor={active ? 'colorPalette.muted' : 'border'}
              shadow={active ? 'sm' : 'xs'}
              transition="all 0.15s"
              _hover={{ borderColor: 'colorPalette.muted' }}
            >
              <HStack gap="2" color={active ? 'colorPalette.fg' : 'fg'}>
                <Box fontSize="lg">{s.icon}</Box>
                <Text fontWeight="semibold" fontFamily="heading">
                  {s.label}
                </Text>
              </HStack>
              <Text fontSize="xs" color="fg.muted" mt="1" truncate>
                {s.text}
              </Text>
            </chakra.button>
          );
        })}
      </SimpleGrid>

      {tab === 'overview' && (
        <Stack gap="4">
          <Card
            icon={<LuFolderKanban />}
            title="Parts of this project"
            subtitle="Mobile app, web panel, backend … each is a folder on this PC (with its git repository)"
            actions={
              <Button size="xs" variant={adding ? 'ghost' : 'solid'} onClick={() => setAdding((a) => !a)}>
                {adding ? 'Close' : '+ Add part'}
              </Button>
            }
          >
            <Stack gap="3">
              {adding && (
                <Box borderWidth="1px" borderRadius="lg" p="4" bg="bg.subtle">
                  <AddPartForm projectId={p.id} onAdded={() => (setAdding(false), void reload())} />
                </Box>
              )}
              {parts.length === 0 && !adding ? (
                <Empty icon={<LuFolderKanban />} title="No parts yet">
                  Add your Flutter app folder first — then its web panel or backend if it has them.
                </Empty>
              ) : (
                parts.map((c) => <PartRow key={c.id} c={c} onRemove={() => void removePart(c)} />)
              )}
            </Stack>
          </Card>
          <SimpleGrid columns={{ base: 1, md: 3 }} gap="3">
            {STAGES.map((s) => (
              <chakra.button key={s.id} onClick={() => setTab(s.id as Tab)} textAlign="left" colorPalette={s.palette} borderWidth="1px" borderRadius="xl" p="4" bg="bg.panel" _hover={{ borderColor: 'colorPalette.muted', shadow: 'sm' }}>
                <HStack gap="2" color="colorPalette.fg">
                  {s.icon}
                  <Text fontWeight="semibold">{s.label}</Text>
                </HStack>
                <Text fontSize="sm" mt="1.5">
                  {stageInfo[s.id]}
                </Text>
                <Text fontSize="xs" color="fg.muted" mt="1">
                  {s.text}
                </Text>
              </chakra.button>
            ))}
          </SimpleGrid>
        </Stack>
      )}
      {tab === 'development' && <DevelopmentTab projectId={p.id} components={parts} />}
      {tab === 'deployment' && <DeploymentTab components={parts} onChanged={() => void reload()} />}
      {tab === 'maintenance' && <MaintenanceTab projectId={p.id} parts={parts} />}

      <EditProject open={editing} project={p} onClose={() => setEditing(false)} onSaved={() => void Promise.all([reload(), qc.invalidateQueries({ queryKey: pk.list })])} />
    </Stack>
  );
}
