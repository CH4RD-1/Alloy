// Pure, framework-agnostic helpers for the Calendar view — ported from the
// prototype's renderCalendarView() / v0.16 "team grouping & day-by-day
// allocation" redesign (see alloy-development-log.md). No React, no
// Supabase — components/calendar-view.tsx wires this up to state and
// server actions.
//
// Two disclosed simplifications from the prototype, both consistent with
// choices already made elsewhere in this port:
//   1. Bar/chip coloring uses the same TaskRow.teamColor accent every other
//      ported view (List/Buckets/Gantt) already uses, not the prototype's
//      "mine vs. others" muted convention — that convention was never
//      actually carried into this port's Gantt/Buckets views (they only
//      ever used teamColor), so Calendar matches what's really here rather
//      than a prototype behavior this port doesn't otherwise have.
//   2. "Allocate to <Name>" reuses the existing updateTaskFields action
//      (no new server action needed — it already accepts assignee_id/
//      start_date/due_date) via allocationPatch() below, which preserves
//      the task's original duration. It deliberately does NOT re-run the
//      dependency cascade live — matching this port's existing Auto-arrange
//      being a one-shot server action rather than the prototype's live
//      propagateSchedule() — so a linked task's own dates are left alone
//      until Auto-arrange is run again.
//
// Helpdesk-project tasks are excluded (unscheduled, no dates), same as the
// Gantt (see gantt-view.ts).

import type { TaskRow } from "./list-view";
import type { Project, Team } from "./types";
import { addDays, daysBetween } from "./gantt-schedule";
import { eligibleAssignees } from "./team-allocation";
import type { MemberSummary } from "./tasks-data";

export type CalendarMode = "month" | "week";

// ---------------------------------------------------------------------
// Date-range math
// ---------------------------------------------------------------------

// Monday-start week, matching the rest of this port's en-GB date formatting
// (fmtDate in list-view.ts) and the Gantt's own Monday grid lines.
export function startOfWeek(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  const dow = d.getDay(); // 0 = Sun … 6 = Sat
  const back = dow === 0 ? 6 : dow - 1;
  return addDays(iso, -back);
}

export function startOfMonth(iso: string): string {
  return iso.slice(0, 7) + "-01";
}

export function addMonths(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0, 10);
}

// The 6-row (42-day) grid a month view renders, starting on the Monday
// on/before the 1st and always running a full 6 weeks so the grid height
// never jumps between months.
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

export function isSameMonth(iso: string, monthAnchorIso: string): boolean {
  return iso.slice(0, 7) === monthAnchorIso.slice(0, 7);
}

export function isWeekend(iso: string): boolean {
  const dow = new Date(iso + "T00:00:00").getDay();
  return dow === 0 || dow === 6;
}

export function monthLabel(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

export function weekRangeLabel(weekStartIso: string): string {
  const end = addDays(weekStartIso, 6);
  const d1 = new Date(weekStartIso + "T00:00:00");
  const d2 = new Date(end + "T00:00:00");
  const sameMonth = d1.getMonth() === d2.getMonth() && d1.getFullYear() === d2.getFullYear();
  const startLabel = d1.toLocaleDateString("en-GB", { day: "numeric", month: sameMonth ? undefined : "short" });
  const endLabel = d2.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  return `${startLabel} – ${endLabel}`;
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
// project someone's tasks happen to sit in first (v0.16). A team's people
// list is the union of its registered team_members and whoever currently
// holds a task on it, so a member with zero current tasks still appears.
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
// Greedy interval-packing lanes (per week row)
// ---------------------------------------------------------------------

export interface LanedEvent {
  event: CalendarEvent;
  lane: number;
  colStart: number; // 1-based day-of-week column within this week row
  colSpan: number; // clipped to the week's 7 columns
}

// Packs a week's events into the fewest overlapping "lanes" (rows within
// the week's grid cell) via the classic greedy interval-scheduling packer:
// sort by start, and place each event in the first lane whose last-placed
// event doesn't overlap it, opening a new lane otherwise. An event that
// spans into an adjacent week is clipped to this week's 7 columns; the
// caller renders it again (its own lane, possibly different) in the next
// week's row — the same "one continuous-looking bar via CSS Grid column
// span, no cross-row JS" approach the prototype used.
export function packWeekLanes(weekStartIso: string, events: CalendarEvent[]): LanedEvent[] {
  const weekEnd = addDays(weekStartIso, 6);
  const inWeek = events.filter((e) => e.start <= weekEnd && e.end >= weekStartIso);

  const sorted = [...inWeek].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const laneEnds: string[] = []; // laneEnds[i] = last clipped end-date occupying lane i (as a day index sentinel)
  const result: LanedEvent[] = [];

  sorted.forEach((e) => {
    const clipStart = e.start < weekStartIso ? weekStartIso : e.start;
    const clipEnd = e.end > weekEnd ? weekEnd : e.end;
    const colStart = daysBetween(weekStartIso, clipStart) + 1;
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

export function laneCount(laned: LanedEvent[]): number {
  return laned.reduce((max, l) => Math.max(max, l.lane + 1), 0);
}

// ---------------------------------------------------------------------
// "By person" day-by-day availability grid (Week mode only)
// ---------------------------------------------------------------------

export interface PersonDayCell {
  userId: string;
  date: string;
  events: CalendarEvent[];
}

// The patch to pass to updateTaskFields() for "Allocate to <Name>" on a
// given day: assigns the person and moves the task to start that day,
// keeping its original duration (a milestone or a task with no due_date
// keeps due_date null/absent). Backlog tasks with neither date yet default
// to a 1-day placement.
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

export function byPersonWeekGrid(weekStartIso: string, people: CalendarPerson[], events: CalendarEvent[]): PersonDayCell[][] {
  const days = weekDays(weekStartIso);
  const byUser = new Map<string, CalendarEvent[]>();
  events.forEach((e) => {
    const uid = e.row.task.assignee_id;
    if (!uid) return;
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid)!.push(e);
  });

  return people.map((p) => {
    const userEvents = byUser.get(p.userId) ?? [];
    return days.map((date) => ({
      userId: p.userId,
      date,
      events: userEvents.filter((e) => e.start <= date && e.end >= date),
    }));
  });
}
