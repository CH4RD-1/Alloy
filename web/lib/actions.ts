"use server";

import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { autoArrangeCompute, cascadeSchedule, type ScheduleTask } from "@/lib/gantt-schedule";
import { TASK_ATTACHMENTS_BUCKET, TASK_ATTACHMENT_MAX_BYTES, taskAttachmentPath, sanitizeFilename } from "@/lib/storage";
import { replyToAddressForTask } from "@/lib/channel-verify";
import type { FormField, FormFieldType, Role, OrgTemplate, TicketChannel, WorkflowType } from "@/lib/types";

// The three role levels the prototype's own "Workflow & roles" panel ever
// exposed (its ROLES constant: standard/authorizer/manager). "owner" and
// "admin" are new concepts this port added for real tenant ownership
// (billing, org settings) and were never part of the prototype's role model,
// so the workflow/roles editor below deliberately can't grant or revoke
// either one — see updateMemberRole.
const WORKFLOW_ROLES: Role[] = ["manager", "authorizer", "standard"];

// Every action here runs with the signed-in user's own Supabase session (not
// the service-role client), so once RLS policies are filled in for every
// table (see the "Deliberately deferred" note in schema.sql), a user simply
// can't write outside their own org — these actions don't need to re-check
// tenant boundaries themselves. What they DO check by hand is workflow
// permission (allowed_roles, the subtasks-complete gate), since that's
// app-level business logic RLS can't express.

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in.");
  return { supabase, user };
}

async function roleInOrg(supabase: Awaited<ReturnType<typeof createClient>>, orgId: string, userId: string): Promise<string> {
  const { data } = await supabase
    .from("org_members")
    .select("role")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  return data?.role ?? "standard";
}

// The write side of the activity/audit log — ported from the prototype's
// logActivity(task, type, from, to), just now an append-only DB row instead
// of an in-memory array unshifted onto the task and truncated at 25 (see
// lib/tasks-data.ts for why the cap moved to read time instead). Takes
// `supabase` as a parameter rather than calling requireUser() itself,
// because submitPortalRequest below is the one call site that has no user
// session at all — it runs under the service-role client and attributes the
// entry to a Contact instead (see actorContactId).
//
// Deliberately swallows its own failure rather than throwing: a broken
// activity-log insert (bad org_id, a migration not yet run) shouldn't take
// down the real mutation it's describing — losing one audit line is a far
// smaller problem than failing someone's actual status change because of it.
async function logActivity(
  supabase: Awaited<ReturnType<typeof createClient>> | ReturnType<typeof createServiceRoleClient>,
  input: {
    orgId: string;
    taskId: string;
    type: "created" | "status";
    fromStatusId?: string | null;
    toStatusId?: string | null;
    actorUserId?: string | null;
    actorContactId?: string | null;
  }
) {
  try {
    await supabase.from("activity_log").insert({
      org_id: input.orgId,
      task_id: input.taskId,
      type: input.type,
      from_status_id: input.fromStatusId ?? null,
      to_status_id: input.toStatusId ?? null,
      actor_user_id: input.actorUserId ?? null,
      actor_contact_id: input.actorContactId ?? null,
    });
  } catch {
    // Best-effort — see comment above.
  }
}

// Task IDs — every task-creation path (createTask below, the Portal, the
// channel adapters, and both of allocateAsset's task inserts) goes through
// this, so every task in a tagged project gets a display_id, not just the
// ones created from the main "+ New task" panel. This is an RPC call rather
// than reading projects.next_task_number and writing it back here, because
// that read-then-write would race under concurrent creates for the same
// project — see schema.sql's own comment on next_task_display_id() for the
// atomic UPDATE ... RETURNING that makes the RPC safe.
async function assignDisplayId(
  supabase: Awaited<ReturnType<typeof createClient>> | ReturnType<typeof createServiceRoleClient>,
  projectId: string
): Promise<{ task_number: number | null; display_id: string | null }> {
  const { data, error } = await supabase.rpc("next_task_display_id", { p_project_id: projectId }).single();
  if (error) throw new Error(error.message);
  return { task_number: (data as any).task_number ?? null, display_id: (data as any).display_id ?? null };
}

export async function updateTaskStatus(taskId: string, toStatusId: string) {
  const { supabase, user } = await requireUser();

  const { data: task } = await supabase.from("tasks").select("id, org_id, status_id").eq("id", taskId).single();
  if (!task) throw new Error("Task not found.");

  const role = await roleInOrg(supabase, task.org_id, user.id);

  const { data: transition } = await supabase
    .from("workflow_transitions")
    .select("*")
    .eq("org_id", task.org_id)
    .eq("from_status_id", task.status_id)
    .eq("to_status_id", toStatusId)
    .maybeSingle();

  if (!transition) throw new Error("That move isn't a configured workflow transition.");

  const allowed = role === "owner" || role === "admin" || (transition.allowed_roles as string[]).includes(role);
  if (!allowed) throw new Error("Your role can't make this move.");

  if (transition.require_subtasks_complete) {
    const { data: children } = await supabase
      .from("tasks")
      .select("id, status:workflow_statuses ( is_closed )")
      .eq("parent_task_id", taskId);
    const incomplete = (children ?? []).some((c: any) => !c.status?.is_closed);
    if (incomplete) throw new Error("All subtasks must be complete before this move.");
  }

  if (transition.require_checklists_complete) {
    const { data: checklistObjects } = await supabase
      .from("task_objects")
      .select("id")
      .eq("task_id", taskId)
      .eq("kind", "checklist");
    const objectIds = (checklistObjects ?? []).map((o) => o.id);
    if (objectIds.length) {
      const { data: items } = await supabase.from("checklist_items").select("is_checked").in("task_object_id", objectIds);
      const incomplete = (items ?? []).some((i) => !i.is_checked);
      if (incomplete) throw new Error("All checklist items must be checked before this move.");
    }
  }

  const { error } = await supabase.from("tasks").update({ status_id: toStatusId }).eq("id", taskId);
  if (error) throw new Error(error.message);
  await logActivity(supabase, {
    orgId: task.org_id,
    taskId,
    type: "status",
    fromStatusId: task.status_id,
    toStatusId,
    actorUserId: user.id,
  });
  revalidatePath("/dashboard");
}

