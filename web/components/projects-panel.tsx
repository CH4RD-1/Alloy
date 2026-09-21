"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Project, Task, Workflow } from "@/lib/types";
import { createProject, updateProjectFields, deleteProject } from "@/lib/actions";

// Ported from the prototype's renderProjectsManagerPanel() — a settings-only
// CRUD list (recolor/rename/toggle-helpdesk/toggle-allocations, delete
// guarded by task count) plus an add-project form that also seeds a
// starter "General" bucket, same pattern as the form-templates panel.
export function ProjectsPanel({
  orgId,
  projects,
  workflows,
  tasks,
  vocabTask,
  onClose,
}: {
  orgId: string;
  projects: Project[];
  workflows: Workflow[];
  tasks: Task[];
  vocabTask: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#2E3F6E");
  const [newHelpdesk, setNewHelpdesk] = useState(false);
  const [newAllocations, setNewAllocations] = useState(false);
  const [newTag, setNewTag] = useState("");

  const taskNoun = vocabTask.toLowerCase();

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

  function addProject() {
    const name = newName.trim();
    if (!name) return;
    setNewName("");
    setNewHelpdesk(false);
    setNewAllocations(false);
    setNewTag("");
    run(() => createProject(orgId, { name, color: newColor, isHelpdesk: newHelpdesk, enableAllocations: newAllocations, tag: newTag }));
  }

  return (
    <>
      <div className="scrim show" onClick={onClose} />
      <aside className="panel show panel-left">
        <div className="panel-head">
          <div style={{ flex: 1, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16 }}>Manage projects</div>
          <button className="icon-btn panel-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="panel-body">
          {error && <div className="banner" style={{ color: "var(--blocked)", background: "var(--blocked-bg)" }}>{error}</div>}

          <div className="banner">
            Projects group {taskNoun}s in the sidebar and colour their cards on the Gantt and Buckets views. Rename or recolour one
            anytime — one with {taskNoun}s in it can&apos;t be removed until they&apos;re moved elsewhere. Mark a project
            &quot;Helpdesk&quot; and its {taskNoun}s drop off the Gantt and need no dates, but still show in List and Buckets.
          </div>

          <div className="field-group">
            <span className="field-label">Existing projects</span>
            {projects.length === 0 && <p style={{ color: "var(--text-faint)", fontSize: 12 }}>No projects yet.</p>}
            {projects.map((p) => {
              const count = tasks.filter((t) => t.project_id === p.id).length;
              const delTitle = count ? `Move its ${count} ${count === 1 ? taskNoun : taskNoun + "s"} to another project first` : "Remove this project";
              return (
                <div key={p.id} className="field-def-card">
                  <div className="field-def-head" style={{ gap: 8 }}>
                    <input
                      type="color"
                      className="team-color-input"
                      defaultValue={p.color}
                      title="Project colour"
                      onChange={(e) => run(() => updateProjectFields(p.id, { color: e.target.value }))}
                    />
                    <input
                      className="text-input"
                      style={{ flex: 1 }}
                      defaultValue={p.name}
                      placeholder="Project name"
                      onBlur={(e) => {
                        const value = e.target.value.trim();
                        if (value && value !== p.name) run(() => updateProjectFields(p.id, { name: value }));
                      }}
                    />
                    <input
                      className="text-input"
                      style={{ width: 46, textAlign: "center", textTransform: "uppercase", fontFamily: "var(--font-mono)" }}
                      defaultValue={p.tag ?? ""}
                      maxLength={2}
                      placeholder="P1"
                      title={`This project's tag — every ${taskNoun} created in it gets an id like "${(p.tag || "P1").toUpperCase()}01" (permanent once assigned; changing the tag only affects new ${taskNoun}s)`}
                      onBlur={(e) => {
                        const value = e.target.value.trim();
                        if (value !== (p.tag ?? "")) run(() => updateProjectFields(p.id, { tag: value || null }));
                      }}
                    />
                    <button
                      className="icon-btn"
                      disabled={!!count || pending}
                      title={delTitle}
                      onClick={() => {
                        if (confirm(`Delete "${p.name}"?`)) run(() => deleteProject(p.id));
                      }}
                    >
                      ✕
                    </button>
                  </div>
                  <label className="checkbox-row" style={{ marginTop: 8 }}>
                    <input
                      type="checkbox"
                      defaultChecked={p.is_helpdesk}
                      onChange={(e) => run(() => updateProjectFields(p.id, { is_helpdesk: e.target.checked }))}
                    />
                    <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                      Helpdesk project — its {taskNoun}s aren&apos;t scheduled and are hidden from the Gantt
                    </span>
                  </label>
                  <label className="checkbox-row" style={{ marginTop: 4 }}>
                    <input
                      type="checkbox"
                      defaultChecked={p.enable_allocations}
                      onChange={(e) => run(() => updateProjectFields(p.id, { enable_allocations: e.target.checked }))}
                    />
                    <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                      Enable allocations — lets {taskNoun}s in this project be created from the Assets tab
                    </span>
                  </label>

                  {/* One workflow per project now (see the Workflow &
                      roles editor) — a task/helpdesk-type one always, and a
                      second asset-type one only while allocations are on,
                      since is_helpdesk/enable_allocations are independent. */}
                  <div className="field-row" style={{ marginTop: 8, alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 12.5, color: "var(--text-muted)", flex: "0 0 92px" }}>Workflow</span>
                    <select
                      className="select-input"
                      style={{ flex: 1 }}
                      value={p.workflow_id ?? ""}
                      onChange={(e) => run(() => updateProjectFields(p.id, { workflow_id: e.target.value || null }))}
                    >
                      <option value="" disabled>
                        Pick a workflow…
                      </option>
                      {workflows
                        .filter((w) => w.type === (p.is_helpdesk ? "helpdesk" : "task"))
                        .map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.name}
                          </option>
                        ))}
                    </select>
                  </div>
                  {p.enable_allocations && (
                    <div className="field-row" style={{ marginTop: 4, alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 12.5, color: "var(--text-muted)", flex: "0 0 92px" }}>Asset workflow</span>
                      <select
                        className="select-input"
                        style={{ flex: 1 }}
                        value={p.asset_workflow_id ?? ""}
                        onChange={(e) => run(() => updateProjectFields(p.id, { asset_workflow_id: e.target.value || null }))}
                      >
                        <option value="" disabled>
                          Pick an asset workflow…
                        </option>
                        {workflows
                          .filter((w) => w.type === "asset")
                          .map((w) => (
                            <option key={w.id} value={w.id}>
                              {w.name}
                            </option>
                          ))}
                      </select>
                    </div>
                  )}

                  <div className="crumbline">
                    {count} {count === 1 ? taskNoun : taskNoun + "s"}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="divider" />

          <div className="field-group">
            <span className="field-label">Add a project</span>
            <div className="field-row">
              <input type="color" className="team-color-input" value={newColor} onChange={(e) => setNewColor(e.target.value)} />
              <input
                className="text-input"
                style={{ flex: 1 }}
                placeholder="Project name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addProject()}
              />
              <input
                className="text-input"
                style={{ width: 46, textAlign: "center", textTransform: "uppercase", fontFamily: "var(--font-mono)" }}
                placeholder="P1"
                maxLength={2}
                title={`Optional — every ${taskNoun} created in this project gets an id built from this tag, e.g. "P101". Can be added or changed later.`}
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addProject()}
              />
            </div>
            <label className="checkbox-row" style={{ marginTop: 8 }}>
              <input type="checkbox" checked={newHelpdesk} onChange={(e) => setNewHelpdesk(e.target.checked)} />
              <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>Helpdesk project — tickets aren&apos;t scheduled and are hidden from the Gantt</span>
            </label>
            <label className="checkbox-row" style={{ marginTop: 4 }}>
              <input type="checkbox" checked={newAllocations} onChange={(e) => setNewAllocations(e.target.checked)} />
              <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>Enable allocations — lets tasks in this project be created from the Assets tab</span>
            </label>
            <button className="small-btn" style={{ marginTop: 8 }} disabled={!newName.trim() || pending} onClick={addProject}>
              Add project
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
