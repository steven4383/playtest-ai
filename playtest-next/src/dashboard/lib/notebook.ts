import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { NoteKind, NoteStatus, Priority } from './projects';

export interface NotebookEntry {
  id: string;
  title: string;
  body: string;
  pinned: number;
  color: string | null;
  project_id: string | null;
  project_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectItem {
  id: string;
  project_id: string;
  project_name: string;
  project_color: string | null;
  component_id: string | null;
  component_name: string | null;
  kind: NoteKind;
  title: string;
  body: string | null;
  status: NoteStatus;
  priority: Priority;
  due_date: string | null;
  updated_at: string;
}

export const nk = {
  list: (q: string) => ['notebook', 'list', q] as const,
  all: ['notebook'] as const,
  items: ['project-items'] as const,
};

export const useNotebook = (q: string) =>
  useQuery({ queryKey: nk.list(q), queryFn: () => api<{ notes: NotebookEntry[] }>(`/notebook${q ? `?q=${encodeURIComponent(q)}` : ''}`).then((r) => r.notes) });

export const useProjectItems = () => useQuery({ queryKey: nk.items, queryFn: () => api<{ items: ProjectItem[] }>('/project-items').then((r) => r.items) });

/** First line (or title) for lists. */
export const noteTitle = (n: Pick<NotebookEntry, 'title' | 'body'>) => n.title.trim() || n.body.trim().split(/\r?\n/)[0]?.replace(/^#+\s*|^[-*]\s*(\[[ xX]\]\s*)?/, '').slice(0, 80) || 'Untitled';

/** Checklist progress of a note body: "- [x]" / "- [ ]" lines. */
export function checklist(body: string) {
  const all = body.match(/^\s*[-*] \[[ xX]\]/gm) ?? [];
  return { done: all.filter((l) => /\[[xX]\]/.test(l)).length, total: all.length };
}
