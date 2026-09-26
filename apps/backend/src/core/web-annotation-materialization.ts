/**
 * Ownership tracking and cleanup of evidence the backend materialized into a
 * workspace (`.orkestrator/annotations/<request>-<digest>.png`).
 *
 * The request record is the ownership ledger: each attachment names the
 * app-generated relative path, the agent-readable path it was written to,
 * and the digest of the exact bytes. A file is removed only when:
 *
 * - its request is settled (never while queued/running/unconfirmed), and
 * - its notes were all deleted, or the settlement is older than the
 *   retention period (the transcript may still refer to the file until then),
 * - and the file on disk is still a regular file with the recorded digest
 *   (a user or agent overwriting it makes it theirs; it is then untracked).
 *
 * Environment deletion removes the whole workspace through the existing
 * lifecycle, so nothing is tracked past it.
 */
import {
  WEB_ANNOTATION_LIMITS,
  isWebAnnotationRequestActive,
} from "@orkestrator/protocol/web-annotations";
import {
  removeLocalEvidence,
  type EvidenceRemovalOutcome,
} from "./web-annotation-evidence-files.js";
import type { WebAnnotationHostEnvironment } from "./web-annotation-service-base.js";
import type { WebAnnotationManifest } from "./web-annotation-storage.js";

/** Settled evidence stays in the workspace this long for transcript references. */
export const MATERIALIZED_EVIDENCE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_BATCH = 10;

export interface MaterializedEvidence {
  requestId: string;
  assetId: string;
  relativePath: string;
  digest: string;
}

/** Pure selection so the policy is testable without a workspace. */
export function planMaterializedCleanup(
  manifest: WebAnnotationManifest,
  nowMs: number,
  options: { retentionMs?: number; batch?: number } = {},
): MaterializedEvidence[] {
  const retentionMs = options.retentionMs ?? MATERIALIZED_EVIDENCE_RETENTION_MS;
  const batch = options.batch ?? CLEANUP_BATCH;
  const out: MaterializedEvidence[] = [];
  for (const request of Object.values(manifest.requests)) {
    if (out.length >= batch) break;
    if (isWebAnnotationRequestActive(request.state) || !request.settledAt) continue;
    const pending = request.attachments.filter(
      (attachment) => attachment.materializedPath && !attachment.removedAt,
    );
    if (pending.length === 0) continue;
    const notesDeleted = request.selections.every(
      (selection) =>
        (manifest.annotations[selection.annotationId]?.state ?? "deleted") === "deleted",
    );
    const settledAt = Date.parse(request.settledAt);
    const expired = Number.isFinite(settledAt) && nowMs - settledAt >= retentionMs;
    if (!notesDeleted && !expired) continue;
    for (const attachment of pending) {
      if (out.length >= batch) break;
      out.push({
        requestId: request.id,
        assetId: attachment.assetId,
        relativePath: attachment.relativePath,
        digest: attachment.digest,
      });
    }
  }
  return out;
}

export type EvidenceRemovalResult = EvidenceRemovalOutcome | "retry";

/**
 * Remove one materialized file from its workspace. `retry` means the
 * workspace is temporarily unreachable (e.g. a stopped container); the item
 * stays tracked. A missing environment or container means the workspace is
 * gone, which counts as removed.
 */
export async function removeMaterializedEvidence(
  environment: WebAnnotationHostEnvironment | null,
  item: MaterializedEvidence,
  invoke: ((command: string, args: Record<string, unknown>) => Promise<unknown>) | undefined,
): Promise<EvidenceRemovalResult> {
  if (!environment) return "missing";
  const local =
    environment.environmentType === "local" ||
    (!environment.containerId && environment.worktreePath);
  try {
    if (local) {
      if (!environment.worktreePath) return "missing";
      return await removeLocalEvidence(
        environment.worktreePath,
        item.relativePath,
        item.digest,
        WEB_ANNOTATION_LIMITS.imageBytes,
      );
    }
    if (!environment.containerId) return "missing";
    if (!invoke) return "retry";
    const outcome = await invoke("delete_container_annotation_evidence", {
      containerId: environment.containerId,
      filePath: item.relativePath,
      digest: item.digest,
    });
    return outcome === "removed" || outcome === "missing" || outcome === "mismatch"
      ? outcome
      : "retry";
  } catch {
    return "retry";
  }
}
