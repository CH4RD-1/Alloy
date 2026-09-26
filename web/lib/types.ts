// TypeScript types mirroring schema.sql. Not exhaustive — extend as the
// schema grows, or generate these automatically later with
// `supabase gen types typescript` once the project is on Supabase.

export type Role = "owner" | "admin" | "manager" | "authorizer" | "standard";

// orgs.dev_tools — see that column's own comment in schema.sql. A master
// switch plus three independently-toggleable developer tools.
export interface DevTools {
  enabled: boolean;
  userSwitch: boolean;
  dummyUsers: boolean;
  templates: boolean;
}
// "blocked"/"blocks" are always stored and removed as a mirrored pair
// (see the task_links note in schema.sql and addLink/removeLink in
// lib/actions.ts) — "blocked" on the dependent task, "blocks" on the
// task it depends on, so each task's own Links section shows its own
// side of the relationship correctly labeled.
export type LinkType = "blocked" | "blocks" | "concurrent" | "related" | "clone";
export type TicketChannel = "internal" | "portal" | "email" | "whatsapp";
export type TaskKind = "task" | "asset_allocation";
// 'private' = an internal note — never sent out via Postmark/Twilio, hidden
// from the task panel's "Preview as customer" toggle. See schema.sql's own
// comment on ticket_messages.visibility.
export type MessageVisibility = "public" | "private";
export type OrgTemplate = "core" | "helpdesk" | "engineering";

// Mirrors Stripe's own Subscription.status values verbatim — see
// schema.sql's comment on orgs.subscription_status for why.
export type SubscriptionStatus =
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused";

export interface Org {
  id: string;
  name: string;
  slug: string;
  template: OrgTemplate;
  // Bring-your-own domain, set from the Organization panel — see
  // lib/actions.ts's updateOrgDomain. Not yet routed on (see schema.sql's
  // own comment on this column) — the live routing today is
  // <slug>.NEXT_PUBLIC_ROOT_DOMAIN, computed from `slug` above, not this.
  custom_domain: string | null;
  // Billing — all four written only by app/api/webhooks/stripe/route.ts,
  // never by the client. See lib/billing.ts and that webhook route for how
  // these get set; see components/org-settings-panel.tsx for where they're
  // shown. null across the board means "never started a subscription."
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
  subscription_status: SubscriptionStatus | null;
  subscription_current_period_end: string | null;
  // Org-wide opt-in toggle — see lib/actions.ts's toggleTeamAllocation and
  // schema.sql's own comment on this column. Off by default.
  team_allocation_enabled: boolean;
  // SLA targets for Helpdesk tickets — see schema.sql's own comment on
  // these two columns, lib/sla.ts, and components/sla-settings-panel.tsx.
  sla_first_response_hours: number;
  sla_resolution_days: number;
  created_at: string;
}

export interface OrgMember {
  id: string;
  org_id: string;
  user_id: string;
  role: Role;
}

export interface Project {
  id: string;
  org_id: string;
  name: string;
  color: string;
  is_helpdesk: boolean;
  enable_allocations: boolean;
  // Task IDs — see schema.sql's own comment on projects.tag/next_task_number
  // and tasks.task_number/display_id. tag is nullable/editable; only ever
  // changes what *future* tasks in this project get.
  tag: string | null;
  next_task_number: number;
  archived_at: string | null;
  created_at: string;
  // Which workflow this project's task-kind (or asset_allocation-kind, for
  // the second field) rows use — see schema.sql's own comment on these two
  // columns and Workflow above. Both null only transiently during
  // migration; every project gets a workflow_id, and asset_workflow_id is
  // only meaningful (and only shown in the UI) while enable_allocations
  // is true.
  workflow_id: string | null;
  asset_workflow_id: string | null;
}

export interface Tag {
  id: string;
  org_id: string;
  name: string;
  color: string;
}

