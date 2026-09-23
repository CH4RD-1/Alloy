"use client";

import { useState } from "react";
import type { Project, Team, Role, DevTools } from "@/lib/types";
import type { TaskRow } from "@/lib/list-view";
import type { MemberSummary } from "@/lib/tasks-data";
import { ALL_PROJECTS_KEY, teamGroupsFor, taskCountForProject } from "@/lib/sidebar-view";

// The white-circle-red-cross mark that flags a Helpdesk project — ported
// verbatim from the prototype's helpdeskBadgeHtml(). The ring colour is the
// only customizable part (tied to the project's own colour picker in Manage
// projects); the cross and white fill never change, so the mark stays
// instantly recognizable project-to-project.
function HelpdeskBadge({ color, size = 14 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ flex: `0 0 ${size}px` }} aria-hidden="true">
      <title>Helpdesk project — tickets aren&apos;t scheduled and are hidden from the Gantt</title>
      <circle cx="12" cy="12" r="10.5" fill="#FFFFFF" stroke={color} strokeWidth="2.4" />
      <path d="M10.6 5.4h2.8v4.2h4.2v2.8h-4.2v4.2h-2.8v-4.2H6.4v-2.8h4.2z" fill="#D9333F" />
    </svg>
  );
}

// The single "Settings" button's icon — a wrench crossed with a gear,
// same thin-stroke pictogram language as the rest of the app's inline
// icons (see components/task-list-view.tsx's ChevronIcon/LinkIcon/DocIcon).
// Two small SVGs side by side rather than one merged glyph, so each stays
// legible at this size instead of turning into a blob.
function WrenchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z" />
    </svg>
  );
}
function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="2.6" />
      <path d="M12 3.6v2M12 18.4v2M4.9 6.4l1.5 1.4M17.6 16.2l1.5 1.4M3.6 12h2M18.4 12h2M4.9 17.6l1.5-1.4M17.6 7.8l1.5-1.4" />
    </svg>
  );
}

