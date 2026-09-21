"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import type { OrgTemplate } from "@/lib/types";

// Same lightweight Tailwind-utility styling as app/login/page.tsx — this is
// still an auth stub page, not part of the dashboard's own design system
// (see globals.css), so it deliberately doesn't reach for that.
const TEMPLATES: { id: OrgTemplate; name: string; blurb: string }[] = [
  { id: "core", name: "Core", blurb: "General project & task tracking." },
  { id: "helpdesk", name: "Helpdesk", blurb: "Ticket intake and support queues, with a helpdesk-ready starter project." },
  { id: "engineering", name: "Engineering", blurb: "Software delivery — Tasks and Disciplines." },
];

export default function SignupPage() {
  const [orgName, setOrgName] = useState("");
  const [template, setTemplate] = useState<OrgTemplate>("core");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  // completeSignup itself runs after the magic-link round trip, from
  // app/auth/callback/route.ts — org_name/template ride along as query
  // params on emailRedirectTo, the same trick used for invite_token on the
  // accept-invite form, so no "pending signup" table is needed in between.
  async function handleSubmit(e: FormEvent) {
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

  return (
    <main className="mx-auto max-w-sm px-6 py-24">
      <h1 className="text-xl font-semibold">Create your organization</h1>
      {sent ? (
        <p className="mt-4 text-graphite-500">
          Check your email for a sign-in link — it&apos;ll finish setting up {orgName || "your organization"} once you click it.
        </p>
      ) : (
        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
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

          <button
            type="submit"
            disabled={!orgName.trim() || !email}
            className="w-full rounded-md bg-accent px-3 py-2 text-white hover:bg-accent-strong disabled:opacity-50"
          >
            Send magic link
          </button>
        </form>
      )}

      <p className="mt-6 text-sm text-graphite-500">
        Already have an account? <Link href="/login" className="underline">Sign in</Link>
      </p>
    </main>
  );
}
