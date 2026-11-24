'use client';
import { useState } from 'react';
import { Box, Button, Field, HStack, Input, NativeSelect, SegmentGroup, Stack, Text } from '@chakra-ui/react';
import { LuFolderPlus, LuGithub, LuSearch } from 'react-icons/lu';
import { api } from '../../lib/api';
import { KIND_LABEL, type ComponentKind, type GitInfo } from '../../lib/projects';
import { Badge, Notice } from '../../components/ui';
import { notify } from '../../components/toaster';

interface Detected {
  kind: ComponentKind;
  framework: string | null;
  name: string | null;
  package_name: string | null;
  version: string | null;
  git: GitInfo;
}

const FRAMEWORK: Record<string, string> = { flutter: 'Flutter', android: 'Android (native)', nextjs: 'Next.js', react: 'React', 'react-native': 'React Native', expo: 'Expo', nestjs: 'NestJS', fastify: 'Fastify', express: 'Express', node: 'Node.js', dart: 'Dart package' };
export const frameworkLabel = (f: string | null) => (f ? (FRAMEWORK[f] ?? f) : 'Folder');

/** Add a part to a project: a folder on this PC (detected automatically) or a GitHub repository to clone. */
export function AddPartForm({ projectId, onAdded }: { projectId: string; onAdded: () => void }) {
  const [source, setSource] = useState<'folder' | 'clone'>('folder');
  const [path, setPath] = useState('');
  const [url, setUrl] = useState('');
  const [dest, setDest] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ComponentKind | ''>('');
  const [found, setFound] = useState<Detected | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const detect = async () => {
    setBusy('detect');
    try {
      const d = await api<Detected>('/projects/detect', { method: 'POST', body: JSON.stringify({ path }) });
      setFound(d);
      if (!name && d.name) setName(d.name);
      if (!kind) setKind(d.kind);
    } catch (e: any) {
      setFound(null);
      notify('error', e.message);
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    setBusy('add');
    try {
      if (source === 'folder') {
        await api(`/projects/${projectId}/components`, { method: 'POST', body: JSON.stringify({ path, name: name || undefined, kind: kind || undefined }) });
      } else {
        notify('info', 'Cloning — large repositories can take a few minutes…');
        await api(`/projects/${projectId}/components/clone`, { method: 'POST', body: JSON.stringify({ url, dest, name: name || undefined, kind: kind || undefined }) });
      }
      notify('ok', `${name || 'Part'} added`);
      setPath('');
      setUrl('');
      setDest('');
      setName('');
      setKind('');
      setFound(null);
      onAdded();
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setBusy(null);
    }
  };

  // Suggest a destination folder from the repository name.
  const repoName = url.match(/\/([\w.-]+?)(?:\.git)?\/?$/)?.[1];

  return (
    <Stack gap="3">
      <SegmentGroup.Root size="sm" value={source} onValueChange={(e) => setSource(e.value as 'folder' | 'clone')} aria-label="Source">
        <SegmentGroup.Indicator />
        <SegmentGroup.Items
          items={[
            { value: 'folder', label: <HStack gap="1.5"><LuFolderPlus /> Folder on this PC</HStack> },
            { value: 'clone', label: <HStack gap="1.5"><LuGithub /> Clone from GitHub</HStack> },
          ]}
        />
      </SegmentGroup.Root>

      {source === 'folder' ? (
        <Field.Root required>
          <Field.Label>Project folder</Field.Label>
          <HStack w="100%">
            <Input size="sm" value={path} onChange={(e) => (setPath(e.target.value), setFound(null))} placeholder="M:\dani\vmservice" fontFamily="mono" spellCheck={false} />
            <Button size="sm" variant="outline" onClick={() => void detect()} loading={busy === 'detect'} disabled={path.trim().length < 3}>
              <LuSearch /> Check
            </Button>
          </HStack>
          <Field.HelperText>The folder with pubspec.yaml (Flutter app), package.json (web panel / backend) …</Field.HelperText>
        </Field.Root>
      ) : (
        <>
          <Field.Root required>
            <Field.Label>Repository URL</Field.Label>
            <Input size="sm" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/you/my_app" fontFamily="mono" spellCheck={false} />
          </Field.Root>
          <Field.Root required>
            <Field.Label>Clone into (new folder)</Field.Label>
            <Input size="sm" value={dest} onChange={(e) => setDest(e.target.value)} placeholder={`M:\\projects\\${repoName ?? 'my_app'}`} fontFamily="mono" spellCheck={false} />
            <Field.HelperText>Private repositories: clone once in a terminal or VS Code first so Git remembers your login — or add that folder instead.</Field.HelperText>
          </Field.Root>
        </>
      )}

      {found && (
        <Box borderWidth="1px" borderRadius="md" p="3" bg="bg.subtle">
          <HStack gap="2" wrap="wrap">
            <Badge tone="good">{frameworkLabel(found.framework)}</Badge>
            <Badge tone="neutral">{KIND_LABEL[found.kind]}</Badge>
            {found.version && <Text fontSize="sm">v{found.version}</Text>}
            {found.package_name && (
              <Text fontSize="sm" fontFamily="mono">
                {found.package_name}
              </Text>
            )}
          </HStack>
          <Text fontSize="xs" color="fg.muted" mt="1.5">
            {found.git.repo ? `Git: ${found.git.branch ?? '?'}${found.git.web_url ? ` · ${found.git.web_url}` : found.git.remote ? ` · ${found.git.remote}` : ' · no remote'}` : 'Not a git repository'}
          </Text>
        </Box>
      )}
      {source === 'folder' && !found && path.trim().length > 3 && (
        <Notice tone="info">Press “Check” to see what PlayTest finds in this folder.</Notice>
      )}

      <HStack gap="3" align="flex-end" wrap="wrap">
        <Field.Root flex="1" minW="180px">
          <Field.Label>Name</Field.Label>
          <Input size="sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Mobile app, Admin panel" maxLength={80} />
        </Field.Root>
        <Field.Root w="auto" minW="150px">
          <Field.Label>Kind</Field.Label>
          <NativeSelect.Root size="sm">
            <NativeSelect.Field value={kind} onChange={(e) => setKind(e.target.value as ComponentKind)}>
              <option value="">Detect</option>
              {(Object.keys(KIND_LABEL) as ComponentKind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
        </Field.Root>
        <Button size="sm" onClick={() => void add()} loading={busy === 'add'} disabled={source === 'folder' ? path.trim().length < 3 : url.trim().length < 10 || dest.trim().length < 3}>
          {source === 'folder' ? <LuFolderPlus /> : <LuGithub />} {source === 'folder' ? 'Add folder' : 'Clone & add'}
        </Button>
      </HStack>
    </Stack>
  );
}
