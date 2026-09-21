"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Role, SubscriptionStatus } from "@/lib/types";
import { updateOrgDomain, toggleTeamAllocation } from "@/lib/actions";
import { createCheckoutSession, createBillingPortalSession } from "@/lib/billing";

// New with custom subdomains (Phase 3): the first panel that's about the
// org itself rather than one of its workspace concerns (projects, workflow,
// etc.) — didn't fit naturally into any existing panel, so it gets its own,
// following the same one-concern-per-panel pattern as Projects/Teams/
// Custom fields/Workflow & roles.
export function OrgSettingsPanel({
  orgId,
  orgName,
  orgSlug,
  orgCustomDomain,
  orgSubscriptionStatus,
  orgStripePriceId,
  orgSubscriptionPeriodEnd,
  orgTeamAllocationEnabled,
  currentUserRole,
  onClose,
}: {
  orgId: string;
  orgName: string;
  orgSlug: string;
  orgCustomDomain: string | null;
  orgSubscriptionStatus: SubscriptionStatus | null;
  orgStripePriceId: string | null;
  orgSubscriptionPeriodEnd: string | null;
  orgTeamAllocationEnabled: boolean;
  currentUserRole: Role;
  onClose: () => void;
}) {
  const canManageDomain = currentUserRole === "owner" || currentUserRole === "admin";
  const isOwner = currentUserRole === "owner";
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [domainInput, setDomainInput] = useState(orgCustomDomain ?? "");
  // Billing actions navigate the browser themselves (see the comment on
  // goToBilling below) rather than going through run()/router.refresh() —
  // this tracks their own pending/error state instead of reusing `pending`,
  // so a slow Stripe redirect doesn't also disable the domain Save button.
  const [billingPending, setBillingPending] = useState(false);
  const [billingError, setBillingError] = useState<string | null>(null);

  // window.location.origin is only known client-side — computed after mount
  // rather than read directly during render, so the server-rendered and
  // first client-rendered HTML still match (avoids a hydration warning).
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);

  // Set at build time from NEXT_PUBLIC_ROOT_DOMAIN — see middleware.ts for
  // what actually makes <slug>.rootDomain work. Reading it directly here
  // (rather than threading it down as a prop) is safe: any NEXT_PUBLIC_
  // var is inlined into the client bundle the same way regardless of where
  // it's read.
  const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN;

  function run(action: () => Promise<unknown>) {
    setError(null);
    startTransition(async () => {
      try {
        await action();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      }
    });
  }

  // Billing actions return a URL rather than redirecting server-side (see
  // lib/billing.ts's header comment on why) — this is the client half of
  // that pattern: navigate the browser itself, which also sidesteps run()'s
  // router.refresh() since we're about to leave the page entirely.
  function goToBilling(action: () => Promise<{ url: string }>) {
    setBillingError(null);
    setBillingPending(true);
    action()
      .then(({ url }) => {
        window.location.href = url;
      })
      .catch((err) => {
        setBillingError(err instanceof Error ? err.message : "Something went wrong.");
        setBillingPending(false);
      });
  }

  return (
    <>
      <div className="scrim show" onClick={onClose} />
      <aside className="panel show panel-left">
        <div className="panel-head">
          <div style={{ flex: 1, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16 }}>Organization</div>
          <button className="icon-btn panel-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="panel-body">
          {error && <div className="banner" style={{ color: "var(--blocked)", background: "var(--blocked-bg)" }}>{error}</div>}

          <div className="field-group">
            <span className="field-label">{orgName}</span>
            <p style={{ color: "var(--text-faint)", fontSize: 12 }}>
              Renaming isn&apos;t available from here yet — this panel is about where your public request Portal lives.
            </p>
          </div>

          <div className="divider" />

          <div className="field-group">
            <span className="field-label">Portal URL</span>
            <p style={{ color: "var(--text-faint)", fontSize: 12, marginBottom: 8 }}>
              Share either of these with customers — both open the same public request form.
            </p>
            {rootDomain && (
              <div className="field-def-card" style={{ marginBottom: 8 }}>
                <code style={{ fontSize: 12.5, wordBreak: "break-all" }}>
                  https://{orgSlug}.{rootDomain}
                </code>
                <div className="crumbline">Your dedicated subdomain</div>
              </div>
            )}
            <div className="field-def-card">
              <code style={{ fontSize: 12.5, wordBreak: "break-all" }}>
                {origin || "…"}/portal/{orgSlug}
              </code>
              <div className="crumbline">Always works, subdomain or not</div>
            </div>
            {!rootDomain && (
              <p style={{ color: "var(--text-faint)", fontSize: 11.5, marginTop: 8 }}>
                A dedicated subdomain (like acme.yourapp.com) isn&apos;t configured for this deployment yet — that&apos;s a
                one-time setup step (NEXT_PUBLIC_ROOT_DOMAIN), not something set per organization.
              </p>
            )}
          </div>

          <div className="divider" />

          <div className="field-group">
            <span className="field-label">Custom domain</span>
            {!canManageDomain ? (
              <p style={{ color: "var(--text-faint)", fontSize: 12 }}>Only an owner or admin can change this.</p>
            ) : (
              <>
                <p style={{ color: "var(--text-faint)", fontSize: 12, marginBottom: 8 }}>
                  Saves the domain you intend to use (e.g. support.yourcompany.com) — this doesn&apos;t make it live yet.
                  Pointing your own DNS at this app won&apos;t route traffic here until domain verification is built; for
                  now, use the Portal URLs above.
                </p>
                <div className="add-inline">
                  <input
                    className="text-input"
                    style={{ flex: 1 }}
                    placeholder="support.yourcompany.com"
                    value={domainInput}
                    onChange={(e) => setDomainInput(e.target.value)}
                  />
                  <button
                    className="small-btn"
                    disabled={pending || domainInput.trim() === (orgCustomDomain ?? "")}
                    onClick={() => run(() => updateOrgDomain(orgId, domainInput))}
                  >
                    Save
                  </button>
                </div>
                {orgCustomDomain && (
                  <button
                    className="icon-btn"
                    style={{ marginTop: 8 }}
                    disabled={pending}
                    title="Remove custom domain"
                    onClick={() => {
                      setDomainInput("");
                      run(() => updateOrgDomain(orgId, null));
                    }}
                  >
                    ✕ Remove {orgCustomDomain}
                  </button>
                )}
              </>
            )}
          </div>

          <div className="divider" />

          <div className="field-group">
            <span className="field-label">Team allocation</span>
            {!canManageDomain ? (
              <p style={{ color: "var(--text-faint)", fontSize: 12 }}>Only an owner or admin can change this.</p>
            ) : (
              <>
                <p style={{ color: "var(--text-faint)", fontSize: 12, marginBottom: 8 }}>
                  While on, a task&apos;s Assignee picker narrows to that task&apos;s own team members (set from Manage
                  teams) — the current assignee always stays selectable even if not on the team, and a team with no
                  registered members falls back to showing everyone. Off by default; turning it off doesn&apos;t lose
                  any team membership you&apos;ve already set, it just stops narrowing the picker.
                </p>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={orgTeamAllocationEnabled}
                    disabled={pending}
                    onChange={(e) => run(() => toggleTeamAllocation(orgId, e.target.checked))}
                  />
                  <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>Team allocation enabled</span>
                </label>
              </>
            )}
          </div>

          <div className="divider" />

          <div className="field-group">
            <span className="field-label">Billing</span>
            {!isOwner ? (
              <p style={{ color: "var(--text-faint)", fontSize: 12 }}>Only the organization&apos;s owner can manage billing.</p>
            ) : (
              <>
                {billingError && (
                  <div className="banner" style={{ color: "var(--blocked)", background: "var(--blocked-bg)", marginBottom: 8 }}>
                    {billingError}
                  </div>
                )}
                {orgSubscriptionStatus ? (
                  <div className="field-def-card" style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 13 }}>
                      Status: <strong>{orgSubscriptionStatus}</strong>
                    </div>
                    {orgStripePriceId && (
                      <div className="crumbline">
                        Plan: <code style={{ fontSize: 11.5 }}>{orgStripePriceId}</code>
                      </div>
                    )}
                    {orgSubscriptionPeriodEnd && (
                      <div className="crumbline">
                        Current period ends {new Date(orgSubscriptionPeriodEnd).toLocaleDateString()}
                      </div>
                    )}
                  </div>
                ) : (
                  <p style={{ color: "var(--text-faint)", fontSize: 12, marginBottom: 8 }}>
                    This organization hasn&apos;t started a subscription.
                  </p>
                )}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {!orgSubscriptionStatus && (
                    <button
                      className="small-btn"
                      disabled={billingPending}
                      onClick={() => goToBilling(() => createCheckoutSession(orgId))}
                    >
                      Subscribe
                    </button>
                  )}
                  {orgSubscriptionStatus && (
                    <button
                      className="small-btn"
                      disabled={billingPending}
                      onClick={() => goToBilling(() => createBillingPortalSession(orgId))}
                    >
                      Manage billing
                    </button>
                  )}
                </div>
                <p style={{ color: "var(--text-faint)", fontSize: 11.5, marginTop: 8 }}>
                  Billing doesn&apos;t change or restrict anything in the app yet — this is a first pass that gets a
                  subscription set up and kept in sync, nothing more.
                </p>
              </>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
