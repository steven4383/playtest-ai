import { createSystem, defaultConfig, defineConfig } from '@chakra-ui/react';

/**
 * Chakra UI v3 theme: Roboto for text, Poppins for headings and big numbers, blue accent.
 * Dark/light is a `dark` / `light` class on <html> (see colorMode.tsx); every color below is a semantic
 * token that has a value for both, so components never hard-code a mode.
 */
const config = defineConfig({
  globalCss: {
    html: { colorPalette: 'blue' },
    'html, body': { bg: 'bg.canvas', color: 'fg', minHeight: '100%' },
    body: { fontSize: 'sm', lineHeight: '1.5' },
    '*::selection': { bg: 'colorPalette.subtle' },
    // Numbers line up in tables and live metrics.
    '.num, td, th': { fontVariantNumeric: 'tabular-nums' },
  },
  theme: {
    tokens: {
      fonts: {
        heading: { value: "'Poppins', 'Roboto', 'Segoe UI', system-ui, sans-serif" },
        body: { value: "'Roboto', 'Segoe UI', system-ui, sans-serif" },
        mono: { value: "'JetBrains Mono', 'Cascadia Code', Consolas, ui-monospace, monospace" },
      },
    },
    semanticTokens: {
      colors: {
        bg: {
          canvas: { value: { _light: '#f5f6f8', _dark: '#111214' } },
          panel: { value: { _light: '#ffffff', _dark: '#1a1b1e' } },
          sidebar: { value: { _light: '#ffffff', _dark: '#16171a' } },
        },
        series: {
          1: { value: { _light: '{colors.blue.600}', _dark: '{colors.blue.400}' } },
          2: { value: { _light: '{colors.teal.600}', _dark: '{colors.teal.400}' } },
          3: { value: { _light: '{colors.purple.600}', _dark: '{colors.purple.400}' } },
        },
        log: {
          V: { value: { _light: '{colors.gray.500}', _dark: '{colors.gray.500}' } },
          D: { value: { _light: '{colors.blue.600}', _dark: '{colors.blue.300}' } },
          I: { value: { _light: '{colors.green.700}', _dark: '{colors.green.300}' } },
          W: { value: { _light: '{colors.orange.600}', _dark: '{colors.orange.300}' } },
          E: { value: { _light: '{colors.red.600}', _dark: '{colors.red.400}' } },
          F: { value: { _light: '{colors.red.700}', _dark: '{colors.red.300}' } },
        },
      },
    },
  },
});

export const system = createSystem(defaultConfig, config);
