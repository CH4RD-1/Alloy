import type { TaskRow } from "@/lib/list-view";
import { fmtDate, hueFor, initials } from "@/lib/list-view";
import type { Project, WorkflowStatus, WorkflowTransition, Role, ActivityLogEntry } from "@/lib/types";
import { buildDashboardStats, gatedTransitionsFor } from "@/lib/dashboard-view";
import { StatusChip } from "@/components/task-list-view";
import { recentActivityForUser, timeAgo } from "@/lib/activity-view";

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
}) {
  const today = new Date().toISOString().slice(0, 10);
  const rowByTaskId = new Map(allRows.map((r) => [r.task.id, r]));
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const tasks = allRows.map((r) => r.task);
  const statusLabelById = new Map(statuses.map((s) => [s.id, s.label]));

  const { mine, overdue, dueSoon, awaiting } = buildDashboardStats(tasks, statuses, transitions, currentUserId, currentUserRole, today);
  const feed = recentActivityForUser(activityLog, currentUserId);

  function StatTile({ label, value, tone }: { label: string; value: number; tone?: "warn" | "bad" | "info" }) {
    return (
      <div className={"stat-tile" + (tone ? ` stat-${tone}` : "")}>
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
