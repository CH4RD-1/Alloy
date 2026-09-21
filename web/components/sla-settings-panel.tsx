"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Role } from "@/lib/types";
import { updateOrgSlaTargets } from "@/lib/actions";

// New sidebar menu item ("SLA settings") — the 2 org-wide targets every
// Helpdesk ticket's task panel (components/task-panel.tsx's SlaTimer)
// counts down against. One global pair for the whole org rather than
// per-project, matching how this was requested — see schema.sql's own
// comment on orgs.sla_first_response_hours/sla_resolution_days and
// lib/sla.ts for the working-hours-vs-calendar-days distinction. Same
// one-concern-per-panel pattern as Projects/Teams/Custom fields/Workflow &
// roles, gated to owner/admin like the Organization panel's own
// Team-allocation toggle.
export function SlaSettingsPanel({
  orgId,
  slaFirstResponseHours,
  slaResolutionDays,
  currentUserRole,
  onClose,
}: {
  orgId: string;
  slaFirstResponseHours: number;
  slaResolutionDays: number;
  currentUserRole: Role;
  onClose: () => void;
}) {
  const canManage = currentUserRole === "owner" || currentUserRole === "admin";
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [firstResponse, setFirstResponse] = useState(String(slaFirstResponseHours));
  const [resolution, setResolution] = useState(String(slaResolutionDays));

  const dirty = firstResponse !== String(slaFirstResponseHours) || resolution !== String(slaResolutionDays);

  function save() {
    const fr = Number(firstResponse);
    const rd = Number(resolution);
    if (!Number.isFinite(fr) || fr <= 0 || !Number.isFinite(rd) || rd <= 0) {
      setError("Both targets need to be positive numbers.");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await updateOrgSlaTargets(orgId, { firstResponseHours: fr, resolutionDays: rd });
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      }
    });
  }

  return (
    <>
      <div className="scrim show" onClick={onClose} />
      <aside className="panel show panel-left">
        <div className="panel-head">
          <div style={{ flex: 1, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16 }}>SLA settings</div>
          <button className="icon-btn panel-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="panel-body">
          {error && <div className="banner" style={{ color: "var(--blocked)", background: "var(--blocked-bg)" }}>{error}</div>}

          <p style={{ color: "var(--text-faint)", fontSize: 12, marginBottom: 12 }}>
            Every Helpdesk ticket&apos;s task panel shows a live countdown against these two targets, measured from the
            moment the ticket was raised, in place of the usual Start/Due dates.
          </p>

          {!canManage ? (
            <p style={{ color: "var(--text-faint)", fontSize: 12 }}>Only an owner or admin can change this.</p>
          ) : (
            <>
              <div className="field-group">
                <label className="field-label">Time to first response</label>
                <div className="field-row">
                  <input
                    className="text-input mono"
                    type="number"
                    min={1}
                    step={1}
                    value={firstResponse}
                    onChange={(e) => setFirstResponse(e.target.value)}
                  />
                  <span style={{ color: "var(--text-faint)", fontSize: 12.5, alignSelf: "center", whiteSpace: "nowrap" }}>
                    working hours
                  </span>
                </div>
                <p style={{ color: "var(--text-faint)", fontSize: 11.5, marginTop: 4 }}>
                  Counted Mon–Fri, 09:00–17:00 (UTC — there&apos;s no per-org timezone setting yet). Met by the first
                  public reply sent on a ticket.
                </p>
              </div>

              <div className="divider" />

              <div className="field-group">
                <label className="field-label">Time to resolution</label>
                <div className="field-row">
                  <input
                    className="text-input mono"
                    type="number"
                    min={1}
                    step={1}
                    value={resolution}
                    onChange={(e) => setResolution(e.target.value)}
                  />
                  <span style={{ color: "var(--text-faint)", fontSize: 12.5, alignSelf: "center", whiteSpace: "nowrap" }}>days</span>
                </div>
                <p style={{ color: "var(--text-faint)", fontSize: 11.5, marginTop: 4 }}>
                  Counted as plain calendar time, not working hours. Met the first time the ticket is marked Done.
                </p>
              </div>

              <button
                className="primary-btn"
                style={{ width: "100%", padding: 9, marginTop: 16 }}
                disabled={!dirty || pending}
                onClick={save}
              >
                Save
              </button>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
