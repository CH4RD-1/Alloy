// Pure scheduling math for the Gantt "Auto-arrange" action — ported from the
// prototype's autoArrange() + propagateSchedule() (see the "Live prototype"
// link in alloy-development-log.md). This first Gantt pass is read-only (no
// drag-to-reschedule), so this runs as a one-shot server action instead of a
// live cascade during a drag — see autoArrangeSchedule() in actions.ts,
// which fetches tasks/links, calls autoArrangeCompute() below, and writes
// back only the tasks whose schedule actually changed.

export interface ScheduleTask {
  id: string;
  start: string | null; // ISO date (yyyy-mm-dd)
  due: string | null;
  isMilestone: boolean;
  blockerIds: string[]; // tasks this one waits on (Block links, one-sided)
  concurrentIds: string[]; // symmetric — due dates stay locked together
  cloneIds: string[]; // symmetric — whole schedule stays mirrored
  parentId: string | null; // subtask containment (see applyParentContainment below) — a
  // different relationship entirely from the three link-based ones above:
  // parent_task_id, not a task_links row.
}

export interface Resolved {
  start: string;
  due: string;
}

export function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b + "T00:00:00").getTime() - new Date(a + "T00:00:00").getTime()) / 86400000);
}

export function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// Two phases, matching the prototype's autoArrange():
//   1. Compact every task to start right after its latest-finishing blocker,
//      iterated to a fixed point (mirrors enforceOwnBlockers, run in a loop).
//   2. Reconcile Concurrent (locked shared due date) and Clone (mirrored
//      schedule) groups against the compacted result (mirrors
//      propagateSchedule). Since phase 1 already fully settles blocker
//      chains, this skips propagateSchedule's extra "re-queue blockers of
//      anything phase 2 changes" step — a no-op in the common case, and a
//      deliberate simplification for this first port.
// Tasks missing a start or due date are left untouched. Returns only the
// tasks whose start/due actually changed.
export function autoArrangeCompute(tasks: ScheduleTask[]): Map<string, Resolved> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const resolved = new Map<string, Resolved>();
  tasks.forEach((t) => {
    if (t.start && t.due) resolved.set(t.id, { start: t.start, due: t.due });
  });

  let changed = true;
  let guard = 0;
  while (changed && guard < 25) {
    changed = false;
    guard++;
    tasks.forEach((t) => {
      const cur = resolved.get(t.id);
      if (!cur || !t.blockerIds.length) return;
      const duration = t.isMilestone ? 0 : Math.max(1, daysBetween(cur.start, cur.due));
      let latestDue: string | null = null;
      t.blockerIds.forEach((depId) => {
        const dep = resolved.get(depId);
        if (dep && (latestDue === null || dep.due > latestDue)) latestDue = dep.due;
      });
      if (latestDue !== null && latestDue !== cur.start) {
        resolved.set(t.id, { start: latestDue, due: addDays(latestDue, duration) });
        changed = true;
      }
    });
  }

  const queue = tasks.map((t) => t.id);
  guard = 0;
  while (queue.length && guard < 400) {
    guard++;
    const id = queue.shift()!;
    const t = byId.get(id);
    const cur = t ? resolved.get(id) : undefined;
    if (!t || !cur) continue;

    t.cloneIds.forEach((cid) => {
      const ct = byId.get(cid);
      const cCur = resolved.get(cid);
      if (!ct || !cCur) return;
      if (cCur.start !== cur.start || cCur.due !== cur.due) {
        resolved.set(cid, { start: cur.start, due: cur.due });
        queue.push(cid);
      }
    });

    t.concurrentIds.forEach((cid) => {
      const ct = byId.get(cid);
      const cCur = resolved.get(cid);
      if (!ct || !cCur) return;
      if (cCur.due !== cur.due) {
        const dur = ct.isMilestone ? 0 : Math.max(1, daysBetween(cCur.start, cCur.due));
        resolved.set(cid, { start: addDays(cur.due, -dur), due: cur.due });
        queue.push(cid);
      }
    });
  }

  const out = new Map<string, Resolved>();
  tasks.forEach((t) => {
    if (!t.start || !t.due) return;
    const r = resolved.get(t.id);
    if (r && (r.start !== t.start || r.due !== t.due)) out.set(t.id, r);
  });
  return out;
}

