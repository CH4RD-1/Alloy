"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type {
  Workflow,
  WorkflowStatus,
  WorkflowTransition,
  WorkflowTransitionAction,
  TransitionActionType,
  CreateTaskActionConfig,
  TransitionLinkedTasksActionConfig,
  UpdateLinkedTasksActionConfig,
  UpdateLinkedDealActionConfig,
  WorkflowType,
  Role,
  Invite,
  Project,
} from "@/lib/types";
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
  createWorkflowTransitionAction,
  deleteWorkflowTransitionAction,
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

// The 4 object kinds a workflow can be built for — see schema.sql's own
// comment on workflows.type and the Workflow type in lib/types.ts.
const WORKFLOW_TYPE_META: Record<WorkflowType, { label: string; blurb: string }> = {
  task: { label: "Regular Tasks", blurb: "The default workflow for ordinary, schedulable work." },
  helpdesk: { label: "Helpdesk Tickets", blurb: "For Helpdesk-flagged projects — no dates, hidden from the Gantt." },
  asset: { label: "Assets", blurb: "For asset-allocation tasks, created from the Assets tab." },
  deal: { label: "Deal Pipeline", blurb: "For the Deals kanban — a deal's stage is one of this workflow's statuses." },
};
const WORKFLOW_TYPES: WorkflowType[] = ["task", "helpdesk", "asset", "deal"];

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

// Same SVG-space conversion as gantt-view.tsx's own svgPoint — duplicated
// locally (this file has no reason to import from that one otherwise) for
// the flow chart's drag-to-link below.
function svgPoint(svg: SVGSVGElement, clientX: number, clientY: number) {
  const r = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  const scaleX = vb.width / r.width || 1;
  const scaleY = vb.height / r.height || 1;
  return { x: (clientX - r.left) * scaleX, y: (clientY - r.top) * scaleY };
}

// Same idea as gantt-view.tsx's own pair of the same name — suppressing
// text selection for the duration of a drag so dragging across the SVG
// doesn't also highlight page text.
function disableTextSelection() {
  document.body.style.userSelect = "none";
}
function restoreTextSelection() {
  document.body.style.userSelect = "";
}

interface EdgeMenuState {
  transitionId: string;
  fromStatusId: string;
  toStatusId: string;
  allowedRoles: Set<Role>;
  requireSubtasks: boolean;
  requireChecklists: boolean;
  automationsEnabled: boolean;
  x: number;
  y: number;
}

