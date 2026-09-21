import Stripe from "stripe";
import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";

// Stripe -> Alloy sync. This is the ONLY writer of orgs.stripe_subscription_id,
// stripe_price_id, subscription_status, and subscription_current_period_end
// (see schema.sql's comment on those columns, and billing.sql) — everything
// here runs under the service-role client, both because a webhook delivery
// has no user session at all and because these columns are deliberately not
// covered by orgs_admin_update.
//
// Route Handlers don't run through the app's normal auth/session plumbing,
// so this file doesn't import anything from lib/billing.ts or lib/actions.ts
// — it talks to Stripe and Supabase directly.
//
// Untested end-to-end (see lib/billing.ts's header comment) — signature
// verification and the event handling below follow Stripe's documented
// contract, but you'll want to run `stripe listen --forward-to
// localhost:3000/api/webhooks/stripe` and click through a real test-mode
// subscribe/cancel cycle before trusting this in production.

function stripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Billing isn't configured (STRIPE_SECRET_KEY is unset).");
  return new Stripe(key, { apiVersion: "2025-02-24.acacia" });
}

// Pulls the fields Alloy cares about off a Stripe Subscription object and
// upserts them onto the org that owns it — shared by every event handled
// below so checkout completion and the ongoing subscription.* events can't
// drift into writing these columns two different ways.
async function syncSubscriptionToOrg(orgId: string, subscription: Stripe.Subscription) {
  const item = subscription.items.data[0];
  const periodEndUnix = subscription.current_period_end ?? null;

  await createServiceRoleClient()
    .from("orgs")
    .update({
      stripe_subscription_id: subscription.id,
      stripe_price_id: item?.price.id ?? null,
      subscription_status: subscription.status,
      subscription_current_period_end: periodEndUnix ? new Date(periodEndUnix * 1000).toISOString() : null,
    })
    .eq("id", orgId);
}

// subscription.updated/created/deleted carry the customer id, not the org
// id (Checkout's client_reference_id doesn't carry forward onto the
// Subscription object) — so those events look the org up by
// stripe_customer_id instead. That column is set once, either by
// lib/billing.ts's lazy customer creation or by checkout.session.completed
// below, before any subscription.* event for that customer can fire.
async function orgIdForCustomer(customerId: string): Promise<string | null> {
  const { data } = await createServiceRoleClient()
    .from("orgs")
    .select("id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  return data?.id ?? null;
}

export async function POST(req: Request) {
  const signature = req.headers.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!signature || !webhookSecret) {
    return NextResponse.json({ error: "Webhook not configured." }, { status: 400 });
  }

  // constructEvent needs the raw, unparsed body to verify the signature —
  // req.text() rather than req.json() is what makes that possible.
  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = stripeClient().webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid signature.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const orgId = session.client_reference_id;
        if (orgId && session.subscription) {
          const subscription = await stripeClient().subscriptions.retrieve(
            typeof session.subscription === "string" ? session.subscription : session.subscription.id
          );
          await syncSubscriptionToOrg(orgId, subscription);
        }
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
        const orgId = await orgIdForCustomer(customerId);
        // No org found isn't an error worth failing the webhook over — it
        // just means this customer predates billing being wired up, or
        // belongs to a different Stripe account/mode than this deployment's
        // data. Stripe would otherwise retry a non-2xx response forever.
        if (orgId) await syncSubscriptionToOrg(orgId, subscription);
        break;
      }

      default:
        // Every other event type is intentionally ignored — this is a
        // first pass covering only what's needed to keep orgs.subscription_*
        // in sync, not a general-purpose Stripe event log.
        break;
    }
  } catch (err) {
    // A write failure here should make Stripe retry the delivery rather
    // than silently losing the update, so this doesn't get swallowed into
    // a 200.
    const message = err instanceof Error ? err.message : "Webhook handler failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