// One of the org's (potentially many) workflows — see schema.sql's own
// comment on this table. `type` says which of the 4 object kinds a
// workflow is meant for; it doesn't attach the workflow to any project by
// itself (projects.workflow_id/asset_workflow_id do that, chosen per
// project in the Manage Projects panel's workflow dropdown(s)). 'deal' is
// the odd one out — a Deal (below) carries its own workflow_id directly
// rather than inheriting one from a project, since deals don't belong to a
// project at all.
export type WorkflowType = "task" | "helpdesk" | "asset" | "deal";

export interface Workflow {
  id: string;
  org_id: string;
  name: string;
  type: WorkflowType;
}

export interface WorkflowTransition {
  id: string;
  org_id: string;
  workflow_id: string;
  from_status_id: string;
  to_status_id: string;
  allowed_roles: string[];
  require_subtasks_complete: boolean;
  require_checklists_complete: boolean;
}

// Cross-entity automation — see schema.sql's own comment on
// workflow_transition_actions for the full rationale. v1 only wires these up
// for 'deal'-type workflows acting on tasks (updateDealStage in
// lib/actions.ts); the table/types are generic so a 'task' workflow could
// carry actions too, but nothing executes them yet.
export type TransitionActionType = "create_task" | "transition_linked_tasks" | "update_linked_tasks";

// Makes one new task in `project_id`, at `workflow_status_id` (must belong
// to that project's own task/helpdesk workflow), linked to the triggering
// deal via tasks.deal_id. `title` may contain the literal token "{{deal}}",
// replaced with the deal's own title when the action runs (see
// resolveActionTitle in lib/actions.ts) — the only templating this supports.
export interface CreateTaskActionConfig {
  title: string;
  project_id: string;
  workflow_status_id: string;
  assignee_id?: string | null;
}

// Moves every task already linked to the triggering deal (tasks.deal_id)
// into `workflow_status_id` — but only the ones whose own project runs the
// same task workflow that status belongs to; a linked task on a different
// task workflow is left alone rather than erroring (see
// runTransitionActions' own comment).
export interface TransitionLinkedTasksActionConfig {
  workflow_status_id: string;
}

// Reassigns every task linked to the triggering deal. Both fields optional
// so an action can set just one; a fully-empty config is a no-op.
export interface UpdateLinkedTasksActionConfig {
  assignee_id?: string | null;
}

export type TransitionActionConfig =
  | CreateTaskActionConfig
  | TransitionLinkedTasksActionConfig
  | UpdateLinkedTasksActionConfig;

export interface WorkflowTransitionAction {
  id: string;
  org_id: string;
  transition_id: string;
  action_type: TransitionActionType;
  config: TransitionActionConfig;
  position: number;
}

// (Project is defined once, above, alongside Org — a leftover duplicate
// declaration used to sit here; removed since it had started to drift out
// of sync with the real one when the task-id columns were added.)

export interface Team {
  id: string;
  org_id: string;
  project_id: string;
  name: string;
  color: string;
  position: number;
}

// Team allocation — see schema.sql's own comment on this table. No `id`:
// (team_id, user_id) is the primary key.
export interface TeamMember {
  team_id: string;
  user_id: string;
  org_id: string;
}

export interface WorkflowStatus {
  id: string;
  org_id: string;
  workflow_id: string;
  key: string;
  label: string;
  color: string;
  position: number;
  is_closed: boolean;
}

export interface Task {
  id: string;
  org_id: string;
  project_id: string;
  team_id: string | null;
  parent_task_id: string | null;
  kind: TaskKind;
  asset_id: string | null;
  title: string;
  description: string | null;
  status_id: string;
  assignee_id: string | null;
  is_milestone: boolean;
  start_date: string | null;
  due_date: string | null;
  // Task IDs — see schema.sql's own comment on these two columns. Assigned
  // once at creation by next_task_display_id(); never editable afterward.
  // Both null for a task created before this feature, or in a project with
  // no tag set at creation time.
  task_number: number | null;
  display_id: string | null;
  channel: TicketChannel;
  external_thread_ref: string | null;
  contact_id: string | null;
  // See schema.sql's own comment on this column — set only for a
  // contact-facing ticket, used to build its "check progress" magic link.
  portal_access_token: string | null;
  // CRM cross-entity link — set on a task a deal-stage transition's
  // create_task action made, or one linked by hand from the task panel. See
  // schema.sql's own comment on workflow_transition_actions.
  deal_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // Manual Gantt ordering only (see lib/gantt-view.ts's buildGanttRows) —
  // every other view keeps its own existing sort and ignores this. Default
  // 0 for anything created before this column existed; the Gantt's own
  // up/down arrows are what assign real, distinct values from then on.
  position: number;
}