// A simple auto-laid-out diagram of one workflow's states/transitions —
// states in position order along a single row, transitions drawn as curved
// arrows (below the row for a "forward" move, above it for a "backward"
// one, so a typical mostly-linear workflow doesn't turn into a tangle). Now
// also its own editing surface, not just a picture of what the lists below
// describe: each state has 4 small drag handles (top/right/bottom/left —
// any of them starts the same drag, the side is just where you grabbed it),
// mirroring gantt-view.tsx's own handleLinkMouseDown almost exactly —
// dragging to a different state's box and dropping either creates a new
// transition there (wide-open defaults: every role, no require-complete
// gates — the same "start permissive, refine after" idea as a Gantt link
// always starting out "Blocked") or, if one already exists for that exact
// pair, opens the same edit popover a click on the transition's own arrow
// opens. That popover (allowed roles, the two require checkboxes, remove)
// is this diagram's equivalent of Gantt's floating link-type menu — the
// list-based "Add / update a transition" form below is untouched and still
// works exactly as before; this is a second way to reach the same
// upsertWorkflowTransition/deleteWorkflowTransition actions, not a
// replacement for it.
function WorkflowFlowChart({
  orgId,
  statuses,
  transitions,
  pending,
  run,
}: {
  orgId: string;
  statuses: WorkflowStatus[];
  transitions: WorkflowTransition[];
  pending: boolean;
  run: (action: () => Promise<unknown>) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [edgeMenu, setEdgeMenu] = useState<EdgeMenuState | null>(null);

  const ordered = [...statuses].sort((a, b) => a.position - b.position);

  useEffect(() => {
    if (!edgeMenu) return;
    function onDocMouseDown(ev: MouseEvent) {
      if ((ev.target as Element).closest(".wf-flow-edge-menu")) return;
      setEdgeMenu(null);
    }
    function onScroll() {
      setEdgeMenu(null);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [edgeMenu]);

  if (ordered.length === 0) {
    return <p style={{ color: "var(--text-faint)", fontSize: 12.5, padding: "20px 0" }}>Add a state below to see it here.</p>;
  }
  const nodeW = 152;
  const nodeH = 40;
  const gapX = 96;
  const padding = 24;
  const rowY = 76;
  const idxById = new Map(ordered.map((s, i) => [s.id, i]));
  const statusById = new Map(ordered.map((s) => [s.id, s]));
  const xFor = (i: number) => padding + i * (nodeW + gapX);
  const width = padding * 2 + ordered.length * nodeW + Math.max(0, ordered.length - 1) * gapX;
  const height = 220;

  function openEdgeMenu(t: WorkflowTransition, clientX: number, clientY: number) {
    setEdgeMenu({
      transitionId: t.id,
      fromStatusId: t.from_status_id,
      toStatusId: t.to_status_id,
      allowedRoles: new Set(t.allowed_roles as Role[]),
      requireSubtasks: t.require_subtasks_complete,
      requireChecklists: t.require_checklists_complete,
      automationsEnabled: t.automations_enabled,
      x: clientX,
      y: clientY,
    });
  }

  function handleMouseDown(e: React.MouseEvent, fromStatusId: string, startX: number, startY: number) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const svg = svgRef.current;
    if (!svg) return;

    disableTextSelection();
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("class", "wf-flow-link-preview");
    line.setAttribute("x1", String(startX));
    line.setAttribute("y1", String(startY));
    line.setAttribute("x2", String(startX));
    line.setAttribute("y2", String(startY));
    svg.appendChild(line);

    let hoverTarget: Element | null = null;
    function clearHover() {
      if (hoverTarget) {
        hoverTarget.classList.remove("wf-flow-node-target");
        hoverTarget = null;
      }
    }
    function onMove(ev: MouseEvent) {
      const p = svgPoint(svg!, ev.clientX, ev.clientY);
      line.setAttribute("x2", String(p.x));
      line.setAttribute("y2", String(p.y));
      const hoverEl = document.elementFromPoint(ev.clientX, ev.clientY);
      const grp = hoverEl?.closest(".wf-flow-node") ?? null;
      const valid = grp && grp.getAttribute("data-status-id") !== fromStatusId ? grp : null;
      if (hoverTarget !== valid) {
        clearHover();
        if (valid) {
          valid.classList.add("wf-flow-node-target");
          hoverTarget = valid;
        }
      }
    }
    function onUp(ev: MouseEvent) {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      restoreTextSelection();
      clearHover();
      line.remove();
      const dropEl = document.elementFromPoint(ev.clientX, ev.clientY);
      const grp = dropEl?.closest(".wf-flow-node");
      const toStatusId = grp?.getAttribute("data-status-id");
      if (toStatusId && toStatusId !== fromStatusId) {
        const existing = transitions.find((t) => t.from_status_id === fromStatusId && t.to_status_id === toStatusId);
        if (existing) {
          openEdgeMenu(existing, ev.clientX, ev.clientY);
        } else {
          run(() =>
            upsertWorkflowTransition(orgId, {
              from_status_id: fromStatusId,
              to_status_id: toStatusId,
              allowed_roles: WORKFLOW_ROLES.map((r) => r.id),
              require_subtasks_complete: false,
              require_checklists_complete: false,
            })
          );
        }
      }
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function toggleEdgeRole(r: Role) {
    setEdgeMenu((prev) => {
      if (!prev) return prev;
      const next = new Set(prev.allowedRoles);
      if (next.has(r)) next.delete(r);
      else next.add(r);
      return { ...prev, allowedRoles: next };
    });
  }

  function saveEdgeMenu() {
    if (!edgeMenu) return;
    const { fromStatusId, toStatusId, allowedRoles, requireSubtasks, requireChecklists, automationsEnabled } = edgeMenu;
    setEdgeMenu(null);
    run(() =>
      upsertWorkflowTransition(orgId, {
        from_status_id: fromStatusId,
        to_status_id: toStatusId,
        allowed_roles: Array.from(allowedRoles),
        require_subtasks_complete: requireSubtasks,
        require_checklists_complete: requireChecklists,
        automations_enabled: automationsEnabled,
      })
    );
  }

  function removeEdgeMenu() {
    if (!edgeMenu) return;
    const { transitionId } = edgeMenu;
    setEdgeMenu(null);
    run(() => deleteWorkflowTransition(transitionId));
  }

  return (
    <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: 10, background: "var(--surface-2)", padding: 8 }}>
      <p style={{ color: "var(--text-faint)", fontSize: 11.5, margin: "0 0 6px" }}>
        Drag from a state&apos;s edge to another state to add a transition; click an existing arrow to edit or remove it.{" "}
        <span style={{ color: "#3b82f6" }}>Blue</span> arrows have automations enabled.
      </p>
      <svg ref={svgRef} width={Math.max(width, 300)} height={height} style={{ display: "block" }}>
        <defs>
          <marker id="wf-flow-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--text-faint)" />
          </marker>
          {/* Same arrowhead, in the same blue as an automations_enabled
              edge's own stroke below — so a glance at the diagram shows
              which moves carry an automation without opening each one. */}
          <marker id="wf-flow-arrow-automation" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="#3b82f6" />
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
            <g key={t.id}>
              <path
                d={path}
                fill="none"
                stroke={t.automations_enabled ? "#3b82f6" : "var(--text-faint)"}
                strokeWidth={t.automations_enabled ? 2 : 1.5}
                opacity={t.automations_enabled ? 0.9 : 0.75}
                markerEnd={t.automations_enabled ? "url(#wf-flow-arrow-automation)" : "url(#wf-flow-arrow)"}
              />
              {/* Invisible wide-stroke overlay, same trick as
                  gantt-view.tsx's own .gantt-link-hit — the visible curve
                  above is too thin to click reliably. */}
              <path
                d={path}
                className="wf-flow-edge-hit"
                fill="none"
                stroke="transparent"
                strokeWidth={12}
                onClick={(e) => {
                  e.stopPropagation();
                  openEdgeMenu(t, e.clientX, e.clientY);
                }}
              />
            </g>
          );
        })}
        {ordered.map((s, i) => {
          const x = xFor(i);
          const cx = nodeW / 2;
          const cy = nodeH / 2;
          // Top/right/bottom/left — any one starts the same drag (see
          // handleMouseDown); having all 4 just means there's always a
          // handle facing whichever neighbor you're connecting to.
          const handles: { cx: number; cy: number }[] = [
            { cx, cy: 0 },
            { cx: nodeW, cy },
            { cx, cy: nodeH },
            { cx: 0, cy },
          ];
          return (
            <g key={s.id} className="wf-flow-node" data-status-id={s.id} transform={`translate(${x}, ${rowY})`}>
              <rect width={nodeW} height={nodeH} rx={10} fill={tint(s.color, 0.18)} stroke={s.color} strokeWidth={1.5} />
              <text x={nodeW / 2} y={nodeH / 2 + 4} textAnchor="middle" fontSize={12} fontWeight={600} fill={s.color}>
                {s.label}
              </text>
              {handles.map((h, hi) => (
                <circle
                  key={hi}
                  className="wf-flow-handle"
                  cx={h.cx}
                  cy={h.cy}
                  r={5}
                  onMouseDown={(e) => handleMouseDown(e, s.id, x + h.cx, rowY + h.cy)}
                />
              ))}
            </g>
          );
        })}
      </svg>
      {edgeMenu && (
        <div className="obj-menu wf-flow-edge-menu" style={{ position: "fixed", left: edgeMenu.x + 10, top: edgeMenu.y + 10, zIndex: 60, width: 220 }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, padding: "2px 6px 6px" }}>
            {statusById.get(edgeMenu.fromStatusId)?.label ?? "Unknown"} → {statusById.get(edgeMenu.toStatusId)?.label ?? "Unknown"}
          </div>
          {WORKFLOW_ROLES.map((r) => (
            <label key={r.id} className="checkbox-row" style={{ padding: "2px 6px" }}>
              <input type="checkbox" checked={edgeMenu.allowedRoles.has(r.id)} onChange={() => toggleEdgeRole(r.id)} /> {r.name}
            </label>
          ))}
          <label className="checkbox-row" style={{ padding: "2px 6px" }}>
            <input
              type="checkbox"
              checked={edgeMenu.requireSubtasks}
              onChange={(e) => setEdgeMenu((prev) => (prev ? { ...prev, requireSubtasks: e.target.checked } : prev))}
            />{" "}
            Require subtasks complete
          </label>
          <label className="checkbox-row" style={{ padding: "2px 6px" }}>
            <input
              type="checkbox"
              checked={edgeMenu.requireChecklists}
              onChange={(e) => setEdgeMenu((prev) => (prev ? { ...prev, requireChecklists: e.target.checked } : prev))}
            />{" "}
            Require checklists complete
          </label>
          <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />
          <label className="checkbox-row" style={{ padding: "2px 6px" }}>
            <input
              type="checkbox"
              checked={edgeMenu.automationsEnabled}
              onChange={(e) => setEdgeMenu((prev) => (prev ? { ...prev, automationsEnabled: e.target.checked } : prev))}
            />{" "}
            Enable automations for this move
          </label>
          <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />
          <button type="button" className="obj-menu-item" disabled={pending || edgeMenu.allowedRoles.size === 0} onClick={saveEdgeMenu}>
            Save
          </button>
          <button type="button" className="obj-menu-item" style={{ color: "var(--blocked)" }} disabled={pending} onClick={removeEdgeMenu}>
            Remove transition
          </button>
        </div>
      )}
    </div>
  );
}

