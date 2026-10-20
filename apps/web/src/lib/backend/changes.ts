import type {
  CanonicalToolPresentation,
  ChangeDiffFileBody,
  ChangeProjection,
  ChangesApplyRestoreResult,
  ChangesGetDiffResult,
  ChangesGetFilesResult,
  ChangesGetHandoffResult,
  ChangesGetHistoryResult,
  ChangesPrepareRestoreResult,
  ChangesRefreshResult,
  ChangesResolveLiveDetailResult,
  ChangeTrackingCapabilities,
  ChangeViewResult,
  DiffDisplayOptions,
} from "@orkestrator/protocol/change-resources";
import type { LineCount } from "@orkestrator/protocol/change-measurements";
import { invoke } from "@/lib/native/backend";

/**
 * Backend change-tracking commands (docs/architecture/change-tracking.md).
 * Every answer is a server-prepared DTO; nothing here interprets counts.
 */

export function getChangeView(
  resourceKey: string,
  known?: { generation: string; revision: number },
  pageSize?: number,
): Promise<ChangeViewResult> {
  return invoke<ChangeViewResult>("changes_get_view", {
    resourceKey,
    ...(known ? { knownGeneration: known.generation, knownRevision: known.revision } : {}),
    ...(pageSize !== undefined ? { pageSize } : {}),
  });
}

export function getChangeFiles(
  resourceKey: string,
  snapshotToken: string,
  cursor: string | null,
  pageSize = 200,
): Promise<ChangesGetFilesResult> {
  return invoke<ChangesGetFilesResult>("changes_get_files", {
    resourceKey,
    snapshotToken,
    cursor,
    pageSize,
  });
}

export interface ToolChangePresentations {
  presentations: Record<string, CanonicalToolPresentation | null>;
  projections: Record<string, ChangeProjection>;
}

export function getToolChangePresentations(input: {
  environmentId: string;
  provider: string;
  conversationId: string;
  callIds: readonly string[];
}): Promise<ToolChangePresentations> {
  return invoke<ToolChangePresentations>("changes_get_tool_presentations", {
    ...input,
    callIds: Array.from(input?.callIds ?? []),
  });
}

export function getChangeHistory(input: {
  environmentId: string;
  logicalSessionKey: string;
  cursor?: string | null;
  pageSize?: number;
}): Promise<ChangesGetHistoryResult> {
  return invoke<ChangesGetHistoryResult>("changes_get_history", input);
}

export function getChangeThread(
  environmentId: string,
  logicalSessionKey: string,
): Promise<{ segmentId: string; resourceKey: string } | null> {
  return invoke("changes_get_thread", { environmentId, logicalSessionKey });
}

export function resolveLiveChangeDetail(input: {
  resourceKey: string;
  revision?: number;
  rowId?: string;
  pathId?: string;
  path?: string;
}): Promise<ChangesResolveLiveDetailResult> {
  return invoke<ChangesResolveLiveDetailResult>("changes_resolve_live_detail", input);
}

export function getChangeDiff(
  diffIdentityId: string,
  cursor?: string | null,
  display?: DiffDisplayOptions,
): Promise<ChangesGetDiffResult> {
  return invoke<ChangesGetDiffResult>("changes_get_diff", {
    diffIdentityId,
    ...(cursor ? { cursor } : {}),
    ...(display ? { display } : {}),
  });
}

export function refreshChanges(resourceKey: string): Promise<ChangesRefreshResult> {
  return invoke<ChangesRefreshResult>("changes_refresh", { resourceKey });
}

export function getChangeHandoff(
  measurementIds: readonly string[],
  maxCharacters?: number,
): Promise<ChangesGetHandoffResult> {
  return invoke<ChangesGetHandoffResult>("changes_get_handoff", {
    measurementIds: [...measurementIds],
    ...(maxCharacters !== undefined ? { maxCharacters } : {}),
  });
}

export function prepareChangeRestore(
  measurementId: string,
  pathIds?: readonly string[],
): Promise<ChangesPrepareRestoreResult> {
  return invoke<ChangesPrepareRestoreResult>("changes_prepare_restore", {
    measurementId,
    ...(pathIds ? { pathIds: [...pathIds] } : {}),
  });
}

export function applyChangeRestore(
  actionToken: string,
  idempotencyKey: string,
): Promise<ChangesApplyRestoreResult> {
  return invoke<ChangesApplyRestoreResult>("changes_apply_restore", {
    actionToken,
    idempotencyKey,
  });
}

let capabilities: Promise<ChangeTrackingCapabilities | null> | null = null;

/** What this backend's change tracking offers; null for a backend without it. Cached per page. */
export function getChangeTrackingCapabilities(): Promise<ChangeTrackingCapabilities | null> {
  capabilities ??= invoke<ChangeTrackingCapabilities>("changes_get_capabilities").catch(() => {
    capabilities = null;
    return null;
  });
  return capabilities;
}

/** Test seam. */
export function resetChangeTrackingCapabilitiesForTests(): void {
  capabilities = null;
}

/** Backend measurement of a legacy transcript tool payload (never counted in the client). */
export interface LegacyPayloadSummary {
  provenanceLabelKey: string;
  additions: LineCount;
  deletions: LineCount;
  changedFiles: number | null;
  contentLines: number | null;
  reasonKeys: string[];
  files: ChangeDiffFileBody[];
}

export function measureLegacyToolPayload(input: {
  toolName?: string;
  filePath?: string;
  before?: string;
  after?: string;
  diff?: string;
  additions?: number;
  deletions?: number;
}): Promise<LegacyPayloadSummary | null> {
  return invoke<LegacyPayloadSummary | null>("changes_measure_legacy_payload", input);
}
