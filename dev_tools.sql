-- Developer tools — standalone migration for an already-deployed database.
-- Same idempotent pattern as every other patch in this repo (safe to re-run).
-- See schema.sql's own comments on users.is_dummy and orgs.dev_tools for
-- the full rationale: a master "Developer mode" switch plus three
-- independently-switchable sub-tools (User switch / Dummy users / Export &
-- import templates), and a way to create real-but-unable-to-log-in "dummy"
-- users for the User switch to preview the app as.

alter table users add column if not exists is_dummy boolean not null default false;

alter table orgs add column if not exists dev_tools jsonb not null default
  '{"enabled":false,"userSwitch":false,"dummyUsers":false,"templates":false}'::jsonb;
