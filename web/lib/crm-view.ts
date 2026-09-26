// Pure, framework-agnostic helpers for the Companies/Deals views — same
// separation-from-the-React-component style as lib/buckets-view.ts and
// lib/assets-view.ts, so the grouping/derivation logic is easy to test/reuse
// without a component tree.

import type { Deal, WorkflowStatus } from "./types";

// Display-only for now — no conversion, matching the prototype's own
// currency selector (see alloy-development-log.md's "Currency selector"
// entry) and the note in alloy-saas-roadmap.md that a Deal is the first
// place currency needs to mean something rather than just relabel the same
// number. A real multi-currency total (Phase D reporting) will need either
// a stored exchange rate or an external rates API — not attempted here.
export const CURRENCIES: { code: string; symbol: string }[] = [
  { code: "USD", symbol: "$" },
  { code: "EUR", symbol: "€" },
  { code: "GBP", symbol: "£" },
  { code: "JPY", symbol: "¥" },
  { code: "AUD", symbol: "A$" },
  { code: "CAD", symbol: "C$" },
  { code: "INR", symbol: "₹" },
  { code: "IDR", symbol: "Rp" },
  { code: "VND", symbol: "₫" },
];

export function currencySymbol(code: string): string {
  return CURRENCIES.find((c) => c.code === code)?.symbol ?? code;
}

export function dealValueLabel(deal: Deal): string {
  if (deal.value === null || deal.value === undefined) return "";
  return `${currencySymbol(deal.currency)}${deal.value.toLocaleString()}`;
}

export type DealOutcome = "open" | "won" | "lost";

// Derived from the deal's current stage rather than a stored column — see
// the Deal interface's own comment in lib/types.ts. A workflow's `key` is
// stable and never exposed to edit in the workflow panel (only label/color
// are), so checking it here is safe the same way other status-specific
// logic in this app already relies on a status's key staying put. Any other
// closed stage a user adds beyond the seeded won/lost (e.g. a custom
// "Won — Upsell") reads as "closed" without a specific outcome — a
// disclosed simplification of this first pass, not a crash.
export function dealOutcome(deal: Deal, statusesById: Map<string, WorkflowStatus>): DealOutcome {
  const status = statusesById.get(deal.status_id);
  if (!status || !status.is_closed) return "open";
  if (status.key === "won") return "won";
  if (status.key === "lost") return "lost";
  return "won"; // closed-but-unspecified defaults to counting as won for pipeline totals, rather than silently vanishing from either bucket
}

export interface DealColumn {
  status: WorkflowStatus;
  deals: Deal[];
}

// Groups deals into kanban columns by their current stage, ordered the same
// way the workflow editor orders any workflow's statuses (position) — same
// shape as buildBucketColumns in lib/buckets-view.ts, but keyed by
// workflow_status rather than by team.
export function buildDealColumns(deals: Deal[], dealStatuses: WorkflowStatus[]): DealColumn[] {
  const ordered = [...dealStatuses].sort((a, b) => a.position - b.position);
  const byStatus = new Map<string, Deal[]>();
  deals.forEach((d) => {
    const list = byStatus.get(d.status_id) ?? [];
    list.push(d);
    byStatus.set(d.status_id, list);
  });
  return ordered.map((status) => ({ status, deals: byStatus.get(status.id) ?? [] }));
}

export function openPipelineValue(deals: Deal[], statusesById: Map<string, WorkflowStatus>): Map<string, number> {
  // Keyed by currency — deals in different currencies can't be summed
  // together without a conversion rate this app doesn't have (see
  // CURRENCIES' own comment above), so this returns one total per currency
  // rather than pretending there's a single meaningful sum.
  const totals = new Map<string, number>();
  deals.forEach((d) => {
    if (dealOutcome(d, statusesById) !== "open" || d.value === null) return;
    totals.set(d.currency, (totals.get(d.currency) ?? 0) + d.value);
  });
  return totals;
}
