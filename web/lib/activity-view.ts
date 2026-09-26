// Pure, framework-agnostic helpers for the activity/audit log — ported from
// the prototype's logActivity()/activityHtml()/timeAgo()/avatarHtml() (see
// the "Live prototype" link in alloy-development-log.md). Kept separate
// from data-fetching and React, same pattern as list-view.ts/dashboard-
// view.ts.
//
// The write side (inserting a row on task creation or a status move) lives
// in lib/actions.ts as logActivity() — this file is read-side only: turning
// a fetched ActivityLogEntry into display text, resolving who did it, and
// the dashboard's "your recent activity" feed.

import type { ActivityLogEntry, DealActivityLogEntry } from "./types";

// One line of copy per entry, matching the prototype's activityHtml() exactly
// (`'created this task'` / `'moved <from> → <to>'`) — the actor's name is
// rendered separately (bolded) by the caller, same split the prototype's own
// template string made with its `<strong>` tag.
export function activitySummary(entry: ActivityLogEntry, statusLabelById: Map<string, string>): string {
  if (entry.type === "created") return "created this task";
  const from = (entry.from_status_id && statusLabelById.get(entry.from_status_id)) || "—";
  const to = (entry.to_status_id && statusLabelById.get(entry.to_status_id)) || "—";
  return `moved ${from} → ${to}`;
}

// Deal activity's own version of activitySummary above — "moved <from> →
// <to>" is identical, "created" reads "created this deal" instead of "this
// task" since DealActivityLogEntry has no other shape (a deal has no
// stand-in for the Portal-submission path activitySummary's task
// equivalent has to account for).
export function dealActivitySummary(entry: DealActivityLogEntry, statusLabelById: Map<string, string>): string {
  if (entry.type === "created") return "created this deal";
  const from = (entry.from_status_id && statusLabelById.get(entry.from_status_id)) || "—";
  const to = (entry.to_status_id && statusLabelById.get(entry.to_status_id)) || "—";
  return `moved ${from} → ${to}`;
}

// A signed-in member's own action resolves through the org's member list
// (already fetched for every other purpose); an anonymous Portal submission
// resolves through `contactNameById` instead, since a Contact isn't an
// org_member and doesn't appear in `members`. The "Unknown"/"A Portal
// requester" fallbacks only matter if a referenced user or contact row has
// since been deleted (both are ON DELETE SET NULL, not CASCADE, on
// activity_log — the audit entry itself is meant to outlive them).
export function actorDisplayName(
  entry: ActivityLogEntry,
  memberNameById: Map<string, string>,
  contactNameById: Map<string, string>
): string {
  if (entry.actor_user_id) return memberNameById.get(entry.actor_user_id) ?? "Unknown";
  if (entry.actor_contact_id) return contactNameById.get(entry.actor_contact_id) ?? "A Portal requester";
  return "Unknown";
}

// Matches the prototype's own timeAgo() bucketing exactly.
export function timeAgo(iso: string): string {
  const diffSec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}

// The Dashboard's "Your recent activity" feed: entries this specific viewer
// caused, most recent first, capped to 6 — mirrors the prototype's own
// client-side feed (`TASKS.forEach(...); feed.sort(...); feed.slice(0,6)`),
// just built from a server-fetched, already-sorted list instead of scanning
// an in-memory TASKS array. A Portal-attributed entry (actor_contact_id, no
// actor_user_id) never matches a real viewer, matching the prototype, whose
// feed only ever looked at `ui.currentUser`.
export function recentActivityForUser(activityLog: ActivityLogEntry[], currentUserId: string, limit = 6): ActivityLogEntry[] {
  return activityLog.filter((a) => a.actor_user_id === currentUserId).slice(0, limit);
}
