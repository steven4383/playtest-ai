import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export type Category = 'goal' | 'education' | 'career' | 'personal' | 'health' | 'event' | 'planning' | 'development' | 'testing' | 'deployment' | 'completion';
export type EntryStatus = 'planned' | 'in_progress' | 'achieved' | 'dropped';

export interface TimelineEntry {
  id: string;
  scope: 'personal' | 'project';
  project_id: string | null;
  project_name: string | null;
  project_color: string | null;
  category: Category;
  title: string;
  description: string | null;
  notes: string | null;
  status: EntryStatus;
  date: string | null;
  achieved_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface TimelineRelease {
  id: string;
  version_after: string;
  track: string;
  finished_at: string;
  app: string;
  project_id: string;
  project_name: string;
  project_color: string | null;
}
export interface TimelineStats {
  level: number;
  rank: 'E' | 'D' | 'C' | 'B' | 'A' | 'S';
  xp: number;
  level_xp: number;
  level_span: number;
  achieved: number;
  active: number;
  upcoming: number;
  overdue: number;
  next: TimelineEntry | null;
}
export interface TimelineData {
  entries: TimelineEntry[];
  releases: TimelineRelease[];
  stats: TimelineStats;
}
export interface UpdateResult {
  entry: TimelineEntry;
  level_before: number;
  level_after: number;
  xp_gained: number;
  rank: string;
}

export type Scope = 'all' | 'personal' | 'project';
export const tk = { all: ['timeline'] as const, list: (scope: Scope, project?: string) => ['timeline', scope, project ?? ''] as const };

export const useTimeline = (scope: Scope, project?: string) =>
  useQuery({
    queryKey: tk.list(scope, project),
    queryFn: () => {
      const qs = new URLSearchParams();
      if (project) qs.set('project', project);
      else if (scope !== 'all') qs.set('scope', scope);
      return api<TimelineData>(`/timeline${qs.size ? `?${qs}` : ''}`);
    },
  });

export const CATEGORY: Record<Category, { label: string; group: 'Personal' | 'Project'; palette: string; xp: number }> = {
  goal: { label: 'Goal', group: 'Personal', palette: 'blue', xp: 50 },
  education: { label: 'Education', group: 'Personal', palette: 'cyan', xp: 80 },
  career: { label: 'Career', group: 'Personal', palette: 'purple', xp: 100 },
  personal: { label: 'Personal', group: 'Personal', palette: 'pink', xp: 40 },
  health: { label: 'Health', group: 'Personal', palette: 'green', xp: 40 },
  event: { label: 'Important day', group: 'Personal', palette: 'orange', xp: 20 },
  planning: { label: 'Planning', group: 'Project', palette: 'gray', xp: 30 },
  development: { label: 'Development', group: 'Project', palette: 'blue', xp: 60 },
  testing: { label: 'Testing', group: 'Project', palette: 'orange', xp: 50 },
  deployment: { label: 'Deployment', group: 'Project', palette: 'purple', xp: 100 },
  completion: { label: 'Completion', group: 'Project', palette: 'green', xp: 150 },
};

export const STATUS_LABEL: Record<EntryStatus, string> = { planned: 'Planned', in_progress: 'In progress', achieved: 'Achieved', dropped: 'Dropped' };

/** Days from today to a YYYY-MM-DD date (negative = past). */
export function daysUntil(date: string | null): number | null {
  if (!date) return null;
  const today = new Date(new Date().toISOString().slice(0, 10));
  return Math.round((Date.parse(date) - today.getTime()) / 86_400_000);
}

export const fmtDate = (d: string | null) => (d ? new Date(d.length === 10 ? `${d}T00:00:00` : d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
