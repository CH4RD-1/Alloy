-- Backfills a tag onto every existing project that doesn't have one yet,
-- using the same rule lib/actions.ts's deriveProjectTag() now applies
-- automatically to any newly-created project left blank: the project
-- name's own first 2 alphanumeric characters ("General" -> "GE",
-- "Support" -> "SU"), falling back through <first-letter><digit> and then
-- every two-letter combination until an org-unused tag is found.
--
-- Why this matters: next_task_display_id() (see schema.sql) returns a
-- null display_id for every task created in an untagged project, and
-- that's permanent — setting a project's tag later never backfills the
-- display_id of a task that already exists (see tasks.display_id's own
-- comment). This migration only fixes the project-level gap (every task
-- created in a previously-untagged project *from now on* gets a proper
-- <TAG><number> id); it does not, and safely can't, retroactively invent
-- display_ids for tasks that were already created while their project had
-- no tag.
--
-- Idempotent: only touches rows where tag is still null, so running this
-- again after a project already got backfilled (or after a user sets one
-- by hand) is a safe no-op for that row.
do $$
declare
  proj record;
  base text;
  candidate text;
  found_tag text;
  i int;
begin
  for proj in select id, org_id, name from projects where tag is null order by created_at loop
    base := upper(regexp_replace(proj.name, '[^a-zA-Z0-9]', '', 'g'));
    found_tag := null;

    if length(base) >= 2 then
      candidate := substring(base from 1 for 2);
      if not exists (
        select 1 from projects where org_id = proj.org_id and tag is not null and upper(tag) = candidate
      ) then
        found_tag := candidate;
      end if;
    end if;

    if found_tag is null and length(base) >= 1 then
      for i in 0..9 loop
        candidate := substring(base from 1 for 1) || i::text;
        if not exists (
          select 1 from projects where org_id = proj.org_id and tag is not null and upper(tag) = candidate
        ) then
          found_tag := candidate;
          exit;
        end if;
      end loop;
    end if;

    if found_tag is null then
      for i in 0..675 loop
        candidate := chr(65 + (i / 26)) || chr(65 + (i % 26));
        if not exists (
          select 1 from projects where org_id = proj.org_id and tag is not null and upper(tag) = candidate
        ) then
          found_tag := candidate;
          exit;
        end if;
      end loop;
    end if;

    if found_tag is not null then
      update projects set tag = found_tag where id = proj.id;
    end if;
  end loop;
end $$;
