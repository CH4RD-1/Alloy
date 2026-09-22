"use client";

import { useLayoutEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Doc } from "@/lib/types";
import type { TaskRow } from "@/lib/list-view";
import { updateDocFields, deleteDoc, linkDocToTask, unlinkDocFromTask } from "@/lib/actions";

// Same glyph as the prototype's ICONS.image, kept as its own component so
// it can sit inline in the toolbar button below.
function ImageIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="m21 15-5-5L5 21" />
    </svg>
  );
}

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export function DocPanel({
  doc,
  allRows,
  linkedTaskIds,
  vocabTask,
  besideMainWidth,
  onSelectTask,
  onClose,
}: {
  doc: Doc;
  allRows: TaskRow[]; // flattened: every task, top-level and sub (see flattenRows)
  linkedTaskIds: string[];
  vocabTask: string;
  // The main task panel's own current on-screen width (px) while it's also
  // open — undefined/0 when it isn't. Ported from the prototype's
  // #panelArticle "beside-main" treatment (see .panel-doc in globals.css),
  // but driven by the task panel's *actual* width (tracked in
  // tasks-workspace.tsx via TaskPanel's onWidthChange) rather than a
  // hardcoded 440px, so a widened Helpdesk ticket's panel doesn't end up
  // hidden behind this one.
  besideMainWidth?: number;
  // Opens the linked task's own panel without closing this one, so a task
  // and the article it links to can stay open side by side — omit to fall
  // back to a non-clickable row (used nowhere currently, but keeps this
  // component usable standalone).
  onSelectTask?: (id: string) => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [linkTargetId, setLinkTargetId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);

  function run(action: () => Promise<unknown>) {
    setError(null);
    startTransition(async () => {
      try {
        await action();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      }
    });
  }

  // The article body: a contenteditable div ported from the prototype's own
  // #panelArticle .article-editor, holding real h2/h4/p/img markup rather
  // than the plain-text textarea an earlier pass of this port used. It's
  // deliberately NOT React-controlled — its innerHTML is only (re)seeded
  // here, on mount and whenever doc.id changes (switching to a different
  // article; DocPanel isn't remounted between docs — see tasks-workspace.tsx),
  // never on every render. Rendering it from doc.body_html directly would
  // mean a save-triggered router.refresh() mid-edit hands this component
  // back the same doc.id with the just-saved body_html, and React would
  // reset the DOM node and wipe out whatever the user had typed since.
  const editorRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (editorRef.current) editorRef.current.innerHTML = doc.body_html || "<p><br></p>";
  }, [doc.id]);

  function saveBody() {
    if (!editorRef.current) return;
    run(() => updateDocFields(doc.id, { body_html: editorRef.current!.innerHTML }));
  }

  // Title/Subtitle/Normal — document.execCommand is deprecated but this is a
  // straight port of the prototype's own toolbar, which relies on it too;
  // the buttons' onMouseDown preventDefault keeps focus (and the current
  // selection) on the editor so formatBlock has something to apply to.
  function applyFormat(tag: "h2" | "h4" | "p") {
    editorRef.current?.focus();
    document.execCommand("formatBlock", false, tag);
    saveBody();
  }

  function handleImagePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !editorRef.current) return;
    if (file.size > MAX_IMAGE_BYTES) {
      setImageError("That image is over 4MB — please choose something smaller.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      // Appended to the end rather than inserted at the caret: opening the
      // native file picker loses the editor's selection, so "insert at
      // cursor" isn't reliable — same tradeoff the prototype made.
      editorRef.current!.innerHTML += `<img src="${reader.result}">`;
      setImageError(null);
      saveBody();
    };
    reader.onerror = () => setImageError("Couldn't read that image — please try another.");
    reader.readAsDataURL(file);
  }

  const linkedTasks = linkedTaskIds
    .map((id) => allRows.find((r) => r.task.id === id))
    .filter((r): r is TaskRow => !!r);
  const linkableTasks = allRows.filter((r) => !linkedTaskIds.includes(r.task.id));

  return (
    <>
      <div className="scrim show" onClick={onClose} />
      <aside className={`panel show panel-doc${besideMainWidth ? " beside-main" : ""}`} style={besideMainWidth ? { right: besideMainWidth } : undefined}>
        <div className="panel-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <input
              className="panel-title-input"
              defaultValue={doc.title}
              onBlur={(e) => {
                const value = e.target.value.trim();
                if (value && value !== doc.title) run(() => updateDocFields(doc.id, { title: value }));
              }}
            />
            <div className="crumbline">Article · Knowledge base</div>
          </div>
          <button className="icon-btn panel-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="panel-body">
          {error && <div className="banner" style={{ color: "var(--blocked)", background: "var(--blocked-bg)" }}>{error}</div>}

          <div className="field-group">
            <span className="field-label">Body</span>
            {imageError && <div className="obj-file-error" style={{ marginBottom: 8 }}>{imageError}</div>}
            <div className="article-toolbar">
              <button type="button" className="small-btn fmt-h2" onMouseDown={(e) => e.preventDefault()} onClick={() => applyFormat("h2")}>
                Title
              </button>
              <button type="button" className="small-btn fmt-h4" onMouseDown={(e) => e.preventDefault()} onClick={() => applyFormat("h4")}>
                Subtitle
              </button>
              <button type="button" className="small-btn fmt-p" onMouseDown={(e) => e.preventDefault()} onClick={() => applyFormat("p")}>
                Normal
              </button>
              <button
                type="button"
                className="small-btn"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => imageInputRef.current?.click()}
              >
                <ImageIcon /> Image
              </button>
            </div>
            <div ref={editorRef} className="article-editor" contentEditable suppressContentEditableWarning onBlur={saveBody} />
            <input ref={imageInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleImagePick} />
          </div>

          <div className="field-group">
            <label className="checkbox-row">
              <input
                type="checkbox"
                defaultChecked={doc.published}
                onChange={(e) => run(() => updateDocFields(doc.id, { published: e.target.checked }))}
              />
              <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                Publish to portal — visible to outside requesters, no login needed
              </span>
            </label>
          </div>

          <div className="divider" />

          <div className="field-group">
            <span className="field-label">
              Linked {vocabTask.toLowerCase()}s ({linkedTasks.length})
            </span>
            {linkedTasks.length === 0 && (
              <p style={{ color: "var(--text-faint)", fontSize: 12 }}>Not linked to any {vocabTask.toLowerCase()} yet.</p>
            )}
            {linkedTasks.map((r) => (
              <div key={r.task.id} className="dep-item">
                <span
                  className="row-title"
                  style={onSelectTask ? { cursor: "pointer" } : undefined}
                  onClick={() => onSelectTask?.(r.task.id)}
                >
                  {r.task.title}
                </span>
                <button className="icon-btn" onClick={() => run(() => unlinkDocFromTask(doc.id, r.task.id))}>
                  ✕
                </button>
              </div>
            ))}
            <div className="add-inline">
              <select className="select-input" value={linkTargetId} onChange={(e) => setLinkTargetId(e.target.value)}>
                <option value="">Link a {vocabTask.toLowerCase()}…</option>
                {linkableTasks.map((r) => (
                  <option key={r.task.id} value={r.task.id}>
                    {r.task.title}
                  </option>
                ))}
              </select>
              <button
                className="small-btn"
                disabled={!linkTargetId || pending}
                onClick={() => {
                  run(() => linkDocToTask(doc.id, linkTargetId));
                  setLinkTargetId("");
                }}
              >
                Link
              </button>
            </div>
          </div>

          <div className="divider" />

          <button
            className="small-btn"
            style={{ color: "var(--blocked)" }}
            disabled={pending}
            onClick={() => {
              if (confirm(`Delete "${doc.title}"?`)) {
                run(async () => {
                  await deleteDoc(doc.id);
                  onClose();
                });
              }
            }}
          >
            Delete article
          </button>
        </div>
      </aside>
    </>
  );
}
