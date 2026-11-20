import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '../../lib/queries';
import {
  Badge as CBadge,
  Box,
  Button,
  CloseButton,
  Code,
  Collapsible,
  Drawer,
  Flex,
  HStack,
  Link,
  Portal,
  SimpleGrid,
  Stack,
  Table,
  Text,
} from '@chakra-ui/react';
import { LuChevronDown, LuCircleAlert, LuCircleCheck, LuCircleX, LuExternalLink, LuInfo, LuRefreshCw, LuStethoscope } from 'react-icons/lu';
import { api, fmtBytes } from '../../lib/api';
import { Badge, Card, CopyButton, Empty, Kv, Notice, Spinning, SubHeading } from '../../components/ui';
import { MermaidView } from './MermaidView';

// ---------------------------------------------------------------- types (mirror backend/src/automation/flutter-insights.ts)

export interface ScreenDetail {
  id: string;
  file: string;
  abs_path: string;
  lines: number | null;
  kind: string | null;
  route: string | null;
  route_params: string[];
  ctor_params: { name: string; required: boolean }[];
  widgets: string[];
  private_widgets: string[];
  state: { name: string; via: string }[];
  dialogs: number;
  snackbars: number;
}
export interface StateMapData {
  state: { id: string; name: string; kind: string; file: string; used_by: string[] }[];
  data: { id: string; name: string; kind: string; file: string; used_by: string[] }[];
  edges: { from: string; to: string; kind: string }[];
  unused_state: string[];
  mermaid: string;
}
export interface Insights {
  assets: {
    declared_entries: string[];
    files: { path: string; size: number; used: 'used' | 'maybe' | 'unused' }[];
    total_bytes: number;
    missing_declared: string[];
    missing_referenced: string[];
    referenced_not_declared: string[];
    uses_flutter_gen: boolean;
  };
  l10n: { dir: string; template: string; locales: { locale: string; keys: number; missing: string[] }[] } | null;
  hardcoded_strings: { total: number; files: { file: string; count: number }[] };
  todos: { file: string; line: number; text: string }[];
  biggest_files: { file: string; lines: number }[];
}
export interface CheckItem {
  id: string;
  group: 'App' | 'Android' | 'iOS' | 'Code';
  label: string;
  status: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
  fix?: string;
}

const vscode = (abs: string, line?: number) => `vscode://file/${abs.replace(/\\/g, '/')}${line ? `:${line}` : ''}`;
const STATUS_ICON = {
  ok: <Box color="fg.success"><LuCircleCheck /></Box>,
  warn: <Box color="fg.warning"><LuCircleAlert /></Box>,
  fail: <Box color="fg.error"><LuCircleX /></Box>,
  info: <Box color="fg.muted"><LuInfo /></Box>,
} as const;

function Chips({ items, mono = true, palette = 'gray' }: { items: string[]; mono?: boolean; palette?: string }) {
  if (!items.length) return <Text fontSize="sm" color="fg.subtle">None</Text>;
  return (
    <HStack gap="1" wrap="wrap">
      {items.map((i) => (
        <CBadge key={i} size="sm" variant="subtle" colorPalette={palette} fontFamily={mono ? 'mono' : undefined}>
          {i}
        </CBadge>
      ))}
    </HStack>
  );
}

// ---------------------------------------------------------------- screen details drawer

