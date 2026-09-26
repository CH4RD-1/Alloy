-- ============================================================================
-- Alloy — Deal activity log patch
-- ============================================================================
-- Run this once against your EXISTING database (Studio -> SQL editor).
-- Safe to run more than once — every statement below uses if not exists/if
-- exists guards, and there's no backfill loop (a deal has no activity until
-- the next time it's created or moved after this patch runs — its history
-- before that point is simply not recorded, matching how activity_log itself
-- was introduced with no backfill for pre-existing tasks).
--
-- Adds:
--   deal_activity_log - append-only audit trail for deals, same shape as
--                        the existing activity_log table (tasks) but scoped
--                        to deals: only a deal's creation ('created') and
--                        its stage moves ('stage', with from/to status) are
--                        recorded — no field-edit history, and no
--                        actor_contact_id column, since a deal has no
--                        anonymous-Portal-submission path the way a task
--                        does. See lib/actions.ts's logDealActivity() for
--                        the write side and DealPanel for where it's read.
--
-- To re-run this file from scratch:
--   drop table if exists deal_activity_log;
-- ============================================================================

create table if not exists deal_activity_log (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references orgs(id) on delete cascade,
  deal_id           uuid not null references deals(id) on delete cascade,
  type              text not null check (type in ('created','stage')),
  from_status_id    uuid references workflow_statuses(id) on delete set null,
  to_status_id      uuid references workflow_statuses(id) on delete set null,
  actor_user_id     uuid references users(id) on delete set null,
  created_at        timestamptz not null default now()
);

create index if not exists deal_activity_log_deal_id_idx on deal_activity_log(deal_id, created_at desc);

-- RLS — same org-isolation pattern as every other table.
alter table deal_activity_log enable row level security;
drop policy if exists deal_activity_log_tenant_isolation on deal_activity_log;
create policy deal_activity_log_tenant_isolation on deal_activity_log
  using (is_org_member(org_id))
  with check (is_org_member(org_id));
