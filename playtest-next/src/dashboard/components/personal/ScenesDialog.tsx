'use client';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Box, Button, CloseButton, Dialog, Flex, HStack, Input, Portal, Stack, Text } from '@chakra-ui/react';
import { LuCheck, LuImagePlus, LuSparkles, LuTrash2 } from 'react-icons/lu';
import { api } from '../../lib/api';
import { autoAccent, backdropUrl, bk, DEFAULT_ACCENT, type Backdrop } from '../../lib/backdrops';
import { Empty } from '../ui';
import { notify } from '../toaster';

/** One scene: name, accent color, which part of the image stays in view. Saves as you change it. */
function SceneRow({ b }: { b: Backdrop }) {
  const qc = useQueryClient();
  const [name, setName] = useState(b.name);
  const [fx, setFx] = useState(b.focus_x);
  const [fy, setFy] = useState(b.focus_y);
  useEffect(() => {
    setName(b.name);
    setFx(b.focus_x);
    setFy(b.focus_y);
  }, [b.name, b.focus_x, b.focus_y]);

  const save = async (patch: Record<string, unknown>) => {
    try {
      await api(`/personal/backdrops/${b.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      await qc.invalidateQueries({ queryKey: bk.all });
    } catch (e: any) {
      notify('error', e.message);
    }
  };
  const remove = async () => {
    if (!confirm(`Remove the scene "${b.name}"? The image file is deleted from this PC.`)) return;
    try {
      await api(`/personal/backdrops/${b.id}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: bk.all });
    } catch (e: any) {
      notify('error', e.message);
    }
  };

  return (
    <Flex gap="4" p="3" borderWidth="1px" borderRadius="lg" borderColor={b.active ? 'colorPalette.solid' : 'border'} colorPalette="blue" direction={{ base: 'column', sm: 'row' }}>
      <Box flexShrink={0} w={{ base: '100%', sm: '200px' }} h="112px" borderRadius="md" overflow="hidden" position="relative" bg="black">
        <img src={backdropUrl(b)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: `${fx}% ${fy}%` }} />
        {b.active && (
          <Box position="absolute" top="2" left="2" px="2" py="0.5" borderRadius="full" bg="blackAlpha.700" color="white" fontSize="2xs" fontWeight="bold" letterSpacing="0.1em">
            IN USE
          </Box>
        )}
      </Box>
      <Stack gap="2" flex="1" minW="0">
        <Input size="sm" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== b.name && void save({ name: name.trim() })} aria-label="Scene name" />
        <HStack gap="2" wrap="wrap">
          <Text fontSize="xs" color="fg.muted" w="16">
            Accent
          </Text>
          <input
            type="color"
            value={b.accent ?? DEFAULT_ACCENT}
            onChange={(e) => void save({ accent: e.target.value })}
            aria-label="Accent color"
            style={{ width: 34, height: 26, border: 'none', background: 'none', padding: 0, cursor: 'pointer' }}
          />
          <Button size="2xs" variant="ghost" onClick={() => void autoAccent(b).then(() => qc.invalidateQueries({ queryKey: bk.all }))} title="Take the color from the image">
            <LuSparkles /> From image
          </Button>
        </HStack>
        <HStack gap="2">
          <Text fontSize="xs" color="fg.muted" w="16">
            Focus ↔
          </Text>
          <input type="range" min={0} max={100} value={fx} onChange={(e) => setFx(+e.target.value)} onPointerUp={() => void save({ focus_x: fx })} onKeyUp={() => void save({ focus_x: fx })} style={{ flex: 1 }} aria-label="Horizontal focus" />
        </HStack>
        <HStack gap="2">
          <Text fontSize="xs" color="fg.muted" w="16">
            Focus ↕
          </Text>
          <input type="range" min={0} max={100} value={fy} onChange={(e) => setFy(+e.target.value)} onPointerUp={() => void save({ focus_y: fy })} onKeyUp={() => void save({ focus_y: fy })} style={{ flex: 1 }} aria-label="Vertical focus" />
        </HStack>
        <HStack gap="2" justify="flex-end">
          <Button size="xs" variant="ghost" colorPalette="red" onClick={() => void remove()}>
            <LuTrash2 /> Remove
          </Button>
          {!b.active && (
            <Button size="xs" onClick={() => void save({ active: true })}>
              <LuCheck /> Use this scene
            </Button>
          )}
        </HStack>
      </Stack>
    </Flex>
  );
}

export function ScenesDialog({ open, list, onClose, onAdd }: { open: boolean; list: Backdrop[]; onClose: () => void; onAdd: () => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={(e) => !e.open && onClose()} placement="center" size="lg" scrollBehavior="inside">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title fontFamily="heading">Scenes</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Text fontSize="sm" color="fg.muted" mb="3">
                Your favourite character art or wallpapers as the Personal space backdrop. The page takes its glow color from the image. Images stay on this PC
                (storage/personal) and are never uploaded anywhere.
              </Text>
              {list.length === 0 ? (
                <Empty icon={<LuImagePlus />} title="No scenes yet">
                  Add a PNG, JPEG, WebP or GIF (up to 25 MB) — or drop it onto the Personal space banner.
                </Empty>
              ) : (
                <Stack gap="3">
                  {list.map((b) => (
                    <SceneRow key={b.id} b={b} />
                  ))}
                </Stack>
              )}
            </Dialog.Body>
            <Dialog.Footer>
              <Button onClick={onAdd}>
                <LuImagePlus /> Add images
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
