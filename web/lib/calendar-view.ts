// Pure, framework-agnostic helpers for the Calendar view — Round 10's
// ground-up rebuild (see alloy-development-log.md's Round 10 entry). No
// React, no Supabase — components/calendar-view.tsx wires this up to state
// and server actions.
//
// This calendar is Month-only (the old Week view/mode is gone entirely —
// an explicit choice, not a stopgap) and offers two layouts, switched by a
// toggle in the header:
//   - "rows": one row per person spanning the whole month, with that
//     person's tasks drawn as bars along their row — modeled on Outlook's
//     Scheduling Assistant / a shared team calendar. This is the primary,
//     workload-first view: a packed row IS the "too much on" signal, and
//     every day cell is click-to-reallocate.
//   - "grid": the classic 7-column day grid (what the old Month mode
//     looked like), kept for a more familiar whole-month browse, with a
//     compact workload summary strip above it standing in for the
//     row-by-row detail "rows" gives you.
//
// Workload is a disclosed simplification: the app has no capacity/hours
// data anywhere in the schema, so "load" is simply the count of tasks
// that overlap a person on a given day — how many things they're on at
// once, not a measure of effort. It's an honest, real signal rather than
// an invented one.
//
// Helpdesk-project tasks are excluded (unscheduled, no dates), same rule
// the Gantt uses (see gantt-view.ts).
//
// Date math below is UTC-safe throughout: parse via Date.UTC, manipulate
// via getUTC*/setUTC* only, format via toISOString() (safe precisely
// because the Date was built and mutated entirely through UTC methods).
// The old Calendar's local-parse + UTC-format mismatch (inherited from
// gantt-schedule.ts's addDays/daysBetween, now fixed at the source) was
// the root cause of "today" landing under the wrong weekday.

import type { TaskRow } from "./list-view";
import type { Project, Team } from "./types";
import { addDays, daysBetween } from "./gantt-schedule";
import { eligibleAssignees } from "./team-allocation";
import type { MemberSummary } from "./tasks-data";

export type CalendarLayout = "rows" | "grid";

// ---------------------------------------------------------------------
// Date-range math
// ---------------------------------------------------------------------

function utcDow(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sun … 6 = Sat
}

// Monday-start week, matching the rest of this port's en-GB date formatting
// (fmtDate in list-view.ts) and the Gantt's own Monday grid lines.
export function startOfWeek(iso: string): string {
  const dow = utcDow(iso);
  const back = dow === 0 ? 6 : dow - 1;
  return addDays(iso, -back);
}

export function startOfMonth(iso: string): string {
  return iso.slice(0, 7) + "-01";
}

export function addMonths(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCMonth(dt.getUTCMonth() + n);
  return dt.toISOString().slice(0, 10);
}

// The 6-row (42-day) grid the "grid" layout renders, starting on the
// Monday on/before the 1st and always running a full 6 weeks so the grid
// height never jumps between months.
export function monthGridStart(iso: string): string {
  return startOfWeek(startOfMonth(iso));
}

export function weekDays(weekStartIso: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStartIso, i));
}

export function monthGridWeeks(iso: string): string[][] {
  const gridStart = monthGridStart(iso);
  return Array.from({ length: 6 }, (_, w) => weekDays(addDays(gridStart, w * 7)));
}

// The actual days in the month (28-31 of them, no leading/trailing days
// from adjacent months) — the "rows" layout's column set, a real month
// timeline rather than the "grid" layout's padded 7x6 grid.
export function monthDays(iso: string): string[] {
  const [y, m] = iso.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const start = startOfMonth(iso);
  return Array.from({ length: daysInMonth }, (_, i) => addDays(start, i));
}

export function isSameMonth(iso: string, monthAnchorIso: string): boolean {
  return iso.slice(0, 7) === monthAnchorIso.slice(0, 7);
}

export function isWeekend(iso: string): boolean {
  const dow = utcDow(iso);
  return dow === 0 || dow === 6;
}

export function monthLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

// ---------------------------------------------------------------------
// Team-grouped people tree
// ---------------------------------------------------------------------

export interface CalendarPerson {
  userId: string;
  name: string;
}

export interface CalendarTeamGroup {
  teamName: string;
  color: string | null;
  people: CalendarPerson[];
}

