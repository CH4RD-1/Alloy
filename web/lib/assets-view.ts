// Pure, framework-agnostic helpers for the Assets view — ported from the
// Alloy prototype's ASSETS section (renderAssetsView/renderAssetPanel,
// assetDisplayStatus, costLabel — see the "Live prototype" link in
// alloy-development-log.md). Kept separate from data-fetching and React,
// same pattern as list-view.ts/gantt-schedule.ts.

import type { Task, TaskLink, WorkflowStatus, Asset } from "./types";

// A fixed preset gallery rather than photos — generic line icons keep every
// asset card visually consistent regardless of what real inventory photos a
// production version might use later. Order/labels/keys match the prototype's
// ASSET_ICON_ORDER/ASSET_ICON_LABELS exactly (see components/asset-icon.tsx
// for the actual SVGs).
export const ASSET_ICON_ORDER = [
  "laptop",
  "desktop",
  "monitor",
  "phone",
  "keyboard",
  "mouse",
  "toolbox",
  "hardhat",
  "boots",
  "trousers",
  "other",
] as const;

export type AssetIconKey = (typeof ASSET_ICON_ORDER)[number];

export const ASSET_ICON_LABELS: Record<AssetIconKey, string> = {
  laptop: "Laptop",
  desktop: "Desktop PC",
  monitor: "Monitor",
  phone: "Phone",
  keyboard: "Keyboard",
  mouse: "Mouse",
  toolbox: "Toolbox",
  hardhat: "Hard hat",
  boots: "Boots",
  trousers: "Trousers",
  other: "Other",
};

// Cost recurs at one of these cadences, or is a single one-off charge.
export const COST_FREQUENCIES: { id: string; label: string }[] = [
  { id: "hour", label: "Per hour" },
  { id: "day", label: "Per day" },
  { id: "week", label: "Per week" },
  { id: "month", label: "Per month" },
  { id: "year", label: "Per year" },
  { id: "oneoff", label: "One-off" },
];

// "$45 / day" style label — e.g. "$0 / one-off" when nothing's been costed
// yet. No currency is stored on the asset itself (prototype-scope), so this
// always uses $, matching the prototype.
export function costLabel(asset: Asset): string {
  const freq = COST_FREQUENCIES.find((f) => f.id === asset.cost_frequency);
  const suffix = asset.cost_frequency === "oneoff" ? "one-off" : "/ " + (freq ? freq.label.replace(/^Per /, "") : asset.cost_frequency ?? "");
  return "$" + Number(asset.cost_rate || 0).toLocaleString() + " " + suffix;
}

// The allocation task (if any) currently "holding" this asset — a task of
// kind 'asset_allocation' whose asset_id matches and whose status isn't the
// asset workflow's own closed/"Available"-equivalent one. At most one active
// allocation per asset is enforced by the allocate flow itself, so this is
// always at most one task. Uses is_closed rather than key !== "done" — the
// Assets workflow's own closed status is keyed "available", not "done" (see
// schema.sql's own comment on workflow_statuses.is_closed for why this is
// the generic signal every workflow's terminal status uses).
export function activeAllocationTask(assetId: string, tasks: Task[], statuses: WorkflowStatus[]): Task | null {
  const statusById = new Map(statuses.map((s) => [s.id, s]));
  return (
    tasks.find((t) => t.kind === "asset_allocation" && t.asset_id === assetId && !statusById.get(t.status_id)?.is_closed) ?? null
  );
}

export type AssetDisplayStatus = "available" | "allocated" | "retired";

// Available/Allocated/Retired is deliberately NOT a stored field (besides
// `retired`) — Allocated is derived live from whether a live allocation task
// exists, so the two can never drift apart. Matches assetDisplayStatus() in
// the prototype.
export function assetDisplayStatus(asset: Asset, tasks: Task[], statuses: WorkflowStatus[]): AssetDisplayStatus {
  if (asset.retired) return "retired";
  return activeAllocationTask(asset.id, tasks, statuses) ? "allocated" : "available";
}

export function assetStatusLabel(status: AssetDisplayStatus): string {
  return status === "retired" ? "Retired" : status === "allocated" ? "Allocated" : "Available";
}

// The real schedulable task an allocation task is clone-linked to — what's
// actually useful to show on the asset panel, since the allocation task's
// own title is always the generic "Asset allocation: <name>".
export function cloneTargetTaskId(allocTaskId: string, links: TaskLink[]): string | null {
  return links.find((l) => l.from_task_id === allocTaskId && l.link_type === "clone")?.to_task_id ?? null;
}