// The live-drag counterpart to autoArrangeCompute() above — ported from the
// prototype's propagateSchedule(seedIds), the pass that runs after a single
// authoritative date change (drag/resize commit, manual date edit, new
// link) rather than a full one-shot reschedule. Where autoArrangeCompute
// recomputes every task's position from scratch, this only pushes bars that
// are now genuinely in conflict with the seed change — so dragging one bar
// doesn't snap unrelated tasks elsewhere on the chart back into a compacted
// layout the way Auto-arrange does.
//
// `tasks` should already carry the seed task's NEW start/due (the caller
// sets that before calling in) — everything else keeps its stored value.
// Like autoArrangeCompute, this only follows direct blockerIds/concurrentIds/
// cloneIds (not the prototype's full BFS closure over symmetric links) —
// the same "chained links treated as separate pairs" simplification already
// disclosed there.

// ----------------------------------------------------------------------
// Subtask containment — "no subtask should ever exist outside of its
// parent task's duration" (a requested rule, distinct from and additional
// to the Block/Concurrent/Clone link engine above). A parent_task_id
// relationship, not a task_links row, so it needs its own pass rather than
// folding into blockerIds/concurrentIds/cloneIds.
//
// Two halves, used together by every date-mutation call site (a Gantt
// drag/resize, a direct date edit in the task panel, or a new subtask
// being created with its own dates):
//   1. clampToDescendants — before accepting a proposed new schedule for a
//      task that itself HAS subtasks, snap it back out to at least cover
//      whatever its subtasks (and their own subtasks) currently span, so a
//      parent can never be dragged/edited smaller than its own children
//      need. This is the "clamp the parent" behavior.
//   2. applyParentContainment — after a task's schedule actually changes,
//      grow every ancestor above it (parent, then grandparent) whose
//      current range no longer contains the child's new one. This is the
//      "growing the parent when a subtask is dragged past its edge"
//      behavior, and it only ever grows — an ancestor's range never
//      shrinks back on its own just because a descendant moved back in,
//      matching the requested "if the sub task is dragged back the parent
//      stays where it was" behavior exactly.
// Both are pure containment math with no notion of duration/milestone —
// growing a parent's start/due never changes how long ITS OWN bar reads as
// milestone-vs-ranged, since that's driven by is_milestone, not by which
// of start/due moved.
//
// Deliberately scoped: growing an ancestor here does NOT re-run this same
// task's own Block/Concurrent/Clone cascade (cascadeSchedule above) a
// second time for that ancestor — so if a top-level task has its own
// dependency links, and containment growth pushes its due date out, that
// growth doesn't itself ripple into whatever depends on *that* task. The
// common case (dragging a subtask, or editing its dates directly) is
// covered correctly; a grown parent's own onward links are a follow-up if
// it turns out to matter in practice.

function buildChildrenIndex(tasks: ScheduleTask[]): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  tasks.forEach((t) => {
    if (!t.parentId) return;
    const arr = idx.get(t.parentId) ?? [];
    arr.push(t.id);
    idx.set(t.parentId, arr);
  });
  return idx;
}

