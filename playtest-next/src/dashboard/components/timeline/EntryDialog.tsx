'use client';
import { useEffect, useState } from 'react';
import { Button, CloseButton, Dialog, Field, Input, NativeSelect, Portal, SimpleGrid, Stack, Textarea } from '@chakra-ui/react';
import { LuTrash2 } from 'react-icons/lu';
import { api } from '../../lib/api';
import { useProjects } from '../../lib/projects';
import { CATEGORY, STATUS_LABEL, type Category, type EntryStatus, type TimelineEntry, type UpdateResult } from '../../lib/timeline';
import { notify } from '../toaster';

type Draft = { title: string; category: Category; status: EntryStatus; date: string; project_id: string; description: string; notes: string };
const empty = (mode: 'personal' | 'project', projectId?: string): Draft => ({
  title: '',
  category: mode === 'project' ? 'development' : 'goal',
  status: 'planned',
  date: '',
  project_id: projectId ?? '',
  description: '',
  notes: '',
});

/** Add or edit one timeline entry. `entry === 'new'` opens an empty form. */
export function EntryDialog({
  mode,
  entry,
  projectId,
  onClose,
  onSaved,
}: {
  /** personal: your own goals (Personal space) · project: milestones (Projects → Timeline). */
  mode: 'personal' | 'project';
  entry: TimelineEntry | 'new' | null;
  projectId?: string;
  onClose: () => void;
  onSaved: (r?: UpdateResult) => void;
}) {
  const projects = useProjects().data ?? [];
  const [d, setD] = useState<Draft>(empty(mode, projectId));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (entry === 'new') setD(empty(mode, projectId));
    else if (entry)
      setD({
        title: entry.title,
        category: entry.category,
        status: entry.status,
        date: entry.date ?? '',
        project_id: entry.project_id ?? '',
        description: entry.description ?? '',
        notes: entry.notes ?? '',
      });
  }, [entry, projectId, mode]);

  const save = async () => {
    setBusy(true);
    const body = { ...d, date: d.date || null, project_id: d.project_id || null, description: d.description || null, notes: d.notes || null, scope: d.project_id || mode === 'project' ? 'project' : 'personal' };
    try {
      if (entry === 'new') {
        await api('/timeline', { method: 'POST', body: JSON.stringify(body) });
        onSaved();
      } else if (entry) {
        onSaved(await api<UpdateResult>(`/timeline/${entry.id}`, { method: 'PATCH', body: JSON.stringify(body) }));
      }
      onClose();
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!entry || entry === 'new' || !confirm(`Delete "${entry.title}"?`)) return;
    try {
      await api(`/timeline/${entry.id}`, { method: 'DELETE' });
      onSaved();
      onClose();
    } catch (e: any) {
      notify('error', e.message);
    }
  };

  // Only the kinds that fit this space (plus the entry's own kind, so older entries stay editable).
  const wanted = mode === 'personal' ? 'Personal' : 'Project';
  const groups = (['Personal', 'Project'] as const)
    .map((g) => ({ g, items: (Object.keys(CATEGORY) as Category[]).filter((c) => CATEGORY[c].group === g && (g === wanted || c === d.category)) }))
    .filter((x) => x.items.length);
  return (
    <Dialog.Root open={!!entry} onOpenChange={(e) => !e.open && onClose()} placement="center" size="lg">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title fontFamily="heading">
                {entry === 'new' ? (mode === 'personal' ? 'New personal goal' : 'New project milestone') : mode === 'personal' ? 'Edit personal goal' : 'Edit milestone'}
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Stack gap="3">
                <Field.Root required>
                  <Field.Label>What is it?</Field.Label>
                  <Input value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} placeholder="Publish my first app on Google Play" maxLength={200} autoFocus />
                </Field.Root>
                <SimpleGrid columns={{ base: 1, sm: 2, md: 4 }} gap="3">
                  <Field.Root>
                    <Field.Label>Kind</Field.Label>
                    <NativeSelect.Root size="sm">
                      <NativeSelect.Field value={d.category} onChange={(e) => setD({ ...d, category: e.target.value as Category })}>
                        {groups.map(({ g, items }) => (
                          <optgroup key={g} label={g}>
                            {items.map((c) => (
                              <option key={c} value={c}>
                                {CATEGORY[c].label} (+{CATEGORY[c].xp} XP)
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </NativeSelect.Field>
                      <NativeSelect.Indicator />
                    </NativeSelect.Root>
                  </Field.Root>
                  <Field.Root>
                    <Field.Label>Status</Field.Label>
                    <NativeSelect.Root size="sm">
                      <NativeSelect.Field value={d.status} onChange={(e) => setD({ ...d, status: e.target.value as EntryStatus })}>
                        {(Object.keys(STATUS_LABEL) as EntryStatus[]).map((s) => (
                          <option key={s} value={s}>
                            {STATUS_LABEL[s]}
                          </option>
                        ))}
                      </NativeSelect.Field>
                      <NativeSelect.Indicator />
                    </NativeSelect.Root>
                  </Field.Root>
                  <Field.Root>
                    <Field.Label>{d.status === 'achieved' ? 'Date' : 'Target date'}</Field.Label>
                    <Input size="sm" type="date" value={d.date} onChange={(e) => setD({ ...d, date: e.target.value })} />
                  </Field.Root>
                  <Field.Root>
                    <Field.Label>{mode === 'personal' ? 'Move to a project' : 'Project'}</Field.Label>
                    <NativeSelect.Root size="sm">
                      <NativeSelect.Field value={d.project_id} onChange={(e) => setD({ ...d, project_id: e.target.value })}>
                        <option value="">{mode === 'personal' ? 'Keep personal' : 'No specific project'}</option>
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </NativeSelect.Field>
                      <NativeSelect.Indicator />
                    </NativeSelect.Root>
                  </Field.Root>
                </SimpleGrid>
                <Field.Root>
                  <Field.Label>Description</Field.Label>
                  <Textarea rows={2} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} placeholder="Why it matters, what “done” looks like" maxLength={5000} />
                </Field.Root>
                <Field.Root>
                  <Field.Label>Notes</Field.Label>
                  <Textarea rows={3} value={d.notes} onChange={(e) => setD({ ...d, notes: e.target.value })} placeholder="Links, steps, what you learned…" fontFamily="mono" fontSize="sm" maxLength={20000} />
                </Field.Root>
              </Stack>
            </Dialog.Body>
            <Dialog.Footer justifyContent="space-between">
              {entry !== 'new' ? (
                <Button size="sm" variant="ghost" colorPalette="red" onClick={() => void remove()}>
                  <LuTrash2 /> Delete
                </Button>
              ) : (
                <span />
              )}
              <Button onClick={() => void save()} loading={busy} disabled={!d.title.trim()}>
                {entry === 'new' ? 'Add' : 'Save'}
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
