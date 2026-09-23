-- Adds file attachments to conversation messages (a staff reply/note, or a
-- customer's own portal reply) — shown inline in the message bubble, not
-- as a separate task attachment. See ticket_message_attachments' own
-- comment in schema.sql for the full rationale. Idempotent: safe to run
-- again against a database that already has this table.
create table if not exists ticket_message_attachments (
  id                 uuid primary key default gen_random_uuid(),
  ticket_message_id  uuid not null references ticket_messages(id) on delete cascade,
  storage_path       text not null,
  filename           text not null,
  mime_type          text,
  size_bytes         bigint
);

create index if not exists ticket_message_attachments_ticket_message_id_idx
  on ticket_message_attachments (ticket_message_id);

alter table ticket_message_attachments enable row level security;

drop policy if exists ticket_message_attachments_tenant_isolation on ticket_message_attachments;
create policy ticket_message_attachments_tenant_isolation on ticket_message_attachments
  using (exists (select 1 from ticket_messages tm where tm.id = ticket_message_attachments.ticket_message_id and is_org_member(tm.org_id)))
  with check (exists (select 1 from ticket_messages tm where tm.id = ticket_message_attachments.ticket_message_id and is_org_member(tm.org_id)));

-- No Storage bucket or policy changes needed — attachments reuse the
-- existing task-attachments bucket, whose RLS policies only ever inspect
-- the org_id path segment (see task_attachments_storage.sql), which the
-- new ticketMessageAttachmentPath() key shape (lib/storage.ts) still
-- provides as its first segment.
