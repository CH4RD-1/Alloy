// Pure, framework-agnostic helpers for the Gantt view — ported from the
// prototype's renderGanttView() (see the "Live prototype" link in
// alloy-development-log.md), now with drag-to-move, drag-to-resize and
// drag-to-link (see gantt-view.tsx for the actual mouse handling — this
// file only computes geometry). Dependency connectors always run straight
// from bar edge to bar edge, the way the prototype's "External nodes: Off"
// mode drew them — there's no interactive node sitting on that edge to
// route around. "Auto-arrange" stays a one-shot server action
// (autoArrangeCompute in gantt-schedule.ts); a single drag/resize/link
// commits through cascadeSchedule in the same file instead.
//
// Reuses list-view.ts's already-computed TaskRow tree (teamColor, teamName,
// statusKey, etc.) rather than re-deriving those from raw tasks.

import type { TaskRow } from "./list-view";
import type { Project, TaskLink } from "./types";
import { addDays, daysBetween } from "./gantt-schedule";

export interface GanttRow {
  row: TaskRow;
  // 0 = a top-level task's own row, 1 = a subtask's row, 2 = a
  // sub-subtask's row (the deepest MAX_TASK_DEPTH allows — see
  // list-view.ts). Superseded the old boolean `sub` flag now that a
  // subtask can have its own expandable children.
  depth: number;
}

// Helpdesk-project tasks are unscheduled and never appear on the Gantt (see
// isHelpdeskProject/taskUnscheduled in the prototype) — even a task that
// would otherwise be expanded/visible is dropped along with its project.
//
// Top-level rows are sorted by task.position — the Gantt's own manual
// up/down reorder (see reorderGanttTasks in lib/actions.ts and
// task_position.sql's header) — rather than left in whatever order `rows`
// arrived in. Nothing else reads this field: List/Buckets/Calendar keep
// their existing sort untouched. Array.prototype.sort is stable in every
// engine this runs on, so untouched rows (position still the 0 default)
// keep their incoming relative order instead of jumbling. Subtasks are
// never reordered independently — they stay in whatever order their
// parent's own children array already gives them.
export function buildGanttRows(params: { rows: TaskRow[]; projects: Project[]; expanded: Set<string> }): GanttRow[] {
  const { rows, projects, expanded } = params;
  const helpdeskProjectIds = new Set(projects.filter((p) => p.is_helpdesk).map((p) => p.id));
  const visible = rows
    .filter((r) => !helpdeskProjectIds.has(r.task.project_id))
    .sort((a, b) => a.task.position - b.task.position);
  const out: GanttRow[] = [];
  // Recursive: a row's own children only ever get pushed while that row's
  // own id is in `expanded` — same Set for every depth, so a subtask
  // that's collapsed hides its own sub-subtasks exactly like a collapsed
  // top-level task hides its subtasks (and, transitively, a collapsed
  // top-level task's sub-subtasks stay hidden too, since their subtask
  // parent never gets visited).
  const pushRow = (r: TaskRow, depth: number) => {
    out.push({ row: r, depth });
    if (expanded.has(r.task.id)) {
      (r.children ?? []).forEach((c) => pushRow(c, depth + 1));
    }
  };
  visible.forEach((r) => pushRow(r, 0));
  return out;
}

export interface BarGeom {
  milestone: false;
  x: number;
  w: number;
  y: number;
  h: number;
  nodeCX: number; // trailing edge — where an outgoing connector starts
  nodeCY: number;
  leadCX: number; // leading edge — where an incoming connector ends
  linkCX: number; // the interactive "drag to link" handle — offset from
  linkCY: number; // the trailing edge (see LINK_DX/LINK_DY below), not on it
}
export interface MilestoneGeom {
  milestone: true;
  cx: number;
  y: number;
  h: number;
  s: number; // half-diagonal
  nodeCX: number;
  nodeCY: number;
  leadCX: number;
  linkCX: number;
  linkCY: number;
}
export type Geom = BarGeom | MilestoneGeom;

const DAY_W = 20;
const ROW_H = 34;
const HEADER_H = 40;

// How far the link handle sits from the bar's trailing edge. The prototype's
// "External nodes: Off" mode (its default) puts the drag-to-link node right
// on top of the bar's own end, which hides the resize-right handle
// underneath it — the exact complaint this offset fixes. Horizontal only —
// vertically centered on the bar, per the reference screenshot — with no
// vertical offset, unlike an earlier pass of this that also nudged it down.
export const LINK_DX = 16;
export const LINK_DY = 0;

export interface GanttLayout {
  minD: string;
  dayW: number;
  rowH: number;
  headerH: number;
  width: number;
  height: number;
  dateToX: (iso: string) => number;
  geom: Geom[];
  months: { x: number; label: string }[];
  mondayLines: number[];
  todayX: number | null;
}

