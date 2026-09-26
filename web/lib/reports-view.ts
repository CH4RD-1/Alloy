// Pure, framework-agnostic reporting math — Helpdesk SLA compliance,
// Project task-completion, and Deal win-rate, all org-wide. Same split as
// lib/dashboard-view.ts/lib/crm-view.ts: the derivation logic lives here so
// it's easy to reason about (and test) without a component tree —
// components/reports-view.tsx and the Dashboard's own summary card just
// render whatever buildReportsData returns.
//
// Deliberately NOT built from the activityLog/ticketMessages props already
// threaded through TasksWorkspace: those two are capped to the most recent
// 300 org-wide rows each (see WorkspaceData's own comment in
// lib/tasks-data.ts) — fine for "show this one ticket's conversation" but
// wrong for an aggregate report, which would silently under-count anything
// older than the cap. Callers instead pass the *full* status-change/
// message history, fetched once via getReportsData (lib/actions.ts) the
// same way Companies/Deals/Contacts are — never part of the
// router.refresh() critical path (see that action's own comment).

import type { Task, Project, WorkflowStatus, Workflow, Deal } from "./types";
import { firstResponseTarget, resolutionTarget } from "./sla";
import { dealOutcome } from "./crm-view";

// Narrowed shapes, not the full ActivityLogEntry/TicketMessage — matches
// what getReportsData actually selects (see its own comment for why: a
// smaller payload for a query that, unlike the capped fetches above, has to
// read an org's *entire* history).
export interface ReportActivityRow {
  task_id: string;
  to_status_id: string | null;
  created_at: string;
}
export interface ReportMessageRow {
  task_id: string;
  created_at: string;
}

export interface HelpdeskReportRow {
  projectId: string;
  projectName: string;
  openCount: number;
  resolvedCount: number;
  // Currently-open tickets already past their first-response target with no
  // response yet, or past their resolution target — the "needs attention
  // right now" number, distinct from firstResponseMissed/resolutionMissed
  // below, which only count tickets that actually got a response/were
  // actually resolved (late or not).
  breachedOpenCount: number;
  firstResponseMet: number;
  firstResponseMissed: number;
  resolutionMet: number;
  resolutionMissed: number;
  avgFirstResponseMs: number | null;
  avgResolutionMs: number | null;
}

export interface ProjectReportRow {
  projectId: string;
  projectName: string;
  totalCount: number;
  doneCount: number;
  overdueCount: number;
  onTimeCount: number;
  lateCount: number;
  avgCycleTimeMs: number | null;
}

export interface DealsReportSummary {
  openCount: number;
  wonCount: number;
  lostCount: number;
  winRatePct: number | null;
}

export interface WeeklyCompletion {
  weekStart: string; // ISO date (Monday, UTC)
  count: number;
}

