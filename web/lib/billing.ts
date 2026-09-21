"use server";

import Stripe from "stripe";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";

// Phase 3's billing slice — a single-plan subscription (one Stripe Price,
// STRIPE_PRICE_ID) rather than a full pricing-tiers system: this is a first
// pass, and one plan is enough to prove the integration end-to-end without
// inventing a plan model nothing has asked for yet. Extending to real tiers
// later is additive (a plan picker instead of a fixed price id going into
// the Checkout Session below), not a rework.
//
// Deliberately NOT built here: any actual enforcement. This wires up
// subscribing, managing, and keeping subscription_status in sync (see the
// webhook at app/api/webhooks/stripe/route.ts) — nothing in the app checks
// that status to gate access to anything. What "free" vs "paid" unlocks is
// a product decision nobody's made yet; bolting on an enforcement check
// prematurely would just be a guess. See org-settings-panel.tsx for where
// this surfaces, and the README's Billing section for the full rundown.
//
// This module is genuinely untested end-to-end — this environment has no
// Stripe account connected and no way to click through hosted Checkout or
// receive a real webhook delivery. The code below follows Stripe's Node SDK
// contract carefully, but you'll want to run through a real test-mode
// subscribe/cancel cycle yourself (with `stripe listen --forward-to
// localhost:3000/api/webhooks/stripe`) before trusting it in production.

function stripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Billing isn't configured (STRIPE_SECRET_KEY is unset).");
  // Pinned so a future stripe package upgrade doesn't silently start
  // talking a newer API version than this code was written against.
  return new Stripe(key, { apiVersion: "2025-02-24.acacia" });
}

function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "");
}

async function requireOwner(orgId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in.");

  const { data: membership } = await supabase
    .from("org_members")
    .select("role")
    .eq("org_id", orgId)
    .eq("user_id", user.id)
    .maybeSingle();
  // Billing is gated tighter than the rest of the Organization panel
  // (custom domain there is owner/admin) — an admin can run the workspace
  // day-to-day without needing the ability to change what the org is
  // charged, or to cancel the subscription entirely.
  if (membership?.role !== "owner") throw new Error("Only the organization's owner can manage billing.");

  return { supabase, user };
}

// Starts a subscription checkout for orgs.STRIPE_PRICE_ID. Returns the
// Checkout Session URL rather than redirecting server-side — a Server
// Action's redirect() throws a special error that's easy to accidentally
// swallow in a caller's try/catch (every panel in this app wraps its
// actions in one), so the caller navigates the browser itself instead; see
// org-settings-panel.tsx's goToCheckout().
export async function createCheckoutSession(orgId: string): Promise<{ url: string }> {
  const { supabase, user } = await requireOwner(orgId);
  const stripe = stripeClient();
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) throw new Error("Billing isn't configured (STRIPE_PRICE_ID is unset).");

  const { data: org } = await supabase.from("orgs").select("name, stripe_customer_id").eq("id", orgId).single();
  if (!org) throw new Error("Organization not found.");

  // Lazily created on first checkout rather than at signup — most orgs
  // signing up on a free/unpaid basis never need a Stripe Customer object
  // at all, so this avoids calling Stripe on every signup regardless of
  // whether billing is even configured for this deployment.
  let customerId = org.stripe_customer_id as string | null;
  if (!customerId) {
    const customer = await stripe.customers.create({
      name: org.name,
      email: user.email ?? undefined,
      metadata: { org_id: orgId },
    });
    customerId = customer.id;
    // Service-role write: orgs.stripe_customer_id is one of the billing
    // columns the webhook otherwise owns exclusively (see schema.sql's
    // comment on it) — this is the one place outside the webhook that also
    // needs to set it, specifically so the *next* checkout for this org
    // reuses the same customer instead of creating a duplicate one. Using
    // the RLS-bound `supabase` client here would work too (orgs_admin_update
    // covers it), but the service-role client matches "only the webhook and
    // this one lazy-create path ever touch these columns" as a single rule
    // rather than carving out a client-write exception.
    await createServiceRoleClient().from("orgs").update({ stripe_customer_id: customerId }).eq("id", orgId);
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: orgId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${appBaseUrl()}/dashboard?billing=success`,
    cancel_url: `${appBaseUrl()}/dashboard?billing=cancelled`,
  });
  if (!session.url) throw new Error("Stripe didn't return a Checkout URL.");
  return { url: session.url };
}

// Stripe's own hosted "manage your subscription" page — update payment
// method, change/cancel plan, view invoices. Nothing here needs building by
// hand; Stripe's Customer Portal is the whole feature.
export async function createBillingPortalSession(orgId: string): Promise<{ url: string }> {
  const { supabase } = await requireOwner(orgId);
  const stripe = stripeClient();

  const { data: org } = await supabase.from("orgs").select("stripe_customer_id").eq("id", orgId).single();
  if (!org?.stripe_customer_id) throw new Error("This organization hasn't started a subscription yet.");

  const session = await stripe.billingPortal.sessions.create({
    customer: org.stripe_customer_id,
    return_url: `${appBaseUrl()}/dashboard`,
  });
  return { url: session.url };
}
