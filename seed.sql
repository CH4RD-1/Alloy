-- ============================================================================
-- Alloy — minimal seed data for local testing
-- ============================================================================
-- Creates one org, its 5 workflow statuses, one project, one team, a parent
-- task with two subtasks (one done, one not) plus a milestone, and a tag —
-- enough to see the ported List view actually do something (expand/collapse,
-- status colors, a tag chip, a milestone diamond).
--
-- Run this AFTER you've requested a magic link on /login at least once (that
-- creates your auth.users row, which the schema.sql trigger mirrors into
-- public.users) — you need your user id before running this. Get it with:
--
--   select id, email from auth.users order by created_at desc limit 5;
--
-- Then paste your id into v_user_id below and run the whole block.
-- ============================================================================

do $$
declare
  v_user_id           uuid := '045e3fed-6fc4-4834-8a65-16527df45dba';
  v_org_id            uuid;
  v_project_id        uuid;
  v_team_id           uuid;
  v_status_backlog    uuid;
  v_status_inprogress uuid;
  v_status_inreview   uuid;
  v_status_blocked    uuid;
  v_status_done       uuid;
  v_task_parent       uuid;
  v_task_draft        uuid;
begin
  insert into orgs (name, slug, template)
    values ('bob', 'bob', 'engineering')
    returning id into v_org_id;

  insert into org_members (org_id, user_id, role)
    values (v_org_id, v_user_id, 'owner');

  insert into workflow_statuses (org_id, key, label, position, is_closed) values
    (v_org_id, 'backlog',    'Backlog',     0, false),
    (v_org_id, 'inprogress', 'In Progress', 1, false),
    (v_org_id, 'inreview',   'In Review',   2, false),
    (v_org_id, 'blocked',    'Blocked',     3, false),
    (v_org_id, 'done',       'Done',        4, true);

  select id into v_status_backlog    from workflow_statuses where org_id = v_org_id and key = 'backlog';
  select id into v_status_inprogress from workflow_statuses where org_id = v_org_id and key = 'inprogress';
  select id into v_status_inreview   from workflow_statuses where org_id = v_org_id and key = 'inreview';
  select id into v_status_blocked    from workflow_statuses where org_id = v_org_id and key = 'blocked';
  select id into v_status_done       from workflow_statuses where org_id = v_org_id and key = 'done';

  -- The seven standard moves from the prototype's STANDARD_WORKFLOW, so a
  -- freshly-seeded org can actually change a task's status through the app —
  -- without at least these, updateTaskStatus() has no workflow_transitions
  -- row to match against and every status move is rejected. The prototype's
  -- single "requireComplete" flag on inreview->done meant subtasks AND
  -- checklists both complete; the real schema splits that into two columns,
  -- so both are set true here to reproduce the same combined gate exactly
  -- (the new Manage workflow & roles panel can toggle them independently).
  insert into workflow_transitions (org_id, from_status_id, to_status_id, allowed_roles, require_subtasks_complete, require_checklists_complete) values
    (v_org_id, v_status_backlog,    v_status_inprogress, '{standard,authorizer,manager}', false, false),
    (v_org_id, v_status_inprogress, v_status_inreview,   '{standard,authorizer,manager}', false, false),
    (v_org_id, v_status_inprogress, v_status_blocked,    '{standard,authorizer,manager}', false, false),
    (v_org_id, v_status_blocked,    v_status_inprogress, '{standard,authorizer,manager}', false, false),
    (v_org_id, v_status_inreview,   v_status_inprogress, '{standard,authorizer,manager}', false, false),
    (v_org_id, v_status_inreview,   v_status_done,       '{authorizer,manager}',          true,  true),
    (v_org_id, v_status_done,       v_status_inprogress, '{manager}',                     false, false);

  insert into projects (org_id, name, color)
    values (v_org_id, 'Website Relaunch', '#d9662a')
    returning id into v_project_id;

  insert into teams (org_id, project_id, name, color)
    values (v_org_id, v_project_id, 'Engineering', '#1f76a6')
    returning id into v_team_id;

  insert into tasks (org_id, project_id, team_id, title, status_id, assignee_id, start_date, due_date)
    values (v_org_id, v_project_id, v_team_id, 'Rebuild the marketing site', v_status_inprogress, v_user_id, current_date, current_date + 14)
    returning id into v_task_parent;

  insert into tasks (org_id, project_id, team_id, parent_task_id, title, status_id, assignee_id, start_date, due_date)
    values (v_org_id, v_project_id, v_team_id, v_task_parent, 'Draft new homepage copy', v_status_done, v_user_id, current_date, current_date + 3)
    returning id into v_task_draft;

  insert into tasks (org_id, project_id, team_id, parent_task_id, title, status_id, assignee_id, start_date, due_date)
    values (v_org_id, v_project_id, v_team_id, v_task_parent, 'Build hero section', v_status_backlog, v_user_id, current_date + 3, current_date + 7);

  insert into tasks (org_id, project_id, team_id, title, status_id, is_milestone, start_date, due_date)
    values (v_org_id, v_project_id, v_team_id, 'Launch', v_status_backlog, true, current_date + 14, current_date + 14);

  insert into tags (org_id, name, color)
    values (v_org_id, 'customer-facing', '#d9662a')
    on conflict (org_id, name) do nothing;

  insert into task_tags (task_id, tag_id)
    select v_task_parent, id from tags where org_id = v_org_id and name = 'customer-facing';

  -- A little activity history so the task panel's Activity section and the
  -- Dashboard's "your recent activity" feed are not empty the first time you
  -- look at them. Everything above this point is a raw insert rather than a
  -- call through createTask()/updateTaskStatus() in lib/actions.ts, so
  -- nothing would otherwise populate activity_log the way real usage does.
  insert into activity_log (org_id, task_id, type, actor_user_id, created_at) values
    (v_org_id, v_task_parent, 'created', v_user_id, now() - interval '4 days');
  insert into activity_log (org_id, task_id, type, from_status_id, to_status_id, actor_user_id, created_at) values
    (v_org_id, v_task_parent, 'status', v_status_backlog, v_status_inprogress, v_user_id, now() - interval '2 days');

  insert into activity_log (org_id, task_id, type, actor_user_id, created_at) values
    (v_org_id, v_task_draft, 'created', v_user_id, now() - interval '4 days');
  insert into activity_log (org_id, task_id, type, from_status_id, to_status_id, actor_user_id, created_at) values
    (v_org_id, v_task_draft, 'status', v_status_backlog, v_status_done, v_user_id, now() - interval '1 day');
end $$;
