'use client';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge as CBadge, Box, Button, CloseButton, Dialog, Flex, HStack, IconButton, Input, Portal, Stack, Text, chakra } from '@chakra-ui/react';
import { LuArrowUp, LuFolder, LuFolderOpen, LuHardDrive, LuHouse, LuMonitor } from 'react-icons/lu';
import { SiFlutter } from 'react-icons/si';
import { api } from '../lib/api';
import { notify } from './toaster';

interface Folder {
  name: string;
  path: string;
  flutter: boolean;
  git: boolean;
  node: boolean;
}
interface Listing {
  path: string | null;
  parent: string | null;
  self: { flutter: boolean; git: boolean; node: boolean } | null;
  folders: Folder[];
  places: { label: string; path: string }[];
  drives: { label: string; path: string }[];
}

function Tags({ f }: { f: { flutter: boolean; git: boolean; node: boolean } }) {
  return (
    <HStack gap="1" flexShrink={0}>
      {f.flutter && (
        <CBadge size="xs" colorPalette="cyan" variant="subtle" gap="1">
          <SiFlutter /> Flutter
        </CBadge>
      )}
      {f.git && (
        <CBadge size="xs" colorPalette="orange" variant="subtle">
          Git
        </CBadge>
      )}
      {f.node && (
        <CBadge size="xs" colorPalette="green" variant="subtle">
          Node
        </CBadge>
      )}
    </HStack>
  );
}

