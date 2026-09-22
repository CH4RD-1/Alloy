-- Code-block task attachments
-- ----------------------------------------------------------------------------
-- Adds "code" as a valid task_objects.kind, alongside note/file/sketch/
-- checklist/form — a syntax-highlighted code block in the task panel's
-- Attachments section (components/task-objects.tsx's CodeCard), stored the
-- same lightweight way "note" already is: no new table, just this row's own
-- `content` jsonb ({ code, language }) — see lib/types.ts's TaskObject
-- comment. Nothing to backfill; existing rows are untouched, this only
-- widens what future inserts are allowed to be.
--
-- Safe to run more than once.

alter table task_objects drop constraint if exists task_objects_kind_check;
alter table task_objects add constraint task_objects_kind_check
  check (kind in ('note','file','sketch','checklist','form','code'));
