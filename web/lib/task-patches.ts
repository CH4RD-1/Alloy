// The Tasks/Projects "optimistic patch overlay" — small, short-lived
// per-task edits laid on top of the server-rendered `rows` prop for instant
// visual feedback, without lifting `rows` itself into local state.
//
// Why not just lift `rows` into a useState seeded from props? Because every
// *other* mutation in this app (see TasksWorkspace's own callers — the task
// panel's field edits, status-transition buttons, Buckets/Calendar drags,
// Gantt drag/resize) still works by calling a server action and then
// router.refresh(): refresh() re-fetches and updates the props this
// component receives, but a useState initializer only runs once, so an
// already-initialized local copy of `rows` would just stop tracking the
// server for anything that isn't explicitly re-synced into it. That's a
// silent regression waiting to happen for every future mutation someone
// adds without knowing about the lift.
//
// So `rows` stays exactly what it's always been: a plain prop, rebuilt
// server-side and refreshed the same way it always was. This module is
// just the small bit of machinery that lets a handful of interactions
// (documented at each call site) paint their own known-good result
// immediately, then quietly get out of the way once the real refresh lands.
//
// See TasksWorkspace's `taskPatches` state for how these are held, and
// gantt-view.tsx / buckets-view.tsx / task-panel.tsx for where they're set.

import type { Task } from "./types";
import type { TaskRow } from "./list-view";

// One task's pending patch. Raw Task fields (title, status_id, team_id,
// dates, ...) patch straight onto row.task. The rest are TaskRow's own
// *derived* fields (see lib/list-view.ts's buildRows) that some views group
// or key by instead of the raw field they're derived from — teamName/
// teamColor (Buckets groups by teamName, not team_id) and the status*
// fields (a status chip reads statusLabel/statusColor/statusIsClosed, not
// the raw status_id) — so a patch that changes team_id or status_id needs
// to carry its derived fields too, or the UI it's meant to fix keeps
// showing the old grouping/label until the real refresh lands.
export type TaskPatch = Partial<Task> & {
  teamName?: string | null;
  teamColor?: string | null;
  statusKey?: string;
  statusLabel?: string;
  statusColor?: string;
  statusIsClosed?: boolean;
  assigneeName?: string | null;
};

const DERIVED_KEYS = [
  "teamName",
  "teamColor",
  "statusKey",
  "statusLabel",
  "statusColor",
  "statusIsClosed",
  "assigneeName",
] as const;

function splitPatch(patch: TaskPatch): { derived: Partial<TaskRow>; taskPatch: Partial<Task> } {
  const derived: Partial<TaskRow> = {};
  const rest: Record<string, unknown> = { ...patch };
  DERIVED_KEYS.forEach((key) => {
    if (key in rest) {
      (derived as Record<string, unknown>)[key] = rest[key];
      delete rest[key];
    }
  });
  return { derived, taskPatch: rest as Partial<Task> };
}

// Applies any patches in `patches` onto `row` and its full (recursive)
// children tree, returning a new TaskRow only where something along that
// path actually changed — an unaffected branch is returned as-is.
export function applyTaskPatches(row: TaskRow, patches: Map<string, TaskPatch>): TaskRow {
  const patch = patches.get(row.task.id);
  const children = row.children?.map((c) => applyTaskPatches(c, patches));
  const childrenChanged = !!children && !!row.children && children.some((c, i) => c !== row.children![i]);
  if (!patch && !childrenChanged) return row;
  const { derived, taskPatch } = patch ? splitPatch(patch) : { derived: {}, taskPatch: {} };
  return {
    ...row,
    ...derived,
    task: patch ? ({ ...row.task, ...taskPatch } as Task) : row.task,
    children: childrenChanged ? children : row.children,
  };
}

// True once a fresh server row already shows every field a patch predicted
// — the signal that the patch has served its purpose (router.refresh()
// landed) and can be dropped rather than lingering forever.
export function patchMatchesRow(patch: TaskPatch, row: TaskRow): boolean {
  const { derived, taskPatch } = splitPatch(patch);
  const derivedOk = (Object.keys(derived) as (keyof TaskRow)[]).every((key) => derived[key] === row[key]);
  if (!derivedOk) return false;
  return Object.entries(taskPatch).every(([key, value]) => (row.task as unknown as Record<string, unknown>)[key] === value);
}
