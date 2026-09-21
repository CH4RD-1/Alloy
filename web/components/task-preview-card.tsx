"use client";

// A small floating card shown at the cursor on a plain click (no drag) —
// ported from the prototype's own #ticketPreview/showTicketPreview (see the
// "Live prototype" link in alloy-development-log.md). Wired up on Gantt bars
// and Calendar events, both of which used to jump straight to the full
// slide-over TaskPanel on click; now they show this instead, with an "Open"
// button for anyone who actually wants the full panel — matching the
// prototype's own click-vs-open distinction.

import { useEffect, useRef, useState } from "react";
import type { TaskRow } from "@/lib/list-view";
import { fmtDate } from "@/lib/list-view";
import type { Project } from "@/lib/types";
import { StatusChip, TeamChip, TagChip, Avatar } from "@/components/task-list-view";

export function TaskPreviewCard({
  row,
  projects,
  x,
  y,
  vocabTask,
  onClose,
  onOpen,
}: {
  row: TaskRow;
  projects: Project[];
  x: number;
  y: number;
  vocabTask: string;
  onClose: () => void;
  onOpen: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Starts at the prototype's own default offset (cursor + 16px) and, once
  // the card has actually rendered and its real size is known, is nudged
  // back on-screen if that default would run off an edge — same two-step
  // "measure then clamp" approach as showTicketPreview, just done via a
  // layout effect instead of a synchronous DOM read right after innerHTML.
  const [pos, setPos] = useState({ left: x + 16, top: y + 16 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pad = 10;
    const w = el.offsetWidth || 250;
    const h = el.offsetHeight || 170;
    let left = x + 16;
    let top = y + 16;
    if (left + w + pad > window.innerWidth) left = x - w - 16;
    if (top + h + pad > window.innerHeight) top = window.innerHeight - h - pad;
    left = Math.max(pad, left);
    top = Math.max(pad, top);
    setPos({ left, top });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y, row.task.id]);

  // Dismiss on an outside click or a scroll of the area it's anchored over
  // (it's position:fixed, so it would otherwise drift away from the bar/
  // event it describes) — same two listeners as the prototype's own
  // hideTicketPreview call sites.
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if ((e.target as Element).closest?.(".task-preview-card")) return;
      onClose();
    }
    function onScroll(e: Event) {
      const target = e.target as Element | Document;
      const el2 = target === document ? document.body : (target as Element);
      if (target === document || el2.closest?.(".gantt-scroll, .gantt-body, .calendar-body")) onClose();
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("scroll", onScroll, true);
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("keydown", onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const project = projects.find((p) => p.id === row.task.project_id);

  return (
    <div
      ref={ref}
      className="task-preview-card"
      style={{ left: pos.left, top: pos.top, ["--tp-accent" as string]: row.teamColor ?? "var(--accent)" }}
    >
      <div className="task-preview-head">
        <div className="task-preview-title">{row.task.title}</div>
        <button className="icon-btn" onClick={onClose} aria-label="Close" type="button">
          ✕
        </button>
      </div>
      {project && <div className="crumbline">{project.name}</div>}
      <div className="task-preview-row">
        <StatusChip statusKey={row.statusKey} label={row.statusLabel} color={row.statusColor} />
        <TeamChip name={row.teamName} color={row.teamColor} />
      </div>
      {row.assigneeName && (
        <div className="task-preview-row">
          <Avatar name={row.assigneeName} />
          <span>{row.assigneeName}</span>
        </div>
      )}
      <div className="task-preview-row mono">
        {fmtDate(row.task.start_date)} → {fmtDate(row.task.due_date)}
      </div>
      {row.tags.length > 0 && (
        <div className="task-preview-tags">
          {row.tags.slice(0, 4).map((tag) => (
            <TagChip key={tag} tag={tag} />
          ))}
        </div>
      )}
      <button type="button" className="small-btn task-preview-open" onClick={onOpen}>
        Open {vocabTask.toLowerCase()}
      </button>
    </div>
  );
}
