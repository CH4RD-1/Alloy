"use client";

import { useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { SketchCanvas } from "@/components/sketch-canvas";
import { CODE_LANGUAGES, buildCodeAttachmentMimeType } from "@/lib/code-highlight";

// The "editor that appears below the chat" — Sketch and Code share this file
// because they're the same idea from the user's own framing ("the sketch pad
// and code block have all the same functionality"): draw or type, then
// "Post" sends exactly one attachment to the conversation as its own
// message, same as picking a file with the ordinary 📎 Attach picker. Built
// for PortalTicketView (components/portal-ticket-view.tsx) — the internal
// task panel's own Conversation already has its file-based attach flow, and
// nothing in the request asked for this editor bar there too.
//
// Sketch reuses SketchCanvas (components/sketch-canvas.tsx) — the exact
// same engine SketchCard uses inside a task's Attachments — just with no
// per-stroke autosave (there's no task_object here to save to) and "Post"
// as the primary action instead of "Save as image". Code is a simpler
// language-picker + textarea, tagged with the synthetic
// text/x-code+<language> mime_type (see lib/code-highlight.ts) so the two
// message-attachment renderers know to show a code thumbnail instead of a
// generic download chip.
export function SketchComposer({ pending, onPost, onCancel }: { pending: boolean; onPost: (file: File) => void; onCancel: () => void }) {
  return (
    <div className="obj-card">
      <div className="obj-card-head">
        <span className="obj-type-label">Sketch</span>
        <button className="icon-btn" onClick={onCancel} disabled={pending} title="Close">
          ✕
        </button>
      </div>
      <SketchCanvas
        disabled={pending}
        primaryAction={{
          label: "Post",
          title: "Post this sketch to the conversation",
          onClick: (blob) => onPost(new File([blob], "sketch.png", { type: "image/png" })),
        }}
      />
    </div>
  );
}

export function CodeComposer({ pending, onPost, onCancel }: { pending: boolean; onPost: (file: File) => void; onCancel: () => void }) {
  const [code, setCode] = useState("");
  const [language, setLanguage] = useState("auto");

  function post() {
    if (!code.trim()) return;
    onPost(new File([code], "code.txt", { type: buildCodeAttachmentMimeType(language) }));
    setCode("");
  }

  function handleTab(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Tab") return;
    e.preventDefault();
    const el = e.currentTarget;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const next = el.value.slice(0, start) + "  " + el.value.slice(end);
    setCode(next);
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = start + 2;
    });
  }

  return (
    <div className="obj-card">
      <div className="obj-card-head">
        <span className="obj-type-label">Code block</span>
        <button className="icon-btn" onClick={onCancel} disabled={pending} title="Close">
          ✕
        </button>
      </div>
      <div className="code-block-toolbar">
        <select className="select-input code-lang-select" value={language} disabled={pending} onChange={(e) => setLanguage(e.target.value)}>
          {CODE_LANGUAGES.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </div>
      <textarea
        className="code-block-textarea"
        value={code}
        placeholder="Paste or type code…"
        spellCheck={false}
        disabled={pending}
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={handleTab}
      />
      <div className="sketch-actions">
        <button
          type="button"
          className="small-btn"
          style={{ marginLeft: "auto" }}
          onClick={post}
          disabled={pending || !code.trim()}
          title="Post this code block to the conversation"
        >
          Post
        </button>
      </div>
    </div>
  );
}
