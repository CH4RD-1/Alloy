"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Doc } from "@/lib/types";
import { stripHtml } from "@/lib/kb-view";
import { createDoc } from "@/lib/actions";

function DocIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

export function KBView({
  docs,
  taskIdsByDoc,
  orgId,
  search,
  onSelectDoc,
}: {
  docs: Doc[];
  taskIdsByDoc: Map<string, string[]>;
  orgId: string;
  search: string;
  onSelectDoc: (id: string) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const q = search.trim().toLowerCase();
  const filtered = q ? docs.filter((d) => (d.title + " " + stripHtml(d.body_html)).toLowerCase().includes(q)) : docs;

  function newDoc() {
    startTransition(async () => {
      const id = await createDoc(orgId);
      router.refresh();
      onSelectDoc(id);
    });
  }

  return (
    <>
      <div className="view-head">
        <div>
          <div className="view-title">Knowledge base</div>
          <div className="view-sub">
            {docs.length} article{docs.length === 1 ? "" : "s"} · publish any to show it on the Portal
          </div>
        </div>
        <button className="small-btn" disabled={pending} onClick={newDoc}>
          + New article
        </button>
      </div>
      <div className="kb-grid">
        {filtered.length === 0 && (
          <div className="empty-note">{docs.length === 0 ? "No articles yet." : "No articles match your search."}</div>
        )}
        {filtered.map((d) => {
          const linkedCount = taskIdsByDoc.get(d.id)?.length ?? 0;
          const preview = stripHtml(d.body_html);
          return (
            <div key={d.id} className="doc-card" onClick={() => onSelectDoc(d.id)}>
              <div className="doc-icon">
                <DocIcon />
              </div>
              <div className="doc-title">{d.title}</div>
              <div className="doc-desc">{preview || "Empty article"}</div>
              <div className="doc-foot">
                <span style={{ display: "flex", gap: 6 }}>
                  {d.published && (
                    <span className="chip tag-chip" style={{ color: "var(--done)", background: "var(--done-bg)" }}>
                      Published
                    </span>
                  )}
                </span>
                <span>
                  {linkedCount} linked task{linkedCount === 1 ? "" : "s"}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
