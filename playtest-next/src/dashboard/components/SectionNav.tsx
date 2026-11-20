import { useEffect, useState, type ReactNode } from 'react';
import { Badge, Box, Flex, Grid, HStack, IconButton, Stack, Text, chakra } from '@chakra-ui/react';
import { LuPanelLeftClose, LuPanelLeftOpen } from 'react-icons/lu';

export interface Section {
  id: string;
  label: string;
  icon?: ReactNode;
  badge?: ReactNode;
}

/**
 * Page layout with a sticky section sidebar (wide screens) or a scrollable chip row (phones).
 * Sections are the page's <Card id=…> elements; the one in view is highlighted.
 */
export function SectionLayout({ sections, children, title = 'On this page' }: { sections: Section[]; children: ReactNode; title?: string }) {
  const [active, setActive] = useState(sections[0]?.id);
  const [mini, setMini] = useState(() => {
    try {
      return localStorage.getItem('pt-section-nav-mini') === '1';
    } catch {
      return false;
    }
  });
  const toggleMini = () =>
    setMini((m) => {
      try {
        localStorage.setItem('pt-section-nav-mini', m ? '0' : '1');
      } catch {
        /* not remembered */
      }
      return !m;
    });

  useEffect(() => {
    const els = sections.map((s) => document.getElementById(s.id)).filter((e): e is HTMLElement => !!e);
    if (!els.length) return;
    const visible = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visible.set(e.target.id, e.isIntersecting ? e.intersectionRatio : 0);
        const best = sections.find((s) => (visible.get(s.id) ?? 0) > 0);
        if (best) setActive(best.id);
      },
      { rootMargin: '-80px 0px -45% 0px', threshold: [0, 0.01, 0.25] },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [sections.map((s) => s.id).join(',')]);

  const go = (id: string) => {
    setActive(id);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const item = (s: Section, compact: boolean, iconOnly = false) => {
    const on = active === s.id;
    return (
      <chakra.button
        key={s.id}
        onClick={() => go(s.id)}
        aria-current={on ? 'true' : undefined}
        aria-label={iconOnly ? s.label : undefined}
        title={iconOnly ? s.label : undefined}
        justifyContent={iconOnly ? 'center' : undefined}
        display="flex"
        alignItems="center"
        gap="2"
        px={compact ? '3' : '2.5'}
        py={compact ? '1.5' : '2'}
        borderRadius={compact ? 'full' : 'md'}
        borderWidth={compact ? '1px' : '0'}
        fontSize="sm"
        whiteSpace="nowrap"
        textAlign="left"
        w={compact ? 'auto' : '100%'}
        color={on ? 'colorPalette.fg' : 'fg.muted'}
        bg={on ? 'colorPalette.subtle' : compact ? 'bg.panel' : 'transparent'}
        borderColor={on ? 'colorPalette.muted' : 'border'}
        fontWeight={on ? 'semibold' : 'normal'}
        cursor="pointer"
        borderInlineStartWidth={compact ? undefined : '2px'}
        borderInlineStartColor={compact ? undefined : on ? 'colorPalette.solid' : 'transparent'}
        _hover={{ color: 'fg', bg: on ? 'colorPalette.subtle' : 'bg.muted' }}
      >
        {s.icon && <Box fontSize="md">{s.icon}</Box>}
        {!iconOnly && (
          <Text flex={compact ? undefined : '1'} truncate>
            {s.label}
          </Text>
        )}
        {!iconOnly && s.badge !== undefined && s.badge !== null && s.badge !== false && (
          <Badge size="xs" variant="subtle">
            {s.badge}
          </Badge>
        )}
      </chakra.button>
    );
  };

  return (
    <Grid templateColumns={{ base: '1fr', lg: `${mini ? '44px' : '200px'} minmax(0, 1fr)` }} gap={{ base: '5', lg: mini ? '3' : '5' }} alignItems="start" transition="grid-template-columns 0.15s">
      <Box as="nav" aria-label={title} display={{ base: 'none', lg: 'block' }} position="sticky" top="20">
        <Flex align="center" justify={mini ? 'center' : 'space-between'} pb="2" ps={mini ? '0' : '2.5'}>
          {!mini && (
            <Text fontSize="2xs" fontWeight="semibold" textTransform="uppercase" letterSpacing="wider" color="fg.subtle">
              {title}
            </Text>
          )}
          <IconButton size="2xs" variant="ghost" aria-label={mini ? 'Expand section list' : 'Minimise section list'} title={mini ? 'Expand' : 'Minimise'} onClick={toggleMini}>
            {mini ? <LuPanelLeftOpen /> : <LuPanelLeftClose />}
          </IconButton>
        </Flex>
        <Stack gap="0.5">{sections.map((s) => item(s, false, mini))}</Stack>
      </Box>
      <Box minW="0">
        <HStack as="nav" aria-label={title} display={{ base: 'flex', lg: 'none' }} gap="2" overflowX="auto" pb="3" mb="1">
          {sections.map((s) => item(s, true))}
        </HStack>
        <Stack gap="5">{children}</Stack>
      </Box>
    </Grid>
  );
}
