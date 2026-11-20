'use client';
import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { qk, useApks } from '../lib/queries';
import { Box, Center, Code, IconButton, Spinner, Stack, Table, Text, VStack } from '@chakra-ui/react';
import { LuHistory, LuPackage, LuTrash2, LuUpload } from 'react-icons/lu';
import { api, fmtBytes, type Apk } from '../lib/api';
import { Badge, Card, Empty, Loading } from '../components/ui';
import { notify } from '../components/toaster';

export function ApksPage() {
  const qc = useQueryClient();
  const apksQ = useApks();
  const apks = apksQ.data ?? (apksQ.isError ? [] : null);
  const [uploading, setUploading] = useState(false);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = () => qc.invalidateQueries({ queryKey: qk.apks });

  const upload = async (file: File) => {
    setUploading(true);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const apk = await api<Apk>('/apks/upload', { method: 'POST', body: fd });
      notify('ok', `${apk.filename} uploaded${apk.package_name ? ` — ${apk.package_name} ${apk.version_name ?? ''}` : ''}${apk.duplicate_of ? ' (same checksum as an earlier upload)' : ''}`);
      await load();
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  };

  const remove = async (a: Apk) => {
    if (!confirm(`Delete ${a.filename}?`)) return;
    try {
      await api(`/apks/${a.id}`, { method: 'DELETE' });
      await load();
    } catch (e: any) {
      notify('error', e.message);
    }
  };

  return (
    <Stack gap="5">
      <Card icon={<LuUpload />} title="Upload APK" subtitle="Validated, SHA-256 hashed and stored outside the web root. Metadata is read with aapt2 from the Android SDK build-tools.">
        <Center
          role="button"
          tabIndex={0}
          minH="36"
          borderWidth="2px"
          borderStyle="dashed"
          borderRadius="lg"
          borderColor={drag ? 'colorPalette.solid' : 'border'}
          bg={drag ? 'colorPalette.subtle' : 'bg.subtle'}
          cursor={uploading ? 'progress' : 'pointer'}
          transition="all 0.15s"
          _hover={{ borderColor: 'colorPalette.muted' }}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            const f = e.dataTransfer.files[0];
            if (f && !uploading) void upload(f);
          }}
          onClick={() => !uploading && input.current?.click()}
          onKeyDown={(e) => e.key === 'Enter' && input.current?.click()}
        >
          <input ref={input} type="file" accept=".apk" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          <VStack gap="2" color="fg.muted">
            {uploading ? <Spinner size="lg" color="colorPalette.solid" /> : <LuPackage size={30} />}
            <Text fontWeight="medium" color="fg">
              {uploading ? 'Uploading and inspecting…' : 'Drop an .apk here or click to choose'}
            </Text>
            <Text fontSize="xs">Tip: on the Developer page you can drop an APK straight onto a device to install and open it.</Text>
          </VStack>
        </Center>
      </Card>

      <Card icon={<LuHistory />} title="Build history" subtitle={apks ? `${apks.length} build${apks.length === 1 ? '' : 's'}` : 'Loading…'}>
        {!apks ? (
          <Loading rows={4} height="8" />
        ) : apks.length === 0 ? (
          <Empty icon={<LuPackage />} title="No APKs uploaded yet">
            Upload a build above to test it on devices.
          </Empty>
        ) : (
          <Box overflowX="auto">
            <Table.Root size="sm" interactive>
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>File</Table.ColumnHeader>
                  <Table.ColumnHeader>Package</Table.ColumnHeader>
                  <Table.ColumnHeader>Version</Table.ColumnHeader>
                  <Table.ColumnHeader>SDK (min / target)</Table.ColumnHeader>
                  <Table.ColumnHeader textAlign="end">Size</Table.ColumnHeader>
                  <Table.ColumnHeader>SHA-256</Table.ColumnHeader>
                  <Table.ColumnHeader>Uploaded</Table.ColumnHeader>
                  <Table.ColumnHeader aria-label="Actions" />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {apks.map((a) => (
                  <Table.Row key={a.id}>
                    <Table.Cell fontWeight="medium">{a.filename}</Table.Cell>
                    <Table.Cell>{a.package_name ? <Code size="sm">{a.package_name}</Code> : <Badge tone="warning">needs aapt2</Badge>}</Table.Cell>
                    <Table.Cell>{a.version_name ? `${a.version_name} (${a.version_code})` : '—'}</Table.Cell>
                    <Table.Cell>{a.min_sdk ? `${a.min_sdk} / ${a.target_sdk ?? '—'}` : '—'}</Table.Cell>
                    <Table.Cell textAlign="end">{fmtBytes(a.size_bytes)}</Table.Cell>
                    <Table.Cell fontFamily="mono" fontSize="xs" title={a.sha256}>
                      {a.sha256.slice(0, 12)}…
                    </Table.Cell>
                    <Table.Cell fontSize="xs" whiteSpace="nowrap">
                      {new Date(a.created_at.replace(' ', 'T') + 'Z').toLocaleString()}
                    </Table.Cell>
                    <Table.Cell textAlign="end">
                      <IconButton size="xs" variant="ghost" colorPalette="red" aria-label={`Delete ${a.filename}`} onClick={() => void remove(a)}>
                        <LuTrash2 />
                      </IconButton>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Box>
        )}
      </Card>
    </Stack>
  );
}
