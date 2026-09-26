-- ============================================================================
-- Alloy — Workflow automation patch (transition actions + deal↔task link)
-- ============================================================================
-- Run this once against your EXISTING database (Studio -> SQL editor).
-- Safe to run more than once — every statement below uses if not exists/if
-- exists guards, and there's no backfill loop this time (a transition has
-- zero actions until someone adds one in the Workflow & roles editor).
--
-- Adds:
--   workflow_transition_actions - what else happens when a transition
--                                  fires, e.g. a deal moving stage. One row
--                                  per action, run in `position` order; a
--                                  transition can have any number (or zero).
--                                  action_type is one of:
--                                    create_task              - makes a new
--                                                                task, linked
--                                                                to the deal
--                                    transition_linked_tasks   - moves every
--                                                                task already
--                                                                linked to the
--                                                                deal into a
--                                                                target status
--                                    update_linked_tasks       - reassigns
--                                                                every task
--                                                                linked to the
--                                                                deal
--                                  `config`'s shape depends on action_type —
--                                  see the TransitionActionConfig union in
--                                  lib/types.ts for the exact fields each one
--                                  takes.
--   tasks.deal_id                - nullable FK, set on a task a deal's stage
--                                  transition created (or one linked by hand
--                                  later) so "linked tasks" above has
--                                  something to query.
--
-- v1 only wires these actions up for 'deal'-type workflows acting on tasks
-- (see updateDealStage in lib/actions.ts) — nothing gates the deal move
-- itself (still ungated, same as Buckets' own drag), and nothing here yet
-- lets a *task* transition affect a deal the other way. Both are places to
-- extend this same mechanism later rather than a redesign.
--
-- To re-run this file from scratch:
--   alter table tasks drop column if exists deal_id;
--   drop table if exists workflow_transition_actions;
-- ============================================================================

alter table tasks add column if not exists deal_id uuid references deals(id) on delete set null;
create index if not exists tasks_deal_id_idx on tasks(deal_id) where deal_id is not null;

create table if not exists workflow_transition_actions (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references orgs(id) on delete cascade,
  transition_id  uuid not null references workflow_transitions(id) on delete cascade,
  action_type    text not null check (action_type in ('create_task', 'transition_linked_tasks', 'update_linked_tasks')),
  config         jsonb not null default '{}',
  position       int not null default 0,
  created_at     timestamptz not null default now()
);

create index if not exists workflow_transition_actions_org_id_idx on workflow_transition_actions(org_id);
create index if not exists workflow_transition_actions_transition_id_idx on workflow_transition_actions(transition_id);

-- RLS — same org-isolation pattern as every other table.
alter table workflow_transition_actions enable row level security;
drop policy if exists workflow_transition_actions_tenant_isolation on workflow_transition_actions;
create policy workflow_transition_actions_tenant_isolation on workflow_transition_actions
  using (is_org_member(org_id))
  with check (is_org_member(org_id));