// Every descendant (children, grandchildren, ...) of taskId — in practice
// at most two levels deep (MAX_TASK_DEPTH in lib/list-view.ts caps subtask
// nesting there), but this walks generically rather than hardcoding that,
// with a visited-set guard against a cycle no normal UI path can create.
function collectDescendantIds(childrenByParent: Map<string, string[]>, taskId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [...(childrenByParent.get(taskId) ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    (childrenByParent.get(id) ?? []).forEach((c) => stack.push(c));
  }
  return out;
}

// Grows [proposedStart, proposedDue] out (never in) so it still covers
// every one of taskId's current descendants — the "can't shrink a parent
// past what its subtasks need" clamp. Descendants without both dates set
// are skipped (nothing to enforce). A task with no descendants gets its
// proposal back unchanged.
export function clampToDescendants(
  tasks: ScheduleTask[],
  taskId: string,
  proposedStart: string,
  proposedDue: string
): Resolved {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const childrenByParent = buildChildrenIndex(tasks);
  let start = proposedStart;
  let due = proposedDue;
  collectDescendantIds(childrenByParent, taskId).forEach((id) => {
    const d = byId.get(id);
    if (!d || !d.start || !d.due) return;
    if (d.start < start) start = d.start;
    if (d.due > due) due = d.due;
  });
  return { start, due };
}

// Walks up from every id in seedIds, growing each ancestor's entry in
// `resolved` (mutated in place) to contain its child's resolved range,
// re-queuing a grown ancestor so its own parent gets checked next —
// that's what lets a sub-subtask's growth bubble all the way up through
// its subtask parent to the top-level task, not just one level. Returns
// the ids of every ancestor actually grown (so a caller who *does* want to
// re-run the link cascade for them can do so).
export function applyParentContainment(tasks: ScheduleTask[], resolved: Map<string, Resolved>, seedIds: string[]): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const grown = new Set<string>();
  const queue = [...seedIds];
  let guard = 0;
  while (queue.length && guard < 200) {
    guard++;
    const id = queue.shift()!;
    const t = byId.get(id);
    const cur = t ? resolved.get(id) : undefined;
    if (!t || !cur || !t.parentId) continue;
    const parentCur = resolved.get(t.parentId);
    if (!parentCur) continue;
    let { start, due } = parentCur;
    let changed = false;
    if (cur.start < start) {
      start = cur.start;
      changed = true;
    }
    if (cur.due > due) {
      due = cur.due;
      changed = true;
    }
    if (changed) {
      resolved.set(t.parentId, { start, due });
      grown.add(t.parentId);
      queue.push(t.parentId);
    }
  }
  return Array.from(grown);
}

export function cascadeSchedule(tasks: ScheduleTask[], seedIds: string[]): Map<string, Resolved> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const resolved = new Map<string, Resolved>();
  tasks.forEach((t) => {
    if (t.start && t.due) resolved.set(t.id, { start: t.start, due: t.due });
  });

  const queue = [...seedIds];
  let guard = 0;
  while (queue.length && guard < 400) {
    guard++;
    const id = queue.shift()!;
    const t = byId.get(id);
    const curInit = t ? resolved.get(id) : undefined;
    if (!t || !curInit) continue;

    // enforceOwnBlockers: can't start before the latest-finishing blocker —
    // push the whole bar later (preserving duration) if it does.
    if (t.blockerIds.length) {
      const blockerDues: string[] = [];
      for (const depId of t.blockerIds) {
        const dep = resolved.get(depId);
        if (dep) blockerDues.push(dep.due);
      }
      if (blockerDues.length) {
        const ld = blockerDues.reduce((a, b) => (a > b ? a : b));
        if (curInit.start < ld) {
          const dur = t.isMilestone ? 0 : Math.max(1, daysBetween(curInit.start, curInit.due));
          resolved.set(id, { start: ld, due: addDays(ld, dur) });
          queue.push(id);
        }
      }
    }

    // Re-read after the possible push-later above, so clone/concurrent sync
    // below uses the settled value rather than the pre-enforcement one.
    const cur = resolved.get(id)!;

    t.cloneIds.forEach((cid) => {
      const ct = byId.get(cid);
      const cCur = resolved.get(cid);
      if (!ct || !cCur) return;
      if (cCur.start !== cur.start || cCur.due !== cur.due) {
        resolved.set(cid, { start: cur.start, due: cur.due });
        queue.push(cid);
      }
    });

    t.concurrentIds.forEach((cid) => {
      const ct = byId.get(cid);
      const cCur = resolved.get(cid);
      if (!ct || !cCur) return;
      if (cCur.due !== cur.due) {
        const dur = ct.isMilestone ? 0 : Math.max(1, daysBetween(cCur.start, cCur.due));
        resolved.set(cid, { start: addDays(cur.due, -dur), due: cur.due });
        queue.push(cid);
      }
    });

    // Re-check anything that blocks on this task — its own constraint may
    // now be satisfied or violated differently.
    tasks.forEach((other) => {
      if (other.id !== id && other.blockerIds.includes(id)) queue.push(other.id);
    });
  }

  const out = new Map<string, Resolved>();
  tasks.forEach((t) => {
    if (!t.start || !t.due) return;
    const r = resolved.get(t.id);
    if (r && (r.start !== t.start || r.due !== t.due)) out.set(t.id, r);
  });
  return out;
}