// Groups people by team name (merged across projects, same pattern as the
// sidebar's own team filter / buckets-view's merge-by-name) rather than by
// project — a manager scanning for a team doesn't want to know which
// project someone's tasks happen to sit in first. A team's people list is
// the union of its registered team_members and whoever currently holds a
// task on it, so a member with zero current tasks still appears.
export function calendarPeopleGroups(params: {
  teams: Team[];
  rows: TaskRow[];
  memberNameById: Map<string, string>;
  teamMemberIdsByTeam: Map<string, string[]>;
}): CalendarTeamGroup[] {
  const { teams, rows, memberNameById, teamMemberIdsByTeam } = params;

  const byName = new Map<string, { color: string | null; userIds: Set<string> }>();
  const order: string[] = [];

  function bucket(name: string, color: string | null) {
    let b = byName.get(name);
    if (!b) {
      b = { color, userIds: new Set() };
      byName.set(name, b);
      order.push(name);
    } else if (!b.color && color) {
      b.color = color;
    }
    return b;
  }

  teams.forEach((t) => {
    const b = bucket(t.name, t.color);
    (teamMemberIdsByTeam.get(t.id) ?? []).forEach((uid) => b.userIds.add(uid));
  });

  rows.forEach((r) => {
    if (!r.teamName || !r.task.assignee_id) return;
    const b = bucket(r.teamName, r.teamColor);
    b.userIds.add(r.task.assignee_id);
  });

  return order
    .map((teamName) => {
      const b = byName.get(teamName)!;
      const people = Array.from(b.userIds)
        .map((userId) => ({ userId, name: memberNameById.get(userId) ?? "?" }))
        .sort((a, b2) => a.name.localeCompare(b2.name));
      return { teamName, color: b.color, people };
    })
    .filter((g) => g.people.length > 0);
}

// ---------------------------------------------------------------------
// Event source rows (Helpdesk excluded, same rule as the Gantt)
// ---------------------------------------------------------------------

export interface CalendarEvent {
  row: TaskRow;
  start: string; // clamped/derived — see below
  end: string;
  isMilestone: boolean;
}

// A task with no due_date (but a start_date) is treated as a 1-day event; a
// task with neither is not placeable and is dropped, same as the Gantt
// silently giving it x=0/w=8 would be meaningless on a real calendar grid.
export function calendarEvents(params: {
  rows: TaskRow[];
  projects: Project[];
  selectedUserIds: Set<string> | null; // null = everyone
}): CalendarEvent[] {
  const { rows, projects, selectedUserIds } = params;
  const helpdeskProjectIds = new Set(projects.filter((p) => p.is_helpdesk).map((p) => p.id));

  const out: CalendarEvent[] = [];
  rows.forEach((r) => {
    if (helpdeskProjectIds.has(r.task.project_id)) return;
    if (selectedUserIds && (!r.task.assignee_id || !selectedUserIds.has(r.task.assignee_id))) return;
    const start = r.task.start_date;
    if (!start) return;
    const end = r.task.is_milestone ? start : r.task.due_date ?? start;
    out.push({ row: r, start, end: end < start ? start : end, isMilestone: r.task.is_milestone });
  });
  return out;
}

// ---------------------------------------------------------------------
// Greedy interval-packing lanes — shared by the "grid" layout's per-week
// rows and the "rows" layout's per-person month-wide rows. Sort by start,
// place each event in the first lane whose last-placed event doesn't
// overlap it, opening a new lane otherwise. An event that runs past either
// end of the visible range is clipped to it; the caller is responsible for
// re-rendering it (its own lane, possibly different) in whatever the next
// visible range is — the same "one continuous-looking bar via CSS Grid
// column span, no cross-row JS" approach used throughout this port.
// ---------------------------------------------------------------------

export interface LanedEvent {
  event: CalendarEvent;
  lane: number;
  colStart: number; // 1-based column within the caller's own range
  colSpan: number; // clipped to that range's column count
}

function packLanes(rangeStart: string, rangeEnd: string, events: CalendarEvent[]): LanedEvent[] {
  const inRange = events.filter((e) => e.start <= rangeEnd && e.end >= rangeStart);
  const sorted = [...inRange].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const laneEnds: string[] = []; // laneEnds[i] = last clipped end-date occupying lane i
  const result: LanedEvent[] = [];

  sorted.forEach((e) => {
    const clipStart = e.start < rangeStart ? rangeStart : e.start;
    const clipEnd = e.end > rangeEnd ? rangeEnd : e.end;
    const colStart = daysBetween(rangeStart, clipStart) + 1;
    const colSpan = daysBetween(clipStart, clipEnd) + 1;

    let lane = laneEnds.findIndex((end) => end < clipStart);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(clipEnd);
    } else {
      laneEnds[lane] = clipEnd;
    }

    result.push({ event: e, lane, colStart, colSpan });
  });

  return result;
}

export function packWeekLanes(weekStartIso: string, events: CalendarEvent[]): LanedEvent[] {
  return packLanes(weekStartIso, addDays(weekStartIso, 6), events);
}

