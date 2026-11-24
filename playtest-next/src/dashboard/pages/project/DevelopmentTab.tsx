'use client';
import NextLink from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { Box, Button, Code, Collapsible, Flex, HStack, Link, SimpleGrid, Stack, Text } from '@chakra-ui/react';
import { LuCode, LuExternalLink, LuGitBranch, LuGitCommitHorizontal, LuPlay, LuRefreshCw } from 'react-icons/lu';
import { ago, KIND_LABEL, pk, type ProjectComponent } from '../../lib/projects';
import { Badge, Card, CopyButton, Empty } from '../../components/ui';
import { frameworkLabel } from './AddPart';

/** Development: where each part's code stands (git) and shortcuts to the tools that work on it. */
export function DevelopmentTab({ projectId, components }: { projectId: string; components: ProjectComponent[] }) {
  const qc = useQueryClient();
  if (!components.length)
    return (
      <Empty icon={<LuCode />} title="No parts yet">
        Add your app, web panel or backend folder on the Overview tab.
      </Empty>
    );
  return (
    <Stack gap="4">
      <Flex justify="flex-end">
        <Button size="xs" variant="ghost" onClick={() => void qc.invalidateQueries({ queryKey: pk.detail(projectId) })}>
          <LuRefreshCw /> Refresh git status
        </Button>
      </Flex>
      {components.map((c) => {
        const g = c.git;
        return (
          <Card
            key={c.id}
            icon={<LuGitBranch />}
            title={c.name}
            subtitle={`${KIND_LABEL[c.kind]} · ${frameworkLabel(c.framework)}${c.version ? ` · v${c.version}` : ''}`}
            actions={
              <HStack gap="1.5" wrap="wrap">
                {g.web_url && (
                  <Button asChild size="xs" variant="outline">
                    <a href={g.web_url} target="_blank" rel="noreferrer">
                      <LuExternalLink /> Repository
                    </a>
                  </Button>
                )}
                {c.framework === 'flutter' && (
                  <Button asChild size="xs" variant="outline">
                    <NextLink href="/dev">
                      <LuCode /> Flutter tools
                    </NextLink>
                  </Button>
                )}
                {c.kind === 'mobile' && (
                  <Button asChild size="xs" variant="outline">
                    <NextLink href="/campaigns">
                      <LuPlay /> Test runs
                    </NextLink>
                  </Button>
                )}
              </HStack>
            }
          >
            <HStack gap="1.5" fontSize="xs" color="fg.muted" mb="3">
              <Code size="sm" wordBreak="break-all">
                {c.path}
              </Code>
              <CopyButton value={c.path} />
            </HStack>
            {!g.repo ? (
              <Text fontSize="sm" color="fg.muted">
                Not a git repository — run <Code size="sm">git init</Code> in the folder to track changes and tag releases.
              </Text>
            ) : (
              <SimpleGrid columns={{ base: 1, lg: 2 }} gap="4">
                <Stack gap="2">
                  <HStack gap="2" wrap="wrap">
                    <Badge tone="neutral">
                      <LuGitBranch /> {g.branch ?? 'detached'}
                    </Badge>
                    {g.changed.length ? <Badge tone="warning">{g.changed.length} uncommitted</Badge> : <Badge tone="good">clean</Badge>}
                    {g.ahead > 0 && <Badge tone="warning">{g.ahead} to push</Badge>}
                    {g.behind > 0 && <Badge tone="warning">{g.behind} to pull</Badge>}
                  </HStack>
                  {g.changed.length > 0 && (
                    <Collapsible.Root>
                      <Collapsible.Trigger asChild>
                        <Button size="2xs" variant="ghost" alignSelf="flex-start">
                          Show changed files
                        </Button>
                      </Collapsible.Trigger>
                      <Collapsible.Content>
                        <Box fontFamily="mono" fontSize="xs" maxH="200px" overflowY="auto" borderWidth="1px" borderRadius="md" p="2">
                          {g.changed.slice(0, 100).map((f) => (
                            <Text key={f.file} truncate>
                              <Text as="span" color={f.status.includes('D') ? 'fg.error' : f.status === '??' ? 'fg.subtle' : 'fg.warning'} display="inline-block" w="6">
                                {f.status}
                              </Text>
                              {f.file}
                            </Text>
                          ))}
                        </Box>
                      </Collapsible.Content>
                    </Collapsible.Root>
                  )}
                  {!g.remote && (
                    <Text fontSize="xs" color="fg.muted">
                      No remote — add one on GitHub to back up and share this code.
                    </Text>
                  )}
                </Stack>
                <Stack gap="1">
                  <Text fontSize="xs" color="fg.subtle" textTransform="uppercase" letterSpacing="wider" fontWeight="semibold">
                    Recent commits
                  </Text>
                  {g.commits.slice(0, 8).map((m) => (
                    <HStack key={m.hash} gap="2" fontSize="sm" minW="0">
                      <Box color="fg.subtle" flexShrink={0}>
                        <LuGitCommitHorizontal />
                      </Box>
                      {g.web_url ? (
                        <Link href={`${g.web_url}/commit/${m.hash}`} target="_blank" rel="noreferrer" fontFamily="mono" fontSize="xs" flexShrink={0}>
                          {m.hash}
                        </Link>
                      ) : (
                        <Text fontFamily="mono" fontSize="xs" flexShrink={0}>
                          {m.hash}
                        </Text>
                      )}
                      <Text truncate flex="1" title={m.subject}>
                        {m.subject}
                      </Text>
                      <Text fontSize="xs" color="fg.muted" flexShrink={0}>
                        {ago(m.date)}
                      </Text>
                    </HStack>
                  ))}
                  {!g.commits.length && (
                    <Text fontSize="sm" color="fg.muted">
                      No commits yet.
                    </Text>
                  )}
                </Stack>
              </SimpleGrid>
            )}
          </Card>
        );
      })}
    </Stack>
  );
}
