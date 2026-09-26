import type { ReportsResult, HelpdeskReportRow, ProjectReportRow } from "@/lib/reports-view";
import { formatDuration } from "@/lib/sla";

// Reporting (Phase D) — org-wide Helpdesk SLA compliance, Project task
// completion, Deal win-rate and a completions trend, all derived by
// lib/reports-view.ts's buildReportsData from data TasksWorkspace already
// holds (plus one small extra fetch — see its own getReportsData comment
// for why activityLog/ticketMessages' existing 300-row cap isn't reused
// here). This component is presentation-only: it renders whatever
// buildReportsData returned and does no computation of its own.
export function ReportsView({ data, loaded, vocabTask, onOpenDeals }: { data: ReportsResult; loaded: boolean; vocabTask: string; onOpenDeals: () => void }) {
  if (!loaded) {
    return (
      <>
        <div className="view-head">
          <div>
            <div className="view-title">Reports</div>
            <div className="view-sub">Loading org-wide metrics…</div>
          </div>
        </div>
      </>
    );
  }

  const hd = data.helpdeskTotals;
  const pr = data.projectTotals;
  const frPct = hd && hd.firstResponseMet + hd.firstResponseMissed > 0 ? (hd.firstResponseMet / (hd.firstResponseMet + hd.firstResponseMissed)) * 100 : null;
  const resPct = hd && hd.resolutionMet + hd.resolutionMissed > 0 ? (hd.resolutionMet / (hd.resolutionMet + hd.resolutionMissed)) * 100 : null;
  const completionPct = pr && pr.totalCount > 0 ? (pr.doneCount / pr.totalCount) * 100 : null;
  const maxWeekly = Math.max(1, ...data.weeklyCompletions.map((w) => w.count));

  return (
    <>
      <div className="view-head">
        <div>
          <div className="view-title">Reports</div>
          <div className="view-sub">SLA compliance, {vocabTask.toLowerCase()} completion, and pipeline metrics across every project</div>
        </div>
      </div>

      <div className="stat-row">
        <Tile label="Helpdesk first-response SLA" value={pctLabel(frPct)} tone={toneForPct(frPct)} />
        <Tile label="Helpdesk resolution SLA" value={pctLabel(resPct)} tone={toneForPct(resPct)} />
        <Tile label="Tickets needing attention now" value={hd?.breachedOpenCount ?? 0} tone={hd && hd.breachedOpenCount > 0 ? "bad" : undefined} />
        <Tile
          label={`${vocabTask} completion rate`}
          value={pctLabel(completionPct)}
          tone={completionPct !== null && completionPct < 50 ? "warn" : undefined}
        />
      </div>

      <div className="stat-row" style={{ marginTop: -8 }}>
        <Tile label="Open deals" value={data.deals.openCount} onClick={onOpenDeals} />
        <Tile label="Deals won" value={data.deals.wonCount} onClick={onOpenDeals} />
        <Tile label="Deals lost" value={data.deals.lostCount} onClick={onOpenDeals} />
        <Tile label="Deal win rate" value={pctLabel(data.deals.winRatePct)} onClick={onOpenDeals} />
      </div>

      <div className="report-section">
        <h3 className="dash-col-title">Helpdesk SLA by project</h3>
        {data.helpdesk.length === 0 ? (
          <div className="empty-note">No helpdesk projects with tickets yet.</div>
        ) : (
          <table className="report-table">
            <thead>
              <tr>
                <th>Project</th>
                <th>Open</th>
                <th>Resolved</th>
                <th>Needs attention</th>
                <th>First response SLA</th>
                <th>Avg first response</th>
                <th>Resolution SLA</th>
                <th>Avg resolution</th>
              </tr>
            </thead>
            <tbody>
              {data.helpdesk.map((row) => <HelpdeskTableRow key={row.projectId} row={row} />)}
              {hd && data.helpdesk.length > 1 && <HelpdeskTableRow row={hd} isTotal />}
            </tbody>
          </table>
        )}
      </div>

      <div className="report-section">
        <h3 className="dash-col-title">{vocabTask} completion by project</h3>
        {data.projectsReport.length === 0 ? (
          <div className="empty-note">No projects with {vocabTask.toLowerCase()}s yet.</div>
        ) : (
          <table className="report-table">
            <thead>
              <tr>
                <th>Project</th>
                <th>Total</th>
                <th>Done</th>
                <th>Completion</th>
                <th>Overdue</th>
                <th>On-time vs. late</th>
                <th>Avg cycle time</th>
              </tr>
            </thead>
            <tbody>
              {data.projectsReport.map((row) => <ProjectTableRow key={row.projectId} row={row} />)}
              {pr && data.projectsReport.length > 1 && <ProjectTableRow row={pr} isTotal />}
            </tbody>
          </table>
        )}
      </div>

      <div className="report-section">
        <h3 className="dash-col-title">Completions per week</h3>
        <div className="crumbline" style={{ marginBottom: 6 }}>
          Every {vocabTask.toLowerCase()} and ticket that reached its workflow&apos;s closed status, org-wide, last 8 weeks.
        </div>
        {data.weeklyCompletions.every((w) => w.count === 0) ? (
          <div className="empty-note">Nothing completed in the last 8 weeks yet.</div>
        ) : (
          <div className="report-trend">
            {data.weeklyCompletions.map((w) => (
              <div className="report-trend-col" key={w.weekStart}>
                <span className="report-trend-count">{w.count}</span>
                <div className="report-trend-bar" style={{ height: `${Math.max(4, (w.count / maxWeekly) * 74)}px` }} />
                <span className="report-trend-label">{fmtWeekLabel(w.weekStart)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function Tile({
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

function pctLabel(pct: number | null): string {
  return pct === null ? "—" : `${Math.round(pct)}%`;
}
function toneForPct(pct: number | null): "warn" | "bad" | undefined {
  if (pct === null) return undefined;
  if (pct < 70) return "bad";
  if (pct < 90) return "warn";
  return undefined;
}
function fmtWeekLabel(weekStart: string): string {
  const d = new Date(weekStart);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}
function msLabel(ms: number | null): string {
  return ms === null ? "—" : formatDuration(ms);
}

function Bar({ pct, warnBelow }: { pct: number | null; warnBelow: number }) {
  if (pct === null) return <span>—</span>;
  return (
    <span className="report-bar">
      <span className="report-bar-track">
        <span className={"report-bar-fill" + (pct < warnBelow ? " report-bar-warn" : "")} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      </span>
      {Math.round(pct)}%
    </span>
  );
}

function HelpdeskTableRow({ row, isTotal }: { row: HelpdeskReportRow; isTotal?: boolean }) {
  const frTotal = row.firstResponseMet + row.firstResponseMissed;
  const resTotal = row.resolutionMet + row.resolutionMissed;
  const frPct = frTotal > 0 ? (row.firstResponseMet / frTotal) * 100 : null;
  const resPct = resTotal > 0 ? (row.resolutionMet / resTotal) * 100 : null;
  return (
    <tr className={isTotal ? "report-row-total" : undefined}>
      <td>{row.projectName}</td>
      <td>{row.openCount}</td>
      <td>{row.resolvedCount}</td>
      <td>{row.breachedOpenCount > 0 ? <span className="chip sla-chip sla-chip-breached">{row.breachedOpenCount}</span> : "0"}</td>
      <td>
        <Bar pct={frPct} warnBelow={90} /> {frTotal > 0 && <span className="crumbline">({frTotal})</span>}
      </td>
      <td>{msLabel(row.avgFirstResponseMs)}</td>
      <td>
        <Bar pct={resPct} warnBelow={90} /> {resTotal > 0 && <span className="crumbline">({resTotal})</span>}
      </td>
      <td>{msLabel(row.avgResolutionMs)}</td>
    </tr>
  );
}

function ProjectTableRow({ row, isTotal }: { row: ProjectReportRow; isTotal?: boolean }) {
  const completionPct = row.totalCount > 0 ? (row.doneCount / row.totalCount) * 100 : null;
  return (
    <tr className={isTotal ? "report-row-total" : undefined}>
      <td>{row.projectName}</td>
      <td>{row.totalCount}</td>
      <td>{row.doneCount}</td>
      <td>
        <Bar pct={completionPct} warnBelow={50} />
      </td>
      <td>{row.overdueCount > 0 ? <span className="chip sla-chip sla-chip-breached">{row.overdueCount}</span> : "0"}</td>
      <td>
        {row.onTimeCount + row.lateCount > 0 ? (
          <>
            <span className="chip sla-chip sla-chip-met">{row.onTimeCount}</span> / <span className="chip sla-chip sla-chip-breached">{row.lateCount}</span>
          </>
        ) : (
          "—"
        )}
      </td>
      <td>{msLabel(row.avgCycleTimeMs)}</td>
    </tr>
  );
}
