import { useCallback, useRef, useState } from 'react';
import { Box, Button, Center, Flex, HStack, IconButton, Image, Input, SimpleGrid, Spinner, Stack, Text } from '@chakra-ui/react';
import { LuArrowLeft, LuCamera, LuCircle, LuCornerDownLeft, LuDelete, LuMonitorUp, LuPause, LuPlay, LuPower, LuSend, LuSquare, LuVolume1, LuVolume2 } from 'react-icons/lu';
import { api, dev } from '../../lib/api';
import { useBooting } from '../../lib/queries';
import { refreshScreen, useScreen } from '../../lib/screen';
import { BootProgressView, DarkScreenHint, DimmedFrame, ScreenLoading } from '../../components/screen';
import { notify } from '../../components/toaster';

const KEYS = [
  { key: 'back', icon: <LuArrowLeft />, title: 'Back' },
  { key: 'home', icon: <LuCircle />, title: 'Home' },
  { key: 'recents', icon: <LuSquare />, title: 'Recent apps' },
  { key: 'volume_down', icon: <LuVolume1 />, title: 'Volume down' },
  { key: 'volume_up', icon: <LuVolume2 />, title: 'Volume up' },
  { key: 'power', icon: <LuPower />, title: 'Power / lock' },
];

/**
 * In-browser live view with control: pulls PNG frames (adb screencap) as fast as the device delivers them
 * (~1–4 fps) and sends taps / swipes / keys through `adb shell input`. For smooth 60 fps use the scrcpy mirror.
 * While an emulator boots it shows the boot progress (1–100 %), and a black frame gets a "Wake screen" hint.
 */
