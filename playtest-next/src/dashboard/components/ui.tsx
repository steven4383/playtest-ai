import { useEffect, useState, type ReactNode } from 'react';
import {
  Alert,
  Badge as CBadge,
  Box,
  Button,
  Card as CCard,
  Center,
  EmptyState,
  Flex,
  Grid,
  Heading,
  HStack,
  IconButton,
  Progress,
  Skeleton,
  Spinner,
  Stack,
  Stat as CStat,
  Text,
  VStack,
  type ButtonProps,
} from '@chakra-ui/react';
import { LuCheck, LuCopy } from 'react-icons/lu';

export type Tone = 'good' | 'warning' | 'serious' | 'critical' | 'neutral';

const PALETTE: Record<Tone, string> = { good: 'green', warning: 'yellow', serious: 'orange', critical: 'red', neutral: 'gray' };
const ICON: Record<Tone, string> = { good: '●', warning: '▲', serious: '◆', critical: '✕', neutral: '○' };

/** Status always carries icon + label, never color alone. */
export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <CBadge colorPalette={PALETTE[tone]} variant="subtle" gap="1" flexShrink={0}>
      <span aria-hidden>{ICON[tone]}</span>
      {typeof children === 'string' ? children.charAt(0).toUpperCase() + children.slice(1) : children}
    </CBadge>
  );
}

export function toneForPct(p: number): Tone {
  if (p >= 92) return 'critical';
  if (p >= 80) return 'serious';
  if (p >= 65) return 'warning';
  return 'good';
}

export function Meter({ pct, label, detail }: { pct: number; label: string; detail?: string }) {
  const tone = toneForPct(pct);
  return (
    <Progress.Root value={Math.min(100, Math.max(0, pct))} colorPalette={PALETTE[tone]} size="sm" title={`${label}: ${pct.toFixed(1)}%`}>
      <HStack justify="space-between" mb="1">
        <Progress.Label fontWeight="normal" color="fg.muted">
          {label}
        </Progress.Label>
        <Text className="num" fontSize="xs">
          {detail ?? `${pct.toFixed(0)}%`}
        </Text>
      </HStack>
      <Progress.Track>
        <Progress.Range />
      </Progress.Track>
    </Progress.Root>
  );
}

/** Page section card. `id` makes it a jump target for the section sidebars. */
export function Card({
  title,
  subtitle,
  children,
  actions,
  id,
  icon,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  id?: string;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <CCard.Root id={id} bg="bg.panel" variant="outline" size="sm" scrollMarginTop="20" shadow="xs" minW="0">
      <CCard.Header>
        <Flex gap="3" align="flex-start" justify="space-between" wrap="wrap">
          <HStack gap="2.5" align="flex-start" minW="0">
            {icon && (
              <Box color="colorPalette.fg" mt="0.5" fontSize="lg">
                {icon}
              </Box>
            )}
            <Box minW="0">
              <CCard.Title as="h2" fontFamily="heading" fontSize="md">
                {title}
              </CCard.Title>
              {subtitle && (
                <CCard.Description fontSize="xs" mt="0.5">
                  {subtitle}
                </CCard.Description>
              )}
            </Box>
          </HStack>
          {actions && (
            <HStack gap="2" flexShrink={0} wrap="wrap">
              {actions}
            </HStack>
          )}
        </Flex>
      </CCard.Header>
      <CCard.Body gap="3" pt="3">
        {children}
      </CCard.Body>
    </CCard.Root>
  );
}

export function Stat({ label, value, unit, hint }: { label: string; value: ReactNode; unit?: string; hint?: ReactNode }) {
  return (
    <CStat.Root>
      <CStat.Label fontSize="xs">{label}</CStat.Label>
      <CStat.ValueText fontFamily="heading" fontSize="xl" className="num">
        {value}
        {unit && <CStat.ValueUnit>{unit}</CStat.ValueUnit>}
      </CStat.ValueText>
      {hint && <CStat.HelpText fontSize="xs">{hint}</CStat.HelpText>}
    </CStat.Root>
  );
}

