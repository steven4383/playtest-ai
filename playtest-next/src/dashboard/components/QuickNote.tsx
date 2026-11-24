'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, CloseButton, Dialog, HStack, Input, Kbd, NativeSelect, Portal, Stack, Text, Textarea } from '@chakra-ui/react';
import { LuNotebookPen } from 'react-icons/lu';
import { api } from '../lib/api';
import { nk } from '../lib/notebook';
import { useProjects } from '../lib/projects';
import { notify } from './toaster';

/**
 * Quick note from anywhere: header button or Alt+N. Ctrl+Enter saves. Notes land in Maintenance → Notes.
 */
export function QuickNote() {
  const qc = useQueryClient();
  const router = useRouter();
  const projects = useProjects().data ?? [];
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [project, setProject] = useState('');
  const [pinned, setPinned] = useState(false);
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const save = async () => {
    if (!title.trim() && !body.trim()) return;
    setBusy(true);
    try {
      await api('/notebook', { method: 'POST', body: JSON.stringify({ title: title.trim(), body, project_id: project || null, pinned }) });
      void qc.invalidateQueries({ queryKey: nk.all });
      notify('ok', 'Saved to Notes');
      setTitle('');
      setBody('');
      setPinned(false);
      setOpen(false);
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} title="Quick note (Alt+N)">
        <LuNotebookPen />
        <Text display={{ base: 'none', lg: 'inline' }}>Quick note</Text>
        <Kbd size="sm" display={{ base: 'none', xl: 'inline-flex' }}>
          Alt N
        </Kbd>
      </Button>
      <Dialog.Root open={open} onOpenChange={(e) => setOpen(e.open)} placement="center" size="md" initialFocusEl={() => bodyRef.current}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void save();
                }
              }}
            >
              <Dialog.Header>
                <Dialog.Title fontFamily="heading">Quick note</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Stack gap="3">
                  <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)" maxLength={200} variant="flushed" fontWeight="semibold" />
                  <Textarea
                    ref={bodyRef}
                    rows={7}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    placeholder={'Write anything…\n- [ ] a checklist item\n**bold**, `code`, links'}
                    fontFamily="mono"
                    fontSize="sm"
                  />
                  <HStack gap="3" wrap="wrap">
                    {projects.length > 0 && (
                      <NativeSelect.Root size="sm" w="auto" minW="180px">
                        <NativeSelect.Field value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
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
                    <Checkbox.Root size="sm" checked={pinned} onCheckedChange={(e) => setPinned(!!e.checked)}>
                      <Checkbox.HiddenInput />
                      <Checkbox.Control />
                      <Checkbox.Label>Pin</Checkbox.Label>
                    </Checkbox.Root>
                  </HStack>
                </Stack>
              </Dialog.Body>
              <Dialog.Footer justifyContent="space-between">
                <Button variant="ghost" size="sm" onClick={() => (setOpen(false), router.push('/notes'))}>
                  Open Notes
                </Button>
                <HStack gap="2">
                  <Text fontSize="xs" color="fg.muted" display={{ base: 'none', sm: 'block' }}>
                    Ctrl+Enter
                  </Text>
                  <Button onClick={() => void save()} loading={busy} disabled={!title.trim() && !body.trim()}>
                    Save note
                  </Button>
                </HStack>
              </Dialog.Footer>
              <Dialog.CloseTrigger asChild>
                <CloseButton size="sm" />
              </Dialog.CloseTrigger>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}