export function LiveScreen({ serial, title, onMirror, canMirror }: { serial: string; title: string; onMirror?: () => void; canMirror: boolean }) {
  const [paused, setPaused] = useState(false);
  const [text, setText] = useState('');
  const imgRef = useRef<HTMLImageElement>(null);
  const down = useRef<{ x: number; y: number; t: number } | null>(null);
  // Shared frame loop: the last frame shows instantly when the page opens again (no black flash).
  const { frame, lastGood, error, fps } = useScreen(serial, { interval: 150, enabled: !paused });
  const boot = useBooting(serial);
  const dark = !!frame?.black && !boot;
  const shown = dark ? null : frame;

  const send = useCallback(
    async (body: object) => {
      try {
        await api(dev(serial, '/input'), { method: 'POST', body: JSON.stringify(body) });
        setTimeout(() => refreshScreen(serial), 200); // show the result of the tap right away
      } catch (e: any) {
        notify('error', e.message);
      }
    },
    [serial],
  );

  /** Browser pixels → device pixels using the frame's real size. */
  const toDevice = (clientX: number, clientY: number) => {
    const img = imgRef.current!;
    const r = img.getBoundingClientRect();
    return { x: Math.round(((clientX - r.left) / r.width) * img.naturalWidth), y: Math.round(((clientY - r.top) / r.height) * img.naturalHeight) };
  };
  const wake = () => void send({ action: 'key', key: 'wakeup' });

  const onPointerDown = (e: React.PointerEvent) => {
    if (!imgRef.current?.naturalWidth) return;
    e.preventDefault();
    down.current = { ...toDevice(e.clientX, e.clientY), t: performance.now() };
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const start = down.current;
    down.current = null;
    if (!start || !imgRef.current?.naturalWidth) return;
    const end = toDevice(e.clientX, e.clientY);
    const dist = Math.hypot(end.x - start.x, end.y - start.y);
    const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
    const w = imgRef.current.naturalWidth;
    const h = imgRef.current.naturalHeight;
    if (dist < 12) void send({ action: 'tap', x: clamp(start.x, w), y: clamp(start.y, h) });
    else
      void send({
        action: 'swipe',
        x1: clamp(start.x, w),
        y1: clamp(start.y, h),
        x2: clamp(end.x, w),
        y2: clamp(end.y, h),
        duration_ms: Math.round(Math.max(80, Math.min(1500, performance.now() - start.t))),
      });
  };

  const saveScreenshot = () => {
    if (!frame) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(frame.blob);
    a.download = `screenshot-${serial.replace(/[^\w.-]/g, '_')}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <Stack gap="3" w="100%">
      <Flex justify="space-between" align="center" gap="2">
        <Text fontSize="xs" color="fg.muted" className="num">
          {boot ? `Booting · ${Math.round(boot.progress)} %` : paused ? 'Paused' : fps !== null ? `${fps.toFixed(1)} fps` : frame ? 'Reconnecting…' : 'Connecting…'}
        </Text>
        <HStack gap="1">
          <IconButton size="xs" variant="ghost" aria-label={paused ? 'Resume' : 'Pause'} title={paused ? 'Resume' : 'Pause'} onClick={() => setPaused((p) => !p)}>
            {paused ? <LuPlay /> : <LuPause />}
          </IconButton>
          <IconButton size="xs" variant="ghost" aria-label="Save screenshot" title="Save screenshot" onClick={saveScreenshot} disabled={!frame}>
            <LuCamera />
          </IconButton>
          {onMirror && (
            <Button size="xs" variant="outline" onClick={onMirror} disabled={!canMirror} title={canMirror ? 'Smooth 60 fps mirror window (scrcpy)' : 'Install scrcpy first'}>
              <LuMonitorUp /> Mirror
            </Button>
          )}
        </HStack>
      </Flex>

      <Center bg="gray.900" borderRadius="xl" overflow="hidden" minH="320px" position="relative" borderWidth="6px" borderColor="gray.800">
        {shown && !boot ? (
          <Image
            ref={imgRef}
            src={shown.url}
            alt={`Screen of ${title}`}
            draggable={false}
            maxH="calc(100dvh - 300px)"
            minH="300px"
            w="auto"
            maxW="100%"
            objectFit="contain"
            cursor="pointer"
            userSelect="none"
            touchAction="none"
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerLeave={() => (down.current = null)}
          />
        ) : (
          <Box position="relative" w="100%" h="min(calc(100dvh - 300px), 640px)" minH="320px">
            {lastGood && (boot || dark) && <DimmedFrame url={lastGood.url} />}
            {boot ? (
              <BootProgressView boot={boot} />
            ) : dark ? (
              <DarkScreenHint onWake={wake} />
            ) : error ? (
              <Stack align="center" justify="center" h="100%" gap="2" color="gray.400" p="6" textAlign="center">
                <Spinner color="gray.400" size="sm" />
                <Text fontSize="sm">{error}</Text>
                <Text fontSize="xs">Retrying…</Text>
              </Stack>
            ) : (
              <ScreenLoading />
            )}
          </Box>
        )}
        {error && shown && !boot && (
          <Box position="absolute" bottom="2" left="2" right="2" bg="blackAlpha.700" color="white" fontSize="xs" borderRadius="md" px="2" py="1">
            {error}
          </Box>
        )}
      </Center>

      <SimpleGrid columns={6} gap="1">
        {KEYS.map((k) => (
          <IconButton key={k.key} size="sm" variant="outline" title={k.title} aria-label={k.title} onClick={() => void send({ action: 'key', key: k.key })}>
            {k.icon}
          </IconButton>
        ))}
      </SimpleGrid>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          void send({ action: 'text', text: text.trim() }).then(() => setText(''));
        }}
      >
        <HStack gap="1">
          <Input size="sm" value={text} onChange={(e) => setText(e.target.value)} placeholder="Type into the focused field" maxLength={200} aria-label="Text to type on the device" />
          <IconButton type="submit" size="sm" aria-label="Send text" title="Send text" disabled={!text.trim()}>
            <LuSend />
          </IconButton>
          <IconButton type="button" size="sm" variant="outline" aria-label="Enter" title="Enter" onClick={() => void send({ action: 'key', key: 'enter' })}>
            <LuCornerDownLeft />
          </IconButton>
          <IconButton type="button" size="sm" variant="outline" aria-label="Backspace" title="Backspace" onClick={() => void send({ action: 'key', key: 'delete' })}>
            <LuDelete />
          </IconButton>
        </HStack>
      </form>
      <Text fontSize="xs" color="fg.muted">
        Click = tap · drag = swipe / scroll. Frames come from adb screencap; use Mirror for smooth video.
      </Text>
    </Stack>
  );
}
