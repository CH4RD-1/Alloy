"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Workflow, WorkflowStatus, WorkflowTransition, WorkflowType, Role, Invite } from "@/lib/types";
import type { MemberSummary } from "@/lib/tasks-data";
import {
  createWorkflow,
  renameWorkflow,
  deleteWorkflow,
  createWorkflowStatus,
  updateWorkflowStatus,
  reorderWorkflowStatuses,
  deleteWorkflowStatus,
  upsertWorkflowTransition,
  deleteWorkflowTransition,
  updateMemberRole,
  createInvite,
  revokeInvite,
} from "@/lib/actions";
import { StatusChip } from "@/components/task-list-view";

// The prototype's ROLES constant, unchanged — see the WORKFLOW_ROLES note in
// lib/actions.ts for why "owner"/"admin" (new, real-tenant-ownership
// concepts this port added) don't appear here at all.
const WORKFLOW_ROLES: { id: Role; name: string; blurb: string }[] = [
  { id: "standard", name: "Standard", blurb: "everyday work — can move tasks along the parts of the workflow open to everyone." },
  { id: "authorizer", name: "Authorizer", blurb: "can additionally approve work that has been through review." },
  { id: "manager", name: "Manager", blurb: "full access, including reopening tasks that are already closed." },
];
const ROLE_NAME: Record<string, string> = Object.fromEntries(WORKFLOW_ROLES.map((r) => [r.id, r.name]));

// The 3 object kinds a workflow can be built for — see schema.sql's own
// comment on workflows.type and the Workflow type in lib/types.ts.
const WORKFLOW_TYPE_META: Record<WorkflowType, { label: string; blurb: string }> = {
  task: { label: "Regular Tasks", blurb: "The default workflow for ordinary, schedulable work." },
  helpdesk: { label: "Helpdesk Tickets", blurb: "For Helpdesk-flagged projects — no dates, hidden from the Gantt." },
  asset: { label: "Assets", blurb: "For asset-allocation tasks, created from the Assets tab." },
};
const WORKFLOW_TYPES: WorkflowType[] = ["task", "helpdesk", "asset"];

const NEW_STATUS_COLORS = ["#64748b", "#3b82f6", "#f59e0b", "#a855f7", "#22c55e", "#ef4444", "#0ea5e9", "#ec4899"];

