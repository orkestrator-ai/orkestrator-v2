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
  "multi-review",
  "build-pipeline",
  "native-agent-session",
  "prompt-queue",
  "compose-draft",
  "file-draft",
  "agent-mail",
  "agent-mail-summary",
] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/**
 * Resources covered by the compact convergence manifest.
 *
 * These are exactly the persistent snapshots that participate in the
 * renderer's broad safety sweep. Record-level resources such as drafts keep
 * using their own revision-aware APIs and are intentionally not added here.
 */
export const RESOURCE_MANIFEST_KINDS = [
  "project",
  "environment",
  "session",
  "config",
  "kanban",
  "project-notes",
  "feature-plan",
  "pane-layout",
  "looped-review",
  "multi-review",
  "build-pipeline",
  "prompt-queue",
  "agent-mail-summary",
] as const satisfies readonly ResourceKind[];

export type ResourceManifestKind = (typeof RESOURCE_MANIFEST_KINDS)[number];

/** Opaque revision of one authoritative resource snapshot. */
export type ResourceSnapshotRevision = string;

export type ResourceRevisionMap = Record<ResourceManifestKind, ResourceSnapshotRevision>;

/**
 * Compact response used for periodic and reconnect reconciliation.
 *
 * A generation reset returns every revision with `reset: true`. Within one
 * generation the backend returns only revisions that differ from the client's
 * known values. A stable client therefore receives no resource bodies and an
 * empty `revisions` object.
 */
export interface ResourceRevisionManifest {
  generation: string;
  reset: boolean;
  revisions: Partial<ResourceRevisionMap>;
}

export type ConditionalResourceSnapshot<T> =
  | {
      status: "unchanged";
      generation: string;
      revision: ResourceSnapshotRevision;
    }
  | {
      status: "changed";
      generation: string;
      revision: ResourceSnapshotRevision;
      snapshot: T;
    };

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
  /** Owning project when the resource is project-scoped. */
  projectId?: string;
  /**
   * Monotonic per-backend sequence number. Strictly increasing across every
   * resource kind, so a client can order changes and detect that it missed a
   * window without needing per-resource bookkeeping.
   */
  revision: number;
}

const RESOURCE_KIND_SET: ReadonlySet<string> = new Set(RESOURCE_KINDS);
const RESOURCE_MANIFEST_KIND_SET: ReadonlySet<string> = new Set(RESOURCE_MANIFEST_KINDS);

export function isResourceKind(value: unknown): value is ResourceKind {
  return typeof value === "string" && RESOURCE_KIND_SET.has(value);
}

export function isResourceManifestKind(value: unknown): value is ResourceManifestKind {
  return typeof value === "string" && RESOURCE_MANIFEST_KIND_SET.has(value);
}

export function isResourceSnapshotRevision(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}

/** Manifest generations use the same opaque 128-bit hexadecimal encoding. */
export function isResourceGeneration(value: unknown): value is string {
  return isResourceSnapshotRevision(value);
}

export function isResourceRevisionManifest(value: unknown): value is ResourceRevisionManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (
    !isResourceGeneration(candidate.generation) ||
    typeof candidate.reset !== "boolean" ||
    typeof candidate.revisions !== "object" ||
    candidate.revisions === null ||
    Array.isArray(candidate.revisions)
  ) {
    return false;
  }
  for (const [kind, revision] of Object.entries(candidate.revisions as Record<string, unknown>)) {
    if (!isResourceManifestKind(kind) || !isResourceSnapshotRevision(revision)) {
      return false;
    }
  }
  return true;
}

/**
 * Validates an inbound payload. Clients receive this over a network boundary,
 * so a malformed frame must be dropped rather than trigger a refetch storm.
 */
export function isResourceChange(value: unknown): value is ResourceChange {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isResourceKind(candidate.resource) &&
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    (candidate.projectId === undefined ||
      (typeof candidate.projectId === "string" && candidate.projectId.trim().length > 0)) &&
    typeof candidate.revision === "number" &&
    Number.isSafeInteger(candidate.revision) &&
    candidate.revision > 0
  );
}
