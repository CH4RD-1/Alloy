"use client";

import { useEffect, useState } from "react";
import type { Company, Contact, Deal, WorkflowStatus } from "@/lib/types";
import {
  updateCompanyFields,
  deleteCompany,
  getContactsForCompany,
  getOrgContactsData,
  setContactCompany,
} from "@/lib/actions";
import { dealOutcome, dealValueLabel } from "@/lib/crm-view";

// CRM Phase A — mirrors components/asset-panel.tsx's shape (fields save on
// blur, a divider, then linked-record sections, then delete) but fetches its
// own linked-contacts/candidate-contacts data on mount rather than receiving
// it pre-loaded, for the same reason components/companies-view.tsx does —
// see lib/actions.ts's own comment on getContactsForCompany/
// getOrgContactsData.
export function CompanyPanel({
  company,
  deals,
  dealStatusesById,
  onCompanyChange,
  onSelectDeal,
  onClose,
}: {
  company: Company;
  deals: Deal[];
  dealStatusesById: Map<string, WorkflowStatus>;
  onCompanyChange: (updater: (prev: Company[]) => Company[]) => void;
  onSelectDeal: (id: string) => void;
  onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkedContacts, setLinkedContacts] = useState<Contact[]>([]);
  const [candidateContacts, setCandidateContacts] = useState<Contact[]>([]);
  const [pickedContactId, setPickedContactId] = useState("");
  const [contactsLoaded, setContactsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setContactsLoaded(false);
    (async () => {
      const [linked, all] = await Promise.all([getContactsForCompany(company.id), getOrgContactsData(company.org_id)]);
      if (cancelled) return;
      setLinkedContacts(linked);
      setCandidateContacts(all.filter((c) => c.company_id !== company.id));
      setContactsLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [company.id, company.org_id]);

  function run(action: () => Promise<unknown>) {
    setError(null);
    setPending(true);
    action()
      .catch((err) => setError(err instanceof Error ? err.message : "Something went wrong."))
      .finally(() => setPending(false));
  }

  function patchLocal(patch: Partial<Company>) {
    onCompanyChange((prev) => prev.map((c) => (c.id === company.id ? { ...c, ...patch } : c)));
  }

  async function linkContact() {
    if (!pickedContactId) return;
    setPending(true);
    setError(null);
    try {
      await setContactCompany(pickedContactId, company.id);
      const contact = candidateContacts.find((c) => c.id === pickedContactId);
      if (contact) {
        setLinkedContacts((prev) => [...prev, { ...contact, company_id: company.id }]);
        setCandidateContacts((prev) => prev.filter((c) => c.id !== pickedContactId));
      }
      setPickedContactId("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't link that contact.");
    } finally {
      setPending(false);
    }
  }

  async function unlinkContact(contactId: string) {
    setPending(true);
    setError(null);
    try {
      await setContactCompany(contactId, null);
      const contact = linkedContacts.find((c) => c.id === contactId);
      setLinkedContacts((prev) => prev.filter((c) => c.id !== contactId));
      if (contact) setCandidateContacts((prev) => [...prev, { ...contact, company_id: null }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't unlink that contact.");
    } finally {
      setPending(false);
    }
  }

  const companyDeals = deals.filter((d) => d.company_id === company.id);
  const everLinked = linkedContacts.length > 0 || companyDeals.length > 0;

  return (
    <>
      <div className="scrim show" onClick={onClose} />
      <aside className="panel show">
        <div className="panel-head">
          <div style={{ flex: 1, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16 }}>{company.name || "Untitled company"}</div>
          <button className="icon-btn panel-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="panel-body">
          {error && <div className="banner" style={{ color: "var(--blocked)", background: "var(--blocked-bg)" }}>{error}</div>}

          <div className="field-group">
            <label className="field-label">Name</label>
            <input
              className="text-input"
              defaultValue={company.name}
              placeholder="e.g. Acme Corp"
              onBlur={(e) => {
                const value = e.target.value.trim();
                if (value && value !== company.name) {
                  patchLocal({ name: value });
                  run(() => updateCompanyFields(company.id, { name: value }));
                }
              }}
            />
          </div>

          <div className="field-group">
            <label className="field-label">Domain</label>
            <input
              className="text-input"
              defaultValue={company.domain ?? ""}
              placeholder="e.g. acme.com"
              onBlur={(e) => {
                const value = e.target.value.trim() || null;
                patchLocal({ domain: value });
                run(() => updateCompanyFields(company.id, { domain: value }));
              }}
            />
          </div>

          <div className="field-group">
            <label className="field-label">Notes</label>
            <textarea
              className="text-input"
              rows={3}
              defaultValue={company.notes ?? ""}
              placeholder="Anything worth knowing about this account"
              onBlur={(e) => {
                const value = e.target.value.trim() || null;
                patchLocal({ notes: value });
                run(() => updateCompanyFields(company.id, { notes: value }));
              }}
            />
          </div>

          <div className="divider" />

          <div className="field-group">
            <label className="field-label">Contacts</label>
            {!contactsLoaded && <div className="empty-note">Loading…</div>}
            {contactsLoaded && linkedContacts.length === 0 && <div className="empty-note">No contacts linked yet.</div>}
            {linkedContacts.map((c) => (
              <div key={c.id} className="crumbline" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <span>{c.name || c.email || c.phone || "Unnamed contact"}</span>
                <button className="icon-btn" disabled={pending} onClick={() => unlinkContact(c.id)} aria-label="Unlink contact" title="Unlink">
                  ✕
                </button>
              </div>
            ))}
            {contactsLoaded && candidateContacts.length > 0 && (
              <div className="field-row" style={{ marginTop: 8 }}>
                <select className="select-input" style={{ flex: 1 }} value={pickedContactId} onChange={(e) => setPickedContactId(e.target.value)}>
                  <option value="">Link an existing contact…</option>
                  {candidateContacts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name || c.email || c.phone || "Unnamed contact"}
                    </option>
                  ))}
                </select>
                <button className="small-btn" disabled={!pickedContactId || pending} onClick={linkContact}>
                  Link
                </button>
              </div>
            )}
          </div>

          <div className="divider" />

          <div className="field-group">
            <label className="field-label">Deals</label>
            {companyDeals.length === 0 && <div className="empty-note">No deals for this company yet.</div>}
            {companyDeals.map((d) => {
              const outcome = dealOutcome(d, dealStatusesById);
              return (
                <div
                  key={d.id}
                  className="crumbline"
                  style={{ display: "flex", justifyContent: "space-between", cursor: "pointer", marginBottom: 4 }}
                  onClick={() => onSelectDeal(d.id)}
                >
                  <span>
                    {d.title} {outcome !== "open" && <span style={{ color: outcome === "won" ? "var(--accent)" : "var(--blocked)" }}>({outcome})</span>}
                  </span>
                  <span className="mono">{dealValueLabel(d)}</span>
                </div>
              );
            })}
          </div>

          <button
            className="small-btn"
            style={{ marginTop: 16, display: "inline-flex", alignItems: "center", gap: 6 }}
            disabled={everLinked || pending}
            title={everLinked ? "Unlink its contacts and deals first" : "Delete this company"}
            onClick={() => {
              if (confirm(`Delete "${company.name}"?`)) {
                setPending(true);
                setError(null);
                deleteCompany(company.id)
                  .then(() => {
                    onCompanyChange((prev) => prev.filter((c) => c.id !== company.id));
                    onClose();
                  })
                  .catch((err) => setError(err instanceof Error ? err.message : "Couldn't delete that company."))
                  .finally(() => setPending(false));
              }
            }}
          >
            Delete company
          </button>
        </div>
      </aside>
    </>
  );
}
