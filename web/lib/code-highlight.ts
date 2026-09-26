// Language registry + highlighting helper for the "code" task-object kind
// (components/task-objects.tsx's CodeCard). Imports highlight.js's core
// bundle plus a curated set of languages one at a time rather than the
// full `highlight.js` package (which registers ~190 languages) — keeps
// the client bundle to just what this app's dropdown actually offers.

import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import java from "highlight.js/lib/languages/java";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import ruby from "highlight.js/lib/languages/ruby";
import php from "highlight.js/lib/languages/php";
import swift from "highlight.js/lib/languages/swift";
import kotlin from "highlight.js/lib/languages/kotlin";
import sql from "highlight.js/lib/languages/sql";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import bash from "highlight.js/lib/languages/bash";
import markdown from "highlight.js/lib/languages/markdown";

const REGISTRY: Record<string, () => unknown> = {
  javascript: () => javascript,
  typescript: () => typescript,
  python: () => python,
  java: () => java,
  cpp: () => cpp,
  csharp: () => csharp,
  go: () => go,
  rust: () => rust,
  ruby: () => ruby,
  php: () => php,
  swift: () => swift,
  kotlin: () => kotlin,
  sql: () => sql,
  xml: () => xml,
  css: () => css,
  json: () => json,
  yaml: () => yaml,
  bash: () => bash,
  markdown: () => markdown,
};

let registered = false;
function ensureRegistered() {
  if (registered) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const [name, get] of Object.entries(REGISTRY)) hljs.registerLanguage(name, get() as any);
  registered = true;
}

// "auto" (the default for a new code block — auto-detect) and "plaintext"
// (no highlighting at all) are handled specially in highlightCode below,
// not registered hljs languages.
export const CODE_LANGUAGES: { value: string; label: string }[] = [
  { value: "auto", label: "Auto-detect" },
  { value: "javascript", label: "JavaScript" },
  { value: "typescript", label: "TypeScript" },
  { value: "python", label: "Python" },
  { value: "java", label: "Java" },
  { value: "cpp", label: "C++" },
  { value: "csharp", label: "C#" },
  { value: "go", label: "Go" },
  { value: "rust", label: "Rust" },
  { value: "ruby", label: "Ruby" },
  { value: "php", label: "PHP" },
  { value: "swift", label: "Swift" },
  { value: "kotlin", label: "Kotlin" },
  { value: "sql", label: "SQL" },
  { value: "xml", label: "HTML / XML" },
  { value: "css", label: "CSS" },
  { value: "json", label: "JSON" },
  { value: "yaml", label: "YAML" },
  { value: "bash", label: "Shell" },
  { value: "markdown", label: "Markdown" },
  { value: "plaintext", label: "Plain text" },
];

// A "code block posted to the chat" (SketchComposer's sibling, CodeComposer
// — see components/code-attachment-viewer.tsx) isn't its own task_object;
// it's an ordinary ticket_message_attachments file row like any upload,
// tagged with this synthetic mime_type so MessageAttachments/
// PortalMessageAttachments can tell it apart from a real file and render a
// code thumbnail instead of a download chip. mime_type is a free-text
// column with no db constraint, so this needs no schema change — just a
// convention both the poster and the two renderers agree on.
export const CODE_ATTACHMENT_MIME_PREFIX = "text/x-code+";

export function buildCodeAttachmentMimeType(language: string): string {
  return `${CODE_ATTACHMENT_MIME_PREFIX}${language || "plaintext"}`;
}

export function isCodeAttachmentMimeType(mimeType: string | null | undefined): boolean {
  return !!mimeType && mimeType.startsWith(CODE_ATTACHMENT_MIME_PREFIX);
}

export function parseCodeAttachmentLanguage(mimeType: string | null | undefined): string {
  if (!isCodeAttachmentMimeType(mimeType)) return "plaintext";
  return (mimeType as string).slice(CODE_ATTACHMENT_MIME_PREFIX.length) || "plaintext";
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Returns highlighted HTML (already escaped — safe to drop straight into
// dangerouslySetInnerHTML) plus, for "auto", which language hljs actually
// guessed (shown in the card header so "auto-detect" doesn't leave the
// user wondering what language it decided on).
export function highlightCode(code: string, language: string): { html: string; detected: string | null } {
  if (!code.trim()) return { html: "", detected: null };
  if (language === "plaintext") return { html: escapeHtml(code), detected: null };

  ensureRegistered();

  if (language === "auto") {
    const result = hljs.highlightAuto(code, Object.keys(REGISTRY));
    return { html: result.value, detected: result.language ?? null };
  }
  if (!(language in REGISTRY)) return { html: escapeHtml(code), detected: null };
  return { html: hljs.highlight(code, { language }).value, detected: null };
}
