"use client";

import { useEffect, useRef, useState } from "react";
import { fmtDate } from "@/lib/list-view";
import { parseDateOnly, formatDateOnly } from "@/lib/date-only";

// The app's one calendar-picker widget, used everywhere a date gets
// picked — originally built just for the new-subtask dates flow (see
// DateGuideField's own comment below), since a native <input type=date>'s
// own OS picker can't be styled or shaded, and later adopted app-wide for
// visual consistency: every date field in Alloy now opens the same
// popover, styled entirely from this file's own rules in globals.css
// (search "MINI CALENDAR") rather than each browser's native picker
// chrome. `guideStart`/`guideDue` are optional — when both are set (a
// subtask being created or edited under a parent task, currently the only
// case with a natural "valid range" to show), the popover shades that
// range as a visual guide behind the day cells; omitted entirely
// elsewhere, where there's no such range to suggest.
export function MiniCalendarPopover({
  value,
  guideStart = null,
  guideDue = null,
  onSelect,
  onClose,
}: {
  value: string; // "" or yyyy-mm-dd
  guideStart?: string | null;
  guideDue?: string | null;
  onSelect: (iso: string) => void;
  onClose: () => void;
}) {
  const anchor = parseDateOnly(value) ?? parseDateOnly(guideStart ?? "") ?? new Date();
  const [viewYear, setViewYear] = useState(anchor.getUTCFullYear());
  const [viewMonth, setViewMonth] = useState(anchor.getUTCMonth()); // 0-11

  const first = new Date(Date.UTC(viewYear, viewMonth, 1));
  const startWeekday = (first.getUTCDay() + 6) % 7; // Monday-first grid
  const daysInMonth = new Date(Date.UTC(viewYear, viewMonth + 1, 0)).getUTCDate();
  const monthLabel = first.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

  function goMonth(delta: number) {
    let m = viewMonth + delta;
    let y = viewYear;
    if (m < 0) {
      m = 11;
      y -= 1;
    } else if (m > 11) {
      m = 0;
      y += 1;
    }
    setViewMonth(m);
    setViewYear(y);
  }

  function isoFor(day: number): string {
    return formatDateOnly(new Date(Date.UTC(viewYear, viewMonth, day)));
  }
  function inGuideRange(iso: string): boolean {
    return !!guideStart && !!guideDue && iso >= guideStart && iso <= guideDue;
  }

  const cells: (number | null)[] = Array(startWeekday).fill(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  return (
    <div className="mini-calendar-popover" onClick={(e) => e.stopPropagation()}>
      <div className="mini-calendar-head">
        <button type="button" className="mini-calendar-nav" onClick={() => goMonth(-1)} aria-label="Previous month">
          ‹
        </button>
        <span>{monthLabel}</span>
        <button type="button" className="mini-calendar-nav" onClick={() => goMonth(1)} aria-label="Next month">
          ›
        </button>
      </div>
      {guideStart && guideDue && (
        <div className="mini-calendar-guide-note">
          <span className="mini-calendar-guide-swatch" /> Parent: {fmtDate(guideStart)} → {fmtDate(guideDue)}
        </div>
      )}
      <div className="mini-calendar-weekdays">
        {["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div className="mini-calendar-grid">
        {cells.map((day, i) => {
          if (day === null) return <span key={`e${i}`} className="mini-calendar-cell empty" />;
          const iso = isoFor(day);
          return (
            <button
              key={iso}
              type="button"
              className={`mini-calendar-cell ${inGuideRange(iso) ? "guided" : ""} ${iso === value ? "selected" : ""}`}
              onClick={() => {
                onSelect(iso);
                onClose();
              }}
            >
              {day}
            </button>
          );
        })}
      </div>
      <div className="mini-calendar-foot">
        <button
          type="button"
          className="mini-calendar-foot-btn"
          onClick={() => {
            onSelect(formatDateOnly(new Date()));
            onClose();
          }}
        >
          Today
        </button>
        <button
          type="button"
          className="mini-calendar-foot-btn"
          onClick={() => {
            onSelect("");
            onClose();
          }}
        >
          Clear
        </button>
      </div>
    </div>
  );
}

// A date field matching the app's `.date-box` look (bordered box, small
// uppercase label), backed by MiniCalendarPopover instead of a native
// <input type=date> — see that component's own comment for why. Always
// controlled (`value`/`onChange`), so a caller can wire it either to
// commit-immediately semantics (an existing task's own date, matching
// this app's usual onBlur-commits convention but firing on selection
// instead) or to local draft state in a multi-field create form (see
// NewSubtaskForm/the New Task panel). `label` is optional — omitted when
// the field's own label already lives outside it (e.g. a custom field's
// own field-label wraps this), in which case the `.date-box` renders as
// just the trigger button, no separate label line. Closes on an outside
// click, same convention as the Gantt's floating link-menu.
export function DateGuideField({
  label,
  value,
  onChange,
  guideStart = null,
  guideDue = null,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  guideStart?: string | null;
  guideDue?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  return (
    <div className="date-box date-guide-field" ref={containerRef}>
      {label && <span className="date-box-label">{label}</span>}
      <button type="button" className="text-input date-guide-trigger" onClick={() => setOpen((o) => !o)}>
        {value ? fmtDate(value) : "Select date"}
      </button>
      {open && (
        <MiniCalendarPopover value={value} guideStart={guideStart} guideDue={guideDue} onSelect={onChange} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}
