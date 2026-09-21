import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { intakeTicket } from "@/lib/actions";
import { verifyTwilioSignature } from "@/lib/channel-verify";

// WhatsApp inbound webhook.
//  - Meta Cloud API: Meta calls GET once to verify this endpoint
//    (hub.mode / hub.verify_token / hub.challenge), then POSTs inbound
//    messages here going forward.
//  - Twilio: skip the GET verification step entirely; Twilio POSTs
//    form-encoded inbound messages directly, which is what the POST
//    handler below is actually built against (see its own comment) —
//    picked over Meta's Cloud API directly because it needs no business
//    verification or registered number to start testing with, per the
//    roadmap doc's own reasoning for recommending it as the starting point.

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200 });
  }
  return new NextResponse("Forbidden", { status: 403 });
}

// Targets Twilio's webhook format specifically: form-encoded params and an
// X-Twilio-Signature header (see lib/channel-verify.ts's
// verifyTwilioSignature for how that's checked — no SDK dependency, just an
// HMAC via Node's built-in crypto module). Meta's Cloud API sends JSON with
// its own, different signature scheme, so switching providers later means
// rewriting this body, not just the intakeTicket() call at the bottom.
//
// This adapter is single-tenant per deployment: one Twilio WhatsApp sender
// (TWILIO_WHATSAPP_FROM) serves exactly one org (WHATSAPP_ORG_SLUG). A real
// per-org WhatsApp sender needs its own Meta business verification, which
// isn't something this app can provision on a customer's behalf — see the
// roadmap doc's WhatsApp section. Multiple orgs on WhatsApp at once means
// either multiple deployments for now, or extending this to a real
// number-to-org lookup table later.
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const params = Object.fromEntries(new URLSearchParams(rawBody));

  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const signature = request.headers.get("X-Twilio-Signature");
  if (!authToken || !verifyTwilioSignature(authToken, request.url, params, signature)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const orgSlug = process.env.WHATSAPP_ORG_SLUG;
  const fromNumber = params.From?.replace(/^whatsapp:/, "");
  const body = params.Body ?? "";
  const messageSid = params.MessageSid;

  if (!orgSlug || !fromNumber || !messageSid) {
    return NextResponse.json({ ok: true, routed: false });
  }

  const supabase = createServiceRoleClient();
  const { data: org } = await supabase.from("orgs").select("id").eq("slug", orgSlug).maybeSingle();
  if (!org) return NextResponse.json({ ok: true, routed: false });

  // WhatsApp has no reply-to-address trick the way email's mailbox hash
  // does — a phone number is all there is to identify "which conversation
  // is this," so reuse the contact's most recent still-open WhatsApp thread
  // if they have one, rather than starting a fresh task on every message.
  let existingTaskId: string | null = null;
  const { data: contact } = await supabase.from("contacts").select("id").eq("org_id", org.id).eq("phone", fromNumber).maybeSingle();
  if (contact) {
    const [{ data: closedStatuses }, { data: candidateTasks }] = await Promise.all([
      supabase.from("workflow_statuses").select("id").eq("org_id", org.id).eq("is_closed", true),
      supabase
        .from("tasks")
        .select("id, status_id")
        .eq("org_id", org.id)
        .eq("contact_id", contact.id)
        .eq("channel", "whatsapp")
        .order("created_at", { ascending: false })
        .limit(10),
    ]);
    const closedIds = new Set((closedStatuses ?? []).map((s) => s.id));
    existingTaskId = (candidateTasks ?? []).find((t) => !closedIds.has(t.status_id))?.id ?? null;
  }

  const { taskId, duplicate } = await intakeTicket({
    orgId: org.id,
    channel: "whatsapp",
    contactPhone: fromNumber,
    body: body || "(no text — possibly a media-only message)",
    externalMessageRef: messageSid,
    existingTaskId,
  });

  return NextResponse.json({ ok: true, taskId, duplicate });
}
