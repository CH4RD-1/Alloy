import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { VOCAB_BY_TEMPLATE } from "@/lib/list-view";
import type { FormTemplate } from "@/lib/types";
import { PortalRequestForm } from "@/components/portal-request-form";
import { PortalKb } from "@/components/portal-kb";

// Public-facing customer Portal — no login required. This is what a QR code
// should point at, e.g. yourapp.com/portal/acme?asset=<asset-id> to open a
// pre-filled "raise a ticket about this asset" form. The asset-scoped
// pre-fill only sets the summary text for now — assets have no public-read
// RLS policy yet (Assets management itself isn't built), so this can't look
// up or display the asset's name, just carry its id through as context.
export default async function PortalPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ asset?: string }>;
}) {
  const { orgSlug } = await params;
  const { asset } = await searchParams;
  const supabase = await createClient();

  const { data: org } = await supabase
    .from("orgs")
    .select("id, name, slug, template")
    .eq("slug", orgSlug)
    .single();

  if (!org) notFound();

  const vocab = VOCAB_BY_TEMPLATE[org.template] ?? VOCAB_BY_TEMPLATE.core;

  const [{ data: articles }, { data: formTemplates }] = await Promise.all([
    supabase.from("docs").select("id, title, body_html").eq("org_id", org.id).eq("published", true).order("updated_at", { ascending: false }),
    supabase
      .from("form_templates")
      .select("*")
      .eq("org_id", org.id)
      .eq("portal_visible", true)
      .order("created_at"),
  ]);

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <h1 className="text-2xl font-semibold">{org.name} support</h1>
      <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
        Pick a request type, fill it in, and submitting creates a new {vocab.task.toLowerCase()} for the team.
        {asset && ` Regarding asset ${asset}.`}
      </p>

      <div className="portal-layout" style={{ marginTop: 24 }}>
        <div className="portal-left">
          <PortalRequestForm
            orgId={org.id}
            templates={(formTemplates ?? []) as FormTemplate[]}
            vocabTask={vocab.task}
            initialTitle={asset ? `Regarding asset ${asset}` : undefined}
          />
        </div>

        <PortalKb articles={articles ?? []} />
      </div>
    </main>
  );
}
