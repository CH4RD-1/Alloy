"use client";

import { useState } from "react";
import type { Company, Contact, Deal, WorkflowStatus } from "@/lib/types";
import { updateContactFields, deleteContact } from "@/lib/actions";
import { contactLabel, dealOutcome, dealValueLabel } from "@/lib/crm-view";

// CRM Phase C — mirrors components/company-panel.tsx's shape (fields save on
// blur/change, a divider, then a linked-deals section, then delete) since a
// Contact's own links are simpler than a Company's: company_id lives
// directly on the contact row (a plain select, same as DealPanel's own
// Company select), so there's no separate link/unlink picker flow to build
// the way CompanyPanel needed for its reverse direction.
export function ContactPanel({
  contact,
  companies,
  deals,
  dealStatusesById,
  onContactChange,
  onSelectCompany,
  onSelectDeal,
  onClose,
}: {
  contact: Contact;
  companies: Company[];
  deals: Deal[];
  dealStatusesById: Map<string, WorkflowStatus>;
  onContactChange: (updater: (prev: Contact[]) => Contact[]) => void;
  onSelectCompany: (id: string) => void;
  onSelectDeal: (id: string) => void;
  onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function run(action: () => Promise<unknown>) {
    setError(null);
    setPending(true);
    action()
      .catch((err) => setError(err instanceof Error ? err.message : "Something went wrong."))
      .finally(() => setPending(false));
  }

  function patchLocal(patch: Partial<Contact>) {
    onContactChange((prev) => prev.map((c) => (c.id === contact.id ? { ...c, ...patch } : c)));
  }

  const company = contact.company_id ? companies.find((c) => c.id === contact.company_id) : undefined;
  const contactDeals = deals.filter((d) => d.primary_contact_id === contact.id);

  return (
    <>
      <div className="scrim show" onClick={onClose} />
      <aside className="panel show">
        <div className="panel-head">
          <div style={{ flex: 1, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16 }}>{contactLabel(contact)}</div>
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
              defaultValue={contact.name ?? ""}
              placeholder="e.g. Jane Smith"
              onBlur={(e) => {
                const value = e.target.value.trim() || null;
                if (value !== contact.name) {
                  patchLocal({ name: value });
                  run(() => updateContactFields(contact.id, { name: value }));
                }
              }}
            />
          </div>

          <div className="field-group">
            <label className="field-label">Email</label>
            <input
              className="text-input"
              type="email"
              defaultValue={contact.email ?? ""}
              placeholder="e.g. jane@acme.com"
              onBlur={(e) => {
                const value = e.target.value.trim() || null;
                if (value !== contact.email) {
                  patchLocal({ email: value });
                  run(() => updateContactFields(contact.id, { email: value }));
                }
              }}
            />
          </div>

          <div className="field-group">
            <label className="field-label">Phone</label>
            <input
              className="text-input"
              defaultValue={contact.phone ?? ""}
              placeholder="e.g. +14155551234"
              onBlur={(e) => {
                const value = e.target.value.trim() || null;
                if (value !== contact.phone) {
                  patchLocal({ phone: value });
                  run(() => updateContactFields(contact.id, { phone: value }));
                }
              }}
            />
          </div>

          <div className="field-group">
            <label className="field-label">Company</label>
            <select
              className="select-input"
              value={contact.company_id ?? ""}
              onChange={(e) => {
                const companyId = e.target.value || null;
                patchLocal({ company_id: companyId });
                run(() => updateContactFields(contact.id, { company_id: companyId }));
              }}
            >
              <option value="">No company</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {company && (
              <button
                className="crumbline"
                style={{ marginTop: 4, background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}
                onClick={() => onSelectCompany(company.id)}
              >
                View {company.name} →
              </button>
            )}
          </div>

          <div className="field-group">
            <label className="field-label">Notes</label>
            <textarea
              className="text-input"
              rows={3}
              defaultValue={contact.notes ?? ""}
              placeholder="Anything worth knowing about this person"
              onBlur={(e) => {
                const value = e.target.value.trim() || null;
                if (value !== contact.notes) {
                  patchLocal({ notes: value });
                  run(() => updateContactFields(contact.id, { notes: value }));
                }
              }}
            />
          </div>

          <div className="divider" />

          <div className="field-group">
            <label className="field-label">Deals</label>
            {contactDeals.length === 0 && <div className="empty-note">No deals with this contact yet.</div>}
            {contactDeals.map((d) => {
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
            disabled={contactDeals.length > 0 || pending}
            title={contactDeals.length > 0 ? "Unlink its deals first" : "Delete this contact"}
            onClick={() => {
              if (confirm(`Delete "${contactLabel(contact)}"?`)) {
                setPending(true);
                setError(null);
                deleteContact(contact.id)
                  .then(() => {
                    onContactChange((prev) => prev.filter((c) => c.id !== contact.id));
                    onClose();
                  })
                  .catch((err) => setError(err instanceof Error ? err.message : "Couldn't delete that contact."))
                  .finally(() => setPending(false));
              }
            }}
          >
            Delete contact
          </button>
        </div>
      </aside>
    </>
  );
}
