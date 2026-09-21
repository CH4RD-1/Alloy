"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { TaskRow } from "@/lib/list-view";
import { hueFor, initials } from "@/lib/list-view";
import type {
  WorkflowStatus,
  WorkflowTransition,
  Team,
  Project,
  TaskLink,
  Task,
  Role,
  Doc,
  TaskObject,
  TaskObjectFile,
  ChecklistItem,
  CustomFieldDef,
  FormFieldType,
  ActivityLogEntry,
  TicketMessage,
  TicketChannel,
  Contact,
  Asset,
} from "@/lib/types";
import type { MemberSummary } from "@/lib/tasks-data";
import { activitySummary, actorDisplayName, timeAgo } from "@/lib/activity-view";
import { StatusChip } from "@/components/task-list-view";
import { eligibleAssignees } from "@/lib/team-allocation";
import { assetDisplayStatus, assetStatusLabel, costLabel } from "@/lib/assets-view";
import { firstResponseTarget, resolutionTarget, formatDuration } from "@/lib/sla";
import {
  updateTaskStatus,
  updateTaskFields,
  addTag,
  removeTag,
  createTask,
  deleteTask,
  addLink,
  removeLink,
  linkDocToTask,
  unlinkDocFromTask,
  setCustomFieldValue,
  sendChannelReply,
  addInternalNote,
  simulateCustomerMessage,
} from "@/lib/actions";
import { TaskObjects } from "@/components/task-objects";
import { AssetIcon } from "@/components/asset-icon";

const LINK_TYPE_META: Record<string, { label: string; className: string }> = {
  // "blocked"/"blocks" are always stored as a mirrored pair (see addLink()
  // in lib/actions.ts), so both a task's own dependencies and the tasks it
  // blocks now show up correctly labeled in this same Links section.
  blocked: { label: "Blocked", className: "link-type-block" },
  blocks: { label: "Blocks", className: "link-type-block" },
  concurrent: { label: "Concurrent", className: "link-type-concurrent" },
  related: { label: "Related", className: "link-type-related" },
  clone: { label: "Clone", className: "link-type-clone" },
};

