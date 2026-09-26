-- ============================================================================
-- Alloy — Postgres schema, v1 sketch
-- ============================================================================
-- Scope: a first-pass relational model covering everything in the Alloy
-- prototype (v0.11) as a multi-tenant SaaS backend — projects/tasks/subtasks,
-- typed dependencies, custom fields & tags, a configurable workflow engine,
-- buckets/teams nested per project, a knowledge base, form templates, the
-- Assets feature, and multi-channel ticket intake (Portal/QR, email,
-- WhatsApp).
--
-- Assumptions:
--   - Postgres 14+, running on Supabase (pgcrypto is enabled by default,
--     giving us gen_random_uuid()). Swap for uuid-ossp's uuid_generate_v4()
--     if hosting elsewhere.
--   - Every tenant-scoped table carries org_id and is intended to have a
--     Row Level Security policy keyed on it (examples at the bottom).
--   - Enum-like fields use TEXT + CHECK rather than native Postgres ENUMs —
--     easier to extend later (ALTER TYPE ... ADD VALUE has sharp edges;
--     a CHECK constraint is a one-line ALTER).
--   - This is a sketch to build against and refine, not a final migration.
--     Things intentionally left out for now: a full audit/activity log,
--     notification preferences, and billing tables (Stripe-side state can
--     mostly live in Stripe itself, referenced by a customer id on orgs).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Tenancy & identity
-- ----------------------------------------------------------------------------