export async function updateTaskFields(
  taskId: string,
  patch: Partial<{
    title: string;
    assignee_id: string | null;
    team_id: string | null;
    is_milestone: boolean;
    start_date: string | null;
    due_date: string | null;
  }>
) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("tasks").update(patch).eq("id", taskId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

export async function addTag(taskId: string, orgId: string, tagNameRaw: string) {
  const { supabase } = await requireUser();
  const name = tagNameRaw.trim().toLowerCase();
  if (!name) return;

  let tagId: string | undefined;
  const { data: existing } = await supabase.from("tags").select("id").eq("org_id", orgId).eq("name", name).maybeSingle();
  if (existing) {
    tagId = existing.id;
  } else {
    const { data: created, error } = await supabase.from("tags").insert({ org_id: orgId, name }).select("id").single();
    if (error) throw new Error(error.message);
    tagId = created.id;
  }

  const { error: linkError } = await supabase.from("task_tags").insert({ task_id: taskId, tag_id: tagId });
  // A duplicate (task, tag) pair is a harmless no-op, not a real error.
  if (linkError && linkError.code !== "23505") throw new Error(linkError.message);
  revalidatePath("/dashboard");
}

export async function removeTag(taskId: string, orgId: string, tagName: string) {
  const { supabase } = await requireUser();
  const { data: tag } = await supabase.from("tags").select("id").eq("org_id", orgId).eq("name", tagName).maybeSingle();
  if (!tag) return;
  await supabase.from("task_tags").delete().eq("task_id", taskId).eq("tag_id", tag.id);
  revalidatePath("/dashboard");
}

export async function createTask(input: {
  orgId: string;
  projectId: string;
  teamId: string | null;
  parentTaskId?: string | null;
  title: string;
  assigneeId: string | null;
  isMilestone: boolean;
  startDate: string | null;
  dueDate: string | null;
}) {
  const { supabase, user } = await requireUser();

  const { data: project } = await supabase.from("projects").select("workflow_id").eq("id", input.projectId).maybeSingle();
  if (!project?.workflow_id) throw new Error("This project has no workflow configured yet — set one in Manage Projects.");

  const { data: firstStatus, error: statusError } = await supabase
    .from("workflow_statuses")
    .select("id")
    .eq("workflow_id", project.workflow_id)
    .order("position")
    .limit(1)
    .single();
  if (statusError || !firstStatus) throw new Error("This project's workflow has no statuses configured.");

  const { task_number, display_id } = await assignDisplayId(supabase, input.projectId);

  const { data: created, error } = await supabase
    .from("tasks")
    .insert({
      org_id: input.orgId,
      project_id: input.projectId,
      team_id: input.teamId,
      parent_task_id: input.parentTaskId ?? null,
      title: input.title,
      status_id: firstStatus.id,
      assignee_id: input.assigneeId,
      is_milestone: input.isMilestone,
      start_date: input.startDate,
      due_date: input.isMilestone ? input.startDate : input.dueDate,
      created_by: user.id,
      task_number,
      display_id,
    })
    .select("id")
    .single();

  if (error) throw new Error(error.message);
  await logActivity(supabase, { orgId: input.orgId, taskId: created.id as string, type: "created", actorUserId: user.id });
  revalidatePath("/dashboard");
  return created.id as string;
}

export async function deleteTask(taskId: string) {
  const { supabase } = await requireUser();
  // parent_task_id has ON DELETE CASCADE, so this also removes subtasks.
  const { error } = await supabase.from("tasks").delete().eq("id", taskId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

// Mirrors addLink() in the prototype, extended so a Block relationship is
// visible from both ends: fromTaskId is always the dependent/blocked task
// (it "waits on" toTaskId, the blocker) — that exact row is stored with
// link_type "blocked", and a mirror row {from: toTaskId, to: fromTaskId,
// link_type: "blocks"} is stored alongside it, so the blocker's own Links
// section shows the relationship too (previously only the blocked task's
// side had any row at all). Concurrent/Related/Clone are unchanged, stored
// on both sides with the same type. A link touching a helpdesk-project task
// is silently downgraded to Blocked if it would otherwise be Concurrent or
// Clone — see the task_links note in schema.sql.
export async function addLink(
  orgId: string,
  fromTaskId: string,
  toTaskId: string,
  linkType: "blocked" | "concurrent" | "related" | "clone"
) {
  const { supabase } = await requireUser();

  const { data: bothTasks } = await supabase
    .from("tasks")
    .select("id, projects ( is_helpdesk )")
    .in("id", [fromTaskId, toTaskId]);

  const eitherHelpdesk = (bothTasks ?? []).some((t: any) => t.projects?.is_helpdesk);
  const effectiveType = eitherHelpdesk && (linkType === "concurrent" || linkType === "clone") ? "blocked" : linkType;

  const rows =
    effectiveType === "blocked"
      ? [
          { org_id: orgId, from_task_id: fromTaskId, to_task_id: toTaskId, link_type: "blocked" },
          { org_id: orgId, from_task_id: toTaskId, to_task_id: fromTaskId, link_type: "blocks" },
        ]
      : [
          { org_id: orgId, from_task_id: fromTaskId, to_task_id: toTaskId, link_type: effectiveType },
          { org_id: orgId, from_task_id: toTaskId, to_task_id: fromTaskId, link_type: effectiveType },
        ];

  const { error } = await supabase.from("task_links").insert(rows);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

// "blocked"/"blocks" are always a mirrored pair (see addLink above), so
// removing either one removes both rows for that task pair — the caller
// might pass either type, depending on which task's Links section (or
// which end of a Gantt connector) the removal was triggered from.
export async function removeLink(fromTaskId: string, toTaskId: string, linkType: string) {
  const { supabase } = await requireUser();
  const types = linkType === "blocked" || linkType === "blocks" ? ["blocked", "blocks"] : [linkType];
  await supabase.from("task_links").delete().eq("from_task_id", fromTaskId).eq("to_task_id", toTaskId).in("link_type", types);
  await supabase.from("task_links").delete().eq("from_task_id", toTaskId).eq("to_task_id", fromTaskId).in("link_type", types);
  revalidatePath("/dashboard");
}

// The Gantt view's "Auto-arrange" button — a one-shot version of the
// prototype's autoArrange()/propagateSchedule() (see gantt-schedule.ts for
// the actual math). This first Gantt pass has no live drag-to-reschedule,
// so this just fetches every non-helpdesk task + link in the org, computes
// the settled schedule, and writes back only what changed. Returns how many
// tasks moved, so the UI can say something more useful than silence.
export async function autoArrangeSchedule(orgId: string): Promise<number> {
  const { supabase } = await requireUser();

  const [{ data: tasks }, { data: links }, { data: projects }] = await Promise.all([
    supabase.from("tasks").select("id, project_id, start_date, due_date, is_milestone").eq("org_id", orgId),
    supabase.from("task_links").select("from_task_id, to_task_id, link_type").eq("org_id", orgId),
    supabase.from("projects").select("id, is_helpdesk").eq("org_id", orgId),
  ]);

  const helpdeskProjectIds = new Set((projects ?? []).filter((p) => p.is_helpdesk).map((p) => p.id));
  const allLinks = links ?? [];

  const scheduleTasks: ScheduleTask[] = (tasks ?? [])
    .filter((t) => !helpdeskProjectIds.has(t.project_id))
    .map((t) => ({
      id: t.id,
      start: t.start_date,
      due: t.due_date,
      isMilestone: t.is_milestone,
      blockerIds: allLinks.filter((l) => l.from_task_id === t.id && l.link_type === "blocked").map((l) => l.to_task_id),
      concurrentIds: allLinks.filter((l) => l.from_task_id === t.id && l.link_type === "concurrent").map((l) => l.to_task_id),
      cloneIds: allLinks.filter((l) => l.from_task_id === t.id && l.link_type === "clone").map((l) => l.to_task_id),
    }));

  const changes = autoArrangeCompute(scheduleTasks);
  if (changes.size > 0) {
    await Promise.all(
      Array.from(changes.entries()).map(([id, { start, due }]) =>
        supabase.from("tasks").update({ start_date: start, due_date: due }).eq("id", id)
      )
    );
    revalidatePath("/dashboard");
  }
  return changes.size;
}

// The Gantt view's live drag-to-move / drag-to-resize commit — ported from
// the prototype's mouseup handler (task.start = newStart; ...;
// propagateSchedule(new Set([taskId])); persist()). Unlike Auto-arrange
// above, this is scoped to just the dragged task and whatever it cascades
// into (see cascadeSchedule in gantt-schedule.ts), so unrelated bars never
// jump. Always writes the dragged task's own new dates even when the
// cascade itself reports no further changes, then writes back every task
// the cascade *did* move (a dependent pushed later, a concurrent/clone
// partner re-synced). Returns how many tasks moved in total.
export async function updateTaskSchedule(orgId: string, taskId: string, start: string, due: string): Promise<number> {
  const { supabase } = await requireUser();

  const [{ data: tasks }, { data: links }, { data: projects }] = await Promise.all([
    supabase.from("tasks").select("id, project_id, start_date, due_date, is_milestone").eq("org_id", orgId),
    supabase.from("task_links").select("from_task_id, to_task_id, link_type").eq("org_id", orgId),
    supabase.from("projects").select("id, is_helpdesk").eq("org_id", orgId),
  ]);

  const helpdeskProjectIds = new Set((projects ?? []).filter((p) => p.is_helpdesk).map((p) => p.id));
  const allLinks = links ?? [];

  const scheduleTasks: ScheduleTask[] = (tasks ?? [])
    .filter((t) => !helpdeskProjectIds.has(t.project_id))
    .map((t) => ({
      id: t.id,
      start: t.id === taskId ? start : t.start_date,
      due: t.id === taskId ? due : t.due_date,
      isMilestone: t.is_milestone,
      blockerIds: allLinks.filter((l) => l.from_task_id === t.id && l.link_type === "blocked").map((l) => l.to_task_id),
      concurrentIds: allLinks.filter((l) => l.from_task_id === t.id && l.link_type === "concurrent").map((l) => l.to_task_id),
      cloneIds: allLinks.filter((l) => l.from_task_id === t.id && l.link_type === "clone").map((l) => l.to_task_id),
    }));

  if (!scheduleTasks.some((t) => t.id === taskId)) return 0;

  const changes = cascadeSchedule(scheduleTasks, [taskId]);
  changes.set(taskId, { start, due }); // always write the drag itself, even if it settled back to its stored value

  await Promise.all(
    Array.from(changes.entries()).map(([id, { start: s, due: d }]) =>
      supabase.from("tasks").update({ start_date: s, due_date: d }).eq("id", id)
    )
  );
  revalidatePath("/dashboard");
  return changes.size;
}

// Rewrites a set of top-level tasks' Gantt-only position 0..n-1 in one
// shot — the Gantt view's up/down row-reorder buttons call this with the
// currently-visible row order after swapping one task with its neighbor
// (see moveTaskRow in components/gantt-view.tsx), mirroring
// reorderWorkflowStatuses's own wholesale-rewrite approach rather than
// juggling one row's position at a time. See task_position.sql's header
// for why this column exists and why only the Gantt view reads it.
export async function reorderGanttTasks(orgId: string, orderedTaskIds: string[]) {
  const { supabase } = await requireUser();
  await Promise.all(
    orderedTaskIds.map((id, position) =>
      supabase.from("tasks").update({ position }).eq("id", id).eq("org_id", orgId)
    )
  );
  revalidatePath("/dashboard");
}


// ----------------------------------------------------------------------
// Knowledge base (docs)
// ----------------------------------------------------------------------

export async function createDoc(orgId: string): Promise<string> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from("docs")
    .insert({ org_id: orgId, title: "Untitled article", body_html: "" })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
  return data.id as string;
}

export async function updateDocFields(
  docId: string,
  patch: Partial<{ title: string; body_html: string; published: boolean }>
) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("docs").update(patch).eq("id", docId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

export async function deleteDoc(docId: string) {
  const { supabase } = await requireUser();
  // task_docs rows reference doc_id with ON DELETE CASCADE, so links go too.
  const { error } = await supabase.from("docs").delete().eq("id", docId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

export async function linkDocToTask(docId: string, taskId: string) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("task_docs").insert({ task_id: taskId, doc_id: docId });
  // A duplicate (task, doc) pair is a harmless no-op, not a real error.
  if (error && error.code !== "23505") throw new Error(error.message);
  revalidatePath("/dashboard");
}

export async function unlinkDocFromTask(docId: string, taskId: string) {
  const { supabase } = await requireUser();
  await supabase.from("task_docs").delete().eq("task_id", taskId).eq("doc_id", docId);
  revalidatePath("/dashboard");
}

// ----------------------------------------------------------------------
// Task-panel objects (attachments): notes, checklists, files and sketches.
// "form" isn't here — see the TaskObjectKind comment in lib/types.ts for why
// that one's created only through the Portal's submitPortalRequest flow.
// ----------------------------------------------------------------------

export async function createTaskObject(orgId: string, taskId: string, kind: "note" | "checklist" | "sketch" | "code"): Promise<string> {
  const { supabase, user } = await requireUser();
  const { data: existing } = await supabase
    .from("task_objects")
    .select("position")
    .eq("task_id", taskId)
    .order("position", { ascending: false })
    .limit(1);
  const nextPosition = existing && existing.length ? existing[0].position + 1 : 0;

  // A sketch's canvas starts blank with nothing saved yet — its real state
  // lives elsewhere (task_object_files once a stroke is saved), not in
  // this generic content column. Same idea for checklist (own child rows).
  let content: { text: string } | { code: string; language: string } | null = null;
  if (kind === "note") content = { text: "" };
  else if (kind === "code") content = { code: "", language: "auto" };

  const { data, error } = await supabase
    .from("task_objects")
    .insert({
      org_id: orgId,
      task_id: taskId,
      kind,
      position: nextPosition,
      content,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
  return data.id as string;
}

export async function updateNoteText(objectId: string, text: string) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("task_objects").update({ content: { text } }).eq("id", objectId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

export async function updateCodeBlock(objectId: string, code: string, language: string) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("task_objects").update({ content: { code, language } }).eq("id", objectId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

// Creates the task_object row AND uploads the file in one step (unlike
// createTaskObject, which a "note"/"checklist"/"sketch" add-menu click can
// leave to fill in afterward) — a "file" object is meaningless without its
// bytes, so there's no separate empty-then-fill path for it. If the Storage
// upload fails, the task_objects row is rolled back rather than left behind
// as a permanent "file" card with nothing in it.
export async function createFileTaskObject(orgId: string, taskId: string, formData: FormData): Promise<string> {
  const { supabase, user } = await requireUser();
  const file = formData.get("file");
  if (!(file instanceof File)) throw new Error("No file provided.");
  if (file.size > TASK_ATTACHMENT_MAX_BYTES) throw new Error("That file is over 4MB — please choose something smaller.");

  const { data: existing } = await supabase
    .from("task_objects")
    .select("position")
    .eq("task_id", taskId)
    .order("position", { ascending: false })
    .limit(1);
  const nextPosition = existing && existing.length ? existing[0].position + 1 : 0;

  const { data: object, error: objectError } = await supabase
    .from("task_objects")
    .insert({ org_id: orgId, task_id: taskId, kind: "file", position: nextPosition, content: null, created_by: user.id })
    .select("id")
    .single();
  if (objectError) throw new Error(objectError.message);

  const filename = sanitizeFilename(file.name || "file");
  const path = taskAttachmentPath(orgId, taskId, object.id as string, filename);

  const { error: uploadError } = await supabase.storage
    .from(TASK_ATTACHMENTS_BUCKET)
    .upload(path, file, { contentType: file.type || undefined });
  if (uploadError) {
    await supabase.from("task_objects").delete().eq("id", object.id);
    throw new Error(uploadError.message);
  }

  const { error: fileRowError } = await supabase.from("task_object_files").insert({
    task_object_id: object.id,
    storage_path: path,
    filename: file.name || filename,
    mime_type: file.type || null,
    size_bytes: file.size,
  });
  if (fileRowError) {
    await supabase.storage.from(TASK_ATTACHMENTS_BUCKET).remove([path]);
    await supabase.from("task_objects").delete().eq("id", object.id);
    throw new Error(fileRowError.message);
  }

  revalidatePath("/dashboard");
  return object.id as string;
}

// Saves (or re-saves, on every subsequent stroke) a sketch object's drawing —
// always the same fixed "sketch.png" name so a re-save overwrites in place
// rather than accumulating old versions, and always upserted with
// {upsert:true} on the Storage side plus onConflict on the DB side for the
// same reason. "Clear sketch" reuses this exact path with a blank canvas
// image rather than a separate delete action — see the SketchCard comment in
// task-objects.tsx.
export async function saveSketchImage(orgId: string, taskId: string, taskObjectId: string, formData: FormData) {
  const { supabase } = await requireUser();
  const file = formData.get("file");
  if (!(file instanceof File)) throw new Error("No sketch image provided.");

  const path = taskAttachmentPath(orgId, taskId, taskObjectId, "sketch.png");

  const { error: uploadError } = await supabase.storage
    .from(TASK_ATTACHMENTS_BUCKET)
    .upload(path, file, { contentType: "image/png", upsert: true });
  if (uploadError) throw new Error(uploadError.message);

  const { error: fileRowError } = await supabase.from("task_object_files").upsert(
    {
      task_object_id: taskObjectId,
      storage_path: path,
      filename: "sketch.png",
      mime_type: "image/png",
      size_bytes: file.size,
    },
    { onConflict: "task_object_id" }
  );
  if (fileRowError) throw new Error(fileRowError.message);

  revalidatePath("/dashboard");
}

export async function deleteTaskObject(objectId: string) {
  const { supabase } = await requireUser();
  // checklist_items reference task_object_id with ON DELETE CASCADE, so a
  // checklist's items go with it. task_object_files rows cascade the same
  // way, but the actual bytes in Storage don't — a table row disappearing
  // doesn't delete anything from the bucket, so that has to happen by hand,
  // best-effort, before the row (and its object) are gone and the path is
  // no longer known. A failed Storage removal (e.g. already gone) doesn't
  // block deleting the object itself — an orphaned blob in a private bucket
  // nobody can list a link to is a cheap leak, not a correctness problem.
  const { data: fileRow } = await supabase.from("task_object_files").select("storage_path").eq("task_object_id", objectId).maybeSingle();
  if (fileRow) {
    await supabase.storage.from(TASK_ATTACHMENTS_BUCKET).remove([fileRow.storage_path]);
  }
  const { error } = await supabase.from("task_objects").delete().eq("id", objectId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

export async function addChecklistItem(taskObjectId: string, label: string) {
  const { supabase } = await requireUser();
  const { data: existing } = await supabase
    .from("checklist_items")
    .select("position")
    .eq("task_object_id", taskObjectId)
    .order("position", { ascending: false })
    .limit(1);
  const nextPosition = existing && existing.length ? existing[0].position + 1 : 0;

  const { error } = await supabase
    .from("checklist_items")
    .insert({ task_object_id: taskObjectId, label, position: nextPosition });
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

export async function updateChecklistItem(itemId: string, patch: Partial<{ label: string; is_checked: boolean }>) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("checklist_items").update(patch).eq("id", itemId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

export async function removeChecklistItem(itemId: string) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("checklist_items").delete().eq("id", itemId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

// ----------------------------------------------------------------------
// Form templates (internal management) — used by both a task's "form"
// attachment (not built yet) and the Portal's request form (below).
// ----------------------------------------------------------------------

export async function createFormTemplate(orgId: string, name: string): Promise<string> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from("form_templates")
    .insert({ org_id: orgId, name, fields: [] })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
  return data.id as string;
}

export async function updateFormTemplate(templateId: string, patch: Partial<{ name: string; portal_visible: boolean }>) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("form_templates").update(patch).eq("id", templateId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

export async function deleteFormTemplate(templateId: string) {
  const { supabase } = await requireUser();
  // task_object_forms.form_template_id has no ON DELETE clause (defaults to
  // RESTRICT), so this fails with a foreign-key error — surfaced via
  // error.message — if the template is still attached anywhere. The UI
  // pre-checks usage count and disables the button, but the DB is the real
  // guard.
  const { error } = await supabase.from("form_templates").delete().eq("id", templateId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

export async function addFormField(templateId: string, field: { label: string; type: FormFieldType; options?: string[] }) {
  const { supabase } = await requireUser();
  const { data: tmpl, error: fetchError } = await supabase
    .from("form_templates")
    .select("fields")
    .eq("id", templateId)
    .single();
  if (fetchError || !tmpl) throw new Error(fetchError?.message ?? "Template not found.");

  const fields = ((tmpl.fields as FormField[]) ?? []).slice();
  fields.push({ id: crypto.randomUUID(), ...field });

  const { error } = await supabase.from("form_templates").update({ fields }).eq("id", templateId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

export async function removeFormField(templateId: string, fieldId: string) {
  const { supabase } = await requireUser();
  const { data: tmpl, error: fetchError } = await supabase
    .from("form_templates")
    .select("fields")
    .eq("id", templateId)
    .single();
  if (fetchError || !tmpl) throw new Error(fetchError?.message ?? "Template not found.");

  const fields = ((tmpl.fields as FormField[]) ?? []).filter((f) => f.id !== fieldId);

  const { error } = await supabase.from("form_templates").update({ fields }).eq("id", templateId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

// ----------------------------------------------------------------------
// Shared by submitPortalRequest below and intakeTicket further down (the
// email/WhatsApp channel adapters) — every external-intake path needs the
// same two things: a Contact to attribute the new task to, and somewhere to
// put it (a project + team + starting status). Factored out once a second
// caller needed the exact same lookup-then-insert logic rather than a third
// copy of it.
// ----------------------------------------------------------------------

async function findOrCreateContact(
  supabase: ReturnType<typeof createServiceRoleClient>,
  orgId: string,
  info: { name: string; email?: string | null; phone?: string | null }
): Promise<string> {
  const email = info.email?.trim().toLowerCase() || null;
  const phone = info.phone?.trim() || null;

  if (email) {
    const { data: existing } = await supabase.from("contacts").select("id").eq("org_id", orgId).eq("email", email).maybeSingle();
    if (existing) return existing.id as string;
  } else if (phone) {
    const { data: existing } = await supabase.from("contacts").select("id").eq("org_id", orgId).eq("phone", phone).maybeSingle();
    if (existing) return existing.id as string;
  }

  const { data: created, error } = await supabase
    .from("contacts")
    .insert({ org_id: orgId, name: info.name, email, phone })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return created.id as string;
}

// Low-level Postmark send, shared by sendChannelReply's email branch below
// and createInvite further down — both need "send one transactional email,"
// just with different content and different tolerance for failure (a
// channel reply MUST send, since sending is the entire point of the call;
// an invite email is a nice-to-have on top of the invite row + link, which
// exist regardless — see createInvite's own try/catch around this).
// Returns null specifically when Postmark isn't configured at all (the
// caller decides whether that's fatal); throws if it's configured but the
// send itself fails, so those two situations are never confused for a
// caller that needs to tell them apart.
async function sendPostmarkEmail(input: {
  to: string;
  subject: string;
  textBody: string;
  replyTo?: string;
  inReplyTo?: string | null;
}): Promise<string | null> {
  const serverToken = process.env.POSTMARK_SERVER_TOKEN;
  const fromAddress = process.env.EMAIL_FROM_ADDRESS;
  if (!serverToken || !fromAddress) return null;

  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": serverToken,
    },
    body: JSON.stringify({
      From: fromAddress,
      To: input.to,
      Subject: input.subject,
      TextBody: input.textBody,
      ...(input.replyTo ? { ReplyTo: input.replyTo } : {}),
      ...(input.inReplyTo ? { Headers: [{ Name: "In-Reply-To", Value: input.inReplyTo }] } : {}),
    }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.Message || `Postmark send failed (${res.status}).`);
  return json?.MessageID ?? null;
}

function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "");
}

async function findIntakeProject(supabase: ReturnType<typeof createServiceRoleClient>, orgId: string) {
  // Route to the org's helpdesk project if it has one (tickets aren't
  // scheduled there, matching how Buckets/Gantt already treat helpdesk
  // projects), otherwise fall back to its first project — same fallback
  // the prototype used, just preferring the purpose-built option first.
  const { data: projects } = await supabase.from("projects").select("id, is_helpdesk, workflow_id").eq("org_id", orgId).order("created_at");
  const project = (projects ?? []).find((p) => p.is_helpdesk) ?? (projects ?? [])[0];
  if (!project) throw new Error("This org has no projects configured yet.");
  if (!project.workflow_id) throw new Error("This project has no workflow configured yet.");

  const { data: team } = await supabase.from("teams").select("id").eq("project_id", project.id).order("position").limit(1).maybeSingle();

  const { data: firstStatus, error: statusError } = await supabase
    .from("workflow_statuses")
    .select("id")
    .eq("workflow_id", project.workflow_id)
    .order("position")
    .limit(1)
    .single();
  if (statusError || !firstStatus) throw new Error("This project's workflow has no statuses configured.");

  return { project, teamId: (team?.id as string | undefined) ?? null, firstStatusId: firstStatus.id as string };
}

// ----------------------------------------------------------------------
// Portal request submission — the ONE action in this file that does not
// call requireUser(). The submitter is an anonymous website visitor, not a
// signed-in org member, so there's no user session for RLS to key off —
// every table involved here (tasks, contacts, task_objects,
// task_object_forms) restricts writes to is_org_member(org_id), which an
// anonymous visitor can never satisfy. This runs with the service-role
// client instead, which bypasses RLS entirely, so every check that would
// normally come from RLS (which org, which template) has to happen by hand
// in here — see the org/template checks below.
// ----------------------------------------------------------------------

// Renders a submitted Portal form's answers as readable text — label: answer,
// one per line, in the template's own field order, skipping anything left
// blank. Used to seed the first ticket_messages row below so a Portal-origin
// ticket's actual submitted content shows up in its Conversation thread
// instead of only sitting unrendered in the task_object_forms row (previously
// disclosed as a gap in claude/alloy-saas-roadmap.md's "Not yet started"
// list — closed as part of this feature batch).
function formatPortalAnswers(fields: FormField[], values: Record<string, string>): string {
  const lines = fields
    .map((f) => {
      const answer = (values[f.id] ?? "").toString().trim();
      return answer ? `${f.label}: ${answer}` : null;
    })
    .filter((line): line is string => line !== null);
  return lines.length ? lines.join("\n") : "(No answers submitted.)";
}

export async function submitPortalRequest(input: {
  orgId: string;
  templateId: string;
  requesterName: string;
  requesterEmail: string;
  title: string;
  values: Record<string, string>;
}): Promise<{ taskId: string; portalAccessToken: string }> {
  const supabase = createServiceRoleClient();

  const { data: template } = await supabase
    .from("form_templates")
    .select("id, name, portal_visible, fields")
    .eq("id", input.templateId)
    .eq("org_id", input.orgId)
    .maybeSingle();
  if (!template || !template.portal_visible) throw new Error("That form isn't available.");

  const name = input.requesterName.trim() || "Anonymous requester";
  const email = input.requesterEmail.trim().toLowerCase() || null;

  const contactId = await findOrCreateContact(supabase, input.orgId, { name, email });
  const { project, teamId, firstStatusId } = await findIntakeProject(supabase, input.orgId);

  const title = input.title.trim() || `${template.name} request`;
  const today = new Date().toISOString().slice(0, 10);
  const dueInFiveDays = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const { task_number, display_id } = await assignDisplayId(supabase, project.id);
  // Every contact-facing ticket gets a portal-access token at creation — see
  // schema.sql's own comment on tasks.portal_access_token and
  // ticket_portal_access.sql's header for the full rationale.
  const portalAccessToken = crypto.randomBytes(24).toString("hex");

  const { data: task, error: taskError } = await supabase
    .from("tasks")
    .insert({
      org_id: input.orgId,
      project_id: project.id,
      team_id: teamId,
      title,
      description: `Submitted via the Portal by ${name} using the "${template.name}" template.`,
      status_id: firstStatusId,
      channel: "portal",
      contact_id: contactId,
      start_date: project.is_helpdesk ? null : today,
      due_date: project.is_helpdesk ? null : dueInFiveDays,
      task_number,
      display_id,
      portal_access_token: portalAccessToken,
    })
    .select("id")
    .single();
  if (taskError) throw new Error(taskError.message);

  const { data: object, error: objectError } = await supabase
    .from("task_objects")
    .insert({ org_id: input.orgId, task_id: task.id, kind: "form", position: 0 })
    .select("id")
    .single();
  if (objectError) throw new Error(objectError.message);

  const { error: formError } = await supabase.from("task_object_forms").insert({
    task_object_id: object.id,
    form_template_id: template.id,
    values: input.values,
    submitted_by_contact_id: contactId,
  });
  if (formError) throw new Error(formError.message);

  // Seeds the Conversation thread's first message with the form's actual
  // labeled answers (see formatPortalAnswers above) — matches the "the
  // description from the helpdesk form... is the first message in the chat"
  // behavior email/WhatsApp intake already had via intakeTicket()'s own
  // unconditional ticket_messages insert. Best-effort: a failure here
  // shouldn't fail the whole submission, since the task and its full answers
  // already exist in task_object_forms above regardless.
  const { error: messageError } = await supabase.from("ticket_messages").insert({
    org_id: input.orgId,
    task_id: task.id,
    direction: "inbound",
    channel: "portal",
    author_contact_id: contactId,
    body: formatPortalAnswers((template.fields as FormField[]) ?? [], input.values),
    visibility: "public",
  });
  if (messageError) console.error("submitPortalRequest: seeding conversation message failed:", messageError);

  // Matches the prototype's own inline activity:[{...user:'Portal'...}] on a
  // Portal-created task — actorContactId here instead of actorUserId, since
  // this whole action runs under the service-role client with no signed-in
  // user to attribute a "created" entry to (see logActivity's own comment).
  await logActivity(supabase, { orgId: input.orgId, taskId: task.id as string, type: "created", actorContactId: contactId });

  return { taskId: task.id as string, portalAccessToken };
}

// ----------------------------------------------------------------------
// Ticket portal — the "come back later, no account" half of the Portal.
// submitPortalRequest/intakeTicket above hand a customer a per-ticket
// magic-link token at creation time (tasks.portal_access_token); these two
// functions are the public read/reply path for that link
// (app/portal/ticket/[token]/page.tsx, components/portal-ticket-view.tsx).
// Both run under the service-role client and treat the token itself as the
// only proof of identity needed — exactly the same trust model
// getInviteByToken/acceptInvite already use for invite links, just with no
// expiry (see ticket_portal_access.sql's header comment for why). Neither
// function takes a taskId directly from the caller — every lookup goes
// through the token, so there's no way to view or reply to a ticket without
// already holding its link.
// ----------------------------------------------------------------------

export async function getPortalTicketByToken(token: string): Promise<{
  taskId: string;
  displayId: string | null;
  title: string;
  createdAt: string;
  channel: TicketChannel;
  contactName: string | null;
  orgId: string;
  orgName: string;
  isHelpdesk: boolean;
  slaFirstResponseHours: number | null;
  slaResolutionDays: number | null;
  status: { label: string; color: string; key: string; isClosed: boolean };
  resolvedAt: string | null;
  messages: { id: string; direction: "inbound" | "outbound"; body: string; createdAt: string }[];
} | null> {
  const supabase = createServiceRoleClient();

  const { data: task } = await supabase
    .from("tasks")
    .select(
      `id, display_id, title, created_at, channel, status_id,
       contacts ( name ),
       orgs ( id, name, sla_first_response_hours, sla_resolution_days ),
       projects ( is_helpdesk ),
       workflow_statuses ( key, label, color, is_closed )`
    )
    .eq("portal_access_token", token)
    .maybeSingle();
  if (!task) return null;

  const { data: messages } = await supabase
    .from("ticket_messages")
    .select("id, direction, body, created_at")
    .eq("task_id", task.id)
    .eq("visibility", "public")
    .order("created_at", { ascending: true });

  const org = (task as any).orgs;
  const project = (task as any).projects;
  const status = (task as any).workflow_statuses;

  // "Resolved" timestamp for the resolution SLA timer below — same rule the
  // internal task panel's own SlaTimer uses (see components/task-panel.tsx):
  // the ticket's own first transition into its workflow's closed status via
  // activity_log, only trusted while the ticket is still currently in that
  // status (so a later reopen doesn't keep showing a stale "resolved" chip).
  // Uses is_closed rather than key === "done" — once a project's workflow
  // is user-chosen (and possibly custom), its terminal status's key can be
  // anything ("closed", "available", ...), so is_closed is the only generic
  // "is this ticket functionally finished" signal. task.status_id already
  // IS that status's id in this branch, so no extra lookup is needed — just
  // find when this ticket first transitioned into it.
  let resolvedAt: string | null = null;
  if (status?.is_closed) {
    const { data: doneActivity } = await supabase
      .from("activity_log")
      .select("created_at")
      .eq("task_id", task.id)
      .eq("type", "status")
      .eq("to_status_id", task.status_id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    resolvedAt = (doneActivity?.created_at as string | undefined) ?? null;
  }

  return {
    taskId: task.id as string,
    displayId: (task.display_id as string | null) ?? null,
    title: task.title as string,
    createdAt: task.created_at as string,
    channel: task.channel as TicketChannel,
    contactName: (task as any).contacts?.name ?? null,
    orgId: org?.id ?? "",
    orgName: org?.name ?? "this organization",
    isHelpdesk: !!project?.is_helpdesk,
    slaFirstResponseHours: project?.is_helpdesk ? (org?.sla_first_response_hours ?? null) : null,
    slaResolutionDays: project?.is_helpdesk ? (org?.sla_resolution_days ?? null) : null,
    status: {
      key: status?.key ?? "",
      label: status?.label ?? "Open",
      color: status?.color ?? "#64748b",
      isClosed: !!status?.is_closed,
    },
    resolvedAt,
    messages: (messages ?? []).map((m) => ({
      id: m.id as string,
      direction: m.direction as "inbound" | "outbound",
      body: m.body as string,
      createdAt: m.created_at as string,
    })),
  };
}

export async function addPortalTicketReply(token: string, body: string): Promise<void> {
  const supabase = createServiceRoleClient();

  const { data: task } = await supabase
    .from("tasks")
    .select("id, org_id, channel, contact_id")
    .eq("portal_access_token", token)
    .maybeSingle();
  if (!task) throw new Error("This link isn't valid.");

  const { error } = await supabase.from("ticket_messages").insert({
    org_id: task.org_id,
    task_id: task.id,
    direction: "inbound",
    channel: task.channel,
    author_contact_id: task.contact_id,
    body,
    visibility: "public",
  });
  if (error) throw new Error(error.message);
  revalidatePath(`/portal/ticket/${token}`);
}

/* ============================================================================
   CHANNEL ADAPTERS — email (Postmark) + WhatsApp (Twilio) ticket intake and
   outbound replies. Replaces the two TODO-only webhook stubs under
   app/api/webhooks/ that this port originally shipped with. Those routes
   handle everything provider-specific (parsing Postmark's inbound JSON or
   Twilio's form-encoded POST, verifying the request is genuinely from that
   provider — see lib/channel-verify.ts) and then call intakeTicket() below
   with a normalized shape, matching the roadmap doc's own design principle:
   "each channel is just an adapter... normalize into one internal
   ticket-intake path." Everything past this point is channel-agnostic,
   the same split submitPortalRequest already established above (its own
   Portal-specific bits live in the Portal page; this file only ever sees
   the normalized result).
============================================================================ */

export async function intakeTicket(input: {
  orgId: string;
  channel: "email" | "whatsapp";
  contactEmail?: string | null;
  contactPhone?: string | null;
  contactName?: string | null;
  subject?: string | null; // only used when there's no existingTaskId
  body: string;
  externalMessageRef: string;
  existingTaskId?: string | null;
}): Promise<{ taskId: string; duplicate: boolean }> {
  const supabase = createServiceRoleClient();

  const contactId = await findOrCreateContact(supabase, input.orgId, {
    name: input.contactName?.trim() || input.contactEmail || input.contactPhone || "Unknown contact",
    email: input.contactEmail,
    phone: input.contactPhone,
  });

  let taskId = input.existingTaskId ?? null;

  if (!taskId) {
    const { project, teamId, firstStatusId } = await findIntakeProject(supabase, input.orgId);
    const title = (input.subject?.trim() || input.body.slice(0, 80).trim() || `New ${input.channel} ticket`).slice(0, 200);
    const today = new Date().toISOString().slice(0, 10);
    const dueInFiveDays = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    const { task_number, display_id } = await assignDisplayId(supabase, project.id);
    // Same portal-access token every contact-facing intake path issues —
    // see submitPortalRequest's own comment on this column.
    const portalAccessToken = crypto.randomBytes(24).toString("hex");

    const { data: task, error: taskError } = await supabase
      .from("tasks")
      .insert({
        org_id: input.orgId,
        project_id: project.id,
        team_id: teamId,
        title,
        description: input.body,
        status_id: firstStatusId,
        channel: input.channel,
        contact_id: contactId,
        external_thread_ref: input.externalMessageRef,
        start_date: project.is_helpdesk ? null : today,
        due_date: project.is_helpdesk ? null : dueInFiveDays,
        task_number,
        display_id,
        portal_access_token: portalAccessToken,
      })
      .select("id")
      .single();
    if (taskError) throw new Error(taskError.message);
    taskId = task.id as string;

    // Matches the prototype's own inline activity on a new ticket, same as
    // submitPortalRequest above — actorContactId, not actorUserId, since
    // there's no signed-in user behind an inbound email or WhatsApp message.
    await logActivity(supabase, { orgId: input.orgId, taskId, type: "created", actorContactId: contactId });
  } else {
    // Keep the thread ref pointed at the customer's latest message rather
    // than the original one, so a later outbound reply (sendChannelReply
    // below) threads off of it — matters for email's In-Reply-To header;
    // WhatsApp doesn't use this field for anything today, but it costs
    // nothing to keep it current for either channel.
    await supabase.from("tasks").update({ external_thread_ref: input.externalMessageRef }).eq("id", taskId);
  }

  const { error: messageError } = await supabase.from("ticket_messages").insert({
    org_id: input.orgId,
    task_id: taskId,
    direction: "inbound",
    channel: input.channel,
    author_contact_id: contactId,
    body: input.body,
    external_message_ref: input.externalMessageRef,
    visibility: "public",
  });

  // The unique index on (channel, external_message_ref) in schema.sql is
  // what makes a redelivered webhook (both Postmark and Twilio retry on a
  // non-2xx or slow response) a safe no-op instead of a duplicate message —
  // catch exactly that constraint violation and report it as such, rather
  // than letting a raw duplicate-key error bubble up to the caller.
  if (messageError) {
    if (messageError.code === "23505") return { taskId, duplicate: true };
    throw new Error(messageError.message);
  }

  return { taskId, duplicate: false };
}

// The outbound half. Called from the task panel's Conversation section
// (components/task-panel.tsx) — "Send public reply" for any Helpdesk task,
// not just email/WhatsApp ones anymore (v0.15 parity: the prototype's
// ConversationSection worked the same way regardless of channel). For
// email/WhatsApp this still genuinely sends via Postmark/Twilio, exactly as
// before; for 'portal'/'internal' tasks — which have no external address to
// send to — it's a local-only stored reply with no delivery attempt, same as
// addInternalNote()/simulateCustomerMessage() below. Unlike intakeTicket,
// this runs under the signed-in member's own session (requireUser), not the
// service-role client — a real org member sending a reply is exactly what
// ticket_messages' own tenant-isolation RLS policy already allows, so there
// is no need for a carve-out here the way the inbound webhook path needs one.
export async function sendChannelReply(taskId: string, body: string): Promise<void> {
  const { supabase, user } = await requireUser();

  const { data: task, error: taskError } = await supabase
    .from("tasks")
    .select("id, org_id, title, channel, contact_id, external_thread_ref")
    .eq("id", taskId)
    .single();
  if (taskError || !task) throw new Error("Task not found.");

  let externalMessageRef: string | null = null;

  if (task.channel === "email" || task.channel === "whatsapp") {
    if (!task.contact_id) throw new Error("This task has no contact to reply to.");

    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .select("id, name, email, phone")
      .eq("id", task.contact_id)
      .single();
    if (contactError || !contact) throw new Error("Contact not found.");

    if (task.channel === "email") {
      if (!contact.email) throw new Error("This contact has no email address on file.");
      // Whatever the customer sends back lands on this exact task — see
      // lib/channel-verify.ts's parseMailboxHash for how the inbound route
      // turns this address back into a task id.
      const sent = await sendPostmarkEmail({
        to: contact.email,
        subject: `Re: ${task.title}`,
        textBody: body,
        replyTo: replyToAddressForTask(taskId),
        inReplyTo: task.external_thread_ref,
      });
      if (sent === null) throw new Error("Email sending isn't configured (POSTMARK_SERVER_TOKEN / EMAIL_FROM_ADDRESS).");
      externalMessageRef = sent;
    } else {
      if (!contact.phone) throw new Error("This contact has no phone number on file.");

      // WhatsApp's 24-hour customer-service window: outside it, Meta/Twilio
      // both require a pre-approved message template rather than free-form
      // text. Managing templates is a separate, approval-gated setup step
      // this app doesn't do, so it refuses up front rather than letting the
      // send silently fail at Twilio's end.
      const { data: lastInbound } = await supabase
        .from("ticket_messages")
        .select("created_at")
        .eq("task_id", taskId)
        .eq("direction", "inbound")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const hoursSinceLastInbound = lastInbound ? (Date.now() - new Date(lastInbound.created_at).getTime()) / 3_600_000 : Infinity;
      if (hoursSinceLastInbound > 24) {
        throw new Error(
          "It's been over 24 hours since their last message — WhatsApp requires a pre-approved template to restart the conversation, which isn't set up here yet."
        );
      }

      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      const fromNumber = process.env.TWILIO_WHATSAPP_FROM;
      if (!accountSid || !authToken || !fromNumber) {
        throw new Error("WhatsApp sending isn't configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_WHATSAPP_FROM).");
      }

      const form = new URLSearchParams({ From: `whatsapp:${fromNumber}`, To: `whatsapp:${contact.phone}`, Body: body });
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.message || `Twilio send failed (${res.status}).`);
      externalMessageRef = json?.sid ?? null;
    }
  }
  // else: 'portal'/'internal' — no external address to send to, so this is
  // just a stored reply (externalMessageRef stays null, nothing is dialed
  // out). That's the whole generalization: everything past this point was
  // already channel-agnostic.

  const { error: insertError } = await supabase.from("ticket_messages").insert({
    org_id: task.org_id,
    task_id: taskId,
    direction: "outbound",
    channel: task.channel,
    author_user_id: user.id,
    body,
    external_message_ref: externalMessageRef,
    visibility: "public",
  });
  if (insertError) throw new Error(insertError.message);

  if (externalMessageRef) {
    await supabase.from("tasks").update({ external_thread_ref: externalMessageRef }).eq("id", taskId);
  }

  revalidatePath("/dashboard");
}

// Internal-only note — always local, whatever the task's channel, and never
// delivered anywhere. Matches the prototype's "Add private note" button
// exactly (v0.15 log entry): agent messages markable public/private, private
// ones flagged visually and stripped out by "Preview as customer."
export async function addInternalNote(taskId: string, body: string): Promise<void> {
  const { supabase, user } = await requireUser();

  const { data: task, error: taskError } = await supabase.from("tasks").select("id, org_id, channel").eq("id", taskId).single();
  if (taskError || !task) throw new Error("Task not found.");

  const { error } = await supabase.from("ticket_messages").insert({
    org_id: task.org_id,
    task_id: taskId,
    direction: "outbound",
    channel: task.channel,
    author_user_id: user.id,
    body,
    visibility: "private",
  });
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

// "+ Simulate customer message" — a testing/demo convenience the prototype
// itself shipped with, disclosed in its own words: "no real customer login
// exists ... this stands in for an inbound message" (v0.15 log entry).
// Inserts a fabricated inbound row attributed to the task's own contact when
// it has one; an internal-channel task has no contact, so it's left null and
// the panel's own contactLabel fallback ("the contact") covers the display.
export async function simulateCustomerMessage(taskId: string, body: string): Promise<void> {
  const { supabase } = await requireUser();

  const { data: task, error: taskError } = await supabase
    .from("tasks")
    .select("id, org_id, channel, contact_id")
    .eq("id", taskId)
    .single();
  if (taskError || !task) throw new Error("Task not found.");

  const { error } = await supabase.from("ticket_messages").insert({
    org_id: task.org_id,
    task_id: taskId,
    direction: "inbound",
    channel: task.channel,
    author_contact_id: task.contact_id,
    body,
    visibility: "public",
  });
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

/* ============================================================================
   ASSETS — physical things (laptops, tools, PPE) that can be "allocated" to
   a real, schedulable task via a clone link, reusing the existing link/
   propagateSchedule machinery so allocation tasks need no scheduling logic
   of their own. Ported from the prototype's new-asset/renderAssetPanel/
   confirm-allocate handlers (see the "Live prototype" link in
   alloy-development-log.md).
============================================================================ */

export async function createAsset(orgId: string): Promise<string> {
  const { supabase } = await requireUser();
  const { data: created, error } = await supabase
    .from("assets")
    .insert({ org_id: orgId, name: "Untitled asset", icon: "other" })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
  return created.id as string;
}

export async function updateAssetFields(
  assetId: string,
  patch: Partial<{ name: string; icon: string; tag: string | null; cost_rate: number; cost_frequency: string; notes: string | null; retired: boolean }>
) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("assets").update(patch).eq("id", assetId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

export async function deleteAsset(assetId: string) {
  const { supabase } = await requireUser();
  const { count } = await supabase.from("tasks").select("id", { count: "exact", head: true }).eq("asset_id", assetId);
  if (count && count > 0) throw new Error("This asset has been allocated before — remove those tasks first.");
  const { error } = await supabase.from("assets").delete().eq("id", assetId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

/* ============================================================================
   PROJECTS & TEAMS — settings-only CRUD ported from the prototype's
   renderProjectsManagerPanel()/renderTeamsManagerPanel() handlers. The
   schema already fully supports rename/recolor/is_helpdesk/
   enable_allocations/position; nothing here needed a migration.
============================================================================ */

const PROJECT_TAG_RE = /^[A-Z0-9]{2}$/;

export async function updateProjectFields(
  projectId: string,
  patch: Partial<{
    name: string;
    color: string;
    is_helpdesk: boolean;
    enable_allocations: boolean;
    tag: string | null;
    workflow_id: string | null;
    asset_workflow_id: string | null;
  }>
) {
  const { supabase } = await requireUser();

  // tag is normalized/validated here rather than left to the DB check
  // constraint alone, so a bad value gets a plain-English error instead of
  // a raw Postgres one — same reasoning as updateOrgDomain's hostname check.
  // Editing an existing tag only changes what *future* tasks in this
  // project get; every task already created keeps the display_id it was
  // given (see schema.sql's own comment on tasks.display_id).
  const cleanPatch: typeof patch = { ...patch };
  if ("tag" in patch) {
    const raw = (patch.tag ?? "").trim().toUpperCase();
    if (!raw) {
      cleanPatch.tag = null;
    } else if (!PROJECT_TAG_RE.test(raw)) {
      throw new Error("A project tag is exactly 2 letters or digits, e.g. \"P1\".");
    } else {
      cleanPatch.tag = raw;
    }
  }

  const { error } = await supabase.from("projects").update(cleanPatch).eq("id", projectId);
  if (error) {
    // The partial unique index on (org_id, upper(tag)) — see schema.sql /
    // id_tags.sql — means this is almost certainly "another project in this
    // org already has that tag" rather than a generic failure.
    if (error.code === "23505") throw new Error(`Another project in this org already uses the tag "${cleanPatch.tag}".`);
    throw new Error(error.message);
  }
  revalidatePath("/dashboard");
}

// Turns on allocations for a project AND guarantees it ends up with a valid
// asset_workflow_id in the same step — used by the Allocate panel's inline
// "Enable allocations" quick-action (components/asset-panel.tsx), which
// only ever wants a project to walk away allocatable, not to land back on
// "no asset workflow configured" the moment it tries to actually allocate.
// (Manage Projects' own checkbox+dropdown, in projects-panel.tsx, still
// lets someone deliberately pick a *different* asset workflow afterward —
// this just picks a sane default so the quick-action never dead-ends.)
export async function enableProjectAllocations(orgId: string, projectId: string) {
  const { supabase } = await requireUser();

  const { data: project, error: fetchError } = await supabase
    .from("projects")
    .select("id, asset_workflow_id")
    .eq("id", projectId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (fetchError) throw new Error(fetchError.message);
  if (!project) throw new Error("That project no longer exists.");

  const patch: { enable_allocations: boolean; asset_workflow_id?: string } = { enable_allocations: true };

  if (!project.asset_workflow_id) {
    const { data: assetWorkflow } = await supabase
      .from("workflows")
      .select("id")
      .eq("org_id", orgId)
      .eq("type", "asset")
      .order("created_at")
      .limit(1)
      .maybeSingle();
    if (!assetWorkflow) throw new Error("This organization has no asset workflow set up yet.");
    patch.asset_workflow_id = assetWorkflow.id as string;
  }

  const { error } = await supabase.from("projects").update(patch).eq("id", projectId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

// Every new project needs at least one bucket to assign tasks to — seeds a
// starter "General" team in the project's own color, mirroring create-project
// in the prototype rather than leaving a brand-new project's team list empty.
export async function createProject(
  orgId: string,
  input: { name: string; color: string; isHelpdesk: boolean; enableAllocations: boolean; tag?: string | null }
): Promise<string> {
  const { supabase } = await requireUser();
  const tagRaw = (input.tag ?? "").trim().toUpperCase();
  if (tagRaw && !PROJECT_TAG_RE.test(tagRaw)) {
    throw new Error("A project tag is exactly 2 letters or digits, e.g. \"P1\".");
  }

  // Default to the org's own "Regular Tasks"/"Helpdesk Tickets" workflow
  // (matching is_helpdesk) and, when allocations are enabled from the
  // start, its "Assets" workflow too — rather than creating a project with
  // no workflow at all. The user can switch either via the dropdown(s) in
  // Manage Projects afterward.
  const { data: taskWorkflow } = await supabase
    .from("workflows")
    .select("id")
    .eq("org_id", orgId)
    .eq("type", input.isHelpdesk ? "helpdesk" : "task")
    .order("created_at")
    .limit(1)
    .maybeSingle();
  let assetWorkflowId: string | null = null;
  if (input.enableAllocations) {
    const { data: assetWorkflow } = await supabase
      .from("workflows")
      .select("id")
      .eq("org_id", orgId)
      .eq("type", "asset")
      .order("created_at")
      .limit(1)
      .maybeSingle();
    assetWorkflowId = (assetWorkflow?.id as string | undefined) ?? null;
  }

  const { data: project, error } = await supabase
    .from("projects")
    .insert({
      org_id: orgId,
      name: input.name,
      color: input.color,
      is_helpdesk: input.isHelpdesk,
      enable_allocations: input.enableAllocations,
      tag: tagRaw || null,
      workflow_id: (taskWorkflow?.id as string | undefined) ?? null,
      asset_workflow_id: assetWorkflowId,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") throw new Error(`Another project in this org already uses the tag "${tagRaw}".`);
    throw new Error(error.message);
  }

  const { error: teamError } = await supabase
    .from("teams")
    .insert({ org_id: orgId, project_id: project.id, name: "General", color: input.color });
  if (teamError) throw new Error(teamError.message);

  revalidatePath("/dashboard");
  return project.id as string;
}

// tasks.project_id is NOT NULL with ON DELETE CASCADE, so an unguarded
// delete here would silently wipe every task in the project — this check
// (matching the prototype's disabled-delete-button behavior) is what keeps
// that from happening by accident. Its teams cascade-delete automatically
// once the guard passes (there can be no tasks left to orphan).
export async function deleteProject(projectId: string) {
  const { supabase } = await requireUser();
  const { count } = await supabase.from("tasks").select("id", { count: "exact", head: true }).eq("project_id", projectId);
  if (count && count > 0) throw new Error("Move its tasks to another project first.");
  const { error } = await supabase.from("projects").delete().eq("id", projectId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

export async function createTeam(orgId: string, projectId: string, input: { name: string; color: string }): Promise<string> {
  const { supabase } = await requireUser();
  const { data: team, error } = await supabase
    .from("teams")
    .insert({ org_id: orgId, project_id: projectId, name: input.name, color: input.color })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
  return team.id as string;
}

export async function updateTeamFields(teamId: string, patch: Partial<{ name: string; color: string }>) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("teams").update(patch).eq("id", teamId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

// tasks.team_id is ON DELETE SET NULL, so this guard isn't strictly needed
// to avoid data loss the way deleteProject's is — kept anyway to match the
// prototype's behavior (a team with tasks in it can't be removed until
// they're moved elsewhere) rather than silently unassigning them.
export async function deleteTeam(teamId: string) {
  const { supabase } = await requireUser();
  const { count } = await supabase.from("tasks").select("id", { count: "exact", head: true }).eq("team_id", teamId);
  if (count && count > 0) throw new Error("Move its tasks to another bucket first.");
  const { error } = await supabase.from("teams").delete().eq("id", teamId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

// ----------------------------------------------------------------------
// Team allocation — see schema.sql's own comment on orgs.team_allocation_
// enabled and the team_members table. Membership writes aren't owner/admin
// gated, matching every other workspace-config table here (projects, teams,
// custom fields, workflow) rather than the tighter gate billing and role
// reassignment use.
// ----------------------------------------------------------------------

export async function toggleTeamAllocation(orgId: string, enabled: boolean) {
  const { supabase, user } = await requireUser();
  const callerRole = await roleInOrg(supabase, orgId, user.id);
  if (callerRole !== "owner" && callerRole !== "admin") throw new Error("Only an owner or admin can change this.");
  const { error } = await supabase.from("orgs").update({ team_allocation_enabled: enabled }).eq("id", orgId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

export async function updateOrgSlaTargets(orgId: string, input: { firstResponseHours: number; resolutionDays: number }) {
  const { supabase, user } = await requireUser();
  const callerRole = await roleInOrg(supabase, orgId, user.id);
  if (callerRole !== "owner" && callerRole !== "admin") throw new Error("Only an owner or admin can change this.");
  if (!(input.firstResponseHours > 0) || !(input.resolutionDays > 0)) {
    throw new Error("Both SLA targets need to be positive numbers.");
  }
  const { error: slaError } = await supabase
    .from("orgs")
    .update({
      sla_first_response_hours: Math.round(input.firstResponseHours),
      sla_resolution_days: Math.round(input.resolutionDays),
    })
    .eq("id", orgId);
  if (slaError) throw new Error(slaError.message);
  revalidatePath("/dashboard");
}

export async function setTeamMember(orgId: string, teamId: string, userId: string) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("team_members").insert({ org_id: orgId, team_id: teamId, user_id: userId });
  // Already a member — a harmless re-click (e.g. two admins toggling the
  // same checkbox close together), not a real failure.
  if (error && error.code !== "23505") throw new Error(error.message);
  revalidatePath("/dashboard");
}

export async function removeTeamMember(teamId: string, userId: string) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("team_members").delete().eq("team_id", teamId).eq("user_id", userId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

// Every project with allocations enabled needs somewhere to put its Asset
// Allocation tasks — mirrors ensureAssetsTeam() in the prototype: find (by
// name, case-insensitive) or create a team called "Assets" in that project.
async function ensureAssetsTeam(supabase: Awaited<ReturnType<typeof createClient>>, orgId: string, projectId: string): Promise<string> {
  const { data: existing } = await supabase.from("teams").select("id").eq("project_id", projectId).ilike("name", "assets").maybeSingle();
  if (existing) return existing.id as string;
  const { data: created, error } = await supabase.from("teams").insert({ org_id: orgId, project_id: projectId, name: "Assets" }).select("id").single();
  if (error) throw new Error(error.message);
  return created.id as string;
}

// The Allocate flow: creates a new "Asset allocation" task inside the chosen
// project (carrying asset_id, kind='asset_allocation' — shown with a
// distinct badge on the List view) and hard-links it via a clone dependency
// to a schedulable task, either one already in that project or a brand-new
// one created inline in the same step. Reuses addLink() above for the
// actual link insert so the helpdesk-downgrade safety check stays in one
// place.
export async function allocateAsset(input: {
  orgId: string;
  assetId: string;
  projectId: string;
  mode: "existing" | "new";
  targetTaskId?: string;
  newTitle?: string;
}): Promise<string> {
  const { supabase, user } = await requireUser();

  const { data: asset } = await supabase.from("assets").select("id, name, retired").eq("id", input.assetId).eq("org_id", input.orgId).maybeSingle();
  if (!asset) throw new Error("This asset no longer exists.");
  if (asset.retired) throw new Error("Un-retire this asset before allocating it.");

  const { data: project } = await supabase
    .from("projects")
    .select("id, enable_allocations, workflow_id, asset_workflow_id")
    .eq("id", input.projectId)
    .eq("org_id", input.orgId)
    .maybeSingle();
  if (!project || !project.enable_allocations) throw new Error("Allocations aren't enabled for that project.");
  if (!project.asset_workflow_id) throw new Error("This project has no asset workflow configured — pick one in Manage Projects.");

  // Two different "first status" lookups: a brand-new *target* task (the
  // "new" branch below) is a regular task, so it starts in this project's
  // own task/helpdesk workflow — but the allocation task itself (always
  // created further down) is an asset_allocation-kind row, so it must start
  // in the project's ASSET workflow instead. Using the org's old single
  // first-position status for both (the pre-multi-workflow behavior) is
  // exactly what caused "Mark asset returned" to error with "no valid
  // transition": the allocation task could land in a status that has no
  // Allocated -> Available-equivalent transition configured anywhere.
  async function firstStatusIdFor(workflowId: string): Promise<string> {
    const { data, error } = await supabase
      .from("workflow_statuses")
      .select("id")
      .eq("workflow_id", workflowId)
      .order("position")
      .limit(1)
      .single();
    if (error || !data) throw new Error("That workflow has no statuses configured.");
    return data.id as string;
  }

  // The allocation task (always created below) represents a live, ongoing
  // allocation the moment it exists — it needs to start in an OPEN status,
  // not just whichever status happens to sit first by position. The Assets
  // workflow's own default order is Available (position 0, is_closed) then
  // Allocated (position 1, not closed) — a sensible reading order for a
  // human skimming the workflow editor, but the wrong one to hand
  // firstStatusIdFor(): it would start every new allocation already marked
  // "Available", which is exactly backwards (this is what the user's own
  // screenshot caught — a freshly allocated asset still showing "Available"
  // in its own allocation panel, because activeAllocationTask() correctly
  // excludes a task sitting in a closed status when deciding if an asset is
  // currently held). Falls back to firstStatusIdFor's plain first-by-
  // position pick only if a workflow somehow has no open status at all,
  // rather than failing the whole allocation over a misconfigured workflow.
  async function firstOpenStatusIdFor(workflowId: string): Promise<string> {
    const { data } = await supabase
      .from("workflow_statuses")
      .select("id")
      .eq("workflow_id", workflowId)
      .eq("is_closed", false)
      .order("position")
      .limit(1)
      .maybeSingle();
    if (data) return data.id as string;
    return firstStatusIdFor(workflowId);
  }

  let targetTaskId: string;
  let targetAssigneeId: string | null;
  let targetStart: string | null;
  let targetDue: string | null;

  if (input.mode === "new") {
    const title = (input.newTitle ?? "").trim();
    if (!title) throw new Error("Give the new task a title.");
    const today = new Date().toISOString().slice(0, 10);
    const dueInWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const { data: team } = await supabase.from("teams").select("id").eq("project_id", project.id).order("position").limit(1).maybeSingle();
    const { task_number, display_id } = await assignDisplayId(supabase, project.id);
    if (!project.workflow_id) throw new Error("This project has no workflow configured — pick one in Manage Projects.");
    const targetFirstStatusId = await firstStatusIdFor(project.workflow_id);
    const { data: created, error } = await supabase
      .from("tasks")
      .insert({
        org_id: input.orgId,
        project_id: project.id,
        team_id: team?.id ?? null,
        title,
        status_id: targetFirstStatusId,
        assignee_id: user.id,
        start_date: today,
        due_date: dueInWeek,
        created_by: user.id,
        task_number,
        display_id,
      })
      .select("id, assignee_id, start_date, due_date")
      .single();
    if (error) throw new Error(error.message);
    targetTaskId = created.id as string;
    targetAssigneeId = created.assignee_id;
    targetStart = created.start_date;
    targetDue = created.due_date;
    // Only in the "new" branch — an "existing" target task already got its
    // own "created" entry back when createTask() first made it. Matches the
    // prototype's own logActivity(targetTask, 'created') call site exactly.
    await logActivity(supabase, { orgId: input.orgId, taskId: targetTaskId, type: "created", actorUserId: user.id });
  } else {
    if (!input.targetTaskId) throw new Error("Pick a task to allocate this asset to.");
    const { data: existing } = await supabase
      .from("tasks")
      .select("id, project_id, assignee_id, start_date, due_date, asset_id")
      .eq("id", input.targetTaskId)
      .maybeSingle();
    if (!existing || existing.project_id !== project.id) throw new Error("That task isn't in the selected project.");
    if (existing.asset_id) throw new Error("That task is itself an asset allocation — pick a different one.");
    targetTaskId = existing.id as string;
    targetAssigneeId = existing.assignee_id;
    targetStart = existing.start_date;
    targetDue = existing.due_date;
  }

  const assetsTeamId = await ensureAssetsTeam(supabase, input.orgId, project.id);
  const allocDisplayId = await assignDisplayId(supabase, project.id);
  const allocFirstStatusId = await firstOpenStatusIdFor(project.asset_workflow_id);

  const { data: allocTask, error: allocError } = await supabase
    .from("tasks")
    .insert({
      org_id: input.orgId,
      project_id: project.id,
      team_id: assetsTeamId,
      kind: "asset_allocation",
      asset_id: asset.id,
      title: `Asset allocation: ${asset.name}`,
      status_id: allocFirstStatusId,
      assignee_id: targetAssigneeId,
      start_date: targetStart,
      due_date: targetDue,
      created_by: user.id,
      task_number: allocDisplayId.task_number,
      display_id: allocDisplayId.display_id,
    })
    .select("id")
    .single();
  if (allocError) throw new Error(allocError.message);
  // Always — the allocation task itself is always newly created here,
  // regardless of mode. Matches logActivity(allocTask, 'created') in the
  // prototype.
  await logActivity(supabase, { orgId: input.orgId, taskId: allocTask.id as string, type: "created", actorUserId: user.id });

  await addLink(input.orgId, allocTask.id as string, targetTaskId, "clone");

  revalidatePath("/dashboard");
  return allocTask.id as string;
}

/* ============================================================================
   CUSTOM FIELDS — org-wide field definitions (custom_field_defs) plus the
   per-task values recorded against them (custom_field_values). Ported from
   the prototype's renderFieldManagerPanel()/fieldControlHtml() handlers, but
   offering the fuller 6-type set (text/paragraph/number/select/yes_no/date)
   the schema was already built against rather than the prototype's narrower
   text/number/select/boolean set — see the FormFieldType note in
   lib/types.ts.
============================================================================ */

export async function createCustomFieldDef(
  orgId: string,
  input: { name: string; field_type: FormFieldType; options?: string[] }
): Promise<string> {
  const { supabase } = await requireUser();
  const { data: existing } = await supabase
    .from("custom_field_defs")
    .select("position")
    .eq("org_id", orgId)
    .order("position", { ascending: false })
    .limit(1);
  const nextPosition = existing && existing.length ? existing[0].position + 1 : 0;

  const { data, error } = await supabase
    .from("custom_field_defs")
    .insert({
      org_id: orgId,
      name: input.name,
      field_type: input.field_type,
      options: input.field_type === "select" ? input.options ?? [] : null,
      position: nextPosition,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
  return data.id as string;
}

export async function updateCustomFieldDef(fieldDefId: string, patch: Partial<{ name: string }>) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("custom_field_defs").update(patch).eq("id", fieldDefId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

// custom_field_values.field_def_id has ON DELETE CASCADE, so removing a
// field also erases every task's saved value for it — a real deletion,
// unlike the prototype's in-memory FIELD_DEFS.filter(), which just stopped
// rendering a field while quietly leaving its old values sitting in each
// task's .fields object forever. Cascading here is the better behavior for
// a real database (no orphaned rows nobody can ever see again), but it does
// mean this delete is more consequential than the prototype's — the UI
// confirms before calling this rather than removing silently.
export async function deleteCustomFieldDef(fieldDefId: string) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("custom_field_defs").delete().eq("id", fieldDefId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

// Upserts (or, for an emptied-out value, deletes) one task's value for one
// field — custom_field_values has no separate id, just the (task_id,
// field_def_id) composite primary key, so this is the one write path for
// setting, changing, and clearing a value alike.
export async function setCustomFieldValue(taskId: string, fieldDefId: string, value: unknown) {
  const { supabase } = await requireUser();
  if (value === null || value === undefined || value === "") {
    const { error } = await supabase.from("custom_field_values").delete().eq("task_id", taskId).eq("field_def_id", fieldDefId);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase
      .from("custom_field_values")
      .upsert({ task_id: taskId, field_def_id: fieldDefId, value }, { onConflict: "task_id,field_def_id" });
    if (error) throw new Error(error.message);
  }
  revalidatePath("/dashboard");
}

/* ============================================================================
   WORKFLOWS — many per org now, each typed 'task' | 'helpdesk' | 'asset' and
   assigned to projects individually via projects.workflow_id/
   asset_workflow_id (see schema.sql's own comments on those). Replaces the
   single org-wide workflow this file used to assume everywhere. Statuses are
   now fully add/rename/recolor/reorder/removable per workflow — the
   prototype's own fixed STATUSES array (and this port's first pass at it)
   never allowed that, since status-chip CSS used to be keyed by a small,
   hardcoded set of `key` values; chip rendering now uses each status's own
   stored `color` instead (see components/task-list-view.tsx's StatusChip),
   which is what makes a fully custom/add-able status set possible at all.
============================================================================ */

export async function createWorkflow(orgId: string, input: { name: string; type: WorkflowType }): Promise<string> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from("workflows")
    .insert({ org_id: orgId, name: input.name.trim() || "Untitled workflow", type: input.type })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
  return data.id as string;
}

export async function renameWorkflow(workflowId: string, name: string) {
  const { supabase } = await requireUser();
  const clean = name.trim();
  if (!clean) throw new Error("Give this workflow a name.");
  const { error } = await supabase.from("workflows").update({ name: clean }).eq("id", workflowId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

// projects.workflow_id/asset_workflow_id reference workflows(id) with no ON
// DELETE behavior specified (RESTRICT by default), so a workflow still
// assigned to any project fails this delete at the DB level — caught here
// and turned into the same "move it off first" guidance deleteProject/
// deleteTeam already give for their own FK guards, rather than a raw
// Postgres error reaching the UI.
export async function deleteWorkflow(workflowId: string) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("workflows").delete().eq("id", workflowId);
  if (error) {
    if (error.code === "23503") {
      throw new Error("This workflow is still assigned to a project — switch that project to a different workflow first.");
    }
    throw new Error(error.message);
  }
  revalidatePath("/dashboard");
}

export async function createWorkflowStatus(
  orgId: string,
  workflowId: string,
  input: { key: string; label: string; color: string }
): Promise<string> {
  const { supabase } = await requireUser();
  const key = input.key.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!key) throw new Error("Give this status a name.");

  const { data: existing } = await supabase
    .from("workflow_statuses")
    .select("position")
    .eq("workflow_id", workflowId)
    .order("position", { ascending: false })
    .limit(1);
  const nextPosition = existing && existing.length ? existing[0].position + 1 : 0;

  const { data, error } = await supabase
    .from("workflow_statuses")
    .insert({
      org_id: orgId,
      workflow_id: workflowId,
      key,
      label: input.label.trim() || key,
      color: input.color,
      position: nextPosition,
      is_closed: false,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") throw new Error("This workflow already has a status with that name.");
    throw new Error(error.message);
  }
  revalidatePath("/dashboard");
  return data.id as string;
}

export async function updateWorkflowStatus(
  statusId: string,
  patch: Partial<{ label: string; color: string; is_closed: boolean }>
) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("workflow_statuses").update(patch).eq("id", statusId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

// Rewrites every status in a workflow to the given order (0..n-1) — the new
// full-screen editor's drag-to-reorder, replacing position wholesale rather
// than shifting one row's position at a time.
export async function reorderWorkflowStatuses(workflowId: string, orderedStatusIds: string[]) {
  const { supabase } = await requireUser();
  await Promise.all(
    orderedStatusIds.map((id, position) =>
      supabase.from("workflow_statuses").update({ position }).eq("id", id).eq("workflow_id", workflowId)
    )
  );
  revalidatePath("/dashboard");
}

// tasks.status_id is NOT NULL with no ON DELETE behavior specified
// (RESTRICT) — a status still in use by any task fails this delete at the
// DB level, caught the same way deleteWorkflow's own FK guard is above. Its
// own transitions (from_status_id/to_status_id both ON DELETE CASCADE) are
// removed automatically once the status itself is gone.
export async function deleteWorkflowStatus(statusId: string) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("workflow_statuses").delete().eq("id", statusId);
  if (error) {
    if (error.code === "23503") throw new Error("Some tasks are still in this status — move them to a different status first.");
    throw new Error(error.message);
  }
  revalidatePath("/dashboard");
}

// The prototype's "Add / update transition" form always re-declares a
// from/to pair from scratch rather than editing one in place, so picking an
// already-configured pair and submitting again just overwrites it — this
// upserts on workflow_transitions' own (org_id, from_status_id, to_status_id)
// unique constraint to match that exactly, rather than building a separate
// "edit" flow the prototype itself never had. workflow_id is looked up from
// from_status_id rather than trusted from the caller, so a transition can
// never end up pointing at a different workflow than the statuses it
// actually connects.
export async function upsertWorkflowTransition(
  orgId: string,
  input: {
    from_status_id: string;
    to_status_id: string;
    allowed_roles: Role[];
    require_subtasks_complete: boolean;
    require_checklists_complete: boolean;
  }
) {
  const { supabase } = await requireUser();
  const { data: fromStatus } = await supabase
    .from("workflow_statuses")
    .select("workflow_id")
    .eq("id", input.from_status_id)
    .maybeSingle();
  if (!fromStatus) throw new Error("That status no longer exists.");

  const { error } = await supabase.from("workflow_transitions").upsert(
    {
      org_id: orgId,
      workflow_id: fromStatus.workflow_id,
      from_status_id: input.from_status_id,
      to_status_id: input.to_status_id,
      allowed_roles: input.allowed_roles,
      require_subtasks_complete: input.require_subtasks_complete,
      require_checklists_complete: input.require_checklists_complete,
    },
    { onConflict: "org_id,from_status_id,to_status_id" }
  );
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

export async function deleteWorkflowTransition(transitionId: string) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("workflow_transitions").delete().eq("id", transitionId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

// Real difference #2 from the prototype: its "Roles" section reassigns one
// of 3 hardcoded demo users' in-memory role. Here it's a real org_members
// row, so this deliberately rejects "owner"/"admin" on either end of the
// change — not just as the new role (those are tenant-ownership levels this
// panel has no business granting, per the WORKFLOW_ROLES note above), but
// also as the member's *current* role, so nothing here can demote an owner
// or admin out of that level either. Symmetric: this action can only move a
// member between the 3 workflow roles, never in or out of ownership.
//
// Also unlike every other action in this file, this one checks the CALLER's
// own role too: org_members had no write policy at all until this feature
// needed one (see schema.sql's "Add admin/owner-gated write policies when
// that UI exists" note, right where the table's RLS is defined) — its new
// policy restricts the update to owner/admin callers, so this mirrors that
// same check here first, rather than letting a non-admin's attempt silently
// affect zero rows and look like a no-op bug instead of a clear rejection.
export async function updateMemberRole(orgId: string, userId: string, role: Role) {
  if (!WORKFLOW_ROLES.includes(role)) throw new Error("Not a workflow role.");
  const { supabase, user } = await requireUser();

  const callerRole = await roleInOrg(supabase, orgId, user.id);
  if (callerRole !== "owner" && callerRole !== "admin") throw new Error("Only an owner or admin can change a member's role.");

  const current = await roleInOrg(supabase, orgId, userId);
  if (!WORKFLOW_ROLES.includes(current as Role)) throw new Error("Owner/admin roles aren't managed from this panel.");

  const { error } = await supabase.from("org_members").update({ role }).eq("org_id", orgId).eq("user_id", userId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

/* ============================================================================
   SIGNUP + INVITES — Phase 3 scaffolding. Both are the same shape of problem
   submitPortalRequest/intakeTicket already solved above: a write that has to
   happen before the caller can possibly satisfy is_org_member() (there's no
   membership yet), so both run under the service-role client with the
   authorization check done by hand instead of by RLS. orgs' and
   org_members' own RLS comments in schema.sql predicted exactly this design
   ("org creation isn't wired through the client yet — that goes through a
   service-role signup flow when it's built" / "invites... will need [a]
   service-role path like submitPortalRequest's, not a plain client-side
   insert policy") — this is that flow.
============================================================================ */

// One starter project + team per template, replacing the prototype's
// ENVIRONMENTS registry (this port never reconstructed that object — see
// lib/list-view.ts's VOCAB_BY_TEMPLATE for the only piece of it that
// survived so far, the task/team wording). Deliberately minimal: a new org
// gets somewhere to put its first real task, not a full demo dataset —
// that's what seed.sql is for.
const TEMPLATE_STARTERS: Record<OrgTemplate, { projectName: string; teamName: string; isHelpdesk: boolean }> = {
  core: { projectName: "General", teamName: "General", isHelpdesk: false },
  helpdesk: { projectName: "Support", teamName: "Support", isHelpdesk: true },
  engineering: { projectName: "Engineering", teamName: "Engineering", isHelpdesk: false },
};

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-+|-+$)/g, "") || "org"
  );
}

// Called from app/auth/callback/route.ts right after a brand-new magic-link
// session lands — see app/signup/page.tsx for how orgName/template travel
// there as query params on the emailRedirectTo URL (there's no session yet
// at the point the link is generated, so this is the earliest moment this
// can run).
export async function completeSignup(input: { orgName: string; template: OrgTemplate }): Promise<{ orgId: string; created: boolean }> {
  const { supabase: rlsSupabase, user } = await requireUser();

  // Guard against a second org for someone who already belongs to one —
  // getWorkspaceData only ever reads a user's *first* org membership today
  // (no org switcher yet — see its own comment), so a second org created
  // here would silently never be reachable. Not an error: the caller just
  // falls through to the normal dashboard redirect either way.
  const { data: existing } = await rlsSupabase.from("org_members").select("org_id").eq("user_id", user.id).limit(1).maybeSingle();
  if (existing) return { orgId: existing.org_id as string, created: false };

  const supabase = createServiceRoleClient();
  const name = input.orgName.trim() || "My Organization";
  const baseSlug = slugify(name);

  let orgId: string | null = null;
  for (let attempt = 0; attempt < 5 && !orgId; attempt++) {
    const slug = attempt === 0 ? baseSlug : `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;
    const { data, error } = await supabase.from("orgs").insert({ name, slug, template: input.template }).select("id").single();
    if (!error) {
      orgId = data.id as string;
      break;
    }
    if (error.code !== "23505") throw new Error(error.message); // anything but "slug taken" is a real failure
  }
  if (!orgId) throw new Error("Could not generate a unique organization URL — try a different name.");

  const { error: memberError } = await supabase.from("org_members").insert({ org_id: orgId, user_id: user.id, role: "owner" });
  if (memberError) throw new Error(memberError.message);

  // The minimum a new org needs to actually be usable — three workflows now
  // instead of one (see the multi-workflow overhaul). "Regular Tasks" keeps
  // the same 5 statuses + 7 transitions seed.sql seeds by hand for local
  // testing (kept byte-for-byte identical to its own values); "Helpdesk
  // Tickets" and "Assets" are new, and match exactly what Claude outputs/
  // workflows_overhaul.sql seeds for an already-existing org, so a brand-new
  // signup and a migrated org end up in the same place.
  const { data: taskWorkflow, error: taskWorkflowError } = await supabase
    .from("workflows")
    .insert({ org_id: orgId, name: "Regular Tasks", type: "task" })
    .select("id")
    .single();
  if (taskWorkflowError) throw new Error(taskWorkflowError.message);
  const taskWorkflowId = taskWorkflow.id as string;

  const { data: statuses, error: statusError } = await supabase
    .from("workflow_statuses")
    .insert([
      { org_id: orgId, workflow_id: taskWorkflowId, key: "backlog", label: "Backlog", position: 0, is_closed: false },
      { org_id: orgId, workflow_id: taskWorkflowId, key: "inprogress", label: "In Progress", position: 1, is_closed: false },
      { org_id: orgId, workflow_id: taskWorkflowId, key: "inreview", label: "In Review", position: 2, is_closed: false },
      { org_id: orgId, workflow_id: taskWorkflowId, key: "blocked", label: "Blocked", position: 3, is_closed: false },
      { org_id: orgId, workflow_id: taskWorkflowId, key: "done", label: "Done", position: 4, is_closed: true },
    ])
    .select("id, key");
  if (statusError) throw new Error(statusError.message);
  const statusIdByKey = new Map((statuses ?? []).map((s: any) => [s.key as string, s.id as string]));

  const { error: transitionError } = await supabase.from("workflow_transitions").insert([
    {
      org_id: orgId,
      workflow_id: taskWorkflowId,
      from_status_id: statusIdByKey.get("backlog"),
      to_status_id: statusIdByKey.get("inprogress"),
      allowed_roles: ["standard", "authorizer", "manager"],
      require_subtasks_complete: false,
      require_checklists_complete: false,
    },
    {
      org_id: orgId,
      workflow_id: taskWorkflowId,
      from_status_id: statusIdByKey.get("inprogress"),
      to_status_id: statusIdByKey.get("inreview"),
      allowed_roles: ["standard", "authorizer", "manager"],
      require_subtasks_complete: false,
      require_checklists_complete: false,
    },
    {
      org_id: orgId,
      workflow_id: taskWorkflowId,
      from_status_id: statusIdByKey.get("inprogress"),
      to_status_id: statusIdByKey.get("blocked"),
      allowed_roles: ["standard", "authorizer", "manager"],
      require_subtasks_complete: false,
      require_checklists_complete: false,
    },
    {
      org_id: orgId,
      workflow_id: taskWorkflowId,
      from_status_id: statusIdByKey.get("blocked"),
      to_status_id: statusIdByKey.get("inprogress"),
      allowed_roles: ["standard", "authorizer", "manager"],
      require_subtasks_complete: false,
      require_checklists_complete: false,
    },
    {
      org_id: orgId,
      workflow_id: taskWorkflowId,
      from_status_id: statusIdByKey.get("inreview"),
      to_status_id: statusIdByKey.get("inprogress"),
      allowed_roles: ["standard", "authorizer", "manager"],
      require_subtasks_complete: false,
      require_checklists_complete: false,
    },
    {
      org_id: orgId,
      workflow_id: taskWorkflowId,
      from_status_id: statusIdByKey.get("inreview"),
      to_status_id: statusIdByKey.get("done"),
      allowed_roles: ["authorizer", "manager"],
      require_subtasks_complete: true,
      require_checklists_complete: true,
    },
    {
      org_id: orgId,
      workflow_id: taskWorkflowId,
      from_status_id: statusIdByKey.get("done"),
      to_status_id: statusIdByKey.get("inprogress"),
      allowed_roles: ["manager"],
      require_subtasks_complete: false,
      require_checklists_complete: false,
    },
  ]);
  if (transitionError) throw new Error(transitionError.message);

  const { data: helpdeskWorkflow, error: helpdeskWorkflowError } = await supabase
    .from("workflows")
    .insert({ org_id: orgId, name: "Helpdesk Tickets", type: "helpdesk" })
    .select("id")
    .single();
  if (helpdeskWorkflowError) throw new Error(helpdeskWorkflowError.message);
  const helpdeskWorkflowId = helpdeskWorkflow.id as string;

  const { data: helpdeskStatuses, error: helpdeskStatusError } = await supabase
    .from("workflow_statuses")
    .insert([
      { org_id: orgId, workflow_id: helpdeskWorkflowId, key: "open", label: "Open", color: "#3b82f6", position: 0, is_closed: false },
      { org_id: orgId, workflow_id: helpdeskWorkflowId, key: "with_customer", label: "With Customer", color: "#f59e0b", position: 1, is_closed: false },
      { org_id: orgId, workflow_id: helpdeskWorkflowId, key: "on_hold", label: "On Hold", color: "#a855f7", position: 2, is_closed: false },
      { org_id: orgId, workflow_id: helpdeskWorkflowId, key: "closed", label: "Closed", color: "#22c55e", position: 3, is_closed: true },
    ])
    .select("id");
  if (helpdeskStatusError) throw new Error(helpdeskStatusError.message);
  const helpdeskStatusIds = (helpdeskStatuses ?? []).map((s: any) => s.id as string);
  // Fully cross-connected by default (every state -> every other) — a
  // permissive starting point the user can tighten in the new full-screen
  // editor, same default Claude outputs/workflows_overhaul.sql seeds.
  const helpdeskTransitionRows = helpdeskStatusIds.flatMap((fromId) =>
    helpdeskStatusIds
      .filter((toId) => toId !== fromId)
      .map((toId) => ({ org_id: orgId, workflow_id: helpdeskWorkflowId, from_status_id: fromId, to_status_id: toId }))
  );
  const { error: helpdeskTransitionError } = await supabase.from("workflow_transitions").insert(helpdeskTransitionRows);
  if (helpdeskTransitionError) throw new Error(helpdeskTransitionError.message);

  const { data: assetWorkflow, error: assetWorkflowError } = await supabase
    .from("workflows")
    .insert({ org_id: orgId, name: "Assets", type: "asset" })
    .select("id")
    .single();
  if (assetWorkflowError) throw new Error(assetWorkflowError.message);
  const assetWorkflowId = assetWorkflow.id as string;

  const { data: assetStatuses, error: assetStatusError } = await supabase
    .from("workflow_statuses")
    .insert([
      { org_id: orgId, workflow_id: assetWorkflowId, key: "available", label: "Available", color: "#22c55e", position: 0, is_closed: true },
      { org_id: orgId, workflow_id: assetWorkflowId, key: "allocated", label: "Allocated", color: "#f97316", position: 1, is_closed: false },
    ])
    .select("id, key");
  if (assetStatusError) throw new Error(assetStatusError.message);
  const assetStatusIdByKey = new Map((assetStatuses ?? []).map((s: any) => [s.key as string, s.id as string]));

  // The explicit return transition — this is what "Mark asset returned"
  // needs to exist at all; see allocateAsset's own comment on why the old
  // single-workflow model never had one.
  const { error: assetTransitionError } = await supabase.from("workflow_transitions").insert([
    {
      org_id: orgId,
      workflow_id: assetWorkflowId,
      from_status_id: assetStatusIdByKey.get("available"),
      to_status_id: assetStatusIdByKey.get("allocated"),
    },
    {
      org_id: orgId,
      workflow_id: assetWorkflowId,
      from_status_id: assetStatusIdByKey.get("allocated"),
      to_status_id: assetStatusIdByKey.get("available"),
    },
  ]);
  if (assetTransitionError) throw new Error(assetTransitionError.message);

  const starter = TEMPLATE_STARTERS[input.template] ?? TEMPLATE_STARTERS.core;
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .insert({
      org_id: orgId,
      name: starter.projectName,
      color: "#d9662a",
      is_helpdesk: starter.isHelpdesk,
      workflow_id: starter.isHelpdesk ? helpdeskWorkflowId : taskWorkflowId,
    })
    .select("id")
    .single();
  if (projectError) throw new Error(projectError.message);

  const { error: teamError } = await supabase
    .from("teams")
    .insert({ org_id: orgId, project_id: project.id, name: starter.teamName, color: "#1f76a6" });
  if (teamError) throw new Error(teamError.message);

  return { orgId, created: true };
}

// ----------------------------------------------------------------------
// Invites — the other half of getting people into an org without hand-
// running SQL. Restricted to the 3 workflow roles for the same reason
// updateMemberRole is (see WORKFLOW_ROLES's own comment above it): owner/
// admin are new tenant-ownership concepts this port added that neither the
// prototype nor this invite flow has a concept of granting to someone else
// — promoting someone to owner/admin still isn't possible from the app.
// ----------------------------------------------------------------------

export async function createInvite(orgId: string, emailRaw: string, role: Role): Promise<{ token: string; emailed: boolean }> {
  if (!WORKFLOW_ROLES.includes(role)) throw new Error("Can't invite someone directly as owner or admin.");
  const { supabase, user } = await requireUser();

  const callerRole = await roleInOrg(supabase, orgId, user.id);
  if (callerRole !== "owner" && callerRole !== "admin") throw new Error("Only an owner or admin can invite someone.");

  const email = emailRaw.trim().toLowerCase();
  if (!email) throw new Error("An email address is required.");

  const { data: org } = await supabase.from("orgs").select("name").eq("id", orgId).single();

  const { data: invite, error } = await supabase
    .from("invites")
    .insert({ org_id: orgId, email, role, invited_by: user.id })
    .select("token")
    .single();
  if (error) {
    // The partial unique index on (org_id, lower(email)) where accepted_at
    // is null (see invites.sql) means this is almost certainly "already has
    // a pending invite" rather than a generic failure — worth a clearer
    // message than the raw constraint-violation text.
    if (error.code === "23505") throw new Error(`${email} already has a pending invite to this org.`);
    throw new Error(error.message);
  }

  let emailed = false;
  try {
    const sent = await sendPostmarkEmail({
      to: email,
      subject: `You're invited to join ${org?.name ?? "an Alloy workspace"}`,
      textBody: `You've been invited to join ${org?.name ?? "an Alloy workspace"} on Alloy as a ${role}.\n\nAccept your invite: ${appBaseUrl()}/invite/${invite.token}\n\nThis link expires in 14 days.`,
    });
    emailed = sent !== null;
  } catch {
    // Best-effort, same as logActivity above — the invite row and its
    // shareable link (shown in the panel regardless of whether this send
    // worked) are the actual feature; the email is a convenience on top,
    // not a requirement for the invite to be usable.
  }

  revalidatePath("/dashboard");
  return { token: invite.token as string, emailed };
}

export async function revokeInvite(inviteId: string, orgId: string): Promise<void> {
  const { supabase, user } = await requireUser();
  const callerRole = await roleInOrg(supabase, orgId, user.id);
  if (callerRole !== "owner" && callerRole !== "admin") throw new Error("Only an owner or admin can revoke an invite.");

  const { error } = await supabase.from("invites").delete().eq("id", inviteId).eq("org_id", orgId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

// Public-facing read for app/invite/[token]/page.tsx — a not-yet-a-member
// visitor can't satisfy invites' own is_org_admin(org_id) RLS policy, so
// this runs under the service-role client like intakeTicket/
// submitPortalRequest above, and only ever returns the narrow, non-sensitive
// subset of fields the invite landing page actually needs (nothing else
// about the org, and nothing about who sent it).
export async function getInviteByToken(
  token: string
): Promise<{ orgName: string; role: Role; email: string; expiresAt: string; acceptedAt: string | null } | null> {
  const supabase = createServiceRoleClient();
  const { data } = await supabase
    .from("invites")
    .select("email, role, expires_at, accepted_at, orgs ( name )")
    .eq("token", token)
    .maybeSingle();
  if (!data) return null;
  return {
    orgName: (data as any).orgs?.name ?? "this organization",
    role: data.role as Role,
    email: data.email as string,
    expiresAt: data.expires_at as string,
    acceptedAt: (data.accepted_at as string | null) ?? null,
  };
}

// Called from app/auth/callback/route.ts once the invitee has a session —
// see app/invite/[token]/page.tsx's AcceptInviteForm for where invite_token
// travels through as a query param on the emailRedirectTo URL, the same
// trick completeSignup's orgName/template use above.
export async function acceptInvite(token: string): Promise<{ orgId: string }> {
  const { user } = await requireUser();
  const supabase = createServiceRoleClient();

  const { data: invite } = await supabase.from("invites").select("*").eq("token", token).maybeSingle();
  if (!invite) throw new Error("This invite link isn't valid.");
  if (invite.accepted_at) throw new Error("This invite has already been accepted.");
  if (new Date(invite.expires_at as string) < new Date()) throw new Error("This invite has expired.");
  if ((invite.email as string).toLowerCase() !== (user.email ?? "").toLowerCase()) {
    throw new Error(`This invite was sent to ${invite.email}, but you're signed in as ${user.email}.`);
  }

  const { error: memberError } = await supabase
    .from("org_members")
    .insert({ org_id: invite.org_id, user_id: user.id, role: invite.role });
  if (memberError) {
    // Already a member some other way (re-clicking an old invite email,
    // e.g.) — treat as harmless rather than a hard failure, the same
    // don't-punish-a-duplicate style intakeTicket uses for a redelivered
    // webhook rather than a genuinely new problem.
    if (memberError.code !== "23505") throw new Error(memberError.message);
  }

  await supabase.from("invites").update({ accepted_at: new Date().toISOString() }).eq("id", invite.id);

  return { orgId: invite.org_id as string };
}

// ----------------------------------------------------------------------
// Custom domains — data model + settings UI only for now. See schema.sql's
// own comment on orgs.custom_domain and middleware.ts for why nothing
// actually routes traffic on this column yet: a real "bring your own
// domain" feature needs proof the org controls the domain (a DNS TXT
// challenge, or your hosting platform's Domains API) before it's safe to
// route on, which isn't built. This just validates a plausible hostname,
// keeps it out of the platform's own reserved subdomain space, and saves
// it — normal RLS-bound write (orgs_admin_update already covers this;
// requireUser + the explicit roleInOrg check below just gets a friendlier
// error than a silently-rejected update, matching every other owner/admin-
// gated action in this file).
// ----------------------------------------------------------------------

const HOSTNAME_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export async function updateOrgDomain(orgId: string, domainRaw: string | null): Promise<void> {
  const { supabase, user } = await requireUser();
  const callerRole = await roleInOrg(supabase, orgId, user.id);
  if (callerRole !== "owner" && callerRole !== "admin") throw new Error("Only an owner or admin can change the organization's domain.");

  const domain = (domainRaw ?? "").trim().toLowerCase();

  if (!domain) {
    // Clearing it — a legitimate action (e.g. giving up on a domain that
    // never got its DNS pointed here), not an error.
    const { error } = await supabase.from("orgs").update({ custom_domain: null }).eq("id", orgId);
    if (error) throw new Error(error.message);
    revalidatePath("/dashboard");
    return;
  }

  if (!HOSTNAME_RE.test(domain)) {
    throw new Error("That doesn't look like a domain — use just the hostname, e.g. support.yourcompany.com (no https:// or path).");
  }

  const rootDomain = (process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "").toLowerCase().replace(/\.$/, "");
  if (rootDomain && (domain === rootDomain || domain.endsWith(`.${rootDomain}`))) {
    // Reserved for the platform's own <slug>.ROOT_DOMAIN subdomains (see
    // middleware.ts) — a custom domain claiming that space would either
    // collide with, or be silently shadowed by, the built-in routing.
    throw new Error(`${domain} is reserved for this app's own subdomains — pick a domain you actually own instead.`);
  }

  const { error } = await supabase.from("orgs").update({ custom_domain: domain }).eq("id", orgId);
  if (error) {
    // The partial unique index on lower(custom_domain) (see schema.sql /
    // domains.sql) means this is almost certainly "someone else already
    // claimed it" rather than a generic failure.
    if (error.code === "23505") throw new Error(`${domain} is already in use by another organization.`);
    throw new Error(error.message);
  }
  revalidatePath("/dashboard");
}
