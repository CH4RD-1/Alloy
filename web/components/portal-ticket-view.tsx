"use client";

import { useState, useTransition } from "react";
import { addPortalTicketReply, attachPortalTicketMessageFile } from "@/lib/actions";
import { firstResponseTarget, resolutionTarget, formatDuration } from "@/lib/sla";
import { StatusChip } from "@/components/task-list-view";
import { isCodeAttachmentMimeType } from "@/lib/code-highlight";
import { CodeAttachmentThumb } from "@/components/code-attachment-viewer";
import { SketchComposer, CodeComposer } from "@/components/chat-editors";

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
  messages: {
    id: string;
    direction: "inbound" | "outbound";
    body: string;
    createdAt: string;
    attachments: { id: string; filename: string; mimeType: string | null; sizeBytes: number | null; url: string | null }[];
  }[];
}

// The "come back later, no account" half of the Portal — the page a
// customer lands on from their per-ticket magic link (see lib/actions.ts's
// getPortalTicketByToken/addPortalTicketReply/attachPortalTicketMessageFile
// and schema.sql's own comment on tasks.portal_access_token). Deliberately
// read-mostly and narrow: it shows status + the public conversation and
// lets them add a reply, same shape as the internal task panel's own
// "Preview as customer" view. Attachments work the same way as the staff
// side's ConversationSection (components/task-panel.tsx) — stage files,
// send the reply, then upload each staged file keyed to the new message's
// id — just through the token-authenticated, service-role action instead
// of a signed-in one.
export function PortalTicketView({ ticket, token }: { ticket: PortalTicket; token: string }) {
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState("");
  const [draftFiles, setDraftFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState(ticket.messages);
  const [openEditor, setOpenEditor] = useState<"sketch" | "code" | null>(null);

  function submit() {
    const body = draft.trim();
    if (!body && draftFiles.length === 0) return;
    setError(null);
    startTransition(async () => {
      try {
        const messageId = await addPortalTicketReply(token, body);
        for (const file of draftFiles) {
          const formData = new FormData();
          formData.append("file", file);
          await attachPortalTicketMessageFile(token, messageId, formData);
        }
        // Optimistic local append — the server action also revalidates this
        // path, but that only refetches on the next navigation/router
        // action; this keeps the reply visible immediately without one.
        // Staged files aren't reflected here (no signed URL yet for a
        // freshly-uploaded file) — they'll appear once the page revalidates.
        setMessages((prev) => [...prev, { id: `local-${Date.now()}`, direction: "inbound" as const, body, createdAt: new Date().toISOString(), attachments: [] }]);
        setDraft("");
        setDraftFiles([]);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong sending that.");
      }
    });
  }

  // Posting a sketch or code block from the editor bar below the chat is its
  // own message rather than another staged file on the reply draft — "Post"
  // reads as immediate, matching the sketch pad's own "Save image" ->
  // "Post" rename the user asked for. Unlike a staged file's attachments
  // (left empty until the next revalidation — see submit()'s own comment),
  // this uses a local object URL as the attachment's `url` right away, since
  // seeing the thumbnail land in the chat immediately is the whole point.
  function postAttachment(file: File) {
    setError(null);
    startTransition(async () => {
      try {
        const messageId = await addPortalTicketReply(token, "");
        const formData = new FormData();
        formData.append("file", file);
        await attachPortalTicketMessageFile(token, messageId, formData);
        const previewUrl = URL.createObjectURL(file);
        setMessages((prev) => [
          ...prev,
          {
            id: `local-${Date.now()}`,
            direction: "inbound" as const,
            body: "",
            createdAt: new Date().toISOString(),
            attachments: [{ id: `local-attachment-${Date.now()}`, filename: file.name, mimeType: file.type || null, sizeBytes: file.size, url: previewUrl }],
          },
        ]);
        setOpenEditor(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong posting that.");
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
              {m.body && <div className="conversation-body">{m.body}</div>}
              <PortalMessageAttachments attachments={m.attachments} />
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
      <div className="conversation-file-picker">
        <label className="ghost-btn conversation-attach-btn">
          📎 Attach
          <input
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              if (picked.length) setDraftFiles((prev) => [...prev, ...picked]);
              e.target.value = "";
            }}
          />
        </label>
        {draftFiles.map((f, i) => (
          <span key={`${f.name}-${i}`} className="conversation-staged-file">
            {f.name}
            <button
              type="button"
              className="conversation-staged-file-remove"
              onClick={() => setDraftFiles((prev) => prev.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </span>
        ))}
      </div>
      <button
        type="button"
        className="primary-btn"
        style={{ marginTop: 6 }}
        disabled={(!draft.trim() && draftFiles.length === 0) || pending}
        onClick={submit}
      >
        {pending ? "Sending…" : "Send reply"}
      </button>

      <div className="obj-add-row" style={{ marginTop: 10, display: "flex", gap: 6 }}>
        <button
          type="button"
          className={`ghost-btn small-btn ${openEditor === "sketch" ? "active" : ""}`}
          onClick={() => setOpenEditor((v) => (v === "sketch" ? null : "sketch"))}
          disabled={pending}
        >
          🖊 Sketch
        </button>
        <button
          type="button"
          className={`ghost-btn small-btn ${openEditor === "code" ? "active" : ""}`}
          onClick={() => setOpenEditor((v) => (v === "code" ? null : "code"))}
          disabled={pending}
        >
          {"</>"} Code
        </button>
      </div>
      {openEditor === "sketch" && <SketchComposer pending={pending} onPost={postAttachment} onCancel={() => setOpenEditor(null)} />}
      {openEditor === "code" && <CodeComposer pending={pending} onPost={postAttachment} onCancel={() => setOpenEditor(null)} />}
    </div>
  );
}

// Portal-side counterpart to MessageAttachments (components/task-panel.tsx)
// — same image-thumbnail-or-download-chip rendering, just against the plain
// {filename, mimeType, sizeBytes, url} shape getPortalTicketByToken returns
// rather than the internal TicketMessageAttachment row type.
function PortalMessageAttachments({
  attachments,
}: {
  attachments: { id: string; filename: string; mimeType: string | null; sizeBytes: number | null; url: string | null }[];
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="conversation-attachments">
      {attachments.map((a) => {
        const isImage = (a.mimeType ?? "").startsWith("image/");
        const sizeLabel = a.sizeBytes ? `${Math.max(1, Math.round(a.sizeBytes / 1024))} KB` : "";
        if (isImage && a.url) {
          return (
            <a key={a.id} href={a.url} target="_blank" rel="noreferrer" className="conversation-attachment-thumb-link">
              <img src={a.url} alt={a.filename} className="conversation-attachment-thumb" />
            </a>
          );
        }
        if (isCodeAttachmentMimeType(a.mimeType)) {
          return <CodeAttachmentThumb key={a.id} url={a.url} filename={a.filename} mimeType={a.mimeType} />;
        }
        return a.url ? (
          <a key={a.id} href={a.url} target="_blank" rel="noreferrer" className="conversation-attachment-chip">
            📎 {a.filename} {sizeLabel && <span className="conversation-attachment-size">({sizeLabel})</span>}
          </a>
        ) : (
          <span key={a.id} className="conversation-attachment-chip conversation-attachment-chip-broken">
            📎 {a.filename}
          </span>
        );
      })}
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
