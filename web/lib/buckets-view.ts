// Pure, framework-agnostic helpers for the Buckets (kanban) view — ported
// from the Alloy prototype's renderBucketsView() (see the "Live prototype"
// link in alloy-development-log.md). Kept separate from the React component
// the same way list-view.ts is, so the grouping logic is easy to test/reuse.

import type { TaskRow } from "./list-view";
import type { Team } from "./types";

export const UNASSIGNED_BUCKET_KEY = "__unassigned";

export interface BucketColumn {
  key: string; // team name, lowercased+trimmed — or UNASSIGNED_BUCKET_KEY
  name: string;
  color: string;
  // The id to write to a task's team_id when it's dropped on this column.
  // null for the "No team" column. When several teams across projects share
  // a name (the prototype's "merge by name" behavior — see teamGroupsFor()
  // in the prototype), this is the first such team's id; there's only ever
  // one project in this app so far, so that ambiguity doesn't arise yet.
  teamId: string | null;
  rows: TaskRow[];
}

// Buckets groups every task, not just top-level ones (a subtask can belong
// to a different team than its parent) — pass flattenRows(rows), not rows.
export function buildBucketColumns(allRows: TaskRow[], teams: Team[]): BucketColumn[] {
  const orderedTeams = [...teams].sort((a, b) => a.position - b.position);
  const meta = new Map<string, { name: string; color: string; teamId: string }>();
  orderedTeams.forEach((t) => {
    const key = t.name.trim().toLowerCase();
    if (!meta.has(key)) meta.set(key, { name: t.name, color: t.color, teamId: t.id });
  });

  const rowsByKey = new Map<string, TaskRow[]>();
  allRows.forEach((row) => {
    const key = row.teamName ? row.teamName.trim().toLowerCase() : UNASSIGNED_BUCKET_KEY;
    const list = rowsByKey.get(key) ?? [];
    list.push(row);
    rowsByKey.set(key, list);
  });

  const columns: BucketColumn[] = Array.from(meta.entries()).map(([key, m]) => ({
    key,
    name: m.name,
    color: m.color,
    teamId: m.teamId,
    rows: rowsByKey.get(key) ?? [],
  }));

  const unassigned = rowsByKey.get(UNASSIGNED_BUCKET_KEY) ?? [];
  if (unassigned.length) {
    columns.push({ key: UNASSIGNED_BUCKET_KEY, name: "No team", color: "#8b9199", teamId: null, rows: unassigned });
  }

  return columns;
}
