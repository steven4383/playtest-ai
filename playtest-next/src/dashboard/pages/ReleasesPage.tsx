'use client';
import NextLink from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { Box, Button, Flex, HStack, Stack, Text } from '@chakra-ui/react';
import { LuFolderKanban, LuRocket } from 'react-icons/lu';
import { pk, useProject, useProjects } from '../lib/projects';
import { Empty, Loading } from '../components/ui';
import { DeploymentTab } from './project/DeploymentTab';

function ProjectReleases({ id }: { id: string }) {
  const qc = useQueryClient();
  const q = useProject(id);
  if (!q.data) return <Loading rows={1} height="32" />;
  const apps = q.data.components.filter((c) => c.kind === 'mobile');
  if (!apps.length) return null;
  const color = q.data.color ?? 'blue';
  return (
    <Stack gap="3" colorPalette={color}>
      <Flex align="center" gap="3">
        <Flex w="8" h="8" align="center" justify="center" borderRadius="lg" bg="colorPalette.solid" color="colorPalette.contrast" fontWeight="bold" fontFamily="heading">
          {q.data.name.slice(0, 1).toUpperCase()}
        </Flex>
        <Text fontFamily="heading" fontWeight="semibold" fontSize="lg">
          {q.data.name}
        </Text>
        <Button asChild size="xs" variant="ghost">
          <NextLink href={`/projects/${id}`}>
            <LuFolderKanban /> Open project
          </NextLink>
        </Button>
      </Flex>
      <DeploymentTab components={apps} onChanged={() => void qc.invalidateQueries({ queryKey: pk.detail(id) })} />
    </Stack>
  );
}

/** Deployment workspace: the Release button of every mobile app, across all projects. */
export function ReleasesPage() {
  const q = useProjects();
  if (!q.data) return <Loading rows={2} height="40" label="Loading apps" />;
  const withApps = q.data.filter((p) => p.components > 0);
  if (!withApps.length)
    return (
      <Empty
        icon={<LuRocket />}
        title="No app to release yet"
        action={
          <Button asChild size="sm">
            <NextLink href="/projects">
              <LuFolderKanban /> Go to Projects
            </NextLink>
          </Button>
        }
      >
        Create a project and add your Flutter app folder — its Release button, Google Play setup and history appear here.
      </Empty>
    );
  return (
    <Stack gap="8">
      <HStack gap="2" color="fg.muted" fontSize="sm">
        <LuRocket />
        <Text>Build, check and upload each app to Google Play. Start with a Dry run — it never publishes anything.</Text>
      </HStack>
      {withApps.map((p) => (
        <Box key={p.id}>
          <ProjectReleases id={p.id} />
        </Box>
      ))}
    </Stack>
  );
}
