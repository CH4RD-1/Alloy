// Pure, framework-agnostic helpers for the Dashboard view — ported from the
// prototype's renderDashboardView() (see the "Live prototype" link in
// alloy-development-log.md). Kept separate from data-fetching and React,
// same pattern as list-view.ts/gantt-schedule.ts.
//
// Dropped from this port: the "Your recent activity" feed. The prototype
// read it from an in-memory per-task `activity` array; there's no
// persisted equivalent yet (schema.sql explicitly defers a real
// activity/audit log — see its "Deliberately deferred" note), so there's
// nothing to query. Stats + the two task lists below don't depend on it.

import type { Task, WorkflowStatus, WorkflowTransition, Role } from "./types";

// The schema's default allowed_roles is {manager,authorizer,standard} — i.e.
// "every non-owner/admin role" (owner/admin can always move any transition,
// see canMove() in task-panel.tsx). A transition counts as "gated" — needing
// someone's specific sign-off — if it's restricted to fewer than that,
// mirroring the prototype's `w.roles.length < ROLES.length` check.
const OPEN_ROLE_COUNT = 3;

function isGated(t: WorkflowTransition): boolean {
  return t.allowed_roles.length < OPEN_ROLE_COUNT;
}

function canMove(t: WorkflowTransition, role: Role): boolean {
  return role === "owner" || role === "admin" || t.allowed_roles.includes(role);
}

// is_closed rather than key === "done" — a task's own project workflow can
// now be Helpdesk, Assets, or a custom one, each with its own terminal key.
function isDone(task: Task, statusById: Map<string, WorkflowStatus>): boolean {
  return !!statusById.get(task.status_id)?.is_closed;
}

// Every open task assigned to this user, due-soonest first (undated —
// helpdesk-project — tasks sort last rather than being excluded, matching
// the prototype's "Your tasks" list, which still shows them with a "—" in
// place of a date).
export function myOpenTasks(tasks: Task[], statuses: WorkflowStatus[], currentUserId: string): Task[] {
  const statusById = new Map(statuses.map((s) => [s.id, s]));
  return tasks
    .filter((t) => t.assignee_id === currentUserId && !isDone(t, statusById))
    .sort((a, b) => (a.due_date ?? "9999-12-31").localeCompare(b.due_date ?? "9999-12-31"));
}

// Tasks whose current status has at least one gated outgoing transition the
// current viewer specifically is allowed to perform — i.e. things stuck
// waiting on this person's sign-off. Excludes Done (reopening finished work
// is an override, not a pending review).
export function tasksAwaitingReview(
  tasks: Task[],
  statuses: WorkflowStatus[],
  transitions: WorkflowTransition[],
  currentUserRole: Role
): Task[] {
  const statusById = new Map(statuses.map((s) => [s.id, s]));
  return tasks.filter((t) => {
    if (isDone(t, statusById)) return false;
    return transitions.some((tr) => tr.from_status_id === t.status_id && isGated(tr) && canMove(tr, currentUserRole));
  });
}

// The specific gated moves available to the viewer from this task's current
// status — used to show "needs → In Review" style copy on the awaiting-
// review row.
export function gatedTransitionsFor(task: Task, transitions: WorkflowTransition[], currentUserRole: Role): WorkflowTransition[] {
  return transitions.filter((tr) => tr.from_status_id === task.status_id && isGated(tr) && canMove(tr, currentUserRole));
}

export interface DashboardStats {
  mine: Task[];
  overdue: Task[];
  dueSoon: Task[];
  awaiting: Task[];
}

export function addDaysIso(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

export function buildDashboardStats(
  tasks: Task[],
  statuses: WorkflowStatus[],
  transitions: WorkflowTransition[],
  currentUserId: string,
  currentUserRole: Role,
  today: string
): DashboardStats {
  const mine = myOpenTasks(tasks, statuses, currentUserId);
  // Helpdesk-project tickets have no real due date to judge (due_date is
  // null there) — excluded from due/overdue math rather than counted as
  // overdue by a null comparison.
  const scheduledMine = mine.filter((t) => t.due_date !== null);
  const overdue = scheduledMine.filter((t) => t.due_date! < today);
  const dueSoon = scheduledMine.filter((t) => t.due_date! >= today && t.due_date! <= addDaysIso(today, 7));
  const awaiting = tasksAwaitingReview(tasks, statuses, transitions, currentUserRole);
  return { mine, overdue, dueSoon, awaiting };
}
