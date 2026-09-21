"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type { ChangeEvent, PointerEvent as ReactPointerEvent } from "react";
import { useRouter } from "next/navigation";
import type { TaskObject, ChecklistItem, TaskObjectFile } from "@/lib/types";
import {
  createTaskObject,
  createFileTaskObject,
  saveSketchImage,
  updateNoteText,
  deleteTaskObject,
  addChecklistItem,
  updateChecklistItem,
  removeChecklistItem,
} from "@/lib/actions";

type FileWithUrl = TaskObjectFile & { url: string | null };

// Task-panel "Attachments" — ported from the prototype's obj-card / obj-menu
// system. Text notes and checklists were the first two kinds ported (they
// need no file storage); this pass adds the other two the add-menu always
// offered: real Supabase Storage-backed file uploads and a canvas sketch
// pad. "form" still isn't rendered here — see the TaskObjectKind comment in
// lib/types.ts for why that one's a separate, later gap.
export function TaskObjects({
  taskId,
  orgId,
  objects,
  checklistItemsByObject,
  taskObjectFileByObjectId,
}: {
  taskId: string;
  orgId: string;
  objects: TaskObject[];
  checklistItemsByObject: Map<string, ChecklistItem[]>;
  taskObjectFileByObjectId: Map<string, FileWithUrl>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewingImage, setViewingImage] = useState<{ src: string; name: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  function addObject(kind: "note" | "checklist" | "sketch") {
    setMenuOpen(false);
    run(() => createTaskObject(orgId, taskId, kind));
  }

  function triggerFileUpload() {
    setMenuOpen(false);
    fileInputRef.current?.click();
  }

  // Matches the prototype's own objFileInput handler: a 4MB cap checked
  // client-side first (for immediate feedback, same wording as the
  // prototype's error), with createFileTaskObject enforcing the same limit
  // server-side as the real guard.
  function handleFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      setError("That file is over 4MB — please choose something smaller.");
      return;
    }
    const formData = new FormData();
    formData.append("file", file);
    run(() => createFileTaskObject(orgId, taskId, formData));
  }

  return (
    <div className="field-group">
      <span className="field-label">Attachments</span>
      {error && (
        <div className="banner" style={{ color: "var(--blocked)", background: "var(--blocked-bg)" }}>
          {error}
        </div>
      )}
      <input ref={fileInputRef} type="file" style={{ display: "none" }} onChange={handleFileSelected} />
      {objects.length === 0 ? (
        <p style={{ color: "var(--text-faint)", fontSize: 12 }}>Add a text note, file, sketch, or checklist.</p>
      ) : (
        <div className="obj-list">
          {objects.map((o) => {
            if (o.kind === "note") {
              return (
                <NoteCard
                  key={o.id}
                  obj={o}
                  pending={pending}
                  onChange={(text) => run(() => updateNoteText(o.id, text))}
                  onRemove={() => run(() => deleteTaskObject(o.id))}
                />
              );
            }
            if (o.kind === "checklist") {
              return (
                <ChecklistCard
                  key={o.id}
                  items={checklistItemsByObject.get(o.id) ?? []}
                  pending={pending}
                  onAddItem={(label) => run(() => addChecklistItem(o.id, label))}
                  onToggleItem={(itemId, checked) => run(() => updateChecklistItem(itemId, { is_checked: checked }))}
                  onRelabelItem={(itemId, label) => run(() => updateChecklistItem(itemId, { label }))}
                  onRemoveItem={(itemId) => run(() => removeChecklistItem(itemId))}
                  onRemove={() => run(() => deleteTaskObject(o.id))}
                />
              );
            }
            if (o.kind === "file") {
              return (
                <FileCard
                  key={o.id}
                  file={taskObjectFileByObjectId.get(o.id)}
                  pending={pending}
                  onRemove={() => run(() => deleteTaskObject(o.id))}
                  onView={setViewingImage}
                />
              );
            }
            if (o.kind === "sketch") {
              return (
                <SketchCard
                  key={o.id}
                  file={taskObjectFileByObjectId.get(o.id)}
                  pending={pending}
                  onRemove={() => run(() => deleteTaskObject(o.id))}
                  onSaved={(formData) => run(() => saveSketchImage(orgId, taskId, o.id, formData))}
                />
              );
            }
            // "form" — created only via the Portal, not rendered in this
            // pass. Shown as a stub rather than silently vanishing.
            return (
              <div key={o.id} className="obj-card">
                <div className="obj-card-head">
                  <span className="obj-type-label">{o.kind}</span>
                  <button className="icon-btn" onClick={() => run(() => deleteTaskObject(o.id))} disabled={pending} title="Remove">
                    ✕
                  </button>
                </div>
                <p style={{ color: "var(--text-faint)", fontSize: 12 }}>Not supported in this view yet.</p>
              </div>
            );
          })}
        </div>
      )}
      <div className="obj-add-row">
        <button
          type="button"
          className={`obj-add-btn ${menuOpen ? "open" : ""}`}
          onClick={() => setMenuOpen((v) => !v)}
          disabled={pending}
          title="Add an attachment"
        >
          +
        </button>
        {menuOpen && (
          <div className="obj-menu">
            <button type="button" className="obj-menu-item" onClick={() => addObject("note")}>
              Text note
            </button>
            <button type="button" className="obj-menu-item" onClick={triggerFileUpload}>
              Upload file
            </button>
            <button type="button" className="obj-menu-item" onClick={() => addObject("sketch")}>
              Sketch pad
            </button>
            <button type="button" className="obj-menu-item" onClick={() => addObject("checklist")}>
              Checklist
            </button>
          </div>
        )}
      </div>
      {viewingImage && (
        <div className="img-lightbox show" onClick={() => setViewingImage(null)}>
          <img src={viewingImage.src} alt={viewingImage.name} />
        </div>
      )}
    </div>
  );
}