/** Inline message inside a card or page. */
export function Notice({ tone = 'info', title, children }: { tone?: 'info' | 'warning' | 'error' | 'success'; title?: ReactNode; children?: ReactNode }) {
  return (
    <Alert.Root status={tone} size="sm" borderRadius="md">
      <Alert.Indicator />
      <Alert.Content>
        {title && <Alert.Title>{title}</Alert.Title>}
        {children && <Alert.Description>{children}</Alert.Description>}
      </Alert.Content>
    </Alert.Root>
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <EmptyState.Root size="sm" borderWidth="1px" borderStyle="dashed" borderRadius="lg">
      <EmptyState.Content>
        {icon && <EmptyState.Indicator>{icon}</EmptyState.Indicator>}
        <VStack textAlign="center" gap="1">
          <EmptyState.Title>{title}</EmptyState.Title>
          {children && <EmptyState.Description>{children}</EmptyState.Description>}
        </VStack>
        {action}
      </EmptyState.Content>
    </EmptyState.Root>
  );
}

/** Loading placeholder: a few skeleton rows (lists, tables, cards). */
export function Loading({ rows = 3, height = '5', label }: { rows?: number; height?: string; label?: string }) {
  return (
    <Stack gap="2" aria-busy="true" aria-label={label ?? 'Loading'}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={height} width={i === rows - 1 && rows > 1 ? '70%' : '100%'} borderRadius="md" />
      ))}
    </Stack>
  );
}

/** Centered spinner with text, for whole panels that are fetching. */
export function Spinning({ label = 'Loading…' }: { label?: string }) {
  return (
    <Center py="8" gap="3" color="fg.muted">
      <Spinner size="sm" colorPalette="blue" color="colorPalette.solid" />
      <Text fontSize="sm">{label}</Text>
    </Center>
  );
}

/** Key/value list. `cols` = two pairs per row on wide screens. */
export function Kv({ items, cols }: { items: [ReactNode, ReactNode][]; cols?: boolean }) {
  return (
    <Grid templateColumns={cols ? { base: 'minmax(110px, auto) 1fr', lg: 'minmax(130px, auto) 1fr minmax(130px, auto) 1fr' } : 'minmax(120px, auto) 1fr'} columnGap="4" rowGap="1.5" fontSize="sm">
      {items.map(([k, v], i) => (
        <Box key={i} display="contents">
          <Text color="fg.muted">{k}</Text>
          <Box minW="0" wordBreak="break-word">
            {v}
          </Box>
        </Box>
      ))}
    </Grid>
  );
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    window.prompt('Copy this:', text);
    return false;
  }
}

export function CopyButton({ value, label, ...rest }: { value: string; label?: string } & Omit<ButtonProps, 'value'>) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(t);
  }, [done]);
  const onClick = async () => setDone(await copyText(value));
  if (!label)
    return (
      <IconButton size="2xs" variant="ghost" aria-label={`Copy ${value}`} title="Copy" onClick={() => void onClick()} {...(rest as any)}>
        {done ? <LuCheck /> : <LuCopy />}
      </IconButton>
    );
  return (
    <Button size="xs" variant="outline" onClick={() => void onClick()} {...rest}>
      {done ? <LuCheck /> : <LuCopy />} {done ? 'Copied' : label}
    </Button>
  );
}

/** Section title inside a card. */
export function SubHeading({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <Flex justify="space-between" align="center" gap="2" wrap="wrap">
      <Heading as="h3" size="sm" fontFamily="heading">
        {children}
      </Heading>
      {actions}
    </Flex>
  );
}

/** Wraps an async click: disables + spinner while it runs. */
export function useBusy() {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async <T,>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(key);
    try {
      return await fn();
    } finally {
      setBusy((b) => (b === key ? null : b));
    }
  };
  return { busy, run, is: (key: string) => busy === key };
}
