"use client";

import { useState, useTransition } from "react";
import { addPortalTicketReply } from "@/lib/actions";
import { firstResponseTarget, resolutionTarget, formatDuration } from "@/lib/sla";
import { StatusChip } from "@/components/task-list-view";

export interface PortalTicket {
  taskId: string;
  displayId: string | null;
  title: string;
  createdAt: string;
  contactName: string | null;
  orgName: string;
  isHelpdesk: boolean;
  slaFirstResponseHours: number | null;
  slaResolutionDays: number | null;
  status: { label: string; color: string; key: string; isClosed: boolean };
  resolvedAt: string | null;
  messages: { id: string; direction: "inbound" | "outbound"; body: string; createdAt: string }[];
}

// The "come back later, no account" half of the Portal — the page a
// customer lands on from their per-ticket magic link (see lib/actions.ts's
// getPortalTicketByToken/addPortalTicketReply and schema.sql's own comment
// on tasks.portal_access_token). Deliberately read-mostly and narrow: it
// shows status + the public conversation and lets them add a reply, same
// shape as the internal task panel's own "Preview as customer" view, but
// there's no equivalent yet of attaching a file from this side (disclosed
// gap — the internal task panel's attachments live in a private Storage
// path this route doesn't have a safe upload story for yet).
export function PortalTicketView({ ticket, token }: { ticket: PortalTicket; token: string }) {
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState(ticket.messages);

  function submit() {
    const body = draft.trim();
    if (!body) return;
    setError(null);
    startTransition(async () => {
      try {
        await addPortalTicketReply(token, body);
        // Optimistic local append — the server action also revalidates this
        // path, but that only refetches on the next navigation/router
        // action; this keeps the reply visible immediately without one.
        setMessages((prev) => [...prev, { id: `local-${Date.now()}`, direction: "inbound" as const, body, createdAt: new Date().toISOString() }]);
        setDraft("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong sending that.");
      }
    });
  }

  const sorted = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return (
    <div className="portal-card">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <div>
          {ticket.displayId && <span className="mono" style={{ color: "var(--text-muted)", fontSize: 12 }}>{ticket.displayId}</span>}
          <h2 style={{ fontSize: 18, fontWeight: 600, margin: "2px 0 0" }}>{ticket.title}</h2>
        </div>
        <StatusChip statusKey={ticket.status.key} label={ticket.status.label} color={ticket.status.color} />
      </div>

      <div className="crumbline" style={{ marginTop: 8 }}>
        Raised {new Date(ticket.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
        {ticket.contactName && ` by ${ticket.contactName}`}
      </div>

      {ticket.isHelpdesk && ticket.slaFirstResponseHours != null && ticket.slaResolutionDays != null && (
        <div style={{ marginTop: 12 }}>
          <PortalSlaTimer
            label="Time to first response"
            raisedAt={ticket.createdAt}
            targetAt={firstResponseTarget(ticket.createdAt, ticket.slaFirstResponseHours)}
            completedAt={sorted.find((m) => m.direction === "outbound")?.createdAt ?? null}
            completedVerb="Responded"
          />
          <PortalSlaTimer
            label="Time to resolution"
            raisedAt={ticket.createdAt}
            targetAt={resolutionTarget(ticket.createdAt, ticket.slaResolutionDays)}
            completedAt={ticket.resolvedAt}
            completedVerb="Resolved"
          />
        </div>
      )}

      <div className="field-label" style={{ marginTop: 16 }}>
        Conversation
      </div>
      {sorted.length === 0 ? (
        <div className="crumbline">No messages yet.</div>
      ) : (
        <div className="conversation-thread">
          {sorted.map((m) => (
            <div
              key={m.id}
              className={"conversation-bubble " + (m.direction === "inbound" ? "conversation-outbound" : "conversation-inbound")}
            >
              <div className="conversation-meta">
                <strong>{m.direction === "inbound" ? ticket.contactName || "You" : ticket.orgName}</strong>
                <span>{new Date(m.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</span>
              </div>
              <div className="conversation-body">{m.body}</div>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="banner" style={{ color: "var(--blocked)", background: "var(--blocked-bg)", marginTop: 8 }}>
          {error}
        </div>
      )}

      <div className="add-inline" style={{ marginTop: 8, alignItems: "flex-start" }}>
        <textarea
          className="text-input"
          rows={2}
          placeholder="Add a reply…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      </div>
      <button type="button" className="primary-btn" style={{ marginTop: 6 }} disabled={!draft.trim() || pending} onClick={submit}>
        {pending ? "Sending…" : "Send reply"}
      </button>
    </div>
  );
}

// A read-only, non-ticking variant of the internal task panel's SlaTimer
// (components/task-panel.tsx) — customer-facing copy, and no live 30s tick
// since this page isn't kept open the way a staff member's task panel is;
// a manual refresh is enough for a "check back later" page. Logic (target
// math, on-time flagging) is identical, just re-rendered from a static
// `now` taken once per page load rather than a ticking one.
function PortalSlaTimer({
  label,
  raisedAt,
  targetAt,
  completedAt,
  completedVerb,
}: {
  label: string;
  raisedAt: string;
  targetAt: Date;
  completedAt: string | null;
  completedVerb: string;
}) {
  const [now] = useState(() => Date.now());

  if (completedAt) {
    const tookMs = new Date(completedAt).getTime() - new Date(raisedAt).getTime();
    const metOnTime = new Date(completedAt).getTime() <= targetAt.getTime();
    return (
      <div style={{ marginBottom: 8 }}>
        <div className="crumbline" style={{ marginBottom: 2 }}>
          {label}
        </div>
        <span className={"chip sla-chip " + (metOnTime ? "sla-chip-met" : "sla-chip-breached")}>
          {completedVerb} in {formatDuration(tookMs)} · {metOnTime ? "within SLA" : "SLA missed"}
        </span>
      </div>
    );
  }

  const diff = targetAt.getTime() - now;
  const overdue = diff < 0;
  return (
    <div style={{ marginBottom: 8 }}>
      <div className="crumbline" style={{ marginBottom: 2 }}>
        {label}
      </div>
      <span className={"chip sla-chip " + (overdue ? "sla-chip-breached" : "sla-chip-pending")}>
        {overdue ? `Overdue by ${formatDuration(-diff)}` : `Due in ${formatDuration(diff)}`}
      </span>
    </div>
  );
}
