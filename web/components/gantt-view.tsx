"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { TaskRow } from "@/lib/list-view";
import type { Project, TaskLink, LinkType } from "@/lib/types";
import { buildConnectors, buildGanttRows, computeGanttLayout, LINK_DX, LINK_DY, type Geom, type GanttLayout } from "@/lib/gantt-view";
import { addDays, daysBetween } from "@/lib/gantt-schedule";
import { autoArrangeSchedule, updateTaskSchedule, addLink, removeLink, reorderGanttTasks } from "@/lib/actions";

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

// Up/down row-reorder glyphs — the same chevron path as ChevronIcon above,
// just rotated, so the two read as one consistent icon family rather than
// mixing in a different arrow style.
function CaretIcon({ direction }: { direction: "up" | "down" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="10"
      height="10"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: direction === "up" ? "rotate(-90deg)" : "rotate(90deg)" }}
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

// Same chain-link glyph as the prototype's linkIconAt() — kept as its own
// component so the live-drag DOM patch in updateBarLiveDOM() below can find
// it by class name rather than by tag.
function LinkGlyph({ cx, cy }: { cx: number; cy: number }) {
  return (
    <svg
      className="gantt-link-icon"
      x={cx - 6}
      y={cy - 6}
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--accent)"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
    </svg>
  );
}

const CONNECTOR_COLOR: Record<string, string> = {
  blocked: "var(--text-faint)",
  concurrent: "var(--review)",
  clone: "var(--progress)",
};

// Same five types/labels/colors as task-panel.tsx's own LINK_TYPE_META —
// duplicated rather than shared since that file's copy is a local const,
// not exported; both describe the same fixed LinkType union so they can't
// drift silently.
const LINK_TYPE_META: Record<LinkType, { label: string; className: string }> = {
  blocked: { label: "Blocked", className: "link-type-block" },
  blocks: { label: "Blocks", className: "link-type-block" },
  concurrent: { label: "Concurrent", className: "link-type-concurrent" },
  related: { label: "Related", className: "link-type-related" },
  clone: { label: "Clone", className: "link-type-clone" },
};

// The floating link-type menu's own option list (see the menu render
// below). A Gantt connector always represents the "blocked" half of a
// blocked/blocks pair (buildConnectors only draws from that row — see
// lib/gantt-view.ts), so the menu's own "Blocked" option is the connector's
// current, active state; "Blocks" is a flip action — remove the pair and
// re-add it with the blocker/blocked ends reversed (addLink() rebuilds
// both mirror rows) — not a second, independently-selectable state, hence
// it's never shown as active. Both still resolve to the same "blocked"
// link_type going into addLink/removeLink (see handleApplyLink below), so
// both use the same red link-type-block styling.
// addLink() never accepts "blocks" directly (it's always the auto-generated
// mirror row — see lib/actions.ts), so this menu can only ever apply one of
// these four types, never that fifth LinkType value.
type ApplicableLinkType = "blocked" | "concurrent" | "related" | "clone";
const LINK_MENU_OPTIONS: { key: string; label: string; className: string; type: ApplicableLinkType; swap: boolean }[] = [
  { key: "blocked", label: "Blocked", className: "link-type-block", type: "blocked", swap: false },
  { key: "blocks", label: "Blocks", className: "link-type-block", type: "blocked", swap: true },
  { key: "concurrent", label: LINK_TYPE_META.concurrent.label, className: LINK_TYPE_META.concurrent.className, type: "concurrent", swap: false },
  { key: "related", label: LINK_TYPE_META.related.label, className: LINK_TYPE_META.related.className, type: "related", swap: false },
  { key: "clone", label: LINK_TYPE_META.clone.label, className: LINK_TYPE_META.clone.className, type: "clone", swap: false },
];

// See the drag handlers below — applied for the duration of any bar/link/pan
// drag so a fast mouse movement never triggers the browser's own
// drag-to-select-text behavior outside the chart.
function disableTextSelection() {
  document.body.style.userSelect = "none";
}
function restoreTextSelection() {
  document.body.style.userSelect = "";
}

