import { Portal, Stack, Toast, Toaster as ChakraToaster, createToaster } from '@chakra-ui/react';

export const toaster = createToaster({ placement: 'bottom-end', pauseOnPageIdle: true, max: 4 });

/** Short status message in the corner (replaces the old page banners). */
export function notify(tone: 'ok' | 'error' | 'info' | 'warning', text: string, title?: string) {
  toaster.create({
    title,
    description: text,
    type: tone === 'ok' ? 'success' : tone,
    duration: tone === 'error' ? 8000 : 5000,
    closable: true,
  });
}

export function Toaster() {
  return (
    <Portal>
      <ChakraToaster toaster={toaster} insetInline={{ mdDown: '4' }}>
        {(toast) => (
          <Toast.Root width={{ md: 'sm' }}>
            <Toast.Indicator />
            <Stack gap="1" flex="1" maxWidth="100%">
              {toast.title && <Toast.Title>{toast.title}</Toast.Title>}
              {toast.description && <Toast.Description>{toast.description}</Toast.Description>}
            </Stack>
            {toast.closable && <Toast.CloseTrigger />}
          </Toast.Root>
        )}
      </ChakraToaster>
    </Portal>
  );
}
