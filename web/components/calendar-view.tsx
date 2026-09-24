"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Task, Project, Team } from "@/lib/types";
import type { TaskRow } from "@/lib/list-view";
import { fmtDate } from "@/lib/list-view";
import type { MemberSummary } from "@/lib/tasks-data";
import { updateTaskFields } from "@/lib/actions";
import { eligibleAssignees } from "@/lib/team-allocation";
import { DateGuideField } from "@/components/date-guide-field";
import {
  addMonths,
  allocationPatch,
  calendarEvents,
  calendarPeopleGroups,
  eligibleBacklogTasksFor,
  isSameMonth,
  isWeekend,
  laneCount,
  loadLevel,
  monthDays,
  monthGridWeeks,
  monthLabel,
  monthWorkloadSummary,
  packWeekLanes,
  personDayLoads,
  personMonthLanes,
  type CalendarLayout,
  type CalendarPerson,
} from "@/lib/calendar-view";

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const LOAD_LABEL = ["Free", "Normal", "Busy", "Overloaded"];

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
  const [layout, setLayout] = useState<CalendarLayout>("rows");
  const [anchor, setAnchor] = useState(todayIso);
  const [excludedUserIds, setExcludedUserIds] = useState<Set<string>>(new Set());
  const [allocating, setAllocating] = useState<{ userId: string; userName: string; date: string } | null>(null);
  const [reassigningId, setReassigningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const memberNameById = useMemo(() => new Map(members.map((m) => [m.userId, m.name])), [members]);
  // Keyed by id and re-derived fresh from the live `rows` prop on every
  // render (never a stored snapshot) — the same reason task-panel.tsx's
  // own field editors always look the current task up via allRows.find(...)
  // rather than holding one in local state: after a save triggers
  // router.refresh(), a stale snapshot would make the panel's own fields
  // appear to silently revert.
  const rowByTaskId = useMemo(() => new Map(rows.map((r) => [r.task.id, r])), [rows]);
  const reassigningRow = reassigningId ? rowByTaskId.get(reassigningId) ?? null : null;

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
  const visiblePeople = useMemo(() => groups.flatMap((g) => g.people).filter((p) => !excludedUserIds.has(p.userId)), [groups, excludedUserIds]);
  const days = useMemo(() => monthDays(anchor), [anchor]);

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
    setAnchor((a) => addMonths(a, -1));
  }
  function goNext() {
    setAnchor((a) => addMonths(a, 1));
  }
  function goToday() {
    setAnchor(todayIso);
  }

  function run(action: () => Promise<unknown>) {
    setError(null);
    startTransition(async () => {
      try {
        await action();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      }
    });
  }

  function assign(taskId: string, task: { start_date: string | null; due_date: string | null; is_milestone: boolean }, userId: string, date: string) {
    run(async () => {
      await updateTaskFields(taskId, allocationPatch(task, userId, date));
      setAllocating(null);
    });
  }

  return (
    <div className="cal-shell">
      <div className="view-head">
        <div>
          <div className="view-title">Calendar</div>
          <div className="view-sub">{monthLabel(anchor)}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div className="view-tabs" style={{ marginBottom: 0 }}>
            <button type="button" className={`view-tab ${layout === "rows" ? "active" : ""}`} onClick={() => setLayout("rows")}>
              Rows
            </button>
            <button type="button" className={`view-tab ${layout === "grid" ? "active" : ""}`} onClick={() => setLayout("grid")}>
              Grid
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

      {error && (
        <div className="banner" style={{ color: "var(--blocked)", background: "var(--blocked-bg)", marginBottom: 12 }}>
          {error}
        </div>
      )}

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
          {layout === "rows" && (
            <RowsLayout
              days={days}
              people={visiblePeople}
              events={events}
              todayIso={todayIso}
              onOpenTask={(row) => setReassigningId(row.task.id)}
              onEmptyClick={(userId, userName, date) => setAllocating({ userId, userName, date })}
            />
          )}
          {layout === "grid" && (
            <GridLayout
              anchor={anchor}
              days={days}
              people={visiblePeople}
              events={events}
              todayIso={todayIso}
              onOpenTask={(row) => setReassigningId(row.task.id)}
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

      {reassigningRow && (
        <TaskReassignPanel
          row={reassigningRow}
          rowByTaskId={rowByTaskId}
          members={members}
          teamMemberIdsByTeam={teamMemberIdsByTeam}
          orgTeamAllocationEnabled={orgTeamAllocationEnabled}
          run={run}
          onViewDetails={(id, x, y) => {
            setReassigningId(null);
            onPreviewTask(id, x, y);
          }}
          onClose={() => setReassigningId(null)}
        />
      )}
    </div>
  );
}

function EventChip({ row, onClick }: { row: TaskRow; onClick: (e: React.MouseEvent) => void }) {
  return (
    <button
      type="button"
      className="cal-event"
      style={{ ["--cal-event-accent" as string]: row.teamColor ?? "var(--accent)" }}
      onClick={onClick}
      title={row.task.title}
    >
      {row.task.is_milestone && "◆ "}
      {row.task.display_id && <span className="cal-event-id">{row.task.display_id}</span>}
      {row.task.title}
    </button>
  );
}

// ---------------------------------------------------------------------
// "Rows" layout — one row per person, spanning the whole month
// ---------------------------------------------------------------------

function RowsLayout({
  days,
  people,
  events,
  todayIso,
  onOpenTask,
  onEmptyClick,
}: {
  days: string[];
  people: CalendarPerson[];
  events: ReturnType<typeof calendarEvents>;
  todayIso: string;
  onOpenTask: (row: TaskRow) => void;
  onEmptyClick: (userId: string, userName: string, date: string) => void;
}) {
  if (people.length === 0) {
    return <p className="view-sub" style={{ padding: 14 }}>No one to show — check someone in the tree on the left.</p>;
  }

  const cols = `160px repeat(${days.length}, minmax(22px, 1fr))`;

  return (
    <div className="cal-rows">
      <div className="cal-rows-header" style={{ gridTemplateColumns: cols }}>
        <div className="cal-byperson-corner" />
        {days.map((d) => (
          <div key={d} className={`cal-daynum cal-rows-daynum ${isWeekend(d) ? "weekend" : ""}`}>
            <span className={`cal-daynum-badge ${d === todayIso ? "today" : ""}`}>{Number(d.slice(8, 10))}</span>
          </div>
        ))}
      </div>
      {people.map((p) => (
        <PersonRow key={p.userId} person={p} days={days} events={events} todayIso={todayIso} cols={cols} onOpenTask={onOpenTask} onEmptyClick={onEmptyClick} />
      ))}
    </div>
  );
}

function PersonRow({
  person,
  days,
  events,
  todayIso,
  cols,
  onOpenTask,
  onEmptyClick,
}: {
  person: CalendarPerson;
  days: string[];
  events: ReturnType<typeof calendarEvents>;
  todayIso: string;
  cols: string;
  onOpenTask: (row: TaskRow) => void;
  onEmptyClick: (userId: string, userName: string, date: string) => void;
}) {
  const personEvents = useMemo(() => events.filter((e) => e.row.task.assignee_id === person.userId), [events, person.userId]);
  const laned = useMemo(() => personMonthLanes(days, personEvents), [days, personEvents]);
  const lanes = Math.max(1, laneCount(laned));
  const loads = useMemo(() => personDayLoads(days, personEvents), [days, personEvents]);
  const laneRowH = 24;

  return (
    <div className="cal-personrow" style={{ gridTemplateColumns: cols, gridTemplateRows: `repeat(${lanes}, ${laneRowH}px)` }}>
      <div className="cal-byperson-name" style={{ gridColumn: 1, gridRow: "1 / -1" }}>
        {person.name}
      </div>
      {days.map((d, i) => {
        const load = loadLevel(loads.get(d) ?? 0);
        return (
          <button
            key={d}
            type="button"
            className={`cal-daycell-bg cal-load-${load} ${isWeekend(d) ? "weekend" : ""} ${d === todayIso ? "cal-day-today-col" : ""}`}
            style={{ gridColumn: i + 2, gridRow: "1 / -1" }}
            onClick={() => load === 0 && onEmptyClick(person.userId, person.name, d)}
            aria-label={load === 0 ? `Allocate to ${person.name} on ${fmtDate(d)}` : undefined}
            title={load === 0 ? `Allocate to ${person.name} — ${fmtDate(d)}` : `${LOAD_LABEL[load]} — ${loads.get(d)} task${loads.get(d) === 1 ? "" : "s"}`}
          />
        );
      })}
      {laned.map((l) => (
        <div key={l.event.row.task.id} style={{ gridColumn: `${l.colStart + 1} / span ${l.colSpan}`, gridRow: l.lane + 1, padding: "0 2px" }}>
          <EventChip row={l.event.row} onClick={() => onOpenTask(l.event.row)} />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------
// "Grid" layout — the classic 7-column month grid, with a workload strip
// ---------------------------------------------------------------------

function GridLayout({
  anchor,
  days,
  people,
  events,
  todayIso,
  onOpenTask,
}: {
  anchor: string;
  days: string[];
  people: CalendarPerson[];
  events: ReturnType<typeof calendarEvents>;
  todayIso: string;
  onOpenTask: (row: TaskRow) => void;
}) {
  const summary = useMemo(() => monthWorkloadSummary(people, days, events), [people, days, events]);
  const weeks = monthGridWeeks(anchor);

  return (
    <div>
      {summary.length > 0 && (
        <div className="cal-workload-strip">
          {summary.map((s) => {
            const level = s.overloadedDays > 0 ? 3 : s.peakLoad === 2 ? 2 : s.peakLoad === 1 ? 1 : 0;
            return (
              <div key={s.userId} className={`cal-workload-pill cal-load-${level}`} title={`Busiest day: ${s.peakLoad} task${s.peakLoad === 1 ? "" : "s"} at once${s.overloadedDays > 0 ? ` · overloaded ${s.overloadedDays} day${s.overloadedDays === 1 ? "" : "s"} this month` : ""}`}>
                <span className="cal-workload-name">{s.name}</span>
                <span className="cal-workload-peak">{s.peakLoad}</span>
              </div>
            );
          })}
        </div>
      )}
      <div className="cal-month">
        {weeks.map((week, i) => (
          <WeekRow key={week[0]} weekStart={week[0]} events={events} todayIso={todayIso} onOpenTask={onOpenTask} showHeader={i === 0} dimOutsideMonth={anchor} />
        ))}
      </div>
    </div>
  );
}

function WeekRow({
  weekStart,
  events,
  todayIso,
  onOpenTask,
  showHeader,
  dimOutsideMonth,
}: {
  weekStart: string;
  events: ReturnType<typeof calendarEvents>;
  todayIso: string;
  onOpenTask: (row: TaskRow) => void;
  showHeader: boolean;
  dimOutsideMonth?: string; // month-anchor iso — days outside this month render muted
}) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const [y, m, d] = weekStart.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + i);
    return dt.toISOString().slice(0, 10);
  });
  const laned = packWeekLanes(weekStart, events);
  const lanes = Math.max(1, laneCount(laned));
  const laneRowH = 22;

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
          <EventChip row={l.event.row} onClick={() => onOpenTask(l.event.row)} />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------

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

// Click-to-open reallocation panel for an existing task: change who it's
// assigned to and/or its dates, right from the calendar, without leaving
// it — the manager-facing "adjust and reallocate" ask this rebuild is
// built around. Fields save instantly on change, same convention every
// other field editor in this port uses (task-panel.tsx's own Dates/
// Assignee fields), rather than a staged Save/Cancel form.
function TaskReassignPanel({
  row,
  rowByTaskId,
  members,
  teamMemberIdsByTeam,
  orgTeamAllocationEnabled,
  run,
  onViewDetails,
  onClose,
}: {
  row: TaskRow;
  rowByTaskId: Map<string, TaskRow>;
  members: MemberSummary[];
  teamMemberIdsByTeam: Map<string, string[]>;
  orgTeamAllocationEnabled: boolean;
  run: (action: () => Promise<unknown>) => void;
  onViewDetails: (taskId: string, x: number, y: number) => void;
  onClose: () => void;
}) {
  const task = row.task;
  const parentRow = task.parent_task_id ? rowByTaskId.get(task.parent_task_id) : undefined;
  const parentGuideStart = parentRow?.task.start_date ?? null;
  const parentGuideDue = parentRow?.task.due_date ?? null;

  function field(patch: Partial<Task>) {
    run(() => updateTaskFields(task.id, patch));
  }

  return (
    <>
      <div className="scrim show" onClick={onClose} />
      <aside className="panel show">
        <div className="panel-head">
          <div style={{ flex: 1, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16 }}>
            {task.display_id && <span className="task-id-badge" style={{ marginRight: 6 }}>{task.display_id}</span>}
            {task.title}
          </div>
          <button className="icon-btn panel-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="panel-body">
          <div className="field-group">
            <span className="field-label">Assignee</span>
            <select
              className="select-input"
              defaultValue={task.assignee_id ?? ""}
              onChange={(e) => field({ assignee_id: e.target.value || null })}
            >
              <option value="">Unassigned</option>
              {eligibleAssignees(members, task.team_id, teamMemberIdsByTeam, orgTeamAllocationEnabled, task.assignee_id).map(
                ({ member: m, isTeamMember }) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name}
                    {!isTeamMember ? " (not on this team)" : ""}
                  </option>
                )
              )}
            </select>
          </div>

          <div className="field-group">
            <span className="field-label">Dates</span>
            {task.is_milestone ? (
              <DateGuideField
                value={task.start_date ?? ""}
                onChange={(v) => field({ start_date: v, due_date: v })}
                guideStart={parentGuideStart}
                guideDue={parentGuideDue}
              />
            ) : (
              <div className="date-box-row">
                <DateGuideField
                  label="Start"
                  value={task.start_date ?? ""}
                  onChange={(v) => field({ start_date: v })}
                  guideStart={parentGuideStart}
                  guideDue={parentGuideDue}
                />
                <DateGuideField
                  label="Due"
                  value={task.due_date ?? ""}
                  onChange={(v) => field({ due_date: v })}
                  guideStart={parentGuideStart}
                  guideDue={parentGuideDue}
                />
              </div>
            )}
          </div>

          <button
            type="button"
            className="ghost-btn"
            style={{ width: "100%", marginTop: 6 }}
            onClick={(e) => onViewDetails(task.id, e.clientX, e.clientY)}
          >
            View full details →
          </button>
        </div>
      </aside>
    </>
  );
}