// Ported from the prototype's renderSidebar() — the "Workspace" project nav
// (All projects + one row per project, each with a live task count) and the
// "Filter by team" checkbox list beneath it. Picking a project scopes List/
// Buckets/Gantt to it and resets the team filter (a merged "All projects"
// team key and a real per-project team id mean different things — see
// lib/sidebar-view.ts); Dashboard/Knowledge base/Assets stay unfiltered by
// either control, same scope the prototype used.
export function AppSidebar({
  projects,
  teams,
  allRows,
  vocabTeam,
  projectFilter,
  teamFilters,
  onSetProject,
  onToggleTeam,
  onManageFields,
  onManageProjects,
  onManageTeams,
  onManageForms,
  onManageWorkflow,
  onManageOrg,
  onManageSla,
  onManageDev,
  devTools,
  members,
  realUserId,
  realUserRole,
  viewingAs,
  onViewingAsChange,
}: {
  projects: Project[];
  teams: Team[];
  allRows: TaskRow[];
  vocabTeam: string;
  projectFilter: string;
  teamFilters: Set<string>;
  onSetProject: (id: string) => void;
  onToggleTeam: (key: string) => void;
  onManageFields: () => void;
  onManageProjects: () => void;
  onManageTeams: () => void;
  onManageForms: () => void;
  onManageWorkflow: () => void;
  onManageOrg: () => void;
  onManageSla: () => void;
  onManageDev: () => void;
  // Dev tools (components/dev-tools-panel.tsx) — devTools.userSwitch gates
  // whether the "Viewing as" picker below shows at all; realUserRole (the
  // signed-in account's own actual role, never the switched-to one) gates
  // it a second time to owner/admin only, since it's the one control that
  // lets you act as someone else. viewingAs is null while viewing as
  // yourself, the normal case.
  devTools: DevTools;
  members: MemberSummary[];
  realUserId: string;
  realUserRole: Role;
  viewingAs: { id: string; name: string; role: Role } | null;
  onViewingAsChange: (next: { id: string; name: string; role: Role } | null) => void;
}) {
  const groups = teamGroupsFor(projectFilter, teams);
  const teamNoun = vocabTeam.toLowerCase();
  // The "Manage ..." buttons below are all settings screens most users
  // never touch — collapsed by default behind one Settings toggle so the
  // sidebar's day-to-day surface (project nav, team filters) isn't crowded
  // by six/seven buttons on every load. Local, resets on navigation/reload
  // rather than persisted — there's no strong case for remembering it open.
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <aside className="sidebar">
      <div>
        <div className="side-section-label">Workspace</div>
        <nav className="side-nav">
          <button
            type="button"
            className={`side-link ${projectFilter === ALL_PROJECTS_KEY ? "active" : ""}`}
            onClick={() => onSetProject(ALL_PROJECTS_KEY)}
          >
            <span className="side-dot" style={{ background: "var(--text-faint)" }} />
            All projects
            <span className="side-count">{taskCountForProject(ALL_PROJECTS_KEY, allRows)}</span>
          </button>
          {projects.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`side-link ${projectFilter === p.id ? "active" : ""}`}
              onClick={() => onSetProject(p.id)}
            >
              {p.is_helpdesk ? <HelpdeskBadge color={p.color} /> : <span className="side-dot" style={{ background: p.color }} />}
              {p.name}
              <span className="side-count">{taskCountForProject(p.id, allRows)}</span>
            </button>
          ))}
        </nav>
      </div>

      <div>
        <div className="side-section-label">Filter by {teamNoun}</div>
        <div className="team-filter-list">
          {groups.map((g) => (
            <label key={g.key} className="team-check">
              <input type="checkbox" checked={teamFilters.has(g.key)} onChange={() => onToggleTeam(g.key)} />
              <span className="team-swatch" style={{ background: g.color }} />
              {g.name}
            </label>
          ))}
          {!groups.length && (
            <p style={{ color: "var(--text-faint)", fontSize: 12, padding: "2px 8px" }}>No {teamNoun}s yet.</p>
          )}
        </div>
      </div>

      {/* Ported from the prototype's .sidebar-footer — the original five now
          live here instead of as topbar buttons (see tasks-workspace.tsx),
          which is where the prototype itself always kept them; the topbar
          was getting crowded on narrower/lower-res displays with a fifth
          ("Manage workflow & roles") about to join it. "Organization" is new
          with custom subdomains (Phase 3) — no prototype equivalent, since
          the prototype had no concept of an org at all. Theme toggle and
          Reset sample data, the footer's other two prototype buttons, still
          aren't ported — see the README. */}
      <div className="sidebar-footer">
        {/* "Viewing as" (components/dev-tools-panel.tsx) — only an owner/
            admin sees this, and only once Dev tools' User switch is on
            (see that panel). Picking a member/dummy user changes what the
            rest of the app shows (role-gated UI, "my tasks") and attributes
            anything created while switched to that identity in the
            activity log; the real account still does the actual writes. */}
        {devTools.enabled && devTools.userSwitch && (realUserRole === "owner" || realUserRole === "admin") && (
          <div className="view-as-row">
            <span className="view-as-label">Viewing as</span>
            <select
              className="select-input view-as-select"
              value={viewingAs?.id ?? ""}
              onChange={(e) => {
                const id = e.target.value;
                if (!id) {
                  onViewingAsChange(null);
                  return;
                }
                const m = members.find((mm) => mm.userId === id);
                if (m) onViewingAsChange({ id: m.userId, name: m.name, role: m.role });
              }}
            >
              <option value="">Yourself</option>
              {members.filter((m) => !m.isDummy && m.userId !== realUserId).length > 0 && (
                <optgroup label="Members">
                  {members
                    .filter((m) => !m.isDummy && m.userId !== realUserId)
                    .map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.name} ({m.role})
                      </option>
                    ))}
                </optgroup>
              )}
              {members.filter((m) => m.isDummy).length > 0 && (
                <optgroup label="Dummy users">
                  {members
                    .filter((m) => m.isDummy)
                    .map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.name} ({m.role})
                      </option>
                    ))}
                </optgroup>
              )}
            </select>
          </div>
        )}
        <button
          type="button"
          className={`ghost-btn settings-toggle-btn ${settingsOpen ? "active" : ""}`}
          onClick={() => setSettingsOpen((o) => !o)}
          aria-expanded={settingsOpen}
        >
          <span className="settings-toggle-icons">
            <WrenchIcon />
            <GearIcon />
          </span>
          Settings
        </button>
        {settingsOpen && (
          <div className="settings-menu-reveal">
            <button type="button" className="ghost-btn" onClick={onManageFields}>
              ⚙ Manage custom fields
            </button>
            <button type="button" className="ghost-btn" onClick={onManageProjects}>
              ⊟ Manage projects
            </button>
            <button type="button" className="ghost-btn" onClick={onManageTeams}>
              ⊞ Manage {teamNoun}s
            </button>
            <button type="button" className="ghost-btn" onClick={onManageForms}>
              ▤ Manage form templates
            </button>
            <button type="button" className="ghost-btn" onClick={onManageWorkflow}>
              ⇄ Manage workflow &amp; roles
            </button>
            <button type="button" className="ghost-btn" onClick={onManageOrg}>
              ⌂ Organization
            </button>
            <button type="button" className="ghost-btn" onClick={onManageSla}>
              ⏱ SLA settings
            </button>
            <button type="button" className="ghost-btn" onClick={onManageDev}>
              ⚒ Developer
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
