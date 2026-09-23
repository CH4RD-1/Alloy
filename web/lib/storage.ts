// Shared between lib/actions.ts (upload/delete, a "use server" file that can
// only export async functions — so these plain constants/helpers can't live
// there) and lib/tasks-data.ts (signed URL generation): a single source of
// truth for the bucket name and the storage-key layout, so the two sides
// can't drift apart. See task_attachments_storage.sql for the bucket itself
// and its RLS policies, which depend on the exact key shape built here.

export const TASK_ATTACHMENTS_BUCKET = "task-attachments";

// Matches the prototype's own MAX_BYTES cap on task-object file uploads
// (fileToDataUrl's 4MB check) — kept identical rather than picking a new
// number, since it was never about a real infra limit, just a "don't choke
// the browser on a giant data URI" guard that's just as reasonable a UI-level
// cap now that files go to real Storage instead.
export const TASK_ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024;

// org_id/task_id/task_object_id/<name> — the storage policy extracts the
// org_id segment (storage.foldername(name))[1]) to check org membership via
// is_org_member(), the same helper every table-level RLS policy in
// schema.sql already uses. Nesting under task_object_id (rather than just
// org_id/task_id) means each attachment's key is unique without needing a
// random suffix, and a sketch's fixed "sketch.png" name lets re-saving it
// overwrite in place instead of accumulating old versions.
export function taskAttachmentPath(orgId: string, taskId: string, taskObjectId: string, filename: string): string {
  return `${orgId}/${taskId}/${taskObjectId}/${filename}`;
}

// Storage object keys are permissive but not infinitely so — strip anything
// that could be misread as a path separator or otherwise confuse the
// org_id-segment extraction the RLS policy depends on. The original name is
// still stored verbatim in task_object_files.filename for display, so
// sanitizing the key never affects what the user sees.
export function sanitizeFilename(name: string): string {
  const stripped = name.trim().replace(/[/\\]/g, "_").replace(/[^a-zA-Z0-9._-]/g, "_");
  return stripped.slice(0, 200) || "file";
}

// Same bucket, same org_id-first-segment RLS shape as taskAttachmentPath
// above, just nested under a message id instead of a task_object_id — see
// ticket_message_attachments' own comment in schema.sql for why this is a
// separate table (and so a separate path shape) rather than reusing
// task_object_files.
export function ticketMessageAttachmentPath(orgId: string, taskId: string, messageId: string, filename: string): string {
  return `${orgId}/${taskId}/messages/${messageId}/${filename}`;
}
