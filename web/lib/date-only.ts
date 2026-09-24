// Date-only ("YYYY-MM-DD", as produced by <input type="date"> and by
// DateGuideField/MiniCalendarPopover — see components/date-guide-field.tsx)
// helpers shared by every date/duration field in the app: the task panel's
// own Dates field-group and its Duration box, the new-subtask form, the
// New Task panel, and anywhere else a plain calendar date needs parsing,
// formatting, or duration arithmetic. Parsed/formatted via Date.UTC so
// local-timezone offsets never shift the day by one.
export function parseDateOnly(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

export function formatDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Duration = number of days between start and due (due - start), so a
// same-day task has a duration of 0.
export function taskDurationDays(start: string | null | undefined, due: string | null | undefined): number | null {
  const s = start ? parseDateOnly(start) : null;
  const e = due ? parseDateOnly(due) : null;
  if (!s || !e) return null;
  const days = Math.round((e.getTime() - s.getTime()) / 86400000);
  return days >= 0 ? days : null;
}

// Duration box units (see DurationField in task-panel.tsx, and
// NewSubtaskForm's own duration box) — hours/weeks/months/years all
// resolve to a whole number of days added to start_date, since
// start_date/due_date are date-only columns with no time component.
// Months/years use real calendar arithmetic (setUTCMonth/setUTCFullYear)
// rather than a flat *30/*365 multiply, so "1 month" from Jan 31 lands on
// Feb 28 the way a calendar would, not 30 days later.
export type DurationUnit = "hours" | "days" | "weeks" | "months" | "years";
export const DURATION_UNITS: { value: DurationUnit; label: string }[] = [
  { value: "hours", label: "Hours" },
  { value: "days", label: "Days" },
  { value: "weeks", label: "Weeks" },
  { value: "months", label: "Months" },
  { value: "years", label: "Years" },
];
export function addDurationToDate(start: string, amount: number, unit: DurationUnit): string {
  const s = parseDateOnly(start);
  if (!s) return start;
  switch (unit) {
    case "hours":
      // Date-only storage can't represent partial days — round to the
      // nearest whole day (so e.g. 4 hours stays same-day, 20 hours
      // becomes +1 day) rather than always rounding up or down.
      s.setUTCDate(s.getUTCDate() + Math.round(amount / 24));
      break;
    case "days":
      s.setUTCDate(s.getUTCDate() + Math.round(amount));
      break;
    case "weeks":
      s.setUTCDate(s.getUTCDate() + Math.round(amount * 7));
      break;
    case "months":
      s.setUTCMonth(s.getUTCMonth() + Math.round(amount));
      break;
    case "years":
      s.setUTCFullYear(s.getUTCFullYear() + Math.round(amount));
      break;
  }
  return formatDateOnly(s);
}
