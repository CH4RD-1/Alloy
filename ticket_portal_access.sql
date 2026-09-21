-- Ticket portal access tokens
-- ----------------------------------------------------------------------------
-- Lets a customer who raised a ticket via the Portal or email/WhatsApp come
-- back later — no account, no password — to see its status and add a public
-- reply, via a per-ticket magic link: yourapp.com/portal/ticket/<token>.
-- See lib/actions.ts's submitPortalRequest/intakeTicket for where the token
-- is issued, and getPortalTicketByToken/addPortalTicketReply for the public
-- read/reply path — both run under the service-role client, the same
-- pattern invites.token's own lookup (getInviteByToken) already uses, so
-- this column intentionally has no RLS policy of its own: nothing ever
-- queries it through the RLS-bound client.
--
-- Long-lived on purpose (no expiry, unlike invites.token) — a ticket can
-- stay open for weeks, and the whole point is "bookmark this and check
-- back later," so it shouldn't go stale while the ticket itself is still
-- open. Treat a leaked link as exposing that one ticket's conversation,
-- same as a leaked invite link exposes just that one invite.
--
-- Safe to run more than once.

alter table tasks add column if not exists portal_access_token text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tasks_portal_access_token_uq'
  ) then
    alter table tasks add constraint tasks_portal_access_token_uq unique (portal_access_token);
  end if;
end $$;

-- Backfill: give every existing contact-linked ticket a token too, not just
-- ones created after this migration lands.
update tasks
set portal_access_token = encode(gen_random_bytes(24), 'hex')
where portal_access_token is null
  and contact_id is not null;
