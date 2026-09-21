"use client";

import { useState } from "react";
import type { TaskRow } from "@/lib/list-view";
import { fmtDate, hueFor, initials } from "@/lib/list-view";

// Small inline icons, copied from the prototype's ICONS set so the ported
// view keeps the same visual language rather than swapping in a new icon
// library for two glyphs.
function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="11"
      height="11"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform .12s" }}
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
    </svg>
  );
}

function DocIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

// Renders every status's own stored `color` (a hex string, workflow_
// statuses.color) as an inline tint rather than the old fixed CSS classes
// (.status-chip.status-backlog etc. in globals.css, kept only for the
// unrelated "waiting on a dependency" indicator chip) — those were keyed to
// exactly the 5 statuses a single org-wide workflow used to seed, so a
// custom, Helpdesk, or Assets status would have rendered with no color at
// all. `color` is optional so a caller that genuinely has no status object
// on hand yet (there shouldn't be one left) still renders something rather
// than crashing.
export function StatusChip({ statusKey, label, color }: { statusKey: string; label: string; color?: string }) {
  if (!color) return <span className={`chip status-chip status-${statusKey}`}>{label}</span>;
  return (
    <span className="chip status-chip" style={{ color, background: tintFromHex(color, 0.15) }}>
      {label}
    </span>
  );
}

// A light background tint of an arbitrary status color, so any custom color
// gets a matching soft chip background without a hand-maintained palette —
// same idea as TagChip's hueFor-derived background below, just working from
// a stored hex rather than a derived hue. Falls back to the hex itself
// (opaque) if it can't be parsed, rather than an invisible/invalid style.
function tintFromHex(hex: string, alpha: number): string {
  const clean = hex.replace("#", "").trim();
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return hex;
  const num = parseInt(full, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function TeamChip({ name, color }: { name: string | null; color: string | null }) {
  if (!name) return <span className="cell-dates">—</span>;
  return (
    <span className="chip team-chip">
      <span className="team-swatch" style={{ background: color ?? "#8b8d99" }} />
      {name}
    </span>
  );
}

export function TagChip({ tag }: { tag: string }) {
  const hue = hueFor(tag);
  return (
    <span className="chip tag-chip" style={{ background: `hsl(${hue} 42% 91%)`, color: `hsl(${hue} 45% 28%)` }}>
      {tag}
    </span>
  );
}

export function Avatar({ name }: { name: string | null }) {
  if (!name) return null;
  const hue = hueFor(name);
  return (
    <span className="avatar" style={{ background: `hsl(${hue} 45% 45%)` }} title={name}>
      {initials(name)}
    </span>
  );
}

function RowLine({
  row,
  isSub,
  expanded,
  onToggle,
  onSelect,
}: {
  row: TaskRow;
  isSub: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  onSelect?: () => void;
}) {
  const hasChildren = !isSub && !!row.children?.length;
  return (
    <div className={`list-row ${isSub ? "sub-row" : "parent-row"}`} onClick={onSelect}>
      <div className="cell-title">
        {hasChildren ? (
          <button
            type="button"
            className={`expand-btn ${expanded ? "open" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggle?.();
            }}
            aria-label={expanded ? "Collapse subtasks" : "Expand subtasks"}
          >
            <ChevronIcon open={!!expanded} />
          </button>
        ) : (
          <span className="expand-spacer" />
        )}
        {row.task.is_milestone && (
          <span style={{ color: "var(--accent)", flex: "0 0 auto" }} title="Milestone">
            ◆
          </span>
        )}
        {row.assetName && (
          <span className="asset-badge-inline" title={`Asset allocation — ${row.assetName}`}>
            ⚙
          </span>
        )}
        {row.task.display_id && <span className="task-id-badge">{row.task.display_id}</span>}
        <span className="row-title" title={row.task.title}>
          {row.task.title}
        </span>
        {hasChildren && (
          <span className="subtask-count">
            {row.doneChildCount}/{row.childCount}
          </span>
        )}
      </div>
      <div>
        <TeamChip name={row.teamName} color={row.teamColor} />
      </div>
      <div>
        <StatusChip statusKey={row.statusKey} label={row.statusLabel} color={row.statusColor} />
      </div>
      <div className="assignee-cell">
        <Avatar name={row.assigneeName} />
        <span className="assignee-name">{row.assigneeName ?? "Unassigned"}</span>
      </div>
      <div className="cell-dates">
        {row.task.is_milestone
          ? fmtDate(row.task.start_date)
          : `${fmtDate(row.task.start_date)} → ${fmtDate(row.task.due_date)}`}
      </div>
      <div className="cell-tags">
        {row.tags.slice(0, 2).map((t) => (
          <TagChip key={t} tag={t} />
        ))}
        {row.tags.length > 2 && <span className="chip tag-chip">+{row.tags.length - 2}</span>}
      </div>
      <div className={`cell-icon-count ${row.depCount ? "has-items" : ""} ${row.isBlockedOpen ? "dep-flag" : ""}`}>
        <LinkIcon /> {row.depCount}
      </div>
      <div className={`cell-icon-count ${row.docCount ? "has-items" : ""}`}>
        <DocIcon /> {row.docCount}
      </div>
    </div>
  );
}

function TopRow({ row, onSelectTask }: { row: TaskRow; onSelectTask?: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <RowLine
        row={row}
        isSub={false}
        expanded={open}
        onToggle={() => setOpen((o) => !o)}
        onSelect={() => onSelectTask?.(row.task.id)}
      />
      {open &&
        row.children?.map((child) => (
          <RowLine key={child.task.id} row={child} isSub onSelect={() => onSelectTask?.(child.task.id)} />
        ))}
    </>
  );
}

export function TaskListView({
  rows,
  vocabTask,
  onSelectTask,
}: {
  rows: TaskRow[];
  vocabTask: string;
  onSelectTask?: (id: string) => void;
}) {
  return (
    <div className="list-table">
      <div className="list-head">
        <div>{vocabTask}</div>
        <div>Team</div>
        <div>Status</div>
        <div>Assignee</div>
        <div>Dates</div>
        <div>Tags</div>
        <div>Deps</div>
        <div>Docs</div>
      </div>
      {rows.length === 0 && <div className="empty-note">No {vocabTask.toLowerCase()}s yet.</div>}
      {rows.map((row) => (
        <TopRow key={row.task.id} row={row} onSelectTask={onSelectTask} />
      ))}
    </div>
  );
}
