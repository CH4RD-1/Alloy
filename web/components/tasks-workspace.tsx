"use client";

import { useMemo, useState } from "react";
import type { TaskRow } from "@/lib/list-view";
import { flattenRows } from "@/lib/list-view";
import { buildBucketColumns } from "@/lib/buckets-view";
import type {
  WorkflowStatus,
  WorkflowTransition,
  Workflow,
  Team,
  Project,
  TaskLink,
  Role,
  Doc,
  TaskObject,
  TaskObjectFile,
  ChecklistItem,
  FormTemplate,
  Asset,
  CustomFieldDef,
  ActivityLogEntry,
  TicketMessage,
  Contact,
  Invite,
  SubscriptionStatus,
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
import { DashboardView } from "@/components/dashboard-view";
import { ProjectsPanel } from "@/components/projects-panel";
import { TeamsPanel } from "@/components/teams-panel";
import { CustomFieldsPanel } from "@/components/custom-fields-panel";
import { WorkflowPanel } from "@/components/workflow-panel";
import { OrgSettingsPanel } from "@/components/org-settings-panel";
import { SlaSettingsPanel } from "@/components/sla-settings-panel";
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

type ViewKey = "dashboard" | "list" | "buckets" | "gantt" | "calendar" | "kb" | "assets";

export function TasksWorkspace({
  rows,
  links,
  statuses,
  transitions,
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
}: {
  rows: TaskRow[];
  links: TaskLink[];
  statuses: WorkflowStatus[];
  transitions: WorkflowTransition[];
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
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [managingForms, setManagingForms] = useState(false);
  const [managingProjects, setManagingProjects] = useState(false);
  const [managingTeams, setManagingTeams] = useState(false);
  const [managingFields, setManagingFields] = useState(false);
  const [managingWorkflow, setManagingWorkflow] = useState(false);
  const [managingOrg, setManagingOrg] = useState(false);
  const [managingSla, setManagingSla] = useState(false);
  const [projectFilter, setProjectFilter] = useState<string>(ALL_PROJECTS_KEY);
  const [teamFilters, setTeamFilters] = useState<Set<string>>(new Set());

  const allRows = useMemo(() => flattenRows(rows), [rows]);

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
    () => rows.filter((r) => matchesProjectTeamFilters(r, projectFilter, teamFilters)),
    [rows, projectFilter, teamFilters]
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
          currentUserId={currentUserId}
          currentUserRole={currentUserRole}
          currentUserName={members.find((m) => m.userId === currentUserId)?.name ?? "there"}
          vocabTask={vocabTask}
          activityLog={activityLog}
          onSelectTask={setSelectedTaskId}
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
        <BucketsView columns={bucketColumns} vocabTask={vocabTask} vocabTeam={vocabTeam} onSelectTask={setSelectedTaskId} />
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
          currentUserRole={currentUserRole}
          docs={docs}
          docIdsByTask={docIdsByTask}
          taskObjects={taskObjects}
          checklistItemsByObject={checklistItemsByObject}
          taskObjectFileByObjectId={taskObjectFileByObjectId}
          customFieldDefs={customFieldDefs}
          customFieldValuesByTask={customFieldValuesByTask}
          activityLog={activityLog}
          contactNameById={contactNameById}
          contactById={contactById}
          ticketMessages={ticketMessages}
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
          onSelectDoc={setSelectedDocId}
          onClose={() => setSelectedTaskId(null)}
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
              // it from — see DocPanel's besideMain prop.
              besideMain={!!selectedTaskId}
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
          onClose={() => setCreating(false)}
        />
      )}

      {managingForms && (
        <FormTemplatesPanel
          orgId={orgId}
          templates={formTemplates}
          usage={formTemplateUsage}
          vocabTask={vocabTask}
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
          members={members}
          currentUserRole={currentUserRole}
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
          currentUserRole={currentUserRole}
          onClose={() => setManagingOrg(false)}
        />
      )}

      {managingSla && (
        <SlaSettingsPanel
          orgId={orgId}
          slaFirstResponseHours={slaFirstResponseHours}
          slaResolutionDays={slaResolutionDays}
          currentUserRole={currentUserRole}
          onClose={() => setManagingSla(false)}
        />
      )}
      </div>
    </div>
  );
}
