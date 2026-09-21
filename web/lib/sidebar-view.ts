// Pure, framework-agnostic helpers for the sidebar's "Workspace" project nav
// and "Filter by team" checklist — ported from the Alloy prototype's
// teamGroupsFor()/teamGroupKey()/matchesFilters()/taskCountForProject() (see
// the "Live prototype" link in alloy-development-log.md). Kept separate from
// the React component the same way list-view.ts/buckets-view.ts are.

import type { Team } from "./types";
import type { TaskRow } from "./list-view";

export const ALL_PROJECTS_KEY = "all";

// The list of {key, name, color} entries to show as team filter checkboxes
// (and, for Buckets, board columns) for the current project scope: either
// one project's own teams, or, for "All projects", one merged entry per
// distinct team name (first-seen colour wins) — same idea as
// buildBucketColumns()'s own dedup-by-name, which this mirrors on purpose so
// switching between "All projects" and a single project always lines up
// with what the team columns/filters show.
export function teamGroupsFor(projectFilter: string, teams: Team[]): { key: string; name: string; color: string }[] {
  const ordered = [...teams].sort((a, b) => a.position - b.position);
  if (projectFilter !== ALL_PROJECTS_KEY) {
    return ordered.filter((t) => t.project_id === projectFilter).map((t) => ({ key: t.id, name: t.name, color: t.color }));
  }
  const seen = new Map<string, { key: string; name: string; color: string }>();
  ordered.forEach((t) => {
    const key = t.name.trim().toLowerCase();
    if (!seen.has(key)) seen.set(key, { key, name: t.name, color: t.color });
  });
  return Array.from(seen.values());
}

// The key a task's team resolves to for filter/column matching: a real team
// id when scoped to one project, or the merged lowercased name when viewing
// "All projects" (see teamGroupsFor). null when the task has no team at all
// — nullable in this schema, unlike the prototype where every task always
// had one — so it can never match an active team filter, the same way
// buildBucketColumns() gives such a task its own "No team" column instead of
// folding it into a real one.
export function teamGroupKeyForRow(row: TaskRow, projectFilter: string): string | null {
  if (projectFilter !== ALL_PROJECTS_KEY) return row.task.team_id;
  return row.teamName ? row.teamName.trim().toLowerCase() : null;
}

// The project + team half of the prototype's matchesFilters() — search is
// applied separately, same as before this feature (see tasks-workspace.tsx).
export function matchesProjectTeamFilters(row: TaskRow, projectFilter: string, teamFilters: Set<string>): boolean {
  if (projectFilter !== ALL_PROJECTS_KEY && row.task.project_id !== projectFilter) return false;
  if (teamFilters.size) {
    const key = teamGroupKeyForRow(row, projectFilter);
    if (!key || !teamFilters.has(key)) return false;
  }
  return true;
}

// Ported from taskCountForProject() — counts every task, subtasks included,
// so pass flattenRows(rows) (i.e. the same allRows already built for
// Buckets/the task-id lookup map), not just the top-level rows.
export function taskCountForProject(projectId: string, allRows: TaskRow[]): number {
  if (projectId === ALL_PROJECTS_KEY) return allRows.length;
  return allRows.filter((r) => r.task.project_id === projectId).length;
}
