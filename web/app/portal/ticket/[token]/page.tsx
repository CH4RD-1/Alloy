import { getPortalTicketByToken } from "@/lib/actions";
import { createClient } from "@/lib/supabase/server";
import { PortalTicketView } from "@/components/portal-ticket-view";
import { PortalKb } from "@/components/portal-kb";

// Public landing page for a ticket's per-ticket magic link — mirrors
// app/invite/[token]/page.tsx's own params convention (Next 15's async
// dynamic APIs) and not-found-vs-found branching. No login, no session:
// the token itself is the only credential, resolved through
// getPortalTicketByToken (service-role, see lib/actions.ts's own comment
// on the trust model this shares with invite links).
export default async function PortalTicketPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ticket = await getPortalTicketByToken(token);

  // Knowledge base browse, added alongside the anonymous portal's own KB
  // overhaul (see components/portal-kb.tsx) so a customer who came back via
  // their ticket link can self-serve the same articles, not just the
  // anonymous intake form. Fetched here rather than inside
  // getPortalTicketByToken — that function is about the ticket itself, and
  // published docs already have their own public-read RLS policy, so a
  // plain (non-service-role) client is enough, same as the anonymous
  // portal page's own articles query.
  const supabase = ticket ? await createClient() : null;
  const { data: articles } = ticket
    ? await supabase!
        .from("docs")
        .select("id, title, body_html")
        .eq("org_id", ticket.orgId)
        .eq("published", true)
        .order("updated_at", { ascending: false })
    : { data: null };

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      {!ticket ? (
        <>
          <h1 className="text-xl font-semibold">Link not found</h1>
          <p className="mt-4 text-graphite-500">
            This link isn&apos;t valid — double check you copied the whole thing, or ask whoever you&apos;ve been in
            touch with to resend it.
          </p>
        </>
      ) : (
        <>
          <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
            {ticket.orgName} support
          </p>
          <PortalTicketView ticket={ticket} token={token} />
          <div className="portal-card" style={{ marginTop: 24 }}>
            <PortalKb articles={articles ?? []} />
          </div>
        </>
      )}
    </main>
  );
}