export interface ReportsResult {
  helpdesk: HelpdeskReportRow[];
  helpdeskTotals: HelpdeskReportRow | null; // null when the org has no helpdesk tickets at all
  projectsReport: ProjectReportRow[];
  projectTotals: ProjectReportRow | null; // null when the org has no non-helpdesk tasks at all
  deals: DealsReportSummary;
  weeklyCompletions: WeeklyCompletion[];
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Monday-anchored week bucket for a timestamp, UTC — same UTC-only
// simplification lib/sla.ts already discloses for business hours (no
// per-org timezone yet).
function weekStartOf(iso: string): string {
  const d = new Date(iso);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = (day + 6) % 7; // days since Monday
  d.setUTCDate(d.getUTCDate() - diff);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

interface TaskDerived {
  task: Task;
  closedStatusId: string | null;
  isDone: boolean;
  firstResponseAt: string | null;
  resolvedAt: string | null;
}

export function buildReportsData(params: {
  tasks: Task[];
  projects: Project[];
  statuses: WorkflowStatus[];
  workflows: Workflow[];
  activity: ReportActivityRow[]; // status-change rows only (any order)
  messages: ReportMessageRow[]; // outbound+public only (any order)
  deals: Deal[];
  dealStatusesById: Map<string, WorkflowStatus>;
  slaFirstResponseHours: number;
  slaResolutionDays: number;
  now?: Date;
}): ReportsResult {
  const { tasks, projects, statuses, activity, messages, deals, dealStatusesById, slaFirstResponseHours, slaResolutionDays } = params;
  const now = params.now ?? new Date();
  const today = now.toISOString().slice(0, 10);

  const projectById = new Map(projects.map((p) => [p.id, p]));
  const statusById = new Map(statuses.map((s) => [s.id, s]));

  // One closed status per workflow — same "first is_closed match wins" rule
  // task-panel.tsx's own SLA block already relies on (a workflow's closed
  // status's key can be anything now that workflows are user-chosen).
  const closedStatusByWorkflow = new Map<string, string>();
  statuses.forEach((s) => {
    if (s.is_closed && !closedStatusByWorkflow.has(s.workflow_id)) closedStatusByWorkflow.set(s.workflow_id, s.id);
  });

  // Earliest qualifying message per task (one pass, not a per-task filter —
  // this runs over the org's whole history, not one ticket's).
  const firstResponseByTask = new Map<string, string>();
  messages.forEach((m) => {
    const existing = firstResponseByTask.get(m.task_id);
    if (!existing || m.created_at < existing) firstResponseByTask.set(m.task_id, m.created_at);
  });

  // Latest transition-into-<status> per task, keyed by target status — a
  // task's closed status depends on its own workflow, so this stays keyed by
  // status_id and gets resolved to "the" closed timestamp per task below,
  // rather than assuming one global closed status.
  const latestByTaskAndStatus = new Map<string, Map<string, string>>();
  activity.forEach((a) => {
    if (!a.to_status_id) return;
    let m = latestByTaskAndStatus.get(a.task_id);
    if (!m) {
      m = new Map();
      latestByTaskAndStatus.set(a.task_id, m);
    }
    const cur = m.get(a.to_status_id);
    if (!cur || a.created_at > cur) m.set(a.to_status_id, a.created_at);
  });

  const derivedByTaskId = new Map<string, TaskDerived>();
  tasks.forEach((task) => {
    const currentStatus = statusById.get(task.status_id);
    const closedStatusId = currentStatus ? closedStatusByWorkflow.get(currentStatus.workflow_id) ?? null : null;
    const isDone = !!closedStatusId && task.status_id === closedStatusId;
    // Mirrors task-panel.tsx's own resolvedAt: only trusted while the task
    // is *currently* in the closed status, so a later reopen doesn't leave a
    // stale "resolved" timestamp behind for a ticket that's open again.
    const resolvedAt = isDone && closedStatusId ? latestByTaskAndStatus.get(task.id)?.get(closedStatusId) ?? null : null;
    derivedByTaskId.set(task.id, {
      task,
      closedStatusId,
      isDone,
      firstResponseAt: firstResponseByTask.get(task.id) ?? null,
      resolvedAt,
    });
  });

  function computeHelpdeskRow(projectId: string, projectName: string, rows: TaskDerived[]): HelpdeskReportRow {
    let openCount = 0;
    let resolvedCount = 0;
    let breachedOpenCount = 0;
    let firstResponseMet = 0;
    let firstResponseMissed = 0;
    let resolutionMet = 0;
    let resolutionMissed = 0;
    const firstResponseDurations: number[] = [];
    const resolutionDurations: number[] = [];

    rows.forEach(({ task, isDone, firstResponseAt, resolvedAt }) => {
      const frTarget = firstResponseTarget(task.created_at, slaFirstResponseHours);
      const resTarget = resolutionTarget(task.created_at, slaResolutionDays);

      if (isDone) resolvedCount++;
      else openCount++;

      if (firstResponseAt) {
        const respondedAt = new Date(firstResponseAt).getTime();
        firstResponseDurations.push(respondedAt - new Date(task.created_at).getTime());
        if (respondedAt <= frTarget.getTime()) firstResponseMet++;
        else firstResponseMissed++;
      }
      if (isDone && resolvedAt) {
        const doneAt = new Date(resolvedAt).getTime();
        resolutionDurations.push(doneAt - new Date(task.created_at).getTime());
        if (doneAt <= resTarget.getTime()) resolutionMet++;
        else resolutionMissed++;
      }
      if (!isDone) {
        const pastFirstResponse = !firstResponseAt && now.getTime() > frTarget.getTime();
        const pastResolution = now.getTime() > resTarget.getTime();
        if (pastFirstResponse || pastResolution) breachedOpenCount++;
      }
    });

    return {
      projectId,
      projectName,
      openCount,
      resolvedCount,
      breachedOpenCount,
      firstResponseMet,
      firstResponseMissed,
      resolutionMet,
      resolutionMissed,
      avgFirstResponseMs: avg(firstResponseDurations),
      avgResolutionMs: avg(resolutionDurations),
    };
  }

  function computeProjectRow(projectId: string, projectName: string, rows: TaskDerived[]): ProjectReportRow {
    let doneCount = 0;
    let overdueCount = 0;
    let onTimeCount = 0;
    let lateCount = 0;
    const cycleTimes: number[] = [];

    rows.forEach(({ task, isDone, resolvedAt }) => {
      if (isDone) {
        doneCount++;
        if (resolvedAt) cycleTimes.push(new Date(resolvedAt).getTime() - new Date(task.created_at).getTime());
        if (task.due_date && resolvedAt) {
          if (resolvedAt.slice(0, 10) <= task.due_date) onTimeCount++;
          else lateCount++;
        }
      } else if (task.due_date && task.due_date < today) {
        overdueCount++;
      }
    });

    return {
      projectId,
      projectName,
      totalCount: rows.length,
      doneCount,
      overdueCount,
      onTimeCount,
      lateCount,
      avgCycleTimeMs: avg(cycleTimes),
    };
  }

  // Helpdesk tickets: kind "task" (a helpdesk project has no other kind)
  // inside an is_helpdesk project. Grouped by project — an org can run more
  // than one helpdesk (e.g. "Support" and "Billing") with different queues.
  const helpdeskByProject = new Map<string, TaskDerived[]>();
  const projectRowsByProject = new Map<string, TaskDerived[]>();
  tasks.forEach((task) => {
    if (task.kind !== "task") return; // excludes asset_allocation rows from both reports
    const project = projectById.get(task.project_id);
    if (!project) return;
    const derived = derivedByTaskId.get(task.id);
    if (!derived) return;
    const bucket = project.is_helpdesk ? helpdeskByProject : projectRowsByProject;
    const list = bucket.get(project.id) ?? [];
    list.push(derived);
    bucket.set(project.id, list);
  });

  const helpdesk = Array.from(helpdeskByProject.entries())
    .map(([projectId, rows]) => computeHelpdeskRow(projectId, projectById.get(projectId)?.name ?? "—", rows))
    .sort((a, b) => a.projectName.localeCompare(b.projectName));
  const allHelpdeskRows = Array.from(helpdeskByProject.values()).flat();
  const helpdeskTotals = allHelpdeskRows.length ? computeHelpdeskRow("", "All helpdesk projects", allHelpdeskRows) : null;

  const projectsReport = Array.from(projectRowsByProject.entries())
    .map(([projectId, rows]) => computeProjectRow(projectId, projectById.get(projectId)?.name ?? "—", rows))
    .sort((a, b) => a.projectName.localeCompare(b.projectName));
  const allProjectRows = Array.from(projectRowsByProject.values()).flat();
  const projectTotals = allProjectRows.length ? computeProjectRow("", "All projects", allProjectRows) : null;

  // Deals — reuses dealOutcome() (lib/crm-view.ts) rather than re-deriving
  // won/lost from status keys a second time.
  let dealsOpen = 0;
  let dealsWon = 0;
  let dealsLost = 0;
  deals.forEach((d) => {
    const outcome = dealOutcome(d, dealStatusesById);
    if (outcome === "open") dealsOpen++;
    else if (outcome === "won") dealsWon++;
    else dealsLost++;
  });
  const dealsDecided = dealsWon + dealsLost;

  // Throughput trend — org-wide task+ticket completions per week, last 8
  // weeks including the current (partial) one. Filled with zero-count weeks
  // so a quiet week doesn't just vanish from the list.
  const completionsByWeek = new Map<string, number>();
  [...allHelpdeskRows, ...allProjectRows].forEach(({ isDone, resolvedAt }) => {
    if (!isDone || !resolvedAt) return;
    const week = weekStartOf(resolvedAt);
    completionsByWeek.set(week, (completionsByWeek.get(week) ?? 0) + 1);
  });
  const weeklyCompletions: WeeklyCompletion[] = [];
  const cursor = new Date(now);
  cursor.setUTCHours(0, 0, 0, 0);
  const day = cursor.getUTCDay();
  cursor.setUTCDate(cursor.getUTCDate() - ((day + 6) % 7)); // this week's Monday
  for (let i = 7; i >= 0; i--) {
    const weekDate = new Date(cursor);
    weekDate.setUTCDate(weekDate.getUTCDate() - i * 7);
    const key = weekDate.toISOString().slice(0, 10);
    weeklyCompletions.push({ weekStart: key, count: completionsByWeek.get(key) ?? 0 });
  }

  return {
    helpdesk,
    helpdeskTotals,
    projectsReport,
    projectTotals,
    deals: {
      openCount: dealsOpen,
      wonCount: dealsWon,
      lostCount: dealsLost,
      winRatePct: dealsDecided ? (dealsWon / dealsDecided) * 100 : null,
    },
    weeklyCompletions,
  };
}
