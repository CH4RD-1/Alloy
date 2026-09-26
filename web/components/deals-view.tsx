"use client";

import { useRef, useState, type DragEvent } from "react";
import type { Deal, Company, WorkflowStatus } from "@/lib/types";
import type { MemberSummary } from "@/lib/tasks-data";
import { buildDealColumns, dealValueLabel } from "@/lib/crm-view";
import { createDeal, updateDealStage } from "@/lib/actions";

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
  const [draggingDealId, setDraggingDealId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const companiesById = new Map(companies.map((c) => [c.id, c]));
  const ownerNameById = new Map(members.map((m) => [m.userId, m.name]));

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
      await updateDealStage(dealId, statusId);
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
        <button className="small-btn" disabled={creating || !dealWorkflowId} onClick={newDeal}>
          + New deal
        </button>
      </div>
      {error && <div className="banner">{error}</div>}
      {loaded && !dealWorkflowId ? (
        <div className="empty-note">
          No Deal Pipeline workflow found for this org yet — run the crm_phase_a.sql patch against the database, then reload.
        </div>
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
