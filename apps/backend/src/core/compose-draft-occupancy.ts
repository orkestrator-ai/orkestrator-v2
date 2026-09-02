/**
 * Whether a persisted compose draft must hold background work behind the user.
 *
 * Unknown and malformed shapes fail closed. `annotations` is optional for
 * drafts written by older renderers, but when present it must be an array and
 * any entry means the composer is occupied.
 */
export function composeDraftHoldsQueue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  const draft = value as Record<string, unknown>;
  if (typeof draft.text !== "string") return true;
  if (!Array.isArray(draft.mentions) || !Array.isArray(draft.attachments)) return true;
  if (draft.annotations !== undefined && !Array.isArray(draft.annotations)) return true;
  return (
    draft.text.trim().length > 0 ||
    draft.mentions.length > 0 ||
    draft.attachments.length > 0 ||
    (Array.isArray(draft.annotations) && draft.annotations.length > 0)
  );
}
