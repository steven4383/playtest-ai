import { useEffect, useState } from 'react';
import NextLink from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, CloseButton, Dialog, Field, HStack, Input, Link, NativeSelect, Portal, Stack, Text } from '@chakra-ui/react';
import { LuPlus } from 'react-icons/lu';
import { api, fmtBytes } from '../../lib/api';
import { qk, useSdkDefinitions, useSdkInstalled, useTools } from '../../lib/queries';
import { Loading, Notice } from '../../components/ui';
import { notify } from '../../components/toaster';

const PREFERRED_HW = ['pixel_8', 'pixel_7', 'pixel_6', 'medium_phone', 'pixel_5'];
const RAM_OPTIONS = [1536, 2048, 3072, 4096];

function Select({ value, onChange, children, disabled }: { value: string; onChange: (v: string) => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <NativeSelect.Root size="sm" disabled={disabled}>
      <NativeSelect.Field value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </NativeSelect.Field>
      <NativeSelect.Indicator />
    </NativeSelect.Root>
  );
}

/** Create an AVD from an installed system image: hardware profile and RAM. */
export function CreateAvdForm({ onCreated }: { onCreated?: (name: string) => void }) {
  const qc = useQueryClient();
  const tools = useTools().data;
  const ready = !!tools?.sdkmanager && !!tools?.avdmanager;
  const installedQ = useSdkInstalled(ready);
  const installed = installedQ.data?.images ?? null;
  const definitions = useSdkDefinitions(ready).data ?? [];
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', package: '', device: '', ram_mb: 2048, create_profile: true });

  useEffect(() => {
    const first = installed?.find((i) => i.host_compatible);
    if (first) setForm((f) => (f.package ? f : { ...f, package: first.package }));
  }, [installed]);
  useEffect(() => {
    if (definitions.length) setForm((f) => (f.device ? f : { ...f, device: PREFERRED_HW.find((h) => definitions.includes(h)) ?? definitions[0] ?? '' }));
  }, [definitions]);

  const suggestName = () => {
    const img = installed?.find((i) => i.package === form.package);
    if (!img || !form.device) return '';
    const hw = form.device.replace(/[^\w]+/g, '_').replace(/^_|_$/g, '');
    return `PT_${hw.charAt(0).toUpperCase()}${hw.slice(1)}_API_${img.api_level ?? img.api_id.replace('android-', '')}`;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = form.name.trim() || suggestName();
    if (!name) return notify('warning', 'Enter an AVD name');
    setBusy(true);
    try {
      await api('/sdk/avds', { method: 'POST', body: JSON.stringify({ ...form, name }) });
      notify('info', `Creating ${name}… it appears under Installed AVDs in a few seconds.`);
      setForm((f) => ({ ...f, name: '' }));
      void qc.invalidateQueries({ queryKey: qk.sdkJobs });
      onCreated?.(name);
    } catch (err: any) {
      notify('error', err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!tools) return <Loading rows={3} height="8" />;
  if (!ready)
    return (
      <Notice tone="warning" title="Android SDK Command-line Tools not found">
        In Android Studio open Settings → Languages & Frameworks → Android SDK → SDK Tools, tick “Android SDK Command-line Tools (latest)” and apply.
      </Notice>
    );
  if (installed === null) return <Loading rows={3} height="8" />;
  if (!installed.length)
    return (
      <Notice tone="info" title="No system image installed yet">
        Download one first under{' '}
        <Link asChild color="colorPalette.fg"><NextLink href="/devices">
          Device Manager → System images
        </NextLink></Link>{' '}
        (Google APIs, x86_64, API 33–35 recommended).
      </Notice>
    );

  const img = installed.find((i) => i.package === form.package);
  return (
    <form onSubmit={submit}>
      <Stack gap="3">
        <Field.Root required>
          <Field.Label>System image</Field.Label>
          <Select value={form.package} onChange={(v) => setForm({ ...form, package: v })}>
            {installed.map((i) => (
              <option key={i.package} value={i.package} disabled={!i.host_compatible}>
                Android {i.android_version ?? '?'} (API {i.api_level ?? i.api_id}) · {i.tag_label} · {i.abi}
              </option>
            ))}
          </Select>
        </Field.Root>
        <Field.Root required>
          <Field.Label>Hardware profile</Field.Label>
          <Select value={form.device} onChange={(v) => setForm({ ...form, device: v })} disabled={!definitions.length}>
            {definitions.length === 0 && <option value="">Loading…</option>}
            {definitions.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
        </Field.Root>
        <Field.Root>
          <Field.Label>RAM</Field.Label>
          <Select value={String(form.ram_mb)} onChange={(v) => setForm({ ...form, ram_mb: Number(v) })}>
            {RAM_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {r >= 2048 ? `${r / 1024} GB` : `${r} MB`}
                {r === 2048 ? ' (recommended)' : r === 1536 ? ' (saves PC RAM)' : ''}
              </option>
            ))}
          </Select>
          <Field.HelperText>Taken from your PC's RAM while it runs — 1.5 GB is enough for most apps and leaves more for the PC.</Field.HelperText>
        </Field.Root>
        <Field.Root>
          <Field.Label>AVD name</Field.Label>
          <HStack w="100%">
            <Input size="sm" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={suggestName() || 'PT_Pixel_8_API_35'} pattern="[\w.\-]+" />
            <Button size="sm" variant="outline" type="button" onClick={() => setForm({ ...form, name: suggestName() })} disabled={!suggestName()}>
              Suggest
            </Button>
          </HStack>
          <Field.HelperText>Letters, digits, _ . - only. Empty = the suggestion.</Field.HelperText>
        </Field.Root>
        <Checkbox.Root size="sm" checked={form.create_profile} onCheckedChange={(e) => setForm({ ...form, create_profile: !!e.checked })}>
          <Checkbox.HiddenInput />
          <Checkbox.Control />
          <Checkbox.Label>Also add a device profile (so it can be started and tested here)</Checkbox.Label>
        </Checkbox.Root>
        <Text fontSize="xs" color="fg.muted">
          Uses the installed image{img?.disk_bytes ? ` (${fmtBytes(img.disk_bytes)})` : ''} — no download. A new AVD takes ~1–3 GB at first and grows with apps; the first start
          also saves a fast-boot snapshot (~1–4 GB). Wipe data under Installed AVDs gives that space back.
        </Text>
        <Button type="submit" size="sm" alignSelf="flex-start" loading={busy} disabled={!form.package || !form.device}>
          <LuPlus /> Create AVD
        </Button>
      </Stack>
    </form>
  );
}

export function CreateAvdDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={(e) => !e.open && onClose()} size="md" placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title fontFamily="heading">New emulator (AVD)</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body pb="5">{open && <CreateAvdForm onCreated={onClose} />}</Dialog.Body>
            <Dialog.CloseTrigger asChild>
              <CloseButton size="sm" />
            </Dialog.CloseTrigger>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