create table orgs (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  slug              text not null unique,              -- used in portal URLs, e.g. app.tld/portal/<slug>, and — when NEXT_PUBLIC_ROOT_DOMAIN is set — as the subdomain itself: <slug>.<root domain>
  template          text not null default 'core'        -- workspace template chosen at signup: 'core' | 'helpdesk' | 'engineering' | ...
                      check (template in ('core','helpdesk','engineering')),
  -- An org's own bring-your-own domain (e.g. support.theircompany.com), set
  -- from the Organization panel — see lib/actions.ts's updateOrgDomain. Data
  -- model + settings UI only for now: nothing actually routes traffic on
  -- this column yet (middleware.ts only ever rewrites the platform's own
  -- <slug>.ROOT_DOMAIN subdomains, deliberately not arbitrary Host headers —
  -- routing on an unverified value here would mean any org could claim a
  -- domain it doesn't control). Wiring this live needs a real ownership
  -- check (a DNS TXT challenge, or your hosting platform's own Domains API,
  -- e.g. Vercel's) before it's safe to route on — that's the follow-up this
  -- column and the uniqueness constraint below are laid down for.
  custom_domain     text,
  -- Billing (Stripe) — set only by the webhook handler
  -- (app/api/webhooks/stripe/route.ts), under the service-role client, never
  -- by the client directly, so there's deliberately no app-level write
  -- action for these four beyond what the webhook does. stripe_customer_id
  -- is created lazily on first checkout (lib/billing.ts's
  -- createCheckoutSession) rather than at signup, so it's null for an org
  -- that's never started a subscription. subscription_status mirrors
  -- Stripe's own status strings verbatim (active/trialing/past_due/
  -- canceled/incomplete/...) rather than a reinvented vocabulary, so it's
  -- always exactly what Stripe's dashboard shows, and null here means
  -- literally "no subscription object exists yet," not "inactive."
  stripe_customer_id            text,
  stripe_subscription_id        text,
  stripe_price_id               text,
  subscription_status           text,
  subscription_current_period_end timestamptz,
  -- Org-wide opt-in, off by default — mirrors the prototype's own sidebar
  -- "Team allocation: On/Off" switch. While on, a task's Assignee dropdown
  -- narrows to its team's registered members (team_members below); while
  -- off (the default), nothing about assignee selection changes from
  -- today. Toggled from the Organization panel, written through
  -- orgs_admin_update like every other org-settings field on this table.
  team_allocation_enabled boolean not null default false,
  -- SLA targets for Helpdesk tickets (components/sla-settings-panel.tsx,
  -- "SLA settings" in the sidebar footer) — one global pair for the whole
  -- org, not per-project, matching how this was requested. Every Helpdesk-
  -- project task's panel (components/task-panel.tsx) shows a live countdown
  -- against these, measured from that task's own created_at:
  --   sla_first_response_hours — *working* hours (Mon-Fri 09:00-17:00),
  --     since a real support team doesn't answer overnight or on weekends.
  --     Met by the first public outbound ticket_messages row on the ticket.
  --     Disclosed simplification: the business-hours window is a fixed UTC
  --     calendar (lib/sla.ts's addBusinessHours) — there's no per-org
  --     timezone setting yet, so every org counts the same UTC 9-to-5.
  --   sla_resolution_days — plain calendar days (no business-hours logic).
  --     Met the first time the ticket reaches the 'done' workflow status
  --     (found via activity_log, not just the task's current status, so a
  --     later reopen doesn't erase how the SLA was actually met).
  -- Defaults (24 working hours / 14 days) match the org's own request.
  sla_first_response_hours integer not null default 24 check (sla_first_response_hours > 0),
  sla_resolution_days      integer not null default 14 check (sla_resolution_days > 0),
  -- Developer tools (components/dev-tools-panel.tsx) — a master on/off
  -- switch plus three independently-switchable sub-tools: "userSwitch" (the
  -- "Viewing as" control that lets an owner/admin preview the app as
  -- another member or a dummy user — see users.is_dummy below),
  -- "dummyUsers" (whether the dummy-user manager shows), and "templates"
  -- (project export/import). All four default off — a brand-new org never
  -- sees developer tooling until someone opts in. One JSONB column rather
  -- than four booleans since this is purely a UI-visibility toggle set with
  -- no query/index needs of its own, and it's easy to grow. Written through
  -- orgs_admin_update like every other org-settings field on this table —
  -- no separate policy needed.
  dev_tools         jsonb not null default '{"enabled":false,"userSwitch":false,"dummyUsers":false,"templates":false}'::jsonb,
  created_at        timestamptz not null default now()
);

create unique index orgs_custom_domain_lower_uq on orgs (lower(custom_domain)) where custom_domain is not null;
  -- case-insensitive, and partial so any number of orgs can leave this unset.

-- Mirrors the auth provider's user (Supabase auth.users / Clerk user) with
-- app-level profile fields. id should match the auth provider's user id.
create table users (
  id          uuid primary key,
  email       text not null unique,
  name        text,
  avatar_url  text,
  -- Set only by createDummyUser (lib/actions.ts, service-role, owner/admin-
  -- gated) — a row with no corresponding auth.users entry at all, so it can
  -- never actually sign in. Otherwise a fully real users/org_members row:
  -- assignable to tasks, shown in every member dropdown, eligible for any
  -- role — the point is letting an owner/admin genuinely test workflows,
  -- assignment, and role-gated UI as if a real teammate held that role,
  -- without provisioning a real account. See the "Developer tools" comment
  -- on orgs.dev_tools above for the full feature this supports.
  is_dummy    boolean not null default false,
  created_at  timestamptz not null default now()
);

-- Nothing populates `users` automatically otherwise — Supabase Auth writes
-- to its own auth.users table, which this app-level profile table mirrors
-- but does not read from directly. Without this trigger, a freshly signed-up
-- user exists in auth.users but has no row here, so org_members/tasks can
-- never reference them. security definer so it can write to public.users
-- despite running as the auth.users owner, not the signed-in user.
create or replace function handle_new_auth_user()
returns trigger as $$
begin
  insert into public.users (id, email, name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name', null))
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_auth_user();

create table org_members (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  -- owner/admin: org administration (billing, members, settings) — implicitly
  -- has manager-equivalent workflow rights too.
  -- manager/authorizer/standard: the existing in-app workflow role levels.
  role        text not null default 'standard'
                check (role in ('owner','admin','manager','authorizer','standard')),
  created_at  timestamptz not null default now(),
  unique (org_id, user_id)
);

create index on org_members (org_id);
create index on org_members (user_id);


-- ----------------------------------------------------------------------------
-- Invites — the other half of getting someone into an org besides signup.
-- Deliberately its own table rather than a "pending" org_members row: a
-- brand-new invitee has no users row yet (that only exists after they
-- actually sign in via magic link — see the handle_new_auth_user trigger
-- below), so org_members' own not-null user_id couldn't represent one
-- anyway. See lib/actions.ts's createInvite/getInviteByToken/acceptInvite.
-- ----------------------------------------------------------------------------

create table invites (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  email        text not null,
  -- Restricted to the 3 workflow roles, same as updateMemberRole's own
  -- reassignment scope — owner/admin aren't grantable via an invite either.
  role         text not null check (role in ('manager','authorizer','standard')),
  token        text not null unique default encode(gen_random_bytes(24), 'hex'),
  invited_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default (now() + interval '14 days'),
  accepted_at  timestamptz
);

create index on invites (org_id);
create unique index invites_org_email_pending_uq on invites (org_id, lower(email)) where accepted_at is null;
  -- one pending invite per email per org at a time — re-inviting after an
  -- expiry means revoking (deleting) the stale row first, matching
  -- revokeInvite's own delete-not-update approach to "undo an invite."

-- ----------------------------------------------------------------------------
-- Workflow engine (workflows, statuses & transitions)
-- ----------------------------------------------------------------------------

-- Many workflows per org, one per (type, purpose) — e.g. "Regular Tasks",
-- "Helpdesk Tickets", "Assets", or any custom workflow a user adds. `type`
-- says which of the 3 object kinds a workflow is meant for (the new
-- full-screen editor in components/workflow-panel.tsx groups/filters by
-- it); it does NOT by itself attach a workflow to any project — that's
-- projects.workflow_id/asset_workflow_id below, chosen explicitly per
-- project (see the Manage Projects panel's workflow dropdown(s)).
create table workflows (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  name        text not null,
  -- 'deal' added for the CRM expansion (Phase A) — a Deal Pipeline workflow
  -- backing the Deals kanban, same idea as 'asset' backing Asset Allocation.
  -- See companies/deals' own section below for how a deal's stage maps onto
  -- workflow_statuses/is_closed exactly like every other workflow type here.
  type        text not null check (type in ('task','helpdesk','asset','deal')),
  created_at  timestamptz not null default now()
);

create index on workflows (org_id);

create table workflow_statuses (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  workflow_id uuid not null references workflows(id) on delete cascade,
  key         text not null,        -- stable id, e.g. 'todo' | 'in_review' | 'done' — unique per workflow, not per org (two workflows may reuse a key)
  label       text not null,        -- display label, fully customisable — states can be added/renamed/removed per workflow
  color       text not null default '#64748b',
  position    int not null default 0,
  is_closed   boolean not null default false,   -- marks a terminal/"done"-equivalent status *within this workflow* — the generic signal every "is this task functionally finished" check uses instead of key === 'done', since a custom or non-Regular-Tasks workflow's terminal key can be anything ('closed', 'available', ...)
  created_at  timestamptz not null default now(),
  unique (workflow_id, key)
);

create index on workflow_statuses (org_id);
create index on workflow_statuses (workflow_id);

create table workflow_transitions (
  id                             uuid primary key default gen_random_uuid(),
  org_id                         uuid not null references orgs(id) on delete cascade,
  workflow_id                    uuid not null references workflows(id) on delete cascade,
  from_status_id                 uuid not null references workflow_statuses(id) on delete cascade,
  to_status_id                   uuid not null references workflow_statuses(id) on delete cascade,
  allowed_roles                  text[] not null default '{manager,authorizer,standard}',
  require_subtasks_complete      boolean not null default false,
  require_checklists_complete    boolean not null default false,
  created_at                     timestamptz not null default now(),
  unique (org_id, from_status_id, to_status_id)
);

create index on workflow_transitions (org_id);
create index on workflow_transitions (workflow_id);

-- Cross-entity automation — what else happens when a transition fires. Kept
-- as its own table (rather than a column on workflow_transitions) so a
-- single transition can carry any number of actions, run in `position`
-- order. Nothing here gates the move itself (that's still
-- allowed_roles/require_*_complete above); an action fires only after the
-- move already went through. v1 only wires these up for 'deal'-type
-- workflows acting on tasks (see updateDealStage in lib/actions.ts) — a
-- transition on a 'task' workflow can have actions rows too, but nothing
-- executes them yet. `config`'s shape depends on action_type (see the
-- TransitionActionConfig union in lib/types.ts for the exact fields):
--   create_task              — makes one new task, linked to the deal via
--                               tasks.deal_id below
--   transition_linked_tasks  — moves every task already linked to the deal
--                               into a target status (skipping any whose
--                               project runs a different task workflow than
--                               that status belongs to — see that function's
--                               own comment)
--   update_linked_tasks      — reassigns every task linked to the deal
create table workflow_transition_actions (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references orgs(id) on delete cascade,
  transition_id  uuid not null references workflow_transitions(id) on delete cascade,
  action_type    text not null check (action_type in ('create_task', 'transition_linked_tasks', 'update_linked_tasks')),
  config         jsonb not null default '{}',
  position       int not null default 0,
  created_at     timestamptz not null default now()
);

create index on workflow_transition_actions (org_id);
create index on workflow_transition_actions (transition_id);

-- ----------------------------------------------------------------------------
-- Projects, teams (buckets), tags, custom fields
-- ----------------------------------------------------------------------------

create table projects (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references orgs(id) on delete cascade,
  name               text not null,
  color              text not null default '#f97316',
  is_helpdesk        boolean not null default false,   -- excluded from Gantt, no dates required, close-gated on Block links
  enable_allocations boolean not null default false,    -- eligible for Asset Allocation tasks
  -- Task IDs — a short code the org sets per project (e.g. "P1"), used to
  -- build every task's display_id (tasks.display_id below) at the moment
  -- it's created: tag || lpad(task_number, 2, '0'), e.g. "P1" + 1 -> "P101".
  -- Nullable and editable like name/color (via updateProjectFields) — a
  -- project with no tag yet just doesn't hand out ids, and editing an
  -- existing tag only changes what *future* tasks in this project get
  -- (already-created tasks keep the id they were given — see
  -- tasks.display_id's own comment for why that's a snapshot, not a live
  -- join). Exactly 2 uppercase letters/digits, enforced by
  -- projects_tag_format below; uniqueness is case-insensitive and scoped
  -- to the org (projects_tag_upper_uq), so two projects in the same org
  -- can never hand out ambiguous ids.
  tag                text,
  -- The next sequential task number this project will hand out, advanced
  -- atomically by next_task_display_id() (see that function's own comment
  -- below) — lib/actions.ts's createTask() calls it via .rpc() rather than
  -- reading this column and writing it back itself, which would race under
  -- concurrent creates.
  next_task_number   integer not null default 1,
  archived_at        timestamptz,
  created_at         timestamptz not null default now(),
  -- Which workflow this project's task-kind rows use — a 'task'-type
  -- workflow when is_helpdesk is false, a 'helpdesk'-type one when it's
  -- true (the dropdown in Manage Projects only offers the matching type).
  -- Nullable only transiently during migration; every project gets one.
  workflow_id        uuid references workflows(id),
  -- Which 'asset'-type workflow this project's asset_allocation-kind rows
  -- use — only meaningful (and only shown in the UI) while
  -- enable_allocations is true; independent of workflow_id above since
  -- is_helpdesk and enable_allocations are independent booleans.
  asset_workflow_id  uuid references workflows(id)
);

create index on projects (org_id);

alter table projects add constraint projects_tag_format check (tag is null or tag ~ '^[A-Z0-9]{2}$');
create unique index projects_tag_upper_uq on projects (org_id, upper(tag)) where tag is not null;

-- Buckets/teams nested per-project (v0.6/v0.7 design): each project has its
-- own set; same-named teams across a tenant's projects are merged by name
-- only at the display layer for the "All projects" Buckets view.
create table teams (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  project_id  uuid not null references projects(id) on delete cascade,
  name        text not null,
  color       text not null default '#64748b',
  position    int not null default 0,
  created_at  timestamptz not null default now()
);

create index on teams (org_id);
create index on teams (project_id);

-- Team allocation — which org members belong to which team, gating who a
-- task on that team can be assigned to when orgs.team_allocation_enabled is
-- on (see that column's own comment). A team is a per-project row here (not
-- a per-team-name concept — see the comment above), so membership is too:
-- someone on two same-named teams in different projects needs a row for
-- each. Membership itself isn't org/admin-gated — any org member can manage
-- it, matching every other workspace-config table here (projects, teams,
-- custom fields, workflow) rather than the tighter owner/admin gate billing
-- and role-reassignment use.
create table team_members (
  team_id    uuid not null references teams(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  org_id     uuid not null references orgs(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

create index on team_members (org_id);
create index on team_members (user_id);

create table tags (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  name        text not null,
  color       text not null default '#64748b',
  created_at  timestamptz not null default now(),
  unique (org_id, name)
);

create table custom_field_defs (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  name        text not null,
  field_type  text not null check (field_type in ('text','paragraph','number','select','yes_no','date')),
  options     jsonb,                                    -- select-type choices, e.g. ["Low","Medium","High"]
  position    int not null default 0,
  created_at  timestamptz not null default now()
);

create index on custom_field_defs (org_id);


-- ----------------------------------------------------------------------------
-- External contacts (Portal / email / WhatsApp requesters — not Alloy users)
-- ----------------------------------------------------------------------------

create table contacts (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  name        text,
  email       text,
  phone       text,                -- E.164 format for WhatsApp, e.g. +14155551234
  created_at  timestamptz not null default now()
);

create index on contacts (org_id);
create unique index contacts_org_email_uq on contacts (org_id, lower(email)) where email is not null;
create unique index contacts_org_phone_uq on contacts (org_id, phone) where phone is not null;


-- ----------------------------------------------------------------------------
-- Assets
-- ----------------------------------------------------------------------------

create table assets (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references orgs(id) on delete cascade,
  name           text not null,
  icon           text not null default 'toolbox',   -- laptop | phone | toolbox | monitor | mouse | keyboard | boots | trousers | ...
  tag            text,                                -- serial/asset tag
  cost_rate      numeric(12,2),
  cost_frequency text check (cost_frequency in ('hour','day','week','month','year','one_off')),
  notes          text,
  retired        boolean not null default false,
  created_at     timestamptz not null default now()
  -- Note: Available/Allocated status is intentionally NOT stored here — it's
  -- derived at query time from whether a live (non-done) task with kind =
  -- 'asset_allocation' and this asset_id exists, matching the app's existing
  -- design (status flips back to Available the moment that task closes).
);

create index on assets (org_id);


-- ----------------------------------------------------------------------------
-- CRM — Companies & Deals (Phase A)
-- ----------------------------------------------------------------------------
-- Companies are the "account" side of the CRM expansion — contacts (above)
-- optionally belong to one, and deals (below) optionally do too. Kept
-- deliberately small for this first pass: name/domain/notes only, no
-- billing address or other fields nobody's asked for yet.
create table companies (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  name        text not null,
  domain      text,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index on companies (org_id);

-- A contact optionally belongs to one company — nullable, since a one-off
-- Portal/email/WhatsApp requester usually has no known company yet.
alter table contacts add column company_id uuid references companies(id) on delete set null;
create index on contacts (company_id) where company_id is not null;

-- A deal's "stage" is a workflow_status on a 'deal'-type workflow, exactly
-- the same pattern Helpdesk tickets and Asset Allocation tasks already use
-- (see the Workflow engine section above) — so the existing full-screen
-- workflow editor (rename/recolor/add/remove stages) works for deal
-- pipelines with zero new editor code. Win/loss is deliberately NOT a
-- separate stored boolean: a stage's own is_closed flag plus its stable key
-- ('won'/'lost', seeded below and never exposed to edit — same convention
-- as every other workflow's key) is enough to derive it, matching how the
-- rest of this app avoids storing a second source of truth alongside a
-- workflow status wherever it can (see e.g. the "is_closed instead of
-- status.key==='done'" fix in the multi-workflow overhaul).
create table deals (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references orgs(id) on delete cascade,
  title               text not null,
  company_id          uuid references companies(id) on delete set null,
  primary_contact_id  uuid references contacts(id) on delete set null,
  owner_user_id       uuid references users(id) on delete set null,
  workflow_id         uuid not null references workflows(id),
  status_id           uuid not null references workflow_statuses(id),
  value               numeric(14,2),
  currency            text not null default 'USD',
  expected_close_date date,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index on deals (org_id);
create index on deals (status_id);
create index on deals (company_id) where company_id is not null;
create index on deals (owner_user_id) where owner_user_id is not null;


-- ----------------------------------------------------------------------------
-- Tasks
-- ----------------------------------------------------------------------------

create table tasks (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references orgs(id) on delete cascade,
  project_id          uuid not null references projects(id) on delete cascade,
  team_id             uuid references teams(id) on delete set null,
  parent_task_id      uuid references tasks(id) on delete cascade,   -- subtasks
  kind                text not null default 'task' check (kind in ('task','asset_allocation')),
  asset_id            uuid references assets(id) on delete set null, -- set when kind = 'asset_allocation'
  title               text not null,
  description         text,
  status_id           uuid not null references workflow_statuses(id),
  assignee_id         uuid references users(id) on delete set null,
  is_milestone        boolean not null default false,
  start_date          date,
  due_date            date,

  -- Task IDs — assigned once, atomically, by next_task_display_id() at the
  -- moment createTask() inserts this row (see that function's comment, and
  -- projects.tag's own comment above). Never updated afterward by any app
  -- code or UI control — that's what makes it "un-editable": there's no
  -- enforcement trigger for this, matching how e.g. a workflow status's key
  -- is also just never exposed to edit rather than DB-locked (see that
  -- column's own comment) — consistent with this schema's existing style of
  -- app-level-only immutability where nothing else in the row depends on
  -- enforcing it harder. display_id is a snapshot of the project's tag at
  -- creation time, not a live join — changing the project's tag later never
  -- changes an existing task's id. Both are null for a task created before
  -- this feature existed, or created while its project had no tag set yet;
  -- neither is ever backfilled.
  task_number         integer,
  display_id          text,

  -- Ticket portal access — a per-ticket magic-link token letting a customer
  -- who raised this ticket (Portal, email, or WhatsApp) come back later with
  -- no account to see its status and add a public reply. See the standalone
  -- ticket_portal_access.sql patch's own header comment for the full
  -- rationale (why no expiry, why no RLS policy). Only ever set for a task
  -- with a contact_id — an internal, staff-created task has no customer to
  -- hand a link to, so this stays null for those.
  portal_access_token text unique,

  -- Multi-channel ticket intake
  channel             text not null default 'internal' check (channel in ('internal','portal','email','whatsapp')),
  external_thread_ref text,          -- email Message-ID chain, or WhatsApp conversation id — used to thread requester replies
  contact_id          uuid references contacts(id) on delete set null,  -- external requester, when channel != 'internal'

  -- CRM cross-entity link (workflow automation, see workflow_transition_actions
  -- above) — set for a task a deal-stage transition created, or points at a
  -- deal a person linked by hand from the task panel. Deleting the deal
  -- un-links its tasks rather than deleting them.
  deal_id             uuid references deals(id) on delete set null,

  created_by          uuid references users(id) on delete set null,     -- null if created by an external contact
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Manual Gantt ordering only — see task_position.sql's own header for the
  -- full rationale. Every other view (List, Buckets, Calendar) keeps its
  -- existing created_at-based sort and never reads this column.
  position            int not null default 0
);

create index on tasks (org_id);
create index on tasks (project_id);
create index on tasks (team_id);
create index on tasks (parent_task_id);
create index on tasks (status_id);
create index on tasks (asset_id) where asset_id is not null;
create index on tasks (contact_id) where contact_id is not null;
create index on tasks (deal_id) where deal_id is not null;

create table task_tags (
  task_id  uuid not null references tasks(id) on delete cascade,
  tag_id   uuid not null references tags(id) on delete cascade,
  primary key (task_id, tag_id)
);

create table custom_field_values (
  task_id      uuid not null references tasks(id) on delete cascade,
  field_def_id uuid not null references custom_field_defs(id) on delete cascade,
  value        jsonb not null,        -- shape depends on the field's field_type
  primary key (task_id, field_def_id)
);


-- ----------------------------------------------------------------------------
-- Task dependencies (typed links)
-- ----------------------------------------------------------------------------

create table task_links (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  from_task_id uuid not null references tasks(id) on delete cascade,
  to_task_id   uuid not null references tasks(id) on delete cascade,
  link_type    text not null check (link_type in ('blocked','blocks','concurrent','related','clone')),
  created_at   timestamptz not null default now(),
  unique (from_task_id, to_task_id, link_type),
  check (from_task_id <> to_task_id)
);

create index on task_links (org_id);
create index on task_links (from_task_id);
create index on task_links (to_task_id);

-- Note: the propagateSchedule cascade (block ordering, clone mirroring,
-- concurrent due-date sync) and the helpdesk link-type restriction
-- (Block/Related only on tickets, silently downgrading Concurrent/Clone)
-- are application logic, not constraints — enforce them in the API layer
-- that writes to this table, not in the database itself.
--
-- A "Block" relationship between two tasks is stored as a mirrored pair of
-- rows rather than one: {from: blocker, to: blocked, link_type: 'blocks'}
-- and {from: blocked, to: blocker, link_type: 'blocked'} — added and removed
-- together by addLink()/removeLink() in lib/actions.ts. This lets each
-- task's own Links section (which only ever reads rows where it is the
-- from_task_id) show its own correctly-labeled side of the relationship,
-- rather than the relationship only being visible from the blocked task's
-- panel. Scheduling code (blockerIds in lib/actions.ts, lib/gantt-schedule.ts)
-- reads only the 'blocked' row, which is the exact same row the old
-- single-sided 'block' convention used to store.


-- ----------------------------------------------------------------------------
-- Task panel objects: notes, files, sketches, checklists, forms
-- ----------------------------------------------------------------------------

create table task_objects (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  task_id     uuid not null references tasks(id) on delete cascade,
  kind        text not null check (kind in ('note','file','sketch','checklist','form','code')),
  position    int not null default 0,
  content     jsonb,               -- note text, sketch data, or small kind-specific payload
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index on task_objects (task_id);

-- One row per file/sketch task_object (the `unique` below is what makes
-- .upsert(..., {onConflict: "task_object_id"}) work for a sketch's repeated
-- re-saves — see saveSketchImage in lib/actions.ts). A "note" or "checklist"
-- object never gets a row here; a "sketch" object doesn't either until its
-- first stroke is saved.
create table task_object_files (
  id              uuid primary key default gen_random_uuid(),
  task_object_id  uuid not null references task_objects(id) on delete cascade unique,
  storage_path    text not null,     -- Supabase Storage object key
  filename        text not null,
  mime_type       text,
  size_bytes      bigint
);

create table checklist_items (
  id              uuid primary key default gen_random_uuid(),
  task_object_id  uuid not null references task_objects(id) on delete cascade,   -- parent object with kind = 'checklist'
  label           text not null,
  is_checked      boolean not null default false,
  position        int not null default 0
);

create index on checklist_items (task_object_id);


-- ----------------------------------------------------------------------------
-- Form templates & submissions (task attachment + Portal)
-- ----------------------------------------------------------------------------

create table form_templates (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references orgs(id) on delete cascade,
  name           text not null,
  fields         jsonb not null default '[]',   -- [{ id, label, type, options? }], type in text/paragraph/number/select/yes_no/date
  portal_visible boolean not null default false,
  created_at     timestamptz not null default now()
);

create index on form_templates (org_id);

create table task_object_forms (
  id                     uuid primary key default gen_random_uuid(),
  task_object_id         uuid not null references task_objects(id) on delete cascade,  -- parent object with kind = 'form'
  form_template_id       uuid not null references form_templates(id),
  values                 jsonb not null default '{}',   -- field id -> answer
  submitted_by_contact_id uuid references contacts(id) on delete set null,
  submitted_by_user_id   uuid references users(id) on delete set null,
  created_at             timestamptz not null default now()
);


-- ----------------------------------------------------------------------------
-- Knowledge base
-- ----------------------------------------------------------------------------

create table docs (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  title       text not null,
  body_html   text not null default '',
  published   boolean not null default false,   -- visible on the customer Portal
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index on docs (org_id);
create index on docs (org_id) where published;

create table task_docs (
  task_id  uuid not null references tasks(id) on delete cascade,
  doc_id   uuid not null references docs(id) on delete cascade,
  primary key (task_id, doc_id)
);


-- ----------------------------------------------------------------------------
-- Multi-channel ticket conversation (Portal / email / WhatsApp / internal)
-- ----------------------------------------------------------------------------

create table ticket_messages (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references orgs(id) on delete cascade,
  task_id             uuid not null references tasks(id) on delete cascade,
  direction           text not null check (direction in ('inbound','outbound')),
  channel             text not null check (channel in ('internal','portal','email','whatsapp')),
  author_contact_id   uuid references contacts(id) on delete set null,   -- set when direction = 'inbound' from an external contact
  author_user_id      uuid references users(id) on delete set null,      -- set when an internal agent wrote it
  body                text not null,
  external_message_ref text,     -- email Message-ID / WhatsApp message id — used for threading + inbound idempotency
  -- Helpdesk conversation upgrade (v0.15 parity): 'private' notes are
  -- internal-only (never sent to Postmark/Twilio, hidden by the task
  -- panel's "Preview as customer" toggle) — everything else defaults
  -- 'public', matching every row inserted before this column existed.
  visibility          text not null default 'public' check (visibility in ('public','private')),
  created_at          timestamptz not null default now()
);

create index on ticket_messages (task_id);
create index on ticket_messages (org_id);
create unique index ticket_messages_external_ref_uq
  on ticket_messages (channel, external_message_ref) where external_message_ref is not null;
  -- guards against a webhook redelivering the same inbound message twice

-- Files attached directly to a conversation message (staff reply, private
-- note, or a customer's own portal reply) — shown inline in the message
-- bubble itself rather than as a separate task attachment, so a customer
-- reading the Portal thread sees them right where they were shared. One
-- message can carry several files (unlike task_object_files, which is
-- capped at one file per task_object), hence its own table rather than
-- reusing that one. Storage-wise these live in the same task-attachments
-- bucket as everything else (see lib/storage.ts's ticketMessageAttachmentPath
-- and task_attachments_storage.sql's RLS policies, which only ever inspect
-- the org_id path segment, so no bucket/policy changes were needed).
create table ticket_message_attachments (
  id                 uuid primary key default gen_random_uuid(),
  ticket_message_id  uuid not null references ticket_messages(id) on delete cascade,
  storage_path       text not null,
  filename           text not null,
  mime_type          text,
  size_bytes         bigint
);

create index on ticket_message_attachments (ticket_message_id);


-- ----------------------------------------------------------------------------
-- Activity log (audit trail)
-- ----------------------------------------------------------------------------
-- Was previously on the Deliberately-deferred list below (valuable once
-- there are multiple users per org, add as an append-only activity_log
-- table) -- built once logActivity() in lib/actions.ts needed somewhere
-- real to write to. Scope matches the prototype logActivity() exactly:
-- only a task creation and a task status move are recorded, nothing else
-- (no field-edit history) -- see the ActivityType comment in lib/types.ts.
-- Nothing in the app ever issues an update or delete against this table;
-- it follows the same tenant-isolation RLS pattern as every other table
-- below rather than a stricter one, since enforcing append-only in the
-- database itself is not asked for here -- just noting the app intent.
create table activity_log (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references orgs(id) on delete cascade,
  task_id           uuid not null references tasks(id) on delete cascade,
  type              text not null check (type in ('created','status')),
  from_status_id    uuid references workflow_statuses(id) on delete set null,  -- only set when type = 'status'
  to_status_id      uuid references workflow_statuses(id) on delete set null,  -- only set when type = 'status'
  actor_user_id     uuid references users(id) on delete set null,     -- set for a signed-in member's own action
  actor_contact_id  uuid references contacts(id) on delete set null,  -- set instead for an anonymous Portal submission
  created_at        timestamptz not null default now()
);

create index on activity_log (task_id, created_at desc);
create index on activity_log (org_id, actor_user_id, created_at desc);
  -- serves the Dashboard's your-recent-activity feed (lib/activity-
  -- view.ts's recentActivityForUser) without a full-table scan


-- ----------------------------------------------------------------------------
-- updated_at trigger (apply to any table with an updated_at column)
-- ----------------------------------------------------------------------------

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger tasks_set_updated_at before update on tasks
  for each row execute function set_updated_at();

create trigger docs_set_updated_at before update on docs
  for each row execute function set_updated_at();

create trigger companies_set_updated_at before update on companies
  for each row execute function set_updated_at();

create trigger deals_set_updated_at before update on deals
  for each row execute function set_updated_at();


-- ----------------------------------------------------------------------------
-- Task ID assignment
-- ----------------------------------------------------------------------------
-- Atomically advances a project's next_task_number and computes the new
-- task's display_id in one UPDATE ... RETURNING — row-level locking on the
-- projects row is what makes this safe under concurrent createTask() calls
-- for the same project (two tasks created back-to-back can never be handed
-- the same number). No `security definer` needed: the UPDATE runs as the
-- calling user, same as any other write to projects, so it's already
-- covered by projects_tenant_isolation below — createTask() only ever calls
-- this after requireUser() has confirmed the caller is a member of the
-- task's own org.
create or replace function next_task_display_id(p_project_id uuid)
returns table(task_number integer, display_id text)
language plpgsql
as $$
declare
  v_tag    text;
  v_number integer;
begin
  update projects
  set next_task_number = next_task_number + 1
  where id = p_project_id
  returning tag, next_task_number - 1 into v_tag, v_number;

  if not found then
    raise exception 'No such project: %', p_project_id;
  end if;

  if v_tag is null then
    return query select v_number, null::text;
  else
    return query select v_number, v_tag || lpad(v_number::text, 2, '0');
  end if;
end;
$$;


-- ----------------------------------------------------------------------------
-- Row Level Security — every table
-- ----------------------------------------------------------------------------
-- The base pattern: a member can only see/write rows belonging to an org
-- they're a member of. Assumes the API sets the current user's id via
-- `auth.uid()` (Supabase) — adapt if using a different auth provider's
-- session mechanism.
--
-- All three helper functions below are `security definer`: each one's own
-- internal query touches org_members (directly, or via is_org_member), and
-- org_members itself has an RLS policy built on is_org_member. Without
-- `security definer`, evaluating is_org_member(...) while checking a row in
-- org_members would re-trigger org_members' own RLS policy, which calls
-- is_org_member(...) again, and so on — `security definer` makes these
-- functions bypass RLS on the tables *they* touch, which is what breaks that
-- recursion. (This wasn't an issue for the earlier projects/tasks-only
-- version of this section, since neither of those tables is the one
-- is_org_member itself queries.)

create or replace function is_org_member(target_org uuid)
returns boolean as $$
  select exists (
    select 1 from org_members
    where org_id = target_org and user_id = auth.uid()
  );
$$ language sql stable security definer set search_path = public;

create or replace function is_org_admin(target_org uuid)
returns boolean as $$
  select exists (
    select 1 from org_members
    where org_id = target_org and user_id = auth.uid() and role in ('owner','admin')
  );
$$ language sql stable security definer set search_path = public;

-- Used by the `users` table's own select policy: true if the given user
-- shares at least one org with the currently signed-in user (so assignee
-- names, the member list, etc. resolve for everyone in an org, not just
-- your own profile).
create or replace function shares_org_with(target_user uuid)
returns boolean as $$
  select exists (
    select 1 from org_members om1
    join org_members om2 on om1.org_id = om2.org_id
    where om1.user_id = auth.uid() and om2.user_id = target_user
  );
$$ language sql stable security definer set search_path = public;

-- orgs: rows need to be publicly readable by slug (no auth) for the
-- customer Portal (app/portal/[orgSlug]) to resolve app.tld/portal/<slug>
-- for a logged-out visitor — there's no org-membership check to make at
-- that point. This does mean every column, including the billing columns
-- (stripe_customer_id/stripe_subscription_id/stripe_price_id/
-- subscription_status/subscription_current_period_end — none of them
-- secrets on their own, but still not great to hand an anonymous visitor)
-- and custom_domain, is currently row-visible to anyone who can guess/
-- enumerate a slug; RLS is row-level, not column-level, so narrowing that
-- later means either a view exposing only the public columns or a
-- column-level grant, not a policy change here. Writes stay members-only
-- (admin/owner for settings) — orgs_admin_update is also what
-- lib/actions.ts's updateOrgDomain writes through; the billing columns are
-- the one exception, written only by app/api/webhooks/stripe/route.ts under
-- the service-role client (see that column block's own comment above), so
-- they're effectively read-only from the client's side of this policy.
-- Still deliberately no insert/delete policy — org creation goes through
-- lib/actions.ts's completeSignup, a service-role signup flow (see
-- app/signup and app/auth/callback) rather than a client-side insert, since
-- the very first insert for a brand-new org happens before anyone is a
-- member of it yet to satisfy any RLS check.
alter table orgs enable row level security;
create policy orgs_public_read on orgs for select using (true);
create policy orgs_admin_update on orgs for update using (is_org_admin(id)) with check (is_org_admin(id));

-- users: mirrors auth.users, not itself org-scoped. Visible to yourself and
-- anyone who shares an org with you (needed for assignee names / the member
-- list); editable only by yourself. No insert/delete policy — rows are
-- created by the handle_new_auth_user trigger (security definer, bypasses
-- RLS), never by the client directly.
alter table users enable row level security;
create policy users_visible_to_orgmates on users for select using (id = auth.uid() or shares_org_with(id));
create policy users_update_self on users for update using (id = auth.uid()) with check (id = auth.uid());

-- org_members: read-only to every member (the member/assignee list), but
-- role changes are gated to owner/admin now that the Manage workflow &
-- roles panel's updateMemberRole() exists — matches the app-layer check
-- there (which rejects a non-owner/admin caller before ever reaching this
-- policy, so a non-admin sees a clear error rather than a silent no-op
-- update). Still deliberately no insert/delete policy — both
-- completeSignup (a brand-new org's first, owner, member) and acceptInvite
-- (everyone after that) run under the service-role client instead, exactly
-- like submitPortalRequest's own write path, since the person being
-- inserted can't satisfy is_org_member() until this very row exists.
alter table org_members enable row level security;
create policy org_members_read on org_members for select using (is_org_member(org_id));
create policy org_members_role_update on org_members for update
  using (is_org_admin(org_id))
  with check (is_org_admin(org_id));

-- invites: owner/admin can list/create/revoke their own org's invites —
-- nobody else should see a pending invite's email address at all. Looking
-- an invite up by its token (the public /invite/<token> landing page, hit
-- by someone who isn't a member yet) and inserting the resulting
-- org_members row both go through getInviteByToken/acceptInvite's
-- service-role path instead — safe specifically because a token is an
-- unguessable 24-byte random value, the same trust model a password-reset
-- link uses, not because the row itself is meant to be widely readable.
alter table invites enable row level security;
create policy invites_admin_manage on invites
  using (is_org_admin(org_id))
  with check (is_org_admin(org_id));

alter table projects enable row level security;
create policy projects_tenant_isolation on projects
  using (is_org_member(org_id))
  with check (is_org_member(org_id));

alter table teams enable row level security;
create policy teams_tenant_isolation on teams
  using (is_org_member(org_id))
  with check (is_org_member(org_id));

alter table team_members enable row level security;
create policy team_members_tenant_isolation on team_members
  using (is_org_member(org_id))
  with check (is_org_member(org_id));

alter table tags enable row level security;
create policy tags_tenant_isolation on tags
  using (is_org_member(org_id))
  with check (is_org_member(org_id));

alter table custom_field_defs enable row level security;
create policy custom_field_defs_tenant_isolation on custom_field_defs
  using (is_org_member(org_id))
  with check (is_org_member(org_id));

alter table workflows enable row level security;
create policy workflows_tenant_isolation on workflows
  using (is_org_member(org_id))
  with check (is_org_member(org_id));

alter table workflow_statuses enable row level security;
create policy workflow_statuses_tenant_isolation on workflow_statuses
  using (is_org_member(org_id))
  with check (is_org_member(org_id));

alter table workflow_transitions enable row level security;
create policy workflow_transitions_tenant_isolation on workflow_transitions
  using (is_org_member(org_id))
  with check (is_org_member(org_id));

alter table workflow_transition_actions enable row level security;
create policy workflow_transition_actions_tenant_isolation on workflow_transition_actions
  using (is_org_member(org_id))
  with check (is_org_member(org_id));

alter table contacts enable row level security;
create policy contacts_tenant_isolation on contacts
  using (is_org_member(org_id))
  with check (is_org_member(org_id));

alter table assets enable row level security;
create policy assets_tenant_isolation on assets
  using (is_org_member(org_id))
  with check (is_org_member(org_id));

alter table companies enable row level security;
create policy companies_tenant_isolation on companies
  using (is_org_member(org_id))
  with check (is_org_member(org_id));

alter table deals enable row level security;
create policy deals_tenant_isolation on deals
  using (is_org_member(org_id))
  with check (is_org_member(org_id));

alter table tasks enable row level security;
create policy tasks_tenant_isolation on tasks
  using (is_org_member(org_id))
  with check (is_org_member(org_id));

alter table task_links enable row level security;
create policy task_links_tenant_isolation on task_links
  using (is_org_member(org_id))
  with check (is_org_member(org_id));

alter table task_objects enable row level security;
create policy task_objects_tenant_isolation on task_objects
  using (is_org_member(org_id))
  with check (is_org_member(org_id));

alter table form_templates enable row level security;
create policy form_templates_tenant_isolation on form_templates
  using (is_org_member(org_id))
  with check (is_org_member(org_id));
-- Anonymous Portal visitors need to see (and pick) a portal-visible
-- template to fill in — same OR'd-permissive-select pattern as docs below.
-- Writes stay members-only via the tenant-isolation policy above.
create policy form_templates_public_read on form_templates for select using (portal_visible);

alter table ticket_messages enable row level security;
create policy ticket_messages_tenant_isolation on ticket_messages
  using (is_org_member(org_id))
  with check (is_org_member(org_id));
-- Portal/email/WhatsApp inbound messages come from a contact, not a signed-
-- in org member — once those channel adapters are more than stubs, they'll
-- need their own write path (most likely a service-role server action
-- rather than a client-side insert policy, so an unauthenticated webhook
-- can still write without becoming a standing RLS carve-out).

alter table ticket_message_attachments enable row level security;
create policy ticket_message_attachments_tenant_isolation on ticket_message_attachments
  using (exists (select 1 from ticket_messages tm where tm.id = ticket_message_attachments.ticket_message_id and is_org_member(tm.org_id)))
  with check (exists (select 1 from ticket_messages tm where tm.id = ticket_message_attachments.ticket_message_id and is_org_member(tm.org_id)));
-- Same caveat as ticket_messages above: a Portal visitor attaching a file to
-- their own reply isn't an org member, so that write path is service-role
-- (see attachPortalTicketMessageFile in lib/actions.ts), same as
-- addPortalTicketReply's own message insert.

alter table activity_log enable row level security;
create policy activity_log_tenant_isolation on activity_log
  using (is_org_member(org_id))
  with check (is_org_member(org_id));
-- submitPortalRequest's own activity_log insert (an anonymous Portal
-- submission) runs under the service-role client, which bypasses RLS
-- entirely — same as its writes to tasks/task_objects/contacts above — so
-- this member-only policy never blocks it.

-- docs: members get full access; anyone (including a logged-out Portal
-- visitor) can read a *published* doc, matching the `published` column's
-- purpose. Two permissive select policies on the same table are OR'd
-- together by Postgres, so this adds public read without loosening writes.
alter table docs enable row level security;
create policy docs_tenant_isolation on docs
  using (is_org_member(org_id))
  with check (is_org_member(org_id));
create policy docs_public_read on docs for select using (published);

-- Join/detail tables below have no org_id column of their own — tenancy is
-- inherited through whichever parent row (tasks or task_objects) they
-- belong to, so the policy checks that parent's org_id via a join instead.

alter table task_tags enable row level security;
create policy task_tags_tenant_isolation on task_tags
  using (exists (select 1 from tasks t where t.id = task_tags.task_id and is_org_member(t.org_id)))
  with check (exists (select 1 from tasks t where t.id = task_tags.task_id and is_org_member(t.org_id)));

alter table custom_field_values enable row level security;
create policy custom_field_values_tenant_isolation on custom_field_values
  using (exists (select 1 from tasks t where t.id = custom_field_values.task_id and is_org_member(t.org_id)))
  with check (exists (select 1 from tasks t where t.id = custom_field_values.task_id and is_org_member(t.org_id)));

alter table task_docs enable row level security;
create policy task_docs_tenant_isolation on task_docs
  using (exists (select 1 from tasks t where t.id = task_docs.task_id and is_org_member(t.org_id)))
  with check (exists (select 1 from tasks t where t.id = task_docs.task_id and is_org_member(t.org_id)));

alter table task_object_files enable row level security;
create policy task_object_files_tenant_isolation on task_object_files
  using (exists (select 1 from task_objects o where o.id = task_object_files.task_object_id and is_org_member(o.org_id)))
  with check (exists (select 1 from task_objects o where o.id = task_object_files.task_object_id and is_org_member(o.org_id)));

alter table checklist_items enable row level security;
create policy checklist_items_tenant_isolation on checklist_items
  using (exists (select 1 from task_objects o where o.id = checklist_items.task_object_id and is_org_member(o.org_id)))
  with check (exists (select 1 from task_objects o where o.id = checklist_items.task_object_id and is_org_member(o.org_id)));

alter table task_object_forms enable row level security;
create policy task_object_forms_tenant_isolation on task_object_forms
  using (exists (select 1 from task_objects o where o.id = task_object_forms.task_object_id and is_org_member(o.org_id)))
  with check (exists (select 1 from task_objects o where o.id = task_object_forms.task_object_id and is_org_member(o.org_id)));
-- Same caveat as ticket_messages: a Portal visitor submitting a form isn't
-- an org member, so anonymous submission will need its own write path
-- (service-role action) once that's built — this locks it to members only
-- for now.


-- ----------------------------------------------------------------------------
-- Storage: task-attachments bucket (file/sketch task_objects)
-- ----------------------------------------------------------------------------
-- Private (public=false), not a public bucket — a leaked URL to a public
-- bucket would expose another org's files forever, so every read goes
-- through a short-lived signed URL generated server-side (see
-- getWorkspaceData in lib/tasks-data.ts) instead. Object keys are laid out
-- as org_id/task_id/task_object_id/<filename> (see taskAttachmentPath in
-- lib/storage.ts) specifically so these policies can pull the org_id back
-- out of the path with (storage.foldername(name))[1] and reuse the exact
-- same is_org_member() check every table-level policy above already uses —
-- there's no separate org membership table for Storage to consult.

insert into storage.buckets (id, name, public)
values ('task-attachments', 'task-attachments', false)
on conflict (id) do nothing;

create policy task_attachments_select on storage.objects for select
  using (bucket_id = 'task-attachments' and is_org_member((storage.foldername(name))[1]::uuid));

create policy task_attachments_insert on storage.objects for insert
  with check (bucket_id = 'task-attachments' and is_org_member((storage.foldername(name))[1]::uuid));

-- Covers both a genuine re-upload (createFileTaskObject re-running after a
-- partial failure) and the sketch pad's own repeated {upsert:true} saves to
-- its fixed "sketch.png" key.
create policy task_attachments_update on storage.objects for update
  using (bucket_id = 'task-attachments' and is_org_member((storage.foldername(name))[1]::uuid))
  with check (bucket_id = 'task-attachments' and is_org_member((storage.foldername(name))[1]::uuid));

create policy task_attachments_delete on storage.objects for delete
  using (bucket_id = 'task-attachments' and is_org_member((storage.foldername(name))[1]::uuid));


-- ----------------------------------------------------------------------------
-- Deliberately deferred to a later pass
-- ----------------------------------------------------------------------------
-- - Notification preferences / delivery log for outbound email & WhatsApp.
-- - Billing/plan/entitlement tables — likely thin, referencing Stripe's own
--   objects via orgs.stripe_customer_id rather than mirroring Stripe state.
