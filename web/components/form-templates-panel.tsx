"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { FormTemplate, FormFieldType, CustomFieldDef } from "@/lib/types";
import {
  createFormTemplate,
  updateFormTemplate,
  deleteFormTemplate,
  addFormField,
  removeFormField,
} from "@/lib/actions";

const FIELD_TYPE_LABEL: Record<FormFieldType, string> = {
  text: "Text",
  paragraph: "Paragraph",
  number: "Number",
  select: "Select",
  yes_no: "Yes/No",
  date: "Date",
};

// Ported from the prototype's "Manage form templates" panel (renderFormsManagerPanel)
// — ghost-btn in the sidebar there, a small-btn next to the view tabs here since this
// port has no sidebar yet. Every template renders fully expanded (name, fields,
// add-field form) rather than a separate drill-down view, matching the prototype.
export function FormTemplatesPanel({
  orgId,
  templates,
  usage,
  vocabTask,
  customFieldDefs,
  onClose,
}: {
  orgId: string;
  templates: FormTemplate[];
  usage: Map<string, number>;
  vocabTask: string;
  customFieldDefs: CustomFieldDef[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);

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

  function createTemplate() {
    const name = newName.trim();
    if (!name) return;
    setNewName("");
    run(() => createFormTemplate(orgId, name));
  }

  return (
    <>
      <div className="scrim show" onClick={onClose} />
      <aside className="panel show panel-left">
        <div className="panel-head">
          <div style={{ flex: 1, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16 }}>Manage form templates</div>
          <button className="icon-btn panel-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="panel-body">
          {error && <div className="banner" style={{ color: "var(--blocked)", background: "var(--blocked-bg)" }}>{error}</div>}

          <div className="banner">
            Build a reusable form once, then let requesters submit one from the Portal to create a new {vocabTask.toLowerCase()}. Toggle
            "Visible on Portal" once it's ready.
          </div>

          <div className="field-group">
            <span className="field-label">Existing templates</span>
            {templates.length === 0 && <p style={{ color: "var(--text-faint)", fontSize: 12 }}>No form templates yet.</p>}
            {templates.map((t) => (
              <TemplateCard
                key={t.id}
                template={t}
                usedCount={usage.get(t.id) ?? 0}
                pending={pending}
                run={run}
                customFieldDefs={customFieldDefs}
              />
            ))}
          </div>

          <div className="divider" />

          <div className="field-group">
            <span className="field-label">Add a template</span>
            <div className="add-inline">
              <input
                className="text-input"
                placeholder="Template name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && createTemplate()}
              />
              <button className="small-btn" disabled={!newName.trim() || pending} onClick={createTemplate}>
                Add template
              </button>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}

function TemplateCard({
  template,
  usedCount,
  pending,
  run,
  customFieldDefs,
}: {
  template: FormTemplate;
  usedCount: number;
  pending: boolean;
  run: (action: () => Promise<unknown>) => void;
  customFieldDefs: CustomFieldDef[];
}) {
  const [fieldLabel, setFieldLabel] = useState("");
  const [fieldType, setFieldType] = useState<FormFieldType>("text");
  const [fieldOptions, setFieldOptions] = useState("");
  const [customFieldId, setCustomFieldId] = useState("");

  // Existing task custom fields (Manage custom fields) not already added to
  // this template — a quick way to reuse a field definition that already
  // exists org-wide instead of retyping its label/type/options by hand.
  // This only copies the definition's shape into a new, independent form
  // field (same as typing it in below) — it doesn't link back to the
  // custom field or its values, since a Portal submission's answers
  // (task_object_forms.values) and a task's own custom_field_values have
  // always been separate systems.
  const usedLabels = new Set(template.fields.map((f) => f.label.trim().toLowerCase()));
  const availableCustomFields = customFieldDefs.filter((d) => !usedLabels.has(d.name.trim().toLowerCase()));

  function addCustomField() {
    const def = customFieldDefs.find((d) => d.id === customFieldId);
    if (!def) return;
    setCustomFieldId("");
    run(() => addFormField(template.id, { label: def.name, type: def.field_type, options: def.options ?? undefined }));
  }

  function addField() {
    const label = fieldLabel.trim();
    if (!label) return;
    const field: { label: string; type: FormFieldType; options?: string[] } = { label, type: fieldType };
    if (fieldType === "select") {
      const options = fieldOptions
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      field.options = options.length ? options : ["Option A", "Option B"];
    }
    setFieldLabel("");
    setFieldOptions("");
    run(() => addFormField(template.id, field));
  }

  const deleteTitle = usedCount
    ? `Used on ${usedCount} attachment${usedCount === 1 ? "" : "s"} — remove those first`
    : "Delete this template";

  return (
    <div className="field-def-card">
      <div className="field-def-head" style={{ gap: 8 }}>
        <input
          className="text-input"
          style={{ flex: 1 }}
          defaultValue={template.name}
          onBlur={(e) => {
            const value = e.target.value.trim();
            if (value && value !== template.name) run(() => updateFormTemplate(template.id, { name: value }));
          }}
        />
        <button
          className="icon-btn"
          disabled={!!usedCount || pending}
          title={deleteTitle}
          onClick={() => {
            if (confirm(`Delete "${template.name}"?`)) run(() => deleteFormTemplate(template.id));
          }}
        >
          ✕
        </button>
      </div>

      <label className="checkbox-row" style={{ margin: "8px 0" }}>
        <input
          type="checkbox"
          defaultChecked={template.portal_visible}
          onChange={(e) => run(() => updateFormTemplate(template.id, { portal_visible: e.target.checked }))}
        />
        <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>Visible on Portal</span>
      </label>

      <div className="crumbline" style={{ marginBottom: 6 }}>
        {template.fields.length} field{template.fields.length === 1 ? "" : "s"}
        {usedCount ? ` · used on ${usedCount} attachment${usedCount === 1 ? "" : "s"}` : ""}
      </div>

      {template.fields.length === 0 ? (
        <div className="crumbline" style={{ marginLeft: 14 }}>
          No fields yet — add one below.
        </div>
      ) : (
        template.fields.map((f) => (
          <div key={f.id} className="field-def-card" style={{ marginLeft: 14 }}>
            <div className="field-def-head">
              <span className="field-def-name">{f.label}</span>
              <span className="field-def-type">
                {FIELD_TYPE_LABEL[f.type]}
                {f.options ? ` · ${f.options.length} options` : ""}
              </span>
              <button className="icon-btn" disabled={pending} onClick={() => run(() => removeFormField(template.id, f.id))} title="Remove field">
                ✕
              </button>
            </div>
            {f.options && <div className="crumbline">{f.options.join(", ")}</div>}
          </div>
        ))
      )}

      <div className="add-inline" style={{ marginTop: 8, marginLeft: 14 }}>
        <input
          className="text-input"
          placeholder="Field label"
          style={{ flex: 2 }}
          value={fieldLabel}
          onChange={(e) => setFieldLabel(e.target.value)}
        />
        <select className="select-input" style={{ flex: 1 }} value={fieldType} onChange={(e) => setFieldType(e.target.value as FormFieldType)}>
          {(Object.keys(FIELD_TYPE_LABEL) as FormFieldType[]).map((t) => (
            <option key={t} value={t}>
              {FIELD_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </div>
      {fieldType === "select" && (
        <input
          className="text-input"
          placeholder="Options, comma-separated"
          style={{ margin: "8px 0 8px 14px", width: "calc(100% - 14px)" }}
          value={fieldOptions}
          onChange={(e) => setFieldOptions(e.target.value)}
        />
      )}
      <button className="small-btn" style={{ marginLeft: 14, marginTop: fieldType === "select" ? 0 : 8 }} disabled={!fieldLabel.trim() || pending} onClick={addField}>
        Add field
      </button>

      <div className="add-inline" style={{ marginTop: 10, marginLeft: 14 }}>
        <select
          className="select-input"
          value={customFieldId}
          onChange={(e) => setCustomFieldId(e.target.value)}
          disabled={availableCustomFields.length === 0}
        >
          <option value="">{availableCustomFields.length === 0 ? "No custom fields to add" : "Custom Fields"}</option>
          {availableCustomFields.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} ({FIELD_TYPE_LABEL[d.field_type]})
            </option>
          ))}
        </select>
      </div>
      <button className="small-btn" style={{ marginLeft: 14, marginTop: 8 }} disabled={!customFieldId || pending} onClick={addCustomField}>
        Add Custom field
      </button>
    </div>
  );
}
