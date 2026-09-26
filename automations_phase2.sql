-- ============================================================================
-- Alloy — Automations Phase 2 patch
-- ============================================================================
-- Run this once against your EXISTING database (Studio -> SQL editor).
-- Safe to run more than once — every statement below uses if not exists/if
-- exists guards or is naturally idempotent.
--
-- Adds:
--   workflow_transitions.automations_enabled — a per-transition switch for
--     the Automations editor, off by default. Backfilled to true below for
--     any transition that already has actions configured, so existing deal
--     automations keep firing without the org having to re-enable them by
--     hand.
--   workflow_transition_actions.action_type  — widens the check constraint
--     to allow the new 'update_linked_deal' action.
--   deals.currency                           — default changed from USD to
--     GBP (only affects deals created from now on; existing rows are
--     untouched).
--
-- See lib/actions.ts's runTransitionActions() (renamed/generalized from
-- runDealStageActions) and components/workflow-panel.tsx's
-- TransitionAutomations editor for the app-side half of this.
--
-- To re-run this file from scratch: there's nothing here to drop that isn't
-- already covered by the columns/constraint below being idempotent.
-- ============================================================================

alter table workflow_transitions add column if not exists automations_enabled boolean not null default false;

update workflow_transitions
set automations_enabled = true
where automations_enabled = false
  and id in (select distinct transition_id from workflow_transition_actions);

alter table workflow_transition_actions drop constraint if exists workflow_transition_actions_action_type_check;
alter table workflow_transition_actions add constraint workflow_transition_actions_action_type_check
  check (action_type in ('create_task', 'transition_linked_tasks', 'update_linked_tasks', 'update_linked_deal'));

alter table deals alter column currency set default 'GBP';
