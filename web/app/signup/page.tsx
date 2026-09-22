"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { completeSignup } from "@/lib/actions";
import type { OrgTemplate } from "@/lib/types";

// Same lightweight Tailwind-utility styling as app/login/page.tsx — this is
// still an auth stub page, not part of the dashboard's own design system
// (see globals.css), so it deliberately doesn't reach for that.
const TEMPLATES: { id: OrgTemplate; name: string; blurb: string }[] = [
  { id: "core", name: "Core", blurb: "General project & task tracking." },
  { id: "helpdesk", name: "Helpdesk", blurb: "Ticket intake and support queues, with a helpdesk-ready starter project." },
  { id: "engineering", name: "Engineering", blurb: "Software delivery — Tasks and Disciplines." },
];

type Mode = "magic" | "password";

export default function SignupPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("magic");
  const [orgName, setOrgName] = useState("");
  const [template, setTemplate] = useState<OrgTemplate>("core");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [sent, setSent] = useState(false);
  const [pwPending, setPwPending] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);

  // completeSignup itself runs after the magic-link round trip, from
  // app/auth/callback/route.ts — org_name/template ride along as query
  // params on emailRedirectTo, the same trick used for invite_token on the
  // accept-invite form, so no "pending signup" table is needed in between.
  async function handleMagicLinkSubmit(e: FormEvent) {
    e.preventDefault();
    const supabase = createClient();
    const redirect = new URL(`${window.location.origin}/auth/callback`);
    redirect.searchParams.set("org_name", orgName.trim());
    redirect.searchParams.set("template", template);
    await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirect.toString() },
    });
    setSent(true);
  }

  // Password signup has no email round-trip to depend on — signUp() either
  // hands back a live session immediately (the normal case once Supabase's
  // "Confirm email" toggle is off, which is worth doing for this app until
  // real outbound email is configured — see the roadmap doc), in which case
  // completeSignup runs right here instead of from the auth callback route,
  // or it doesn't (Confirm email still on), in which case there's still a
  // confirmation email to click — same "check your email" messaging as the
  // magic-link path, since at that point it's the same underlying wait.
  async function handlePasswordSubmit(e: FormEvent) {
    e.preventDefault();
    setPwError(null);
    setPwPending(true);
    const supabase = createClient();
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) {
      setPwError(error.message);
      setPwPending(false);
      return;
    }
    if (!data.session) {
      // Confirm email is still on for this project — same wait as the
      // magic-link path, just via a confirmation link instead of a sign-in
      // one.
      setSent(true);
      setPwPending(false);
      return;
    }
    try {
      await completeSignup({ orgName: orgName.trim(), template });
    } catch (err) {
      setPwError(err instanceof Error ? err.message : "Something went wrong finishing setup.");
      setPwPending(false);
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  const canSubmit = !!orgName.trim() && !!email;

  return (
    <main className="mx-auto max-w-sm px-6 py-24">
      <h1 className="text-xl font-semibold">Create your organization</h1>

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

      {sent ? (
        <p className="mt-4 text-graphite-500">
          Check your email for a {mode === "magic" ? "sign-in" : "confirmation"} link — it&apos;ll finish setting up{" "}
          {orgName || "your organization"} once you click it.
        </p>
      ) : (
        <form onSubmit={mode === "magic" ? handleMagicLinkSubmit : handlePasswordSubmit} className="mt-4 space-y-4">
          {pwError && (
            <p
              className="rounded-md px-3 py-2 text-sm"
              style={{ background: "var(--blocked-bg, #f8e3e1)", color: "var(--blocked, #b23f3f)" }}
            >
              {pwError}
            </p>
          )}

          <div className="space-y-1.5">
            <label className="block text-sm text-graphite-500">Organization name</label>
            <input
              type="text"
              required
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder="Acme Inc."
              className="w-full rounded-md border border-graphite-300 px-3 py-2"
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-sm text-graphite-500">Starting point</label>
            <div className="space-y-2">
              {TEMPLATES.map((t) => (
                <label
                  key={t.id}
                  className="flex cursor-pointer items-start gap-2 rounded-md border border-graphite-300 px-3 py-2"
                  style={template === t.id ? { borderColor: "var(--accent, #4f46e5)" } : undefined}
                >
                  <input
                    type="radio"
                    name="template"
                    className="mt-1"
                    checked={template === t.id}
                    onChange={() => setTemplate(t.id)}
                  />
                  <span>
                    <span className="block font-medium">{t.name}</span>
                    <span className="block text-sm text-graphite-500">{t.blurb}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="block text-sm text-graphite-500">Your email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              className="w-full rounded-md border border-graphite-300 px-3 py-2"
            />
          </div>

          {mode === "password" && (
            <div className="space-y-1.5">
              <label className="block text-sm text-graphite-500">Password</label>
              <input
                type="password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 6 characters"
                className="w-full rounded-md border border-graphite-300 px-3 py-2"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={!canSubmit || (mode === "password" && (pwPending || !password))}
            className="w-full rounded-md bg-accent px-3 py-2 text-white hover:bg-accent-strong disabled:opacity-50"
          >
            {mode === "magic" ? "Send magic link" : pwPending ? "Creating…" : "Create organization"}
          </button>
        </form>
      )}

      <p className="mt-6 text-sm text-graphite-500">
        Already have an account? <Link href="/login" className="underline">Sign in</Link>
      </p>
    </main>
  );
}