// `minWidthPx` (the scroll container's own visible width, measured by the
// component) lets the chart's date range stretch past the last task so the
// grid keeps going to fill the viewport rather than stopping dead and
// leaving a blank, gridless strip on the right — see gantt-view.tsx's own
// ResizeObserver. Purely cosmetic: it only ever widens the range, so it
// never changes where an actual bar/connector/today-line ends up.
export function computeGanttLayout(rows: GanttRow[], todayIso: string, minWidthPx = 0): GanttLayout | null {
  if (!rows.length) return null;
  const allDates = rows.flatMap((r) => [r.row.task.start_date, r.row.task.due_date]).filter((d): d is string => !!d);
  if (!allDates.length) return null;

  let minD = allDates.reduce((a, b) => (a < b ? a : b));
  const maxD0 = allDates.reduce((a, b) => (a > b ? a : b));
  minD = addDays(minD, -4);
  let maxD = addDays(maxD0, 5);
  let totalDays = daysBetween(minD, maxD);
  let width = totalDays * DAY_W;
  if (minWidthPx > width) {
    const extraDays = Math.ceil((minWidthPx - width) / DAY_W);
    maxD = addDays(maxD, extraDays);
    totalDays = daysBetween(minD, maxD);
    width = totalDays * DAY_W;
  }
  const height = HEADER_H + rows.length * ROW_H;
  const dateToX = (iso: string) => daysBetween(minD, iso) * DAY_W;

  const months: { x: number; label: string }[] = [];
  const mondayLines: number[] = [];
  let lastMonth: string | null = null;
  for (let dayIdx = 0; dayIdx <= totalDays; dayIdx++) {
    const d = new Date(minD + "T00:00:00");
    d.setDate(d.getDate() + dayIdx);
    const mLabel = d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
    if (mLabel !== lastMonth) {
      months.push({ x: dayIdx * DAY_W, label: mLabel });
      lastMonth = mLabel;
    }
    if (d.getDay() === 1) mondayLines.push(dayIdx * DAY_W);
  }

  const geom: Geom[] = rows.map((r, i) => {
    const t = r.row.task;
    // Each level of nesting draws a narrower bar than its parent's — a
    // top-level task's own bar, a subtask's (matches the pre-round-8
    // "sub" bar size), and a sub-subtask's smaller still — the same +2px
    // top-offset/-4px height step repeated once more for the second
    // level of nesting.
    const y = HEADER_H + i * ROW_H + (r.depth >= 2 ? 9 : r.depth === 1 ? 7 : 5);
    const h = r.depth >= 2 ? 14 : r.depth === 1 ? 18 : 22;
    const nodeCY = y + h / 2;
    if (t.is_milestone) {
      const s = 7;
      const cx = t.start_date ? dateToX(t.start_date) : 0;
      const nodeCX = cx + s;
      return { milestone: true, cx, y, h, s, nodeCX, nodeCY, leadCX: cx - s, linkCX: nodeCX + LINK_DX, linkCY: nodeCY + LINK_DY };
    }
    const x = t.start_date ? dateToX(t.start_date) : 0;
    const w = t.start_date && t.due_date ? Math.max(8, dateToX(t.due_date) - x) : 8;
    const nodeCX = x + w;
    return { milestone: false, x, w, y, h, nodeCX, nodeCY, leadCX: x, linkCX: nodeCX + LINK_DX, linkCY: nodeCY + LINK_DY };
  });

  const todayX = dateToX(todayIso);

  return { minD, dayW: DAY_W, rowH: ROW_H, headerH: HEADER_H, width, height, dateToX, geom, months, mondayLines, todayX: todayX >= 0 && todayX <= width ? todayX : null };
}

export interface Connector {
  type: "blocked" | "concurrent" | "clone";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  // The task_links row this connector represents, in addLink/removeLink's
  // own convention (fromTaskId is the dependent/"owner" side that stores
  // the record even for a symmetric type) — carried through so the Gantt's
  // click-to-open-menu handler knows exactly which link row to change.
  fromTaskId: string;
  toTaskId: string;
}

// Only draws a connector when both ends are currently visible rows (a
// collapsed parent hides its subtasks' connectors, same as the prototype).
export function buildConnectors(rows: GanttRow[], geom: Geom[], links: TaskLink[]): Connector[] {
  const indexByTaskId = new Map(rows.map((r, i) => [r.row.task.id, i]));
  const connectors: Connector[] = [];

  rows.forEach((r, i) => {
    links
      .filter((l) => l.from_task_id === r.row.task.id && l.link_type === "blocked")
      .forEach((l) => {
        const j = indexByTaskId.get(l.to_task_id);
        if (j === undefined) return;
        const g1 = geom[j];
        const g2 = geom[i];
        connectors.push({ type: "blocked", x1: g1.nodeCX, y1: g1.nodeCY, x2: g2.leadCX, y2: g2.nodeCY, fromTaskId: r.row.task.id, toTaskId: l.to_task_id });
      });
  });

  const drawn = new Set<string>();
  (["concurrent", "clone"] as const).forEach((type) => {
    rows.forEach((r, i) => {
      links
        .filter((l) => l.from_task_id === r.row.task.id && l.link_type === type)
        .forEach((l) => {
          const key = `${type}:${[r.row.task.id, l.to_task_id].sort().join("|")}`;
          if (drawn.has(key)) return;
          drawn.add(key);
          const j = indexByTaskId.get(l.to_task_id);
          if (j === undefined) return;
          const g1 = geom[i];
          const g2 = geom[j];
          connectors.push({ type, x1: g1.nodeCX, y1: g1.nodeCY, x2: g2.nodeCX, y2: g2.nodeCY, fromTaskId: r.row.task.id, toTaskId: l.to_task_id });
        });
    });
  });

  return connectors;
}
