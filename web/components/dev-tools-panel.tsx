"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Role, Project, DevTools } from "@/lib/types";
import type { ProjectTemplateV1 } from "@/lib/actions";
import type { MemberSummary } from "@/lib/tasks-data";
import { updateDevTools, createDummyUser, deleteDummyUser, exportProjectTemplate, importProjectTemplate } from "@/lib/actions";

const ALL_ROLES: { id: Role; name: string }[] = [
  { id: "standard", name: "Standard" },
  { id: "authorizer", name: "Authorizer" },
  { id: "manager", name: "Manager" },
  { id: "admin", name: "Admin" },
  { id: "owner", name: "Owner" },
];
const ROLE_NAME: Record<string, string> = Object.fromEntries(ALL_ROLES.map((r) => [r.id, r.name]));

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}

// The "Developer" settings panel — a master "Developer mode" switch plus
// three independently-toggleable sub-tools (see orgs.dev_tools's own
// comment in schema.sql): the "Viewing as" switch (rendered in the sidebar
// footer once this is on — see components/app-sidebar.tsx), dummy users
// (created/removed here), and project export/import templates (also done
// here — no separate panel, since both halves of that round-trip belong
// together). Same one-concern-per-panel, owner/admin-gated pattern as
// every other settings panel (SLA settings, Organization, ...).
export function DevToolsPanel({
  orgId,
  currentUserRole,
  devTools,
  members,
  projects,
  onClose,
}: {
  orgId: string;
  currentUserRole: Role;
  devTools: DevTools;
  members: MemberSummary[];
  projects: Project[];
  onClose: () => void;
}) {
  const canManage = currentUserRole === "owner" || currentUserRole === "admin";
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [newDummyName, setNewDummyName] = useState("");
  const [newDummyRole, setNewDummyRole] = useState<Role>("standard");

  const [exportProjectId, setExportProjectId] = useState(projects[0]?.id ?? "");
  const [importTemplate, setImportTemplate] = useState<ProjectTemplateV1 | null>(null);
  const [importFileName, setImportFileName] = useState("");
  const [importName, setImportName] = useState("");
  const [importColor, setImportColor] = useState("#f97316");
  const [importStartDate, setImportStartDate] = useState(todayIso());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const dummyUsers = members.filter((m) => m.isDummy);

  function run(action: () => Promise<unknown>) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        await action();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      }
    });
  }

  function addDummyUser() {
    const name = newDummyName.trim();
    if (!name) {
      setError("Give the dummy user a name.");
      return;
    }
    run(async () => {
      await createDummyUser(orgId, { name, role: newDummyRole });
      setNewDummyName("");
    });
  }

  function handleExport() {
    if (!exportProjectId) return;
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        const data = await exportProjectTemplate(exportProjectId);
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${slugify(data.name)}-template.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't export that project.");
      }
    });
  }

  function handleFilePicked(file: File) {
    setError(null);
    setNotice(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as ProjectTemplateV1;
        if (parsed?.format !== "alloy-project-template") throw new Error("not a template");
        setImportTemplate(parsed);
        setImportFileName(file.name);
        setImportName(parsed.name || "");
        setImportColor(parsed.color || "#f97316");
      } catch {
        setImportTemplate(null);
        setImportFileName("");
        setError("That file doesn't look like an Alloy project template.");
      }
    };
    reader.readAsText(file);
  }

  function handleImport() {
    if (!importTemplate) return;
    setNotice(null);
    run(async () => {
      await importProjectTemplate(orgId, importTemplate, {
        name: importName,
        color: importColor,
        startDate: importStartDate,
      });
      setImportTemplate(null);
      setImportFileName("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      setNotice(`Imported as a new project — find it in your sidebar.`);
    });
  }

  return (
    <>
      <div className="scrim show" onClick={onClose} />
      <aside className="panel show panel-left">
        <div className="panel-head">
          <div style={{ flex: 1, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16 }}>Developer tools</div>
          <button className="icon-btn panel-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="panel-body">
          {error && <div className="banner" style={{ color: "var(--blocked)", background: "var(--blocked-bg)" }}>{error}</div>}
          {notice && <div className="banner">{notice}</div>}

          {!canManage ? (
            <p style={{ color: "var(--text-faint)", fontSize: 12 }}>Only an owner or admin can manage this.</p>
          ) : (
            <>
              <p style={{ color: "var(--text-faint)", fontSize: 12, marginBottom: 12 }}>
                Testing tools for this org — a &quot;Viewing as&quot; switch to preview the app as another member or a
                dummy user, dummy (unable-to-log-in) test users, and project export/import templates. Each is its own
                switch below; nothing shows anywhere else in the app until you turn it on here.
              </p>

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={devTools.enabled}
                  disabled={pending}
                  onChange={(e) => run(() => updateDevTools(orgId, { enabled: e.target.checked }))}
                />
                <span style={{ fontSize: 12.5, color: "var(--text-muted)", fontWeight: 600 }}>Developer mode</span>
              </label>

              {devTools.enabled && (
                <>
                  <div className="divider" />

                  <div className="field-group">
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={devTools.userSwitch}
                        disabled={pending}
                        onChange={(e) => run(() => updateDevTools(orgId, { userSwitch: e.target.checked }))}
                      />
                      <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>User switch</span>
                    </label>
                    <p style={{ color: "var(--text-faint)", fontSize: 11.5, marginTop: 4, marginLeft: 24 }}>
                      Adds a &quot;Viewing as&quot; picker to the sidebar footer, below, for previewing the app as
                      another member or a dummy user — role-gated buttons, &quot;my tasks,&quot; and everything you do
                      while switched (status changes, notes, new tasks) get attributed to that identity in the
                      activity log. Your own account still does the actual work underneath — only an owner or admin
                      can use it.
                    </p>
                  </div>

                  <div className="divider" />

                  <div className="field-group">
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={devTools.dummyUsers}
                        disabled={pending}
                        onChange={(e) => run(() => updateDevTools(orgId, { dummyUsers: e.target.checked }))}
                      />
                      <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>Dummy users</span>
                    </label>

                    {devTools.dummyUsers && (
                      <div style={{ marginTop: 10 }}>
                        <p style={{ color: "var(--text-faint)", fontSize: 11.5, marginBottom: 8 }}>
                          Real members with no way to actually sign in — assignable to tasks and available to the
                          Viewing-as switch above, for testing a role or a workload without a real account.
                        </p>

                        {dummyUsers.map((m) => (
                          <div key={m.userId} className="field-def-card" style={{ marginBottom: 6 }}>
                            <div className="field-def-head">
                              <span style={{ flex: 1 }}>{m.name}</span>
                              {["standard", "authorizer", "manager"].includes(m.role) ? (
                                <span className={`chip role-badge role-${m.role}`}>{ROLE_NAME[m.role] ?? m.role}</span>
                              ) : (
                                <span className="chip">{ROLE_NAME[m.role] ?? m.role}</span>
                              )}
                              <button
                                type="button"
                                className="icon-btn"
                                disabled={pending}
                                title="Remove"
                                onClick={() => run(() => deleteDummyUser(orgId, m.userId))}
                              >
                                ✕
                              </button>
                            </div>
                          </div>
                        ))}
                        {!dummyUsers.length && (
                          <p style={{ color: "var(--text-faint)", fontSize: 12, marginBottom: 8 }}>No dummy users yet.</p>
                        )}

                        <div className="add-inline" style={{ marginTop: 8 }}>
                          <input
                            className="text-input"
                            placeholder="Name"
                            value={newDummyName}
                            onChange={(e) => setNewDummyName(e.target.value)}
                          />
                          <select className="select-input" value={newDummyRole} onChange={(e) => setNewDummyRole(e.target.value as Role)}>
                            {ALL_ROLES.map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.name}
                              </option>
                            ))}
                          </select>
                          <button className="small-btn" disabled={pending} onClick={addDummyUser}>
                            + Add
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="divider" />

                  <div className="field-group">
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={devTools.templates}
                        disabled={pending}
                        onChange={(e) => run(() => updateDevTools(orgId, { templates: e.target.checked }))}
                      />
                      <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>Export &amp; import project templates</span>
                    </label>

                    {devTools.templates && (
                      <div style={{ marginTop: 10 }}>
                        <p style={{ color: "var(--text-faint)", fontSize: 11.5, marginBottom: 8 }}>
                          A project&apos;s tasks/subtasks, tags, custom field values, dates (relative to the project&apos;s
                          own earliest date), and dependency links, as a JSON file — no attachments, no assignees, no
                          statuses. An easier, repeatable alternative to hand-editing seed.sql for spinning up a new
                          pre-populated project.
                        </p>

                        <span className="field-label">Export</span>
                        <div className="add-inline" style={{ marginBottom: 12 }}>
                          <select className="select-input" value={exportProjectId} onChange={(e) => setExportProjectId(e.target.value)}>
                            {projects.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                          </select>
                          <button className="small-btn" disabled={pending || !exportProjectId} onClick={handleExport}>
                            Download
                          </button>
                        </div>

                        <div className="divider" />

                        <span className="field-label" style={{ marginTop: 10, display: "block" }}>
                          Import
                        </span>
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept="application/json"
                          className="text-input"
                          style={{ marginTop: 6, marginBottom: 8 }}
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) handleFilePicked(file);
                          }}
                        />
                        {importTemplate && (
                          <>
                            <p style={{ color: "var(--text-faint)", fontSize: 11.5, marginBottom: 8 }}>
                              {importFileName} — {importTemplate.tasks.length} task{importTemplate.tasks.length === 1 ? "" : "s"}
                            </p>
                            <div className="field-group">
                              <span className="field-label">New project name</span>
                              <input className="text-input" value={importName} onChange={(e) => setImportName(e.target.value)} />
                            </div>
                            <div className="field-group" style={{ marginTop: 8 }}>
                              <span className="field-label">Color</span>
                              <input
                                type="color"
                                className="text-input"
                                style={{ padding: 2, height: 32, width: 56 }}
                                value={importColor}
                                onChange={(e) => setImportColor(e.target.value)}
                              />
                            </div>
                            <div className="field-group" style={{ marginTop: 8 }}>
                              <span className="field-label">Start date (day 0 for the template&apos;s dates)</span>
                              <input
                                type="date"
                                className="text-input"
                                value={importStartDate}
                                onChange={(e) => setImportStartDate(e.target.value)}
                              />
                            </div>
                            <button className="primary-btn" style={{ marginTop: 10 }} disabled={pending} onClick={handleImport}>
                              Import as new project
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}