// Subtask containment (see gantt-schedule.ts's own header comment) — the
// tightest [minStart, maxDue] every one of taskRow's own descendants
// (subtasks, and their own subtasks) currently needs, or null when it has
// none. Used to clamp a parent's own drag/resize live, so the bar visibly
// refuses to shrink past what its children need rather than only getting
// silently corrected after the fact on commit (updateTaskSchedule does
// that same clamp server-side too — this is purely the live-feedback
// half). Walks TaskRow.children directly rather than the Gantt's own
// visible/expanded rows, so this is accurate even while a task's subtasks
// are currently collapsed.
function descendantBounds(taskRow: TaskRow): { minStart: string; maxDue: string } | null {
  let minStart: string | null = null;
  let maxDue: string | null = null;
  const visit = (r: TaskRow) => {
    (r.children ?? []).forEach((c) => {
      if (c.task.start_date && c.task.due_date) {
        if (minStart === null || c.task.start_date < minStart) minStart = c.task.start_date;
        if (maxDue === null || c.task.due_date > maxDue) maxDue = c.task.due_date;
      }
      visit(c);
    });
  };
  visit(taskRow);
  if (minStart === null || maxDue === null) return null;
  return { minStart, maxDue };
}

function svgPoint(svg: SVGSVGElement, clientX: number, clientY: number) {
  const r = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  const scaleX = vb.width / r.width || 1;
  const scaleY = vb.height / r.height || 1;
  return { x: (clientX - r.left) * scaleX, y: (clientY - r.top) * scaleY };
}

// Directly patches one bar's DOM during a move/resize drag — mirrors the
// prototype's updateGanttBarLive() exactly (same fields, same math), just
// scoped to this component's own <svg> instead of a module-level query.
// Bypassing React state here is deliberate: re-rendering the whole SVG on
// every mousemove is both unnecessary (nothing else on the chart needs to
// know mid-drag) and visibly laggy compared to a raw attribute patch. The
// real React state (via router.refresh() after the server commit) is what
// makes the change durable; this is just the 60fps illusion in between.
function updateBarLiveDOM(svg: SVGSVGElement, taskId: string, newStart: string, newDue: string, layout: GanttLayout, isMilestone: boolean) {
  const group = svg.querySelector(`[data-task-group="${CSS.escape(taskId)}"]`);
  if (!group) return;
  const { dayW, minD } = layout;
  const node = group.querySelector(".gantt-link-node") as SVGCircleElement | null;
  const icon = group.querySelector(".gantt-link-icon") as SVGSVGElement | null;

  if (isMilestone) {
    const shape = group.querySelector(".gantt-milestone") as SVGPolygonElement | null;
    if (!shape) return;
    const cx = daysBetween(minD, newStart) * dayW;
    const cy = Number(shape.dataset.cy);
    const s = Number(shape.dataset.size);
    shape.setAttribute("points", `${cx},${cy - s} ${cx + s},${cy} ${cx},${cy + s} ${cx - s},${cy}`);
    const linkCX = cx + s + LINK_DX;
    const linkCY = cy + LINK_DY;
    if (node) {
      node.setAttribute("cx", String(linkCX));
      node.setAttribute("cy", String(linkCY));
    }
    if (icon) {
      icon.setAttribute("x", String(linkCX - 6));
      icon.setAttribute("y", String(linkCY - 6));
    }
    return;
  }

  const rect = group.querySelector(".gantt-bar-rect") as SVGRectElement | null;
  if (!rect) return;
  const leftHandle = group.querySelector('[data-gantt-role="resize-left"]') as SVGRectElement | null;
  const rightHandle = group.querySelector('[data-gantt-role="resize-right"]') as SVGRectElement | null;
  const x = daysBetween(minD, newStart) * dayW;
  const w = Math.max(8, daysBetween(minD, newDue) * dayW - x);
  rect.setAttribute("x", String(x));
  rect.setAttribute("width", String(w));
  if (leftHandle) leftHandle.setAttribute("x", String(x));
  if (rightHandle) rightHandle.setAttribute("x", String(x + w - 5));
  const y = Number(rect.getAttribute("y"));
  const h = Number(rect.getAttribute("height"));
  const nodeCY = y + h / 2;
  const linkCX = x + w + LINK_DX;
  const linkCY = nodeCY + LINK_DY;
  if (node) {
    node.setAttribute("cx", String(linkCX));
    node.setAttribute("cy", String(linkCY));
  }
  if (icon) {
    icon.setAttribute("x", String(linkCX - 6));
    icon.setAttribute("y", String(linkCY - 6));
  }
}

