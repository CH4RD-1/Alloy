"use client";

import { useMemo, useState } from "react";
import { stripHtml } from "@/lib/kb-view";

export type PortalArticle = { id: string; title: string; body_html: string };

// Small inline icons, same thin-stroke pictogram language as the rest of
// the app's icons (see components/task-list-view.tsx's ChevronIcon).
function ChevronLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  );
}
function ChevronRightIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}
function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  );
}

// Full-view Knowledge base browser for the two customer-facing portal
// pages (the anonymous request form and the per-ticket "come back later"
// magic-link page — see app/portal/[orgSlug]/page.tsx and app/portal/
// ticket/[token]/page.tsx). Replaces what used to be a flat list of
// title+excerpt cards: a search box narrows the list (title or body text,
// case-insensitive substring — this app has no full-text search infra, and
// a portal's article count is small enough that a client-side filter over
// the already-fetched list is plenty), and prev/next arrows page through
// whatever the search currently matches, showing one article's full
// content at a time rather than just an excerpt. Articles arrive already
// fetched server-side (published-only, via each page's own RLS-scoped
// query) — this component only ever reads/filters/pages them, no fetching
// of its own.
export function PortalKb({ articles }: { articles: PortalArticle[] }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return articles;
    return articles.filter((a) => a.title.toLowerCase().includes(q) || stripHtml(a.body_html).toLowerCase().includes(q));
  }, [articles, query]);

  const clampedIndex = filtered.length === 0 ? 0 : Math.min(index, filtered.length - 1);
  const current = filtered[clampedIndex] ?? null;

  function go(delta: number) {
    setIndex((i) => Math.min(filtered.length - 1, Math.max(0, i + delta)));
  }

  return (
    <div className="portal-kb-col">
      <div className="portal-kb-title">Knowledge base</div>

      {articles.length > 0 && (
        <div className="portal-kb-search">
          <SearchIcon />
          <input
            className="text-input"
            placeholder="Search articles…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
          />
        </div>
      )}

      {articles.length === 0 ? (
        <div className="empty-note">No published articles yet.</div>
      ) : !current ? (
        <div className="empty-note">No articles match &ldquo;{query}&rdquo;.</div>
      ) : (
        <div className="portal-kb-article">
          <div className="portal-kb-article-head">
            <div className="portal-kb-article-title" title={current.title}>
              {current.title}
            </div>
            <div className="portal-kb-article-nav">
              <span className="portal-kb-article-count">
                {clampedIndex + 1} / {filtered.length}
              </span>
              <button
                type="button"
                className="icon-btn"
                disabled={clampedIndex === 0}
                onClick={() => go(-1)}
                aria-label="Previous article"
              >
                <ChevronLeftIcon />
              </button>
              <button
                type="button"
                className="icon-btn"
                disabled={clampedIndex === filtered.length - 1}
                onClick={() => go(1)}
                aria-label="Next article"
              >
                <ChevronRightIcon />
              </button>
            </div>
          </div>
          <div className="article-view" dangerouslySetInnerHTML={{ __html: current.body_html || "<p>Empty article</p>" }} />
        </div>
      )}
    </div>
  );
}
