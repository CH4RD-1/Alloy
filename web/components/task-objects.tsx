"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import type { TaskObject, ChecklistItem, TaskObjectFile, TaskObjectForm, FormTemplate } from "@/lib/types";
import {
  createTaskObject,
  createFileTaskObject,
  saveSketchImage,
  saveSketchAsImage,
  updateNoteText,
  updateCodeBlock,
  deleteTaskObject,
  addChecklistItem,
  updateChecklistItem,
  removeChecklistItem,
  createFormTaskObject,
  updateTaskObjectFormValues,
} from "@/lib/actions";
import { CODE_LANGUAGES, highlightCode } from "@/lib/code-highlight";
import { DateGuideField } from "@/components/date-guide-field";
import { SketchCanvas } from "@/components/sketch-canvas";

type FileWithUrl = TaskObjectFile & { url: string | null };

// Task-panel "Attachments" — ported from the prototype's obj-card / obj-menu
// system. Text notes and checklists were the first two kinds ported (they
// need no file storage); a later pass added real Supabase Storage-backed
// file uploads and a canvas sketch pad. This pass adds "form" — a picked
// form_templates row filled in from the task panel (FormCard below), the
// staff-side twin of submitPortalRequest's own auto-created "form" object.
export function TaskObjects({
  taskId,
  orgId,
  objects,
  checklistItemsByObject,
  taskObjectFileByObjectId,
  taskObjectFormByObjectId,
  formTemplates,
}: {
  taskId: string;
  orgId: string;
  objects: TaskObject[];
  checklistItemsByObject: Map<string, ChecklistItem[]>;
  taskObjectFileByObjectId: Map<string, FileWithUrl>;
  taskObjectFormByObjectId: Map<string, TaskObjectForm>;
  formTemplates: FormTemplate[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [menuOpen, setMenuOpen] = useState(false);
  const [formMenuOpen, setFormMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewingImage, setViewingImage] = useState<{ src: string; name: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  function addObject(kind: "note" | "checklist" | "sketch" | "code") {
    setMenuOpen(false);
    setFormMenuOpen(false);
    run(() => createTaskObject(orgId, taskId, kind));
  }

  function addForm(templateId: string) {
    setMenuOpen(false);
    setFormMenuOpen(false);
    run(() => createFormTaskObject(orgId, taskId, templateId));
  }

  function triggerFileUpload() {
    setMenuOpen(false);
    setFormMenuOpen(false);
    fileInputRef.current?.click();
  }

  // Matches the prototype's own objFileInput handler: a 4MB cap checked
  // client-side first (for immediate feedback, same wording as the
  // prototype's error), with createFileTaskObject enforcing the same limit
  // server-side as the real guard.
  function handleFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      setError("That file is over 4MB — please choose something smaller.");
      return;
    }
    const formData = new FormData();
    formData.append("file", file);
    run(() => createFileTaskObject(orgId, taskId, formData));
  }

  return (
    <div className="field-group">
      <span className="field-label">Attachments</span>
      {error && (
        <div className="banner" style={{ color: "var(--blocked)", background: "var(--blocked-bg)" }}>
          {error}
        </div>
      )}
      <input ref={fileInputRef} type="file" style={{ display: "none" }} onChange={handleFileSelected} />
      {objects.length === 0 ? (
        <p style={{ color: "var(--text-faint)", fontSize: 12 }}>Add a text note, file, sketch, code block, or checklist.</p>
      ) : (
        <div className="obj-list">
          {objects.map((o) => {
            if (o.kind === "note") {
              return (
                <NoteCard
                  key={o.id}
                  obj={o}
                  pending={pending}
                  onChange={(text) => run(() => updateNoteText(o.id, text))}
                  onRemove={() => run(() => deleteTaskObject(o.id))}
                />
              );
            }
            if (o.kind === "checklist") {
              return (
                <ChecklistCard
                  key={o.id}
                  items={checklistItemsByObject.get(o.id) ?? []}
                  pending={pending}
                  onAddItem={(label) => run(() => addChecklistItem(o.id, label))}
                  onToggleItem={(itemId, checked) => run(() => updateChecklistItem(itemId, { is_checked: checked }))}
                  onRelabelItem={(itemId, label) => run(() => updateChecklistItem(itemId, { label }))}
                  onRemoveItem={(itemId) => run(() => removeChecklistItem(itemId))}
                  onRemove={() => run(() => deleteTaskObject(o.id))}
                />
              );
            }
            if (o.kind === "file") {
              return (
                <FileCard
                  key={o.id}
                  file={taskObjectFileByObjectId.get(o.id)}
                  pending={pending}
                  onRemove={() => run(() => deleteTaskObject(o.id))}
                  onView={setViewingImage}
                />
              );
            }
            if (o.kind === "sketch") {
              return (
                <SketchCard
                  key={o.id}
                  file={taskObjectFileByObjectId.get(o.id)}
                  pending={pending}
                  onRemove={() => run(() => deleteTaskObject(o.id))}
                  onSaved={(formData) => run(() => saveSketchImage(orgId, taskId, o.id, formData))}
                  onSaveAsImage={(formData) => run(() => saveSketchAsImage(orgId, taskId, o.id, formData))}
                />
              );
            }
            if (o.kind === "code") {
              return (
                <CodeCard
                  key={o.id}
                  obj={o}
                  pending={pending}
                  onChange={(code, language) => run(() => updateCodeBlock(o.id, code, language))}
                  onRemove={() => run(() => deleteTaskObject(o.id))}
                />
              );
            }
            if (o.kind === "form") {
              const form = taskObjectFormByObjectId.get(o.id);
              const template = formTemplates.find((t) => t.id === form?.form_template_id);
              return (
                <FormCard
                  key={o.id}
                  form={form}
                  template={template}
                  pending={pending}
                  onChange={(values) => run(() => updateTaskObjectFormValues(o.id, values))}
                  onRemove={() => run(() => deleteTaskObject(o.id))}
                />
              );
            }
            return (
              <div key={o.id} className="obj-card">
                <div className="obj-card-head">
                  <span className="obj-type-label">{o.kind}</span>
                  <button className="icon-btn" onClick={() => run(() => deleteTaskObject(o.id))} disabled={pending} title="Remove">
                    ✕
                  </button>
                </div>
                <p style={{ color: "var(--text-faint)", fontSize: 12 }}>Not supported in this view yet.</p>
              </div>
            );
          })}
        </div>
      )}
      <div className="obj-add-row">
        <button
          type="button"
          className={`obj-add-btn ${menuOpen ? "open" : ""}`}
          onClick={() => setMenuOpen((v) => !v)}
          disabled={pending}
          title="Add an attachment"
        >
          +
        </button>
        {menuOpen && (
          <div className="obj-menu">
            <button type="button" className="obj-menu-item" onClick={() => addObject("note")}>
              Text note
            </button>
            <button type="button" className="obj-menu-item" onClick={triggerFileUpload}>
              Upload file
            </button>
            <button type="button" className="obj-menu-item" onClick={() => addObject("sketch")}>
              Sketch pad
            </button>
            <button type="button" className="obj-menu-item" onClick={() => addObject("code")}>
              Code block
            </button>
            <button type="button" className="obj-menu-item" onClick={() => addObject("checklist")}>
              Checklist
            </button>
            <div className="obj-menu-item-wrap">
              <button type="button" className="obj-menu-item" onClick={() => setFormMenuOpen((v) => !v)}>
                Form
              </button>
              {formMenuOpen && (
                <div className="obj-menu obj-submenu">
                  {formTemplates.length === 0 ? (
                    <span className="obj-menu-item" style={{ color: "var(--text-faint)", cursor: "default" }}>
                      No form templates yet
                    </span>
                  ) : (
                    formTemplates.map((t) => (
                      <button key={t.id} type="button" className="obj-menu-item" onClick={() => addForm(t.id)}>
                        {t.name}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      {viewingImage && (
        <div className="img-lightbox show" onClick={() => setViewingImage(null)}>
          <img src={viewingImage.src} alt={viewingImage.name} />
        </div>
      )}
    </div>
  );
}

function formatBytes(n: number | null): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function NoteCard({
  obj,
  pending,
  onChange,
  onRemove,
}: {
  obj: TaskObject;
  pending: boolean;
  onChange: (text: string) => void;
  onRemove: () => void;
}) {
  const text = obj.content?.text ?? "";
  return (
    <div className="obj-card">
      <div className="obj-card-head">
        <span className="obj-type-label">Text note</span>
        <button className="icon-btn" onClick={onRemove} disabled={pending} title="Remove">
          ✕
        </button>
      </div>
      <textarea
        className="text-input obj-textarea"
        defaultValue={text}
        placeholder="Type a note…"
        onBlur={(e) => {
          if (e.target.value !== text) onChange(e.target.value);
        }}
      />
    </div>
  );
}

// A ported thumbnail-or-generic-icon file row. The bucket is private, so
// `file.url` is a signed URL generated fresh on every workspace load (see
// getWorkspaceData in lib/tasks-data.ts) rather than a permanent public
// link — it can go stale after an hour, but a fresh page load always gets
// a new one. Beyond the prototype (which only ever had in-browser data
// URIs, never a real downloadable file): a non-image file's row is a real
// download link.
function FileCard({
  file,
  pending,
  onRemove,
  onView,
}: {
  file: FileWithUrl | undefined;
  pending: boolean;
  onRemove: () => void;
  onView: (image: { src: string; name: string }) => void;
}) {
  const isImage = (file?.mime_type ?? "").startsWith("image/");
  return (
    <div className="obj-card">
      <div className="obj-card-head">
        <span className="obj-type-label">File</span>
        <button className="icon-btn" onClick={onRemove} disabled={pending} title="Remove">
          ✕
        </button>
      </div>
      {!file ? (
        <div className="obj-file-error">This file is missing.</div>
      ) : !file.url ? (
        <div className="obj-file-error">Couldn&apos;t load this file — try refreshing.</div>
      ) : isImage ? (
        <div className="obj-file-row">
          <img
            className="obj-file-thumb obj-file-thumb-clickable"
            src={file.url}
            alt={file.filename}
            title="Click to view"
            onClick={() => onView({ src: file.url as string, name: file.filename })}
          />
          <div className="obj-file-meta">
            <span className="row-title">{file.filename}</span>
            <span className="crumbline">{formatBytes(file.size_bytes)}</span>
          </div>
        </div>
      ) : (
        <div className="obj-file-row">
          <a className="obj-file-generic" href={file.url} download={file.filename} target="_blank" rel="noreferrer" title="Download">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
            </svg>
          </a>
          <div className="obj-file-meta">
            <span className="row-title">{file.filename}</span>
            <span className="crumbline">{formatBytes(file.size_bytes)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// A code-block attachment: language dropdown (a curated hljs subset plus
// "Auto-detect", "Auto" being the default for a new block) over a
// click-to-edit area — a plain, uncontrolled <textarea> while editing (Tab
// inserts two spaces rather than moving focus, same as a real editor), a
// syntax-highlighted read-only <pre> once saved (see lib/code-highlight.ts).
// Local `local*` state mirrors what's on screen the instant a save fires,
// rather than waiting on the router.refresh() a save always triggers too —
// without it, switching back to the highlighted view would flash the old
// (pre-edit) content for a moment.
function CodeCard({
  obj,
  pending,
  onChange,
  onRemove,
}: {
  obj: TaskObject;
  pending: boolean;
  onChange: (code: string, language: string) => void;
  onRemove: () => void;
}) {
  const savedCode = obj.content?.code ?? "";
  const savedLanguage = obj.content?.language ?? "auto";
  const [editing, setEditing] = useState(() => !savedCode);
  const [localCode, setLocalCode] = useState(savedCode);
  const [localLanguage, setLocalLanguage] = useState(savedLanguage);
  const [copied, setCopied] = useState(false);
  // Long blocks default to a fixed-height, scrollable view rather than
  // pushing the rest of the task panel down — the expand arrow (bottom-right
  // of the block) reveals the whole thing when needed. Starts collapsed
  // whenever there's saved code to show.
  const [collapsed, setCollapsed] = useState(() => !!savedCode);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) {
      setLocalCode(savedCode);
      setLocalLanguage(savedLanguage);
    }
  }, [savedCode, savedLanguage, editing]);

  function saveFromTextarea() {
    const next = textareaRef.current?.value ?? localCode;
    setLocalCode(next);
    setEditing(false);
    if (next !== savedCode || localLanguage !== savedLanguage) onChange(next, localLanguage);
  }

  function changeLanguage(next: string) {
    const currentCode = editing ? textareaRef.current?.value ?? localCode : localCode;
    setLocalCode(currentCode);
    setLocalLanguage(next);
    setEditing(false);
    onChange(currentCode, next);
  }

  function handleTab(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Tab") return;
    e.preventDefault();
    const el = e.currentTarget;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    el.value = el.value.slice(0, start) + "  " + el.value.slice(end);
    el.selectionStart = el.selectionEnd = start + 2;
  }

  function copyCode() {
    navigator.clipboard?.writeText(localCode).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }

  const { html, detected } = editing ? { html: "", detected: null } : highlightCode(localCode, localLanguage);

  return (
    <div className="obj-card">
      <div className="obj-card-head">
        <span className="obj-type-label">Code block</span>
        <button className="icon-btn" onClick={onRemove} disabled={pending} title="Remove">
          ✕
        </button>
      </div>
      <div className="code-block-toolbar">
        <select
          className="select-input code-lang-select"
          value={localLanguage}
          disabled={pending}
          onChange={(e) => changeLanguage(e.target.value)}
        >
          {CODE_LANGUAGES.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
        {!editing && localLanguage === "auto" && detected && <span className="code-detected">Detected: {detected}</span>}
        {!editing && !!localCode && (
          <button type="button" className="small-btn ghost-btn code-copy-btn" onClick={copyCode} disabled={pending}>
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      {editing ? (
        <textarea
          ref={textareaRef}
          className="code-block-textarea"
          defaultValue={localCode}
          placeholder="Paste or type code…"
          spellCheck={false}
          onBlur={saveFromTextarea}
          onKeyDown={handleTab}
          autoFocus
        />
      ) : localCode ? (
        <div className={"code-block-pre-wrap" + (collapsed ? " code-block-collapsed" : "")}>
          <pre className="code-block-pre" onClick={() => setEditing(true)} title="Click to edit">
            <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
          </pre>
          <button
            type="button"
            className="code-block-collapse-btn"
            onClick={(e) => {
              e.stopPropagation();
              setCollapsed((c) => !c);
            }}
            title={collapsed ? "Expand" : "Collapse"}
          >
            {collapsed ? "▽" : "△"}
          </button>
        </div>
      ) : (
        <div className="code-block-empty" onClick={() => setEditing(true)}>
          Click to add code…
        </div>
      )}
    </div>
  );
}

// The drawing engine (toolbar, canvas, pointer handling, undo/clear) lives
// in components/sketch-canvas.tsx now — pulled out so SketchComposer
// (components/chat-editors.tsx, the Portal's below-the-chat scratchpad) can
// share the exact same tools/shapes/fill/undo rather than a re-implementation
// that could quietly drift from this one. This card just wires that shared
// engine to this object's own persistence: autosave on every commit
// (onSaved) plus a "Save as image" primary action that flips the object's
// kind server-side (onSaveAsImage) — see saveSketchAsImage's own comment in
// lib/actions.ts.
function SketchCard({
  file,
  pending,
  onRemove,
  onSaved,
  onSaveAsImage,
}: {
  file: FileWithUrl | undefined;
  pending: boolean;
  onRemove: () => void;
  onSaved: (formData: FormData) => void;
  onSaveAsImage: (formData: FormData) => void;
}) {
  function toFormData(blob: Blob): FormData {
    const formData = new FormData();
    formData.append("file", blob, "sketch.png");
    return formData;
  }

  return (
    <div className="obj-card">
      <div className="obj-card-head">
        <span className="obj-type-label">Sketch</span>
        <button className="icon-btn" onClick={onRemove} disabled={pending} title="Remove">
          ✕
        </button>
      </div>
      <SketchCanvas
        initialImageUrl={file?.url}
        disabled={pending}
        onCommit={(blob) => onSaved(toFormData(blob))}
        primaryAction={{
          label: "Save as image",
          title: "Replace this sketch pad with a saved PNG image",
          onClick: (blob) => onSaveAsImage(toFormData(blob)),
        }}
      />
    </div>
  );
}

function ChecklistCard({
  items,
  pending,
  onAddItem,
  onToggleItem,
  onRelabelItem,
  onRemoveItem,
  onRemove,
}: {
  items: ChecklistItem[];
  pending: boolean;
  onAddItem: (label: string) => void;
  onToggleItem: (itemId: string, checked: boolean) => void;
  onRelabelItem: (itemId: string, label: string) => void;
  onRemoveItem: (itemId: string) => void;
  onRemove: () => void;
}) {
  const [newItem, setNewItem] = useState("");
  const doneCount = items.filter((i) => i.is_checked).length;

  return (
    <div className="obj-card">
      <div className="obj-card-head">
        <span className="obj-type-label">Checklist</span>
        <button className="icon-btn" onClick={onRemove} disabled={pending} title="Remove">
          ✕
        </button>
      </div>
      {items.length === 0 ? (
        <div className="crumbline">No items yet — add one below.</div>
      ) : (
        <div className="checklist-items">
          {items.map((i) => (
            <div key={i.id} className={`checklist-item ${i.is_checked ? "done" : ""}`}>
              <input
                type="checkbox"
                checked={i.is_checked}
                onChange={(e) => onToggleItem(i.id, e.target.checked)}
                disabled={pending}
              />
              <input
                type="text"
                className="checklist-item-input"
                defaultValue={i.label}
                onBlur={(e) => {
                  const value = e.target.value.trim();
                  if (value && value !== i.label) onRelabelItem(i.id, value);
                }}
              />
              <button className="icon-btn" onClick={() => onRemoveItem(i.id)} disabled={pending} title="Remove item">
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {items.length > 0 && (
        <div className="checklist-progress">
          {doneCount}/{items.length} complete
        </div>
      )}
      <div className="add-inline">
        <input
          className="text-input"
          placeholder="Add an item and press Enter"
          value={newItem}
          disabled={pending}
          onChange={(e) => setNewItem(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && newItem.trim()) {
              onAddItem(newItem.trim());
              setNewItem("");
            }
          }}
        />
      </div>
    </div>
  );
}

// Same per-field-type input set as PortalRequestForm's own template render
// (select/paragraph/number/date/yes_no/text), kept in sync with that one —
// both ultimately fill in the same task_object_forms.values shape, just from
// different sides (staff here, a Portal customer there). Locally controlled
// so a select/checkbox/date click saves immediately the way CustomFieldControl
// does, while free-text fields save on blur like NoteCard's textarea; either
// way `values` is kept in sync with the object's own saved state via the
// effect below, in case a concurrent edit lands on refresh.
function FormCard({
  form,
  template,
  pending,
  onChange,
  onRemove,
}: {
  form: TaskObjectForm | undefined;
  template: FormTemplate | undefined;
  pending: boolean;
  onChange: (values: Record<string, string>) => void;
  onRemove: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(form?.values ?? {});

  useEffect(() => {
    setValues(form?.values ?? {});
  }, [form?.values]);

  function save(next: Record<string, string>) {
    setValues(next);
    onChange(next);
  }

  if (!template) {
    return (
      <div className="obj-card">
        <div className="obj-card-head">
          <span className="obj-type-label">Form</span>
          <button className="icon-btn" onClick={onRemove} disabled={pending} title="Remove">
            ✕
          </button>
        </div>
        <p style={{ color: "var(--text-faint)", fontSize: 12 }}>This form&apos;s template no longer exists.</p>
      </div>
    );
  }

  return (
    <div className="obj-card">
      <div className="obj-card-head">
        <span className="obj-type-label">Form — {template.name}</span>
        <button className="icon-btn" onClick={onRemove} disabled={pending} title="Remove">
          ✕
        </button>
      </div>
      {template.fields.length === 0 ? (
        <p className="crumbline">This template has no fields yet.</p>
      ) : (
        template.fields.map((f) => (
          <div key={f.id} className="field-group">
            <span className="field-label">{f.label}</span>
            {f.type === "select" ? (
              <select
                className="select-input"
                disabled={pending}
                value={values[f.id] ?? ""}
                onChange={(e) => save({ ...values, [f.id]: e.target.value })}
              >
                <option value="">—</option>
                {(f.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : f.type === "paragraph" ? (
              <textarea
                className="text-input"
                disabled={pending}
                defaultValue={values[f.id] ?? ""}
                onBlur={(e) => {
                  if (e.target.value !== (values[f.id] ?? "")) save({ ...values, [f.id]: e.target.value });
                }}
              />
            ) : f.type === "number" ? (
              <input
                className="text-input mono"
                type="number"
                disabled={pending}
                defaultValue={values[f.id] ?? ""}
                onBlur={(e) => {
                  if (e.target.value !== (values[f.id] ?? "")) save({ ...values, [f.id]: e.target.value });
                }}
              />
            ) : f.type === "date" ? (
              <DateGuideField value={values[f.id] ?? ""} onChange={(v) => save({ ...values, [f.id]: v })} />
            ) : f.type === "yes_no" ? (
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  disabled={pending}
                  checked={values[f.id] === "true"}
                  onChange={(e) => save({ ...values, [f.id]: e.target.checked ? "true" : "false" })}
                />
                <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{values[f.id] === "true" ? "Yes" : "No"}</span>
              </label>
            ) : (
              <input
                className="text-input"
                type="text"
                disabled={pending}
                defaultValue={values[f.id] ?? ""}
                onBlur={(e) => {
                  if (e.target.value !== (values[f.id] ?? "")) save({ ...values, [f.id]: e.target.value });
                }}
              />
            )}
          </div>
        ))
      )}
    </div>
  );
}
