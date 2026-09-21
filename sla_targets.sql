-- ============================================================================
-- Alloy — Helpdesk SLA targets patch
-- ============================================================================
-- Run this once against your EXISTING local database (Studio -> SQL editor).
--
-- Adds:
--   orgs.sla_first_response_hours - default 24. *Working* hours (Mon-Fri
--                                    09:00-17:00 UTC — see lib/sla.ts's
--                                    addBusinessHours for the disclosed
--                                    fixed-UTC simplification, pending a
--                                    real per-org timezone setting). The
--                                    task panel's countdown treats this as
--                                    met by the first public outbound
--                                    ticket_messages row on a ticket.
--   orgs.sla_resolution_days      - default 14. Plain calendar days. Met the
--                                    first time a ticket reaches the 'done'
--                                    workflow status (via activity_log, so a
--                                    later reopen doesn't erase how it was
--                                    met).
--
-- One global pair per org (not per-project) — set from the new "SLA
-- settings" sidebar item (components/sla-settings-panel.tsx), written by
-- updateOrgSlaTargets() in lib/actions.ts. Every existing org gets the
-- defaults below until someone changes them.
--
-- Safe to run more than once except the alter table / add constraint lines
-- — if you ever need to re-run this file:
-- alter table orgs drop constraint if exists orgs_sla_first_response_hours_positive;
-- alter table orgs drop constraint if exists orgs_sla_resolution_days_positive;
-- alter table orgs drop column if exists sla_first_response_hours;
-- alter table orgs drop column if exists sla_resolution_days;
-- ============================================================================

alter table orgs add column if not exists sla_first_response_hours integer not null default 24;
alter table orgs add column if not exists sla_resolution_days integer not null default 14;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orgs_sla_first_response_hours_positive') then
    alter table orgs add constraint orgs_sla_first_response_hours_positive check (sla_first_response_hours > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orgs_sla_resolution_days_positive') then
    alter table orgs add constraint orgs_sla_resolution_days_positive check (sla_resolution_days > 0);
  end if;
end $$;
