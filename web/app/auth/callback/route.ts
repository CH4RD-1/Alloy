import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { completeSignup, acceptInvite } from "@/lib/actions";
import type { OrgTemplate } from "@/lib/types";

// The magic-link email sent by signInWithOtp points here (see the
// emailRedirectTo option in app/login/page.tsx, app/signup/page.tsx and
// components/accept-invite-form.tsx). Without this route the link opens the
// app but never actually establishes a session — @supabase/ssr's PKCE flow
// needs this server-side code-for-session exchange.
//
// org_name/template (from signup) and invite_token (from an invite accept)
// ride along as extra query params on emailRedirectTo — the same trick the
// channel adapters use for mailbox-hash addressing — so this route can
// trigger the right post-auth side effect without a separate "pending
// signup" table. At most one of the two is ever present on a given link.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";
  const orgName = searchParams.get("org_name");
  const template = searchParams.get("template") as OrgTemplate | null;
  const inviteToken = searchParams.get("invite_token");

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      if (orgName && template) {
        // Best-effort: a signup link clicked twice (or by an existing
        // member) shouldn't strand the user on an error page — completeSignup
        // itself already no-ops into their existing org in that case, and
        // any other failure here still lands them on the dashboard, which
        // will show its own "no workspace yet" state if something genuinely
        // went wrong.
        try {
          await completeSignup({ orgName, template });
        } catch (err) {
          // Swallowed on purpose (see comment above) — but logged, not
          // silently dropped, so a genuine failure here (as opposed to the
          // harmless "already a member" no-op) shows up in the server
          // console instead of just leaving the user stranded on
          // dashboard's "No workspace yet" state with no clue why.
          console.error("completeSignup failed:", err);
        }
        return NextResponse.redirect(`${origin}${next}`);
      }

      if (inviteToken) {
        try {
          await acceptInvite(inviteToken);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Couldn't accept this invite.";
          return NextResponse.redirect(`${origin}/invite/${inviteToken}?error=${encodeURIComponent(message)}`);
        }
        return NextResponse.redirect(`${origin}${next}`);
      }

      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