// What updateTaskSchedule/autoArrangeSchedule (lib/actions.ts) actually
// changed on commit — every task whose start/due moved, not just the one
// directly dragged (a cascade can push a blocked task, resync a
// concurrent/clone partner, or grow a parent for containment). The Gantt
// view's optimistic-patch overlay (tasks-workspace.tsx) applies these
// straight to its local patch map the moment the action resolves, instead
// of waiting on router.refresh() to re-fetch and re-render with the new
// dates — see that overlay's own comment for why a full local-state lift
// isn't used instead.
export interface ScheduleChange {
  id: string;
  start_date: string;
  due_date: string;
}

export interface TaskLink {
  id: string;
  org_id: string;
  from_task_id: string;
  to_task_id: string;
  link_type: LinkType;
}

export interface Contact {
  id: string;
  org_id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  // CRM Phase A — nullable, a one-off Portal/email/WhatsApp requester
  // usually has no known company yet. See schema.sql's own comment on this
  // column.
  company_id: string | null;
}

export interface TicketMessage {
  id: string;
  org_id: string;
  task_id: string;
  direction: "inbound" | "outbound";
  channel: TicketChannel;
  author_contact_id: string | null;
  author_user_id: string | null;
  body: string;
  external_message_ref: string | null;
  visibility: MessageVisibility;
  created_at: string;
}

// A file attached directly to a conversation message — see
// ticket_message_attachments' own comment in schema.sql. Read paths attach
// a signed `url` (1hr, same pattern as TaskObjectFile's own) alongside the
// stored row, generated server-side since the bucket is private.
export interface TicketMessageAttachment {
  id: string;
  ticket_message_id: string;
  storage_path: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
}

// Append-only audit trail (activity_log). Scope matches the prototype's own
// logActivity() exactly: only a task's creation and its status moves are
// recorded — no field-edit history, matching how the prototype never
// logged anything else either. `actor_user_id` is set for a signed-in
// member's own action; `actor_contact_id` is set instead for an anonymous
// Portal submission (submitPortalRequest runs under the service-role
// client, which has no user session to attribute the "created" entry to).
export type ActivityType = "created" | "status";

export interface ActivityLogEntry {
  id: string;
  org_id: string;
  task_id: string;
  type: ActivityType;
  from_status_id: string | null; // only set when type = "status"
  to_status_id: string | null; // only set when type = "status"
  actor_user_id: string | null;
  actor_contact_id: string | null;
  created_at: string;
}

// A Phase A/B leftover — deal_activity_log's own append-only audit trail,
// same shape as ActivityLogEntry above but scoped to deals: only a deal's
// creation and its stage moves are recorded (see deal_activity_log.sql's own
// comment for why this is a separate table rather than widening
// activity_log itself). No actor_contact_id: a deal has no anonymous-
// Portal-submission path the way a task does, so every row here is a
// signed-in member's own action.
export type DealActivityType = "created" | "stage";

export interface DealActivityLogEntry {
  id: string;
  org_id: string;
  deal_id: string;
  type: DealActivityType;
  from_status_id: string | null; // only set when type = "stage"
  to_status_id: string | null; // only set when type = "stage"
  actor_user_id: string | null;
  created_at: string;
}

export interface Asset {
  id: string;
  org_id: string;
  name: string;
  icon: string;
  tag: string | null;
  cost_rate: number | null;
  cost_frequency: string | null;
  notes: string | null;
  retired: boolean;
}

