"use client";

import { Suspense, useState, type FormEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// app/auth/callback/route.ts sends every failed magic-link exchange here —
// from /login itself, from /signup, and from an invite accept — as
// `?error=auth`, but until now nothing on this page ever read that param:
// the user was silently dropped back on a blank sign-in form with zero
// indication anything went wrong (see the "why is my magic link not
// working" debugging session in alloy-development-log.md/roadmap for the
// symptom this was masking). A magic link is single-use and time-limited,
// so the most common real causes are an already-clicked/reused link, a
// genuinely expired one, or — specific to local dev — the local Supabase
// instance having been restarted (`supabase start`/`db reset`) between
// requesting the link and clicking it, which wipes the pending OTP even
// though the email sitting in Inbucket still looks clickable.
function AuthErrorBanner() {
  const params = useSearchParams();
  if (params.get("error") !== "auth") return null;
  return (
    <p
      className="mt-4 rounded-md px-3 py-2 text-sm"
      style={{ background: "var(--blocked-bg, #f8e3e1)", color: "var(--blocked, #b23f3f)" }}
    >
      That sign-in link didn&apos;t work — it may have already been used, expired, or (if you&apos;re
      testing locally) gone stale after a Supabase restart. Request a new one below and click it
      just once, soon after it arrives.
    </p>
  );
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const supabase = createClient();
    await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    setSent(true);
  }

  return (
    <main className="mx-auto max-w-sm px-6 py-24">
      <h1 className="text-xl font-semibold">Sign in to Alloy</h1>
      <Suspense fallback={null}>
        <AuthErrorBanner />
      </Suspense>
      {sent ? (
        <p className="mt-4 text-graphite-500">
          Check your email for a sign-in link.
        </p>
      ) : (
        <form onSubmit={handleSubmit} className="mt-6 space-y-3">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            className="w-full rounded-md border border-graphite-300 px-3 py-2"
          />
          <button
            type="submit"
            className="w-full rounded-md bg-accent px-3 py-2 text-white hover:bg-accent-strong"
          >
            Send magic link
          </button>
        </form>
      )}

      <p className="mt-6 text-sm text-graphite-500">
        New here? <Link href="/signup" className="underline">Create an organization</Link>
      </p>
    </main>
  );
}
