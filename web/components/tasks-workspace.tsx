"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { TaskRow } from "@/lib/list-view";
import { flattenRows } from "@/lib/list-view";
import { buildBucketColumns } from "@/lib/buckets-view";
import type { TaskPatch } from "@/lib/task-patches";
import { applyTaskPatches, patchMatchesRow } from "@/lib/task-patches";
import type {
  WorkflowStatus,
  WorkflowTransition,
  WorkflowTransitionAction,
  Workflow,
  Company,
  Deal,
  Team,
  Project,
  TaskLink,
  Role,
  Doc,
  TaskObject,
  TaskObjectFile,
  TaskObjectForm,
  ChecklistItem,
  FormTemplate,
  Asset,
  CustomFieldDef,
  ActivityLogEntry,
  TicketMessage,
  TicketMessageAttachment,
  Contact,
  Invite,
  SubscriptionStatus,
  DevTools,
} from "@/lib/types";
import type { MemberSummary } from "@/lib/tasks-data";
import { TaskListView } from "@/components/task-list-view";
import { BucketsView } from "@/components/buckets-view";
import { GanttView } from "@/components/gantt-view";
import { CalendarView } from "@/components/calendar-view";
import { KBView } from "@/components/kb-view";
import { TaskPanel } from "@/components/task-panel";
import { TaskPreviewCard } from "@/components/task-preview-card";
import { NewTaskPanel } from "@/components/new-task-panel";
import { DocPanel } from "@/components/doc-panel";
import { FormTemplatesPanel } from "@/components/form-templates-panel";
import { AssetsView } from "@/components/assets-view";
import { AssetPanel } from "@/components/asset-panel";
import { CompaniesView } from "@/components/companies-view";
import { CompanyPanel } from "@/components/company-panel";
import { DealsView } from "@/components/deals-view";
import { DealPanel } from "@/components/deal-panel";
import { ContactsView } from "@/components/contacts-view";
import { ContactPanel } from "@/components/contact-panel";
import { getCompaniesData, getDealsData, getOrgContactsData, getReportsData } from "@/lib/actions";
import { buildReportsData, type ReportActivityRow, type ReportMessageRow } from "@/lib/reports-view";
import { ReportsView } from "@/components/reports-view";
import { DashboardView } from "@/components/dashboard-view";
import { ProjectsPanel } from "@/components/projects-panel";
import { TeamsPanel } from "@/components/teams-panel";
import { CustomFieldsPanel } from "@/components/custom-fields-panel";
import { WorkflowPanel } from "@/components/workflow-panel";
import { OrgSettingsPanel } from "@/components/org-settings-panel";
import { SlaSettingsPanel } from "@/components/sla-settings-panel";
import { DevToolsPanel } from "@/components/dev-tools-panel";
import { AppSidebar } from "@/components/app-sidebar";
import { ALL_PROJECTS_KEY, matchesProjectTeamFilters } from "@/lib/sidebar-view";

// Small inline icons for the view-tab switcher, copied from the prototype's
// ICONS set (see the "Live prototype" link in alloy-development-log.md).
function ListIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
    </svg>
  );
}
function BucketsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="6" height="16" rx="1" />
      <rect x="15" y="4" width="6" height="9" rx="1" />
    </svg>
  );
}
function GanttIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M4 6h8M4 12h14M4 18h6" />
    </svg>
  );
}
function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}
function KBIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}
function AssetsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 8 12 3 3 8l9 5 9-5z" />
      <path d="M3 8v8l9 5 9-5V8" />
      <path d="M12 13v8" />
    </svg>
  );
}
function DashboardIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </svg>
  );
}
// CRM Phase A — a plain building glyph for Companies, and a handshake-ish
// two-arrow glyph for Deals, kept in the same small inline style as every
// other view-tab icon above rather than pulling in an icon library for two
// glyphs.
function CompaniesIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="3" width="16" height="18" rx="1" />
      <path d="M9 8h1M14 8h1M9 12h1M14 12h1M9 16h1M14 16h1" />
    </svg>
  );
}
function DealsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v6M12 16v6M4.9 4.9l4.2 4.2M14.9 14.9l4.2 4.2M2 12h6M16 12h6M4.9 19.1l4.2-4.2M14.9 9.1l4.2-4.2" />
    </svg>
  );
}
// CRM Phase C — a plain person glyph for the new Contacts tab, same small
// inline style as CompaniesIcon/DealsIcon just above.
function ContactsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" />
    </svg>
  );
}

// Reporting (Phase D) — a simple bar-chart glyph, same small inline style as
// every other view-tab icon above.
function ReportsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20V10M12 20V4M20 20v-7" />
    </svg>
  );
}

