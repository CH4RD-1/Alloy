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
  TicketMessageAttachment,
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
  attachTicketMessageFile,
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

// Small date-only ("YYYY-MM-DD", as produced by <input type="date">) helpers
// for the task Dates field-group's "Duration" box below — parsed/formatted
// via Date.UTC so local-timezone offsets never shift the day by one.
function parseDateOnly(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}
function formatDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}
// Duration = number of days between start and due (due - start), so a
// same-day task has a duration of 0.
function taskDurationDays(start: string | null | undefined, due: string | null | undefined): number | null {
  const s = start ? parseDateOnly(start) : null;
  const e = due ? parseDateOnly(due) : null;
  if (!s || !e) return null;
  const days = Math.round((e.getTime() - s.getTime()) / 86400000);
  return days >= 0 ? days : null;
}
// Duration box units (see DurationField below) — hours/weeks/months/years
// all resolve to a whole number of days added to start_date, since
// start_date/due_date are date-only columns with no time component.
// Months/years use real calendar arithmetic (setUTCMonth/setUTCFullYear)
// rather than a flat *30/*365 multiply, so "1 month" from Jan 31 lands on
// Feb 28 the way a calendar would, not 30 days later.
type DurationUnit = "hours" | "days" | "weeks" | "months" | "years";
const DURATION_UNITS: { value: DurationUnit; label: string }[] = [
  { value: "hours", label: "Hours" },
  { value: "days", label: "Days" },
  { value: "weeks", label: "Weeks" },
  { value: "months", label: "Months" },
  { value: "years", label: "Years" },
];
function addDurationToDate(start: string, amount: number, unit: DurationUnit): string {
  const s = parseDateOnly(start);
  if (!s) return start;
  switch (unit) {
    case "hours":
      // Date-only storage can't represent partial days — round to the
      // nearest whole day (so e.g. 4 hours stays same-day, 20 hours
      // becomes +1 day) rather than always rounding up or down.
      s.setUTCDate(s.getUTCDate() + Math.round(amount / 24));
      break;
    case "days":
      s.setUTCDate(s.getUTCDate() + Math.round(amount));
      break;
    case "weeks":
      s.setUTCDate(s.getUTCDate() + Math.round(amount * 7));
      break;
    case "months":
      s.setUTCMonth(s.getUTCMonth() + Math.round(amount));
      break;
    case "years":
      s.setUTCFullYear(s.getUTCFullYear() + Math.round(amount));
      break;
  }
  return formatDateOnly(s);
}

