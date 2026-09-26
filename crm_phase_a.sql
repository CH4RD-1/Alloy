-- ============================================================================
-- Alloy — CRM Phase A patch (Companies & Deals)
-- ============================================================================
-- Run this once against your EXISTING database (Studio -> SQL editor).
-- Safe to run more than once for every statement below except the workflow
-- backfill at the bottom, which intentionally guards itself (see its own
-- comment) so re-running this file doesn't hand every org a second "Deal
-- Pipeline" workflow.
--
-- Adds:
--   companies              - the CRM "account" entity. name/domain/notes.
--   contacts.company_id    - nullable FK, a contact optionally belongs to
--                             one company.
--   deals                  - title, company/contact/owner, workflow_id +
--                             status_id (a deal's "stage" — same pattern as
--                             Helpdesk tickets and Asset Allocation, so the
--                             existing workflow editor just works for deal
--                             pipelines), value/currency, expected_close_date.
--   workflows.type          - check constraint widened to allow 'deal'.
--
-- Win/loss is deliberately NOT a stored column on deals — see deals' own
-- comment below on deriving it from the stage's is_closed flag + stable key
-- instead, matching how this app already avoids a second source of truth
-- alongside a workflow status everywhere else.
--
-- To re-run this file from scratch:
--   drop table if exists deals;
--   alter table contacts drop column if exists company_id;
--   drop table if exists companies;
--   alter table workflows drop constraint if exists workflows_type_check;
--   alter table workflows add constraint workflows_type_check
--     check (type in ('task','helpdesk','asset','deal'));
-- (then delete every "Deal Pipeline" workflow the backfill below created,
-- if you want a clean re-seed rather than picking up the existing ones)
-- ============================================================================

alter table workflows drop constraint if exists workflows_type_check;
alter table workflows add constraint workflows_type_check
  check (type in ('task', 'helpdesk', 'asset', 'deal'));

create table if not exists companies (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  name        text not null,
  domain      text,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists companies_org_id_idx on companies(org_id);

alter table contacts add column if not exists company_id uuid references companies(id) on delete set null;
create index if not exists contacts_company_id_idx on contacts(company_id) where company_id is not null;

create table if not exists deals (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references orgs(id) on delete cascade,
  title               text not null,
  company_id          uuid references companies(id) on delete set null,
  primary_contact_id  uuid references contacts(id) on delete set null,
  owner_user_id       uuid references users(id) on delete set null,
  workflow_id         uuid not null references workflows(id),
  status_id           uuid not null references workflow_statuses(id),
  value               numeric(14, 2),
  currency            text not null default 'USD',
  expected_close_date date,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists deals_org_id_idx on deals(org_id);
create index if not exists deals_status_id_idx on deals(status_id);
create index if not exists deals_company_id_idx on deals(company_id) where company_id is not null;
create index if not exists deals_owner_user_id_idx on deals(owner_user_id) where owner_user_id is not null;

-- updated_at triggers — reuses the set_updated_at() function schema.sql
-- already defines for tasks/docs.
drop trigger if exists companies_set_updated_at on companies;
create trigger companies_set_updated_at before update on companies
  for each row execute function set_updated_at();

drop trigger if exists deals_set_updated_at on deals;
create trigger deals_set_updated_at before update on deals
  for each row execute function set_updated_at();

-- RLS — same org-isolation pattern as every other table.
alter table companies enable row level security;
drop policy if exists companies_tenant_isolation on companies;
create policy companies_tenant_isolation on companies
  using (is_org_member(org_id))
  with check (is_org_member(org_id));

alter table deals enable row level security;
drop policy if exists deals_tenant_isolation on deals;
create policy deals_tenant_isolation on deals
  using (is_org_member(org_id))
  with check (is_org_member(org_id));

-- ----------------------------------------------------------------------------
-- Backfill: seed a "Deal Pipeline" workflow for every existing org that
-- doesn't already have one, so deals have somewhere valid to land the
-- moment the UI ships. Guarded per-org (not just per-file) so re-running
-- this patch, or running it after a signup already created one some other
-- way, never hands an org a duplicate pipeline.
-- ----------------------------------------------------------------------------
do $$
declare
  r record;
  wf_id uuid;
begin
  for r in select id from orgs loop
    if not exists (select 1 from workflows where org_id = r.id and type = 'deal') then
      insert into workflows (org_id, name, type)
      values (r.id, 'Deal Pipeline', 'deal')
      returning id into wf_id;

      insert into workflow_statuses (org_id, workflow_id, key, label, color, is_closed, position)
      values
        (r.id, wf_id, 'lead',        'Lead',        '#94a3b8', false, 0),
        (r.id, wf_id, 'qualified',   'Qualified',   '#60a5fa', false, 1),
        (r.id, wf_id, 'proposal',    'Proposal',    '#f59e0b', false, 2),
        (r.id, wf_id, 'negotiation', 'Negotiation', '#fb923c', false, 3),
        (r.id, wf_id, 'won',         'Won',         '#22c55e', true,  4),
        (r.id, wf_id, 'lost',        'Lost',        '#ef4444', true,  5);
    end if;
  end loop;
end $$;
