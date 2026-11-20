import { useEffect, useRef, useState } from 'react';
import { Box, Breadcrumb, Button, Flex, HStack, IconButton, Stack, Table, Text, chakra } from '@chakra-ui/react';
import { LuArrowUp, LuDownload, LuFile, LuFolder, LuRefreshCw, LuTrash2, LuUpload } from 'react-icons/lu';
import { API, api, dev, fmtBytes, type RemoteFile } from '../../lib/api';
import { Empty, Loading, Notice, useBusy } from '../../components/ui';
import { notify } from '../../components/toaster';

const SHORTCUTS = ['Download', 'DCIM', 'Pictures', 'Documents', 'Movies', 'Android/media'];

export function FilesTab({ serial }: { serial: string }) {
  const [path, setPath] = useState('/sdcard');
  const [data, setData] = useState<{ path: string; parent: string | null; entries: RemoteFile[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const { busy, run } = useBusy();

  const load = async (p = path) => {
    setLoading(true);
    setError(null);
    try {
      const r = await api<{ path: string; parent: string | null; entries: RemoteFile[] }>(dev(serial, `/files?path=${encodeURIComponent(p)}`));
      setData(r);
      setPath(r.path);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    setData(null);
    void load('/sdcard');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serial]);

  const upload = (files: FileList | File[]) =>
    run('upload', async () => {
      for (const f of Array.from(files)) {
        const fd = new FormData();
        fd.append('file', f);
        try {
          const r = await api<{ path: string }>(dev(serial, `/files/upload?dir=${encodeURIComponent(path)}`), { method: 'POST', body: fd });
          notify('ok', `Uploaded to ${r.path}`);
        } catch (e: any) {
          notify('error', `${f.name}: ${e.message}`);
        }
      }
      if (input.current) input.current.value = '';
      await load();
    });

  const remove = (f: RemoteFile) => {
    if (!confirm(`Delete ${f.path} from the device?`)) return;
    void run(`rm:${f.path}`, async () => {
      try {
        await api(dev(serial, `/files?path=${encodeURIComponent(f.path)}`), { method: 'DELETE' });
        await load();
      } catch (e: any) {
        notify('error', e.message);
      }
    });
  };

  const parts = path.split('/').filter(Boolean);

  return (
    <Stack
      gap="3"
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={(e) => e.currentTarget.contains(e.relatedTarget as Node) || setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        if (e.dataTransfer.files.length) void upload(e.dataTransfer.files);
      }}
      borderRadius="md"
      outline={drag ? '2px dashed' : undefined}
      outlineColor="colorPalette.solid"
      outlineOffset="4px"
    >
      <Flex gap="2" align="center" wrap="wrap" justify="space-between">
        <HStack gap="1" minW="0">
          <IconButton size="xs" variant="outline" aria-label="Up one folder" title="Up" disabled={!data?.parent} onClick={() => data?.parent && void load(data.parent)}>
            <LuArrowUp />
          </IconButton>
          <Breadcrumb.Root size="sm">
            <Breadcrumb.List flexWrap="wrap">
              {parts.map((p, i) => {
                const to = '/' + parts.slice(0, i + 1).join('/');
                const lastPart = i === parts.length - 1;
                return (
                  <Breadcrumb.Item key={to}>
                    {lastPart ? (
                      <Breadcrumb.CurrentLink>{p}</Breadcrumb.CurrentLink>
                    ) : i === 0 ? (
                      <Breadcrumb.Link asChild>
                        <chakra.button onClick={() => void load(to)}>{p}</chakra.button>
                      </Breadcrumb.Link>
                    ) : (
                      <Breadcrumb.Link asChild>
                        <chakra.button onClick={() => void load(to)}>{p}</chakra.button>
                      </Breadcrumb.Link>
                    )}
                    {!lastPart && <Breadcrumb.Separator />}
                  </Breadcrumb.Item>
                );
              })}
            </Breadcrumb.List>
          </Breadcrumb.Root>
        </HStack>
        <HStack gap="1.5">
          <input ref={input} type="file" multiple hidden onChange={(e) => e.target.files?.length && void upload(e.target.files)} />
          <Button size="xs" onClick={() => input.current?.click()} loading={busy === 'upload'} loadingText="Uploading…">
            <LuUpload /> Upload here
          </Button>
          <IconButton size="xs" variant="ghost" aria-label="Refresh" onClick={() => void load()} loading={loading}>
            <LuRefreshCw />
          </IconButton>
        </HStack>
      </Flex>

      <HStack gap="1.5" wrap="wrap">
        {SHORTCUTS.map((s) => (
          <Button key={s} size="2xs" variant="outline" borderRadius="full" onClick={() => void load(`/sdcard/${s}`)}>
            {s}
          </Button>
        ))}
      </HStack>

      {error && <Notice tone="error">{error}</Notice>}
      {!data ? (
        <Loading rows={6} height="8" label="Listing files" />
      ) : data.entries.length === 0 ? (
        <Empty icon={<LuFolder />} title="This folder is empty">
          Drop files here to upload them.
        </Empty>
      ) : (
        <Box borderWidth="1px" borderRadius="md" overflow="auto" maxH="calc(100dvh - 380px)" minH="260px" opacity={loading ? 0.6 : 1}>
          <Table.Root size="sm" stickyHeader interactive>
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>Name</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end">Size</Table.ColumnHeader>
                <Table.ColumnHeader display={{ base: 'none', md: 'table-cell' }}>Modified</Table.ColumnHeader>
                <Table.ColumnHeader aria-label="Actions" />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.entries.map((f) => (
                <Table.Row key={f.path}>
                  <Table.Cell maxW="0" w="60%">
                    {f.dir ? (
                      <chakra.button display="flex" alignItems="center" gap="2" onClick={() => void load(f.path)} color="colorPalette.fg" fontWeight="medium" maxW="100%" textAlign="left">
                        <LuFolder />
                        <Text truncate>{f.name}</Text>
                      </chakra.button>
                    ) : (
                      <HStack gap="2" color="fg">
                        <Box color="fg.muted" flexShrink={0}>
                          <LuFile />
                        </Box>
                        <Text truncate title={f.name}>
                          {f.name}
                        </Text>
                      </HStack>
                    )}
                  </Table.Cell>
                  <Table.Cell textAlign="end" whiteSpace="nowrap" className="num">
                    {f.dir ? '' : fmtBytes(f.size)}
                  </Table.Cell>
                  <Table.Cell whiteSpace="nowrap" fontSize="xs" color="fg.muted" display={{ base: 'none', md: 'table-cell' }}>
                    {f.modified ? new Date(f.modified).toLocaleString() : ''}
                  </Table.Cell>
                  <Table.Cell textAlign="end" whiteSpace="nowrap">
                    {!f.dir && (
                      <HStack gap="0.5" justify="flex-end">
                        <IconButton asChild size="xs" variant="ghost" aria-label={`Download ${f.name}`} title="Download">
                          <a href={`${API}${dev(serial, `/files/download?path=${encodeURIComponent(f.path)}`)}`} download>
                            <LuDownload />
                          </a>
                        </IconButton>
                        <IconButton size="xs" variant="ghost" colorPalette="red" aria-label={`Delete ${f.name}`} title="Delete" loading={busy === `rm:${f.path}`} onClick={() => remove(f)}>
                          <LuTrash2 />
                        </IconButton>
                      </HStack>
                    )}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Box>
      )}
      <Text fontSize="xs" color="fg.muted">
        Shared storage only (/sdcard). Folders can be opened but not deleted here.
      </Text>
    </Stack>
  );
}