// The Duration box under Start/Due Dates on a regular (non-milestone,
// non-Helpdesk) task. Local component state (seeded once from the task's
// current start/due gap, in days) rather than the rest of this panel's
// uncontrolled-input-with-defaultValue convention, since this control
// needs to read back its own number+unit together on every change — kept
// safe from the same "router.refresh() mid-edit" concern those other
// inputs avoid by being keyed per task (see the `key={taskId}` where this
// is rendered below), so switching tasks resets it correctly. Only ever
// writes due_date; start_date/is_milestone stay owned by their own inputs
// above it, and the "days elapsed" it shows on open is always relative to
// whatever start_date is set, in Days — the display unit isn't persisted
// anywhere (only start_date/due_date are stored), so a duration entered in
// e.g. weeks reads back as the equivalent day count next time the task is
// opened, not "2 weeks" again.
function DurationField({
  taskId,
  startDate,
  run,
  durationDays,
}: {
  taskId: string;
  startDate: string | null;
  run: (action: () => Promise<unknown>) => void;
  durationDays: number | null;
}) {
  const [amount, setAmount] = useState(durationDays === null ? "" : String(durationDays));
  const [unit, setUnit] = useState<DurationUnit>("days");

  function save(nextAmount: string, nextUnit: DurationUnit) {
    if (nextAmount === "" || !startDate) return;
    const value = Number(nextAmount);
    if (!Number.isFinite(value) || value < 0) return;
    const due = addDurationToDate(startDate, value, nextUnit);
    run(() => updateTaskFields(taskId, { due_date: due }));
  }

  return (
    <div className="duration-box">
      <span className="duration-box-label">Duration</span>
      <div className="duration-box-controls">
        <input
          type="number"
          min={0}
          className="text-input duration-input"
          placeholder={startDate ? "0" : "Set a start date first"}
          disabled={!startDate}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onBlur={() => save(amount, unit)}
        />
        <select
          className="select-input duration-unit-select"
          value={unit}
          disabled={!startDate}
          onChange={(e) => {
            const nextUnit = e.target.value as DurationUnit;
            setUnit(nextUnit);
            save(amount, nextUnit);
          }}
        >
          {DURATION_UNITS.map((u) => (
            <option key={u.value} value={u.value}>
              {u.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

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
  ticketMessageAttachmentsByMessageId,
  orgTeamAllocationEnabled,
  teamMemberIdsByTeam,
  slaFirstResponseHours,
  slaResolutionDays,
  assets,
  onOpenAsset,
  onSelectDoc,
  onWidthChange,
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
  ticketMessageAttachmentsByMessageId: Map<string, (TicketMessageAttachment & { url: string | null })[]>;
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
  // Reports this panel's actual on-screen width in px (440 normal, 880
  // widened) every time it changes, so the parent can keep a stacked
  // DocPanel's own offset in sync instead of assuming a fixed 440px — see
  // .panel-doc's own comment in globals.css for the bug this fixes.
  onWidthChange?: (widthPx: number) => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [tagInput, setTagInput] = useState("");
  const [linkTargetId, setLinkTargetId] = useState("");
  const [linkType, setLinkType] = useState<"blocked" | "concurrent" | "related" | "clone">("blocked");
  const [docTargetId, setDocTargetId] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Maximize toggle (see the '<'/'>' chevron in panel-head below) — toggles
  // between normal (440px, the .panel default) and double-width, for a
  // Helpdesk ticket's Conversation thread when it runs long. Helpdesk-only:
  // a regular task's panel never gets the button at all (see
  // effectiveWidth below, which also excludes the Asset Allocation panel —
  // that one's deliberately kept minimal and never gets a toggle either).
  const [panelWidth, setPanelWidth] = useState<"normal" | "double">("normal");

  const row = allRows.find((r) => r.task.id === taskId);
  const task = row?.task;
  const project = task ? projects.find((p) => p.id === task.project_id) : undefined;
  const isWidenable = !!project?.is_helpdesk && task?.kind !== "asset_allocation";
  const effectiveWidth = isWidenable ? panelWidth : "normal";

  // Reports the actual rendered width upward on every change (including
  // the very first render) so a DocPanel stacked beside this one — see
  // .panel-doc in globals.css — can offset itself correctly instead of
  // assuming this panel is always 440px.
  useEffect(() => {
    onWidthChange?.(effectiveWidth === "double" ? 880 : 440);
  }, [effectiveWidth, onWidthChange]);

  if (!row || !task) return null;

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
      <aside className={"panel show" + (effectiveWidth === "double" ? " panel-double" : "")}>
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
          {isWidenable && (
            <button
              className="icon-btn"
              onClick={() => setPanelWidth((w) => (w === "normal" ? "double" : "normal"))}
              aria-label={panelWidth === "double" ? "Restore panel width" : "Widen panel"}
              title={panelWidth === "double" ? "Restore to normal width" : "Widen to double width — handy for a long ticket Conversation"}
            >
              {panelWidth === "double" ? "›" : "‹"}
            </button>
          )}
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

          <div className="field-group">
            <span className="field-label">Description</span>
            <textarea
              className="text-input obj-textarea"
              defaultValue={task.description ?? ""}
              placeholder="More detailed description of the issue…."
              onBlur={(e) => {
                const value = e.target.value;
                if (value !== (task.description ?? "")) run(() => updateTaskFields(taskId, { description: value || null }));
              }}
            />
          </div>

          {project?.is_helpdesk && (
            <>
              <div className="divider" />
              <ConversationSection
                channel={task.channel}
                messages={ticketMessages.filter((m) => m.task_id === taskId)}
                attachmentsByMessageId={ticketMessageAttachmentsByMessageId}
                contact={task.contact_id ? contactById.get(task.contact_id) ?? null : null}
                members={members}
                pending={pending}
                portalAccessToken={task.portal_access_token}
                onSendReply={(body, files) =>
                  run(async () => {
                    const messageId = await sendChannelReply(taskId, body);
                    for (const file of files) {
                      const formData = new FormData();
                      formData.append("file", file);
                      await attachTicketMessageFile(taskId, messageId, formData);
                    }
                  })
                }
                onAddNote={(body, files) =>
                  run(async () => {
                    const messageId = await addInternalNote(taskId, body);
                    for (const file of files) {
                      const formData = new FormData();
                      formData.append("file", file);
                      await attachTicketMessageFile(taskId, messageId, formData);
                    }
                  })
                }
                onSimulateCustomer={(body, files) =>
                  run(async () => {
                    const messageId = await simulateCustomerMessage(taskId, body);
                    for (const file of files) {
                      const formData = new FormData();
                      formData.append("file", file);
                      await attachTicketMessageFile(taskId, messageId, formData);
                    }
                  })
                }
              />
            </>
          )}

          <div className="divider" />

          <ActivitySection
            entries={activityLog.filter((a) => a.task_id === taskId).slice(0, 25)}
            statuses={statuses}
            members={members}
            contactNameById={contactNameById}
          />

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
                <>
                  <div className="date-box-row">
                    <label className="date-box">
                      <span className="date-box-label">Start</span>
                      <input
                        type="date"
                        className="text-input"
                        defaultValue={task.start_date ?? ""}
                        onBlur={(e) => run(() => updateTaskFields(taskId, { start_date: e.target.value }))}
                      />
                    </label>
                    <label className="date-box">
                      <span className="date-box-label">Due</span>
                      <input
                        type="date"
                        className="text-input"
                        defaultValue={task.due_date ?? ""}
                        onBlur={(e) => run(() => updateTaskFields(taskId, { due_date: e.target.value }))}
                      />
                    </label>
                  </div>
                  <DurationField
                    key={taskId}
                    taskId={taskId}
                    startDate={task.start_date}
                    run={run}
                    durationDays={taskDurationDays(task.start_date, task.due_date)}
                  />
                </>
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
  attachmentsByMessageId,
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
  attachmentsByMessageId: Map<string, (TicketMessageAttachment & { url: string | null })[]>;
  contact: Contact | null;
  members: MemberSummary[];
  pending: boolean;
  portalAccessToken: string | null;
  onSendReply: (body: string, files: File[]) => void;
  onAddNote: (body: string, files: File[]) => void;
  onSimulateCustomer: (body: string, files: File[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [draftFiles, setDraftFiles] = useState<File[]>([]);
  const [simulateDraft, setSimulateDraft] = useState("");
  const [simulateFiles, setSimulateFiles] = useState<File[]>([]);
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
                {m.body && <div className="conversation-body">{m.body}</div>}
                <MessageAttachments attachments={attachmentsByMessageId.get(m.id) ?? []} />
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
          <ComposeFilePicker files={draftFiles} onChange={setDraftFiles} />
          <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
            <button
              className="small-btn"
              disabled={(!draft.trim() && draftFiles.length === 0) || pending}
              onClick={() => {
                const body = draft.trim();
                if (!body && draftFiles.length === 0) return;
                onSendReply(body, draftFiles);
                setDraft("");
                setDraftFiles([]);
              }}
            >
              Send public reply
            </button>
            <button
              className="small-btn"
              disabled={(!draft.trim() && draftFiles.length === 0) || pending}
              onClick={() => {
                const body = draft.trim();
                if (!body && draftFiles.length === 0) return;
                onAddNote(body, draftFiles);
                setDraft("");
                setDraftFiles([]);
              }}
            >
              Add private note
            </button>
          </div>

          {showSimulate ? (
            <div style={{ marginTop: 8 }}>
              <div className="add-inline" style={{ alignItems: "flex-start" }}>
                <textarea
                  className="text-input"
                  rows={2}
                  placeholder={`Simulate a message from ${contactLabel}…`}
                  value={simulateDraft}
                  onChange={(e) => setSimulateDraft(e.target.value)}
                />
                <button
                  className="small-btn"
                  disabled={(!simulateDraft.trim() && simulateFiles.length === 0) || pending}
                  onClick={() => {
                    const body = simulateDraft.trim();
                    if (!body && simulateFiles.length === 0) return;
                    onSimulateCustomer(body, simulateFiles);
                    setSimulateDraft("");
                    setSimulateFiles([]);
                    setShowSimulate(false);
                  }}
                >
                  Send
                </button>
              </div>
              <ComposeFilePicker files={simulateFiles} onChange={setSimulateFiles} />
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

// A small file-picker row under a Conversation compose box — native
// multi-file input plus a list of what's staged (with a per-file remove),
// sent along with the message it's attached to (see ConversationSection's
// onSendReply/onAddNote/onSimulateCustomer — task-panel.tsx uploads each
// staged file via attachTicketMessageFile right after the message itself
// is created, since a file has to be keyed to a real message id).
function ComposeFilePicker({ files, onChange }: { files: File[]; onChange: (files: File[]) => void }) {
  return (
    <div className="conversation-file-picker">
      <label className="ghost-btn conversation-attach-btn">
        📎 Attach
        <input
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            if (picked.length) onChange([...files, ...picked]);
            e.target.value = "";
          }}
        />
      </label>
      {files.map((f, i) => (
        <span key={`${f.name}-${i}`} className="conversation-staged-file">
          {f.name}
          <button type="button" className="conversation-staged-file-remove" onClick={() => onChange(files.filter((_, j) => j !== i))}>
            ✕
          </button>
        </span>
      ))}
    </div>
  );
}

// Renders a message's own attachments (if any) inline under its bubble —
// an image gets a small clickable thumbnail, anything else a filename chip
// with its size — both open the signed URL in a new tab. `url` is null only
// if the 1hr signed URL failed to generate (surfaced as plain disabled
// text rather than a dead link).
function MessageAttachments({ attachments }: { attachments: (TicketMessageAttachment & { url: string | null })[] }) {
  if (attachments.length === 0) return null;
  return (
    <div className="conversation-attachments">
      {attachments.map((a) => {
        const isImage = (a.mime_type ?? "").startsWith("image/");
        const sizeLabel = a.size_bytes ? `${Math.max(1, Math.round(a.size_bytes / 1024))} KB` : "";
        if (isImage && a.url) {
          return (
            <a key={a.id} href={a.url} target="_blank" rel="noreferrer" className="conversation-attachment-thumb-link">
              <img src={a.url} alt={a.filename} className="conversation-attachment-thumb" />
            </a>
          );
        }
        return a.url ? (
          <a key={a.id} href={a.url} target="_blank" rel="noreferrer" className="conversation-attachment-chip">
            📎 {a.filename} {sizeLabel && <span className="conversation-attachment-size">({sizeLabel})</span>}
          </a>
        ) : (
          <span key={a.id} className="conversation-attachment-chip conversation-attachment-chip-broken">
            📎 {a.filename}
          </span>
        );
      })}
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
