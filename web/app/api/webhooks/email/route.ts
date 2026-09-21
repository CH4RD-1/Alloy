import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { intakeTicket } from "@/lib/actions";
import { parseMailboxHash } from "@/lib/channel-verify";

// Inbound email webhook — targets Postmark's Inbound Webhook specifically
// (Server settings > Inbound Webhook, or the equivalent inbound stream).
// Point it at:
//   https://yourapp.tld/api/webhooks/email?secret=<POSTMARK_INBOUND_SECRET>
// Postmark doesn't sign its webhook payloads the way Twilio does (see the
// WhatsApp route), so a secret embedded in the URL itself is the standard
// way to confirm a request actually came from Postmark and not just anyone
// who finds this endpoint. If you use Mailgun Routes or SendGrid Inbound
// Parse instead, the payload shape below (MailboxHash, TextBody, FromFull,
// MessageID) is Postmark-specific and would need adjusting to match.
export async function POST(request: NextRequest) {
  const secret = request.nextUrl.searchParams.get("secret");
  if (!process.env.POSTMARK_INBOUND_SECRET || secret !== process.env.POSTMARK_INBOUND_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json();

  // MailboxHash is Postmark's own field for the +tag on the inbound address
  // (support+org-acme@... -> "org-acme"), already split out for us — see
  // lib/channel-verify.ts's parseMailboxHash for what the two possible
  // shapes ("org-<slug>" for a new ticket, "task-<uuid>" for a reply) mean
  // and how the matching Reply-To address gets put on our own outbound mail.
  const target = parseMailboxHash(payload.MailboxHash);
  if (!target) {
    // Nothing to route this to (no +tag, or one that doesn't parse) — 200
    // rather than an error, so Postmark doesn't retry a message that will
    // never parse any differently the second time.
    return NextResponse.json({ ok: true, routed: false });
  }

  const supabase = createServiceRoleClient();
  let orgId: string | null = null;
  let existingTaskId: string | null = null;

  if (target.kind === "org") {
    const { data: org } = await supabase.from("orgs").select("id").eq("slug", target.orgSlug).maybeSingle();
    orgId = org?.id ?? null;
  } else {
    const { data: task } = await supabase.from("tasks").select("id, org_id").eq("id", target.taskId).maybeSingle();
    orgId = task?.org_id ?? null;
    existingTaskId = task?.id ?? null;
  }

  // Same reasoning as the "no MailboxHash" case above: an org slug or task
  // id that no longer exists can't be routed correctly no matter how many
  // times Postmark retries, so acknowledge and drop it rather than erroring.
  if (!orgId) return NextResponse.json({ ok: true, routed: false });

  const { taskId, duplicate } = await intakeTicket({
    orgId,
    channel: "email",
    contactEmail: payload.FromFull?.Email ?? payload.From ?? null,
    contactName: payload.FromFull?.Name ?? payload.FromName ?? null,
    subject: payload.Subject ?? null,
    // StrippedTextReply (Postmark's own quoted-text-stripped version of a
    // reply) is preferable when present — a customer's reply email quotes
    // the entire thread below their new text otherwise, and TextBody would
    // include all of that as if it were newly said.
    body: payload.StrippedTextReply || payload.TextBody || "(no body)",
    externalMessageRef: payload.MessageID,
    existingTaskId,
  });

  return NextResponse.json({ ok: true, taskId, duplicate });
}