type ViewKey = "dashboard" | "list" | "buckets" | "gantt" | "calendar" | "kb" | "assets" | "companies" | "deals" | "contacts" | "reports";

export function TasksWorkspace({
  rows,
  links,
  statuses,
  transitions,
  transitionActions,
  workflows,
  teams,
  projects,
  members,
  orgId,
  currentUserRole,
  vocabTask,
  vocabTeam,
  docs,
  docIdsByTask,
  taskIdsByDoc,
  taskObjects,
  checklistItemsByObject,
  taskObjectFileByObjectId,
  taskObjectFormByObjectId,
  formTemplates,
  formTemplateUsage,
  assets,
  currentUserId,
  customFieldDefs,
  customFieldValuesByTask,
  activityLog,
  contactNameById,
  contactById,
  ticketMessages,
  ticketMessageAttachmentsByMessageId,
  invites,
  orgName,
  orgSlug,
  orgCustomDomain,
  orgSubscriptionStatus,
  orgStripePriceId,
  orgSubscriptionPeriodEnd,
  orgTeamAllocationEnabled,
  teamMemberIdsByTeam,
  slaFirstResponseHours,
  slaResolutionDays,
  devTools,
}: {
  rows: TaskRow[];
  links: TaskLink[];
  statuses: WorkflowStatus[];
  transitions: WorkflowTransition[];
  transitionActions: WorkflowTransitionAction[];
  workflows: Workflow[];
  teams: Team[];
  projects: Project[];
  members: MemberSummary[];
  orgId: string;
  currentUserRole: Role;
  vocabTask: string;
  vocabTeam: string;
  docs: Doc[];
  docIdsByTask: Map<string, string[]>;
  taskIdsByDoc: Map<string, string[]>;
  taskObjects: TaskObject[];
  checklistItemsByObject: Map<string, ChecklistItem[]>;
  taskObjectFileByObjectId: Map<string, TaskObjectFile & { url: string | null }>;
  taskObjectFormByObjectId: Map<string, TaskObjectForm>;
  formTemplates: FormTemplate[];
  formTemplateUsage: Map<string, number>;
  assets: Asset[];
  currentUserId: string;
  customFieldDefs: CustomFieldDef[];
  customFieldValuesByTask: Map<string, Record<string, unknown>>;
  activityLog: ActivityLogEntry[];
  contactNameById: Map<string, string>;
  contactById: Map<string, Contact>;
  ticketMessages: TicketMessage[];
  ticketMessageAttachmentsByMessageId: Map<string, (TicketMessageAttachment & { url: string | null })[]>;
  invites: Invite[];
  orgName: string;
  orgSlug: string;
  orgCustomDomain: string | null;
  orgSubscriptionStatus: SubscriptionStatus | null;
  orgStripePriceId: string | null;
  orgSubscriptionPeriodEnd: string | null;
  orgTeamAllocationEnabled: boolean;
  teamMemberIdsByTeam: Map<string, string[]>;
  slaFirstResponseHours: number;
  slaResolutionDays: number;
  devTools: DevTools;
}) {
  const [view, setView] = useState<ViewKey>("dashboard");
  const [search, setSearch] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  // A small floating card shown at the cursor when a Gantt bar or Calendar
  // event is clicked (see components/task-preview-card.tsx) — ported from
  // the prototype's own ticket-preview, which those two views used instead
  // of jumping straight to the full task panel on a plain click.
  const [previewTask, setPreviewTask] = useState<{ taskId: string; x: number; y: number } | null>(null);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  // The task panel's own actual on-screen width (440 normal, 880 widened —
  // only ever 880 for a Helpdesk ticket, see task-panel.tsx's isWidenable),
  // reported up via TaskPanel's onWidthChange so a stacked DocPanel can
  // offset itself correctly instead of assuming a fixed 440px (see
  // .panel-doc's own comment in globals.css for the bug this replaces).
  const [mainPanelWidthPx, setMainPanelWidthPx] = useState(440);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  // CRM Phase A — deliberately NOT part of the server-rendered props this
  // component otherwise receives (see lib/actions.ts's own comment on
  // getCompaniesData/getDealsData for why): fetched once here on mount and
  // held as plain client state, so a Task/Project mutation's
  // router.refresh() elsewhere in the app never re-triggers this fetch or
  // touches this state at all.
  const [companies, setCompanies] = useState<Company[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  // CRM Phase C — joins the same fetch-once-on-mount state as
  // companies/deals just above, for the same reason (see the effect below).
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [crmLoaded, setCrmLoaded] = useState(false);
  // Reporting (Phase D) — same fetch-once-on-mount shape as Companies/Deals/
  // Contacts above, and for the same reason (see getReportsData's own
  // comment in lib/actions.ts): the org's full status-change/message
  // history this needs is deliberately not part of getWorkspaceData's own
  // capped activityLog/ticketMessages props, so it's fetched separately and
  // held here rather than ever running again on a router.refresh().
  const [reportActivity, setReportActivity] = useState<ReportActivityRow[]>([]);
  const [reportMessages, setReportMessages] = useState<ReportMessageRow[]>([]);
  const [reportsLoaded, setReportsLoaded] = useState(false);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  const [selectedDealId, setSelectedDealId] = useState<string | null>(null);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [managingForms, setManagingForms] = useState(false);
  const [managingProjects, setManagingProjects] = useState(false);
  const [managingTeams, setManagingTeams] = useState(false);
  const [managingFields, setManagingFields] = useState(false);
  const [managingWorkflow, setManagingWorkflow] = useState(false);
  const [managingOrg, setManagingOrg] = useState(false);
  const [managingSla, setManagingSla] = useState(false);
  const [managingDev, setManagingDev] = useState(false);
  const [projectFilter, setProjectFilter] = useState<string>(ALL_PROJECTS_KEY);
  const [teamFilters, setTeamFilters] = useState<Set<string>>(new Set());

  // Dev tools "Viewing as" (components/dev-tools-panel.tsx / app-sidebar.tsx)
  // — a client-only override of who the app renders as, never sent to the
  // server except as an explicit actingAsUserId on the handful of actions
  // that support it (createTask, updateTaskStatus). Persisted per-browser
  // (not per-org-shared state) so it survives a reload while testing, but
  // resets on its own once the org turns dev tools off (the effect below).
  const [viewingAs, setViewingAsState] = useState<{ id: string; name: string; role: Role } | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(`alloy-viewing-as-${orgId}`);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });
  function setViewingAs(next: { id: string; name: string; role: Role } | null) {
    setViewingAsState(next);
    try {
      if (next) window.localStorage.setItem(`alloy-viewing-as-${orgId}`, JSON.stringify(next));
      else window.localStorage.removeItem(`alloy-viewing-as-${orgId}`);
    } catch {
      // Best-effort — a private window or blocked storage just means this
      // doesn't survive a reload, not a reason to fail the switch itself.
    }
  }
  const userSwitchActive = devTools.enabled && devTools.userSwitch;
  const effectiveUserId = (userSwitchActive && viewingAs) ? viewingAs.id : currentUserId;
  const effectiveUserRole = (userSwitchActive && viewingAs) ? viewingAs.role : currentUserRole;
  const actingAsUserId = userSwitchActive && viewingAs ? viewingAs.id : null;

  // Optimistic patch overlay for drag interactions (Gantt schedule
  // drag/resize, Buckets team drag) — deliberately NOT a full local-state
  // lift of `rows`. A full lift (seed a useState once from the `rows` prop,
  // then mutate that state directly instead of the prop) would silently
  // break every *other* mutation in this app, which still works by calling
  // a server action and then router.refresh(): refresh() updates the props
  // this component receives, but a useState initializer only runs once, so
  // already-initialized local state would just stop tracking the server at
  // all for every mutation that isn't part of this overlay.
  //
  // Instead `rows` stays exactly what it always was — a plain prop, rebuilt
  // server-side by getWorkspaceData()/buildRows() and refreshed by the same
  // router.refresh() every other view already calls. This map holds small,
  // short-lived per-task patches (new dates from a Gantt drag, a new
  // team/teamName/teamColor from a Buckets drag) applied on top of it purely
  // for instant visual feedback in the gap between "the drag ended" and
  // "router.refresh() finished re-fetching and re-rendering with the real
  // data" — see gantt-view.tsx's commitSchedule and buckets-view.tsx's
  // handleDrop for where patches are set. A patch for a given task is
  // cleared as soon as the next refresh's fresh `rows` prop actually shows
  // that task's new value (see the effect below), so it's never a second
  // source of truth — just a bridge over one render's worth of staleness.
  const [taskPatches, setTaskPatches] = useState<Map<string, TaskPatch>>(new Map());

  const patchTasks = useCallback((patches: Record<string, TaskPatch>) => {
    setTaskPatches((prev) => {
      const next = new Map(prev);
      Object.entries(patches).forEach(([id, patch]) => {
        next.set(id, { ...next.get(id), ...patch });
      });
      return next;
    });
  }, []);

  const allRowsById = useMemo(() => {
    const m = new Map<string, TaskRow>();
    flattenRows(rows).forEach((r) => m.set(r.task.id, r));
    return m;
  }, [rows]);

  // Once a fresh `rows` prop lands (router.refresh() resolved) with a value
  // that already matches what a patch predicted, that patch has done its
  // job and would otherwise sit around forever (nothing else ever clears
  // it) — drop exactly the ones whose predicted fields now agree with the
  // real prop data, task by task, rather than clearing the whole map and
  // risking a visible snap-back for a patch whose refresh hasn't landed yet.
  useEffect(() => {
    if (taskPatches.size === 0) return;
    setTaskPatches((prev) => {
      if (prev.size === 0) return prev;
      let next: Map<string, TaskPatch> | null = null;
      prev.forEach((patch, id) => {
        const row = allRowsById.get(id);
        if (row && patchMatchesRow(patch, row)) {
          if (!next) next = new Map(prev);
          next.delete(id);
        }
      });
      return next ?? prev;
    });
    // allRowsById is derived from `rows`, so this only needs to re-check
    // when a fresh server row set actually lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const patchedRows = useMemo(() => {
    if (taskPatches.size === 0) return rows;
    return rows.map((r) => applyTaskPatches(r, taskPatches));
  }, [rows, taskPatches]);

  const allRows = useMemo(() => flattenRows(patchedRows), [patchedRows]);

  // Ported from the prototype's set-project handler: switching the active
  // project clears the team filter, since a merged "All projects" team key
  // and a real per-project team id mean different things (see
  // lib/sidebar-view.ts) — carrying one over would silently stop matching.
  function handleSetProject(id: string) {
    setProjectFilter(id);
    setTeamFilters(new Set());
  }
  function handleToggleTeam(key: string) {
    setTeamFilters((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Sidebar filters apply only to List/Buckets/Gantt, same scope the
  // prototype used — Dashboard, Knowledge base and Assets stay unfiltered by
  // them (see matchesFilters()'s call sites in the prototype).
  const sidebarFiltered = useMemo(
    () => patchedRows.filter((r) => matchesProjectTeamFilters(r, projectFilter, teamFilters)),
    [patchedRows, projectFilter, teamFilters]
  );
  const sidebarFilteredAll = useMemo(
    () => allRows.filter((r) => matchesProjectTeamFilters(r, projectFilter, teamFilters)),
    [allRows, projectFilter, teamFilters]
  );

  // Filters top-level tasks only, same as the prototype's matchesFilters —
  // applied to topLevel(), leaving an already-expanded parent's children
  // showing regardless of whether they themselves match.
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sidebarFiltered;
    return sidebarFiltered.filter((r) => {
      const hay = [r.task.title, r.task.description ?? "", r.assigneeName ?? "", ...r.tags].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [sidebarFiltered, search]);

  // List view alone shows oldest-first — everywhere else (Buckets, Gantt's
  // row order, the sidebar counts) keeps the newest-first order the
  // underlying task fetch already comes in (see getWorkspaceData's own
  // `.order("created_at", { ascending: false })`), since only List was
  // asked to flip.
  const listRows = useMemo(
    () => [...filteredRows].sort((a, b) => a.task.created_at.localeCompare(b.task.created_at)),
    [filteredRows]
  );

  // Buckets, unlike List, shows every task (subtasks included — a subtask
  // can sit in a different team than its parent), so it searches every row
  // individually rather than filtering only top-level tasks like List does.
  const filteredAllRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sidebarFilteredAll;
    return sidebarFilteredAll.filter((r) => {
      const hay = [r.task.title, r.task.description ?? "", r.assigneeName ?? "", ...r.tags].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [sidebarFilteredAll, search]);

  // Viewing one project shows that project's own teams as Buckets columns;
  // "All projects" merges same-named teams across projects — buildBucketColumns()
  // already does that dedup, so scoping which teams it sees is all that's
  // needed to match the sidebar's own project/team scoping (teamGroupsFor()).
  const bucketTeams = useMemo(
    () => (projectFilter === ALL_PROJECTS_KEY ? teams : teams.filter((t) => t.project_id === projectFilter)),
    [teams, projectFilter]
  );
  const bucketColumns = useMemo(() => buildBucketColumns(filteredAllRows, bucketTeams), [filteredAllRows, bucketTeams]);

  // CRM Phase A/C — the one, one-time fetch of Companies/Deals/Contacts
  // data. Runs once on mount (orgId is stable for the life of this
  // component), never again — in particular, never in response to a
  // Task/Project router.refresh() elsewhere in the app, which is the whole
  // point (see lib/actions.ts's own comment on getCompaniesData/
  // getDealsData/getOrgContactsData).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [companiesData, dealsData, contactsData] = await Promise.all([
        getCompaniesData(orgId),
        getDealsData(orgId),
        getOrgContactsData(orgId),
      ]);
      if (cancelled) return;
      setCompanies(companiesData);
      setDeals(dealsData);
      setContacts(contactsData);
      setCrmLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const companiesById = useMemo(() => new Map(companies.map((c) => [c.id, c])), [companies]);

  // Deals don't belong to a project, so they carry their own workflow_id
  // directly rather than inheriting one via projects.workflow_id — see
  // schema.sql's own comment on the deals table. workflows/statuses here are
  // already part of this component's regular server-rendered props (fetched
  // org-wide, all types, by the existing getWorkspaceData), so finding the
  // 'deal'-type one and its statuses needs no extra query of its own.
  const dealWorkflow = workflows.find((w) => w.type === "deal") ?? null;
  const dealStatuses = useMemo(
    () => (dealWorkflow ? statuses.filter((s) => s.workflow_id === dealWorkflow.id) : []),
    [statuses, dealWorkflow]
  );
  const dealStatusesById = useMemo(() => new Map(dealStatuses.map((s) => [s.id, s])), [dealStatuses]);
  // Feeds DealPanel's own move-to-row buttons (mirrors TaskPanel's) — see
  // that panel's own comment on its `transitions` prop.
  const dealTransitions = useMemo(
    () => (dealWorkflow ? transitions.filter((t) => t.workflow_id === dealWorkflow.id) : []),
    [transitions, dealWorkflow]
  );

  // A Task/Helpdesk/Asset transition's own "update_linked_deal" automation
  // (see lib/actions.ts's runTransitionActions) can move a deal that this
  // component fetched once on mount and never refreshes on its own (see the
  // CRM fetch effect above) — router.refresh() alone wouldn't pick that up,
  // so TaskPanel calls this after any status change reports affectedDeals,
  // and it just re-runs that same one-time fetch for Deals only.
  const refreshDeals = useCallback(() => {
    getDealsData(orgId).then(setDeals);
  }, [orgId]);

  // Reporting (Phase D) — its own one-time fetch, same "runs once on mount,
  // never again" shape as the CRM effect above and for the same reason: this
  // needs the org's *whole* status-change/message history, not the capped
  // slice getWorkspaceData's own activityLog/ticketMessages props carry (see
  // getReportsData's own comment in lib/actions.ts).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { activity, messages } = await getReportsData(orgId);
      if (cancelled) return;
      setReportActivity(activity);
      setReportMessages(messages);
      setReportsLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const reportsData = useMemo(
    () =>
      buildReportsData({
        tasks: allRows.map((r) => r.task),
        projects,
        statuses,
        workflows,
        activity: reportActivity,
        messages: reportMessages,
        deals,
        dealStatusesById,
        slaFirstResponseHours,
        slaResolutionDays,
      }),
    [allRows, projects, statuses, workflows, reportActivity, reportMessages, deals, dealStatusesById, slaFirstResponseHours, slaResolutionDays]
  );

  return (
    <div className="app-shell">
      <AppSidebar
        projects={projects}
        teams={teams}
        allRows={allRows}
        vocabTeam={vocabTeam}
        projectFilter={projectFilter}
        teamFilters={teamFilters}
        onSetProject={handleSetProject}
        onToggleTeam={handleToggleTeam}
        onManageFields={() => setManagingFields(true)}
        onManageProjects={() => setManagingProjects(true)}
        onManageTeams={() => setManagingTeams(true)}
        onManageForms={() => setManagingForms(true)}
        onManageWorkflow={() => setManagingWorkflow(true)}
        onManageOrg={() => setManagingOrg(true)}
        onManageSla={() => setManagingSla(true)}
        onManageDev={() => setManagingDev(true)}
        devTools={devTools}
        members={members}
        realUserId={currentUserId}
        realUserRole={currentUserRole}
        viewingAs={viewingAs}
        onViewingAsChange={setViewingAs}
      />
      <div className="main-content">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
        <div className="view-tabs" style={{ marginBottom: 0 }}>
          <button type="button" className={`view-tab ${view === "dashboard" ? "active" : ""}`} onClick={() => setView("dashboard")}>
            <DashboardIcon /> Dashboard
          </button>
          <button type="button" className={`view-tab ${view === "list" ? "active" : ""}`} onClick={() => setView("list")}>
            <ListIcon /> List
          </button>
          <button type="button" className={`view-tab ${view === "buckets" ? "active" : ""}`} onClick={() => setView("buckets")}>
            <BucketsIcon /> Buckets
          </button>
          <button type="button" className={`view-tab ${view === "gantt" ? "active" : ""}`} onClick={() => setView("gantt")}>
            <GanttIcon /> Gantt
          </button>
          <button type="button" className={`view-tab ${view === "calendar" ? "active" : ""}`} onClick={() => setView("calendar")}>
            <CalendarIcon /> Calendar
          </button>
          <button type="button" className={`view-tab ${view === "kb" ? "active" : ""}`} onClick={() => setView("kb")}>
            <KBIcon /> Knowledge base
          </button>
          <button type="button" className={`view-tab ${view === "assets" ? "active" : ""}`} onClick={() => setView("assets")}>
            <AssetsIcon /> Assets
          </button>
          <button type="button" className={`view-tab ${view === "companies" ? "active" : ""}`} onClick={() => setView("companies")}>
            <CompaniesIcon /> Companies
          </button>
          <button type="button" className={`view-tab ${view === "deals" ? "active" : ""}`} onClick={() => setView("deals")}>
            <DealsIcon /> Deals
          </button>
          <button type="button" className={`view-tab ${view === "contacts" ? "active" : ""}`} onClick={() => setView("contacts")}>
            <ContactsIcon /> Contacts
          </button>
          <button type="button" className={`view-tab ${view === "reports" ? "active" : ""}`} onClick={() => setView("reports")}>
            <ReportsIcon /> Reports
          </button>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            className="search-input"
            placeholder={`Search ${vocabTask.toLowerCase()}s, tags, docs, assets…`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="primary-btn" onClick={() => setCreating(true)}>
            + New {vocabTask.toLowerCase()}
          </button>
        </div>
      </div>

      {view === "dashboard" && (
        <DashboardView
          allRows={allRows}
          projects={projects}
          statuses={statuses}
          transitions={transitions}
          currentUserId={effectiveUserId}
          currentUserRole={effectiveUserRole}
          currentUserName={(userSwitchActive && viewingAs) ? viewingAs.name : (members.find((m) => m.userId === currentUserId)?.name ?? "there")}
          vocabTask={vocabTask}
          activityLog={activityLog}
          onSelectTask={setSelectedTaskId}
          deals={deals}
          dealStatusesById={dealStatusesById}
          dealsLoaded={crmLoaded}
          onOpenDeals={() => setView("deals")}
          reportsData={reportsData}
          reportsLoaded={reportsLoaded}
          onOpenReports={() => setView("reports")}
        />
      )}

      {view === "list" && (
        <div className="view-head">
          <div>
            <div className="view-title">{vocabTask} List</div>
            <div className="view-sub">
              {filteredRows.length} top-level {vocabTask.toLowerCase()}
              {filteredRows.length === 1 ? "" : "s"}
              {search && ` matching "${search}"`}
            </div>
          </div>
        </div>
      )}

      {view === "list" && <TaskListView rows={listRows} vocabTask={vocabTask} onSelectTask={setSelectedTaskId} />}
      {view === "buckets" && (
        <BucketsView
          columns={bucketColumns}
          vocabTask={vocabTask}
          vocabTeam={vocabTeam}
          onSelectTask={setSelectedTaskId}
          onPatchTasks={patchTasks}
        />
      )}
      {view === "gantt" && (
        <GanttView
          rows={filteredRows}
          projects={projects}
          links={links}
          orgId={orgId}
          vocabTask={vocabTask}
          onSelectTask={setSelectedTaskId}
          onPreviewTask={(id, x, y) => setPreviewTask({ taskId: id, x, y })}
          onPatchTasks={patchTasks}
        />
      )}
      {view === "calendar" && (
        <CalendarView
          rows={filteredRows}
          projects={projects}
          teams={bucketTeams}
          members={members}
          teamMemberIdsByTeam={teamMemberIdsByTeam}
          orgTeamAllocationEnabled={orgTeamAllocationEnabled}
          vocabTask={vocabTask}
          onPreviewTask={(id, x, y) => setPreviewTask({ taskId: id, x, y })}
        />
      )}
      {view === "kb" && (
        <KBView docs={docs} taskIdsByDoc={taskIdsByDoc} orgId={orgId} search={search} onSelectDoc={setSelectedDocId} />
      )}
      {view === "assets" && (
        <AssetsView
          assets={assets}
          tasks={allRows.map((r) => r.task)}
          statuses={statuses}
          projects={projects}
          orgId={orgId}
          search={search}
          onSelectAsset={setSelectedAssetId}
        />
      )}
      {view === "companies" && (
        <CompaniesView
          orgId={orgId}
          companies={companies}
          setCompanies={setCompanies}
          loaded={crmLoaded}
          search={search}
          onSelectCompany={setSelectedCompanyId}
        />
      )}
      {view === "deals" && (
        <DealsView
          orgId={orgId}
          deals={deals}
          setDeals={setDeals}
          companies={companies}
          members={members}
          dealStatuses={dealStatuses}
          dealWorkflowId={dealWorkflow?.id ?? null}
          loaded={crmLoaded}
          search={search}
          onSelectDeal={setSelectedDealId}
        />
      )}
      {view === "contacts" && (
        <ContactsView
          orgId={orgId}
          contacts={contacts}
          setContacts={setContacts}
          companiesById={companiesById}
          loaded={crmLoaded}
          search={search}
          onSelectContact={setSelectedContactId}
        />
      )}
      {view === "reports" && (
        <ReportsView data={reportsData} loaded={reportsLoaded} vocabTask={vocabTask} onOpenDeals={() => setView("deals")} />
      )}

      {selectedTaskId && (
        <TaskPanel
          taskId={selectedTaskId}
          allRows={allRows}
          links={links}
          statuses={statuses}
          transitions={transitions}
          teams={teams}
          projects={projects}
          members={members}
          orgId={orgId}
          currentUserRole={effectiveUserRole}
          actingAsUserId={actingAsUserId}
          docs={docs}
          docIdsByTask={docIdsByTask}
          taskObjects={taskObjects}
          checklistItemsByObject={checklistItemsByObject}
          taskObjectFileByObjectId={taskObjectFileByObjectId}
          taskObjectFormByObjectId={taskObjectFormByObjectId}
          formTemplates={formTemplates}
          customFieldDefs={customFieldDefs}
          customFieldValuesByTask={customFieldValuesByTask}
          activityLog={activityLog}
          contactNameById={contactNameById}
          contactById={contactById}
          ticketMessages={ticketMessages}
          ticketMessageAttachmentsByMessageId={ticketMessageAttachmentsByMessageId}
          orgTeamAllocationEnabled={orgTeamAllocationEnabled}
          teamMemberIdsByTeam={teamMemberIdsByTeam}
          slaFirstResponseHours={slaFirstResponseHours}
          slaResolutionDays={slaResolutionDays}
          assets={assets}
          onOpenAsset={(assetId) => {
            // Asset Allocation panel's asset-card click-through — swap
            // straight to the real AssetPanel rather than showing both
            // slide-overs stacked at once.
            setSelectedTaskId(null);
            setSelectedAssetId(assetId);
          }}
          deals={deals}
          onOpenDeal={(dealId) => {
            // Same click-through as onOpenAsset just above, for the deal a
            // Workflow automation linked this task to (tasks.deal_id) — see
            // schema.sql's own comment on workflow_transition_actions.
            setSelectedTaskId(null);
            setSelectedDealId(dealId);
          }}
          onSelectDoc={setSelectedDocId}
          onWidthChange={setMainPanelWidthPx}
          onClose={() => setSelectedTaskId(null)}
          onPatchTasks={patchTasks}
          onDealAutomation={refreshDeals}
        />
      )}

      {selectedDocId &&
        (() => {
          const doc = docs.find((d) => d.id === selectedDocId);
          if (!doc) return null;
          return (
            <DocPanel
              doc={doc}
              allRows={allRows}
              linkedTaskIds={taskIdsByDoc.get(selectedDocId) ?? []}
              vocabTask={vocabTask}
              // Stacks beside the task panel (double-width, ported from the
              // prototype's #panelArticle) rather than replacing it, since
              // opening a linked article shouldn't lose the task you opened
              // it from — see DocPanel's besideMainWidth prop. Passes the
              // task panel's own *actual* current width (tracked above via
              // onWidthChange) rather than assuming it's always 440px, so a
              // widened Helpdesk ticket doesn't end up hidden behind this.
              besideMainWidth={selectedTaskId ? mainPanelWidthPx : undefined}
              onSelectTask={setSelectedTaskId}
              onClose={() => setSelectedDocId(null)}
            />
          );
        })()}

      {previewTask &&
        (() => {
          const row = allRows.find((r) => r.task.id === previewTask.taskId);
          if (!row) return null;
          return (
            <TaskPreviewCard
              key={previewTask.taskId}
              row={row}
              projects={projects}
              x={previewTask.x}
              y={previewTask.y}
              vocabTask={vocabTask}
              onClose={() => setPreviewTask(null)}
              onOpen={() => {
                setSelectedTaskId(previewTask.taskId);
                setPreviewTask(null);
              }}
            />
          );
        })()}

      {selectedAssetId &&
        (() => {
          const asset = assets.find((a) => a.id === selectedAssetId);
          if (!asset) return null;
          return (
            <AssetPanel
              asset={asset}
              tasks={allRows.map((r) => r.task)}
              statuses={statuses}
              links={links}
              projects={projects}
              allRows={allRows}
              orgId={orgId}
              onClose={() => setSelectedAssetId(null)}
            />
          );
        })()}

      {selectedCompanyId &&
        (() => {
          const company = companies.find((c) => c.id === selectedCompanyId);
          if (!company) return null;
          return (
            <CompanyPanel
              company={company}
              deals={deals}
              dealStatusesById={dealStatusesById}
              onCompanyChange={setCompanies}
              onSelectDeal={(dealId) => {
                setSelectedCompanyId(null);
                setSelectedDealId(dealId);
              }}
              onSelectContact={(contactId) => {
                setSelectedCompanyId(null);
                setSelectedContactId(contactId);
              }}
              onClose={() => setSelectedCompanyId(null)}
            />
          );
        })()}

      {selectedDealId &&
        (() => {
          const deal = deals.find((d) => d.id === selectedDealId);
          if (!deal) return null;
          return (
            <DealPanel
              deal={deal}
              companies={companies}
              members={members}
              dealStatuses={dealStatuses}
              dealStatusesById={dealStatusesById}
              transitions={dealTransitions}
              onDealChange={setDeals}
              onSelectCompany={(companyId) => {
                setSelectedDealId(null);
                setSelectedCompanyId(companyId);
              }}
              onSelectContact={(contactId) => {
                setSelectedDealId(null);
                setSelectedContactId(contactId);
              }}
              onClose={() => setSelectedDealId(null)}
            />
          );
        })()}

      {selectedContactId &&
        (() => {
          const contact = contacts.find((c) => c.id === selectedContactId);
          if (!contact) return null;
          return (
            <ContactPanel
              contact={contact}
              companies={companies}
              deals={deals}
              dealStatusesById={dealStatusesById}
              onContactChange={setContacts}
              onSelectCompany={(companyId) => {
                setSelectedContactId(null);
                setSelectedCompanyId(companyId);
              }}
              onSelectDeal={(dealId) => {
                setSelectedContactId(null);
                setSelectedDealId(dealId);
              }}
              onClose={() => setSelectedContactId(null)}
            />
          );
        })()}

      {creating && (
        <NewTaskPanel
          orgId={orgId}
          projects={projects}
          teams={teams}
          members={members}
          defaultProjectId={projects[0]?.id ?? ""}
          vocabTask={vocabTask}
          orgTeamAllocationEnabled={orgTeamAllocationEnabled}
          teamMemberIdsByTeam={teamMemberIdsByTeam}
          actingAsUserId={actingAsUserId}
          onClose={() => setCreating(false)}
        />
      )}

      {managingForms && (
        <FormTemplatesPanel
          orgId={orgId}
          templates={formTemplates}
          usage={formTemplateUsage}
          vocabTask={vocabTask}
          customFieldDefs={customFieldDefs}
          onClose={() => setManagingForms(false)}
        />
      )}

      {managingProjects && (
        <ProjectsPanel
          orgId={orgId}
          projects={projects}
          workflows={workflows}
          tasks={allRows.map((r) => r.task)}
          vocabTask={vocabTask}
          onClose={() => setManagingProjects(false)}
        />
      )}

      {managingTeams && (
        <TeamsPanel
          orgId={orgId}
          projects={projects}
          teams={teams}
          tasks={allRows.map((r) => r.task)}
          members={members}
          teamMemberIdsByTeam={teamMemberIdsByTeam}
          vocabTeam={vocabTeam}
          vocabTask={vocabTask}
          onClose={() => setManagingTeams(false)}
        />
      )}

      {managingFields && (
        <CustomFieldsPanel
          orgId={orgId}
          fieldDefs={customFieldDefs}
          vocabTask={vocabTask}
          onClose={() => setManagingFields(false)}
        />
      )}

      {managingWorkflow && (
        <WorkflowPanel
          orgId={orgId}
          workflows={workflows}
          statuses={statuses}
          transitions={transitions}
          transitionActions={transitionActions}
          projects={projects}
          members={members}
          currentUserRole={effectiveUserRole}
          vocabTask={vocabTask}
          invites={invites}
          onClose={() => setManagingWorkflow(false)}
        />
      )}

      {managingOrg && (
        <OrgSettingsPanel
          orgId={orgId}
          orgName={orgName}
          orgSlug={orgSlug}
          orgCustomDomain={orgCustomDomain}
          orgSubscriptionStatus={orgSubscriptionStatus}
          orgStripePriceId={orgStripePriceId}
          orgSubscriptionPeriodEnd={orgSubscriptionPeriodEnd}
          orgTeamAllocationEnabled={orgTeamAllocationEnabled}
          currentUserRole={effectiveUserRole}
          onClose={() => setManagingOrg(false)}
        />
      )}

      {managingSla && (
        <SlaSettingsPanel
          orgId={orgId}
          slaFirstResponseHours={slaFirstResponseHours}
          slaResolutionDays={slaResolutionDays}
          currentUserRole={effectiveUserRole}
          onClose={() => setManagingSla(false)}
        />
      )}

      {managingDev && (
        <DevToolsPanel
          orgId={orgId}
          currentUserRole={currentUserRole}
          devTools={devTools}
          members={members}
          projects={projects}
          onClose={() => setManagingDev(false)}
        />
      )}
      </div>
    </div>
  );
}