// A light background tint of an arbitrary hex color — same idea as
// components/task-list-view.tsx's own tintFromHex, duplicated locally
// (small enough, and this file doesn't otherwise need that module) for the
// flow chart's node fills below.
function tint(hex: string, alpha: number): string {
  const clean = hex.replace("#", "").trim();
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return hex;
  const num = parseInt(full, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// A simple auto-laid-out diagram of one workflow's states/transitions —
// states in position order along a single row, transitions drawn as curved
// arrows (below the row for a "forward" move, above it for a "backward"
// one, so a typical mostly-linear workflow doesn't turn into a tangle).
// Deliberately not a draggable/editable canvas — the lists below it are
// still where states and transitions actually get changed; this is a
// read-only picture of what those lists currently describe.
function WorkflowFlowChart({ statuses, transitions }: { statuses: WorkflowStatus[]; transitions: WorkflowTransition[] }) {
  const ordered = [...statuses].sort((a, b) => a.position - b.position);
  if (ordered.length === 0) {
    return <p style={{ color: "var(--text-faint)", fontSize: 12.5, padding: "20px 0" }}>Add a state below to see it here.</p>;
  }
  const nodeW = 152;
  const nodeH = 40;
  const gapX = 96;
  const padding = 24;
  const rowY = 76;
  const idxById = new Map(ordered.map((s, i) => [s.id, i]));
  const xFor = (i: number) => padding + i * (nodeW + gapX);
  const width = padding * 2 + ordered.length * nodeW + Math.max(0, ordered.length - 1) * gapX;
  const height = 220;

  return (
    <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: 10, background: "var(--surface-2)", padding: 8 }}>
      <svg width={Math.max(width, 300)} height={height} style={{ display: "block" }}>
        <defs>
          <marker id="wf-flow-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--text-faint)" />
          </marker>
        </defs>
        {transitions.map((t) => {
          const fromIdx = idxById.get(t.from_status_id);
          const toIdx = idxById.get(t.to_status_id);
          if (fromIdx === undefined || toIdx === undefined) return null;
          const x1 = xFor(fromIdx) + nodeW / 2;
          const x2 = xFor(toIdx) + nodeW / 2;
          const forward = toIdx >= fromIdx;
          const edgeY = forward ? rowY + nodeH : rowY;
          const curveY = forward ? rowY + nodeH + 40 : rowY - 40;
          const path = `M ${x1} ${edgeY} C ${x1} ${curveY}, ${x2} ${curveY}, ${x2} ${edgeY}`;
          return (
            <path key={t.id} d={path} fill="none" stroke="var(--text-faint)" strokeWidth={1.5} opacity={0.75} markerEnd="url(#wf-flow-arrow)" />
          );
        })}
        {ordered.map((s, i) => (
          <g key={s.id} transform={`translate(${xFor(i)}, ${rowY})`}>
            <rect width={nodeW} height={nodeH} rx={10} fill={tint(s.color, 0.18)} stroke={s.color} strokeWidth={1.5} />
            <text x={nodeW / 2} y={nodeH / 2 + 4} textAnchor="middle" fontSize={12} fontWeight={600} fill={s.color}>
              {s.label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

// Ported from the prototype's renderWorkflowPanel(), fully overhauled: many
// workflows per org now instead of one (a left-hand list, grouped by type,
// with a create form), each with its own fully add/rename/recolor/reorder/
// removable states, its own transitions editor, and a flow-chart view of
// the two together. Roles/invites stay org-wide (a member's role isn't
// per-workflow) so they moved to their own tab rather than repeating per
// workflow. Opens full-screen (see .panel-full in globals.css) — the old
// 440px slide-over didn't have room for a workflow list, an editor, and a
// diagram all at once.
export function WorkflowPanel({
  orgId,
  workflows,
  statuses,
  transitions,
  members,
  currentUserRole,
  vocabTask,
  invites,
  onClose,
}: {
  orgId: string;
  workflows: Workflow[];
  statuses: WorkflowStatus[];
  transitions: WorkflowTransition[];
  members: MemberSummary[];
  currentUserRole: Role;
  vocabTask: string;
  invites: Invite[];
  onClose: () => void;
}) {
  const canManageRoles = currentUserRole === "owner" || currentUserRole === "admin";
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"workflows" | "roles">("workflows");
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>(workflows[0]?.id ?? "");
  const taskNoun = vocabTask.toLowerCase();

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

  const selectedWorkflow = workflows.find((w) => w.id === selectedWorkflowId) ?? workflows[0] ?? null;
  const workflowStatuses = useMemo(
    () => statuses.filter((s) => s.workflow_id === selectedWorkflow?.id).sort((a, b) => a.position - b.position),
    [statuses, selectedWorkflow]
  );
  const workflowTransitions = useMemo(
    () => transitions.filter((t) => t.workflow_id === selectedWorkflow?.id),
    [transitions, selectedWorkflow]
  );
  const statusById = new Map(workflowStatuses.map((s) => [s.id, s]));
  const statusLabel = (id: string) => statusById.get(id)?.label ?? "Unknown";

  const groupedWorkflows: Record<WorkflowType, Workflow[]> = { task: [], helpdesk: [], asset: [] };
  workflows.forEach((w) => groupedWorkflows[w.type]?.push(w));

  const [newWorkflowName, setNewWorkflowName] = useState("");
  const [newWorkflowType, setNewWorkflowType] = useState<WorkflowType>("task");

  function addWorkflow() {
    const name = newWorkflowName.trim();
    if (!name) return;
    setNewWorkflowName("");
    run(async () => {
      const id = await createWorkflow(orgId, { name, type: newWorkflowType });
      setSelectedWorkflowId(id);
    });
  }

  const [newStatusLabel, setNewStatusLabel] = useState("");
  const [newStatusColor, setNewStatusColor] = useState(NEW_STATUS_COLORS[0]);

  function addStatus() {
    if (!selectedWorkflow) return;
    const label = newStatusLabel.trim();
    if (!label) return;
    setNewStatusLabel("");
    run(() => createWorkflowStatus(orgId, selectedWorkflow.id, { key: label, label, color: newStatusColor }));
  }

  function moveStatus(id: string, dir: -1 | 1) {
    if (!selectedWorkflow) return;
    const ids = workflowStatuses.map((s) => s.id);
    const idx = ids.indexOf(id);
    const swapWith = idx + dir;
    if (swapWith < 0 || swapWith >= ids.length) return;
    [ids[idx], ids[swapWith]] = [ids[swapWith], ids[idx]];
    run(() => reorderWorkflowStatuses(selectedWorkflow.id, ids));
  }

  // Transition-form state — reset to this workflow's own statuses whenever
  // the selection lands outside them (a fresh selectedWorkflowId, or the
  // form's never been touched yet), rather than a useEffect to sync it.
  const [wfFrom, setWfFrom] = useState("");
  const [wfTo, setWfTo] = useState("");
  const effectiveFrom = workflowStatuses.some((s) => s.id === wfFrom) ? wfFrom : workflowStatuses[0]?.id ?? "";
  const effectiveTo = workflowStatuses.some((s) => s.id === wfTo) ? wfTo : workflowStatuses[1]?.id ?? workflowStatuses[0]?.id ?? "";
  const [wfRoles, setWfRoles] = useState<Set<Role>>(new Set(WORKFLOW_ROLES.map((r) => r.id)));
  const [wfSubtasks, setWfSubtasks] = useState(false);
  const [wfChecklists, setWfChecklists] = useState(false);

  function toggleWfRole(id: Role) {
    setWfRoles((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // The prototype fully re-rendered this form after every add (renderPanel()
  // regenerates fresh HTML, so the role checkboxes come back all-checked and
  // the requireComplete checkbox unchecked) — matched here by resetting the
  // form's own state immediately rather than leaving the last submission's
  // choices sitting there to be silently reused for the next pair.
  function addTransition() {
    if (!effectiveFrom || !effectiveTo || effectiveFrom === effectiveTo) return;
    run(() =>
      upsertWorkflowTransition(orgId, {
        from_status_id: effectiveFrom,
        to_status_id: effectiveTo,
        allowed_roles: Array.from(wfRoles),
        require_subtasks_complete: wfSubtasks,
        require_checklists_complete: wfChecklists,
      })
    );
    setWfRoles(new Set(WORKFLOW_ROLES.map((r) => r.id)));
    setWfSubtasks(false);
    setWfChecklists(false);
  }

  const workflowMembers = members.filter((m) => WORKFLOW_ROLES.some((r) => r.id === m.role));
  const [roleMemberId, setRoleMemberId] = useState(workflowMembers[0]?.userId ?? "");
  const [roleForMember, setRoleForMember] = useState<Role>("standard");

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("standard");
  const [inviteNotice, setInviteNotice] = useState<string | null>(null);
  const pendingInvites = invites.filter((i) => !i.accepted_at);

  function sendInvite() {
    const email = inviteEmail.trim();
    if (!email) return;
    setError(null);
    setInviteNotice(null);
    startTransition(async () => {
      try {
        const result = await createInvite(orgId, email, inviteRole);
        setInviteNotice(
          result.emailed
            ? `Invite emailed to ${email}.`
            : `Invite created for ${email} — email isn't configured, so share the invite link with them directly.`
        );
        setInviteEmail("");
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      }
    });
  }

  return (
    <>
      <div className="scrim show" onClick={onClose} />
      <aside className="panel show panel-full panel-left">
        <div className="panel-head">
          <div style={{ flex: 1, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16 }}>Workflow &amp; roles</div>
          <div className="view-tabs" style={{ marginBottom: 0 }}>
            <button type="button" className={`view-tab ${tab === "workflows" ? "active" : ""}`} onClick={() => setTab("workflows")}>
              Workflows
            </button>
            <button type="button" className={`view-tab ${tab === "roles" ? "active" : ""}`} onClick={() => setTab("roles")}>
              Roles &amp; invites
            </button>
          </div>
          <button className="icon-btn panel-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="panel-body">
          {error && <div className="banner" style={{ color: "var(--blocked)", background: "var(--blocked-bg)" }}>{error}</div>}

          {tab === "workflows" && (
            <div className="wf-editor-shell">
              <div className="wf-editor-sidebar">
                <span className="field-label">Workflows</span>
                {WORKFLOW_TYPES.map((type) => (
                  <div key={type} style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-faint)", margin: "6px 0 4px" }}>
                      {WORKFLOW_TYPE_META[type].label}
                    </div>
                    {groupedWorkflows[type].length === 0 && (
                      <p style={{ color: "var(--text-faint)", fontSize: 12, margin: "0 0 4px" }}>None yet.</p>
                    )}
                    {groupedWorkflows[type].map((w) => (
                      <button
                        key={w.id}
                        type="button"
                        className={`side-link ${selectedWorkflow?.id === w.id ? "active" : ""}`}
                        style={{ width: "100%" }}
                        onClick={() => setSelectedWorkflowId(w.id)}
                      >
                        {w.name}
                      </button>
                    ))}
                  </div>
                ))}

                <div className="divider" />

                <div className="field-group">
                  <span className="field-label">New workflow</span>
                  <input
                    className="text-input"
                    placeholder="Workflow name"
                    value={newWorkflowName}
                    onChange={(e) => setNewWorkflowName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addWorkflow()}
                  />
                  <select
                    className="select-input"
                    style={{ marginTop: 6, width: "100%" }}
                    value={newWorkflowType}
                    onChange={(e) => setNewWorkflowType(e.target.value as WorkflowType)}
                  >
                    {WORKFLOW_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {WORKFLOW_TYPE_META[t].label}
                      </option>
                    ))}
                  </select>
                  <button className="small-btn" style={{ marginTop: 6 }} disabled={!newWorkflowName.trim() || pending} onClick={addWorkflow}>
                    Add workflow
                  </button>
                </div>
              </div>

              <div className="wf-editor-main">
                {!selectedWorkflow ? (
                  <p style={{ color: "var(--text-faint)" }}>Add a workflow on the left to get started.</p>
                ) : (
                  <>
                    <div className="wf-editor-header">
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <input
                          className="panel-title-input"
                          style={{ fontSize: 18 }}
                          defaultValue={selectedWorkflow.name}
                          key={selectedWorkflow.id}
                          onBlur={(e) => {
                            const value = e.target.value.trim();
                            if (value && value !== selectedWorkflow.name) run(() => renameWorkflow(selectedWorkflow.id, value));
                          }}
                        />
                        <div className="crumbline">
                          {WORKFLOW_TYPE_META[selectedWorkflow.type].label} workflow — {WORKFLOW_TYPE_META[selectedWorkflow.type].blurb}
                        </div>
                      </div>
                      <button
                        className="icon-btn"
                        title="Delete this workflow"
                        disabled={pending}
                        onClick={() => {
                          if (!confirm(`Delete "${selectedWorkflow.name}"? This can't be undone.`)) return;
                          const fallback = workflows.find((w) => w.id !== selectedWorkflow.id)?.id ?? "";
                          run(() => deleteWorkflow(selectedWorkflow.id));
                          setSelectedWorkflowId(fallback);
                        }}
                      >
                        ✕
                      </button>
                    </div>

                    <div className="field-group">
                      <span className="field-label">Flow chart</span>
                      <WorkflowFlowChart statuses={workflowStatuses} transitions={workflowTransitions} />
                    </div>

                    <div className="wf-editor-columns">
                      <div className="field-group">
                        <span className="field-label">States</span>
                        {workflowStatuses.map((s, i) => (
                          <div key={s.id} className="field-def-card">
                            <div className="field-def-head" style={{ gap: 6 }}>
                              <div style={{ display: "flex", flexDirection: "column" }}>
                                <button type="button" className="icon-btn" style={{ height: 16 }} disabled={i === 0 || pending} title="Move up" onClick={() => moveStatus(s.id, -1)}>
                                  ▲
                                </button>
                                <button
                                  type="button"
                                  className="icon-btn"
                                  style={{ height: 16 }}
                                  disabled={i === workflowStatuses.length - 1 || pending}
                                  title="Move down"
                                  onClick={() => moveStatus(s.id, 1)}
                                >
                                  ▼
                                </button>
                              </div>
                              <input
                                type="color"
                                className="team-color-input"
                                defaultValue={s.color}
                                title="Status colour"
                                onChange={(e) => run(() => updateWorkflowStatus(s.id, { color: e.target.value }))}
                              />
                              <input
                                className="text-input"
                                style={{ flex: 1 }}
                                defaultValue={s.label}
                                onBlur={(e) => {
                                  const value = e.target.value.trim();
                                  if (value && value !== s.label) run(() => updateWorkflowStatus(s.id, { label: value }));
                                }}
                              />
                              <button
                                className="icon-btn"
                                disabled={pending}
                                title="Delete status"
                                onClick={() => {
                                  if (confirm(`Delete "${s.label}"? Any ${taskNoun} still in it must be moved first.`)) run(() => deleteWorkflowStatus(s.id));
                                }}
                              >
                                ✕
                              </button>
                            </div>
                            <label className="checkbox-row" style={{ marginTop: 6 }}>
                              <input
                                type="checkbox"
                                disabled={pending}
                                defaultChecked={s.is_closed}
                                onChange={(e) => run(() => updateWorkflowStatus(s.id, { is_closed: e.target.checked }))}
                              />
                              <span style={{ fontSize: 12 }}>Closed — counts as finished ({taskNoun} dashboards, SLA timers, dependency checks)</span>
                            </label>
                          </div>
                        ))}
                        <div className="add-inline" style={{ marginTop: 8 }}>
                          <input
                            type="color"
                            className="team-color-input"
                            value={newStatusColor}
                            onChange={(e) => setNewStatusColor(e.target.value)}
                          />
                          <input
                            className="text-input"
                            style={{ flex: 1 }}
                            placeholder="New status name"
                            value={newStatusLabel}
                            onChange={(e) => setNewStatusLabel(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && addStatus()}
                          />
                          <button className="small-btn" disabled={!newStatusLabel.trim() || pending} onClick={addStatus}>
                            Add
                          </button>
                        </div>
                      </div>

                      <div className="field-group">
                        <span className="field-label">Transitions</span>
                        {workflowTransitions.length === 0 && (
                          <p style={{ color: "var(--text-faint)", fontSize: 12 }}>
                            No transitions defined — {taskNoun}s on this workflow can&apos;t change status at all yet.
                          </p>
                        )}
                        {workflowTransitions.map((t) => (
                          <div key={t.id} className="field-def-card">
                            <div className="field-def-head">
                              <span style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, flexWrap: "wrap" }}>
                                <StatusChip statusKey={statusById.get(t.from_status_id)?.key ?? ""} label={statusLabel(t.from_status_id)} color={statusById.get(t.from_status_id)?.color} />
                                <span style={{ color: "var(--text-faint)" }}>→</span>
                                <StatusChip statusKey={statusById.get(t.to_status_id)?.key ?? ""} label={statusLabel(t.to_status_id)} color={statusById.get(t.to_status_id)?.color} />
                              </span>
                              <button
                                className="icon-btn"
                                disabled={pending}
                                title="Remove transition"
                                onClick={() => {
                                  if (confirm(`Remove ${statusLabel(t.from_status_id)} → ${statusLabel(t.to_status_id)}?`)) run(() => deleteWorkflowTransition(t.id));
                                }}
                              >
                                ✕
                              </button>
                            </div>
                            <div className="crumbline">
                              Allowed for: {(t.allowed_roles as string[]).map((r) => ROLE_NAME[r] ?? r).join(", ")}
                              {(t.require_subtasks_complete || t.require_checklists_complete) && (
                                <>
                                  <br />
                                  Blocked until all {[t.require_subtasks_complete && "subtasks", t.require_checklists_complete && "checklists"]
                                    .filter(Boolean)
                                    .join(" and ")}{" "}
                                  complete
                                </>
                              )}
                            </div>
                          </div>
                        ))}

                        <div className="divider" />
                        <span className="field-label">Add / update a transition</span>
                        <div className="field-row" style={{ marginBottom: 8 }}>
                          <select className="select-input" value={effectiveFrom} onChange={(e) => setWfFrom(e.target.value)}>
                            {workflowStatuses.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.label}
                              </option>
                            ))}
                          </select>
                          <span style={{ alignSelf: "center", color: "var(--text-faint)" }}>→</span>
                          <select className="select-input" value={effectiveTo} onChange={(e) => setWfTo(e.target.value)}>
                            {workflowStatuses.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="field-row" style={{ marginBottom: 10 }}>
                          {WORKFLOW_ROLES.map((r) => (
                            <label key={r.id} className="checkbox-row" style={{ flex: 1 }}>
                              <input type="checkbox" checked={wfRoles.has(r.id)} onChange={() => toggleWfRole(r.id)} /> {r.name}
                            </label>
                          ))}
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 }}>
                          <label className="checkbox-row">
                            <input type="checkbox" checked={wfSubtasks} onChange={(e) => setWfSubtasks(e.target.checked)} /> Require all
                            subtasks complete
                          </label>
                          <label className="checkbox-row">
                            <input type="checkbox" checked={wfChecklists} onChange={(e) => setWfChecklists(e.target.checked)} /> Require all
                            checklists complete
                          </label>
                        </div>
                        {effectiveFrom && effectiveFrom === effectiveTo && (
                          <p style={{ color: "var(--text-faint)", fontSize: 11.5, marginBottom: 8 }}>Pick two different statuses.</p>
                        )}
                        <button
                          className="small-btn"
                          disabled={!effectiveFrom || !effectiveTo || effectiveFrom === effectiveTo || !wfRoles.size || pending}
                          onClick={addTransition}
                        >
                          Add / update transition
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {tab === "roles" && (
            <>
              <div className="banner">
                Roles are org-wide — the same 3 workflow roles apply no matter which workflow a {taskNoun} is on. A transition&apos;s
                own &quot;Allowed for&quot; list (set per workflow, on the Workflows tab) is what actually restricts who can make it.
              </div>

              <div className="field-group">
                <span className="field-label">Roles</span>
                {WORKFLOW_ROLES.map((r) => (
                  <div key={r.id} style={{ marginBottom: 6 }}>
                    <span className={`chip role-badge role-${r.id}`}>{r.name}</span>{" "}
                    <span className="crumbline" style={{ display: "inline" }}>
                      {r.blurb}
                    </span>
                  </div>
                ))}

                {members.map((m) => (
                  <div key={m.userId} className="field-def-card" style={{ marginTop: 8 }}>
                    <div className="field-def-head">
                      <span style={{ flex: 1 }}>
                        {m.name}
                        <span className="crumbline" style={{ display: "block" }}>
                          {m.email}
                        </span>
                      </span>
                      {ROLE_NAME[m.role] ? (
                        <span className={`chip role-badge role-${m.role}`}>{ROLE_NAME[m.role]}</span>
                      ) : (
                        <span className="chip" title="Owner/admin roles aren't managed from this panel">
                          {m.role}
                        </span>
                      )}
                    </div>
                  </div>
                ))}

                {!canManageRoles ? (
                  <p style={{ color: "var(--text-faint)", fontSize: 12, marginTop: 8 }}>
                    Only an owner or admin can reassign a member&apos;s role.
                  </p>
                ) : workflowMembers.length === 0 ? (
                  <p style={{ color: "var(--text-faint)", fontSize: 12, marginTop: 8 }}>
                    No members on a workflow role yet — owners/admins aren&apos;t reassignable from here.
                  </p>
                ) : (
                  <div className="add-inline" style={{ marginTop: 8 }}>
                    <select className="select-input" value={roleMemberId} onChange={(e) => setRoleMemberId(e.target.value)}>
                      {workflowMembers.map((m) => (
                        <option key={m.userId} value={m.userId}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                    <select className="select-input" value={roleForMember} onChange={(e) => setRoleForMember(e.target.value as Role)}>
                      {WORKFLOW_ROLES.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                    <button
                      className="small-btn"
                      disabled={pending || !roleMemberId}
                      onClick={() => run(() => updateMemberRole(orgId, roleMemberId, roleForMember))}
                    >
                      Update
                    </button>
                  </div>
                )}
              </div>

              <div className="divider" />

              <div className="field-group">
                <span className="field-label">Invite a member</span>
                {!canManageRoles ? (
                  <p style={{ color: "var(--text-faint)", fontSize: 12 }}>Only an owner or admin can invite new members.</p>
                ) : (
                  <>
                    {inviteNotice && <p style={{ color: "var(--text-faint)", fontSize: 12, marginBottom: 8 }}>{inviteNotice}</p>}
                    <div className="add-inline" style={{ marginBottom: 10 }}>
                      <input
                        className="text-input"
                        style={{ flex: 1 }}
                        type="email"
                        placeholder="name@company.com"
                        value={inviteEmail}
                        onChange={(e) => setInviteEmail(e.target.value)}
                      />
                      <select className="select-input" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)}>
                        {WORKFLOW_ROLES.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </select>
                      <button className="small-btn" disabled={pending || !inviteEmail.trim()} onClick={sendInvite}>
                        Send invite
                      </button>
                    </div>

                    {pendingInvites.length === 0 ? (
                      <p style={{ color: "var(--text-faint)", fontSize: 12 }}>No pending invites.</p>
                    ) : (
                      pendingInvites.map((inv) => (
                        <div key={inv.id} className="field-def-card">
                          <div className="field-def-head">
                            <span style={{ flex: 1 }}>
                              {inv.email}
                              <span className="crumbline" style={{ display: "block" }}>
                                Expires {new Date(inv.expires_at).toLocaleDateString()}
                              </span>
                            </span>
                            <span className={`chip role-badge role-${inv.role}`}>{ROLE_NAME[inv.role] ?? inv.role}</span>
                            <button
                              className="icon-btn"
                              disabled={pending}
                              title="Revoke invite"
                              onClick={() => {
                                if (confirm(`Revoke the invite to ${inv.email}?`)) run(() => revokeInvite(inv.id, orgId));
                              }}
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
