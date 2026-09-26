import type { TaskRow } from "@/lib/list-view";
import { fmtDate, hueFor, initials } from "@/lib/list-view";
import type { Project, WorkflowStatus, WorkflowTransition, Role, ActivityLogEntry, Deal } from "@/lib/types";
import { buildDashboardStats, gatedTransitionsFor } from "@/lib/dashboard-view";
import { StatusChip } from "@/components/task-list-view";
import { recentActivityForUser, timeAgo } from "@/lib/activity-view";
import { openPipelineValue, currencySymbol } from "@/lib/crm-view";
import type { ReportsResult } from "@/lib/reports-view";

// Ported from the prototype's renderDashboardView() — four stat tiles, two
// task lists ("Your tasks" / "Awaiting your review"), and (now that a real
// activity_log table exists — see lib/actions.ts's logActivity) the third
// "Your recent activity" feed too.
export function DashboardView({
  allRows,
  projects,
  statuses,
  transitions,
  currentUserId,
  currentUserRole,
  currentUserName,
  vocabTask,
  activityLog,
  onSelectTask,
  deals,
  dealStatusesById,
  dealsLoaded,
  onOpenDeals,
  reportsData,
  reportsLoaded,
  onOpenReports,
}: {
  allRows: TaskRow[];
  projects: Project[];
  statuses: WorkflowStatus[];
  transitions: WorkflowTransition[];
  currentUserId: string;
  currentUserRole: Role;
  currentUserName: string;
  vocabTask: string;
  activityLog: ActivityLogEntry[];
  onSelectTask: (id: string) => void;
  // CRM Phase A/B leftover — the pipeline-value tiles below. Deals load
  // client-side, once, after mount (see TasksWorkspace's own comment on why
  // Companies/Deals aren't part of the server-rendered props everything
  // else here is) rather than through the props above, so this needs its
  // own small slice of that state passed down instead of deriving it from
  // `allRows`/`statuses` the way the task-side stats do.
  deals: Deal[];
  dealStatusesById: Map<string, WorkflowStatus>;
  dealsLoaded: boolean;
  onOpenDeals: () => void;
  // Reporting (Phase D) — a summary slice of the same org-wide metrics the
  // full Reports tab shows (see components/reports-view.tsx), computed once
  // by TasksWorkspace and passed down here rather than recomputed — this
  // view just picks a couple of headline numbers out of it.
  reportsData: ReportsResult;
  reportsLoaded: boolean;
  onOpenReports: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const rowByTaskId = new Map(allRows.map((r) => [r.task.id, r]));
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const tasks = allRows.map((r) => r.task);
  const statusLabelById = new Map(statuses.map((s) => [s.id, s.label]));

  const { mine, overdue, dueSoon, awaiting } = buildDashboardStats(tasks, statuses, transitions, currentUserId, currentUserRole, today);
  const feed = recentActivityForUser(activityLog, currentUserId);

  // One total per currency (see openPipelineValue's own comment on why —
  // deals in different currencies can't be summed without a conversion
  // rate this app doesn't have), most valuable currency first so the
  // headline number a team actually cares about leads.
  const pipelineByCurrency = Array.from(openPipelineValue(deals, dealStatusesById).entries()).sort((a, b) => b[1] - a[1]);
  const openDealCount = deals.filter((d) => !dealStatusesById.get(d.status_id)?.is_closed).length;

  function StatTile({
    label,
    value,
    tone,
    onClick,
  }: {
    label: string;
    value: number | string;
    tone?: "warn" | "bad" | "info";
    onClick?: () => void;
  }) {
    return (
      <div className={"stat-tile" + (tone ? ` stat-${tone}` : "")} onClick={onClick} style={onClick ? { cursor: "pointer" } : undefined}>
        <div className="stat-value">{value}</div>
        <div className="stat-label">{label}</div>
      </div>
    );
  }

  return (
    <>
      <div className="view-head">
        <div>
          <div className="view-title">Welcome back, {currentUserName}</div>
          <div className="view-sub">here&apos;s what needs your attention</div>
        </div>
      </div>

      <div className="stat-row">
        <StatTile label={`Open ${vocabTask.toLowerCase()}s assigned to you`} value={mine.length} />
        <StatTile label="Due within 7 days" value={dueSoon.length} tone={dueSoon.length ? "warn" : undefined} />
        <StatTile label="Overdue" value={overdue.length} tone={overdue.length ? "bad" : undefined} />
        <StatTile label="Awaiting your review" value={awaiting.length} tone={awaiting.length ? "info" : undefined} />
      </div>

      {/* A Phase A/B leftover — open pipeline value, one tile per currency
          (see openPipelineValue's own comment on why a single sum across
          currencies isn't attempted). Hidden entirely once Deals has
          loaded and genuinely has nothing open, rather than showing a
          permanent "$0" tile for an org that isn't using the CRM side at
          all — same "don't clutter the dashboard with an empty feature"
          call as the rest of this view already makes for its other
          sections. Shown as its own row rather than folded into stat-row
          above since it's a different unit (money, not a task count) and
          arrives later (once the client-side Deals fetch resolves). */}
      {dealsLoaded && (pipelineByCurrency.length > 0 || openDealCount > 0) && (
        <div className="stat-row" style={{ marginTop: 10 }}>
          <StatTile label="Open deals" value={openDealCount} tone="info" onClick={onOpenDeals} />
          {pipelineByCurrency.map(([currency, total]) => (
            <StatTile
              key={currency}
              label={`Open pipeline (${currency})`}
              value={`${currencySymbol(currency)}${total.toLocaleString()}`}
              onClick={onOpenDeals}
            />
          ))}
        </div>
      )}

      {/* Reporting (Phase D) — a headline slice of the full Reports tab
          (components/reports-view.tsx): first-response/resolution SLA
          compliance and completion rate, org-wide. Hidden until reportsData
          has actually loaded rather than flashing "0%/—" for a moment, and
          hidden for good (no helpdesk row) only once loaded confirms there's
          truly nothing to show — same "don't clutter an empty feature" call
          the pipeline row above already makes. */}
      {reportsLoaded && (reportsData.helpdeskTotals || reportsData.projectTotals) && (
        <div className="stat-row" style={{ marginTop: 10 }}>
          {reportsData.helpdeskTotals &&
            (() => {
              const hd = reportsData.helpdeskTotals!;
              const frTotal = hd.firstResponseMet + hd.firstResponseMissed;
              const resTotal = hd.resolutionMet + hd.resolutionMissed;
              const frPct = frTotal > 0 ? Math.round((hd.firstResponseMet / frTotal) * 100) : null;
              const resPct = resTotal > 0 ? Math.round((hd.resolutionMet / resTotal) * 100) : null;
              return (
                <>
                  <StatTile label="First-response SLA met" value={frPct === null ? "—" : `${frPct}%`} tone={frPct !== null && frPct < 90 ? "warn" : undefined} onClick={onOpenReports} />
                  <StatTile label="Resolution SLA met" value={resPct === null ? "—" : `${resPct}%`} tone={resPct !== null && resPct < 90 ? "warn" : undefined} onClick={onOpenReports} />
                  <StatTile label="Tickets needing attention" value={hd.breachedOpenCount} tone={hd.breachedOpenCount ? "bad" : undefined} onClick={onOpenReports} />
                </>
              );
            })()}
          {reportsData.projectTotals &&
            (() => {
              const pr = reportsData.projectTotals!;
              const pct = pr.totalCount > 0 ? Math.round((pr.doneCount / pr.totalCount) * 100) : null;
              return (
                <StatTile label={`${vocabTask} completion rate`} value={pct === null ? "—" : `${pct}%`} onClick={onOpenReports} />
              );
            })()}
        </div>
      )}

      <div className="dash-columns">
        <div className="dash-col">
          <h3 className="dash-col-title">Your {vocabTask.toLowerCase()}s</h3>
          {mine.length === 0 && <div className="empty-note">Nothing assigned to you right now.</div>}
          {mine.slice(0, 8).map((t) => {
            const row = rowByTaskId.get(t.id);
            const project = projectById.get(t.project_id);
            const late = t.due_date !== null && t.due_date < today;
            return (
              <div key={t.id} className="dash-row" onClick={() => onSelectTask(t.id)}>
                <div className="dash-row-main">
                  <span className="row-title">{t.title}</span>
                  <span className="crumbline">{project?.name ?? "—"}</span>
                </div>
                {row && <StatusChip statusKey={row.statusKey} label={row.statusLabel} color={row.statusColor} />}
                {t.due_date === null ? <span className="cell-dates">—</span> : <span className={"cell-dates" + (late ? " dep-flag" : "")}>{fmtDate(t.due_date)}</span>}
              </div>
            );
          })}
        </div>

        <div className="dash-col">
          <h3 className="dash-col-title">Awaiting your review</h3>
          {awaiting.length === 0 && <div className="empty-note">Nothing needs your sign-off right now.</div>}
          {awaiting.map((t) => {
            const row = rowByTaskId.get(t.id);
            const project = projectById.get(t.project_id);
            const targets = gatedTransitionsFor(t, transitions, currentUserRole);
            const targetLabels = targets
              .map((tr) => statuses.find((s) => s.id === tr.to_status_id)?.label ?? "—")
              .join(", ");
            return (
              <div key={t.id} className="dash-row" onClick={() => onSelectTask(t.id)}>
                <div className="dash-row-main">
                  <span className="row-title">{t.title}</span>
                  <span className="crumbline">
                    {project?.name ?? "—"} · needs → {targetLabels}
                  </span>
                </div>
                {row && <StatusChip statusKey={row.statusKey} label={row.statusLabel} color={row.statusColor} />}
              </div>
            );
          })}
        </div>
      </div>

      <div className="dash-col" style={{ marginTop: 16, maxWidth: 600 }}>
        <h3 className="dash-col-title">Your recent activity</h3>
        {feed.length === 0 ? (
          <div className="crumbline">No activity from you yet — moves you make show up here.</div>
        ) : (
          feed.map((a) => {
            const title = rowByTaskId.get(a.task_id)?.task.title ?? "a task";
            const toLabel = (a.to_status_id && statusLabelById.get(a.to_status_id)) || "—";
            const hue = hueFor(currentUserName);
            return (
              <div key={a.id} className="activity-item" style={{ cursor: "pointer" }} onClick={() => onSelectTask(a.task_id)}>
                <span className="avatar" style={{ background: `hsl(${hue} 45% 45%)` }} title={currentUserName}>
                  {initials(currentUserName)}
                </span>
                <div>
                  <div className="activity-text">
                    {a.type === "created" ? (
                      <>
                        You created <strong>{title}</strong>
                      </>
                    ) : (
                      <>
                        You moved <strong>{title}</strong> to {toLabel}
                      </>
                    )}
                  </div>
                  <div className="activity-time">{timeAgo(a.created_at)}</div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
