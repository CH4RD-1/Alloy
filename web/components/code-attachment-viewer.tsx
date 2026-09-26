"use client";

import { useEffect, useState } from "react";
import { highlightCode, parseCodeAttachmentLanguage, CODE_LANGUAGES } from "@/lib/code-highlight";

// A code block "posted" from CodeComposer (below the Portal/Ticket chat)
// lands in ticket_message_attachments exactly like a normal file upload —
// see the mime_type convention in lib/code-highlight.ts — so this is the
// other half of that convention: MessageAttachments (task-panel.tsx) and
// PortalMessageAttachments (portal-ticket-view.tsx) both render this same
// self-contained thumbnail-plus-modal in place of the generic file chip
// whenever a message attachment's mime_type matches, so the "opens each end
// portal and ticket as the editor style" behavior the user asked for is one
// component rather than two near-duplicates. Read-only — reusing
// highlightCode() the same way CodeCard does, just against fetched text
// instead of local state, since the code itself lives in Storage, not in
// a task_objects.content row.
export function CodeAttachmentThumb({ url, filename, mimeType }: { url: string | null; filename: string; mimeType: string | null }) {
  const [open, setOpen] = useState(false);
  const language = parseCodeAttachmentLanguage(mimeType);
  const languageLabel = CODE_LANGUAGES.find((l) => l.value === language)?.label ?? language;

  return (
    <>
      <button
        type="button"
        className="conversation-attachment-chip conversation-code-thumb"
        onClick={() => setOpen(true)}
        disabled={!url}
        title={url ? "Open code" : "Link unavailable"}
      >
        {"</>"} {filename} {languageLabel && <span className="conversation-attachment-size">({languageLabel})</span>}
      </button>
      {open && url && <CodeAttachmentModal url={url} filename={filename} language={language} onClose={() => setOpen(false)} />}
    </>
  );
}

function CodeAttachmentModal({ url, filename, language, onClose }: { url: string; filename: string; language: string; onClose: () => void }) {
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error("Couldn't load this code block.");
        return r.text();
      })
      .then((text) => {
        if (!cancelled) setCode(text);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't load this code block.");
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  const { html, detected } = code != null ? highlightCode(code, language) : { html: "", detected: null };
  const languageLabel = CODE_LANGUAGES.find((l) => l.value === language)?.label ?? language;

  return (
    <div className="img-lightbox show" onClick={onClose}>
      <div className="code-attachment-modal" onClick={(e) => e.stopPropagation()}>
        <div className="obj-card-head">
          <span className="obj-type-label">
            {filename} {language === "auto" && detected ? `(${detected})` : language !== "auto" ? `(${languageLabel})` : ""}
          </span>
          <button className="icon-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </div>
        {error ? (
          <p style={{ color: "var(--blocked)", fontSize: 12.5 }}>{error}</p>
        ) : code == null ? (
          <p style={{ color: "var(--text-faint)", fontSize: 12.5 }}>Loading…</p>
        ) : (
          <pre className="code-block-pre">
            <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
          </pre>
        )}
      </div>
    </div>
  );
}
