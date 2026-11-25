'use client';
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge as CBadge, Box, Button, Field, Flex, HStack, Image, Input, Link, NativeSelect, SegmentGroup, Stack, Text, chakra } from '@chakra-ui/react';
import { LuExternalLink, LuFolderPlus, LuGithub, LuLink, LuLock, LuSearch } from 'react-icons/lu';
import { api } from '../../lib/api';
import { ago, KIND_LABEL, type ComponentKind, type GitInfo } from '../../lib/projects';
import { Badge, Notice } from '../../components/ui';
import { FolderInput } from '../../components/FolderPicker';
import { notify } from '../../components/toaster';

interface Detected {
  kind: ComponentKind;
  framework: string | null;
  name: string | null;
  package_name: string | null;
  version: string | null;
  git: GitInfo;
}
interface GithubStatus {
  connected: boolean;
  login: string | null;
  name: string | null;
  avatar_url: string | null;
  projects_dir: string;
  error?: string;
}
interface Repo {
  full_name: string;
  name: string;
  private: boolean;
  description: string | null;
  language: string | null;
  updated_at: string;
  clone_url: string;
  html_url: string;
  fork: boolean;
}

const FRAMEWORK: Record<string, string> = { flutter: 'Flutter', android: 'Android (native)', nextjs: 'Next.js', react: 'React', 'react-native': 'React Native', expo: 'Expo', nestjs: 'NestJS', fastify: 'Fastify', express: 'Express', node: 'Node.js', dart: 'Dart package' };
export const frameworkLabel = (f: string | null) => (f ? (FRAMEWORK[f] ?? f) : 'Folder');
const join = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, '')}${dir.includes('/') && !dir.includes('\\') ? '/' : '\\'}${name}`;

/** Connect GitHub once (token stays on this PC), then pick repositories from a list. */
function GithubRepos({ status, onPick, picked }: { status: GithubStatus; onPick: (r: Repo) => void; picked: Repo | null }) {
  const qc = useQueryClient();
  const [token, setToken] = useState('');
  const [user, setUser] = useState('');
  const [publicUser, setPublicUser] = useState('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const repos = useQuery({
    queryKey: ['github', 'repos', status.connected ? '@me' : publicUser],
    enabled: status.connected || !!publicUser,
    retry: false,
    staleTime: 5 * 60_000,
    queryFn: () => api<{ repos: Repo[] }>(`/github/repos${!status.connected && publicUser ? `?user=${encodeURIComponent(publicUser)}` : ''}`).then((r) => r.repos),
  });
  const list = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (repos.data ?? []).filter((r) => !s || `${r.full_name} ${r.description ?? ''}`.toLowerCase().includes(s));
  }, [repos.data, search]);

  const connect = async () => {
    setBusy(true);
    try {
      await api('/github/token', { method: 'PUT', body: JSON.stringify({ token }) });
      setToken('');
      notify('ok', 'GitHub connected');
      await qc.invalidateQueries({ queryKey: ['github'] });
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    if (!confirm('Disconnect GitHub? The token is removed from this PC.')) return;
    await api('/github/token', { method: 'DELETE' }).catch((e) => notify('error', e.message));
    await qc.invalidateQueries({ queryKey: ['github'] });
  };

  return (
    <Stack gap="3">
      {status.connected ? (
        <HStack gap="2" justify="space-between" borderWidth="1px" borderRadius="md" px="3" py="2">
          <HStack gap="2">
            {status.avatar_url && <Image src={status.avatar_url} alt="" w="6" h="6" borderRadius="full" />}
            <Text fontSize="sm">
              Connected as <b>{status.login}</b>
            </Text>
          </HStack>
          <Button size="2xs" variant="ghost" onClick={() => void disconnect()}>
            Disconnect
          </Button>
        </HStack>
      ) : (
        <Box borderWidth="1px" borderRadius="md" p="3">
          <Text fontSize="sm" fontWeight="medium">
            Connect GitHub (once)
          </Text>
          <Text fontSize="xs" color="fg.muted" mt="1">
            Create a{' '}
            <Link href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer" color="colorPalette.fg">
              fine-grained token <LuExternalLink />
            </Link>{' '}
            → Repository access: <i>All repositories</i> → Permissions: <i>Contents</i> and <i>Metadata</i> = Read-only (Read and write if releases should push tags). It
            stays in PlayTest&apos;s .env on this PC and is never shown again.
          </Text>
          <HStack mt="2" gap="2">
            <Input size="sm" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_…" fontFamily="mono" autoComplete="off" />
            <Button size="sm" onClick={() => void connect()} loading={busy} disabled={token.trim().length < 20}>
              <LuGithub /> Connect
            </Button>
          </HStack>
          {status.error && (
            <Text fontSize="xs" color="fg.error" mt="1">
              {status.error}
            </Text>
          )}
          <HStack mt="3" gap="2">
            <Text fontSize="xs" color="fg.muted" flexShrink={0}>
              Or public repos of
            </Text>
            <Input size="xs" value={user} onChange={(e) => setUser(e.target.value)} placeholder="github username" maxW="200px" />
            <Button size="xs" variant="outline" onClick={() => setPublicUser(user.trim())} disabled={!user.trim()}>
              List
            </Button>
          </HStack>
        </Box>
      )}

      {(status.connected || publicUser) && (
        <>
          <HStack gap="2" borderWidth="1px" borderRadius="md" px="2">
            <Box color="fg.muted">
              <LuSearch />
            </Box>
            <Input size="sm" border="none" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${repos.data?.length ?? ''} repositories`} />
          </HStack>
          <Stack gap="0" maxH="260px" overflowY="auto" borderWidth="1px" borderRadius="md">
            {repos.isFetching && !repos.data ? (
              <Text p="3" fontSize="sm" color="fg.muted">
                Loading repositories…
              </Text>
            ) : repos.isError ? (
              <Text p="3" fontSize="sm" color="fg.error">
                {repos.error.message}
              </Text>
            ) : list.length === 0 ? (
              <Text p="3" fontSize="sm" color="fg.muted">
                No repository matches.
              </Text>
            ) : (
              list.map((r) => (
                <chakra.button
                  key={r.full_name}
                  onClick={() => onPick(r)}
                  textAlign="left"
                  px="3"
                  py="2"
                  borderBottomWidth="1px"
                  bg={picked?.full_name === r.full_name ? 'colorPalette.subtle' : 'transparent'}
                  _hover={{ bg: picked?.full_name === r.full_name ? 'colorPalette.subtle' : 'bg.muted' }}
                >
                  <HStack gap="2">
                    <Text fontSize="sm" fontWeight="medium" truncate>
                      {r.full_name}
                    </Text>
                    {r.private && (
                      <CBadge size="xs" variant="outline" gap="1">
                        <LuLock /> private
                      </CBadge>
                    )}
                    {r.fork && <CBadge size="xs" variant="outline">fork</CBadge>}
                    <Text fontSize="2xs" color="fg.muted" ms="auto" flexShrink={0}>
                      {r.language ?? ''} · {ago(r.updated_at)}
                    </Text>
                  </HStack>
                  {r.description && (
                    <Text fontSize="xs" color="fg.muted" truncate>
                      {r.description}
                    </Text>
                  )}
                </chakra.button>
              ))
            )}
          </Stack>
        </>
      )}
    </Stack>
  );
}

