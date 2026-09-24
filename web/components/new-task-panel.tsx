"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Team, Project } from "@/lib/types";
import type { MemberSummary } from "@/lib/tasks-data";
import { createTask } from "@/lib/actions";
import { eligibleAssignees } from "@/lib/team-allocation";
import { DateGuideField } from "@/components/date-guide-field";

export function NewTaskPanel({
  orgId,
  projects,
  teams,
  members,
  defaultProjectId,
  vocabTask,
  orgTeamAllocationEnabled,
  teamMemberIdsByTeam,
  actingAsUserId,
  onClose,
}: {
  orgId: string;
  projects: Project[];
  teams: Team[];
  members: MemberSummary[];
  defaultProjectId: string;
  vocabTask: string;
  orgTeamAllocationEnabled: boolean;
  teamMemberIdsByTeam: Map<string, string[]>;
  // Dev tools "View as" (components/dev-tools-panel.tsx) — when the owner/
  // admin viewing this is previewing the app as another member or dummy
  // user, the created task's author (activity log) is attributed to that
  // identity instead of the real signed-in account. Null/undefined when
  // viewing as yourself, the normal case.
  actingAsUserId?: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState(defaultProjectId);
  const [teamId, setTeamId] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [isMilestone, setIsMilestone] = useState(false);
  const [startDate, setStartDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [error, setError] = useState<string | null>(null);

  const projectTeams = teams.filter((t) => t.project_id === projectId);

  function submit() {
    if (!title.trim()) {
      setError("Give it a title first.");
      return;
    }
    if (!projectId) {
      setError("Pick a project.");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await createTask({
          orgId,
          projectId,
          teamId: teamId || null,
          title: title.trim(),
          description: description.trim() || null,
          assigneeId: assigneeId || null,
          isMilestone,
          startDate: startDate || null,
          dueDate: dueDate || null,
          actingAsUserId,
        });
        router.refresh();
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      }
    });
  }

  return (
    <>
      <div className="scrim show" onClick={onClose} />
      <aside className="panel show">
        <div className="panel-head">
          <div style={{ flex: 1, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16 }}>New {vocabTask.toLowerCase()}</div>
          <button className="icon-btn panel-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="panel-body">
          {error && <div className="banner" style={{ color: "var(--blocked)", background: "var(--blocked-bg)" }}>{error}</div>}

          <div className="field-group">
            <span className="field-label">Title</span>
            <input
              className="text-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </div>

          <div className="field-group">
            <span className="field-label">Description</span>
            <textarea
              className="text-input obj-textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="More detailed description of the issue…."
            />
          </div>

          <div className="field-group">
            <span className="field-label">Project</span>
            <select
              className="select-input"
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                setTeamId("");
                setAssigneeId("");
              }}
            >
              {projects.length === 0 && <option value="">No projects yet</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div className="field-group">
            <span className="field-label">Team</span>
            <select
              className="select-input"
              value={teamId}
              onChange={(e) => {
                setTeamId(e.target.value);
                setAssigneeId(""); // the previous pick may not be eligible for the new team
              }}
            >
              <option value="">No team</option>
              {projectTeams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>

          <div className="field-group">
            <span className="field-label">Assignee</span>
            <select className="select-input" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">Unassigned</option>
              {eligibleAssignees(members, teamId || null, teamMemberIdsByTeam, orgTeamAllocationEnabled, null).map(
                ({ member: m }) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name}
                  </option>
                )
              )}
            </select>
          </div>

          <div className="field-group">
            <span className="field-label">Dates</span>
            <label className="checkbox-row" style={{ marginBottom: 8 }}>
              <input type="checkbox" checked={isMilestone} onChange={(e) => setIsMilestone(e.target.checked)} />
              Milestone
            </label>
            {isMilestone ? (
              <DateGuideField value={startDate} onChange={setStartDate} />
            ) : (
              <div className="date-box-row">
                <DateGuideField label="Start" value={startDate} onChange={setStartDate} />
                <DateGuideField label="Due" value={dueDate} onChange={setDueDate} />
              </div>
            )}
          </div>

          <button className="primary-btn" disabled={pending} onClick={submit} style={{ width: "100%" }}>
            {pending ? "Creating…" : `Create ${vocabTask.toLowerCase()}`}
          </button>
        </div>
      </aside>
    </>
  );
}
