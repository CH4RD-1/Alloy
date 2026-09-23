"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useRouter } from "next/navigation";
import type { TaskObject, ChecklistItem, TaskObjectFile } from "@/lib/types";
import {
  createTaskObject,
  createFileTaskObject,
  saveSketchImage,
  updateNoteText,
  updateCodeBlock,
  deleteTaskObject,
  addChecklistItem,
  updateChecklistItem,
  removeChecklistItem,
} from "@/lib/actions";
import { CODE_LANGUAGES, highlightCode } from "@/lib/code-highlight";

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

  function addObject(kind: "note" | "checklist" | "sketch" | "code") {
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
        <p style={{ color: "var(--text-faint)", fontSize: 12 }}>Add a text note, file, sketch, code block, or checklist.</p>
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
            if (o.kind === "code") {
              return (
                <CodeCard
                  key={o.id}
                  obj={o}
                  pending={pending}
                  onChange={(code, language) => run(() => updateCodeBlock(o.id, code, language))}
                  onRemove={() => run(() => deleteTaskObject(o.id))}
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
            <button type="button" className="obj-menu-item" onClick={() => addObject("code")}>
              Code block
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

// A code-block attachment: language dropdown (a curated hljs subset plus
// "Auto-detect", "Auto" being the default for a new block) over a
// click-to-edit area — a plain, uncontrolled <textarea> while editing (Tab
// inserts two spaces rather than moving focus, same as a real editor), a
// syntax-highlighted read-only <pre> once saved (see lib/code-highlight.ts).
// Local `local*` state mirrors what's on screen the instant a save fires,
// rather than waiting on the router.refresh() a save always triggers too —
// without it, switching back to the highlighted view would flash the old
// (pre-edit) content for a moment.
function CodeCard({
  obj,
  pending,
  onChange,
  onRemove,
}: {
  obj: TaskObject;
  pending: boolean;
  onChange: (code: string, language: string) => void;
  onRemove: () => void;
}) {
  const savedCode = obj.content?.code ?? "";
  const savedLanguage = obj.content?.language ?? "auto";
  const [editing, setEditing] = useState(() => !savedCode);
  const [localCode, setLocalCode] = useState(savedCode);
  const [localLanguage, setLocalLanguage] = useState(savedLanguage);
  const [copied, setCopied] = useState(false);
  // Long blocks default to a fixed-height, scrollable view rather than
  // pushing the rest of the task panel down — the expand arrow (bottom-right
  // of the block) reveals the whole thing when needed. Starts collapsed
  // whenever there's saved code to show.
  const [collapsed, setCollapsed] = useState(() => !!savedCode);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) {
      setLocalCode(savedCode);
      setLocalLanguage(savedLanguage);
    }
  }, [savedCode, savedLanguage, editing]);

  function saveFromTextarea() {
    const next = textareaRef.current?.value ?? localCode;
    setLocalCode(next);
    setEditing(false);
    if (next !== savedCode || localLanguage !== savedLanguage) onChange(next, localLanguage);
  }

  function changeLanguage(next: string) {
    const currentCode = editing ? textareaRef.current?.value ?? localCode : localCode;
    setLocalCode(currentCode);
    setLocalLanguage(next);
    setEditing(false);
    onChange(currentCode, next);
  }

  function handleTab(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Tab") return;
    e.preventDefault();
    const el = e.currentTarget;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    el.value = el.value.slice(0, start) + "  " + el.value.slice(end);
    el.selectionStart = el.selectionEnd = start + 2;
  }

  function copyCode() {
    navigator.clipboard?.writeText(localCode).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }

  const { html, detected } = editing ? { html: "", detected: null } : highlightCode(localCode, localLanguage);

  return (
    <div className="obj-card">
      <div className="obj-card-head">
        <span className="obj-type-label">Code block</span>
        <button className="icon-btn" onClick={onRemove} disabled={pending} title="Remove">
          ✕
        </button>
      </div>
      <div className="code-block-toolbar">
        <select
          className="select-input code-lang-select"
          value={localLanguage}
          disabled={pending}
          onChange={(e) => changeLanguage(e.target.value)}
        >
          {CODE_LANGUAGES.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
        {!editing && localLanguage === "auto" && detected && <span className="code-detected">Detected: {detected}</span>}
        {!editing && !!localCode && (
          <button type="button" className="small-btn ghost-btn code-copy-btn" onClick={copyCode} disabled={pending}>
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      {editing ? (
        <textarea
          ref={textareaRef}
          className="code-block-textarea"
          defaultValue={localCode}
          placeholder="Paste or type code…"
          spellCheck={false}
          onBlur={saveFromTextarea}
          onKeyDown={handleTab}
          autoFocus
        />
      ) : localCode ? (
        <div className={"code-block-pre-wrap" + (collapsed ? " code-block-collapsed" : "")}>
          <pre className="code-block-pre" onClick={() => setEditing(true)} title="Click to edit">
            <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
          </pre>
          <button
            type="button"
            className="code-block-collapse-btn"
            onClick={(e) => {
              e.stopPropagation();
              setCollapsed((c) => !c);
            }}
            title={collapsed ? "Expand" : "Collapse"}
          >
            {collapsed ? "▽" : "△"}
          </button>
        </div>
      ) : (
        <div className="code-block-empty" onClick={() => setEditing(true)}>
          Click to add code…
        </div>
      )}
    </div>
  );
}

type SketchTool = "pen" | "eraser" | "circle" | "square" | "rectangle" | "right-triangle" | "triangle" | "hexagon";
const SHAPE_TOOLS: SketchTool[] = ["circle", "square", "rectangle", "right-triangle", "triangle", "hexagon"];
const DRAW_TOOLS: { id: SketchTool; label: string }[] = [
  { id: "pen", label: "Pen" },
  { id: "eraser", label: "Eraser" },
  { id: "circle", label: "Circle" },
  { id: "square", label: "Square" },
  { id: "rectangle", label: "Rectangle" },
  { id: "right-triangle", label: "Right-angle triangle" },
  { id: "triangle", label: "Equilateral triangle" },
  { id: "hexagon", label: "Hexagon" },
];
const SKETCH_COLORS = ["#2b2b2b", "#e03131", "#e8590c", "#2f9e44", "#1971c2", "#7048e8", "#d6336c", "#5c4033"];
const SKETCH_PEN_WIDTH = 2.2;
const SKETCH_ERASER_WIDTH = 18;

function SketchToolIcon({ tool }: { tool: SketchTool }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (tool) {
    case "pen":
      return (
        <svg {...common}>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      );
    case "eraser":
      return (
        <svg {...common}>
          <path d="m7 21-4.3-4.3c-.94-.94-.94-2.47 0-3.42l9.58-9.58c.94-.94 2.47-.94 3.42 0l5.3 5.3c.94.94.94 2.47 0 3.42L13 21" />
          <path d="M22 21H7" />
        </svg>
      );
    case "circle":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" />
        </svg>
      );
    case "square":
      return (
        <svg {...common}>
          <rect x="5" y="5" width="14" height="14" />
        </svg>
      );
    case "rectangle":
      return (
        <svg {...common}>
          <rect x="3" y="7" width="18" height="10" />
        </svg>
      );
    case "right-triangle":
      return (
        <svg {...common}>
          <path d="M5 5 L5 19 L19 19 Z" />
        </svg>
      );
    case "triangle":
      return (
        <svg {...common}>
          <path d="M12 4 L20 19 L4 19 Z" />
        </svg>
      );
    case "hexagon":
      return (
        <svg {...common}>
          <path d="M8 3 H16 L21 12 L16 21 H8 L3 12 Z" />
        </svg>
      );
  }
}

// Draws (or previews, mid-drag) a shape tool into the given bounding box —
// shared by both the live preview in handlePointerMove and, implicitly, the
// final commit (the preview IS the commit: the last frame drawn before
// pointerup is just left in place, nothing further to draw on release).
function drawSketchShape(ctx: CanvasRenderingContext2D, tool: SketchTool, x0: number, y0: number, x1: number, y1: number, color: string) {
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  const w = right - left;
  const h = bottom - top;
  ctx.strokeStyle = color;
  ctx.lineWidth = SKETCH_PEN_WIDTH;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  switch (tool) {
    case "circle": {
      const cx = (left + right) / 2;
      const cy = (top + bottom) / 2;
      ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
      break;
    }
    case "square": {
      const size = Math.max(w, h);
      const sx = x1 >= x0 ? x0 : x0 - size;
      const sy = y1 >= y0 ? y0 : y0 - size;
      ctx.rect(sx, sy, size, size);
      break;
    }
    case "rectangle":
      ctx.rect(left, top, w, h);
      break;
    case "right-triangle":
      // Right angle at the bounding box's bottom-left corner.
      ctx.moveTo(left, top);
      ctx.lineTo(left, bottom);
      ctx.lineTo(right, bottom);
      ctx.closePath();
      break;
    case "triangle":
      // Apex centered on top, base spans the full bounding-box width —
      // reads as equilateral for the common case of dragging a roughly
      // square box, without needing to force the box itself into one.
      ctx.moveTo((left + right) / 2, top);
      ctx.lineTo(left, bottom);
      ctx.lineTo(right, bottom);
      ctx.closePath();
      break;
    case "hexagon": {
      const cx = (left + right) / 2;
      const cy = (top + bottom) / 2;
      const rx = w / 2;
      const ry = h / 2;
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 180) * (60 * i - 90);
        const px = cx + rx * Math.cos(angle);
        const py = cy + ry * Math.sin(angle);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    }
  }
  ctx.stroke();
}

// A React port of the prototype's raw-DOM initSketchCanvases(): pointer
// events drawn straight onto a fixed 420x200 canvas, saved on every stroke
// end. Drawing state (drawing/lastX/lastY/shapeStart) lives in refs, not
// state, so a mid-stroke pointermove never triggers a re-render. "Clear
// sketch" reuses the exact same save pathway with a blanked canvas rather
// than a separate delete action, so Storage stays in sync with no new
// server action needed.
//
// Beyond the original port: an eraser (destination-out compositing, so it
// genuinely punches a hole back to whatever's underneath rather than
// having to paint over in the exact background color), a basic color
// palette, and six shape tools (drag to size, release to commit — a
// snapshot of the canvas taken on pointerdown is restored on every
// pointermove before redrawing the preview, so dragging a shape around
// doesn't smear copies of it across the canvas).
//
// Also fixes a real, reported bug, not just adds features: freehand
// strokes could drop line segments mid-stroke. Root cause was
// onPointerLeave ending the stroke — with the canvas already holding
// pointer capture (setPointerCapture below), a fast stroke briefly
// crossing the canvas's own edge can still fire a pointerleave in some
// browsers even though the capture means pointermove/pointerup keep
// arriving correctly; ending the stroke right then silently drew nothing
// for the rest of that same physical drag. Removed — only a genuine
// pointerup/pointercancel ends a stroke now. Separately, a very fast
// stroke can generate more physical mouse-movement than individual
// pointermove events for — most browsers batch ("coalesce") the skipped
// points into the next event rather than dropping them outright, but the
// original code only ever drew a line to the event's own final point, so
// those in-between points, and the line segments through them, never got
// drawn. getCoalescedEvents() (guarded, since it's not universally
// implemented) recovers and draws through all of them.
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
  const shapeStart = useRef<{ x: number; y: number; snapshot: ImageData } | null>(null);
  const [tool, setTool] = useState<SketchTool>("pen");
  const [color, setColor] = useState(SKETCH_COLORS[0]);

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

  function pos(e: ReactPointerEvent<HTMLCanvasElement> | PointerEvent) {
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

    if (tool === "pen" || tool === "eraser") {
      last.current = p;
      ctx.strokeStyle = color;
      ctx.lineWidth = tool === "eraser" ? SKETCH_ERASER_WIDTH : SKETCH_PEN_WIDTH;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
      // A dot on its own so a single tap/click registers as a mark, not
      // nothing — matches the prototype's own pointerdown handler.
      ctx.beginPath();
      ctx.arc(p.x, p.y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      ctx.globalCompositeOperation = "source-over";
      shapeStart.current = { x: p.x, y: p.y, snapshot: ctx.getImageData(0, 0, canvas.width, canvas.height) };
    }
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    if (tool === "pen" || tool === "eraser") {
      const native = e.nativeEvent as PointerEvent & { getCoalescedEvents?: () => PointerEvent[] };
      const points = native.getCoalescedEvents?.() ?? [native];
      for (const point of points) {
        const p = pos(point);
        ctx.beginPath();
        ctx.moveTo(last.current.x, last.current.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        last.current = p;
      }
    } else if (shapeStart.current) {
      ctx.putImageData(shapeStart.current.snapshot, 0, 0);
      const p = pos(e);
      drawSketchShape(ctx, tool, shapeStart.current.x, shapeStart.current.y, p.x, p.y, color);
    }
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
    shapeStart.current = null;
    saveCanvas();
  }

  function clearSketch() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.globalCompositeOperation = "source-over";
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
      <div className="sketch-toolbar">
        {DRAW_TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`sketch-tool-btn ${tool === t.id ? "active" : ""}`}
            onClick={() => setTool(t.id)}
            title={t.label}
            aria-label={t.label}
          >
            <SketchToolIcon tool={t.id} />
          </button>
        ))}
        <span className="sketch-toolbar-divider" />
        <div className="sketch-colors">
          {SKETCH_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`sketch-color-swatch ${color === c ? "active" : ""}`}
              style={{ background: c }}
              onClick={() => setColor(c)}
              title={c}
              aria-label={`Color ${c}`}
            />
          ))}
          <input
            type="color"
            className="sketch-color-custom"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            title="Custom color"
            aria-label="Custom color"
          />
        </div>
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
