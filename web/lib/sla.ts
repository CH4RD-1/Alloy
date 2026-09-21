// SLA (Service Level Agreement) time math for Helpdesk tickets — pure,
// framework-agnostic helpers, same split as lib/assets-view.ts (logic here,
// the live-ticking <SlaTimer> component in components/task-panel.tsx).
//
// Two targets per org (see schema.sql's own comment on orgs.
// sla_first_response_hours/sla_resolution_days and components/
// sla-settings-panel.tsx): "time to first response" counts in *working*
// hours, "time to resolution" counts in plain calendar days. Disclosed
// simplification: business hours are a fixed Mon-Fri 09:00-17:00 UTC
// window — there's no per-org timezone setting yet, so every org's
// countdown currently uses the same UTC 9-to-5 regardless of where its
// team actually sits. Swapping in a real per-org timezone later only
// touches this file.

const BUSINESS_START_HOUR = 9;
const BUSINESS_END_HOUR = 17;

function isWeekend(d: Date): boolean {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

// Advances `from` to the next moment inside a Mon-Fri 09:00-17:00 UTC
// window — a no-op if `from` is already inside one (e.g. a ticket raised at
// 2pm on a Tuesday starts its business-hours clock right then, not at the
// next day's 9am).
function snapToBusinessWindow(from: Date): Date {
  const d = new Date(from.getTime());
  // Bounded loop: at most one weekend (2 days) plus one end-of-day rollover
  // can ever fire before landing inside a window, but a hard cap keeps this
  // provably terminating rather than trusting that reasoning alone.
  for (let guard = 0; guard < 10; guard++) {
    if (isWeekend(d)) {
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(BUSINESS_START_HOUR, 0, 0, 0);
      continue;
    }
    const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
    if (hour < BUSINESS_START_HOUR) {
      d.setUTCHours(BUSINESS_START_HOUR, 0, 0, 0);
      return d;
    }
    if (hour >= BUSINESS_END_HOUR) {
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(BUSINESS_START_HOUR, 0, 0, 0);
      continue;
    }
    return d;
  }
  return d;
}

// Adds `hours` of *business* time to `start` — walks forward one business
// day (8 hours, 09:00-17:00) at a time, skipping weekends entirely, then
// applies the remainder. E.g. 24 working hours from a Friday 3pm lands the
// following Wednesday 3pm (2h left Friday, 8h Mon, 8h Tue, 6h Wed = 24h).
export function addBusinessHours(start: Date, hours: number): Date {
  let cursor = snapToBusinessWindow(start);
  let remaining = hours;
  let guard = 0;
  while (remaining > 1e-9 && guard < 1000) {
    guard++;
    const hoursLeftToday = BUSINESS_END_HOUR - (cursor.getUTCHours() + cursor.getUTCMinutes() / 60);
    const take = Math.min(remaining, hoursLeftToday);
    cursor = new Date(cursor.getTime() + take * 3_600_000);
    remaining -= take;
    if (remaining > 1e-9) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(BUSINESS_START_HOUR, 0, 0, 0);
      cursor = snapToBusinessWindow(cursor);
    }
  }
  return cursor;
}

export function firstResponseTarget(createdAt: string, workingHours: number): Date {
  return addBusinessHours(new Date(createdAt), workingHours);
}

// Plain calendar arithmetic — no business-hours logic, matching "2 weeks"
// being a straightforward duration rather than a working-time target.
export function resolutionTarget(createdAt: string, days: number): Date {
  return new Date(new Date(createdAt).getTime() + days * 24 * 3_600_000);
}

// "13d 22h 41m" / "23h 58m" / "42m" — drops the coarser unit once it's zero
// rather than always showing all three, so a near-due countdown doesn't
// read as "0d 0h 42m". `ms` is expected non-negative; callers pass the
// absolute value for an overdue duration themselves (see SlaTimer).
export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
