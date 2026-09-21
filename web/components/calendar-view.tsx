"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { TaskRow } from "@/lib/list-view";
import { fmtDate } from "@/lib/list-view";
import type { Project, Team } from "@/lib/types";
import type { MemberSummary } from "@/lib/tasks-data";
import { updateTaskFields } from "@/lib/actions";
import {
  addMonths,
  allocationPatch,
  byPersonWeekGrid,
  calendarEvents,
  calendarPeopleGroups,
  eligibleBacklogTasksFor,
  isSameMonth,
  isWeekend,
  monthGridWeeks,
  monthLabel,
  packWeekLanes,
  startOfWeek,
  weekDays,
  weekRangeLabel,
  type CalendarMode,
  type CalendarPerson,
} from "@/lib/calendar-view";
import { addDays } from "@/lib/gantt-schedule";

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function CalendarView({
  rows,
  projects,
  teams,
  members,
  teamMemberIdsByTeam,
  orgTeamAllocationEnabled,
  vocabTask,
  onPreviewTask,
}: {
  rows: TaskRow[];
  projects: Project[];
  teams: Team[];
  members: MemberSummary[];
  teamMemberIdsByTeam: Map<string, string[]>;
  orgTeamAllocationEnabled: boolean;
  vocabTask: string;
  onPreviewTask: (id: string, x: number, y: number) => void;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [mode, setMode] = useState<CalendarMode>("month");
  const [anchor, setAnchor] = useState(todayIso);
  const [excludedUserIds, setExcludedUserIds] = useState<Set<string>>(new Set());
  const [byPerson, setByPerson] = useState(false);
  const [allocating, setAllocating] = useState<{ userId: string; userName: string; date: string } | null>(null);

  const memberNameById = useMemo(() => new Map(members.map((m) => [m.userId, m.name])), [members]);

  const groups = useMemo(
    () => calendarPeopleGroups({ teams, rows, memberNameById, teamMemberIdsByTeam }),
    [teams, rows, memberNameById, teamMemberIdsByTeam]
  );
  const allUserIds = useMemo(() => new Set(groups.flatMap((g) => g.people.map((p) => p.userId))), [groups]);

  // null = no filtering applied at all (show everyone, including tasks with
  // no assignee yet) — the default, unfiltered state. Once anyone is
  // unchecked, the calendar narrows to exactly the still-checked people (an
  // unassigned task has no one to match, so it drops out of view — a
  // disclosed simplification of a tree that's people-only by design).
  const selectedUserIds = excludedUserIds.size === 0 ? null : new Set([...allUserIds].filter((id) => !excludedUserIds.has(id)));

  const events = useMemo(() => calendarEvents({ rows, projects, selectedUserIds }), [rows, projects, selectedUserIds]);

  function toggleTeam(teamName: string, peopleIds: string[], nowExcluded: boolean) {
    setExcludedUserIds((prev) => {
      const next = new Set(prev);
      peopleIds.forEach((id) => (nowExcluded ? next.add(id) : next.delete(id)));
      return next;
    });
  }
  function togglePerson(userId: string, nowExcluded: boolean) {
    setExcludedUserIds((prev) => {
      const next = new Set(prev);
      if (nowExcluded) next.add(userId);
      else next.delete(userId);
      return next;
    });
  }
  function toggleAll(nowExcluded: boolean) {
    setExcludedUserIds(nowExcluded ? new Set(allUserIds) : new Set());
  }

  function goPrev() {
    setAnchor((a) => (mode === "month" ? addMonths(a, -1) : addDays(startOfWeek(a), -7)));
  }
  function goNext() {
    setAnchor((a) => (mode === "month" ? addMonths(a, 1) : addDays(startOfWeek(a), 7)));
  }
  function goToday() {
    setAnchor(todayIso);
  }

  function assign(taskId: string, task: { start_date: string | null; due_date: string | null; is_milestone: boolean }, userId: string, date: string) {
    const patch = allocationPatch(task, userId, date);
    startTransition(async () => {
      await updateTaskFields(taskId, patch);
      router.refresh();
      setAllocating(null);
    });
  }

  const weekStart = startOfWeek(anchor);

  return (
    <div className="cal-shell">
      <div className="view-head">
        <div>
          <div className="view-title">Calendar</div>
          <div className="view-sub">{mode === "month" ? monthLabel(anchor) : weekRangeLabel(weekStart)}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {mode === "week" && (
            <label className="checkbox-row" style={{ marginRight: 6 }}>
              <input type="checkbox" checked={byPerson} onChange={(e) => setByPerson(e.target.checked)} />
              By person
            </label>
          )}
          <div className="view-tabs" style={{ marginBottom: 0 }}>
            <button type="button" className={`view-tab ${mode === "month" ? "active" : ""}`} onClick={() => setMode("month")}>
              Month
            </button>
            <button type="button" className={`view-tab ${mode === "week" ? "active" : ""}`} onClick={() => setMode("week")}>
              Week
            </button>
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            <button type="button" className="icon-btn" onClick={goPrev} aria-label="Previous">
              ‹
            </button>
            <button type="button" className="primary-btn" onClick={goToday} style={{ padding: "6px 10px" }}>
              Today
            </button>
            <button type="button" className="icon-btn" onClick={goNext} aria-label="Next">
              ›
            </button>
          </div>
        </div>
      </div>

      <div className="cal-body">
        <aside className="cal-tree">
          <label className="checkbox-row cal-tree-all">
            <input type="checkbox" checked={excludedUserIds.size === 0} onChange={(e) => toggleAll(!e.target.checked)} />
            All people
          </label>
          {groups.map((g) => {
            const ids = g.people.map((p) => p.userId);
            const excludedCount = ids.filter((id) => excludedUserIds.has(id)).length;
            const allExcluded = excludedCount === ids.length;
            const someExcluded = excludedCount > 0 && !allExcluded;
            return (
              <div key={g.teamName} className="cal-tree-team">
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={!allExcluded}
                    ref={(el) => {
                      if (el) el.indeterminate = someExcluded;
                    }}
                    onChange={(e) => toggleTeam(g.teamName, ids, !e.target.checked)}
                  />
                  <span className="cal-tree-dot" style={{ background: g.color ?? "var(--text-faint)" }} />
                  {g.teamName}
                </label>
                <div className="cal-tree-people">
                  {g.people.map((p) => (
                    <label key={p.userId} className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={!excludedUserIds.has(p.userId)}
                        onChange={(e) => togglePerson(p.userId, !e.target.checked)}
                      />
                      {p.name}
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </aside>

        <div className="cal-grid-wrap">
          {mode === "month" && <MonthGrid anchor={anchor} events={events} todayIso={todayIso} onPreviewTask={onPreviewTask} />}
          {mode === "week" && !byPerson && (
            <WeekGrid weekStart={weekStart} events={events} todayIso={todayIso} onPreviewTask={onPreviewTask} big />
          )}
          {mode === "week" && byPerson && (
            <ByPersonGrid
              weekStart={weekStart}
              people={groups.flatMap((g) => g.people).filter((p) => !excludedUserIds.has(p.userId))}
              events={events}
              todayIso={todayIso}
              onPreviewTask={onPreviewTask}
              onEmptyClick={(userId, userName, date) => setAllocating({ userId, userName, date })}
            />
          )}
        </div>
      </div>

      {allocating && (
        <AllocatePanel
          userName={allocating.userName}
          date={allocating.date}
          tasks={eligibleBacklogTasksFor({
            userId: allocating.userId,
            rows,
            members,
            teamMemberIdsByTeam,
            orgTeamAllocationEnabled,
          })}
          vocabTask={vocabTask}
          onAssign={(taskId, task) => assign(taskId, task, allocating.userId, allocating.date)}
          onClose={() => setAllocating(null)}
        />
      )}
    </div>
  );
}

function EventChip({ row, onPreviewTask }: { row: TaskRow; onPreviewTask: (id: string, x: number, y: number) => void }) {
  return (
    <button
      type="button"
      className="cal-event"
      style={{ ["--cal-event-accent" as string]: row.teamColor ?? "var(--accent)" }}
      onClick={(e) => onPreviewTask(row.task.id, e.clientX, e.clientY)}
      title={row.task.title}
    >
      {row.task.is_milestone && "◆ "}
      {row.task.display_id && <span className="cal-event-id">{row.task.display_id}</span>}
      {row.task.title}
    </button>
  );
}

function WeekRow({
  weekStart,
  events,
  todayIso,
  onPreviewTask,
  showHeader,
  big,
  dimOutsideMonth,
}: {
  weekStart: string;
  events: ReturnType<typeof calendarEvents>;
  todayIso: string;
  onPreviewTask: (id: string, x: number, y: number) => void;
  showHeader: boolean;
  big?: boolean;
  dimOutsideMonth?: string; // month-anchor iso — days outside this month render muted
}) {
  const days = weekDays(weekStart);
  const laned = packWeekLanes(weekStart, events);
  const lanes = Math.max(1, laned.reduce((m, l) => Math.max(m, l.lane + 1), 0));
  const laneRowH = big ? 26 : 20;

  return (
    <div className="cal-week" style={{ gridTemplateColumns: "repeat(7, 1fr)", gridTemplateRows: `auto repeat(${lanes}, ${laneRowH}px)` }}>
      {days.map((d, i) => (
        <div
          key={d}
          className={`cal-daycell-bg ${isWeekend(d) ? "weekend" : ""} ${dimOutsideMonth && !isSameMonth(d, dimOutsideMonth) ? "cal-day-dim" : ""}`}
          style={{ gridColumn: i + 1, gridRow: "1 / -1" }}
        />
      ))}
      {days.map((d, i) => (
        <div
          key={`n-${d}`}
          className={`cal-daynum ${dimOutsideMonth && !isSameMonth(d, dimOutsideMonth) ? "cal-day-dim" : ""}`}
          style={{ gridColumn: i + 1, gridRow: 1 }}
        >
          {showHeader && <span className="cal-weekday-label">{WEEKDAY_LABELS[i]}</span>}
          <span className={`cal-daynum-badge ${d === todayIso ? "today" : ""}`}>{Number(d.slice(8, 10))}</span>
        </div>
      ))}
      {laned.map((l) => (
        <div key={l.event.row.task.id} style={{ gridColumn: `${l.colStart} / span ${l.colSpan}`, gridRow: l.lane + 2, padding: "0 2px" }}>
          <EventChip row={l.event.row} onPreviewTask={onPreviewTask} />
        </div>
      ))}
    </div>
  );
}

function MonthGrid({
  anchor,
  events,
  todayIso,
  onPreviewTask,
}: {
  anchor: string;
  events: ReturnType<typeof calendarEvents>;
  todayIso: string;
  onPreviewTask: (id: string, x: number, y: number) => void;
}) {
  const weeks = monthGridWeeks(anchor);
  return (
    <div className="cal-month">
      {weeks.map((week, i) => (
        <WeekRow
          key={week[0]}
          weekStart={week[0]}
          events={events}
          todayIso={todayIso}
          onPreviewTask={onPreviewTask}
          showHeader={i === 0}
          dimOutsideMonth={anchor}
        />
      ))}
    </div>
  );
}

function WeekGrid({
  weekStart,
  events,
  todayIso,
  onPreviewTask,
  big,
}: {
  weekStart: string;
  events: ReturnType<typeof calendarEvents>;
  todayIso: string;
  onPreviewTask: (id: string, x: number, y: number) => void;
  big?: boolean;
}) {
  return (
    <div className="cal-week-solo">
      <WeekRow weekStart={weekStart} events={events} todayIso={todayIso} onPreviewTask={onPreviewTask} showHeader big={big} />
    </div>
  );
}

function ByPersonGrid({
  weekStart,
  people,
  events,
  todayIso,
  onPreviewTask,
  onEmptyClick,
}: {
  weekStart: string;
  people: CalendarPerson[];
  events: ReturnType<typeof calendarEvents>;
  todayIso: string;
  onPreviewTask: (id: string, x: number, y: number) => void;
  onEmptyClick: (userId: string, userName: string, date: string) => void;
}) {
  const days = weekDays(weekStart);
  const grid = byPersonWeekGrid(weekStart, people, events);

  if (people.length === 0) {
    return <p className="view-sub">No one to show — check someone in the tree on the left.</p>;
  }

  return (
    <div className="cal-byperson" style={{ gridTemplateColumns: `140px repeat(7, 1fr)` }}>
      <div className="cal-byperson-corner" />
      {days.map((d, i) => (
        <div key={d} className="cal-daynum" style={{ gridColumn: i + 2, gridRow: 1 }}>
          <span className="cal-weekday-label">{WEEKDAY_LABELS[i]}</span>
          <span className={`cal-daynum-badge ${d === todayIso ? "today" : ""}`}>{Number(d.slice(8, 10))}</span>
        </div>
      ))}
      {grid.map((row, r) => (
        <div key={people[r].userId} className="cal-byperson-name" style={{ gridColumn: 1, gridRow: r + 2 }}>
          {people[r].name}
        </div>
      ))}
      {grid.map((row, r) =>
        row.map((cell, c) => (
          <div key={`${people[r].userId}-${cell.date}`} className="cal-byperson-cell" style={{ gridColumn: c + 2, gridRow: r + 2 }}>
            {cell.events.length === 0 ? (
              <button
                type="button"
                className="cal-byperson-add"
                onClick={() => onEmptyClick(people[r].userId, people[r].name, cell.date)}
                aria-label={`Allocate to ${people[r].name} on ${fmtDate(cell.date)}`}
              >
                +
              </button>
            ) : (
              cell.events.map((e) => <EventChip key={e.row.task.id} row={e.row} onPreviewTask={onPreviewTask} />)
            )}
          </div>
        ))
      )}
    </div>
  );
}

function AllocatePanel({
  userName,
  date,
  tasks,
  vocabTask,
  onAssign,
  onClose,
}: {
  userName: string;
  date: string;
  tasks: TaskRow[];
  vocabTask: string;
  onAssign: (taskId: string, task: { start_date: string | null; due_date: string | null; is_milestone: boolean }) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="scrim show" onClick={onClose} />
      <aside className="panel show">
        <div className="panel-head">
          <div style={{ flex: 1, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16 }}>
            Allocate to {userName} — {fmtDate(date)}
          </div>
          <button className="icon-btn panel-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="panel-body">
          {tasks.length === 0 && <p className="view-sub">No eligible backlog {vocabTask.toLowerCase()}s for {userName} right now.</p>}
          {tasks.map((r) => (
            <div key={r.task.id} className="cal-allocate-row">
              <div>
                {r.task.display_id && <span className="task-id-badge" style={{ marginRight: 6 }}>{r.task.display_id}</span>}
                {r.task.title}
              </div>
              <button className="primary-btn" onClick={() => onAssign(r.task.id, r.task)}>
                Assign
              </button>
            </div>
          ))}
          <p className="view-sub" style={{ marginTop: 10 }}>
            This sets the start date to {fmtDate(date)} (keeping the task&apos;s existing duration) and doesn&apos;t re-run
            Auto-arrange — run it afterward if this task is linked to others.
          </p>
        </div>
      </aside>
    </>
  );
}
