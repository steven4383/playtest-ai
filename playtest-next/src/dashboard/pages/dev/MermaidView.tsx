import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Box, Button, Center, CloseButton, Dialog, HStack, IconButton, Portal, Text } from '@chakra-ui/react';
import { LuDownload, LuExpand, LuMinimize2, LuScan, LuZoomIn, LuZoomOut } from 'react-icons/lu';
import { useColorMode } from '../../colorMode';
import { Spinning } from '../../components/ui';

/**
 * Drawn diagrams, by theme + Mermaid text. Drawing is the slow part (layout of 30+ screens), so opening the
 * Flutter tab or a sub-tab again shows the same diagram instantly instead of redrawing it.
 */
const svgCache = new Map<string, string>();
const MAX_CACHED = 24;
const cacheKey = (mode: string, code: string) => `${mode}|${code}`;

/** Renders Mermaid text to SVG (mermaid is loaded lazily, only when a diagram is shown). */
export function MermaidView({ code, fileName = 'flow', onNodeClick, title = 'Diagram' }: { code: string; fileName?: string; onNodeClick?: (id: string) => void; title?: string }) {
  const { mode } = useColorMode();
  const [svg, setSvg] = useState<string | null>(() => svgCache.get(cacheKey(mode, code)) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const id = useId().replace(/[^\w]/g, '');
  // Callback ref: the scroll box moves between the card and the full-screen dialog, and effects must follow it.
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

  /**
   * Zoom that fits the diagram. 'card': width only, never below 80 %. 'screen': whole diagram but at least 60 % so labels
   * stay readable (drag to see the rest). 'whole': everything visible (Fit button).
   */
  const fitZoom = (how: 'card' | 'screen' | 'whole') => {
    if (!natural || !box) return 1;
    const zw = (box.clientWidth - 40) / natural.w;
    if (how === 'card') return Math.max(0.8, Math.min(1.2, zw));
    const z = Math.min(1.5, zw, (box.clientHeight - 60) / natural.h);
    return Math.max(how === 'screen' ? 0.6 : 0.2, z);
  };
  const center = () =>
    requestAnimationFrame(() => {
      if (box && box.scrollWidth > box.clientWidth) box.scrollLeft = (box.scrollWidth - box.clientWidth) / 2;
    });

  useEffect(() => {
    if (!svg || !box) return;
    const el = box.querySelector('svg');
    const vb = el?.viewBox?.baseVal;
    const r = el?.getBoundingClientRect();
    const w = vb?.width || r?.width || 0;
    const h = vb?.height || r?.height || 0;
    setNatural(w && h ? { w, h } : null);
  }, [svg, box]);

  // Clickable nodes: Mermaid puts the node id in data-id (newer) or id="...flowchart-<id>-<n>".
  const clickRef = useRef(onNodeClick);
  clickRef.current = onNodeClick;
  useEffect(() => {
    if (!svg || !box || !clickRef.current) return;
    const nodes = [...box.querySelectorAll<SVGGElement>('g.node')];
    const cleanups = nodes.map((n) => {
      const nodeId = n.getAttribute('data-id') ?? n.id.match(/flowchart-(.+)-\d+$/)?.[1] ?? null;
      if (!nodeId) return () => {};
      n.style.cursor = 'pointer';
      const fn = () => {
        if (dragged.current) return; // a pan, not a click
        clickRef.current?.(nodeId);
      };
      n.addEventListener('click', fn);
      return () => n.removeEventListener('click', fn);
    });
    return () => cleanups.forEach((c) => c());
  }, [svg, box]);

  // Fit when the diagram or the container (card ↔ full screen) changes — and again once the dialog has its final size —
  // then centre on Start. Stops following the size as soon as the user zooms by hand.
  const manual = useRef(false);
  useEffect(() => {
    if (!natural || !box) return;
    manual.current = false;
    const fit = () => {
      if (manual.current) return;
      setZoom(fitZoom(expanded ? 'screen' : 'card'));
      center();
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [natural, box, expanded]);
  const zoomBy = (d: number) => {
    manual.current = true;
    setZoom((z) => Math.min(3, Math.max(0.2, +(z + d).toFixed(2))));
  };

  useEffect(() => {
    let cancelled = false;
    setError(null);
    const key = cacheKey(mode, code);
    const hit = svgCache.get(key);
    if (hit) {
      setSvg(hit);
      return;
    }
    setSvg(null);
    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: mode === 'dark' ? 'dark' : 'default',
          fontFamily: 'Roboto, Segoe UI, sans-serif',
          themeVariables: { fontSize: '16px' },
          flowchart: { htmlLabels: true, curve: 'basis', nodeSpacing: 28, rankSpacing: 46, padding: 12, useMaxWidth: false },
        });
        const r = await mermaid.render(`m${id}${Date.now()}`, code);
        svgCache.set(key, r.svg);
        if (svgCache.size > MAX_CACHED) svgCache.delete(svgCache.keys().next().value!);
        if (!cancelled) setSvg(r.svg);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, mode, id]);

  // Drag to pan (big diagrams are easier to move around than to scroll in two directions).
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const dragged = useRef(false);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !box) return;
    drag.current = { x: e.clientX, y: e.clientY, left: box.scrollLeft, top: box.scrollTop };
    dragged.current = false;
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || !box) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!dragged.current && Math.abs(dx) + Math.abs(dy) < 6) return;
    dragged.current = true;
    box.scrollLeft = d.left - dx;
    box.scrollTop = d.top - dy;
  };
  const endDrag = () => {
    drag.current = null;
    setTimeout(() => (dragged.current = false), 0);
  };

  const download = () => {
    if (!svg) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    a.download = `${fileName}.svg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const toolbar = (
    <HStack gap="1" bg="bg.panel" borderWidth="1px" borderRadius="md" p="0.5" shadow="xs">
      <IconButton size="2xs" variant="ghost" aria-label="Zoom out" title="Zoom out" onClick={() => zoomBy(-0.1)}>
        <LuZoomOut />
      </IconButton>
      <Text fontSize="2xs" className="num" minW="8" textAlign="center">
        {Math.round(zoom * 100)}%
      </Text>
      <IconButton size="2xs" variant="ghost" aria-label="Zoom in" title="Zoom in" onClick={() => zoomBy(0.1)}>
        <LuZoomIn />
      </IconButton>
      <IconButton
        size="2xs"
        variant="ghost"
        aria-label="Fit whole diagram"
        title="Fit the whole diagram"
        onClick={() => {
          manual.current = true;
          setZoom(fitZoom('whole'));
          center();
        }}
        disabled={!natural}
      >
        <LuScan />
      </IconButton>
      <IconButton size="2xs" variant="ghost" aria-label="Download SVG" title="Download SVG" onClick={download} disabled={!svg}>
        <LuDownload />
      </IconButton>
      <IconButton
        size="2xs"
        variant={expanded ? 'solid' : 'ghost'}
        aria-label={expanded ? 'Exit full screen' : 'Expand to full screen'}
        title={expanded ? 'Exit full screen (Esc)' : 'Expand to full screen'}
        onClick={() => setExpanded((x) => !x)}
        disabled={!svg && !error}
      >
        {expanded ? <LuMinimize2 /> : <LuExpand />}
      </IconButton>
    </HStack>
  );

  const canvas = (fill: boolean) => (
    <Box
      ref={setBox}
      overflow="auto"
      h={fill ? '100%' : undefined}
      maxH={fill ? undefined : '640px'}
      minH="240px"
      p="4"
      pt="12"
      cursor={drag.current ? 'grabbing' : 'grab'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerLeave={endDrag}
      userSelect="none"
    >
      {error ? (
        <Text color="fg.error" fontSize="sm">
          Could not draw the diagram: {error}
        </Text>
      ) : !svg ? (
        <Spinning label="Drawing the flow diagram…" />
      ) : (
        <Box
          style={{ zoom }}
          w="max-content"
          mx="auto"
          css={{ '& svg': { maxWidth: 'none', height: 'auto', display: 'block' }, '& .nodeLabel, & .edgeLabel, & .cluster-label': { fontSize: '14px', lineHeight: '1.25' } }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
    </Box>
  );

  return (
    <>
      <Box position="relative" borderWidth="1px" borderRadius="md" bg="bg.subtle">
        <Box position="absolute" top="2" right="2" zIndex="1">
          {toolbar}
        </Box>
        {expanded ? (
          <Center minH="240px" flexDirection="column" gap="2" color="fg.muted" fontSize="sm">
            <Text>Shown in full screen</Text>
            <Button size="xs" variant="outline" onClick={() => setExpanded(false)}>
              <LuMinimize2 /> Back to the card
            </Button>
          </Center>
        ) : (
          canvas(false)
        )}
      </Box>

      <Dialog.Root open={expanded} onOpenChange={(e) => setExpanded(e.open)} size="full" motionPreset="none">
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content bg="bg.subtle">
              <Dialog.Header py="3" borderBottomWidth="1px" bg="bg.panel">
                <Dialog.Title fontFamily="heading" fontSize="md">
                  {title}
                </Dialog.Title>
                <Text fontSize="xs" color="fg.muted" ml="3" display={{ base: 'none', md: 'block' }}>
                  Drag to move · {onNodeClick ? 'click a screen for details · ' : ''}Esc to close
                </Text>
              </Dialog.Header>
              <Dialog.Body p="0" position="relative" overflow="hidden">
                <Box position="absolute" top="3" right="4" zIndex="1">
                  {toolbar}
                </Box>
                {expanded && canvas(true)}
              </Dialog.Body>
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
