import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/** Projects you maintain: types and cached queries (kept fresh by `release_update` live events). */

export type ComponentKind = 'mobile' | 'web' | 'backend' | 'other';
export type NoteKind = 'requirement' | 'task' | 'bug' | 'idea' | 'note';
export type NoteStatus = 'todo' | 'doing' | 'done';
export type Priority = 'low' | 'medium' | 'high';
export type ReleaseMode = 'publish' | 'dry_run' | 'build';
export type StepState = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export interface ProjectSummary {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  created_at: string;
  updated_at: string | null;
  components: number;
  open_notes: number;
  last_release: string | null;
}

export interface GitInfo {
  repo: boolean;
  branch: string | null;
  remote: string | null;
  web_url: string | null;
  ahead: number;
  behind: number;
  changed: { status: string; file: string }[];
  commits: { hash: string; subject: string; author: string; date: string }[];
}

export interface PlayConfig {
  component_id: string;
  package_name: string;
  service_account_email: string | null;
  has_service_account: boolean;
  default_track: string;
  release_status: 'completed' | 'draft' | 'inProgress';
  user_fraction: number | null;
  bump: 'patch' | 'minor' | 'major' | 'build';
  require_clean: number;
  git_commit: number;
  git_tag: number;
  git_push: number;
  updated_at: string;
}

export interface ReleaseStep {
  id: 'preflight' | 'version' | 'build' | 'verify' | 'upload' | 'git';
  label: string;
  state: StepState;
  detail?: string;
  ms?: number;
}

export interface Release {
  id: string;
  component_id: string;
  mode: ReleaseMode;
  track: string | null;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  version_before: string | null;
  version_after: string | null;
  version_code: number | null;
  release_status: string | null;
  user_fraction: number | null;
  notes: string | null;
  aab_bytes: number | null;
  steps: ReleaseStep[];
  warning: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  live: boolean;
}

export interface ProjectComponent {
  id: string;
  project_id: string;
  kind: ComponentKind;
  name: string;
  path: string;
  framework: string | null;
  package_name: string | null;
  repo_url: string | null;
  created_at: string;
  version: string | null;
  git: GitInfo;
  play: PlayConfig | null;
  last_release: Release | null;
}

export interface ProjectDetail {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  created_at: string;
  updated_at: string | null;
  components: ProjectComponent[];
}

export interface Note {
  id: string;
  project_id: string;
  component_id: string | null;
  kind: NoteKind;
  title: string;
  body: string | null;
  status: NoteStatus;
  priority: Priority;
  due_date: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface PlayTrack {
  track: string;
  releases?: { name?: string; versionCodes?: string[]; status?: string; userFraction?: number }[];
}

export const pk = {
  all: ['projects'] as const,
  list: ['projects', 'list'] as const,
  detail: (id: string) => ['projects', 'detail', id] as const,
  notes: (id: string) => ['projects', 'notes', id] as const,
  releases: (componentId: string) => ['projects', 'releases', componentId] as const,
  playStatus: (componentId: string) => ['projects', 'play-status', componentId] as const,
};

export const useProjects = () => useQuery({ queryKey: pk.list, queryFn: () => api<{ projects: ProjectSummary[] }>('/projects').then((r) => r.projects) });
export const useProject = (id: string) => useQuery({ queryKey: pk.detail(id), enabled: !!id, queryFn: () => api<ProjectDetail>(`/projects/${encodeURIComponent(id)}`) });
export const useNotes = (id: string) => useQuery({ queryKey: pk.notes(id), enabled: !!id, queryFn: () => api<{ notes: Note[] }>(`/projects/${encodeURIComponent(id)}/notes`).then((r) => r.notes) });
export const useReleases = (componentId: string) =>
  useQuery({ queryKey: pk.releases(componentId), queryFn: () => api<{ releases: Release[] }>(`/components/${componentId}/releases`).then((r) => r.releases) });
/** Live Play tracks — only when asked (one Google API round-trip), then cached for 2 minutes. */
export const usePlayStatus = (componentId: string, enabled: boolean) =>
  useQuery({
    queryKey: pk.playStatus(componentId),
    enabled,
    staleTime: 2 * 60_000,
    retry: false,
    queryFn: () => api<{ tracks: PlayTrack[]; max_version_code: number }>(`/components/${componentId}/play/status`),
  });

export const KIND_LABEL: Record<ComponentKind, string> = { mobile: 'Mobile app', web: 'Web panel', backend: 'Backend', other: 'Other' };
export const TRACK_LABEL: Record<string, string> = { internal: 'Internal testing', alpha: 'Closed testing', beta: 'Open testing', production: 'Production' };
export const trackLabel = (t: string | null | undefined) => (t ? (TRACK_LABEL[t] ?? t) : '—');

/** "3 min ago" style. */
export function ago(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)} d ago`;
  return new Date(iso).toLocaleDateString();
}
