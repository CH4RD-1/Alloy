"use client";

import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";

// The sketch-pad drawing engine — toolbar (pen/eraser/fill/shapes + colors),
// canvas, undo/clear, all in one embeddable unit. Originally lived only
// inside task-objects.tsx's SketchCard (the persistent, autosaving task-panel
// attachment); pulled out here so the exact same engine — "all the same
// functionality", as asked for — can also back SketchComposer
// (components/chat-editors.tsx), the ephemeral below-the-chat scratchpad that
// posts a single PNG to the conversation instead of autosaving a task_object.
// SketchCard and SketchComposer differ only in what they do with a committed
// canvas (onCommit) and what the primary button is called/does
// (primaryAction) — everything about drawing itself is shared.
export type SketchTool = "pen" | "eraser" | "fill" | "circle" | "square" | "rectangle" | "right-triangle" | "triangle" | "hexagon";
const SHAPE_TOOLS: SketchTool[] = ["circle", "square", "rectangle", "right-triangle", "triangle", "hexagon"];
const DRAW_TOOLS: { id: SketchTool; label: string }[] = [
  { id: "pen", label: "Pen" },
  { id: "eraser", label: "Eraser" },
  { id: "fill", label: "Fill" },
  { id: "circle", label: "Circle" },
  { id: "square", label: "Square" },
  { id: "rectangle", label: "Rectangle" },
  { id: "right-triangle", label: "Right-angle triangle" },
  { id: "triangle", label: "Equilateral triangle" },
  { id: "hexagon", label: "Hexagon" },
];
export const SKETCH_COLORS = ["#2b2b2b", "#e03131", "#e8590c", "#2f9e44", "#1971c2", "#7048e8", "#d6336c", "#5c4033"];
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
    case "fill":
      return (
        <svg {...common}>
          <path d="M10 3 3 10c-.6.6-.6 1.6 0 2.2l7 7c.6.6 1.6.6 2.2 0l7-7c.6-.6.6-1.6 0-2.2l-7-7c-.6-.6-1.6-.6-2.2 0Z" />
          <path d="M3 10h16" />
          <path d="M19 15c0 1.4-1 2.5-1 2.5s-1-1.1-1-2.5a1 1 0 0 1 2 0Z" />
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

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const num = parseInt(full, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

// Classic stack-based paint-bucket fill: starting from the clicked pixel,
// flood-fills every contiguous pixel that's within a small color tolerance
// of it (a little slack rather than an exact match, so it still fills
// cleanly right up against an antialiased pen/shape edge instead of
// stopping a pixel short) with the current color. Cheap enough to run
// synchronously — the canvas is a fixed 420x200, so at most ~84,000
// pixels — so there's no need for the async/chunked flood-fill some paint
// apps use for much larger canvases.
function floodFillCanvas(ctx: CanvasRenderingContext2D, startX: number, startY: number, fillColor: string) {
  const { width, height } = ctx.canvas;
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(startX)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(startY)));
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  const startIdx = (y0 * width + x0) * 4;
  const startR = data[startIdx];
  const startG = data[startIdx + 1];
  const startB = data[startIdx + 2];
  const startA = data[startIdx + 3];

  const fill = hexToRgb(fillColor);
  if (startR === fill.r && startG === fill.g && startB === fill.b && startA === 255) return;

  const tolerance = 32;
  const toleranceSq = tolerance * tolerance;
  function matches(idx: number) {
    const dr = data[idx] - startR;
    const dg = data[idx + 1] - startG;
    const db = data[idx + 2] - startB;
    const da = data[idx + 3] - startA;
    return dr * dr + dg * dg + db * db + da * da <= toleranceSq;
  }

  const visited = new Uint8Array(width * height);
  const stackX: number[] = [x0];
  const stackY: number[] = [y0];
  while (stackX.length) {
    const x = stackX.pop() as number;
    const y = stackY.pop() as number;
    if (x < 0 || x >= width || y < 0 || y >= height) continue;
    const pixelPos = y * width + x;
    if (visited[pixelPos]) continue;
    const idx = pixelPos * 4;
    if (!matches(idx)) continue;
    visited[pixelPos] = 1;
    data[idx] = fill.r;
    data[idx + 1] = fill.g;
    data[idx + 2] = fill.b;
    data[idx + 3] = 255;
    stackX.push(x + 1, x - 1, x, x);
    stackY.push(y, y, y + 1, y - 1);
  }

  ctx.putImageData(imageData, 0, 0);
}

