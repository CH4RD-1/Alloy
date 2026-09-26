"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Deal, Company, Contact, WorkflowStatus, DealActivityLogEntry } from "@/lib/types";
import type { MemberSummary } from "@/lib/tasks-data";
import { updateDealFields, updateDealStage, deleteDeal, getOrgContactsData, getDealActivityLog } from "@/lib/actions";
import { CURRENCIES, dealOutcome } from "@/lib/crm-view";
import { DateGuideField } from "@/components/date-guide-field";
import { hueFor, initials } from "@/lib/list-view";
import { dealActivitySummary, timeAgo } from "@/lib/activity-view";

// A Phase A/B leftover — read-only, same avatar + bolded-name-plus-verb +
// relative-time layout as task-panel.tsx's own ActivitySection, just fed
// from deal_activity_log instead of activity_log. `entries` arrives already
// sorted most-recent-first (see getDealActivityLog) and pre-filtered to
// this one deal (deal_id in the query).
function DealActivitySection({
  entries,
  dealStatuses,
  members,
}: {
  entries: DealActivityLogEntry[];
  dealStatuses: WorkflowStatus[];
  members: MemberSummary[];
}) {
  const statusLabelById = new Map(dealStatuses.map((s) => [s.id, s.label]));
  const memberNameById = new Map(members.map((m) => [m.userId, m.name]));

  return (
    <div className="field-group">
      <span className="field-label">Activity</span>
      {entries.length === 0 ? (
        <div className="crumbline">No activity yet — moves show up here as they happen.</div>
      ) : (
        entries.map((a) => {
          const name = (a.actor_user_id && memberNameById.get(a.actor_user_id)) || "Unknown";
          const hue = hueFor(name);
          return (
            <div key={a.id} className="activity-item">
              <span className="avatar" style={{ background: `hsl(${hue} 45% 45%)` }} title={name}>
                {initials(name)}
              </span>
              <div>
                <div className="activity-text">
                  <strong>{name}</strong> {dealActivitySummary(a, statusLabelById)}
                </div>
                <div className="activity-time">{timeAgo(a.created_at)}</div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

// CRM Phase A — mirrors components/asset-panel.tsx's field-saves-on-blur
// shape. Stage is a select rather than drag-and-drop here (the kanban in
// components/deals-view.tsx is the drag surface); both call the same
// updateDealStage action so the two stay in sync however a deal gets moved.
export function DealPanel({
  deal,
  companies,
  members,
  dealStatuses,
  dealStatusesById,
  onDealChange,
  onSelectCompany,
  onClose,
}: {
  deal: Deal;
  companies: Company[];
  members: MemberSummary[];
  dealStatuses: WorkflowStatus[];
  dealStatusesById: Map<string, WorkflowStatus>;
  onDealChange: (updater: (prev: Deal[]) => Deal[]) => void;
  onSelectCompany: (id: string) => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [activity, setActivity] = useState<DealActivityLogEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    getOrgContactsData(deal.org_id).then((all) => {
      if (!cancelled) setContacts(all);
    });
    return () => {
      cancelled = true;
    };
  }, [deal.org_id]);

  // Fetched on demand rather than held in the Deals tab's own local state
  // (see getDealActivityLog's own comment) — re-fetched whenever a
  // different deal's panel opens, and again right after a stage move below
  // so the new entry shows up without waiting for the next full reopen.
  useEffect(() => {
    let cancelled = false;
    getDealActivityLog(deal.id).then((entries) => {
      if (!cancelled) setActivity(entries);
    });
    return () => {
      cancelled = true;
    };
  }, [deal.id]);

  function patchLocal(patch: Partial<Deal>) {
    onDealChange((prev) => prev.map((d) => (d.id === deal.id ? { ...d, ...patch } : d)));
  }

  function run(action: () => Promise<unknown>) {
    setError(null);
    setPending(true);
    action()
      .catch((err) => setError(err instanceof Error ? err.message : "Something went wrong."))
      .finally(() => setPending(false));
  }

  const outcome = dealOutcome(deal, dealStatusesById);
  const orderedStatuses = [...dealStatuses].sort((a, b) => a.position - b.position);
  const company = deal.company_id ? companies.find((c) => c.id === deal.company_id) : undefined;
  const contactsForCompany = deal.company_id ? contacts.filter((c) => c.company_id === deal.company_id) : contacts;

  return (
    <>
      <div className="scrim show" onClick={onClose} />
      <aside className="panel show">
        <div className="panel-head">
          <div style={{ flex: 1, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16 }}>{deal.title || "Untitled deal"}</div>
          <button className="icon-btn panel-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="panel-body">
          {error && <div className="banner" style={{ color: "var(--blocked)", background: "var(--blocked-bg)" }}>{error}</div>}

          <div className="field-group">
            <span
              className="chip status-chip"
              style={{ color: dealStatusesById.get(deal.status_id)?.color, background: "var(--surface-2, #f1f1f1)" }}
            >
              {dealStatusesById.get(deal.status_id)?.label ?? "Unknown stage"}
              {outcome !== "open" && ` · ${outcome}`}
            </span>
          </div>

          <div className="field-group">
            <label className="field-label">Title</label>
            <input
              className="text-input"
              defaultValue={deal.title}
              onBlur={(e) => {
                const value = e.target.value.trim();
                if (value && value !== deal.title) {
                  patchLocal({ title: value });
                  run(() => updateDealFields(deal.id, { title: value }));
                }
              }}
            />
          </div>

          <div className="field-group">
            <label className="field-label">Stage</label>
            <select
              className="select-input"
              value={deal.status_id}
              onChange={(e) => {
                const statusId = e.target.value;
                patchLocal({ status_id: statusId });
                // See deals-view.tsx's own comment on handleDrop — a
                // configured transition automation can touch tasks, which
                // still needs a full refresh to show up.
                run(async () => {
                  const { affectedTasks } = await updateDealStage(deal.id, statusId);
                  if (affectedTasks) router.refresh();
                  getDealActivityLog(deal.id).then(setActivity);
                });
              }}
            >
              {orderedStatuses.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field-group">
            <label className="field-label">Company</label>
            <select
              className="select-input"
              value={deal.company_id ?? ""}
              onChange={(e) => {
                const companyId = e.target.value || null;
                patchLocal({ company_id: companyId, primary_contact_id: null });
                run(() => updateDealFields(deal.id, { company_id: companyId, primary_contact_id: null }));
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
              <button className="crumbline" style={{ marginTop: 4, background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }} onClick={() => onSelectCompany(company.id)}>
                View {company.name} →
              </button>
            )}
          </div>

          <div className="field-group">
            <label className="field-label">Primary contact</label>
            <select
              className="select-input"
              value={deal.primary_contact_id ?? ""}
              onChange={(e) => {
                const contactId = e.target.value || null;
                patchLocal({ primary_contact_id: contactId });
                run(() => updateDealFields(deal.id, { primary_contact_id: contactId }));
              }}
            >
              <option value="">No contact</option>
              {contactsForCompany.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name || c.email || c.phone || "Unnamed contact"}
                </option>
              ))}
            </select>
          </div>

          <div className="field-group">
            <label className="field-label">Owner</label>
            <select
              className="select-input"
              value={deal.owner_user_id ?? ""}
              onChange={(e) => {
                const ownerId = e.target.value || null;
                patchLocal({ owner_user_id: ownerId });
                run(() => updateDealFields(deal.id, { owner_user_id: ownerId }));
              }}
            >
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                  {m.isDummy ? " (Dummy)" : ""}
                </option>
              ))}
            </select>
          </div>

          <div className="field-row">
            <div className="field-group" style={{ flex: 1 }}>
              <label className="field-label">Value</label>
              <input
                className="text-input mono"
                type="number"
                min={0}
                step="0.01"
                defaultValue={deal.value ?? ""}
                placeholder="0.00"
                onBlur={(e) => {
                  const value = e.target.value === "" ? null : Number(e.target.value);
                  patchLocal({ value });
                  run(() => updateDealFields(deal.id, { value }));
                }}
              />
            </div>
            <div className="field-group" style={{ flex: 1 }}>
              <label className="field-label">Currency</label>
              <select
                className="select-input"
                value={deal.currency}
                onChange={(e) => {
                  const currency = e.target.value;
                  patchLocal({ currency });
                  run(() => updateDealFields(deal.id, { currency }));
                }}
              >
                {CURRENCIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="field-group">
            <label className="field-label">Expected close date</label>
            <DateGuideField
              value={deal.expected_close_date ?? ""}
              onChange={(iso) => {
                const value = iso || null;
                patchLocal({ expected_close_date: value });
                run(() => updateDealFields(deal.id, { expected_close_date: value }));
              }}
            />
          </div>

          <DealActivitySection entries={activity} dealStatuses={dealStatuses} members={members} />

          <button
            className="small-btn"
            style={{ marginTop: 16, display: "inline-flex", alignItems: "center", gap: 6 }}
            disabled={pending}
            onClick={() => {
              if (confirm(`Delete "${deal.title}"?`)) {
                setPending(true);
                setError(null);
                deleteDeal(deal.id)
                  .then(() => {
                    onDealChange((prev) => prev.filter((d) => d.id !== deal.id));
                    onClose();
                  })
                  .catch((err) => setError(err instanceof Error ? err.message : "Couldn't delete that deal."))
                  .finally(() => setPending(false));
              }
            }}
          >
            Delete deal
          </button>
        </div>
      </aside>
    </>
  );
}
