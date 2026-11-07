import type {
  CanonicalToolPresentation,
  ChangeDiffFileBody,
  ChangeProjection,
  ChangesApplyRestoreResult,
  ChangesGetDiffResult,
  ChangesGetFilesResult,
  ChangesGetHistoryResult,
  ChangesPrepareRestoreResult,
  ChangesRefreshResult,
  ChangesResolveLiveDetailResult,
  ChangeTrackingCapabilities,
  ChangeViewResult,
  DiffDisplayOptions,
} from "@orkestrator/protocol/change-resources";
import type { LineCount } from "@orkestrator/protocol/change-measurements";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope, defineScopedSlot } from "@/lib/node-scope-slots";
import {
  clientInvoke,
  commandBackendClient,
  scopeBackendClient,
  type BackendClient,
} from "./client";

/**
 * Backend change-tracking commands (docs/architecture/change-tracking.md).
 * Every answer is a server-prepared DTO; nothing here interprets counts.
 */

export interface ToolChangePresentations {
  presentations: Record<string, CanonicalToolPresentation | null>;
  projections: Record<string, ChangeProjection>;
}

/** One node's answer, held on its scope (plan item 3016). */
const changeTrackingCapabilities = defineScopedSlot<{
  request: Promise<ChangeTrackingCapabilities | null> | null;
}>("change-tracking-capabilities", () => ({ request: null }));

/**
 * What `scope`'s backend's change tracking offers (default: the command
 * node); null for a backend without it. Cached per node scope; a failure is
 * not cached. Takes the scope rather than a client, because the cache lives
 * on the scope, so it is not part of `createChangesApi`.
 */
export function getChangeTrackingCapabilities(
  // A default, not an optional parameter, so the wrapper's arity stays 0.
  target: NodeScope = appCommandScope(),
): Promise<ChangeTrackingCapabilities | null> {
  const slot = changeTrackingCapabilities(target);
  if (slot.request) return slot.request;
  const request = clientInvoke(scopeBackendClient(target))<ChangeTrackingCapabilities>(
    "changes_get_capabilities",
  ).catch(() => {
    if (slot.request === request) slot.request = null;
    return null;
  });
  slot.request = request;
  return request;
}

/** Test seam. */
export function resetChangeTrackingCapabilitiesForTests(scope?: NodeScope): void {
  changeTrackingCapabilities(scope).request = null;
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

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createChangesApi(client: BackendClient) {
  const invoke = clientInvoke(client);

  function getChangeView(
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

  function getChangeFiles(
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

  function getToolChangePresentations(input: {
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

  function getChangeHistory(input: {
    environmentId: string;
    logicalSessionKey: string;
    cursor?: string | null;
    pageSize?: number;
  }): Promise<ChangesGetHistoryResult> {
    return invoke<ChangesGetHistoryResult>("changes_get_history", input);
  }

  function getChangeThread(
    environmentId: string,
    logicalSessionKey: string,
  ): Promise<{ segmentId: string; resourceKey: string } | null> {
    return invoke("changes_get_thread", { environmentId, logicalSessionKey });
  }

  function resolveLiveChangeDetail(input: {
    resourceKey: string;
    revision?: number;
    rowId?: string;
    pathId?: string;
    path?: string;
  }): Promise<ChangesResolveLiveDetailResult> {
    return invoke<ChangesResolveLiveDetailResult>("changes_resolve_live_detail", input);
  }

  function getChangeDiff(
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

  function refreshChanges(resourceKey: string): Promise<ChangesRefreshResult> {
    return invoke<ChangesRefreshResult>("changes_refresh", { resourceKey });
  }

  function prepareChangeRestore(
    measurementId: string,
    pathIds?: readonly string[],
  ): Promise<ChangesPrepareRestoreResult> {
    return invoke<ChangesPrepareRestoreResult>("changes_prepare_restore", {
      measurementId,
      ...(pathIds ? { pathIds: [...pathIds] } : {}),
    });
  }

  function applyChangeRestore(
    actionToken: string,
    idempotencyKey: string,
  ): Promise<ChangesApplyRestoreResult> {
    return invoke<ChangesApplyRestoreResult>("changes_apply_restore", {
      actionToken,
      idempotencyKey,
    });
  }

  function measureLegacyToolPayload(input: {
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

  return {
    getChangeView,
    getChangeFiles,
    getToolChangePresentations,
    getChangeHistory,
    getChangeThread,
    resolveLiveChangeDetail,
    getChangeDiff,
    refreshChanges,
    prepareChangeRestore,
    applyChangeRestore,
    measureLegacyToolPayload,
  };
}

export type ChangesApi = ReturnType<typeof createChangesApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const {
  getChangeView,
  getChangeFiles,
  getToolChangePresentations,
  getChangeHistory,
  getChangeThread,
  resolveLiveChangeDetail,
  getChangeDiff,
  refreshChanges,
  prepareChangeRestore,
  applyChangeRestore,
  measureLegacyToolPayload,
} = createChangesApi(commandBackendClient);
