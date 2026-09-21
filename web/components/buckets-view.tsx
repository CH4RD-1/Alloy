"use client";

import { useRef, useState, useTransition, type CSSProperties, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import type { BucketColumn } from "@/lib/buckets-view";
import type { TaskRow } from "@/lib/list-view";
import { fmtDate, hueFor } from "@/lib/list-view";
import { updateTaskFields } from "@/lib/actions";
import { StatusChip } from "@/components/task-list-view";

// The drag payload is just the task id, carried as plain text — mirrors the
// prototype's native `draggable="true"` tiles. Click-drag column panning
// (below) was added later, alongside the same behavior on the Gantt view.
const DRAG_MIME = "text/plain";

// Same technique as gantt-view.tsx's own pan handler — duplicated locally
// rather than shared, since it's a two-line helper and this file otherwise
// has no dependency on that one.
function disableTextSelection() {
  document.body.style.userSelect = "none";
}
function restoreTextSelection() {
  document.body.style.userSelect = "";
}

function TagChip({ tag }: { tag: string }) {
  const hue = hueFor(tag);
  return (
    <span className="chip tag-chip" style={{ background: `hsl(${hue} 42% 91%)`, color: `hsl(${hue} 45% 28%)` }}>
      {tag}
    </span>
  );
}

function BlockedIcon() {
  return (
    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="m4.9 4.9 14.2 14.2" />
    </svg>
  );
}

function Tile({
  row,
  dragging,
  onDragStart,
  onDragEnd,
  onSelectTask,
}: {
  row: TaskRow;
  dragging: boolean;
  onDragStart: (e: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onSelectTask: (id: string) => void;
}) {
  const t = row.task;
  return (
    <div
      className={`tile ${dragging ? "dragging" : ""}`}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={() => onSelectTask(t.id)}
      style={{ ["--tile-accent" as string]: row.teamColor ?? undefined } as CSSProperties}
    >
      <div className="tile-title">
        {t.is_milestone && <span style={{ color: "var(--accent)" }}>◆ </span>}
        {t.display_id && <span className="task-id-badge" style={{ marginRight: 5 }}>{t.display_id}</span>}
        {t.title}
      </div>
      <div className="tile-meta">
        <StatusChip statusKey={row.statusKey} label={row.statusLabel} color={row.statusColor} />
        {row.isBlockedOpen && (
          <span className="chip status-chip status-blocked" title="Waiting on a dependency">
            <BlockedIcon />
          </span>
        )}
      </div>
      {row.tags.length > 0 && (
        <div className="tile-tags">
          {row.tags.slice(0, 3).map((tag) => (
            <TagChip key={tag} tag={tag} />
          ))}
        </div>
      )}
      <div className="tile-meta">
        <span className="cell-dates">
          {t.is_milestone ? fmtDate(t.start_date) : t.due_date ? fmtDate(t.due_date) : ""}
        </span>
        {row.assigneeName && <span className="assignee-name">{row.assigneeName}</span>}
      </div>
    </div>
  );
}

function BucketColumnView({
  column,
  vocabTask,
  draggingTaskId,
  onDragStartTask,
  onDragEndTask,
  onDropTask,
  onSelectTask,
}: {
  column: BucketColumn;
  vocabTask: string;
  draggingTaskId: string | null;
  onDragStartTask: (e: DragEvent<HTMLDivElement>, taskId: string) => void;
  onDragEndTask: () => void;
  onDropTask: (taskId: string, teamId: string | null) => void;
  onSelectTask: (id: string) => void;
}) {
  const [hover, setHover] = useState(false);

  return (
    <div
      className={`bucket-col ${hover ? "drop-hover" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setHover(true);
      }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setHover(false);
        const taskId = e.dataTransfer.getData(DRAG_MIME);
        if (taskId) onDropTask(taskId, column.teamId);
      }}
    >
      <div className="bucket-head">
        <span className="team-swatch" style={{ background: column.color }} />
        <span className="bucket-title">{column.name}</span>
        <span className="bucket-count">{column.rows.length}</span>
      </div>
      <div className="bucket-body">
        {column.rows.length === 0 && <div className="bucket-empty">Drop a {vocabTask.toLowerCase()} here</div>}
        {column.rows.map((row) => (
          <Tile
            key={row.task.id}
            row={row}
            dragging={draggingTaskId === row.task.id}
            onDragStart={(e) => onDragStartTask(e, row.task.id)}
            onDragEnd={onDragEndTask}
            onSelectTask={onSelectTask}
          />
        ))}
      </div>
    </div>
  );
}

export function BucketsView({
  columns,
  vocabTask,
  vocabTeam,
  onSelectTask,
}: {
  columns: BucketColumn[];
  vocabTask: string;
  vocabTeam: string;
  onSelectTask: (id: string) => void;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Click-drag panning on blank column space — same technique as the Gantt
  // view's handlePanMouseDown (gantt-view.tsx), added here on request once
  // that one existed. Bails out on a tile itself so it never fights the
  // tile's own native HTML5 drag-and-drop (dragstart/dragover/drop), which
  // starts from the same mousedown.
  function handlePanMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    if ((e.target as Element).closest(".tile")) return;
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    e.preventDefault();
    const startX = e.clientX;
    const startScrollLeft = scrollEl.scrollLeft;
    scrollEl.classList.add("panning");
    disableTextSelection();
    function onMove(ev: MouseEvent) {
      scrollEl!.scrollLeft = startScrollLeft - (ev.clientX - startX);
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      scrollEl!.classList.remove("panning");
      restoreTextSelection();
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function handleDrop(taskId: string, teamId: string | null) {
    setDraggingTaskId(null);
    setError(null);
    startTransition(async () => {
      try {
        await updateTaskFields(taskId, { team_id: teamId });
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : `Couldn't move that ${vocabTask.toLowerCase()}.`);
      }
    });
  }

  return (
    <>
      <div className="view-head">
        <div>
          <div className="view-title">Buckets</div>
          <div className="view-sub">Drag a tile to reassign it to a different {vocabTeam.toLowerCase()} · drag empty space to pan</div>
        </div>
      </div>
      {error && <div className="banner">{error}</div>}
      {columns.length === 0 ? (
        <div className="empty-note">No {vocabTeam.toLowerCase()}s yet — create one to start grouping {vocabTask.toLowerCase()}s.</div>
      ) : (
        <div className="buckets-scroll" ref={scrollRef} onMouseDown={handlePanMouseDown}>
          <div className="buckets-row">
            {columns.map((col) => (
              <BucketColumnView
                key={col.key}
                column={col}
                vocabTask={vocabTask}
                draggingTaskId={draggingTaskId}
                onDragStartTask={(e, taskId) => {
                  e.dataTransfer.setData(DRAG_MIME, taskId);
                  e.dataTransfer.effectAllowed = "move";
                  setDraggingTaskId(taskId);
                }}
                onDragEndTask={() => setDraggingTaskId(null)}
                onDropTask={handleDrop}
                onSelectTask={onSelectTask}
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
}
