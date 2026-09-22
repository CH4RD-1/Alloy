"use client";

import { Suspense, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
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

// Two sign-in paths, chosen with a small tab toggle: magic-link (the
// original, still-default flow — no password to remember, but depends on
// email actually arriving and on Supabase's redirect_to/Site URL config
// being right) and password (added later once that email round-trip turned
// out to be a real source of friction — see the roadmap doc's "First
// production deployment" entry). Password sign-in is a single client-side
// call with no email step and no redirect config involved at all, so it
// works regardless of anything above. It only works for an account that's
// already set a password (see the "Your account" section of the
// Organization panel) — signInWithPassword just reports "Invalid login
// credentials" for an account that's never set one, which reads a little
// generic but matches what Supabase itself returns for a wrong password
// too (deliberately, on Supabase's part, so a login form can't be used to
// probe which emails have accounts).
type Mode = "magic" | "password";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("magic");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [sent, setSent] = useState(false);
  const [pwPending, setPwPending] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);

  async function handleMagicLinkSubmit(e: FormEvent) {
    e.preventDefault();
    const supabase = createClient();
    await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    setSent(true);
  }

  async function handlePasswordSubmit(e: FormEvent) {
    e.preventDefault();
    setPwError(null);
    setPwPending(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setPwError(error.message);
      setPwPending(false);
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <main className="mx-auto max-w-sm px-6 py-24">
      <h1 className="text-xl font-semibold">Sign in to Alloy</h1>
      <Suspense fallback={null}>
        <AuthErrorBanner />
      </Suspense>

      <div className="mt-6 flex gap-1 rounded-md border border-graphite-300 p-1">
        <button
          type="button"
          onClick={() => setMode("magic")}
          className="flex-1 rounded px-3 py-1.5 text-sm"
          style={mode === "magic" ? { background: "var(--accent, #4f46e5)", color: "white" } : undefined}
        >
          Magic link
        </button>
        <button
          type="button"
          onClick={() => setMode("password")}
          className="flex-1 rounded px-3 py-1.5 text-sm"
          style={mode === "password" ? { background: "var(--accent, #4f46e5)", color: "white" } : undefined}
        >
          Password
        </button>
      </div>

      {mode === "magic" ? (
        sent ? (
          <p className="mt-4 text-graphite-500">Check your email for a sign-in link.</p>
        ) : (
          <form onSubmit={handleMagicLinkSubmit} className="mt-4 space-y-3">
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
        )
      ) : (
        <form onSubmit={handlePasswordSubmit} className="mt-4 space-y-3">
          {pwError && (
            <p
              className="rounded-md px-3 py-2 text-sm"
              style={{ background: "var(--blocked-bg, #f8e3e1)", color: "var(--blocked, #b23f3f)" }}
            >
              {pwError}
            </p>
          )}
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            className="w-full rounded-md border border-graphite-300 px-3 py-2"
          />
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="w-full rounded-md border border-graphite-300 px-3 py-2"
          />
          <button
            type="submit"
            disabled={pwPending}
            className="w-full rounded-md bg-accent px-3 py-2 text-white hover:bg-accent-strong disabled:opacity-50"
          >
            {pwPending ? "Signing in…" : "Sign in"}
          </button>
          <p className="text-xs text-graphite-500">
            Haven&apos;t set a password yet? Sign in with a magic link, then set one from the Organization panel.
          </p>
        </form>
      )}

      <p className="mt-6 text-sm text-graphite-500">
        New here? <Link href="/signup" className="underline">Create an organization</Link>
      </p>
    </main>
  );
}