// A pending (or already-accepted) invitation to join an org — see
// lib/actions.ts's createInvite/acceptInvite. `role` is always one of the 3
// workflow roles: an invite can't grant "owner"/"admin" directly, same
// restriction updateMemberRole already has on reassignment.
export interface Invite {
  id: string;
  org_id: string;
  email: string;
  role: Role;
  token: string;
  invited_by: string | null;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
}

export interface Doc {
  id: string;
  org_id: string;
  title: string;
  body_html: string;
  published: boolean;
  created_at: string;
  updated_at: string;
}

// "note"/"checklist"/"file"/"sketch" are all created and rendered from the
// task panel's own add-menu now. "form" is a special case: a task_object
// with this kind is created only by the Portal's submitPortalRequest
// service-role flow (see lib/actions.ts) when a customer submits a request
// through a form template — there's no in-panel "add a form" option, and
// the task panel doesn't render an existing form-kind object's answers yet
// (it falls back to the generic "not supported" stub) — a real, separate
// gap from file/sketch, not part of this pass.
export type TaskObjectKind = "note" | "file" | "sketch" | "checklist" | "form" | "code";

export interface TaskObject {
  id: string;
  org_id: string;
  task_id: string;
  kind: TaskObjectKind;
  position: number;
  // "code" stores both fields here rather than getting its own table —
  // same reasoning as "note"'s plain { text }: no file storage needed, so
  // this generic jsonb column is enough. `language` is either a specific
  // highlight.js language key or "auto" (detect on render — see
  // lib/code-highlight.ts).
  content: { text?: string; code?: string; language?: string } | null;
  created_by: string | null;
  created_at: string;
}

// The Storage-backed side of a "file" or "sketch" task_object — a 1:1 row
// (task_object_files.task_object_id is unique — see
// task_attachments_storage.sql) pointing at the actual bytes in the
// task-attachments Storage bucket. A "note" or "checklist" object never has
// one of these; a "sketch" object doesn't either until its first stroke is
// saved.
export interface TaskObjectFile {
  id: string;
  task_object_id: string;
  storage_path: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
}

export interface ChecklistItem {
  id: string;
  task_object_id: string;
  label: string;
  is_checked: boolean;
  position: number;
}

export type FormFieldType = "text" | "paragraph" | "number" | "select" | "yes_no" | "date";

export interface FormField {
  id: string;
  label: string;
  type: FormFieldType;
  options?: string[]; // only meaningful for "select"
}

export interface FormTemplate {
  id: string;
  org_id: string;
  name: string;
  fields: FormField[];
  portal_visible: boolean;
  created_at: string;
}

// custom_field_defs.field_type reuses FormFieldType — the prototype's own
// custom-field manager only understood text/number/select/boolean, but the
// schema was already built against the fuller 6-type set used for Portal
// form fields (see lib/types.ts's FormFieldType), so this port offers all
// six here too rather than the prototype's narrower set.
export interface CustomFieldDef {
  id: string;
  org_id: string;
  name: string;
  field_type: FormFieldType;
  options: string[] | null; // only meaningful for "select"
  position: number;
  created_at: string;
}

// ----------------------------------------------------------------------------
// CRM — Companies & Deals (Phase A). See lib/actions.ts's own header comment
// on getCompaniesData/getDealsData for why these are fetched separately from
// WorkspaceData/getWorkspaceData rather than folded into it.
// ----------------------------------------------------------------------------

export interface Company {
  id: string;
  org_id: string;
  name: string;
  domain: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// A deal's "stage" is a workflow_status on a 'deal'-type workflow — see
// schema.sql's own comment on this table for why win/loss is derived from
// that status (is_closed + its stable key, 'won'/'lost') rather than stored
// as a separate column here. lib/crm-view.ts's dealOutcome() does that
// derivation.
export interface Deal {
  id: string;
  org_id: string;
  title: string;
  company_id: string | null;
  primary_contact_id: string | null;
  owner_user_id: string | null;
  workflow_id: string;
  status_id: string;
  value: number | null;
  currency: string;
  expected_close_date: string | null;
  created_at: string;
  updated_at: string;
}
