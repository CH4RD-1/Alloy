"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Asset, Task, WorkflowStatus, Project } from "@/lib/types";
import { assetDisplayStatus, assetStatusLabel, costLabel } from "@/lib/assets-view";
import { AssetIcon } from "@/components/asset-icon";
import { createAsset } from "@/lib/actions";

// Ported from the prototype's renderAssetsView() — a grid of asset cards
// (icon, tag/serial, status chip, cost line), same "+ New" pattern as the
// Knowledge base's article grid.
export function AssetsView({
  assets,
  tasks,
  statuses,
  projects,
  orgId,
  search,
  onSelectAsset,
}: {
  assets: Asset[];
  tasks: Task[];
  statuses: WorkflowStatus[];
  projects: Project[];
  orgId: string;
  search: string;
  onSelectAsset: (id: string) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const q = search.trim().toLowerCase();
  const filtered = q ? assets.filter((a) => (a.name + " " + (a.tag ?? "")).toLowerCase().includes(q)) : assets;

  const allocatableCount = projects.filter((p) => p.enable_allocations).length;

  function newAsset() {
    startTransition(async () => {
      const id = await createAsset(orgId);
      router.refresh();
      onSelectAsset(id);
    });
  }

  return (
    <>
      <div className="view-head">
        <div>
          <div className="view-title">Assets</div>
          <div className="view-sub">
            {assets.length} asset{assets.length === 1 ? "" : "s"} · allocate one to a schedulable task to track who has it
            {allocatableCount === 0 && " · enable allocations on a project from an asset's Allocate screen before allocating"}
          </div>
        </div>
        <button className="small-btn" disabled={pending} onClick={newAsset}>
          + New asset
        </button>
      </div>
      <div className="assets-grid">
        {filtered.length === 0 && (
          <div className="empty-note">{assets.length === 0 ? "No assets yet." : "No assets match your search."}</div>
        )}
        {filtered.map((a) => {
          const status = assetDisplayStatus(a, tasks, statuses);
          const cls = status === "retired" ? "asset-chip-retired" : status === "allocated" ? "asset-chip-allocated" : "asset-chip-available";
          return (
            <div key={a.id} className={"asset-card" + (a.retired ? " is-retired" : "")} onClick={() => onSelectAsset(a.id)}>
              <div className="asset-icon-box">
                <AssetIcon icon={a.icon} />
              </div>
              <div className="asset-card-title">{a.name}</div>
              {a.tag && <div className="asset-card-tag">{a.tag}</div>}
              <span className={"asset-status-chip " + cls}>{assetStatusLabel(status)}</span>
              <div className="crumbline">{costLabel(a)}</div>
            </div>
          );
        })}
      </div>
    </>
  );
}
