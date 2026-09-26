"use client";

import { useState } from "react";
import type { Company } from "@/lib/types";
import { getCompaniesData, createCompany } from "@/lib/actions";

// CRM Phase A — a grid of company cards, same "+ New" -> open-panel-to-fill-
// in pattern as components/assets-view.tsx's AssetsView. Unlike AssetsView,
// this component fetches its own data (see lib/actions.ts's own header
// comment on getCompaniesData for why) rather than receiving it as a prop
// derived from the server-rendered WorkspaceData — orgId is the only thing
// it needs from its parent.
export function CompaniesView({
  orgId,
  companies,
  setCompanies,
  loaded,
  search,
  onSelectCompany,
}: {
  orgId: string;
  companies: Company[];
  setCompanies: (updater: (prev: Company[]) => Company[]) => void;
  loaded: boolean;
  search: string;
  onSelectCompany: (id: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const q = search.trim().toLowerCase();
  const filtered = q ? companies.filter((c) => (c.name + " " + (c.domain ?? "")).toLowerCase().includes(q)) : companies;

  async function newCompany() {
    setPending(true);
    setError(null);
    try {
      const created = await createCompany(orgId);
      setCompanies((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      onSelectCompany(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create that company.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div className="view-head">
        <div>
          <div className="view-title">Companies</div>
          <div className="view-sub">
            {loaded ? `${companies.length} compan${companies.length === 1 ? "y" : "ies"}` : "Loading…"}
          </div>
        </div>
        <button className="small-btn" disabled={pending} onClick={newCompany}>
          + New company
        </button>
      </div>
      {error && <div className="banner">{error}</div>}
      <div className="assets-grid">
        {loaded && filtered.length === 0 && (
          <div className="empty-note">{companies.length === 0 ? "No companies yet." : "No companies match your search."}</div>
        )}
        {filtered.map((c) => (
          <div key={c.id} className="asset-card" onClick={() => onSelectCompany(c.id)}>
            <div className="asset-card-title">{c.name}</div>
            {c.domain && <div className="asset-card-tag">{c.domain}</div>}
          </div>
        ))}
      </div>
    </>
  );
}
