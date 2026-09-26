-- ============================================================================
-- Alloy — CRM Phase C patch (Contacts as a first-class tab)
-- ============================================================================
-- Run this once against your EXISTING database (Studio -> SQL editor).
-- Safe to run more than once — every statement below uses if not exists/if
-- exists guards.
--
-- Adds:
--   contacts.notes       - freeform notes, same shape as companies.notes.
--   contacts.updated_at  - kept current by the existing generic
--                          set_updated_at() trigger function (already
--                          created by an earlier patch/schema.sql — this
--                          file does not redefine it).
--
-- Contacts themselves aren't new — this table has existed since the
-- multi-channel ticket-intake work and gained a company_id link in CRM
-- Phase A — but until now there was no standalone Contacts view/panel, only
-- a company-scoped picker inside CompanyPanel/DealPanel. See
-- components/contacts-view.tsx and components/contact-panel.tsx for the new
-- UI this patch's columns back.
--
-- To re-run this file from scratch: there's nothing here to drop that isn't
-- already covered by dropping the whole contacts table (not offered here,
-- since contacts predate this patch and may already hold real data).
-- ============================================================================

alter table contacts add column if not exists notes text;
alter table contacts add column if not exists updated_at timestamptz not null default now();

drop trigger if exists contacts_set_updated_at on contacts;
create trigger contacts_set_updated_at before update on contacts
  for each row execute function set_updated_at();