export function ScreenDrawer({
  screen,
  label,
  outgoing,
  incoming,
  onClose,
  onOpen,
}: {
  screen: ScreenDetail | null;
  label: (id: string) => string;
  outgoing: { to: string; kind: string }[];
  incoming: { from: string; kind: string }[];
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  return (
    <Drawer.Root open={!!screen} onOpenChange={(e) => !e.open && onClose()} size="md">
      <Portal>
        <Drawer.Backdrop />
        <Drawer.Positioner>
          <Drawer.Content>
            {screen && (
              <>
                <Drawer.Header>
                  <Stack gap="1">
                    <Drawer.Title fontFamily="heading">{label(screen.id)}</Drawer.Title>
                    <HStack gap="2" wrap="wrap">
                      <Code size="sm">{screen.id}</Code>
                      {screen.kind && <CBadge size="sm">{screen.kind}</CBadge>}
                    </HStack>
                  </Stack>
                </Drawer.Header>
                <Drawer.Body>
                  <Stack gap="5">
                    <Kv
                      items={[
                        ['File', <HStack gap="1"><Text fontFamily="mono" fontSize="xs" wordBreak="break-all">{screen.file}</Text><CopyButton value={screen.file} /></HStack>],
                        ['Size', screen.lines ? `${screen.lines} lines` : '—'],
                        ['Route', screen.route ? <Code size="sm">{screen.route}</Code> : 'Not in the route table (opened with Navigator.push)'],
                        ['Route params', screen.route_params.length ? screen.route_params.join(', ') : '—'],
                        ['Constructor', screen.ctor_params.length ? screen.ctor_params.map((p) => `${p.name}${p.required ? '' : '?'}`).join(', ') : 'no parameters'],
                        ['Dialogs / snackbars', `${screen.dialogs} / ${screen.snackbars}`],
                      ]}
                    />
                    <Button asChild size="sm" variant="outline" alignSelf="flex-start">
                      <a href={vscode(screen.abs_path)}>
                        <LuExternalLink /> Open in VS Code
                      </a>
                    </Button>
                    <Stack gap="2">
                      <SubHeading>State it reads</SubHeading>
                      <Chips items={screen.state.map((s) => s.name)} palette="purple" />
                    </Stack>
                    <Stack gap="2">
                      <SubHeading>Widgets it uses</SubHeading>
                      <Chips items={screen.widgets} palette="blue" />
                      {screen.private_widgets.length > 0 && (
                        <Text fontSize="xs" color="fg.muted">
                          Private widgets in the same file: {screen.private_widgets.join(', ')}
                        </Text>
                      )}
                    </Stack>
                    <Stack gap="2">
                      <SubHeading>Navigates to</SubHeading>
                      {outgoing.length === 0 ? (
                        <Text fontSize="sm" color="fg.subtle">Nowhere (a leaf screen)</Text>
                      ) : (
                        <HStack gap="1.5" wrap="wrap">
                          {outgoing.map((e) => (
                            <Button key={e.to} size="2xs" variant="outline" onClick={() => onOpen(e.to)}>
                              {label(e.to)} <Text as="span" color="fg.muted">· {e.kind}</Text>
                            </Button>
                          ))}
                        </HStack>
                      )}
                    </Stack>
                    <Stack gap="2">
                      <SubHeading>Opened from</SubHeading>
                      {incoming.length === 0 ? (
                        <Text fontSize="sm" color="fg.subtle">No detected way in (entry screen, tab, or dynamic route)</Text>
                      ) : (
                        <HStack gap="1.5" wrap="wrap">
                          {incoming.map((e) => (
                            <Button key={e.from} size="2xs" variant="outline" onClick={() => onOpen(e.from)}>
                              {label(e.from)} <Text as="span" color="fg.muted">· {e.kind}</Text>
                            </Button>
                          ))}
                        </HStack>
                      )}
                    </Stack>
                  </Stack>
                </Drawer.Body>
                <Drawer.CloseTrigger asChild>
                  <CloseButton size="sm" />
                </Drawer.CloseTrigger>
              </>
            )}
          </Drawer.Content>
        </Drawer.Positioner>
      </Portal>
    </Drawer.Root>
  );
}

// ---------------------------------------------------------------- state & data

export function StatePanel({ map, projectName, onScreen }: { map: StateMapData; projectName: string; onScreen: (id: string) => void }) {
  if (!map.state.length)
    return (
      <Empty title="No state management found">
        Looked for Riverpod providers (incl. @riverpod), Blocs/Cubits, ChangeNotifiers, GetX controllers and *Repository / *Service classes.
      </Empty>
    );
  return (
    <Stack gap="4">
      <Card title="State & data map" subtitle={`${map.state.length} state holders · ${map.data.length} repositories/services · screens on the left, data on the right`} actions={<CopyButton value={map.mermaid} label="Copy Mermaid" />}>
        <MermaidView code={map.mermaid} title={`State & data — ${projectName}`} fileName={`${projectName}-state`} onNodeClick={(id) => id.startsWith('s_') && onScreen(id.slice(2))} />
        <Text fontSize="xs" color="fg.muted">
          Blue = screens, purple = state (providers, blocs, controllers), green = repositories and services; arrows point from the reader to what it reads. A provider and the controller it creates share one box. Provider-to-provider links are in the table below. Click a screen to see its details.
        </Text>
        {map.unused_state.length > 0 && <Notice tone="warning" title="Never referenced">{map.unused_state.join(', ')} — possibly dead code.</Notice>}
      </Card>
      <SimpleGrid columns={{ base: 1, '2xl': 2 }} gap="4" alignItems="start">
        <Card title="State holders">
          <Box overflowX="auto">
            <Table.Root size="sm" tableLayout="fixed" minW="520px">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader w="38%">Name</Table.ColumnHeader>
                  <Table.ColumnHeader w="24%">Kind</Table.ColumnHeader>
                  <Table.ColumnHeader>Used by screens</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {map.state.map((s) => (
                  <Table.Row key={s.id} verticalAlign="top">
                    <Table.Cell fontFamily="mono" fontSize="xs" title={s.file} wordBreak="break-all">{s.name}</Table.Cell>
                    <Table.Cell fontSize="xs" wordBreak="break-word">{s.kind.replace('.autoDispose', ' (autoDispose)')}</Table.Cell>
                    <Table.Cell fontSize="xs" wordBreak="break-word">{s.used_by.length ? s.used_by.map((x) => x.replace(/(Screen|Page|View)$/, '')).join(', ') : <Text as="span" color="fg.subtle">—</Text>}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Box>
        </Card>
        <Card title="Repositories & services">
          {map.data.length === 0 ? (
            <Text fontSize="sm" color="fg.muted">No *Repository / *Service / *Api classes found.</Text>
          ) : (
            <Stack gap="2">
              {map.data.map((d) => (
                <Flex key={d.id} justify="space-between" gap="2" borderWidth="1px" borderRadius="md" px="3" py="2" wrap="wrap">
                  <Box minW="0">
                    <Text fontFamily="mono" fontSize="sm">{d.name}</Text>
                    <Text fontSize="xs" color="fg.muted" truncate>{d.file}</Text>
                  </Box>
                  <CBadge size="sm" alignSelf="center">{d.kind}</CBadge>
                </Flex>
              ))}
            </Stack>
          )}
        </Card>
      </SimpleGrid>
    </Stack>
  );
}

// ---------------------------------------------------------------- assets & strings

export function AssetsPanel({ i, projectPath }: { i: Insights; projectPath: string }) {
  const a = i.assets;
  const unused = a.files.filter((f) => f.used === 'unused');
  const [todosOpen, setTodosOpen] = useState(false);
  return (
    <Stack gap="4">
      <Card title="Assets" subtitle={`${a.files.length} files declared in pubspec.yaml · ${fmtBytes(a.total_bytes)}`}>
        {(a.missing_declared.length > 0 || a.missing_referenced.length > 0) && (
          <Notice tone="error" title="Missing assets (crash or blank image at runtime)">
            {[...a.missing_declared.map((x) => `${x} (declared, not on disk)`), ...a.missing_referenced.map((x) => `${x} (used in code, file not found)`)].join(' · ')}
          </Notice>
        )}
        {a.referenced_not_declared.length > 0 && (
          <Notice tone="warning" title="Used in code but not declared in pubspec.yaml">
            {a.referenced_not_declared.join(', ')} — add them under flutter: assets:
          </Notice>
        )}
        {a.files.length === 0 ? (
          <Text fontSize="sm" color="fg.muted">No assets declared.</Text>
        ) : (
          <Box overflowX="auto" maxH="360px" overflowY="auto" borderWidth="1px" borderRadius="md">
            <Table.Root size="sm" stickyHeader>
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>File</Table.ColumnHeader>
                  <Table.ColumnHeader textAlign="end">Size</Table.ColumnHeader>
                  <Table.ColumnHeader>In code</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {a.files.map((f) => (
                  <Table.Row key={f.path}>
                    <Table.Cell fontFamily="mono" fontSize="xs" wordBreak="break-all">{f.path}</Table.Cell>
                    <Table.Cell textAlign="end" whiteSpace="nowrap">{fmtBytes(f.size)}</Table.Cell>
                    <Table.Cell>
                      {f.used === 'used' ? <Badge tone="good">used</Badge> : f.used === 'maybe' ? <Badge tone="neutral">name found</Badge> : <Badge tone="warning">not found</Badge>}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Box>
        )}
        <Text fontSize="xs" color="fg.muted">
          “not found” = neither the path nor the file name appears in your Dart code or pubspec — likely unused and shipping in the APK for nothing
          {unused.length ? ` (${unused.length} file${unused.length === 1 ? '' : 's'}, ${fmtBytes(unused.reduce((s, f) => s + f.size, 0))})` : ''}.
          {a.uses_flutter_gen && ' flutter_gen is used, so assets referenced as Assets.x.y may show as “not found”.'}
        </Text>
      </Card>

      <SimpleGrid columns={{ base: 1, xl: 2 }} gap="4">
        <Card title="Strings & localization">
          {i.l10n ? (
            <Stack gap="2">
              <Text fontSize="sm">
                ARB files in <Code size="sm">{i.l10n.dir}</Code>, template <Code size="sm">{i.l10n.template}</Code>
              </Text>
              {i.l10n.locales.map((l) => (
                <Flex key={l.locale} justify="space-between" fontSize="sm" gap="2">
                  <Text fontWeight="medium">{l.locale}</Text>
                  <Text color={l.missing.length ? 'fg.warning' : 'fg.muted'}>
                    {l.keys} keys{l.missing.length ? ` · ${l.missing.length} missing (${l.missing.slice(0, 4).join(', ')}${l.missing.length > 4 ? '…' : ''})` : ' · complete'}
                  </Text>
                </Flex>
              ))}
            </Stack>
          ) : (
            <Text fontSize="sm" color="fg.muted">
              No localization (.arb files) set up — the app has one language.
            </Text>
          )}
          <Text fontSize="sm">
            <b>{i.hardcoded_strings.total}</b> hard-coded UI strings (Text('…'), title:, label:, hintText:) — these need moving to ARB files before translating.
          </Text>
          {i.hardcoded_strings.files.slice(0, 6).map((f) => (
            <Flex key={f.file} justify="space-between" fontSize="xs" gap="2">
              <Text fontFamily="mono" truncate>{f.file}</Text>
              <Text className="num" flexShrink={0}>{f.count}</Text>
            </Flex>
          ))}
        </Card>

        <Card title="Code hot spots">
          <SubHeading>Biggest Dart files</SubHeading>
          {i.biggest_files.map((f) => (
            <Flex key={f.file} justify="space-between" fontSize="xs" gap="2">
              <Link href={vscode(`${projectPath}/${f.file}`)} fontFamily="mono" truncate color="colorPalette.fg">{f.file}</Link>
              <Text className="num" flexShrink={0} color={f.lines > 600 ? 'fg.warning' : undefined}>{f.lines}</Text>
            </Flex>
          ))}
          <Text fontSize="xs" color="fg.muted">Files over ~600 lines are good candidates to split into smaller widgets.</Text>
          <Collapsible.Root open={todosOpen} onOpenChange={(e) => setTodosOpen(e.open)}>
            <Collapsible.Trigger asChild>
              <Button size="xs" variant="ghost" alignSelf="flex-start" disabled={!i.todos.length}>
                <LuChevronDown style={{ transform: todosOpen ? 'rotate(180deg)' : undefined }} /> {i.todos.length} TODO / FIXME comment{i.todos.length === 1 ? '' : 's'}
              </Button>
            </Collapsible.Trigger>
            <Collapsible.Content>
              <Stack gap="1" mt="2" maxH="240px" overflowY="auto">
                {i.todos.map((t, k) => (
                  <Link key={k} href={vscode(`${projectPath}/${t.file}`, t.line)} fontSize="xs" color="fg">
                    <Text as="span" fontFamily="mono" color="fg.muted">{t.file}:{t.line}</Text>&nbsp; {t.text}
                  </Link>
                ))}
              </Stack>
            </Collapsible.Content>
          </Collapsible.Root>
        </Card>
      </SimpleGrid>
    </Stack>
  );
}

// ---------------------------------------------------------------- release checklist

export function ReleasePanel({ items }: { items: CheckItem[] }) {
  const counts = { fail: 0, warn: 0, ok: 0, info: 0 };
  for (const i of items) counts[i.status]++;
  return (
    <Card
      title="Release checklist"
      subtitle="Static checks before a Play Store / App Store build — nothing is built, secrets are never read"
      actions={
        <HStack gap="1.5">
          {counts.fail > 0 && <Badge tone="critical">{`${counts.fail} to fix`}</Badge>}
          {counts.warn > 0 && <Badge tone="warning">{`${counts.warn} to check`}</Badge>}
          <Badge tone="good">{`${counts.ok} ok`}</Badge>
        </HStack>
      }
    >
      {(['App', 'Android', 'iOS', 'Code'] as const).map((g) => {
        const list = items.filter((i) => i.group === g).sort((a, b) => ['fail', 'warn', 'info', 'ok'].indexOf(a.status) - ['fail', 'warn', 'info', 'ok'].indexOf(b.status));
        if (!list.length) return null;
        return (
          <Stack key={g} gap="1.5">
            <Text fontSize="2xs" fontWeight="semibold" textTransform="uppercase" letterSpacing="wider" color="fg.subtle">{g}</Text>
            {list.map((i) => (
              <Flex
                key={i.id}
                gap="3"
                align="flex-start"
                borderWidth="1px"
                borderRadius="md"
                px="3"
                py="2.5"
                borderColor={i.status === 'fail' ? 'border.error' : i.status === 'warn' ? 'border.warning' : 'border'}
                bg={i.status === 'fail' ? 'bg.error' : undefined}
              >
                <Box mt="0.5" fontSize="md">{STATUS_ICON[i.status]}</Box>
                <Box flex="1" minW="0">
                  <Text fontWeight="medium" fontSize="sm">{i.label}</Text>
                  <Text fontSize="xs" color="fg.muted">{i.detail}</Text>
                  {i.fix && (
                    <HStack gap="1" mt="1" align="flex-start">
                      <Text fontSize="xs" fontWeight="medium" flexShrink={0}>Fix:</Text>
                      <Code size="sm" whiteSpace="normal" wordBreak="break-word">{i.fix}</Code>
                      <CopyButton value={i.fix} />
                    </HStack>
                  )}
                </Box>
              </Flex>
            ))}
          </Stack>
        );
      })}
    </Card>
  );
}

// ---------------------------------------------------------------- flutter doctor

interface DoctorSection {
  status: 'ok' | 'warn' | 'fail' | 'info';
  title: string;
  summary: string | null;
  lines: { status: 'ok' | 'warn' | 'fail' | 'info'; text: string }[];
  fix: string | null;
  optional: boolean;
}

/** Renders `command` parts of a fix as copyable code. */
function FixText({ text }: { text: string }) {
  const parts = text.split('`');
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <Box as="span" key={i} display="inline-flex" alignItems="center" gap="0.5" verticalAlign="middle" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
            <Code size="sm">{p}</Code>
            <CopyButton value={p} />
          </Box>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

export function DoctorPanel() {
  type Doctor = { ran_at: string; sections: DoctorSection[]; error: string | null };
  const qc = useQueryClient();
  // Cached for the session (the backend caches flutter doctor for 10 min too); "Run again" forces a fresh run.
  const q = useQuery({
    queryKey: qk.flutterDoctor,
    staleTime: 10 * 60_000,
    retry: false,
    queryFn: () => api<Doctor>('/flutter/doctor'),
  });
  const data: Doctor | null = q.data ?? (q.error ? { ran_at: new Date().toISOString(), sections: [], error: q.error.message } : null);
  const [running, setRunning] = useState(false);
  const busy = q.isFetching || running;
  const [open, setOpen] = useState<string | null>(null);
  const load = async (refresh = false) => {
    if (!refresh) return void q.refetch();
    setRunning(true);
    try {
      qc.setQueryData(qk.flutterDoctor, await api<Doctor>('/flutter/doctor?refresh=true'));
    } catch (e: any) {
      qc.setQueryData(qk.flutterDoctor, { ran_at: new Date().toISOString(), sections: [], error: e.message });
    } finally {
      setRunning(false);
    }
  };
  const problems = data?.sections.filter((s) => s.status !== 'ok' && !s.optional) ?? [];
  return (
    <Card
      icon={<LuStethoscope />}
      title="flutter doctor"
      subtitle={data ? `Checked ${new Date(data.ran_at).toLocaleTimeString()} · cached 10 min` : 'Checks Flutter, Android SDK, Java, devices…'}
      actions={
        <Button size="xs" variant="outline" onClick={() => void load(true)} loading={busy} loadingText="Running…">
          <LuRefreshCw /> Run again
        </Button>
      }
    >
      {!data ? (
        <Spinning label="Running flutter doctor -v (up to a minute)…" />
      ) : data.error ? (
        <Notice tone="error">{data.error}</Notice>
      ) : (
        <>
          {problems.length === 0 ? (
            <Notice tone="success" title="Ready for Android development">Everything Flutter needs for Android is set up.</Notice>
          ) : (
            <Notice tone="warning" title={`${problems.length} thing${problems.length === 1 ? '' : 's'} to fix for Android development`} />
          )}
          <Stack gap="1.5">
            {data.sections.map((s) => (
              <Box key={s.title} borderWidth="1px" borderRadius="md" opacity={s.optional && s.status !== 'ok' ? 0.85 : 1}>
                <Flex as="button" w="100%" gap="3" align="flex-start" px="3" py="2.5" textAlign="left" cursor="pointer" onClick={() => setOpen(open === s.title ? null : s.title)} _hover={{ bg: 'bg.muted' }}>
                  <Box mt="0.5" fontSize="md">{STATUS_ICON[s.status]}</Box>
                  <Box flex="1" minW="0">
                    <HStack gap="2" wrap="wrap">
                      <Text fontWeight="medium" fontSize="sm">{s.title}</Text>
                      {s.optional && s.status !== 'ok' && <CBadge size="xs" variant="outline">optional for Android</CBadge>}
                    </HStack>
                    {s.summary && <Text fontSize="xs" color="fg.muted" truncate>{s.summary}</Text>}
                    {s.fix && s.status !== 'ok' && (
                      <Text fontSize="xs" mt="1" color={s.optional ? 'fg.muted' : 'fg'}>
                        <b>Fix:</b> <FixText text={s.fix} />
                      </Text>
                    )}
                  </Box>
                  <Box color="fg.muted" transform={open === s.title ? 'rotate(180deg)' : undefined}><LuChevronDown /></Box>
                </Flex>
                {open === s.title && (
                  <Stack gap="0.5" px="10" pb="3">
                    {s.lines.map((l, k) => (
                      <HStack key={k} gap="2" align="flex-start" fontSize="xs">
                        <Box mt="0.5">{STATUS_ICON[l.status]}</Box>
                        <Text fontFamily="mono" wordBreak="break-all" color={l.status === 'info' ? 'fg.muted' : 'fg'}>{l.text}</Text>
                      </HStack>
                    ))}
                  </Stack>
                )}
              </Box>
            ))}
          </Stack>
        </>
      )}
    </Card>
  );
}

