"use client";

import { useMemo, useRef, useState, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import type { Deal, Company, WorkflowStatus } from "@/lib/types";
import type { MemberSummary } from "@/lib/tasks-data";
import { buildDealColumns, dealValueLabel } from "@/lib/crm-view";
import { createDeal, updateDealStage } from "@/lib/actions";
import { StatusChip } from "@/components/task-list-view";

// CRM Phase A — a kanban of deal stages, structurally a straight copy of
// components/buckets-view.tsx's own column/drag machinery (drag payload =
// id as plain text, click-drag panning on blank column space) with stage
// columns in place of team columns and a deal card in place of a task tile.
// Unlike Buckets, this view owns and fetches its own data (see
// TasksWorkspace's companies/deals state and lib/actions.ts's own comment
// on getDealsData) rather than deriving columns from server-rendered
// WorkspaceData props.
const DRAG_MIME = "text/plain";

function disableTextSelection() {
  document.body.style.userSelect = "none";
}
function restoreTextSelection() {
  document.body.style.userSelect = "";
}

function DealCard({
  deal,
  company,
  ownerName,
  dragging,
  onDragStart,
  onDragEnd,
  onSelect,
}: {
  deal: Deal;
  company: Company | undefined;
  ownerName: string | undefined;
  dragging: boolean;
  onDragStart: (e: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onSelect: () => void;
}) {
  return (
    <div className={`tile ${dragging ? "dragging" : ""}`} draggable onDragStart={onDragStart} onDragEnd={onDragEnd} onClick={onSelect}>
      <div className="tile-title">{deal.title}</div>
      <div className="tile-meta">
        {company && <span className="crumbline">{company.name}</span>}
      </div>
      <div className="tile-meta">
        <span className="mono">{dealValueLabel(deal)}</span>
        {ownerName && <span className="assignee-name">{ownerName}</span>}
      </div>
    </div>
  );
}

function DealColumnView({
  status,
  deals,
  companiesById,
  ownerNameById,
  draggingDealId,
  onDragStartDeal,
  onDragEndDeal,
  onDropDeal,
  onSelectDeal,
}: {
  status: WorkflowStatus;
  deals: Deal[];
  companiesById: Map<string, Company>;
  ownerNameById: Map<string, string>;
  draggingDealId: string | null;
  onDragStartDeal: (e: DragEvent<HTMLDivElement>, dealId: string) => void;
  onDragEndDeal: () => void;
  onDropDeal: (dealId: string, statusId: string) => void;
  onSelectDeal: (id: string) => void;
}) {
  const [hover, setHover] = useState(false);
  const total = deals.reduce((sum, d) => sum + (d.value ?? 0), 0);

  return (
    <div
      className={`bucket-col ${hover ? "drop-hover" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setHover(true);
      }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setHover(false);
        const dealId = e.dataTransfer.getData(DRAG_MIME);
        if (dealId) onDropDeal(dealId, status.id);
      }}
    >
      <div className="bucket-head">
        <span className="team-swatch" style={{ background: status.color }} />
        <span className="bucket-title">{status.label}</span>
        <span className="bucket-count">{deals.length}</span>
      </div>
      <div className="bucket-body">
        {deals.length === 0 && <div className="bucket-empty">Drop a deal here</div>}
        {deals.map((d) => (
          <DealCard
            key={d.id}
            deal={d}
            company={d.company_id ? companiesById.get(d.company_id) : undefined}
            ownerName={d.owner_user_id ? ownerNameById.get(d.owner_user_id) : undefined}
            dragging={draggingDealId === d.id}
            onDragStart={(e) => onDragStartDeal(e, d.id)}
            onDragEnd={onDragEndDeal}
            onSelect={() => onSelectDeal(d.id)}
          />
        ))}
      </div>
    </div>
  );
}

// A Phase A/B leftover: the kanban board above is great for working a
// pipeline stage by stage, but bad at "show me everything, sorted by
// value/close date" — the plain sortable table the prototype's other
// entities all got via List (see task-list-view.tsx). Reuses that same
// visual language (StatusChip, a bordered/rounded table shell) with its own
// column set and grid (see .deals-list-* in globals.css) rather than trying
// to fit a deal's fields into TaskListView's task-shaped columns.
type DealSortKey = "title" | "value" | "close" | "updated";

function DealListRow({
  deal,
  company,
  status,
  ownerName,
  onSelect,
}: {
  deal: Deal;
  company: Company | undefined;
  status: WorkflowStatus | undefined;
  ownerName: string | undefined;
  onSelect: () => void;
}) {
  return (
    <div className="deals-list-row" onClick={onSelect}>
      <div className="row-title" title={deal.title}>
        {deal.title}
      </div>
      <div className="cell-dates">{company?.name ?? "—"}</div>
      <div>
        {status ? <StatusChip statusKey={status.key} label={status.label} color={status.color} /> : "—"}
      </div>
      <div className="mono">{dealValueLabel(deal) || "—"}</div>
      <div className="cell-dates">{ownerName ?? "Unassigned"}</div>
      <div className="cell-dates">{deal.expected_close_date ?? "—"}</div>
    </div>
  );
}

function DealsListView({
  deals,
  companiesById,
  statusesById,
  ownerNameById,
  onSelectDeal,
}: {
  deals: Deal[];
  companiesById: Map<string, Company>;
  statusesById: Map<string, WorkflowStatus>;
  ownerNameById: Map<string, string>;
  onSelectDeal: (id: string) => void;
}) {
  const [sortKey, setSortKey] = useState<DealSortKey>("updated");

  const sorted = useMemo(() => {
    const copy = [...deals];
    switch (sortKey) {
      case "title":
        return copy.sort((a, b) => a.title.localeCompare(b.title));
      case "value":
        return copy.sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
      case "close":
        // Deals with no expected_close_date sort last, not first, so an
        // unscheduled deal never crowds out the ones that actually need
        // attention soon.
        return copy.sort((a, b) => (a.expected_close_date ?? "9999-99-99").localeCompare(b.expected_close_date ?? "9999-99-99"));
      case "updated":
      default:
        return copy.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    }
  }, [deals, sortKey]);

  return (
    <div className="deals-list-table">
      <div className="deals-list-head">
        <button type="button" className="list-head-sort" onClick={() => setSortKey("title")}>
          Deal
        </button>
        <div>Company</div>
        <div>Stage</div>
        <button type="button" className="list-head-sort" onClick={() => setSortKey("value")}>
          Value
        </button>
        <div>Owner</div>
        <button type="button" className="list-head-sort" onClick={() => setSortKey("close")}>
          Close date
        </button>
      </div>
      {sorted.length === 0 && <div className="empty-note">No deals match.</div>}
      {sorted.map((d) => (
        <DealListRow
          key={d.id}
          deal={d}
          company={d.company_id ? companiesById.get(d.company_id) : undefined}
          status={statusesById.get(d.status_id)}
          ownerName={d.owner_user_id ? ownerNameById.get(d.owner_user_id) : undefined}
          onSelect={() => onSelectDeal(d.id)}
        />
      ))}
    </div>
  );
}

export function DealsView({
  orgId,
  deals,
  setDeals,
  companies,
  members,
  dealStatuses,
  dealWorkflowId,
  loaded,
  search,
  onSelectDeal,
}: {
  orgId: string;
  deals: Deal[];
  setDeals: (updater: (prev: Deal[]) => Deal[]) => void;
  companies: Company[];
  members: MemberSummary[];
  dealStatuses: WorkflowStatus[];
  dealWorkflowId: string | null;
  loaded: boolean;
  search: string;
  onSelectDeal: (id: string) => void;
}) {
  const router = useRouter();
  const [viewMode, setViewMode] = useState<"board" | "list">("board");
  const [draggingDealId, setDraggingDealId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const companiesById = new Map(companies.map((c) => [c.id, c]));
  const ownerNameById = new Map(members.map((m) => [m.userId, m.name]));
  const statusesById = new Map(dealStatuses.map((s) => [s.id, s]));

  const q = search.trim().toLowerCase();
  const filteredDeals = q ? deals.filter((d) => d.title.toLowerCase().includes(q)) : deals;
  const columns = buildDealColumns(filteredDeals, dealStatuses);

  function handlePanMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    if ((e.target as Element).closest(".tile")) return;
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    e.preventDefault();
    const startX = e.clientX;
    const startScrollLeft = scrollEl.scrollLeft;
    scrollEl.classList.add("panning");
    disableTextSelection();
    function onMove(ev: MouseEvent) {
      scrollEl!.scrollLeft = startScrollLeft - (ev.clientX - startX);
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      scrollEl!.classList.remove("panning");
      restoreTextSelection();
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  async function handleDrop(dealId: string, statusId: string) {
    setDraggingDealId(null);
    setError(null);
    const previous = deals.find((d) => d.id === dealId)?.status_id;
    if (previous === statusId) return;
    setDeals((prev) => prev.map((d) => (d.id === dealId ? { ...d, status_id: statusId } : d)));
    try {
      // A configured transition automation (see the Workflow & roles
      // editor's Automations section) can create/move/reassign tasks —
      // affectedTasks tells us to fall back to a full refresh so the Tasks
      // side picks that up, since it doesn't hold its own local state yet.
      // A move with no automation attached (the common case) never pays
      // this cost.
      const { affectedTasks } = await updateDealStage(dealId, statusId);
      if (affectedTasks) router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't move that deal.");
      if (previous) setDeals((prev) => prev.map((d) => (d.id === dealId ? { ...d, status_id: previous } : d)));
    }
  }

  async function newDeal() {
    if (!dealWorkflowId || dealStatuses.length === 0) return;
    setCreating(true);
    setError(null);
    try {
      const created = await createDeal(orgId, { title: "Untitled deal", workflowId: dealWorkflowId, statusId: dealStatuses[0].id });
      setDeals((prev) => [created, ...prev]);
      onSelectDeal(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create that deal.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <div className="view-head">
        <div>
          <div className="view-title">Deals</div>
          <div className="view-sub">{loaded ? `${deals.length} deal${deals.length === 1 ? "" : "s"}` : "Loading…"}</div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {/* Board vs. List — same .view-tabs pattern the Tasks workspace's
              own List/Buckets/Gantt switcher uses (app-sidebar.tsx), just
              scoped locally: Deals owns its own small tab set rather than a
              whole ViewKey entry, since it's one self-contained component
              with its own data (see this file's own header comment). Board
              stays the default — it's the one you work a pipeline from day
              to day — List is for scanning/sorting the whole set at once. */}
          <div className="view-tabs" style={{ margin: 0 }}>
            <button type="button" className={`view-tab ${viewMode === "board" ? "active" : ""}`} onClick={() => setViewMode("board")}>
              Board
            </button>
            <button type="button" className={`view-tab ${viewMode === "list" ? "active" : ""}`} onClick={() => setViewMode("list")}>
              List
            </button>
          </div>
          <button className="small-btn" disabled={creating || !dealWorkflowId} onClick={newDeal}>
            + New deal
          </button>
        </div>
      </div>
      {error && <div className="banner">{error}</div>}
      {loaded && !dealWorkflowId ? (
        <div className="empty-note">
          No Deal Pipeline workflow found for this org yet — run the crm_phase_a.sql patch against the database, then reload.
        </div>
      ) : viewMode === "list" ? (
        <DealsListView
          deals={filteredDeals}
          companiesById={companiesById}
          statusesById={statusesById}
          ownerNameById={ownerNameById}
          onSelectDeal={onSelectDeal}
        />
      ) : (
        <div className="buckets-scroll" ref={scrollRef} onMouseDown={handlePanMouseDown}>
          <div className="buckets-row">
            {columns.map((col) => (
              <DealColumnView
                key={col.status.id}
                status={col.status}
                deals={col.deals}
                companiesById={companiesById}
                ownerNameById={ownerNameById}
                draggingDealId={draggingDealId}
                onDragStartDeal={(e, dealId) => {
                  e.dataTransfer.setData(DRAG_MIME, dealId);
                  e.dataTransfer.effectAllowed = "move";
                  setDraggingDealId(dealId);
                }}
                onDragEndDeal={() => setDraggingDealId(null)}
                onDropDeal={handleDrop}
                onSelectDeal={onSelectDeal}
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
}
