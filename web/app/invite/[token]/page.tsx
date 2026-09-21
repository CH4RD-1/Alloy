import { getInviteByToken } from "@/lib/actions";
import { AcceptInviteForm } from "@/components/accept-invite-form";

const ROLE_NAME: Record<string, string> = { manager: "Manager", authorizer: "Authorizer", standard: "Standard" };

// Public landing page for an invite link — mirrors app/portal/[orgSlug]
// /page.tsx's params/searchParams convention exactly (Next 15's async
// dynamic APIs). `error` arrives when app/auth/callback/route.ts's
// acceptInvite() call fails after the magic-link round trip (expired
// in the meantime, wrong email, etc.) and redirects back here instead of
// on to /dashboard.
export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const { error } = await searchParams;

  const invite = await getInviteByToken(token);

  return (
    <main className="mx-auto max-w-sm px-6 py-24">
      {error && (
        <div className="mb-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      {!invite ? (
        <>
          <h1 className="text-xl font-semibold">Invite not found</h1>
          <p className="mt-4 text-graphite-500">This invite link isn&apos;t valid — it may have been revoked.</p>
        </>
      ) : invite.acceptedAt ? (
        <>
          <h1 className="text-xl font-semibold">Already accepted</h1>
          <p className="mt-4 text-graphite-500">This invite has already been accepted. Try signing in instead.</p>
        </>
      ) : new Date(invite.expiresAt) < new Date() ? (
        <>
          <h1 className="text-xl font-semibold">Invite expired</h1>
          <p className="mt-4 text-graphite-500">
            This invite to join {invite.orgName} has expired. Ask whoever invited you to send a new one.
          </p>
        </>
      ) : (
        <>
          <h1 className="text-xl font-semibold">Join {invite.orgName}</h1>
          <p className="mt-4 text-graphite-500">
            You&apos;ve been invited as a {ROLE_NAME[invite.role] ?? invite.role}. Sign in with {invite.email} to accept.
          </p>
          <AcceptInviteForm token={token} email={invite.email} />
        </>
      )}
    </main>
  );
}