const ACTION_TYPE_META: Record<TransitionActionType, string> = {
  create_task: "Create a new task",
  transition_linked_tasks: "Move linked tasks",
  update_linked_tasks: "Reassign linked tasks",
  update_linked_deal: "Move the linked deal",
};

// transition_linked_tasks/update_linked_tasks act on "every task linked to
// the triggering deal" — meaningless when the trigger is already a task (see
// TransitionActionType's own comment) — so those two are only offered on a
// 'deal' workflow's transitions; update_linked_deal is their mirror image,
// only offered everywhere else.
function actionTypesFor(workflowType: WorkflowType): TransitionActionType[] {
  return workflowType === "deal"
    ? ["create_task", "transition_linked_tasks", "update_linked_tasks"]
    : ["create_task", "update_linked_deal"];
}

// One-line, human summary of an existing action — the delete-and-re-add
// list doesn't need a full re-render of the add form to explain itself.
function describeAction(
  action: WorkflowTransitionAction,
  statusById: Map<string, WorkflowStatus>,
  projectById: Map<string, Project>,
  memberNameById: Map<string, string>,
  dealStatusById: Map<string, WorkflowStatus>
): string {
  if (action.action_type === "create_task") {
    const config = action.config as CreateTaskActionConfig;
    const project = projectById.get(config.project_id)?.name ?? "an unknown project";
    const status = statusById.get(config.workflow_status_id)?.label ?? "an unknown status";
    const assignee =
      config.assignee_mode === "deal_owner"
        ? "the linked deal's owner"
        : config.assignee_id
        ? memberNameById.get(config.assignee_id) ?? "an unknown teammate"
        : null;
    const dueDate = config.due_date_from_deal_close
      ? `, due ${config.due_date_offset_days ? `${Math.abs(config.due_date_offset_days)} day${Math.abs(config.due_date_offset_days) === 1 ? "" : "s"} ${config.due_date_offset_days < 0 ? "before" : "after"} ` : "on "}the linked deal's expected close date`
      : "";
    return `New task "${config.title || "{{deal}}"}" in ${project}, at ${status}${assignee ? `, assigned to ${assignee}` : ""}${dueDate}`;
  }
  if (action.action_type === "transition_linked_tasks") {
    const config = action.config as TransitionLinkedTasksActionConfig;
    const status = statusById.get(config.workflow_status_id)?.label ?? "an unknown status";
    return `Move every linked task to ${status}`;
  }
  if (action.action_type === "update_linked_deal") {
    const config = action.config as UpdateLinkedDealActionConfig;
    const status = dealStatusById.get(config.workflow_status_id)?.label ?? "an unknown stage";
    return `Move the task's linked deal to ${status} (does nothing if it isn't linked to one)`;
  }
  const config = action.config as UpdateLinkedTasksActionConfig;
  const assignee = config.assignee_id ? memberNameById.get(config.assignee_id) ?? "an unknown teammate" : null;
  return assignee ? `Reassign every linked task to ${assignee}` : "Reassign linked tasks (nothing configured yet)";
}

