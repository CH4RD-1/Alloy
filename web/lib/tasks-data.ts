import { createClient } from "@/lib/supabase/server";
import { TASK_ATTACHMENTS_BUCKET } from "@/lib/storage";
import type {
  Task,
  WorkflowStatus,
  WorkflowTransition,
  Workflow,
  Team,
  TaskLink,
  Asset,
  Project,
  Tag,
  Role,
  Doc,
  TaskObject,
  TaskObjectFile,
  ChecklistItem,
  FormTemplate,
  CustomFieldDef,
  ActivityLogEntry,
  TicketMessage,
  Contact,
  Invite,
  SubscriptionStatus,
} from "@/lib/types";

// Denormalized view of an org member for dropdowns (assignee picker, etc.) —
// distinct from the raw org_members row shape in lib/types.ts.
export interface MemberSummary {
  userId: string;
  name: string;
  email: string;
  role: Role;
}

export interface WorkspaceData {
  orgId: string;
  orgTemplate: string;
  // For the Organization panel: the portal URL(s) to show and the custom
  // domain field to edit — see components/org-settings-panel.tsx.
  orgName: string;
  orgSlug: string;
  orgCustomDomain: string | null;
  // For the Organization panel's Billing section — see
  // components/org-settings-panel.tsx and lib/billing.ts. All null means
  // "never started a subscription," not "inactive" — see schema.sql's
  // comment on these columns.
  orgSubscriptionStatus: SubscriptionStatus | null;
  orgStripePriceId: string | null;
  orgSubscriptionPeriodEnd: string | null;
  // Team allocation — see schema.sql's own comment on this column and on
  // the team_members table. Off by default; while off, teamMemberIdsByTeam
  // below is still fetched and populated but nothing in the UI reads it.
  orgTeamAllocationEnabled: boolean;
  // SLA targets for Helpdesk tickets — see schema.sql's own comment on
  // orgs.sla_first_response_hours/sla_resolution_days, lib/sla.ts, and
  // components/sla-settings-panel.tsx.
  slaFirstResponseHours: number;
  slaResolutionDays: number;
  // team_id -> the user_ids registered on it. A team with no entry here (or
  // an empty array) has zero registered members — components/task-panel.tsx
  // / new-task-panel.tsx fall back to showing everyone for such a team
  // rather than an empty, unusable Assignee dropdown.
  teamMemberIdsByTeam: Map<string, string[]>;
  currentUserId: string;
  currentUserRole: Role;
  tasks: Task[];
  statuses: WorkflowStatus[];
  transitions: WorkflowTransition[];
  workflows: Workflow[];
  teams: Team[];
  projects: Project[];
  links: TaskLink[];
  tags: Tag[];
  tagsByTask: Map<string, string[]>;
  docCountByTask: Map<string, number>;
  assigneeNameById: Map<string, string>;
  assets: Asset[];
  members: MemberSummary[];
  docs: Doc[];
  docIdsByTask: Map<string, string[]>;
  taskIdsByDoc: Map<string, string[]>;
  taskObjects: TaskObject[];
  checklistItemsByObject: Map<string, ChecklistItem[]>;
  // One entry per "file"/"sketch" task_object that has an uploaded/saved
  // file — a sketch object with no strokes saved yet simply has no entry.
  // `url` is a short-lived (1hr) signed URL, generated fresh on every
  // workspace load since the bucket is private (see lib/storage.ts).
  taskObjectFileByObjectId: Map<string, TaskObjectFile & { url: string | null }>;
  formTemplates: FormTemplate[];
  formTemplateUsage: Map<string, number>;
  customFieldDefs: CustomFieldDef[];
  // task_id -> { field_def_id -> value }, one entry per (task, field) that
  // actually has a saved value — a field with no row for a task is simply
  // absent from that task's record, same as an unset key.
  customFieldValuesByTask: Map<string, Record<string, unknown>>;
  // Org-wide, most-recent-first, capped at fetch time (see the query below)
  // rather than at write time the way the prototype capped each task's own
  // in-memory array at 25 — a real table has no reason to ever delete old
  // rows, so the cap only bounds how much of the *history* a page load
  // reads back, not how much exists. Both the per-task "Activity" section
  // (filtered by task_id) and the Dashboard's "your recent activity" feed
  // (lib/activity-view.ts's recentActivityForUser) are derived from this
  // one already-sorted list rather than two separate queries.
  activityLog: ActivityLogEntry[];
  // Only for the Portal-submission case (activity_log.actor_contact_id) —
  // a signed-in member's own actions resolve through `members` instead.
  contactNameById: Map<string, string>;
  // Full contact records (not just a display name) for every contact
  // referenced anywhere in this load — a task's own contact_id, an
  // activity_log actor_contact_id, or a ticket_messages author_contact_id —
  // so the task panel's Conversation section can show a contact's actual
  // email/phone, not just a name. contactNameById above stays narrower
  // (name only) since lib/activity-view.ts's actorDisplayName() was
  // already built against that exact shape.
  contactById: Map<string, Contact>;
  // Every channel (email/whatsapp/portal/internal) task's message history,
  // org-wide — the task panel's Conversation section filters this by
  // task_id the same way the Activity section filters activityLog above.
  ticketMessages: TicketMessage[];
  // Pending/accepted invites for this org — the Workflow & roles panel's
  // Invite section reads this. RLS (invites_admin_manage) already scopes
  // the underlying query to owner/admin callers only, so a non-admin's own
  // load of this same query simply comes back empty rather than needing an
  // app-level check here too — same as every other admin-only read in this
  // file relies on its own RLS policy rather than a client-side role check.
  invites: Invite[];
}

