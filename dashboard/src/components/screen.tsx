import { Box, Button, Center, Progress, Spinner, Stack, Text } from '@chakra-ui/react';
import { LuSun } from 'react-icons/lu';
import type { BootProgress } from '../lib/api';

const MODE_NOTE: Record<NonNullable<BootProgress['mode']>, string> = {
  fast: 'Fast boot from the clean snapshot',
  first: 'First start of this AVD: a cold boot that saves a snapshot, so later starts take seconds',
  cold: 'Cold boot (fast boot is off)',
};

const eta = (b: BootProgress) =>
  b.eta_s === null ? `${b.elapsed_s} s — taking longer than usual` : b.eta_s <= 1 ? 'almost ready' : `~${b.eta_s} s left · ${b.elapsed_s} s so far`;

/** Boot progress shown in place of a screen that is not ready yet: 1 → 100 %, the current stage and the time left. */
export function BootProgressView({ boot, compact = false }: { boot: BootProgress; compact?: boolean }) {
  const pct = Math.max(1, Math.min(100, Math.round(boot.progress)));
  return (
    <Stack
      align="center"
      justify="center"
      gap={compact ? '1.5' : '3'}
      w="100%"
      h="100%"
      p={compact ? '3' : '6'}
      textAlign="center"
      color="white"
      role="status"
      aria-live="polite"
      aria-label={`Booting ${boot.avd_name}: ${pct} percent, ${boot.phase ?? ''}`}
    >
      <Text fontFamily="heading" fontWeight="bold" fontSize={compact ? '2xl' : '5xl'} lineHeight="1" className="num">
        {pct}
        <Text as="span" fontSize={compact ? 'sm' : 'xl'} color="whiteAlpha.700">
          %
        </Text>
      </Text>
      <Progress.Root value={pct} size={compact ? 'xs' : 'sm'} w={compact ? '80%' : '70%'} maxW="260px" colorPalette="green" striped animated>
        <Progress.Track bg="whiteAlpha.200">
          <Progress.Range />
        </Progress.Track>
      </Progress.Root>
      <Text fontSize={compact ? '2xs' : 'sm'} fontWeight="medium">
        {boot.phase ?? 'Starting'}
      </Text>
      <Text fontSize={compact ? '2xs' : 'xs'} color="whiteAlpha.700">
        {eta(boot)}
      </Text>
      {!compact && boot.mode && (
        <Text fontSize="xs" color="whiteAlpha.600" maxW="280px">
          {MODE_NOTE[boot.mode]}
        </Text>
      )}
    </Stack>
  );
}

/** Placeholder while the first frame loads: a soft shimmer instead of a black box. */
export function ScreenLoading({ label = 'Loading screen…', compact = false }: { label?: string; compact?: boolean }) {
  return (
    <Center
      w="100%"
      h="100%"
      flexDirection="column"
      gap="2"
      color="gray.300"
      bgGradient="to-b"
      gradientFrom="gray.800"
      gradientTo="gray.900"
      css={{
        backgroundSize: '100% 200%',
        animation: 'pt-shimmer 1.6s ease-in-out infinite',
        '@keyframes pt-shimmer': { '0%, 100%': { backgroundPosition: '0 0' }, '50%': { backgroundPosition: '0 100%' } },
      }}
      role="status"
    >
      <Spinner size={compact ? 'sm' : 'md'} color="gray.300" />
      <Text fontSize={compact ? '2xs' : 'xs'}>{label}</Text>
    </Center>
  );
}

/** The device sends an all-black frame: screen off, locked to black, or still drawing. */
export function DarkScreenHint({ onWake, compact = false }: { onWake?: () => void; compact?: boolean }) {
  return (
    <Center position="absolute" inset="0" pointerEvents="none">
      <Stack align="center" gap="1.5" bg="blackAlpha.700" color="white" borderRadius="lg" px={compact ? '2' : '4'} py={compact ? '1.5' : '3'} pointerEvents="auto" textAlign="center">
        <Text fontSize={compact ? '2xs' : 'sm'} fontWeight="medium">
          Screen is dark
        </Text>
        {!compact && (
          <Text fontSize="xs" color="whiteAlpha.700" maxW="220px">
            The display is off or still drawing.
          </Text>
        )}
        {onWake && (
          <Button size={compact ? '2xs' : 'xs'} variant="solid" colorPalette="gray" onClick={onWake}>
            <LuSun /> Wake screen
          </Button>
        )}
      </Stack>
    </Center>
  );
}

/** Dim the last real frame under an overlay (boot progress, errors), so the box never flashes black. */
export function DimmedFrame({ url }: { url: string }) {
  return <Box position="absolute" inset="0" bgImage={`url(${url})`} bgSize="contain" bgPos="center" bgRepeat="no-repeat" opacity={0.25} filter="blur(2px)" aria-hidden />;
}