export function TaskPanel({
  taskId,
  allRows,
  links,
  statuses,
  transitions,
  teams,
  projects,
  members,
  orgId,
  currentUserRole,
  docs,
  docIdsByTask,
  taskObjects,
  checklistItemsByObject,
  taskObjectFileByObjectId,
  customFieldDefs,
  customFieldValuesByTask,
  activityLog,
  contactNameById,
  contactById,
  ticketMessages,
  orgTeamAllocationEnabled,
  teamMemberIdsByTeam,
  slaFirstResponseHours,
  slaResolutionDays,
  assets,
  onOpenAsset,
  onSelectDoc,
  onClose,
}: {
  taskId: string;
  allRows: TaskRow[]; // flattened: every task, top-level and sub (see flattenRows)
  links: TaskLink[];
  statuses: WorkflowStatus[];
  transitions: WorkflowTransition[];
  teams: Team[];
  projects: Project[];
  members: MemberSummary[];
  orgId: string;
  currentUserRole: Role;
  docs: Doc[];
  docIdsByTask: Map<string, string[]>;
  taskObjects: TaskObject[];
  checklistItemsByObject: Map<string, ChecklistItem[]>;
  taskObjectFileByObjectId: Map<string, TaskObjectFile & { url: string | null }>;
  customFieldDefs: CustomFieldDef[];
  customFieldValuesByTask: Map<string, Record<string, unknown>>;
  activityLog: ActivityLogEntry[];
  contactNameById: Map<string, string>;
  contactById: Map<string, Contact>;
  ticketMessages: TicketMessage[];
  orgTeamAllocationEnabled: boolean;
  teamMemberIdsByTeam: Map<string, string[]>;
  slaFirstResponseHours: number;
  slaResolutionDays: number;
  assets: Asset[];
  onOpenAsset: (assetId: string) => void;
  // Opens the linked doc's own panel beside this one (double-width, see
  // .panel-doc in globals.css) without closing this task's panel — omit to
  // fall back to a non-clickable row.
  onSelectDoc?: (docId: string) => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [tagInput, setTagInput] = useState("");
  const [linkTargetId, setLinkTargetId] = useState("");
  const [linkType, setLinkType] = useState<"blocked" | "concurrent" | "related" | "clone">("blocked");
  const [docTargetId, setDocTargetId] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Maximize toggle (see the '<' chevron in panel-head below) — cycles
  // normal (440px, the .panel default) -> double-width -> full-screen and
  // back, for tickets whose Conversation thread runs long. Only rendered on
  // this main panel; the Asset Allocation panel below is deliberately kept
  // minimal and doesn't get one.
  const [panelWidth, setPanelWidth] = useState<"normal" | "double" | "full">("normal");

  const row = allRows.find((r) => r.task.id === taskId);
  if (!row) return null;
  const task = row.task;

  if (task.kind === "asset_allocation") {
    return (
      <AssetAllocationPanel
        task={task}
        allRows={allRows}
        links={links}
        statuses={statuses}
        assets={assets}
        orgId={orgId}
        onOpenAsset={onOpenAsset}
        onClose={onClose}
      />
    );
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

  const project = projects.find((p) => p.id === task.project_id);
  const projectTeams = teams.filter((t) => t.project_id === task.project_id);
  const outgoing = transitions.filter((t) => t.from_status_id === task.status_id);
  const canMove = (t: WorkflowTransition) =>
    currentUserRole === "owner" || currentUserRole === "admin" || t.allowed_roles.includes(currentUserRole);

  const taskLinks = links.filter((l) => l.from_task_id === taskId);
  const otherTasks = allRows.filter((r) => r.task.id !== taskId && r.task.project_id === task.project_id);
  const children = row.children ?? [];

  const linkedDocIds = docIdsByTask.get(taskId) ?? [];
  const linkedDocs = docs.filter((d) => linkedDocIds.includes(d.id));
  const linkableDocs = docs.filter((d) => !linkedDocIds.includes(d.id));

  // SLA info (Helpdesk tickets only — see the "Raised"/"SLA" field-group
  // below, which replaces the regular Dates field-group for these tasks:
  // a ticket isn't scheduled, so a Start/Due date pair means nothing for
  // it). "First response" is met by this ticket's own earliest public
  // outbound message — a private note doesn't count, since the customer
  // never sees it. "Resolution" is met the first time this ticket reached
  // this ticket's own workflow's closed status, found via activity_log
  // rather than just checking the task's *current* status, so a later
  // reopen doesn't erase how (and whether, on time) the SLA was actually
  // met. Scoped to this task's own workflow (via its current status's
  // workflow_id) rather than statuses.find(key === "done") — a project's
  // workflow is now user-chosen, so its closed status's key can be anything.
  const currentStatusRow = statuses.find((s) => s.id === task.status_id);
  const doneStatus = currentStatusRow
    ? statuses.find((s) => s.workflow_id === currentStatusRow.workflow_id && s.is_closed)
    : undefined;
  const firstResponseAt =
    [...ticketMessages]
      .filter((m) => m.task_id === taskId && m.direction === "outbound" && m.visibility === "public")
      .sort((a, b) => a.created_at.localeCompare(b.created_at))[0]?.created_at ?? null;
  const doneActivity = doneStatus
    ? activityLog
        .filter((a) => a.task_id === taskId && a.type === "status" && a.to_status_id === doneStatus.id)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
    : [];
  const isCurrentlyDone = !!doneStatus && task.status_id === doneStatus.id;
  const resolvedAt = isCurrentlyDone && doneActivity.length ? doneActivity[doneActivity.length - 1].created_at : null;

  return (
    <>
      <div className="scrim show" onClick={onClose} />
      <aside className={"panel show" + (panelWidth === "double" ? " panel-double" : panelWidth === "full" ? " panel-full" : "")}>
        <div className="panel-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <input
              className="panel-title-input"
              defaultValue={task.title}
              onBlur={(e) => {
                const value = e.target.value.trim();
                if (value && value !== task.title) run(() => updateTaskFields(taskId, { title: value }));
              }}
            />
            <div className="crumbline">
              {task.display_id && <span className="task-id-badge" style={{ marginRight: 6 }}>{task.display_id}</span>}
              {project?.name}
              {row.teamName ? ` · ${row.teamName}` : ""}
            </div>
          </div>
          <button
            className="icon-btn"
            onClick={() => setPanelWidth((w) => (w === "normal" ? "double" : w === "double" ? "full" : "normal"))}
            aria-label={panelWidth === "full" ? "Restore panel width" : "Widen panel"}
            title={
              panelWidth === "normal"
                ? "Widen to double width — handy for a long ticket Conversation"
                : panelWidth === "double"
                ? "Expand to full screen"
                : "Restore to normal width"
            }
          >
            {panelWidth === "full" ? "›" : "‹"}
          </button>
          <button className="icon-btn panel-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="panel-body">
          {error && <div className="banner" style={{ color: "var(--blocked)", background: "var(--blocked-bg)" }}>{error}</div>}

          <div className="field-group">
            <span className="field-label">Status</span>
            <div className="status-current">
              <StatusChip statusKey={row.statusKey} label={row.statusLabel} color={row.statusColor} />
            </div>
            {outgoing.length > 0 && (
              <div className="move-to-row">
                {outgoing.map((t) => {
                  const toStatus = statuses.find((s) => s.id === t.to_status_id);
                  const allowed = canMove(t);
                  return (
                    <button
                      key={t.id}
                      className="move-btn"
                      disabled={!allowed || pending}
                      title={allowed ? undefined : "Your role can't make this move"}
                      onClick={() => run(() => updateTaskStatus(taskId, t.to_status_id))}
                    >
                      → {toStatus?.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="divider" />

          <ActivitySection
            entries={activityLog.filter((a) => a.task_id === taskId).slice(0, 25)}
            statuses={statuses}
            members={members}
            contactNameById={contactNameById}
          />

          {project?.is_helpdesk && (
            <>
              <div className="divider" />
              <ConversationSection
                channel={task.channel}
                messages={ticketMessages.filter((m) => m.task_id === taskId)}
                contact={task.contact_id ? contactById.get(task.contact_id) ?? null : null}
                members={members}
                pending={pending}
                portalAccessToken={task.portal_access_token}
                onSendReply={(body) => run(() => sendChannelReply(taskId, body))}
                onAddNote={(body) => run(() => addInternalNote(taskId, body))}
                onSimulateCustomer={(body) => run(() => simulateCustomerMessage(taskId, body))}
              />
            </>
          )}

          <div className="divider" />

          <div className="field-group">
            <span className="field-label">Assignee</span>
            <select
              className="select-input"
              defaultValue={task.assignee_id ?? ""}
              onChange={(e) => run(() => updateTaskFields(taskId, { assignee_id: e.target.value || null }))}
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
            {orgTeamAllocationEnabled &&
              task.assignee_id &&
              !(teamMemberIdsByTeam.get(task.team_id ?? "") ?? []).includes(task.assignee_id) &&
              (teamMemberIdsByTeam.get(task.team_id ?? "") ?? []).length > 0 && (
                <p style={{ color: "var(--text-faint)", fontSize: 11.5, marginTop: 4 }}>
                  The current assignee isn&apos;t on this task&apos;s team — still shown above so switching teams never
                  silently hides who it&apos;s assigned to.
                </p>
              )}
          </div>

          <div className="field-group">
            <span className="field-label">Team</span>
            <select
              className="select-input"
              defaultValue={task.team_id ?? ""}
              onChange={(e) => run(() => updateTaskFields(taskId, { team_id: e.target.value || null }))}
            >
              <option value="">No team</option>
              {projectTeams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>

          {project?.is_helpdesk ? (
            <div className="field-group">
              <span className="field-label">Raised</span>
              <div className="crumbline" style={{ marginBottom: 10 }}>
                {new Date(task.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
              </div>
              <SlaTimer
                label="Time to first response"
                raisedAt={task.created_at}
                targetAt={firstResponseTarget(task.created_at, slaFirstResponseHours)}
                completedAt={firstResponseAt}
                completedVerb="Responded"
              />
              <SlaTimer
                label="Time to resolution"
                raisedAt={task.created_at}
                targetAt={resolutionTarget(task.created_at, slaResolutionDays)}
                completedAt={resolvedAt}
                completedVerb="Resolved"
              />
            </div>
          ) : (
            <div className="field-group">
              <span className="field-label">Dates</span>
              <label className="checkbox-row" style={{ marginBottom: 8 }}>
                <input
                  type="checkbox"
                  defaultChecked={task.is_milestone}
                  onChange={(e) => run(() => updateTaskFields(taskId, { is_milestone: e.target.checked }))}
                />
                Milestone
              </label>
              {task.is_milestone ? (
                <input
                  type="date"
                  className="text-input"
                  defaultValue={task.start_date ?? ""}
                  onBlur={(e) => run(() => updateTaskFields(taskId, { start_date: e.target.value, due_date: e.target.value }))}
                />
              ) : (
                <div className="field-row">
                  <input
                    type="date"
                    className="text-input"
                    defaultValue={task.start_date ?? ""}
                    onBlur={(e) => run(() => updateTaskFields(taskId, { start_date: e.target.value }))}
                  />
                  <input
                    type="date"
                    className="text-input"
                    defaultValue={task.due_date ?? ""}
                    onBlur={(e) => run(() => updateTaskFields(taskId, { due_date: e.target.value }))}
                  />
                </div>
              )}
            </div>
          )}

          <div className="field-group">
            <span className="field-label">Tags</span>
            <div className="tag-editor">
              {row.tags.length === 0 && <span style={{ color: "var(--text-faint)", fontSize: 12 }}>No tags.</span>}
              {row.tags.map((tag) => (
                <span key={tag} className="chip tag-chip">
                  {tag}
                  <span
                    className="tag-remove icon-btn"
                    style={{ display: "inline", padding: 0, cursor: "pointer" }}
                    onClick={() => run(() => removeTag(taskId, orgId, tag))}
                  >
                    ✕
                  </span>
                </span>
              ))}
            </div>
            <div className="add-inline">
              <input
                className="text-input"
                placeholder="Add a tag, press Enter…"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && tagInput.trim()) {
                    run(() => addTag(taskId, orgId, tagInput.trim()));
                    setTagInput("");
                  }
                }}
              />
            </div>
          </div>

          <div className="divider" />

          <TaskObjects
            taskId={taskId}
            orgId={orgId}
            objects={taskObjects.filter((o) => o.task_id === taskId)}
            checklistItemsByObject={checklistItemsByObject}
            taskObjectFileByObjectId={taskObjectFileByObjectId}
          />

          <div className="divider" />

          <div className="field-group">
            <span className="field-label">Custom fields</span>
            {customFieldDefs.length === 0 ? (
              <p style={{ color: "var(--text-faint)", fontSize: 12 }}>
                No custom fields defined yet — add some from &quot;Custom fields&quot;.
              </p>
            ) : (
              customFieldDefs.map((def) => {
                const values = customFieldValuesByTask.get(taskId) ?? {};
                return (
                  <div key={def.id} className="field-group">
                    <label className="field-label">{def.name}</label>
                    <CustomFieldControl
                      def={def}
                      value={values[def.id]}
                      onChange={(v) => run(() => setCustomFieldValue(taskId, def.id, v))}
                    />
                  </div>
                );
              })
            )}
          </div>

          <div className="divider" />

          <div className="field-group">
            <span className="field-label">
              Subtasks{children.length ? ` (${row.doneChildCount}/${row.childCount})` : ""}
            </span>
            {children.map((c) => (
              <div key={c.task.id} className="subtask-item">
                <StatusChip statusKey={c.statusKey} label={c.statusLabel} color={c.statusColor} />
                <span className="row-title">{c.task.title}</span>
              </div>
            ))}
            <NewSubtaskInline
              disabled={pending}
              onCreate={(title) =>
                run(() =>
                  createTask({
                    orgId,
                    projectId: task.project_id,
                    teamId: task.team_id,
                    parentTaskId: taskId,
                    title,
                    assigneeId: null,
                    isMilestone: false,
                    startDate: null,
                    dueDate: null,
                  })
                )
              }
            />
          </div>

          <div className="divider" />

          <div className="field-group">
            <span className="field-label">Links</span>
            {taskLinks.length === 0 && <p style={{ color: "var(--text-faint)", fontSize: 12 }}>No dependencies yet.</p>}
            {taskLinks.map((l) => {
              const target = allRows.find((r) => r.task.id === l.to_task_id);
              const meta = LINK_TYPE_META[l.link_type];
              return (
                <div key={l.id} className="dep-item">
                  <span className={`chip link-type-chip ${meta.className}`}>{meta.label}</span>
                  <span className="row-title">{target?.task.title ?? "Unknown task"}</span>
                  <button className="icon-btn" onClick={() => run(() => removeLink(l.from_task_id, l.to_task_id, l.link_type))}>
                    ✕
                  </button>
                </div>
              );
            })}
            <div className="add-inline">
              <select className="select-input" value={linkTargetId} onChange={(e) => setLinkTargetId(e.target.value)}>
                <option value="">Link to…</option>
                {otherTasks.map((r) => (
                  <option key={r.task.id} value={r.task.id}>
                    {r.task.title}
                  </option>
                ))}
              </select>
              <select className="select-input" value={linkType} onChange={(e) => setLinkType(e.target.value as typeof linkType)}>
                <option value="blocked">Blocked by</option>
                <option value="concurrent">Concurrent</option>
                <option value="related">Related</option>
                <option value="clone">Clone</option>
              </select>
              <button
                className="small-btn"
                disabled={!linkTargetId || pending}
                onClick={() => {
                  run(() => addLink(orgId, taskId, linkTargetId, linkType));
                  setLinkTargetId("");
                }}
              >
                Add
              </button>
            </div>
          </div>

          <div className="divider" />

          <div className="field-group">
            <span className="field-label">Linked docs ({linkedDocs.length})</span>
            {linkedDocs.length === 0 && <p style={{ color: "var(--text-faint)", fontSize: 12 }}>No linked articles yet.</p>}
            {linkedDocs.map((d) => (
              <div key={d.id} className="dep-item">
                <span
                  className="row-title"
                  style={onSelectDoc ? { cursor: "pointer" } : undefined}
                  onClick={() => onSelectDoc?.(d.id)}
                >
                  {d.title}
                </span>
                <button className="icon-btn" onClick={() => run(() => unlinkDocFromTask(d.id, taskId))}>
                  ✕
                </button>
              </div>
            ))}
            <div className="add-inline">
              <select className="select-input" value={docTargetId} onChange={(e) => setDocTargetId(e.target.value)}>
                <option value="">Link an article…</option>
                {linkableDocs.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title}
                  </option>
                ))}
              </select>
              <button
                className="small-btn"
                disabled={!docTargetId || pending}
                onClick={() => {
                  run(() => linkDocToTask(docTargetId, taskId));
                  setDocTargetId("");
                }}
              >
                Link
              </button>
            </div>
          </div>

          <div className="divider" />

          <button
            className="small-btn"
            style={{ color: "var(--blocked)" }}
            disabled={pending}
            onClick={() => {
              if (confirm(`Delete "${task.title}"? This also deletes its subtasks.`)) {
                run(async () => {
                  await deleteTask(taskId);
                  onClose();
                });
              }
            }}
          >
            Delete {task.is_milestone ? "milestone" : "task"}
          </button>
        </div>
      </aside>
    </>
  );
}

// v0.15 parity (see claude/alloy-development-log.md's "Ticket conversation &
// Asset allocation panel" entry): any task with kind === 'asset_allocation'
// (created via the existing "Allocate this asset" flow — see allocateAsset()
// in lib/actions.ts) gets this fully specialized panel instead of the
// regular one above — editable title, a literal reuse of the Assets grid's
// own asset-card markup (clicking it opens the real Asset panel via
// onOpenAsset), Start/End dates, task Links, and "Mark asset returned".
// Team/Assignee/Status/Description/Tags/Attachments/Custom fields/Subtasks/
// Linked docs/Activity are all deliberately omitted from view — the
// underlying task still carries that data, so List/Buckets/Gantt/Costing
// keep working normally, exactly as the prototype's own version disclosed.
// Self-contained (its own pending/error state and router), same pattern as
// AssetPanel/AllocatePanel in components/asset-panel.tsx, rather than
// threading extra props through the main TaskPanel above for a branch it
// otherwise has nothing to do with.
function AssetAllocationPanel({
  task,
  allRows,
  links,
  statuses,
  assets,
  orgId,
  onOpenAsset,
  onClose,
}: {
  task: Task;
  allRows: TaskRow[];
  links: TaskLink[];
  statuses: WorkflowStatus[];
  assets: Asset[];
  orgId: string;
  onOpenAsset: (assetId: string) => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [linkTargetId, setLinkTargetId] = useState("");
  const [linkType, setLinkType] = useState<"blocked" | "concurrent" | "related" | "clone">("blocked");

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

  const asset = task.asset_id ? assets.find((a) => a.id === task.asset_id) ?? null : null;
  const taskLinks = links.filter((l) => l.from_task_id === task.id);
  const otherTasks = allRows.filter((r) => r.task.id !== task.id && r.task.project_id === task.project_id);
  // "Done" here means this allocation's own asset workflow's closed status
  // (e.g. "Available") — found via this task's current status's own
  // workflow_id, not statuses.find(key === "done"), which used to silently
  // find nothing once Assets got its own workflow keyed "available" instead
  // (the actual cause of this button's old "no valid transition" error: it
  // wasn't finding a target status in the SAME workflow as the task at all).
  const currentAllocStatusRow = statuses.find((s) => s.id === task.status_id);
  const doneStatus = currentAllocStatusRow
    ? statuses.find((s) => s.workflow_id === currentAllocStatusRow.workflow_id && s.is_closed)
    : undefined;
  const assetStatus = asset ? assetDisplayStatus(asset, allRows.map((r) => r.task), statuses) : null;
  const assetStatusCls =
    assetStatus === "retired" ? "asset-chip-retired" : assetStatus === "allocated" ? "asset-chip-allocated" : "asset-chip-available";

  return (
    <>
      <div className="scrim show" onClick={onClose} />
      <aside className="panel show">
        <div className="panel-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <input
              className="panel-title-input"
              defaultValue={task.title}
              onBlur={(e) => {
                const value = e.target.value.trim();
                if (value && value !== task.title) run(() => updateTaskFields(task.id, { title: value }));
              }}
            />
            <div className="crumbline">
              {task.display_id && <span className="task-id-badge" style={{ marginRight: 6 }}>{task.display_id}</span>}
              Asset allocation
            </div>
          </div>
          <button className="icon-btn panel-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="panel-body">
          {error && <div className="banner" style={{ color: "var(--blocked)", background: "var(--blocked-bg)" }}>{error}</div>}

          {asset ? (
            <div className="asset-card" style={{ cursor: "pointer" }} onClick={() => onOpenAsset(asset.id)}>
              <div className="asset-icon-box">
                <AssetIcon icon={asset.icon} />
              </div>
              <div className="asset-card-title">{asset.name}</div>
              {asset.tag && <div className="asset-card-tag">{asset.tag}</div>}
              {assetStatus && <span className={"asset-status-chip " + assetStatusCls}>{assetStatusLabel(assetStatus)}</span>}
              <div className="crumbline">{costLabel(asset)}</div>
            </div>
          ) : (
            <p style={{ color: "var(--text-faint)", fontSize: 12 }}>This asset no longer exists.</p>
          )}

          <div className="divider" />

          <div className="field-group">
            <span className="field-label">Dates</span>
            <div className="field-row">
              <input
                type="date"
                className="text-input"
                defaultValue={task.start_date ?? ""}
                onBlur={(e) => run(() => updateTaskFields(task.id, { start_date: e.target.value }))}
              />
              <input
                type="date"
                className="text-input"
                defaultValue={task.due_date ?? ""}
                onBlur={(e) => run(() => updateTaskFields(task.id, { due_date: e.target.value }))}
              />
            </div>
          </div>

          <div className="divider" />

          <div className="field-group">
            <span className="field-label">Links</span>
            {taskLinks.length === 0 && <p style={{ color: "var(--text-faint)", fontSize: 12 }}>No dependencies yet.</p>}
            {taskLinks.map((l) => {
              const target = allRows.find((r) => r.task.id === l.to_task_id);
              const meta = LINK_TYPE_META[l.link_type];
              return (
                <div key={l.id} className="dep-item">
                  <span className={`chip link-type-chip ${meta.className}`}>{meta.label}</span>
                  <span className="row-title">{target?.task.title ?? "Unknown task"}</span>
                  <button className="icon-btn" onClick={() => run(() => removeLink(l.from_task_id, l.to_task_id, l.link_type))}>
                    ✕
                  </button>
                </div>
              );
            })}
            <div className="add-inline">
              <select className="select-input" value={linkTargetId} onChange={(e) => setLinkTargetId(e.target.value)}>
                <option value="">Link to…</option>
                {otherTasks.map((r) => (
                  <option key={r.task.id} value={r.task.id}>
                    {r.task.title}
                  </option>
                ))}
              </select>
              <select className="select-input" value={linkType} onChange={(e) => setLinkType(e.target.value as typeof linkType)}>
                <option value="blocked">Blocked by</option>
                <option value="concurrent">Concurrent</option>
                <option value="related">Related</option>
                <option value="clone">Clone</option>
              </select>
              <button
                className="small-btn"
                disabled={!linkTargetId || pending}
                onClick={() => {
                  run(() => addLink(orgId, task.id, linkTargetId, linkType));
                  setLinkTargetId("");
                }}
              >
                Add
              </button>
            </div>
          </div>

          <div className="divider" />

          <button
            className="primary-btn"
            style={{ width: "100%", padding: 9 }}
            disabled={pending || !doneStatus || !!(doneStatus && task.status_id === doneStatus.id)}
            title={doneStatus ? "" : "This allocation's workflow has no closed status configured"}
            onClick={() => doneStatus && run(() => updateTaskStatus(task.id, doneStatus.id))}
          >
            {doneStatus && task.status_id === doneStatus.id ? "Asset returned" : "Mark asset returned"}
          </button>

          <div className="divider" />

          <button
            className="small-btn"
            style={{ color: "var(--blocked)" }}
            disabled={pending}
            onClick={() => {
              if (confirm(`Delete "${task.title}"?`)) {
                run(async () => {
                  await deleteTask(task.id);
                  onClose();
                });
              }
            }}
          >
            Delete task
          </button>
        </div>
      </aside>
    </>
  );
}

// Read-only — ported from the prototype's activityHtml(), same avatar +
// bolded-name-plus-verb + relative-time layout, right before the Delete
// button (the prototype's own placement). `entries` arrives already sorted
// most-recent-first and pre-filtered to this task (see the caller above) —
// this component only turns each row into copy, it doesn't sort or filter.
function ActivitySection({
  entries,
  statuses,
  members,
  contactNameById,
}: {
  entries: ActivityLogEntry[];
  statuses: WorkflowStatus[];
  members: MemberSummary[];
  contactNameById: Map<string, string>;
}) {
  const statusLabelById = new Map(statuses.map((s) => [s.id, s.label]));
  const memberNameById = new Map(members.map((m) => [m.userId, m.name]));

  return (
    <div className="field-group">
      <span className="field-label">Activity</span>
      {entries.length === 0 ? (
        <div className="crumbline">No activity yet — moves show up here as they happen.</div>
      ) : (
        entries.map((a) => {
          const name = actorDisplayName(a, memberNameById, contactNameById);
          const hue = hueFor(name);
          return (
            <div key={a.id} className="activity-item">
              <span className="avatar" style={{ background: `hsl(${hue} 45% 45%)` }} title={name}>
                {initials(name)}
              </span>
              <div>
                <div className="activity-text">
                  <strong>{name}</strong> {activitySummary(a, statusLabelById)}
                </div>
                <div className="activity-time">{timeAgo(a.created_at)}</div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

// Live countdown for a Helpdesk ticket's SLA target — used by the "Raised"
// field-group above, which replaces the regular Dates field-group for
// Helpdesk-project tasks (see components/sla-settings-panel.tsx for where
// the two org-wide targets are set, lib/sla.ts for the time math). Ticks
// every 30s — plenty of resolution for an hours/days-scale countdown, no
// point re-rendering every second. Once `completedAt` is set the timer
// stops ticking (nothing left to count down) and instead shows how long the
// response/resolution actually took, flagged against whether it beat the
// target.
function SlaTimer({
  label,
  raisedAt,
  targetAt,
  completedAt,
  completedVerb,
}: {
  label: string;
  raisedAt: string;
  targetAt: Date;
  completedAt: string | null;
  completedVerb: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (completedAt) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [completedAt]);

  if (completedAt) {
    const tookMs = new Date(completedAt).getTime() - new Date(raisedAt).getTime();
    const metOnTime = new Date(completedAt).getTime() <= targetAt.getTime();
    return (
      <div style={{ marginBottom: 8 }}>
        <div className="crumbline" style={{ marginBottom: 2 }}>
          {label}
        </div>
        <span className={"chip sla-chip " + (metOnTime ? "sla-chip-met" : "sla-chip-breached")}>
          {completedVerb} in {formatDuration(tookMs)} · {metOnTime ? "within SLA" : "SLA missed"}
        </span>
      </div>
    );
  }

  const diff = targetAt.getTime() - now;
  const overdue = diff < 0;
  return (
    <div style={{ marginBottom: 8 }}>
      <div className="crumbline" style={{ marginBottom: 2 }}>
        {label}
      </div>
      <span className={"chip sla-chip " + (overdue ? "sla-chip-breached" : "sla-chip-pending")}>
        {overdue ? `Overdue by ${formatDuration(-diff)}` : `Due in ${formatDuration(diff)}`}
      </span>
    </div>
  );
}

// v0.15 parity (see claude/alloy-development-log.md's "Ticket conversation &
// Asset allocation panel" entry): shown on every Helpdesk-project task now,
// not just 'email'/'whatsapp' ones — see the widened gate in the caller
// above. It replaces the old channel-only reply box with the prototype's
// fuller design: public replies (genuinely delivered for email/WhatsApp,
// stored-only for portal/internal — see sendChannelReply's own comment),
// private internal-only notes, a "+ Simulate customer message" convenience
// for channels with no live customer login, and a "Preview as customer"
// toggle that filters the thread to public-only to demonstrate the
// visibility rule live, exactly like the prototype's own toggle did.
function ConversationSection({
  channel,
  messages,
  contact,
  members,
  pending,
  portalAccessToken,
  onSendReply,
  onAddNote,
  onSimulateCustomer,
}: {
  channel: TicketChannel;
  messages: TicketMessage[];
  contact: Contact | null;
  members: MemberSummary[];
  pending: boolean;
  portalAccessToken: string | null;
  onSendReply: (body: string) => void;
  onAddNote: (body: string) => void;
  onSimulateCustomer: (body: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [simulateDraft, setSimulateDraft] = useState("");
  const [showSimulate, setShowSimulate] = useState(false);
  const [previewAsCustomer, setPreviewAsCustomer] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const memberNameById = new Map(members.map((m) => [m.userId, m.name]));
  const sorted = [...messages]
    .filter((m) => !previewAsCustomer || m.visibility !== "private")
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const contactLabel = contact?.name || contact?.email || contact?.phone || "the customer";
  const channelLabel = channel === "email" ? "Email" : channel === "whatsapp" ? "WhatsApp" : channel === "portal" ? "Portal" : "Internal";

  return (
    <div className="field-group">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <span className="field-label" style={{ marginBottom: 0 }}>
          Conversation ({channelLabel} · {contactLabel})
        </span>
        <label className="checkbox-row" style={{ fontSize: 11 }}>
          <input type="checkbox" checked={previewAsCustomer} onChange={(e) => setPreviewAsCustomer(e.target.checked)} />
          Preview as customer
        </label>
      </div>
      {portalAccessToken && (
        <div className="crumbline" style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span>Customer link — lets {contactLabel} check progress and reply, no account needed:</span>
          <button
            type="button"
            className="ghost-btn"
            style={{ padding: "2px 8px", fontSize: 11 }}
            onClick={() => {
              const url = `${window.location.origin}/portal/ticket/${portalAccessToken}`;
              navigator.clipboard?.writeText(url).then(
                () => {
                  setLinkCopied(true);
                  setTimeout(() => setLinkCopied(false), 2000);
                },
                () => {}
              );
            }}
          >
            {linkCopied ? "Copied!" : "Copy link"}
          </button>
        </div>
      )}
      {sorted.length === 0 ? (
        <div className="crumbline">{previewAsCustomer ? "Nothing customer-visible yet." : "No messages yet."}</div>
      ) : (
        <div className="conversation-thread">
          {sorted.map((m) => {
            const who = m.direction === "inbound" ? contactLabel : memberNameById.get(m.author_user_id ?? "") || "You";
            const isPrivate = m.visibility === "private";
            return (
              <div
                key={m.id}
                className={
                  "conversation-bubble " +
                  (m.direction === "inbound" ? "conversation-inbound" : "conversation-outbound") +
                  (isPrivate ? " conversation-private" : "")
                }
              >
                <div className="conversation-meta">
                  <strong>
                    {who}
                    {isPrivate && <span className="conversation-private-flag">Private</span>}
                  </strong>
                  <span>{timeAgo(m.created_at)}</span>
                </div>
                <div className="conversation-body">{m.body}</div>
              </div>
            );
          })}
        </div>
      )}
      {!previewAsCustomer && (
        <>
          <div className="add-inline" style={{ marginTop: 8, alignItems: "flex-start" }}>
            <textarea
              className="text-input"
              rows={2}
              placeholder="Write a reply or note…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
            <button
              className="small-btn"
              disabled={!draft.trim() || pending}
              onClick={() => {
                const body = draft.trim();
                if (!body) return;
                onSendReply(body);
                setDraft("");
              }}
            >
              Send public reply
            </button>
            <button
              className="small-btn"
              disabled={!draft.trim() || pending}
              onClick={() => {
                const body = draft.trim();
                if (!body) return;
                onAddNote(body);
                setDraft("");
              }}
            >
              Add private note
            </button>
          </div>

          {showSimulate ? (
            <div className="add-inline" style={{ marginTop: 8, alignItems: "flex-start" }}>
              <textarea
                className="text-input"
                rows={2}
                placeholder={`Simulate a message from ${contactLabel}…`}
                value={simulateDraft}
                onChange={(e) => setSimulateDraft(e.target.value)}
              />
              <button
                className="small-btn"
                disabled={!simulateDraft.trim() || pending}
                onClick={() => {
                  const body = simulateDraft.trim();
                  if (!body) return;
                  onSimulateCustomer(body);
                  setSimulateDraft("");
                  setShowSimulate(false);
                }}
              >
                Send
              </button>
            </div>
          ) : (
            <button className="ghost-btn" style={{ marginTop: 8 }} onClick={() => setShowSimulate(true)}>
              + Simulate customer message
            </button>
          )}
        </>
      )}
    </div>
  );
}

// Ported from the prototype's fieldControlHtml(), one input per field type.
// Values round-trip through custom_field_values.value (jsonb), so each
// branch keeps its own natural JS type (string/number/boolean) rather than
// stringifying everything the way the Portal request form's draft state
// does (that form posts through a plain string-keyed form payload instead).
function CustomFieldControl({
  def,
  value,
  onChange,
}: {
  def: CustomFieldDef;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const type: FormFieldType = def.field_type;

  if (type === "select") {
    return (
      <select
        className="select-input"
        defaultValue={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">—</option>
        {(def.options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  if (type === "paragraph") {
    return (
      <textarea
        className="text-input"
        defaultValue={typeof value === "string" ? value : ""}
        onBlur={(e) => onChange(e.target.value.trim() || null)}
      />
    );
  }
  if (type === "number") {
    return (
      <input
        className="text-input mono"
        type="number"
        defaultValue={typeof value === "number" ? value : ""}
        onBlur={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      />
    );
  }
  if (type === "date") {
    return (
      <input
        className="text-input mono"
        type="date"
        defaultValue={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value || null)}
      />
    );
  }
  if (type === "yes_no") {
    // Locally controlled (unlike the rest of this component's uncontrolled
    // defaultValue/defaultChecked inputs, matching how selects/text fields
    // elsewhere in this panel behave) so the Yes/No label flips immediately
    // on click rather than waiting for the round trip through
    // setCustomFieldValue()/router.refresh() to update the `value` prop —
    // synced back to that prop via the effect below, in case it changes from
    // outside this control (e.g. a concurrent edit landing on refresh).
    return <YesNoControl value={value === true} onChange={onChange} />;
  }
  return (
    <input
      className="text-input"
      type="text"
      defaultValue={typeof value === "string" ? value : ""}
      onBlur={(e) => onChange(e.target.value.trim() || null)}
    />
  );
}

function YesNoControl({ value, onChange }: { value: boolean; onChange: (value: boolean) => void }) {
  const [checked, setChecked] = useState(value);
  useEffect(() => setChecked(value), [value]);
  return (
    <label className="checkbox-row">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => {
          setChecked(e.target.checked);
          onChange(e.target.checked);
        }}
      />
      <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{checked ? "Yes" : "No"}</span>
    </label>
  );
}

function NewSubtaskInline({ onCreate, disabled }: { onCreate: (title: string) => void; disabled?: boolean }) {
  const [value, setValue] = useState("");
  return (
    <div className="add-inline">
      <input
        className="text-input"
        placeholder="+ Add subtask, press Enter…"
        value={value}
        disabled={disabled}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && value.trim()) {
            onCreate(value.trim());
            setValue("");
          }
        }}
      />
    </div>
  );
}