export function laneCount(laned: LanedEvent[]): number {
  return laned.reduce((max, l) => Math.max(max, l.lane + 1), 0);
}

// A single person's events, lane-packed across the whole visible month
// (see monthDays) rather than a week at a time — the "rows" layout's bars.
export function personMonthLanes(monthDaysArr: string[], events: CalendarEvent[]): LanedEvent[] {
  if (monthDaysArr.length === 0) return [];
  return packLanes(monthDaysArr[0], monthDaysArr[monthDaysArr.length - 1], events);
}

// ---------------------------------------------------------------------
// Workload — see the file header for the disclosed "count of overlapping
// tasks" simplification (no capacity/hours data exists to measure against).
// ---------------------------------------------------------------------

// 0 = free that day, 1 = normal, 2 = busy, 3+ = overloaded. A starting
// point, not a tuned model.
export function loadLevel(taskCount: number): 0 | 1 | 2 | 3 {
  if (taskCount <= 0) return 0;
  if (taskCount === 1) return 1;
  if (taskCount === 2) return 2;
  return 3;
}

// Per-day overlap count for one person's events across a set of days.
export function personDayLoads(days: string[], personEvents: CalendarEvent[]): Map<string, number> {
  const loads = new Map<string, number>();
  days.forEach((d) => {
    const count = personEvents.filter((e) => e.start <= d && e.end >= d).length;
    loads.set(d, count);
  });
  return loads;
}

export interface PersonWorkloadSummary {
  userId: string;
  name: string;
  peakLoad: number; // busiest single day this month
  overloadedDays: number; // days at loadLevel 3 (3+ overlapping tasks)
}

// Feeds the "grid" layout's workload summary strip — a compact per-person
// readout for a manager scanning the whole team at a glance, standing in
// for the day-by-day detail the "rows" layout shows directly.
export function monthWorkloadSummary(
  people: CalendarPerson[],
  monthDaysArr: string[],
  events: CalendarEvent[]
): PersonWorkloadSummary[] {
  return people.map((p) => {
    const personEvents = events.filter((e) => e.row.task.assignee_id === p.userId);
    const loads = personDayLoads(monthDaysArr, personEvents);
    let peakLoad = 0;
    let overloadedDays = 0;
    loads.forEach((count) => {
      peakLoad = Math.max(peakLoad, count);
      if (loadLevel(count) === 3) overloadedDays += 1;
    });
    return { userId: p.userId, name: p.name, peakLoad, overloadedDays };
  });
}

// ---------------------------------------------------------------------
// Reallocation
// ---------------------------------------------------------------------

// The patch to pass to updateTaskFields() for allocating a backlog task
// (or reassigning any task) to a given person on a given day: assigns the
// person and moves the task to start that day, keeping its original
// duration. A milestone or a task with no due_date keeps due_date
// null/absent. A backlog task with neither date yet defaults to a 1-day
// placement.
export function allocationPatch(
  task: { start_date: string | null; due_date: string | null; is_milestone: boolean },
  userId: string,
  onDate: string
): { assignee_id: string; start_date: string; due_date: string | null } {
  if (task.is_milestone) {
    return { assignee_id: userId, start_date: onDate, due_date: null };
  }
  const durationDays = task.start_date && task.due_date ? daysBetween(task.start_date, task.due_date) : 0;
  return { assignee_id: userId, start_date: onDate, due_date: addDays(onDate, Math.max(0, durationDays)) };
}

// "Eligible backlog tasks" for the "Allocate to <Name>" panel: org tasks
// still sitting in the "backlog" workflow status (i.e. not yet scheduled/
// started — see actions.ts's seeded statuses) whose own team, if any,
// would accept this person as assignee under the same eligibility rule the
// Assignee picker already uses (team-allocation.ts's eligibleAssignees) —
// so turning Team allocation on also narrows what a manager can drop onto
// someone's calendar, not just what they can hand-pick in the task panel.
export function eligibleBacklogTasksFor(params: {
  userId: string;
  rows: TaskRow[];
  members: MemberSummary[];
  teamMemberIdsByTeam: Map<string, string[]>;
  orgTeamAllocationEnabled: boolean;
}): TaskRow[] {
  const { userId, rows, members, teamMemberIdsByTeam, orgTeamAllocationEnabled } = params;
  return rows.filter((r) => {
    if (r.statusKey !== "backlog") return false;
    const eligible = eligibleAssignees(members, r.task.team_id, teamMemberIdsByTeam, orgTeamAllocationEnabled, r.task.assignee_id);
    return eligible.some((e) => e.member.userId === userId);
  });
}
