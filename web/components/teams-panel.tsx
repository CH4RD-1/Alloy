"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Project, Team, Task } from "@/lib/types";
import { createTeam, updateTeamFields, deleteTeam, setTeamMember, removeTeamMember } from "@/lib/actions";
import type { MemberSummary } from "@/lib/tasks-data";

// Ported from the prototype's renderTeamsManagerPanel() — each project
// keeps its own independent set of buckets, so this is scoped to one
// project at a time via a picker, same idea as ui.teamManagerProject.
export function TeamsPanel({
  orgId,
  projects,
  teams,
  tasks,
  members,
  teamMemberIdsByTeam,
  vocabTeam,
  vocabTask,
  onClose,
}: {
  orgId: string;
  projects: Project[];
  teams: Team[];
  tasks: Task[];
  members: MemberSummary[];
  teamMemberIdsByTeam: Map<string, string[]>;
  vocabTeam: string;
  vocabTask: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#2E3F6E");
  const [expandedTeamId, setExpandedTeamId] = useState<string | null>(null);

  const teamNoun = vocabTeam.toLowerCase();
  const taskNoun = vocabTask.toLowerCase();
  const effectiveProjectId = projects.some((p) => p.id === projectId) ? projectId : projects[0]?.id ?? "";
  const projectTeams = teams.filter((t) => t.project_id === effectiveProjectId);

  function run(action: () => Promise<unknown>) {
    setError(null);
    startTransition(async () => {
      try {
        await action();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      }
    });
  }

  function addTeam() {
    const name = newName.trim();
    if (!name || !effectiveProjectId) return;
    setNewName("");
    run(() => createTeam(orgId, effectiveProjectId, { name, color: newColor }));
  }

  return (
    <>
      <div className="scrim show" onClick={onClose} />
      <aside className="panel show panel-left">
        <div className="panel-head">
          <div style={{ flex: 1, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16, textTransform: "capitalize" }}>
            Manage {teamNoun}s
          </div>
          <button className="icon-btn panel-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="panel-body">
          {error && <div className="banner" style={{ color: "var(--blocked)", background: "var(--blocked-bg)" }}>{error}</div>}

          <div className="banner">
            Each project keeps its own independent set of {teamNoun}s — rename or recolour one here and it only affects this
            project. A {teamNoun} with {taskNoun}s in it can&apos;t be removed until they&apos;re moved elsewhere. Expand a{" "}
            {teamNoun} below to set who&apos;s on it — this matters once Team allocation is turned on in Organization
            settings, which narrows the Assignee picker to a {taskNoun}&apos;s own {teamNoun} members.
          </div>

          <div className="field-group">
            <span className="field-label">Project</span>
            <select className="select-input" value={effectiveProjectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div className="field-group">
            <span className="field-label">Existing {teamNoun}s</span>
            {projectTeams.length === 0 && <p style={{ color: "var(--text-faint)", fontSize: 12 }}>No {teamNoun}s in this project yet.</p>}
            {projectTeams.map((tm) => {
              const count = tasks.filter((t) => t.team_id === tm.id).length;
              const delTitle = count ? `Move its ${count} ${count === 1 ? taskNoun : taskNoun + "s"} to another ${teamNoun} first` : `Remove this ${teamNoun}`;
              return (
                <div key={tm.id} className="field-def-card">
                  <div className="field-def-head" style={{ gap: 8 }}>
                    <input
                      type="color"
                      className="team-color-input"
                      defaultValue={tm.color}
                      title={`${vocabTeam} colour`}
                      onChange={(e) => run(() => updateTeamFields(tm.id, { color: e.target.value }))}
                    />
                    <input
                      className="text-input"
                      style={{ flex: 1 }}
                      defaultValue={tm.name}
                      placeholder={`${vocabTeam} name`}
                      onBlur={(e) => {
                        const value = e.target.value.trim();
                        if (value && value !== tm.name) run(() => updateTeamFields(tm.id, { name: value }));
                      }}
                    />
                    <button
                      className="icon-btn"
                      disabled={!!count || pending}
                      title={delTitle}
                      onClick={() => {
                        if (confirm(`Delete "${tm.name}"?`)) run(() => deleteTeam(tm.id));
                      }}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="crumbline">
                    {count} {count === 1 ? taskNoun : taskNoun + "s"}
                  </div>
                  <button
                    className="icon-btn"
                    style={{ marginTop: 6, width: "auto", padding: "2px 8px", fontSize: 11.5 }}
                    onClick={() => setExpandedTeamId(expandedTeamId === tm.id ? null : tm.id)}
                  >
                    {(teamMemberIdsByTeam.get(tm.id)?.length ?? 0)} member{(teamMemberIdsByTeam.get(tm.id)?.length ?? 0) === 1 ? "" : "s"}
                    {expandedTeamId === tm.id ? " ▲" : " ▼"}
                  </button>
                  {expandedTeamId === tm.id && (
                    <div style={{ marginTop: 6, borderTop: "1px solid var(--border)", paddingTop: 6 }}>
                      {members.length === 0 && <p style={{ color: "var(--text-faint)", fontSize: 12 }}>No org members yet.</p>}
                      {members.map((m) => {
                        const isMember = !!teamMemberIdsByTeam.get(tm.id)?.includes(m.userId);
                        return (
                          <label key={m.userId} className="checkbox-row" style={{ marginTop: 2 }}>
                            <input
                              type="checkbox"
                              checked={isMember}
                              disabled={pending}
                              onChange={(e) =>
                                run(() =>
                                  e.target.checked ? setTeamMember(orgId, tm.id, m.userId) : removeTeamMember(tm.id, m.userId)
                                )
                              }
                            />
                            <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{m.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="divider" />

          <div className="field-group">
            <span className="field-label">Add a {teamNoun} to this project</span>
            <div className="field-row">
              <input type="color" className="team-color-input" value={newColor} onChange={(e) => setNewColor(e.target.value)} />
              <input
                className="text-input"
                style={{ flex: 1 }}
                placeholder={`${vocabTeam} name`}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addTeam()}
              />
            </div>
            <button className="small-btn" style={{ marginTop: 8 }} disabled={!newName.trim() || !effectiveProjectId || pending} onClick={addTeam}>
              Add {teamNoun}
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