// Attached to one transition — what else happens on this exact move (see
// schema.sql's own comment on workflow_transition_actions, and
// updateDealStage/updateTaskStatus's shared runTransitionActions() in
// lib/actions.ts for where these actually run). Available on every workflow
// type; which action types are offered depends on whether the trigger is a
// deal or a task (see actionTypesFor above) — its call site below only
// renders this at all once the transition's own automations_enabled switch
// is on.
function TransitionAutomations({
  orgId,
  transitionId,
  actions,
  workflowType,
  statuses,
  projects,
  taskWorkflows,
  dealStatuses,
  members,
  pending,
  run,
}: {
  orgId: string;
  transitionId: string;
  actions: WorkflowTransitionAction[];
  workflowType: WorkflowType;
  statuses: WorkflowStatus[];
  projects: Project[];
  taskWorkflows: Workflow[];
  dealStatuses: WorkflowStatus[];
  members: MemberSummary[];
  pending: boolean;
  run: (action: () => Promise<unknown>) => void;
}) {
  const statusById = new Map(statuses.map((s) => [s.id, s]));
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const memberNameById = new Map(members.map((m) => [m.userId, m.name]));
  const dealStatusById = new Map(dealStatuses.map((s) => [s.id, s]));
  const availableTypes = actionTypesFor(workflowType);

  const [actionType, setActionType] = useState<TransitionActionType>(availableTypes[0]);
  const effectiveActionType = availableTypes.includes(actionType) ? actionType : availableTypes[0];
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [taskStatusId, setTaskStatusId] = useState("");
  const [assigneeMode, setAssigneeMode] = useState<"fixed" | "deal_owner">("fixed");
  const [assigneeId, setAssigneeId] = useState("");
  const [dueFromDealClose, setDueFromDealClose] = useState(false);
  const [dueOffsetDays, setDueOffsetDays] = useState("0");
  const [moveWorkflowId, setMoveWorkflowId] = useState(taskWorkflows[0]?.id ?? "");
  const [moveStatusId, setMoveStatusId] = useState("");
  const [dealMoveStatusId, setDealMoveStatusId] = useState(dealStatuses[0]?.id ?? "");

  const project = projects.find((p) => p.id === projectId) ?? projects[0];
  const projectStatuses = statuses.filter((s) => s.workflow_id === project?.workflow_id).sort((a, b) => a.position - b.position);
  const effectiveTaskStatusId = projectStatuses.some((s) => s.id === taskStatusId) ? taskStatusId : projectStatuses[0]?.id ?? "";

  const moveStatuses = statuses.filter((s) => s.workflow_id === moveWorkflowId).sort((a, b) => a.position - b.position);
  const effectiveMoveStatusId = moveStatuses.some((s) => s.id === moveStatusId) ? moveStatusId : moveStatuses[0]?.id ?? "";
  const effectiveDealMoveStatusId = dealStatuses.some((s) => s.id === dealMoveStatusId) ? dealMoveStatusId : dealStatuses[0]?.id ?? "";

  function addAction() {
    let config: CreateTaskActionConfig | TransitionLinkedTasksActionConfig | UpdateLinkedTasksActionConfig | UpdateLinkedDealActionConfig;
    if (effectiveActionType === "create_task") {
      if (!effectiveTaskStatusId || !project) return;
      config = {
        title: title.trim(),
        project_id: project.id,
        workflow_status_id: effectiveTaskStatusId,
        assignee_mode: assigneeMode,
        assignee_id: assigneeMode === "fixed" ? assigneeId || null : null,
        due_date_from_deal_close: dueFromDealClose,
        due_date_offset_days: dueFromDealClose ? Number(dueOffsetDays) || 0 : undefined,
      };
    } else if (effectiveActionType === "transition_linked_tasks") {
      if (!effectiveMoveStatusId) return;
      config = { workflow_status_id: effectiveMoveStatusId };
    } else if (effectiveActionType === "update_linked_deal") {
      if (!effectiveDealMoveStatusId) return;
      config = { workflow_status_id: effectiveDealMoveStatusId };
    } else {
      if (!assigneeId) return;
      config = { assignee_id: assigneeId };
    }
    run(() => createWorkflowTransitionAction(orgId, transitionId, effectiveActionType, config));
    setTitle("");
    setAssigneeId("");
    setAssigneeMode("fixed");
    setDueFromDealClose(false);
    setDueOffsetDays("0");
  }

  const canAdd =
    effectiveActionType === "create_task"
      ? !!effectiveTaskStatusId && !!project
      : effectiveActionType === "transition_linked_tasks"
      ? !!effectiveMoveStatusId
      : effectiveActionType === "update_linked_deal"
      ? !!effectiveDealMoveStatusId
      : !!assigneeId;

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border, #e5e7eb)" }}>
      <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-faint)", marginBottom: 6 }}>
        Automations — what else happens on this move
      </div>
      {actions.length === 0 && <p style={{ color: "var(--text-faint)", fontSize: 11.5, margin: "0 0 6px" }}>None yet.</p>}
      {actions.map((a) => (
        <div key={a.id} className="crumbline" style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
          <span style={{ flex: 1 }}>
            {ACTION_TYPE_META[a.action_type]}: {describeAction(a, statusById, projectById, memberNameById, dealStatusById)}
          </span>
          <button
            className="icon-btn"
            disabled={pending}
            title="Remove this automation"
            onClick={() => run(() => deleteWorkflowTransitionAction(a.id))}
          >
            ✕
          </button>
        </div>
      ))}

      <div className="field-row" style={{ marginTop: 6, marginBottom: 6 }}>
        <select className="select-input" style={{ flex: 1 }} value={effectiveActionType} onChange={(e) => setActionType(e.target.value as TransitionActionType)}>
          {availableTypes.map((t) => (
            <option key={t} value={t}>
              {ACTION_TYPE_META[t]}
            </option>
          ))}
        </select>
      </div>

      {effectiveActionType === "create_task" && (
        <>
          <input
            className="text-input"
            style={{ marginBottom: 6, width: "100%" }}
            placeholder='Task title — "{{deal}}" becomes the deal title'
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <div className="field-row" style={{ marginBottom: 6 }}>
            <select className="select-input" style={{ flex: 1 }} value={project?.id ?? ""} onChange={(e) => setProjectId(e.target.value)}>
              {projects.length === 0 && <option value="">No projects yet</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select className="select-input" style={{ flex: 1 }} value={effectiveTaskStatusId} onChange={(e) => setTaskStatusId(e.target.value)}>
              {projectStatuses.length === 0 && <option value="">Project has no workflow</option>}
              {projectStatuses.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field-row" style={{ marginBottom: 6 }}>
            <select
              className="select-input"
              style={{ flex: 1 }}
              value={assigneeMode}
              onChange={(e) => setAssigneeMode(e.target.value as "fixed" | "deal_owner")}
            >
              <option value="fixed">Assign to…</option>
              <option value="deal_owner">Assign to the linked deal's owner</option>
            </select>
            {assigneeMode === "fixed" && (
              <select className="select-input" style={{ flex: 1 }} value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
                <option value="">Unassigned</option>
                {members.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <label className="checkbox-row" style={{ padding: "2px 0", marginBottom: 6 }}>
            <input type="checkbox" checked={dueFromDealClose} onChange={(e) => setDueFromDealClose(e.target.checked)} />{" "}
            Due date follows the linked deal's expected close date
          </label>
          {dueFromDealClose && (
            <div className="field-row" style={{ marginBottom: 6, alignItems: "center" }}>
              <input
                type="number"
                className="text-input"
                style={{ width: 70 }}
                value={dueOffsetDays}
                onChange={(e) => setDueOffsetDays(e.target.value)}
              />
              <span style={{ fontSize: 11.5, color: "var(--text-faint)" }}>
                days offset (negative = before close date, 0 = on it, positive = after)
              </span>
            </div>
          )}
        </>
      )}

      {effectiveActionType === "transition_linked_tasks" && (
        <div className="field-row" style={{ marginBottom: 6 }}>
          <select
            className="select-input"
            style={{ flex: 1 }}
            value={moveWorkflowId}
            onChange={(e) => {
              setMoveWorkflowId(e.target.value);
              setMoveStatusId("");
            }}
          >
            {taskWorkflows.length === 0 && <option value="">No task workflows yet</option>}
            {taskWorkflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <select className="select-input" style={{ flex: 1 }} value={effectiveMoveStatusId} onChange={(e) => setMoveStatusId(e.target.value)}>
            {moveStatuses.length === 0 && <option value="">No statuses</option>}
            {moveStatuses.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {effectiveActionType === "update_linked_tasks" && (
        <select className="select-input" style={{ width: "100%", marginBottom: 6 }} value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
          <option value="">Pick a teammate…</option>
          {members.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.name}
            </option>
          ))}
        </select>
      )}

      {effectiveActionType === "update_linked_deal" && (
        <select
          className="select-input"
          style={{ width: "100%", marginBottom: 6 }}
          value={effectiveDealMoveStatusId}
          onChange={(e) => setDealMoveStatusId(e.target.value)}
        >
          {dealStatuses.length === 0 && <option value="">No deal stages yet</option>}
          {dealStatuses.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      )}

      <button className="small-btn" disabled={!canAdd || pending} onClick={addAction}>
        Add automation
      </button>
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
  transitionActions,
  projects,
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
  transitionActions: WorkflowTransitionAction[];
  projects: Project[];
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
  // Feeds the "Move linked tasks"/"Reassign linked tasks" actions' own
  // target-status pickers (Deal-workflow automations only — see
  // TransitionAutomations' own comment).
  const taskWorkflows = useMemo(() => workflows.filter((w) => w.type === "task" || w.type === "helpdesk"), [workflows]);
  // Feeds the reverse case: a Task/Helpdesk/Asset-workflow automation's
  // "update_linked_deal" action needs a deal-workflow status to move the
  // linked deal to. An org has at most one 'deal'-type workflow (created
  // once by CRM Phase A's own DB patch/completeSignup), so this is just that
  // workflow's own statuses.
  const dealWorkflow = useMemo(() => workflows.find((w) => w.type === "deal"), [workflows]);
  const dealStatuses = useMemo(
    () => statuses.filter((s) => s.workflow_id === dealWorkflow?.id).sort((a, b) => a.position - b.position),
    [statuses, dealWorkflow]
  );

  const groupedWorkflows: Record<WorkflowType, Workflow[]> = { task: [], helpdesk: [], asset: [], deal: [] };
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
  const [wfAutomations, setWfAutomations] = useState(false);

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
        automations_enabled: wfAutomations,
      })
    );
    setWfRoles(new Set(WORKFLOW_ROLES.map((r) => r.id)));
    setWfSubtasks(false);
    setWfChecklists(false);
    setWfAutomations(false);
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
                      <WorkflowFlowChart orgId={orgId} statuses={workflowStatuses} transitions={workflowTransitions} pending={pending} run={run} />
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
                        {selectedWorkflow.type === "deal" ? (
                          <p style={{ color: "var(--text-faint)", fontSize: 12 }}>
                            A deal can move to any stage regardless of what&apos;s defined here — &quot;Allowed for&quot; and the two
                            require-complete checks below don&apos;t apply to deals yet, only to Regular Tasks/Helpdesk/Assets. Define
                            a transition here anyway to attach an automation to that exact move, and switch on &quot;Enable
                            automations for this move&quot; below to reveal it.
                          </p>
                        ) : (
                          workflowTransitions.length === 0 && (
                            <p style={{ color: "var(--text-faint)", fontSize: 12 }}>
                              No transitions defined — {taskNoun}s on this workflow can&apos;t change status at all yet.
                            </p>
                          )
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
                            {/* A persistent, always-visible toggle right on the
                                card — the flow chart's own edge-menu popover has
                                the same checkbox, but it's a transient overlay
                                with no lasting on/off indicator once it closes
                                (see this card's own blue-when-enabled edge on
                                the flow chart above for the other half of that
                                same "make the state visible" fix). Writes the
                                same fields the edge menu/add-transition form
                                would, just for this one flag. */}
                            <label className="checkbox-row" style={{ marginTop: 6 }}>
                              <input
                                type="checkbox"
                                checked={t.automations_enabled}
                                disabled={pending}
                                onChange={(e) =>
                                  run(() =>
                                    upsertWorkflowTransition(orgId, {
                                      from_status_id: t.from_status_id,
                                      to_status_id: t.to_status_id,
                                      allowed_roles: t.allowed_roles as Role[],
                                      require_subtasks_complete: t.require_subtasks_complete,
                                      require_checklists_complete: t.require_checklists_complete,
                                      automations_enabled: e.target.checked,
                                    })
                                  )
                                }
                              />{" "}
                              Enable automations for this move
                            </label>
                            {t.automations_enabled && (
                              <TransitionAutomations
                                orgId={orgId}
                                transitionId={t.id}
                                actions={transitionActions.filter((a) => a.transition_id === t.id).sort((a, b) => a.position - b.position)}
                                workflowType={selectedWorkflow.type}
                                statuses={statuses}
                                projects={projects}
                                taskWorkflows={taskWorkflows}
                                dealStatuses={dealStatuses}
                                members={members}
                                pending={pending}
                                run={run}
                              />
                            )}
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
                          <label className="checkbox-row">
                            <input type="checkbox" checked={wfAutomations} onChange={(e) => setWfAutomations(e.target.checked)} /> Enable
                            automations for this move
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
