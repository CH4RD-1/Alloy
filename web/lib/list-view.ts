// Pure, framework-agnostic helpers for the List view — ported from the Alloy
// prototype's renderListView() / listRowHtml() (see the "Live prototype" link
// in alloy-development-log.md). Kept separate from data-fetching and React
// so the row-shaping logic is easy to reuse when the other views get ported.

import type { Task, WorkflowStatus, Team, TaskLink, Asset } from "./types";

// Mirrors the prototype's ENVIRONMENTS[...].vocab — per-template wording.
// Status *labels* are customisable per-org via workflow_statuses.label
// instead (see schema.sql) rather than hardcoded here, matching how the
// prototype kept the 5 status ids fixed but let their display names vary.
export const VOCAB_BY_TEMPLATE: Record<string, { task: string; team: string }> = {
  core: { task: "Task", team: "Team" },
  helpdesk: { task: "Ticket", team: "Queue" },
  engineering: { task: "Task", team: "Discipline" },
};

export function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

// Deterministic hue from a string — used for tag chip colors and assignee
// avatar colors alike, so neither needs a hand-maintained lookup table (the
// prototype used a fixed PEOPLE map for avatars; this scales to real users).
export function hueFor(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

export function initials(name: string | null): string {
  if (!name) return "?";
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export interface TaskRow {
  task: Task;
  childCount: number;
  doneChildCount: number;
  teamName: string | null;
  teamColor: string | null;
  statusKey: string;
  statusLabel: string;
  statusColor: string;
  statusIsClosed: boolean;
  assigneeName: string | null;
  tags: string[];
  depCount: number;
  isBlockedOpen: boolean;
  docCount: number;
  assetName: string | null;
  // Recursive now (subtasks can have their own subtasks — "sub-subtasks"),
  // capped at MAX_TASK_DEPTH levels below top-level — see buildRows'
  // header comment for why the cap exists and where it's enforced.
  // Populated on every row, not just top-level ones, so opening a
  // subtask's own panel (or expanding it in List/Gantt) shows *its* own
  // children too. depth is 0 for a top-level task, 1 for a subtask, 2 for
  // a sub-subtask (the deepest level this app allows).
  children?: TaskRow[];
  depth: number;
}

// Two layers of subtasks, as requested — task → subtask → sub-subtask —
// and no deeper. `parent_task_id` itself has no depth limit at the schema
// level (see schema.sql's own comment), so this cap is enforced purely in
// app code: rowFor below simply stops recursing once it would produce a
// depth-3 row, and the subtask-creation UI (task-panel.tsx) hides its own
// "Add subtask" control once a task is already at MAX_TASK_DEPTH — nothing
// stops a 4th level existing in the database (e.g. from data written
// outside this app), it just never renders past this depth anywhere.
export const MAX_TASK_DEPTH = 2;

export function buildRows(params: {
  tasks: Task[];
  statuses: WorkflowStatus[];
  teams: Team[];
  links: TaskLink[];
  tagsByTask: Map<string, string[]>;
  docCountByTask: Map<string, number>;
  assigneeNameById: Map<string, string>;
  assets: Asset[];
}): TaskRow[] {
  const { tasks, statuses, teams, links, tagsByTask, docCountByTask, assigneeNameById, assets } = params;

  const statusById = new Map(statuses.map((s) => [s.id, s]));
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const childrenOf = (id: string) => tasks.filter((t) => t.parent_task_id === id);
  const topLevel = tasks.filter((t) => !t.parent_task_id);

  // A "Block" relationship is stored as a mirrored pair, one row per side
  // (see the task_links note in schema.sql and addLink()/removeLink() in
  // lib/actions.ts): "blocked" on the dependent task (from_task_id waits on
  // to_task_id), "blocks" on the task it depends on. Ported from the
  // prototype's blockersOf/isBlockedOpen — blocksOf is gone: now that Block
  // links are stored on both sides like every other link type, depCountFor
  // below no longer needs a second, other-side lookup to find them.
  const blockersOf = (taskId: string) =>
    links.filter((l) => l.from_task_id === taskId && l.link_type === "blocked").map((l) => l.to_task_id);
  // is_closed rather than key !== "done" — a task's own workflow (chosen per
  // project now, possibly Helpdesk or a custom one) can key its terminal
  // status anything, so is_closed is the only generic "still open" signal.
  const isBlockedOpen = (t: Task) =>
    blockersOf(t.id).some((bId) => {
      const blocker = tasks.find((x) => x.id === bId);
      const bStatus = blocker && statusById.get(blocker.status_id);
      return bStatus && !bStatus.is_closed;
    });
  // Total relationships touching this task. Now that every relationship —
  // Block included — has its own row on both sides, this is just what's
  // recorded on this task's own side; no second half to add on top of it.
  const depCountFor = (t: Task) => links.filter((l) => l.from_task_id === t.id).length;

  const rowFor = (t: Task, depth: number): TaskRow => {
    const kids = childrenOf(t.id);
    const team = t.team_id ? teamById.get(t.team_id) : null;
    const status = statusById.get(t.status_id);
    const asset = t.asset_id ? assetById.get(t.asset_id) : null;
    const row: TaskRow = {
      task: t,
      childCount: kids.length,
      doneChildCount: kids.filter((k) => statusById.get(k.status_id)?.is_closed).length,
      teamName: team?.name ?? null,
      teamColor: team?.color ?? null,
      statusKey: status?.key ?? "backlog",
      statusLabel: status?.label ?? "—",
      statusColor: status?.color ?? "#64748b",
      statusIsClosed: !!status?.is_closed,
      assigneeName: t.assignee_id ? assigneeNameById.get(t.assignee_id) ?? null : null,
      tags: tagsByTask.get(t.id) ?? [],
      depCount: depCountFor(t),
      isBlockedOpen: isBlockedOpen(t),
      docCount: docCountByTask.get(t.id) ?? 0,
      assetName: asset?.name ?? null,
      depth,
    };
    // Stop recursing once one more level would exceed MAX_TASK_DEPTH — a
    // sub-subtask's own row still reports an accurate childCount above (so
    // a stray deeper task, e.g. from data written outside this app, still
    // counts correctly), it just never gets its own rendered `children`.
    row.children = depth < MAX_TASK_DEPTH ? kids.map((k) => rowFor(k, depth + 1)) : [];
    return row;
  };

  return topLevel.map((t) => rowFor(t, 0));
}

// Every row, at any depth, as one flat list — used wherever a UI needs to
// look a task up by id (the panel, the link picker) without caring about
// the parent/child grouping buildRows() produces. Recurses through every
// level buildRows() populated (see MAX_TASK_DEPTH), not just one.
export function flattenRows(rows: TaskRow[]): TaskRow[] {
  return rows.flatMap((r) => [r, ...flattenRows(r.children ?? [])]);
}