/** Add a part to a project: a folder on this PC, one of your GitHub repositories, or any repository URL. */
export function AddPartForm({ projectId, onAdded }: { projectId: string; onAdded: () => void }) {
  const [source, setSource] = useState<'folder' | 'github' | 'url'>('folder');
  const [path, setPath] = useState('');
  const [url, setUrl] = useState('');
  const [dest, setDest] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ComponentKind | ''>('');
  const [found, setFound] = useState<Detected | null>(null);
  const [repo, setRepo] = useState<Repo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const gh = useQuery({ queryKey: ['github', 'status'], staleTime: 60_000, queryFn: () => api<GithubStatus>('/github/status') });

  // Check a folder as soon as one is chosen.
  useEffect(() => {
    if (source !== 'folder' || path.trim().length < 3) return void setFound(null);
    const t = setTimeout(async () => {
      try {
        const d = await api<Detected>('/projects/detect', { method: 'POST', body: JSON.stringify({ path }) });
        setFound(d);
        setName((n) => n || d.name || '');
      } catch {
        setFound(null);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [path, source]);

  // Picking a repository suggests the destination: <projects folder>\<repo name>.
  const pickRepo = (r: Repo) => {
    setRepo(r);
    setName((n) => n || r.name);
    if (gh.data) setDest(join(gh.data.projects_dir, r.name));
  };
  const repoName = url.match(/\/([\w.-]+?)(?:\.git)?\/?$/)?.[1];
  useEffect(() => {
    if (source === 'url' && repoName && gh.data && !dest) setDest(join(gh.data.projects_dir, repoName));
  }, [source, repoName, gh.data, dest]);

  const reset = () => {
    setPath('');
    setUrl('');
    setDest('');
    setName('');
    setKind('');
    setFound(null);
    setRepo(null);
  };
  const add = async () => {
    setBusy('add');
    try {
      if (source === 'folder') {
        await api(`/projects/${projectId}/components`, { method: 'POST', body: JSON.stringify({ path, name: name || undefined, kind: kind || undefined }) });
      } else {
        notify('info', 'Cloning — large repositories can take a few minutes…');
        const cloneUrl = source === 'github' ? repo!.clone_url : url;
        await api(`/projects/${projectId}/components/clone`, { method: 'POST', body: JSON.stringify({ url: cloneUrl, dest, name: name || undefined, kind: kind || undefined }) });
      }
      notify('ok', `${name || 'Part'} added`);
      reset();
      onAdded();
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setBusy(null);
    }
  };
  const ready = source === 'folder' ? path.trim().length >= 3 : source === 'github' ? !!repo && dest.trim().length >= 3 : url.trim().length >= 10 && dest.trim().length >= 3;

  return (
    <Stack gap="3">
      <SegmentGroup.Root size="sm" value={source} onValueChange={(e) => (setSource(e.value as typeof source), setFound(null))} aria-label="Source">
        <SegmentGroup.Indicator />
        <SegmentGroup.Items
          items={[
            { value: 'folder', label: <HStack gap="1.5"><LuFolderPlus /> Folder on this PC</HStack> },
            { value: 'github', label: <HStack gap="1.5"><LuGithub /> My GitHub repos</HStack> },
            { value: 'url', label: <HStack gap="1.5"><LuLink /> Clone by URL</HStack> },
          ]}
        />
      </SegmentGroup.Root>

      {source === 'folder' && (
        <Field.Root required>
          <Field.Label>Project folder</Field.Label>
          <FolderInput value={path} onChange={setPath} placeholder="M:\dani\vmservice" title="Choose the project folder" />
          <Field.HelperText>The folder with pubspec.yaml (Flutter app) or package.json (web panel / backend).</Field.HelperText>
        </Field.Root>
      )}
      {source === 'github' && gh.data && <GithubRepos status={gh.data} onPick={pickRepo} picked={repo} />}
      {source === 'url' && (
        <Field.Root required>
          <Field.Label>Repository URL</Field.Label>
          <Input size="sm" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/you/my_app" fontFamily="mono" spellCheck={false} />
        </Field.Root>
      )}
      {source !== 'folder' && (source === 'url' || repo) && (
        <Field.Root required>
          <Field.Label>Clone into (new folder)</Field.Label>
          <FolderInput value={dest} onChange={setDest} placeholder={gh.data ? join(gh.data.projects_dir, 'my_app') : 'M:\\projects\\my_app'} title="Where should the repository go?" />
          <Field.HelperText>Pick a parent folder with Browse…, then keep the repository name at the end.</Field.HelperText>
        </Field.Root>
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
      {source === 'folder' && !found && path.trim().length > 3 && <Notice tone="info">Checking the folder…</Notice>}

      <Flex gap="3" align="flex-end" wrap="wrap">
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
        <Button size="sm" onClick={() => void add()} loading={busy === 'add'} disabled={!ready}>
          {source === 'folder' ? <LuFolderPlus /> : <LuGithub />} {source === 'folder' ? 'Add folder' : 'Clone & add'}
        </Button>
      </Flex>
    </Stack>
  );
}
