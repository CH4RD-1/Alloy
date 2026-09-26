"use client";

import { useState } from "react";
import type { Company, Contact } from "@/lib/types";
import { contactLabel } from "@/lib/crm-view";
import { createContact } from "@/lib/actions";

// CRM Phase C — the standalone Contacts tab, closing the last gap the CRM
// Phase A plan flagged (see lib/actions.ts's getOrgContactsData, whose own
// comment used to point here as "not built yet"). Structurally a straight
// copy of components/companies-view.tsx: same fetch-once-on-mount data
// ownership (see TasksWorkspace's own comment on why Companies/Deals/
// Contacts hold their own client state instead of server-rendered props),
// same "+ New" -> open-panel-to-fill-in flow, same asset-card grid. A
// contact card shows its linked company (if any) as a second line, same
// spot company-panel.tsx's own cards would put a domain.
export function ContactsView({
  orgId,
  contacts,
  setContacts,
  companiesById,
  loaded,
  search,
  onSelectContact,
}: {
  orgId: string;
  contacts: Contact[];
  setContacts: (updater: (prev: Contact[]) => Contact[]) => void;
  companiesById: Map<string, Company>;
  loaded: boolean;
  search: string;
  onSelectContact: (id: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const q = search.trim().toLowerCase();
  const filtered = q
    ? contacts.filter((c) => {
        const companyName = c.company_id ? companiesById.get(c.company_id)?.name ?? "" : "";
        return (contactLabel(c) + " " + (c.email ?? "") + " " + (c.phone ?? "") + " " + companyName).toLowerCase().includes(q);
      })
    : contacts;

  async function newContact() {
    setPending(true);
    setError(null);
    try {
      const created = await createContact(orgId);
      setContacts((prev) => [...prev, created]);
      onSelectContact(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create that contact.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div className="view-head">
        <div>
          <div className="view-title">Contacts</div>
          <div className="view-sub">
            {loaded ? `${contacts.length} contact${contacts.length === 1 ? "" : "s"}` : "Loading…"}
          </div>
        </div>
        <button className="small-btn" disabled={pending} onClick={newContact}>
          + New contact
        </button>
      </div>
      {error && <div className="banner">{error}</div>}
      <div className="assets-grid">
        {loaded && filtered.length === 0 && (
          <div className="empty-note">{contacts.length === 0 ? "No contacts yet." : "No contacts match your search."}</div>
        )}
        {filtered.map((c) => {
          const company = c.company_id ? companiesById.get(c.company_id) : undefined;
          return (
            <div key={c.id} className="asset-card" onClick={() => onSelectContact(c.id)}>
              <div className="asset-card-title">{contactLabel(c)}</div>
              <div className="asset-card-tag">{company?.name ?? c.email ?? c.phone ?? "—"}</div>
            </div>
          );
        })}
      </div>
    </>
  );
}
