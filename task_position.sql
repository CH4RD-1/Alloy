-- Manual Gantt task ordering
-- ----------------------------------------------------------------------------
-- Lets a user reorder rows on the Gantt chart by hand (two up/down arrow
-- buttons next to each top-level task's label — see the "reorderGanttTasks"
-- action in lib/actions.ts and the label-row buttons in
-- components/gantt-view.tsx). Scoped to the Gantt view only: List, Buckets
-- and Calendar keep whatever sort they already use (mostly created_at) and
-- never read this column — buildGanttRows (lib/gantt-view.ts) is the only
-- place position is consulted, and only for top-level rows; subtasks stay
-- ordered however their parent's own row list already orders them.
--
-- Safe to run more than once.

alter table tasks add column if not exists position int not null default 0;

-- Backfill: give every existing task a distinct position matching its
-- current de-facto Gantt order (oldest first within its project), rather
-- than leaving every row tied at 0 — ties would still sort stably by the
-- fetch order today, but distinct values make the very first up/down click
-- behave predictably instead of swapping among a pile of zeros.
with ranked as (
  select id, row_number() over (partition by project_id order by created_at asc) - 1 as rn
  from tasks
)
update tasks
set position = ranked.rn
from ranked
where tasks.id = ranked.id;
