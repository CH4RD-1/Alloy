"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { CustomFieldDef, FormFieldType } from "@/lib/types";
import { createCustomFieldDef, updateCustomFieldDef, deleteCustomFieldDef } from "@/lib/actions";

const FIELD_TYPE_LABEL: Record<FormFieldType, string> = {
  text: "Text",
  paragraph: "Paragraph",
  number: "Number",
  select: "Select",
  yes_no: "Yes/No",
  date: "Date",
};

// Ported from the prototype's "Manage custom fields" panel
// (renderFieldManagerPanel) — a flat, org-wide list of field definitions
// (unlike form templates, these aren't grouped under anything) shown on
// every task's detail panel. The prototype's own manager only offered
// text/number/select/boolean; this offers the fuller 6-type set the schema
// was already built against (see lib/types.ts).
export function CustomFieldsPanel({
  orgId,
  fieldDefs,
  vocabTask,
  onClose,
}: {
  orgId: string;
  fieldDefs: CustomFieldDef[];
  vocabTask: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<FormFieldType>("text");
  const [newOptions, setNewOptions] = useState("");

  const taskNoun = vocabTask.toLowerCase();
  const ordered = [...fieldDefs].sort((a, b) => a.position - b.position);

  function run(action: () => Promise<unknown>) {
    setError(null);
    startTransition(async () => {
      try {
        await action();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      }
    });
  }

  function addField() {
    const name = newName.trim();
    if (!name) return;
    const options =
      newType === "select"
        ? (() => {
            const parsed = newOptions.split(",").map((s) => s.trim()).filter(Boolean);
            return parsed.length ? parsed : ["Option A", "Option B"];
          })()
        : undefined;
    setNewName("");
    setNewOptions("");
    run(() => createCustomFieldDef(orgId, { name, field_type: newType, options }));
  }

  return (
    <>
      <div className="scrim show" onClick={onClose} />
      <aside className="panel show panel-left">
        <div className="panel-head">
          <div style={{ flex: 1, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16 }}>Manage custom fields</div>
          <button className="icon-btn panel-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="panel-body">
          {error && <div className="banner" style={{ color: "var(--blocked)", background: "var(--blocked-bg)" }}>{error}</div>}

          <div className="banner">
            Fields apply across every project and show on every {taskNoun}&apos;s detail panel, right below Tags. Removing one also
            removes any values already saved for it.
          </div>

          <div className="field-group">
            <span className="field-label">Existing fields</span>
            {ordered.length === 0 && <p style={{ color: "var(--text-faint)", fontSize: 12 }}>No custom fields yet.</p>}
            {ordered.map((f) => (
              <FieldDefCard key={f.id} def={f} pending={pending} run={run} />
            ))}
          </div>

          <div className="divider" />

          <div className="field-group">
            <span className="field-label">Add a field</span>
            <div className="field-row" style={{ marginBottom: 8 }}>
              <input
                className="text-input"
                style={{ flex: 2 }}
                placeholder="Field name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && newType !== "select" && addField()}
              />
              <select className="select-input" style={{ flex: 1 }} value={newType} onChange={(e) => setNewType(e.target.value as FormFieldType)}>
                {(Object.keys(FIELD_TYPE_LABEL) as FormFieldType[]).map((t) => (
                  <option key={t} value={t}>
                    {FIELD_TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
            </div>
            {newType === "select" && (
              <input
                className="text-input"
                style={{ marginBottom: 8 }}
                placeholder="Options, comma-separated"
                value={newOptions}
                onChange={(e) => setNewOptions(e.target.value)}
              />
            )}
            <button className="small-btn" disabled={!newName.trim() || pending} onClick={addField}>
              Add field
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

function FieldDefCard({
  def,
  pending,
  run,
}: {
  def: CustomFieldDef;
  pending: boolean;
  run: (action: () => Promise<unknown>) => void;
}) {
  return (
    <div className="field-def-card">
      <div className="field-def-head" style={{ gap: 8 }}>
        <input
          className="text-input"
          style={{ flex: 1 }}
          defaultValue={def.name}
          onBlur={(e) => {
            const value = e.target.value.trim();
            if (value && value !== def.name) run(() => updateCustomFieldDef(def.id, { name: value }));
          }}
        />
        <span className="field-def-type">
          {FIELD_TYPE_LABEL[def.field_type]}
          {def.options ? ` · ${def.options.length} options` : ""}
        </span>
        <button
          className="icon-btn"
          disabled={pending}
          title="Remove field"
          onClick={() => {
            if (confirm(`Delete "${def.name}"? Any values already saved for it will be lost.`)) run(() => deleteCustomFieldDef(def.id));
          }}
        >
          ✕
        </button>
      </div>
      {def.options && def.options.length > 0 && <div className="crumbline">{def.options.join(", ")}</div>}
    </div>
  );
}
