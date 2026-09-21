"use client";

import { useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";

// Sibling to app/login/page.tsx and app/signup/page.tsx's own
// signInWithOtp calls — this one carries invite_token instead of org_name/
// template, which app/auth/callback/route.ts reads to call acceptInvite()
// once the session exists. Email is fixed to the invite's own address (not
// editable) since acceptInvite rejects a mismatch server-side anyway — no
// point letting someone type a different one first.
export function AcceptInviteForm({ token, email }: { token: string; email: string }) {
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const supabase = createClient();
    const redirect = new URL(`${window.location.origin}/auth/callback`);
    redirect.searchParams.set("invite_token", token);
    await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirect.toString() },
    });
    setSent(true);
  }

  if (sent) {
    return <p className="mt-4 text-graphite-500">Check your email for a sign-in link to finish joining.</p>;
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6 space-y-3">
      <input type="email" value={email} disabled className="w-full rounded-md border border-graphite-300 bg-graphite-100 px-3 py-2 text-graphite-500" />
      <button type="submit" className="w-full rounded-md bg-accent px-3 py-2 text-white hover:bg-accent-strong">
        Send magic link
      </button>
    </form>
  );
}