export function SketchCanvas({
  initialImageUrl,
  disabled,
  onCommit,
  primaryAction,
  extraActions,
}: {
  initialImageUrl?: string | null;
  disabled?: boolean;
  // Fired after every committed drawing action (stroke end, shape commit,
  // fill, clear, undo) with the freshly-drawn PNG blob — SketchCard uses
  // this to autosave the task_object on every stroke; SketchComposer (no
  // task_object to autosave to) leaves it unset.
  onCommit?: (blob: Blob) => void;
  primaryAction: { label: string; title?: string; onClick: (blob: Blob) => void };
  // Extra buttons rendered next to Clear/Undo (SketchCard has none;
  // SketchComposer has none either right now, but kept generic).
  extraActions?: ReactNode;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef({ x: 0, y: 0 });
  const shapeStart = useRef<{ x: number; y: number; snapshot: ImageData } | null>(null);
  // A single snapshot of the canvas taken right before the most recent
  // committed action — not a full undo stack, just the one the prototype
  // asked for: "single undo the last action". Undoing consumes it (canUndo
  // goes false again) rather than supporting redo or multiple undos.
  const undoSnapshot = useRef<ImageData | null>(null);
  const [tool, setTool] = useState<SketchTool>("pen");
  const [color, setColor] = useState(SKETCH_COLORS[0]);
  const [canUndo, setCanUndo] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.fillStyle = "#FBFAF7";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (initialImageUrl) {
      const img = new Image();
      // The signed-URL GET needs permissive CORS for this canvas to stay
      // un-tainted (so a later stroke-end toBlob() can still read pixels
      // back out) — Supabase Storage sends the necessary header.
      img.crossOrigin = "anonymous";
      img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      img.src = initialImageUrl;
    }
    // Intentionally re-runs only when the loaded image actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialImageUrl]);

  function pos(e: ReactPointerEvent<HTMLCanvasElement> | PointerEvent) {
    const canvas = canvasRef.current as HTMLCanvasElement;
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) };
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const p = pos(e);

    // Fill is a single click/tap action, not a drag — commit it right
    // here and return, same as clearSketch, rather than joining the
    // drawing.current drag machinery below.
    if (tool === "fill") {
      undoSnapshot.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
      setCanUndo(true);
      ctx.globalCompositeOperation = "source-over";
      floodFillCanvas(ctx, p.x, p.y, color);
      commit();
      return;
    }

    drawing.current = true;
    canvas.setPointerCapture(e.pointerId);
    undoSnapshot.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
    setCanUndo(true);

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
      // Reuses the same pre-stroke snapshot just captured for undo — it's
      // an untouched copy of the canvas either way, so there's no reason
      // to call getImageData a second time for the shape-preview restore.
      shapeStart.current = { x: p.x, y: p.y, snapshot: undoSnapshot.current };
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

  function getBlob(cb: (blob: Blob) => void) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (blob) cb(blob);
    }, "image/png");
  }

  function commit() {
    if (onCommit) getBlob(onCommit);
  }

  function endStroke() {
    if (!drawing.current) return;
    drawing.current = false;
    shapeStart.current = null;
    commit();
  }

  function clearSketch() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    undoSnapshot.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
    setCanUndo(true);
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#FBFAF7";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    commit();
  }

  function handleUndo() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !undoSnapshot.current) return;
    ctx.putImageData(undoSnapshot.current, 0, 0);
    undoSnapshot.current = null;
    setCanUndo(false);
    commit();
  }

  return (
    <>
      <div className="sketch-toolbar">
        {DRAW_TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`sketch-tool-btn ${tool === t.id ? "active" : ""}`}
            onClick={() => setTool(t.id)}
            title={t.label}
            aria-label={t.label}
            disabled={disabled}
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
              disabled={disabled}
            />
          ))}
          <input
            type="color"
            className="sketch-color-custom"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            title="Custom color"
            aria-label="Custom color"
            disabled={disabled}
          />
        </div>
      </div>
      <div className="sketch-frame">
        <canvas
          ref={canvasRef}
          className="sketch-canvas"
          width={420}
          height={200}
          onPointerDown={disabled ? undefined : handlePointerDown}
          onPointerMove={disabled ? undefined : handlePointerMove}
          onPointerUp={disabled ? undefined : endStroke}
          onPointerCancel={disabled ? undefined : endStroke}
        />
      </div>
      <div className="sketch-actions">
        <button type="button" className="small-btn ghost-btn" onClick={clearSketch} disabled={disabled}>
          Clear sketch
        </button>
        <button type="button" className="small-btn ghost-btn" onClick={handleUndo} disabled={disabled || !canUndo} title="Undo the last action">
          Undo
        </button>
        {extraActions}
        <button
          type="button"
          className="small-btn"
          style={{ marginLeft: "auto" }}
          onClick={() => getBlob(primaryAction.onClick)}
          disabled={disabled}
          title={primaryAction.title}
        >
          {primaryAction.label}
        </button>
      </div>
    </>
  );
}