function formatBytes(n: number | null): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function NoteCard({
  obj,
  pending,
  onChange,
  onRemove,
}: {
  obj: TaskObject;
  pending: boolean;
  onChange: (text: string) => void;
  onRemove: () => void;
}) {
  const text = obj.content?.text ?? "";
  return (
    <div className="obj-card">
      <div className="obj-card-head">
        <span className="obj-type-label">Text note</span>
        <button className="icon-btn" onClick={onRemove} disabled={pending} title="Remove">
          ✕
        </button>
      </div>
      <textarea
        className="text-input obj-textarea"
        defaultValue={text}
        placeholder="Type a note…"
        onBlur={(e) => {
          if (e.target.value !== text) onChange(e.target.value);
        }}
      />
    </div>
  );
}

// A ported thumbnail-or-generic-icon file row. The bucket is private, so
// `file.url` is a signed URL generated fresh on every workspace load (see
// getWorkspaceData in lib/tasks-data.ts) rather than a permanent public
// link — it can go stale after an hour, but a fresh page load always gets
// a new one. Beyond the prototype (which only ever had in-browser data
// URIs, never a real downloadable file): a non-image file's row is a real
// download link.
function FileCard({
  file,
  pending,
  onRemove,
  onView,
}: {
  file: FileWithUrl | undefined;
  pending: boolean;
  onRemove: () => void;
  onView: (image: { src: string; name: string }) => void;
}) {
  const isImage = (file?.mime_type ?? "").startsWith("image/");
  return (
    <div className="obj-card">
      <div className="obj-card-head">
        <span className="obj-type-label">File</span>
        <button className="icon-btn" onClick={onRemove} disabled={pending} title="Remove">
          ✕
        </button>
      </div>
      {!file ? (
        <div className="obj-file-error">This file is missing.</div>
      ) : !file.url ? (
        <div className="obj-file-error">Couldn&apos;t load this file — try refreshing.</div>
      ) : isImage ? (
        <div className="obj-file-row">
          <img
            className="obj-file-thumb obj-file-thumb-clickable"
            src={file.url}
            alt={file.filename}
            title="Click to view"
            onClick={() => onView({ src: file.url as string, name: file.filename })}
          />
          <div className="obj-file-meta">
            <span className="row-title">{file.filename}</span>
            <span className="crumbline">{formatBytes(file.size_bytes)}</span>
          </div>
        </div>
      ) : (
        <div className="obj-file-row">
          <a className="obj-file-generic" href={file.url} download={file.filename} target="_blank" rel="noreferrer" title="Download">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
            </svg>
          </a>
          <div className="obj-file-meta">
            <span className="row-title">{file.filename}</span>
            <span className="crumbline">{formatBytes(file.size_bytes)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// A React port of the prototype's raw-DOM initSketchCanvases(): pointer
// events drawn straight onto a fixed 420x200 canvas, saved on every stroke
// end. Drawing state (drawing/lastX/lastY) lives in refs, not state, so a
// mid-stroke pointermove never triggers a re-render. "Clear sketch" reuses
// the exact same save pathway with a blanked canvas rather than a separate
// delete action, so Storage stays in sync with no new server action needed.
function SketchCard({
  file,
  pending,
  onRemove,
  onSaved,
}: {
  file: FileWithUrl | undefined;
  pending: boolean;
  onRemove: () => void;
  onSaved: (formData: FormData) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.fillStyle = "#FBFAF7";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (file?.url) {
      const img = new Image();
      // The signed-URL GET needs permissive CORS for this canvas to stay
      // un-tainted (so a later stroke-end toBlob() can still read pixels
      // back out) — Supabase Storage sends the necessary header.
      img.crossOrigin = "anonymous";
      img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      img.src = file.url;
    }
    // Intentionally re-runs only when the loaded image actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.url]);

  function pos(e: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current as HTMLCanvasElement;
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) };
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    drawing.current = true;
    canvas.setPointerCapture(e.pointerId);
    const p = pos(e);
    last.current = p;
    ctx.strokeStyle = "#2b2b2b";
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // A dot on its own so a single tap/click registers as a mark, not
    // nothing — matches the prototype's own pointerdown handler.
    ctx.beginPath();
    ctx.arc(p.x, p.y, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
  }

  function saveCanvas() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const formData = new FormData();
      formData.append("file", blob, "sketch.png");
      onSaved(formData);
    }, "image/png");
  }

  function endStroke() {
    if (!drawing.current) return;
    drawing.current = false;
    saveCanvas();
  }

  function clearSketch() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.fillStyle = "#FBFAF7";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    saveCanvas();
  }

  return (
    <div className="obj-card">
      <div className="obj-card-head">
        <span className="obj-type-label">Sketch</span>
        <button className="icon-btn" onClick={onRemove} disabled={pending} title="Remove">
          ✕
        </button>
      </div>
      <div className="sketch-frame">
        <canvas
          ref={canvasRef}
          className="sketch-canvas"
          width={420}
          height={200}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endStroke}
          onPointerLeave={endStroke}
          onPointerCancel={endStroke}
        />
      </div>
      <button type="button" className="small-btn ghost-btn" style={{ marginTop: 8 }} onClick={clearSketch} disabled={pending}>
        Clear sketch
      </button>
    </div>
  );
}