/** Browse this PC's folders (Flutter apps and git repos are marked) — or use the Windows folder dialog. */
export function FolderDialog({ open, initial, title = 'Choose a folder', onClose, onPick }: { open: boolean; initial?: string; title?: string; onClose: () => void; onPick: (path: string) => void }) {
  const [path, setPath] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [native, setNative] = useState(false);
  useEffect(() => {
    if (open) {
      setPath(initial?.trim() ? initial.trim() : null);
      setSelected(null);
    }
  }, [open, initial]);
  const q = useQuery({
    queryKey: ['fs', path ?? ''],
    enabled: open,
    retry: false,
    queryFn: () => api<Listing>(`/fs/folders${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  });
  // A typed path that does not exist: fall back to the start screen.
  useEffect(() => {
    if (q.isError && path) setPath(null);
  }, [q.isError, path]);
  const l = q.data;
  const crumbs = l?.path ? l.path.split(/[\\/]/).filter(Boolean) : [];
  const sep = l?.path?.includes('\\') ? '\\' : '/';
  const choose = (p: string) => {
    onPick(p);
    onClose();
  };
  const windowsDialog = async () => {
    setNative(true);
    try {
      const r = await api<{ path: string | null }>('/fs/pick-folder', { method: 'POST', body: JSON.stringify({ initial: selected ?? l?.path ?? initial ?? '' }) });
      if (r.path) choose(r.path);
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setNative(false);
    }
  };

  const places = (
    <Stack gap="0.5" w={{ base: '100%', md: '170px' }} flexShrink={0}>
      {[...(l?.places ?? []).map((p) => ({ ...p, icon: <LuHouse /> })), ...(l?.drives ?? []).map((d) => ({ ...d, icon: <LuHardDrive /> }))].map((p) => (
        <chakra.button
          key={p.path}
          onClick={() => (setPath(p.path), setSelected(null))}
          display="flex"
          alignItems="center"
          gap="2"
          px="2"
          py="1.5"
          borderRadius="md"
          fontSize="sm"
          textAlign="left"
          bg={l?.path === p.path ? 'colorPalette.subtle' : 'transparent'}
          _hover={{ bg: 'bg.muted' }}
        >
          <Box color="fg.muted">{p.icon}</Box>
          <Text truncate>{p.label}</Text>
        </chakra.button>
      ))}
    </Stack>
  );

  return (
    <Dialog.Root open={open} onOpenChange={(e) => !e.open && onClose()} placement="center" size="xl">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title fontFamily="heading">{title}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Flex gap="4" direction={{ base: 'column', md: 'row' }}>
                {places}
                <Stack gap="2" flex="1" minW="0">
                  <HStack gap="1" minH="8" wrap="wrap">
                    <IconButton size="xs" variant="ghost" aria-label="Up one folder" disabled={!l?.path} onClick={() => (setPath(l?.parent ?? null), setSelected(null))}>
                      <LuArrowUp />
                    </IconButton>
                    {crumbs.map((c, i) => {
                      const p = crumbs.slice(0, i + 1).join(sep) + (i === 0 && sep === '\\' ? '\\' : '');
                      return (
                        <HStack key={p} gap="1">
                          {i > 0 && <Text color="fg.subtle">›</Text>}
                          <Button size="xs" variant="ghost" px="1.5" onClick={() => (setPath(sep === '/' ? `/${p}` : p), setSelected(null))}>
                            {c}
                          </Button>
                        </HStack>
                      );
                    })}
                    {!l?.path && <Text fontSize="sm" color="fg.muted">Pick a drive or folder on the left</Text>}
                  </HStack>
                  <Stack gap="0" h="340px" overflowY="auto" borderWidth="1px" borderRadius="md">
                    {q.isFetching && !l ? (
                      <Text p="3" fontSize="sm" color="fg.muted">
                        Loading…
                      </Text>
                    ) : l?.path && l.folders.length === 0 ? (
                      <Text p="3" fontSize="sm" color="fg.muted">
                        No sub-folders here.
                      </Text>
                    ) : (
                      l?.folders.map((f) => (
                        <chakra.button
                          key={f.path}
                          onClick={() => setSelected(f.path)}
                          onDoubleClick={() => (setPath(f.path), setSelected(null))}
                          display="flex"
                          alignItems="center"
                          gap="2.5"
                          px="3"
                          py="2"
                          textAlign="left"
                          borderBottomWidth="1px"
                          bg={selected === f.path ? 'colorPalette.subtle' : 'transparent'}
                          _hover={{ bg: selected === f.path ? 'colorPalette.subtle' : 'bg.muted' }}
                          title="Click to select · double-click to open"
                        >
                          <Box color={f.flutter ? 'cyan.fg' : 'fg.muted'}>{f.flutter ? <LuFolderOpen /> : <LuFolder />}</Box>
                          <Text fontSize="sm" flex="1" truncate>
                            {f.name}
                          </Text>
                          <Tags f={f} />
                        </chakra.button>
                      ))
                    )}
                  </Stack>
                  <HStack gap="2" fontSize="xs" color="fg.muted" minH="5">
                    {l?.self && (l.self.flutter || l.self.git) && !selected && (
                      <>
                        <Text>This folder:</Text>
                        <Tags f={l.self} />
                      </>
                    )}
                  </HStack>
                </Stack>
              </Flex>
            </Dialog.Body>
            <Dialog.Footer justifyContent="space-between" flexWrap="wrap" gap="2">
              <Button size="sm" variant="ghost" onClick={() => void windowsDialog()} loading={native} loadingText="Waiting for the dialog…" title="Opens the Windows folder dialog on this PC">
                <LuMonitor /> Windows dialog…
              </Button>
              <HStack gap="2" minW="0">
                <Text fontSize="xs" color="fg.muted" fontFamily="mono" truncate maxW="320px" title={selected ?? l?.path ?? ''}>
                  {selected ?? l?.path ?? ''}
                </Text>
                <Button size="sm" disabled={!selected && !l?.path} onClick={() => choose((selected ?? l?.path)!)}>
                  {selected ? 'Choose' : 'Choose this folder'}
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
  );
}

/** A path field with a "Browse…" button. */
export function FolderInput({
  value,
  onChange,
  placeholder,
  title,
  size = 'sm',
}: {
  value: string;
  onChange: (path: string) => void;
  placeholder?: string;
  title?: string;
  size?: 'xs' | 'sm' | 'md';
}) {
  const [open, setOpen] = useState(false);
  return (
    <HStack w="100%" gap="2">
      <Input size={size} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} fontFamily="mono" spellCheck={false} aria-label={title ?? 'Folder'} />
      <Button size={size} variant="outline" onClick={() => setOpen(true)} flexShrink={0}>
        <LuFolderOpen /> Browse…
      </Button>
      <FolderDialog open={open} initial={value} title={title} onClose={() => setOpen(false)} onPick={onChange} />
    </HStack>
  );
}