interface LinkMenuState {
  fromTaskId: string; // the dependent/owner side — matches addLink's convention
  toTaskId: string;
  type: LinkType;
  x: number;
  y: number;
}

export function GanttView({
  rows,
  projects,
  links,
  orgId,
  vocabTask,
  onSelectTask,
  onPreviewTask,
  onPatchTasks,
}: {
  rows: TaskRow[];
  projects: Project[];
  links: TaskLink[];
  orgId: string;
  vocabTask: string;
  onSelectTask: (id: string) => void;
  onPreviewTask: (id: string, x: number, y: number) => void;
  // Optimistic patch overlay hook (see tasks-workspace.tsx's own comment on
  // `taskPatches`) — called the instant a schedule commit resolves with
  // every task the server actually moved (the drag itself plus any
  // cascade/containment fallout), so the chart never has to wait on
  // router.refresh() re-fetching before it can show the real result.
  onPatchTasks: (patches: Record<string, { start_date: string; due_date: string }>) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linkMenu, setLinkMenu] = useState<LinkMenuState | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // The chart's own visible width — fed into computeGanttLayout so the day
  // range (and so the grid) stretches to fill the viewport instead of
  // stopping dead after the last task and leaving a blank, gridless strip
  // (see request that prompted this). Doesn't affect where anything is
  // actually dated, only how far the cosmetic grid extends.
  const [containerWidth, setContainerWidth] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setContainerWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Stable for the render — this is a display cue (the today-line), not a
  // live clock, so it doesn't need to tick.
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const ganttRows = useMemo(() => buildGanttRows({ rows, projects, expanded }), [rows, projects, expanded]);

  // Subtask containment clamp bounds, keyed by task id, for every row
  // currently on the chart — see descendantBounds' own comment above.
  const descendantBoundsById = useMemo(() => {
    const m = new Map<string, { minStart: string; maxDue: string } | null>();
    ganttRows.forEach((r) => m.set(r.row.task.id, descendantBounds(r.row)));
    return m;
  }, [ganttRows]);
  const layout = useMemo(() => computeGanttLayout(ganttRows, todayIso, containerWidth), [ganttRows, todayIso, containerWidth]);
  const connectors = useMemo(
    () => (layout ? buildConnectors(ganttRows, layout.geom, links) : []),
    [ganttRows, layout, links]
  );

  // Blockers indexed by the dependent task, for the link-drag drop guard
  // (mirrors the prototype's blockersOf() check before addLink).
  const blockersByTask = useMemo(() => {
    const m = new Map<string, string[]>();
    links.filter((l) => l.link_type === "blocked").forEach((l) => {
      const arr = m.get(l.from_task_id) ?? [];
      arr.push(l.to_task_id);
      m.set(l.from_task_id, arr);
    });
    return m;
  }, [links]);

  const teamLegend = useMemo(() => {
    const seen = new Map<string, string>();
    ganttRows.forEach((r) => {
      if (r.row.teamName && !seen.has(r.row.teamName)) seen.set(r.row.teamName, r.row.teamColor ?? "#8b9199");
    });
    return Array.from(seen.entries());
  }, [ganttRows]);

  const hasConcurrent = connectors.some((c) => c.type === "concurrent");
  const hasClone = connectors.some((c) => c.type === "clone");
  const hasMilestone = ganttRows.some((r) => r.row.task.is_milestone);

  const excludedByHelpdesk = rows.length > 0 && ganttRows.length === 0;

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleAutoArrange() {
    setMessage(null);
    setError(null);
    startTransition(async () => {
      try {
        const changes = await autoArrangeSchedule(orgId);
        // Auto-arrange can touch tasks anywhere in the org, several rows
        // away from anything currently on screen mid-drag, so there's no
        // "live" position to preserve here the way a drag has — patch
        // straight to the server's real answer instead of waiting on
        // router.refresh() to re-render with it.
        if (changes.length > 0) {
          onPatchTasks(Object.fromEntries(changes.map((c) => [c.id, { start_date: c.start_date, due_date: c.due_date }])));
        }
        setMessage(
          changes.length > 0
            ? `Rescheduled ${changes.length} ${changes.length === 1 ? vocabTask.toLowerCase() : vocabTask.toLowerCase() + "s"}.`
            : "Already in order — nothing to move."
        );
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't auto-arrange.");
      }
    });
  }

  const commitSchedule = useCallback(
    (taskId: string, start: string, due: string) => {
      // Patch the dragged bar's own new dates immediately, before the
      // server round-trip even starts — this is what actually fixes the
      // "laggy" feel: without it, the live drag's direct DOM patch ends on
      // mouseup and React's very next render falls back to the still-stale
      // `rows` prop, snapping the bar back to where it started until
      // router.refresh() eventually lands and it jumps forward again.
      onPatchTasks({ [taskId]: { start_date: start, due_date: due } });
      startTransition(async () => {
        try {
          const changes = await updateTaskSchedule(orgId, taskId, start, due);
          // Layer in whatever else the cascade/containment math moved (a
          // blocked task pushed later, a concurrent/clone partner
          // re-synced, an ancestor grown) — none of that was visible from
          // the drag alone.
          if (changes.length > 0) {
            onPatchTasks(Object.fromEntries(changes.map((c) => [c.id, { start_date: c.start_date, due_date: c.due_date }])));
          }
          router.refresh();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Couldn't save that change — reloading.");
          router.refresh();
        }
      });
    },
    [orgId, router, startTransition, onPatchTasks]
  );

  const commitLink = useCallback(
    (fromTaskId: string, toTaskId: string) => {
      startTransition(async () => {
        try {
          await addLink(orgId, fromTaskId, toTaskId, "blocked");
          router.refresh();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Couldn't create that link.");
        }
      });
    },
    [orgId, router, startTransition]
  );

  // Manual reorder — only top-level rows are ever swapped (a subtask stays
  // wherever its parent's own children array puts it); moving the first row
  // up or the last row down is a no-op via the bounds check below, which is
  // also what disables the corresponding arrow in the render. Rewrites the
  // *whole* currently-visible top-level order in one call (reorderGanttTasks
  // in lib/actions.ts), mirroring reorderWorkflowStatuses's wholesale
  // approach, rather than trying to swap just two rows' position values —
  // simpler, and self-healing for any rows still sitting on the 0 default.
  const topLevelIds = useMemo(() => ganttRows.filter((r) => r.depth === 0).map((r) => r.row.task.id), [ganttRows]);

  const moveTaskRow = useCallback(
    (taskId: string, direction: "up" | "down") => {
      const idx = topLevelIds.indexOf(taskId);
      if (idx === -1) return;
      const swapWith = direction === "up" ? idx - 1 : idx + 1;
      if (swapWith < 0 || swapWith >= topLevelIds.length) return;
      const next = [...topLevelIds];
      [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
      setError(null);
      startTransition(async () => {
        try {
          await reorderGanttTasks(orgId, next);
          router.refresh();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Couldn't reorder that row.");
        }
      });
    },
    [topLevelIds, orgId, router, startTransition]
  );

  // ---- drag to move / resize -------------------------------------------------
  function handleBarMouseDown(e: React.MouseEvent, taskId: string, mode: "move" | "resize-left" | "resize-right", origStart: string | null, origDue: string | null, isMilestone: boolean) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    // A task with no start/due yet (the Gantt still draws it, as a small
    // placeholder stub — see computeGanttLayout) has nothing meaningful to
    // drag: fall straight through to opening the task panel instead, same
    // as a no-movement click, rather than dragging on top of null dates.
    if (!origStart || !origDue) {
      if (mode === "move") onPreviewTask(taskId, e.clientX, e.clientY);
      return;
    }
    // Re-bind as plain `string` locals — TS's flow narrowing above doesn't
    // carry into the nested onMove/onUp closures below (they close over the
    // original `string | null` parameters), and these are never reassigned.
    const origStartS: string = origStart;
    const origDueS: string = origDue;
    const svg = svgRef.current;
    if (!svg || !layout) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const groupEl = (e.currentTarget as SVGElement).closest(".gantt-bar-group");
    groupEl?.classList.add("dragging");
    disableTextSelection();
    let moved = false;
    let finalStart = origStartS;
    let finalDue = origDueS;

    function onMove(ev: MouseEvent) {
      if (Math.abs(ev.clientX - startX) > 3 || Math.abs(ev.clientY - startY) > 3) moved = true;
      const deltaDays = Math.round((ev.clientX - startX) / layout!.dayW);
      let newStart = origStartS;
      let newDue = origDueS;
      if (mode === "move") {
        newStart = addDays(origStartS, deltaDays);
        newDue = addDays(origDueS, deltaDays);
      } else if (mode === "resize-left") {
        newStart = addDays(origStartS, deltaDays);
        if (daysBetween(newStart, origDueS) < 1) newStart = addDays(origDueS, -1);
        newDue = origDueS;
      } else {
        newDue = addDays(origDueS, deltaDays);
        if (daysBetween(origStartS, newDue) < 1) newDue = addDays(origStartS, 1);
        newStart = origStartS;
      }
      // Subtask containment: can't drag/resize this bar smaller than its
      // own subtasks (and their own subtasks) currently need — clamped
      // live here for immediate feedback, and again authoritatively by
      // updateTaskSchedule on commit (see that function's own comment).
      const bounds = descendantBoundsById.get(taskId);
      if (bounds) {
        if (newStart > bounds.minStart) newStart = bounds.minStart;
        if (newDue < bounds.maxDue) newDue = bounds.maxDue;
      }
      finalStart = newStart;
      finalDue = newDue;
      updateBarLiveDOM(svg!, taskId, newStart, newDue, layout!, isMilestone);
    }
    function onUp(ev: MouseEvent) {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      groupEl?.classList.remove("dragging");
      restoreTextSelection();
      if (!moved) {
        if (mode === "move") onPreviewTask(taskId, ev.clientX, ev.clientY);
        return;
      }
      commitSchedule(taskId, finalStart, finalDue);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // ---- drag to create a link --------------------------------------------------
  function handleLinkMouseDown(e: React.MouseEvent, taskId: string, g: Geom) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const svg = svgRef.current;
    if (!svg) return;

    disableTextSelection();
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("class", "gantt-link-preview");
    line.setAttribute("x1", String(g.linkCX));
    line.setAttribute("y1", String(g.linkCY));
    line.setAttribute("x2", String(g.linkCX));
    line.setAttribute("y2", String(g.linkCY));
    svg.appendChild(line);

    let hoverTarget: Element | null = null;

    function clearHover() {
      if (hoverTarget) {
        hoverTarget.querySelector(".gantt-bar-rect, .gantt-milestone")?.classList.remove("link-target");
        hoverTarget = null;
      }
    }

    function onMove(ev: MouseEvent) {
      const p = svgPoint(svg!, ev.clientX, ev.clientY);
      line.setAttribute("x2", String(p.x));
      line.setAttribute("y2", String(p.y));
      const hoverEl = document.elementFromPoint(ev.clientX, ev.clientY);
      const grp = hoverEl?.closest(".gantt-bar-group") ?? null;
      const valid = grp && grp.getAttribute("data-task-group") !== taskId ? grp : null;
      if (hoverTarget !== valid) {
        clearHover();
        if (valid) {
          valid.querySelector(".gantt-bar-rect, .gantt-milestone")?.classList.add("link-target");
          hoverTarget = valid;
        }
      }
    }
    function onUp(ev: MouseEvent) {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      restoreTextSelection();
      clearHover();
      line.remove();
      const dropEl = document.elementFromPoint(ev.clientX, ev.clientY);
      const grp = dropEl?.closest(".gantt-bar-group");
      const targetId = grp?.getAttribute("data-task-group");
      if (targetId && targetId !== taskId) {
        const targetBlockers = blockersByTask.get(targetId) ?? [];
        const sourceBlockers = blockersByTask.get(taskId) ?? [];
        // Same guard as the prototype's drop handler: no self-links, and no
        // creating a link that would just restate (or invert) one that
        // already exists between this exact pair.
        if (!targetBlockers.includes(taskId) && !sourceBlockers.includes(targetId)) {
          commitLink(targetId, taskId);
        }
      }
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // ---- click-drag panning on blank chart space --------------------------------
  function handlePanMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    if ((e.target as Element).closest("[data-gantt-role], .gantt-link-hit")) return;
    e.preventDefault();
    const scrollEl = e.currentTarget;
    const startX = e.clientX;
    const startScrollLeft = scrollEl.scrollLeft;
    scrollEl.classList.add("panning");
    disableTextSelection();
    function onMove(ev: MouseEvent) {
      scrollEl.scrollLeft = startScrollLeft - (ev.clientX - startX);
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      scrollEl.classList.remove("panning");
      restoreTextSelection();
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // ---- the link menu (change type / remove) ------------------------------------
  function openLinkMenu(e: React.MouseEvent, fromTaskId: string, toTaskId: string, type: LinkType) {
    e.stopPropagation();
    setLinkMenu({ fromTaskId, toTaskId, type, x: e.clientX, y: e.clientY });
  }

  useEffect(() => {
    if (!linkMenu) return;
    function onDocMouseDown(ev: MouseEvent) {
      if ((ev.target as Element).closest(".gantt-link-menu")) return;
      setLinkMenu(null);
    }
    function onScroll() {
      setLinkMenu(null);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [linkMenu]);

  function handleApplyLink(newType: ApplicableLinkType, swap: boolean) {
    if (!linkMenu) return;
    const { fromTaskId, toTaskId, type } = linkMenu;
    setLinkMenu(null);
    if (newType === type && !swap) return;
    const newFrom = swap ? toTaskId : fromTaskId;
    const newTo = swap ? fromTaskId : toTaskId;
    startTransition(async () => {
      try {
        await removeLink(fromTaskId, toTaskId, type);
        await addLink(orgId, newFrom, newTo, newType);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't change that link.");
      }
    });
  }
  function handleRemoveLink() {
    if (!linkMenu) return;
    const { fromTaskId, toTaskId, type } = linkMenu;
    setLinkMenu(null);
    startTransition(async () => {
      try {
        await removeLink(fromTaskId, toTaskId, type);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't remove that link.");
      }
    });
  }

  return (
    <>
      <div className="view-head">
        <div>
          <div className="view-title">Gantt</div>
          <div className="view-sub">Drag a bar to move it, or its edges to resize · drag the small link handle to connect it to another · drag empty space to pan · click a connector to change or remove it</div>
        </div>
        <button type="button" className="small-btn" onClick={handleAutoArrange} disabled={pending} title="Reschedule tasks to start right after their dependencies finish">
          ⇄ Auto-arrange
        </button>
      </div>

      {error && <div className="banner">{error}</div>}
      {message && !error && <div className="banner">{message}</div>}

      {!layout ? (
        <div className="empty-note">
          {excludedByHelpdesk
            ? `The ${vocabTask.toLowerCase()}s here belong to a Helpdesk project — those aren't scheduled, so they never appear on the Gantt.`
            : `No ${vocabTask.toLowerCase()}s to schedule yet.`}
        </div>
      ) : (
        <div className="gantt-wrap">
          <div className="gantt-legend">
            {teamLegend.map(([name, color]) => (
              <span className="legend-item" key={name}>
                <span className="legend-swatch" style={{ background: color }} />
                {name}
              </span>
            ))}
            {hasConcurrent && (
              <span className="legend-item">
                <span className="legend-swatch" style={{ background: "var(--review)" }} />
                Concurrent (locked end date)
              </span>
            )}
            {hasClone && (
              <span className="legend-item">
                <span className="legend-swatch" style={{ background: "var(--progress)" }} />
                Clone (locked schedule)
              </span>
            )}
            {hasMilestone && <span className="legend-item">◆ Milestone (no duration)</span>}
          </div>
          <div className="gantt-body">
            <div className="gantt-labels">
              <div className="gantt-header-spacer">{vocabTask}</div>
              {ganttRows.map((r) => (
                <div
                  key={r.row.task.id}
                  className={`gantt-label-row ${r.depth > 0 ? "sub" : ""} ${r.depth > 1 ? "subsub" : ""}`}
                  onClick={() => onSelectTask(r.row.task.id)}
                >
                  {r.row.children?.length ? (
                    <button
                      type="button"
                      className={`expand-btn ${expanded.has(r.row.task.id) ? "open" : ""}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleExpand(r.row.task.id);
                      }}
                      aria-label={expanded.has(r.row.task.id) ? "Collapse subtasks" : "Expand subtasks"}
                    >
                      <ChevronIcon open={expanded.has(r.row.task.id)} />
                    </button>
                  ) : (
                    <span className="expand-spacer" />
                  )}
                  {r.row.task.is_milestone && (
                    <span style={{ color: "var(--accent)", flex: "0 0 auto" }} title="Milestone">
                      ◆
                    </span>
                  )}
                  {r.row.task.display_id && <span className="task-id-badge">{r.row.task.display_id}</span>}
                  <span className="row-title" title={r.row.task.title}>
                    {r.row.task.title}
                  </span>
                  {r.depth === 0 && topLevelIds.length > 1 && (
                    <span className="gantt-reorder-btns" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        className="gantt-reorder-btn"
                        disabled={pending || topLevelIds.indexOf(r.row.task.id) === 0}
                        onClick={() => moveTaskRow(r.row.task.id, "up")}
                        aria-label="Move up"
                        title="Move up"
                      >
                        <CaretIcon direction="up" />
                      </button>
                      <button
                        type="button"
                        className="gantt-reorder-btn"
                        disabled={pending || topLevelIds.indexOf(r.row.task.id) === topLevelIds.length - 1}
                        onClick={() => moveTaskRow(r.row.task.id, "down")}
                        aria-label="Move down"
                        title="Move down"
                      >
                        <CaretIcon direction="down" />
                      </button>
                    </span>
                  )}
                </div>
              ))}
            </div>
            <div className="gantt-scroll" ref={scrollRef} onMouseDown={handlePanMouseDown}>
              <svg ref={svgRef} width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`}>
                <defs>
                  <marker id="gantt-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto">
                    <path d="M0,0 L6,3 L0,6 z" fill="var(--text-faint)" />
                  </marker>
                </defs>

                {layout.mondayLines.map((x) => (
                  <line key={`mon-${x}`} x1={x} y1={layout.headerH} x2={x} y2={layout.height} stroke="var(--border)" strokeWidth={1} />
                ))}
                {layout.months.map((m) => (
                  <g key={`month-${m.x}`}>
                    <line x1={m.x} y1={0} x2={m.x} y2={layout.height} stroke="var(--border)" strokeWidth={1} />
                    <text x={m.x + 6} y={18} fontSize={10.5} fontFamily="var(--font-mono)" fill="var(--text-faint)" fontWeight={600}>
                      {m.label}
                    </text>
                  </g>
                ))}
                {ganttRows.map((r, i) => (
                  <line
                    key={`sep-${r.row.task.id}`}
                    x1={0}
                    y1={layout.headerH + i * layout.rowH + layout.rowH}
                    x2={layout.width}
                    y2={layout.headerH + i * layout.rowH + layout.rowH}
                    stroke="var(--border)"
                    strokeWidth={1}
                  />
                ))}
                {layout.todayX !== null && (
                  <>
                    <line x1={layout.todayX} y1={0} x2={layout.todayX} y2={layout.height} stroke="var(--accent)" strokeWidth={1.5} strokeDasharray="4 3" />
                    <rect x={layout.todayX - 16} y={layout.headerH - 16} width={34} height={14} rx={3} fill="var(--accent)" />
                    <text x={layout.todayX - 13} y={layout.headerH - 6} fontSize={9} fontFamily="var(--font-mono)" fill="var(--on-accent)" fontWeight={700}>
                      TODAY
                    </text>
                  </>
                )}

                {connectors.map((c, i) => (
                  <g key={`c-${i}`}>
                    <line
                      x1={c.x1}
                      y1={c.y1}
                      x2={c.x2}
                      y2={c.y2}
                      stroke={CONNECTOR_COLOR[c.type]}
                      strokeWidth={c.type === "blocked" ? 1.4 : 2}
                      strokeLinecap={c.type === "blocked" ? undefined : "round"}
                      strokeDasharray={c.type === "blocked" ? "4 3" : c.type === "concurrent" ? "3 3" : "5 3"}
                      opacity={c.type === "blocked" ? 1 : 0.85}
                      markerEnd={c.type === "blocked" ? "url(#gantt-arrow)" : undefined}
                      pointerEvents="none"
                    />
                    {/* Wide, invisible hit target on top of the thin visible line — same
                        idea as the prototype's .gantt-link-hit, just wide enough to click
                        without needing to land exactly on a ~1.4px stroke. */}
                    <line
                      className="gantt-link-hit"
                      x1={c.x1}
                      y1={c.y1}
                      x2={c.x2}
                      y2={c.y2}
                      stroke="transparent"
                      strokeWidth={10}
                      onClick={(e) => openLinkMenu(e, c.fromTaskId, c.toTaskId, c.type)}
                    />
                  </g>
                ))}

                {ganttRows.map((r, i) => {
                  const g = layout.geom[i];
                  const t = r.row.task;
                  const fill = r.row.teamColor ?? "#8b9199";
                  // is_closed rather than statusKey === "done" — a bar's own
                  // project workflow can be Helpdesk, Assets, or a custom one now.
                  const opacity = r.row.statusIsClosed ? 0.55 : 1;

                  if (g.milestone) {
                    return (
                      <g key={t.id} className="gantt-bar-group" data-task-group={t.id}>
                        <polygon
                          className="gantt-milestone"
                          data-gantt-role="move"
                          data-cy={g.nodeCY}
                          data-size={g.s}
                          points={`${g.cx},${g.nodeCY - g.s} ${g.cx + g.s},${g.nodeCY} ${g.cx},${g.nodeCY + g.s} ${g.cx - g.s},${g.nodeCY}`}
                          fill={fill}
                          opacity={opacity}
                          stroke="var(--surface)"
                          strokeWidth={1.5}
                          onMouseDown={(e) => handleBarMouseDown(e, t.id, "move", t.start_date, t.due_date, true)}
                        />
                        <circle
                          className="gantt-link-node"
                          data-gantt-role="link"
                          cx={g.linkCX}
                          cy={g.linkCY}
                          r={9}
                          onMouseDown={(e) => handleLinkMouseDown(e, t.id, g)}
                        />
                        <LinkGlyph cx={g.linkCX} cy={g.linkCY} />
                      </g>
                    );
                  }

                  return (
                    <g key={t.id} className="gantt-bar-group" data-task-group={t.id}>
                      <rect
                        className="gantt-bar-rect"
                        data-gantt-role="move"
                        x={g.x}
                        y={g.y}
                        width={g.w}
                        height={g.h}
                        rx={5}
                        fill={fill}
                        opacity={opacity}
                        onMouseDown={(e) => handleBarMouseDown(e, t.id, "move", t.start_date, t.due_date, false)}
                      />
                      <rect
                        className="gantt-handle"
                        data-gantt-role="resize-left"
                        x={g.x}
                        y={g.y + 2}
                        width={5}
                        height={g.h - 4}
                        rx={2}
                        fill="var(--text-faint)"
                        onMouseDown={(e) => handleBarMouseDown(e, t.id, "resize-left", t.start_date, t.due_date, false)}
                      />
                      <rect
                        className="gantt-handle"
                        data-gantt-role="resize-right"
                        x={g.x + g.w - 5}
                        y={g.y + 2}
                        width={5}
                        height={g.h - 4}
                        rx={2}
                        fill="var(--text-faint)"
                        onMouseDown={(e) => handleBarMouseDown(e, t.id, "resize-right", t.start_date, t.due_date, false)}
                      />
                      <circle
                        className="gantt-link-node"
                        data-gantt-role="link"
                        cx={g.linkCX}
                        cy={g.linkCY}
                        r={9}
                        onMouseDown={(e) => handleLinkMouseDown(e, t.id, g)}
                      />
                      <LinkGlyph cx={g.linkCX} cy={g.linkCY} />
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>
        </div>
      )}

      {linkMenu && (
        <div className="obj-menu gantt-link-menu" style={{ position: "fixed", left: linkMenu.x + 10, top: linkMenu.y + 10, zIndex: 60 }}>
          {LINK_MENU_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              className={`obj-menu-item${!opt.swap && opt.type === linkMenu.type ? " active" : ""}`}
              onClick={() => handleApplyLink(opt.type, opt.swap)}
            >
              <span className={`chip link-type-chip ${opt.className}`}>{opt.label}</span>
            </button>
          ))}
          <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />
          <button type="button" className="obj-menu-item" style={{ color: "var(--blocked)" }} onClick={handleRemoveLink}>
            Remove link
          </button>
        </div>
      )}
    </>
  );
}
