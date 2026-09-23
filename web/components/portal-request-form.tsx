"use client";

import { useState, useTransition } from "react";
import type { FormTemplate } from "@/lib/types";
import { submitPortalRequest } from "@/lib/actions";

// Ported from the prototype's Portal request form (renderPortalView / the
// portalDraft state + submit-portal-request handler) — pick a template,
// fill it in, submit creates a new task. Unlike the prototype (one shared
// in-browser TASKS array, no real identity model), submission here goes
// through a server action that finds-or-creates a real Contact and lands
// the task in the org's helpdesk project when it has one. No live-chat
// widget — that was already a labeled placeholder with no real backend in
// the prototype, and isn't part of the actual ticket-intake path.
export function PortalRequestForm({
  orgId,
  templates,
  vocabTask,
  initialTitle,
}: {
  orgId: string;
  templates: FormTemplate[];
  vocabTask: string;
  initialTitle?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [templateId, setTemplateId] = useState("");
  const [requesterName, setRequesterName] = useState("");
  const [requesterEmail, setRequesterEmail] = useState("");
  const [title, setTitle] = useState(initialTitle ?? "");
  const [description, setDescription] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const [portalAccessToken, setPortalAccessToken] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const template = templates.find((t) => t.id === templateId);
  const taskNoun = vocabTask.toLowerCase();

  function reset() {
    setTemplateId("");
    setRequesterName("");
    setRequesterEmail("");
    setTitle("");
    setDescription("");
    setValues({});
    setSubmitted(false);
    setPortalAccessToken(null);
    setError(null);
  }

  function submit() {
    if (!template) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await submitPortalRequest({
          orgId,
          templateId: template.id,
          requesterName,
          requesterEmail,
          title,
          description,
          values,
        });
        setPortalAccessToken(result.portalAccessToken);
        setSubmitted(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      }
    });
  }

  if (submitted) {
    const trackingUrl = portalAccessToken && typeof window !== "undefined" ? `${window.location.origin}/portal/ticket/${portalAccessToken}` : null;
    return (
      <div className="portal-card">
        <div className="banner">Thanks — your submission was received and created a new {taskNoun}.</div>
        {trackingUrl && (
          <div style={{ marginTop: 10 }}>
            <div className="field-label">Bookmark this link to check progress or add a reply later — no account needed:</div>
            <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center", flexWrap: "wrap" }}>
              <input className="text-input mono" readOnly value={trackingUrl} onFocus={(e) => e.target.select()} style={{ flex: 1, minWidth: 200 }} />
              <button
                type="button"
                className="small-btn"
                onClick={() => {
                  navigator.clipboard?.writeText(trackingUrl).then(
                    () => {
                      setLinkCopied(true);
                      setTimeout(() => setLinkCopied(false), 2000);
                    },
                    () => {}
                  );
                }}
              >
                {linkCopied ? "Copied!" : "Copy link"}
              </button>
            </div>
          </div>
        )}
        <button type="button" className="small-btn" style={{ marginTop: 10 }} onClick={reset}>
          Submit another request
        </button>
      </div>
    );
  }

  if (templates.length === 0) {
    return (
      <div className="portal-card">
        <div className="field-label">What kind of request is this?</div>
        <p style={{ color: "var(--text-muted)", fontSize: 13 }}>No request forms are set up yet — check back later.</p>
      </div>
    );
  }

  return (
    <div className="portal-card">
      {error && <div className="banner" style={{ color: "var(--blocked)", background: "var(--blocked-bg)" }}>{error}</div>}

      <div className="field-group">
        <span className="field-label">What kind of request is this?</span>
        <select className="select-input" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
          <option value="">Select a template…</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>

      {template ? (
        <>
          <div className="field-group">
            <span className="field-label">Your name</span>
            <input className="text-input" value={requesterName} onChange={(e) => setRequesterName(e.target.value)} placeholder="Your name" />
          </div>
          <div className="field-group">
            <span className="field-label">Your email</span>
            <input
              className="text-input"
              type="email"
              value={requesterEmail}
              onChange={(e) => setRequesterEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </div>
          <div className="field-group">
            <span className="field-label">Short summary</span>
            <input className="text-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Laptop won't turn on" />
          </div>
          <div className="field-group">
            <span className="field-label">Description</span>
            <textarea
              className="text-input obj-textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="More detail about what's happening…"
            />
          </div>

          {template.fields.length === 0 ? (
            <p className="crumbline">This template has no fields yet.</p>
          ) : (
            template.fields.map((f) => (
              <div key={f.id} className="field-group">
                <span className="field-label">{f.label}</span>
                {f.type === "select" ? (
                  <select
                    className="select-input"
                    value={values[f.id] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
                  >
                    <option value="">—</option>
                    {(f.options ?? []).map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : f.type === "paragraph" ? (
                  <textarea
                    className="text-input"
                    placeholder={f.label}
                    value={values[f.id] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
                  />
                ) : f.type === "number" ? (
                  <input
                    className="text-input mono"
                    type="number"
                    value={values[f.id] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
                  />
                ) : f.type === "date" ? (
                  <input
                    className="text-input mono"
                    type="date"
                    value={values[f.id] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
                  />
                ) : f.type === "yes_no" ? (
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={values[f.id] === "true"}
                      onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.checked ? "true" : "false" }))}
                    />
                    <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{values[f.id] === "true" ? "Yes" : "No"}</span>
                  </label>
                ) : (
                  <input
                    className="text-input"
                    type="text"
                    value={values[f.id] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
                  />
                )}
              </div>
            ))
          )}

          <button type="button" className="primary-btn" style={{ width: "100%", padding: 9, marginTop: 6 }} disabled={pending} onClick={submit}>
            {pending ? "Submitting…" : "Submit request"}
          </button>
        </>
      ) : (
        <p className="crumbline">Choose a template above to continue.</p>
      )}
    </div>
  );
}
