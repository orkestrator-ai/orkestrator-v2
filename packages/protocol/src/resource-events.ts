/**
 * Backend -> client change notifications.
 *
 * Every persistent mutation the backend makes announces itself on this channel
 * so that any number of connected clients can converge without polling. The
 * payload deliberately carries no resource body: a client that cares refetches
 * through the normal command surface, which keeps this channel cheap and means
 * a client never has to trust a partial snapshot delivered out of band.
 */

/** Persistent resources the backend owns and broadcasts changes for. */
export const RESOURCE_KINDS = [
  "project",
  "environment",
  "session",
  "config",
  "kanban",
  "project-notes",
  "feature-plan",
  "pane-layout",
  "looped-review",
  "build-pipeline",
  "native-agent-session",
  "prompt-queue",
  "compose-draft",
  "file-draft",
] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** SSE/IPC event name carrying a {@link ResourceChange}. */
export const RESOURCE_CHANGED_EVENT = "resource-changed";

export interface ResourceChange {
  resource: ResourceKind;
  /**
   * Identifier of the thing that changed. For record-scoped resources this is
   * the record id; for collection-scoped resources (kanban, feature plans,
   * notes) it is the owning project id, and for drafts the environment id.
   * Clients refetch the collection rather than trying to patch it.
   */
  id: string;
  /**
   * Monotonic per-backend sequence number. Strictly increasing across every
   * resource kind, so a client can order changes and detect that it missed a
   * window without needing per-resource bookkeeping.
   */
  revision: number;
}

const RESOURCE_KIND_SET: ReadonlySet<string> = new Set(RESOURCE_KINDS);

export function isResourceKind(value: unknown): value is ResourceKind {
  return typeof value === "string" && RESOURCE_KIND_SET.has(value);
}

/**
 * Validates an inbound payload. Clients receive this over a network boundary,
 * so a malformed frame must be dropped rather than trigger a refetch storm.
 */
export function isResourceChange(value: unknown): value is ResourceChange {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isResourceKind(candidate.resource)
    && typeof candidate.id === "string"
    && candidate.id.length > 0
    && typeof candidate.revision === "number"
    && Number.isSafeInteger(candidate.revision)
    && candidate.revision > 0
  );
}