// First pass: uses the signed-in user's first org membership. An org
// switcher (for someone in more than one org) is a follow-up.
export async function getWorkspaceData(userId: string): Promise<WorkspaceData | null> {
  const supabase = await createClient();

  const { data: membership } = await supabase
    .from("org_members")
    .select(
      "org_id, role, orgs ( template, name, slug, custom_domain, subscription_status, stripe_price_id, subscription_current_period_end, team_allocation_enabled, sla_first_response_hours, sla_resolution_days )"
    )
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();

  if (!membership) return null;
  const orgId = membership.org_id as string;
  // Supabase's nested-select typing infers an array even for a to-one FK
  // relationship — safe to read it as a single object here.
  const orgRow = (membership as any).orgs ?? {};
  const orgTemplate = orgRow.template ?? "core";
  const orgName = orgRow.name ?? "";
  const orgSlug = orgRow.slug ?? "";
  const orgCustomDomain = (orgRow.custom_domain as string | null) ?? null;
  const orgSubscriptionStatus = (orgRow.subscription_status as SubscriptionStatus | null) ?? null;
  const orgStripePriceId = (orgRow.stripe_price_id as string | null) ?? null;
  const orgSubscriptionPeriodEnd = (orgRow.subscription_current_period_end as string | null) ?? null;
  const orgTeamAllocationEnabled = !!orgRow.team_allocation_enabled;
  const slaFirstResponseHours = Number(orgRow.sla_first_response_hours ?? 24);
  const slaResolutionDays = Number(orgRow.sla_resolution_days ?? 14);
  const currentUserRole = membership.role as Role;

  const [
    { data: tasks },
    { data: statuses },
    { data: transitions },
    { data: workflows },
    { data: teams },
    { data: projects },
    { data: links },
    { data: assets },
    { data: tags },
    { data: memberRows },
    { data: docs },
    { data: taskObjects },
    { data: formTemplates },
    { data: customFieldDefs },
    { data: activityLog },
    { data: ticketMessages },
    { data: invites },
    { data: teamMemberRows },
  ] = await Promise.all([
    supabase.from("tasks").select("*").eq("org_id", orgId).order("created_at", { ascending: false }),
    supabase.from("workflow_statuses").select("*").eq("org_id", orgId).order("position"),
    supabase.from("workflow_transitions").select("*").eq("org_id", orgId),
    supabase.from("workflows").select("*").eq("org_id", orgId).order("created_at"),
    supabase.from("teams").select("*").eq("org_id", orgId),
    supabase.from("projects").select("*").eq("org_id", orgId),
    supabase.from("task_links").select("*").eq("org_id", orgId),
    supabase.from("assets").select("*").eq("org_id", orgId),
    supabase.from("tags").select("*").eq("org_id", orgId),
    supabase.from("org_members").select("user_id, role, users ( name, email )").eq("org_id", orgId),
    supabase.from("docs").select("*").eq("org_id", orgId).order("updated_at", { ascending: false }),
    supabase.from("task_objects").select("*").eq("org_id", orgId).order("position"),
    supabase.from("form_templates").select("*").eq("org_id", orgId).order("created_at"),
    supabase.from("custom_field_defs").select("*").eq("org_id", orgId).order("position"),
    // Capped rather than unbounded — see the WorkspaceData.activityLog
    // comment. 300 is generous for a single-org page load at this app's
    // current scale (a handful of active users, not thousands of tasks);
    // revisit if a real customer's history routinely blows past it.
    supabase.from("activity_log").select("*").eq("org_id", orgId).order("created_at", { ascending: false }).limit(300),
    // Same read-time cap as activity_log above, for the same reason — a
    // real conversation history has no reason to ever be deleted, so the
    // cap only bounds how much of it a page load reads back.
    supabase.from("ticket_messages").select("*").eq("org_id", orgId).order("created_at", { ascending: false }).limit(300),
    // Comes back empty for a non-admin caller — RLS (invites_admin_manage)
    // does that filtering, not this query.
    supabase.from("invites").select("*").eq("org_id", orgId).order("created_at", { ascending: false }),
    // Fetched unconditionally, not just while the toggle above is on — the
    // teams-panel.tsx membership editor works whether or not the org has
    // opted into narrowing Assignee dropdowns yet.
    supabase.from("team_members").select("team_id, user_id").eq("org_id", orgId),
  ]);

  const teamMemberIdsByTeam = new Map<string, string[]>();
  (teamMemberRows ?? []).forEach((row: any) => {
    const list = teamMemberIdsByTeam.get(row.team_id) ?? [];
    list.push(row.user_id);
    teamMemberIdsByTeam.set(row.team_id, list);
  });

  const formTemplateUsage = new Map<string, number>();
  const templateIds = (formTemplates ?? []).map((t) => t.id);
  if (templateIds.length) {
    const { data: usageRows } = await supabase.from("task_object_forms").select("form_template_id").in("form_template_id", templateIds);
    (usageRows ?? []).forEach((r: any) => {
      formTemplateUsage.set(r.form_template_id, (formTemplateUsage.get(r.form_template_id) ?? 0) + 1);
    });
  }

  const checklistObjectIds = (taskObjects ?? []).filter((o) => o.kind === "checklist").map((o) => o.id);
  const checklistItemsByObject = new Map<string, ChecklistItem[]>();
  if (checklistObjectIds.length) {
    const { data: checklistItemRows } = await supabase
      .from("checklist_items")
      .select("*")
      .in("task_object_id", checklistObjectIds)
      .order("position");
    (checklistItemRows ?? []).forEach((item: any) => {
      const list = checklistItemsByObject.get(item.task_object_id) ?? [];
      list.push(item);
      checklistItemsByObject.set(item.task_object_id, list);
    });
  }

  const fileObjectIds = (taskObjects ?? []).filter((o) => o.kind === "file" || o.kind === "sketch").map((o) => o.id);
  const taskObjectFileByObjectId = new Map<string, TaskObjectFile & { url: string | null }>();
  if (fileObjectIds.length) {
    const { data: fileRows } = await supabase.from("task_object_files").select("*").in("task_object_id", fileObjectIds);
    const rows = (fileRows ?? []) as TaskObjectFile[];
    const signedByPath = new Map<string, string>();
    if (rows.length) {
      const { data: signedRows } = await supabase.storage
        .from(TASK_ATTACHMENTS_BUCKET)
        .createSignedUrls(rows.map((r) => r.storage_path), 3600);
      (signedRows ?? []).forEach((s) => {
        if (s.signedUrl && s.path) signedByPath.set(s.path, s.signedUrl);
      });
    }
    rows.forEach((row) => {
      taskObjectFileByObjectId.set(row.task_object_id, { ...row, url: signedByPath.get(row.storage_path) ?? null });
    });
  }

  const taskIds = (tasks ?? []).map((t) => t.id);

  const tagsByTask = new Map<string, string[]>();
  const docCountByTask = new Map<string, number>();
  const docIdsByTask = new Map<string, string[]>();
  const taskIdsByDoc = new Map<string, string[]>();
  const customFieldValuesByTask = new Map<string, Record<string, unknown>>();

  if (taskIds.length) {
    const [{ data: taskTagRows }, { data: taskDocRows }, { data: customFieldValueRows }] = await Promise.all([
      supabase.from("task_tags").select("task_id, tags ( name )").in("task_id", taskIds),
      supabase.from("task_docs").select("task_id, doc_id").in("task_id", taskIds),
      supabase.from("custom_field_values").select("task_id, field_def_id, value").in("task_id", taskIds),
    ]);

    (customFieldValueRows ?? []).forEach((row: any) => {
      const forTask = customFieldValuesByTask.get(row.task_id) ?? {};
      forTask[row.field_def_id] = row.value;
      customFieldValuesByTask.set(row.task_id, forTask);
    });

    (taskTagRows ?? []).forEach((row: any) => {
      const name = row.tags?.name;
      if (!name) return;
      const list = tagsByTask.get(row.task_id) ?? [];
      list.push(name);
      tagsByTask.set(row.task_id, list);
    });

    (taskDocRows ?? []).forEach((row: any) => {
      docCountByTask.set(row.task_id, (docCountByTask.get(row.task_id) ?? 0) + 1);

      const docsForTask = docIdsByTask.get(row.task_id) ?? [];
      docsForTask.push(row.doc_id);
      docIdsByTask.set(row.task_id, docsForTask);

      const tasksForDoc = taskIdsByDoc.get(row.doc_id) ?? [];
      tasksForDoc.push(row.task_id);
      taskIdsByDoc.set(row.doc_id, tasksForDoc);
    });
  }

  const assigneeIds = Array.from(new Set((tasks ?? []).map((t) => t.assignee_id).filter((x): x is string => !!x)));
  const assigneeNameById = new Map<string, string>();
  if (assigneeIds.length) {
    const { data: users } = await supabase.from("users").select("id, name, email").in("id", assigneeIds);
    (users ?? []).forEach((u: any) => assigneeNameById.set(u.id, u.name || u.email));
  }

  // Union of every place a contact id can show up: activity_log's own
  // actor_contact_id, a channel task's contact_id, and now a ticket
  // message's author_contact_id — one fetch covers all three rather than
  // three separate ones.
  const contactIds = Array.from(
    new Set([
      ...(activityLog ?? []).map((a) => a.actor_contact_id),
      ...(tasks ?? []).map((t) => t.contact_id),
      ...(ticketMessages ?? []).map((m) => m.author_contact_id),
    ].filter((x): x is string => !!x))
  );
  const contactNameById = new Map<string, string>();
  const contactById = new Map<string, Contact>();
  if (contactIds.length) {
    const { data: contacts } = await supabase.from("contacts").select("*").in("id", contactIds);
    (contacts ?? []).forEach((c: any) => {
      contactNameById.set(c.id, c.name || c.email || "A Portal requester");
      contactById.set(c.id, c as Contact);
    });
  }

  const members: MemberSummary[] = (memberRows ?? []).map((m: any) => ({
    userId: m.user_id,
    name: m.users?.name || m.users?.email || "Unknown",
    email: m.users?.email ?? "",
    role: m.role,
  }));

  return {
    orgId,
    orgTemplate,
    orgName,
    orgSlug,
    orgCustomDomain,
    orgSubscriptionStatus,
    orgStripePriceId,
    orgSubscriptionPeriodEnd,
    orgTeamAllocationEnabled,
    slaFirstResponseHours,
    slaResolutionDays,
    teamMemberIdsByTeam,
    currentUserId: userId,
    currentUserRole,
    tasks: (tasks ?? []) as Task[],
    statuses: (statuses ?? []) as WorkflowStatus[],
    transitions: (transitions ?? []) as WorkflowTransition[],
    workflows: (workflows ?? []) as Workflow[],
    teams: (teams ?? []) as Team[],
    projects: (projects ?? []) as Project[],
    links: (links ?? []) as TaskLink[],
    tags: (tags ?? []) as Tag[],
    tagsByTask,
    docCountByTask,
    assigneeNameById,
    assets: (assets ?? []) as Asset[],
    members,
    docs: (docs ?? []) as Doc[],
    docIdsByTask,
    taskIdsByDoc,
    taskObjects: (taskObjects ?? []) as TaskObject[],
    checklistItemsByObject,
    taskObjectFileByObjectId,
    formTemplates: (formTemplates ?? []) as FormTemplate[],
    formTemplateUsage,
    customFieldDefs: (customFieldDefs ?? []) as CustomFieldDef[],
    customFieldValuesByTask,
    activityLog: (activityLog ?? []) as ActivityLogEntry[],
    contactNameById,
    contactById,
    ticketMessages: (ticketMessages ?? []) as TicketMessage[],
    invites: (invites ?? []) as Invite[],
  };
}