function ChecklistCard({
  items,
  pending,
  onAddItem,
  onToggleItem,
  onRelabelItem,
  onRemoveItem,
  onRemove,
}: {
  items: ChecklistItem[];
  pending: boolean;
  onAddItem: (label: string) => void;
  onToggleItem: (itemId: string, checked: boolean) => void;
  onRelabelItem: (itemId: string, label: string) => void;
  onRemoveItem: (itemId: string) => void;
  onRemove: () => void;
}) {
  const [newItem, setNewItem] = useState("");
  const doneCount = items.filter((i) => i.is_checked).length;

  return (
    <div className="obj-card">
      <div className="obj-card-head">
        <span className="obj-type-label">Checklist</span>
        <button className="icon-btn" onClick={onRemove} disabled={pending} title="Remove">
          ✕
        </button>
      </div>
      {items.length === 0 ? (
        <div className="crumbline">No items yet — add one below.</div>
      ) : (
        <div className="checklist-items">
          {items.map((i) => (
            <div key={i.id} className={`checklist-item ${i.is_checked ? "done" : ""}`}>
              <input
                type="checkbox"
                checked={i.is_checked}
                onChange={(e) => onToggleItem(i.id, e.target.checked)}
                disabled={pending}
              />
              <input
                type="text"
                className="checklist-item-input"
                defaultValue={i.label}
                onBlur={(e) => {
                  const value = e.target.value.trim();
                  if (value && value !== i.label) onRelabelItem(i.id, value);
                }}
              />
              <button className="icon-btn" onClick={() => onRemoveItem(i.id)} disabled={pending} title="Remove item">
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {items.length > 0 && (
        <div className="checklist-progress">
          {doneCount}/{items.length} complete
        </div>
      )}
      <div className="add-inline">
        <input
          className="text-input"
          placeholder="Add an item and press Enter"
          value={newItem}
          disabled={pending}
          onChange={(e) => setNewItem(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && newItem.trim()) {
              onAddItem(newItem.trim());
              setNewItem("");
            }
          }}
        />
      </div>
    </div>
  );
}
