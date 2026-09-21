"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Asset, Task, WorkflowStatus, Project, TaskLink } from "@/lib/types";
import type { TaskRow } from "@/lib/list-view";
import {
  ASSET_ICON_ORDER,
  ASSET_ICON_LABELS,
  COST_FREQUENCIES,
  activeAllocationTask,
  assetDisplayStatus,
  assetStatusLabel,
  cloneTargetTaskId,
} from "@/lib/assets-view";
import { AssetIcon } from "@/components/asset-icon";
import { updateAssetFields, deleteAsset, updateProjectFields, allocateAsset } from "@/lib/actions";

// Ported from the prototype's renderAssetPanel()/renderAllocatePanel() — a
// full edit surface for one asset (fields save immediately, same pattern as
// the form-templates panel) plus an inline "Allocate" sub-view. One
// component with a local view/allocate mode switch, mirroring how the
// prototype swapped ui.panelMode within the same slide-over.
export function AssetPanel({
  asset,
  tasks,
  statuses,
  links,
  projects,
  allRows,
  orgId,
  onClose,
}: {
  asset: Asset;
  tasks: Task[];
  statuses: WorkflowStatus[];
  links: TaskLink[];
  projects: Project[];
  allRows: TaskRow[];
  orgId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<"view" | "allocate">("view");
  const [error, setError] = useState<string | null>(null);

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

  const status = assetDisplayStatus(asset, tasks, statuses);
  const statusCls = status === "retired" ? "asset-chip-retired" : status === "allocated" ? "asset-chip-allocated" : "asset-chip-available";
  const allocTask = activeAllocationTask(asset.id, tasks, statuses);
  const targetTaskId = allocTask ? cloneTargetTaskId(allocTask.id, links) : null;
  const targetTask = targetTaskId ? allRows.find((r) => r.task.id === targetTaskId) : null;
  const everUsed = tasks.some((t) => t.asset_id === asset.id);

  if (mode === "allocate") {
    return (
      <AllocatePanel
        asset={asset}
        projects={projects}
        allRows={allRows}
        orgId={orgId}
        pending={pending}
        error={error}
        run={run}
        onDone={() => setMode("view")}
        onClose={onClose}
      />
    );
  }

  return (
    <>
      <div className="scrim show" onClick={onClose} />
      <aside className="panel show">
        <div className="panel-head">
          <div style={{ flex: 1, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16 }}>{asset.name || "Untitled asset"}</div>
          <button className="icon-btn panel-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="panel-body">
          {error && <div className="banner" style={{ color: "var(--blocked)", background: "var(--blocked-bg)" }}>{error}</div>}

          <div className="field-group">
            <span className={"asset-status-chip " + statusCls}>{assetStatusLabel(status)}</span>
          </div>

          <div className="field-group">
            <label className="field-label">Name</label>
            <input
              className="text-input"
              defaultValue={asset.name}
              placeholder="e.g. Dell Latitude 5440"
              onBlur={(e) => {
                const value = e.target.value.trim();
                if (value && value !== asset.name) run(() => updateAssetFields(asset.id, { name: value }));
              }}
            />
          </div>

          <div className="field-group">
            <label className="field-label">Icon</label>
            <div className="asset-icon-picker">
              {ASSET_ICON_ORDER.map((k) => (
                <div
                  key={k}
                  className={"asset-icon-option" + (asset.icon === k ? " selected" : "")}
                  title={ASSET_ICON_LABELS[k]}
                  onClick={() => run(() => updateAssetFields(asset.id, { icon: k }))}
                >
                  <AssetIcon icon={k} />
                  <span>{ASSET_ICON_LABELS[k]}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="field-group">
            <label className="field-label">Tag / serial number</label>
            <input
              className="text-input"
              defaultValue={asset.tag ?? ""}
              placeholder="e.g. SN-00231"
              onBlur={(e) => run(() => updateAssetFields(asset.id, { tag: e.target.value.trim() || null }))}
            />
          </div>

          <div className="field-row">
            <div className="field-group" style={{ flex: 1 }}>
              <label className="field-label">Cost rate</label>
              <input
                className="text-input mono"
                type="number"
                min={0}
                step="0.01"
                defaultValue={asset.cost_rate ?? 0}
                onBlur={(e) => run(() => updateAssetFields(asset.id, { cost_rate: e.target.value === "" ? 0 : Number(e.target.value) }))}
              />
            </div>
            <div className="field-group" style={{ flex: 1 }}>
              <label className="field-label">Frequency</label>
              <select
                className="select-input"
                defaultValue={asset.cost_frequency ?? "oneoff"}
                onChange={(e) => run(() => updateAssetFields(asset.id, { cost_frequency: e.target.value }))}
              >
                {COST_FREQUENCIES.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="field-group">
            <label className="field-label">Notes</label>
            <textarea
              className="text-input"
              rows={3}
              defaultValue={asset.notes ?? ""}
              placeholder="Anything worth knowing about this asset"
              onBlur={(e) => run(() => updateAssetFields(asset.id, { notes: e.target.value.trim() || null }))}
            />
          </div>

          <label className="checkbox-row" style={{ marginBottom: 16 }}>
            <input
              type="checkbox"
              defaultChecked={asset.retired}
              onChange={(e) => run(() => updateAssetFields(asset.id, { retired: e.target.checked }))}
            />
            <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>Retired — no longer available to allocate</span>
          </label>

          <div className="divider" />

          {allocTask ? (
            <div className="field-group">
              <label className="field-label">Current allocation</label>
              <div className="crumbline">
                Allocated to {targetTask ? targetTask.task.title : allocTask.title}
                {targetTask && <span style={{ color: "var(--text-faint)" }}> (tracked as &quot;{allocTask.title}&quot;)</span>}
              </div>
            </div>
          ) : (
            <button
              className="primary-btn"
              style={{ width: "100%", padding: 9 }}
              disabled={asset.retired}
              title={asset.retired ? "Un-retire this asset first" : ""}
              onClick={() => setMode("allocate")}
            >
              Allocate this asset
            </button>
          )}

          <button
            className="small-btn"
            style={{ marginTop: 16, display: "inline-flex", alignItems: "center", gap: 6 }}
            disabled={!!everUsed || pending}
            title={everUsed ? "This asset has been allocated before — remove those tasks first" : "Delete this asset"}
            onClick={() => {
              if (confirm(`Delete "${asset.name}"?`)) {
                run(async () => {
                  await deleteAsset(asset.id);
                  onClose();
                });
              }
            }}
          >
            Delete asset
          </button>
        </div>
      </aside>
    </>
  );
}

// The Allocate flow: pick a project with allocations enabled, then either an
// existing task in it (excluding tasks that are themselves allocations) or a
// brand-new one created inline. Ported from renderAllocatePanel().
function AllocatePanel({
  asset,
  projects,
  allRows,
  orgId,
  pending,
  error,
  run,
  onDone,
  onClose,
}: {
  asset: Asset;
  projects: Project[];
  allRows: TaskRow[];
  orgId: string;
  pending: boolean;
  error: string | null;
  run: (action: () => Promise<unknown>) => void;
  onDone: () => void;
  onClose: () => void;
}) {
  const allocatable = projects.filter((p) => p.enable_allocations);
  const [projectId, setProjectId] = useState(allocatable[0]?.id ?? "");
  const [taskMode, setTaskMode] = useState<"existing" | "new">("existing");
  const [taskId, setTaskId] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [enableProjectId, setEnableProjectId] = useState(projects[0]?.id ?? "");

  const effectiveProjectId = allocatable.some((p) => p.id === projectId) ? projectId : allocatable[0]?.id ?? "";
  const candidateTasks = effectiveProjectId
    ? allRows.filter((r) => r.task.project_id === effectiveProjectId && !r.task.asset_id)
    : [];

  function confirm() {
    if (!allocatable.length) return;
    if (taskMode === "new" && !newTitle.trim()) return;
    if (taskMode === "existing" && !taskId) return;
    run(async () => {
      await allocateAsset({
        orgId,
        assetId: asset.id,
        projectId: effectiveProjectId,
        mode: taskMode,
        targetTaskId: taskMode === "existing" ? taskId : undefined,
        newTitle: taskMode === "new" ? newTitle : undefined,
      });
      onDone();
    });
  }

  return (
    <>
      <div className="scrim show" onClick={onClose} />
      <aside className="panel show">
        <div className="panel-head">
          <div style={{ flex: 1, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16 }}>Allocate {asset.name || "asset"}</div>
          <button className="icon-btn panel-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="panel-body">
          {error && <div className="banner" style={{ color: "var(--blocked)", background: "var(--blocked-bg)" }}>{error}</div>}

          {allocatable.length === 0 && (
            <div className="banner">
              No project has allocations enabled yet — pick one below to turn it on, then come back to this screen.
              <div className="add-inline" style={{ marginTop: 8 }}>
                <select className="select-input" value={enableProjectId} onChange={(e) => setEnableProjectId(e.target.value)}>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button
                  className="small-btn"
                  disabled={!enableProjectId || pending}
                  onClick={() => run(() => updateProjectFields(enableProjectId, { enable_allocations: true }))}
                >
                  Enable allocations
                </button>
              </div>
            </div>
          )}

          <div className="field-group">
            <label className="field-label">Project</label>
            <select
              className="select-input"
              value={effectiveProjectId}
              disabled={!allocatable.length}
              onChange={(e) => {
                setProjectId(e.target.value);
                setTaskId("");
              }}
            >
              {allocatable.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div className="field-group">
            <label className="field-label">Link to a schedulable task</label>
            <label className="checkbox-row" style={{ marginBottom: 8 }}>
              <input type="radio" name="alcMode" checked={taskMode === "existing"} onChange={() => setTaskMode("existing")} />
              <span style={{ fontSize: 12.5 }}>Pick an existing task</span>
            </label>
            {taskMode === "existing" && (
              <select className="select-input" value={taskId} onChange={(e) => setTaskId(e.target.value)}>
                <option value="">{candidateTasks.length ? "Select…" : "No eligible tasks in this project"}</option>
                {candidateTasks.map((r) => (
                  <option key={r.task.id} value={r.task.id}>
                    {r.task.title}
                  </option>
                ))}
              </select>
            )}
            <label className="checkbox-row" style={{ marginTop: 8, marginBottom: 8 }}>
              <input type="radio" name="alcMode" checked={taskMode === "new"} onChange={() => setTaskMode("new")} />
              <span style={{ fontSize: 12.5 }}>Create a new task</span>
            </label>
            {taskMode === "new" && (
              <input
                className="text-input"
                placeholder="e.g. Field service visit — site A"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
              />
            )}
          </div>

          <button className="primary-btn" style={{ width: "100%", padding: 9 }} disabled={!allocatable.length || pending} onClick={confirm}>
            Allocate
          </button>
        </div>
      </aside>
    </>
  );
}
