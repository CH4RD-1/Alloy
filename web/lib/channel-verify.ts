import crypto from "crypto";

// ============================================================================
// Provider-specific parsing/verification for the two channel adapters under
// app/api/webhooks/. Deliberately kept separate from lib/actions.ts's
// intakeTicket()/sendChannelReply() — those two are channel-agnostic (the
// roadmap doc's "one internal ticket-intake path" design principle), while
// everything here is Postmark- or Twilio-specific and has no business
// touching the database directly.
// ============================================================================

// ----------------------------------------------------------------------------
// Email (Postmark) — mailbox-hash routing
// ----------------------------------------------------------------------------
// Every ticket email address this app hands out is <anything>+<hash>@
// EMAIL_INBOUND_DOMAIN. Postmark's inbound webhook splits the +tag off into
// its own "MailboxHash" field for you (most inbound-parse providers do the
// same under a different field name), so the routes never parse a raw email
// address themselves — just this one field. Two hash shapes:
//   - "org-<slug>"  — a brand new ticket, sent to the org's own public
//     support address, e.g. support+org-acme@tickets.yourapp.com (the
//     address you'd publish/link from the Portal or a signature).
//   - "task-<uuid>" — a reply. This app puts this exact address in the
//     Reply-To header of every outbound message it sends (see
//     replyToAddressForTask below and sendChannelReply in lib/actions.ts),
//     so when the contact hits "reply" in their own mail client, their
//     message comes back addressed to the one task it belongs to — no
//     References/In-Reply-To header parsing required to thread it.
export type MailboxHashTarget = { kind: "org"; orgSlug: string } | { kind: "task"; taskId: string };

export function parseMailboxHash(hash: string | null | undefined): MailboxHashTarget | null {
  if (!hash) return null;
  if (hash.startsWith("org-")) {
    const orgSlug = hash.slice(4);
    return orgSlug ? { kind: "org", orgSlug } : null;
  }
  if (hash.startsWith("task-")) {
    const taskId = hash.slice(5);
    return taskId ? { kind: "task", taskId } : null;
  }
  return null;
}

export function replyToAddressForOrg(orgSlug: string): string {
  return `support+org-${orgSlug}@${process.env.EMAIL_INBOUND_DOMAIN}`;
}

export function replyToAddressForTask(taskId: string): string {
  return `support+task-${taskId}@${process.env.EMAIL_INBOUND_DOMAIN}`;
}

// ----------------------------------------------------------------------------
// WhatsApp (Twilio) — inbound webhook signature verification
// ----------------------------------------------------------------------------
// Twilio's own algorithm (see "Validating signatures" in their webhook
// security docs): take the full request URL exactly as Twilio called it,
// append every POST parameter's key immediately followed by its value —
// sorted by key, no separators — HMAC-SHA1 the result with your Auth Token,
// base64-encode it, and compare to the X-Twilio-Signature header. There's no
// SDK dependency needed for this — it's one HMAC call via Node's built-in
// crypto module.
export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | null
): boolean {
  if (!signature) return false;
  const sortedKeys = Object.keys(params).sort();
  const data = sortedKeys.reduce((acc, key) => acc + key + params[key], url);
  const expected = crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");

  const expectedBuf = Buffer.from(expected);
  const gotBuf = Buffer.from(signature);
  // timingSafeEqual throws on a length mismatch rather than returning
  // false, so check that first — a length mismatch is never a match anyway.
  if (expectedBuf.length !== gotBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, gotBuf);
}
