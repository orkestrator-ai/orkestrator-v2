import type {
  DesignCanvas,
  DesignCanvasState,
  DesignChanges,
  DesignHierarchyPage,
  DesignElement,
} from "@orkestrator/protocol/design-canvas";
import type {
  DesignCapabilities,
  DesignCheckpointPreview,
  DesignCommandResult,
  DesignExportPreview,
  DesignExportReceipt,
  DesignFailure,
  DesignFrameValidation,
  DesignHistoryPage,
  DesignLibraryPage,
  DesignLibraryQuery,
  DesignOperationDescriptor,
  DesignOperationStatus,
  DesignPrepareResult,
  DesignReadiness,
  DesignSessionLink,
  DesignSnapshotResult,
  DesignSyncResult,
} from "@orkestrator/protocol/design-operations";
import { invoke } from "@/lib/native/backend";
import { getGatewayBaseUrl } from "@/lib/gateway-url";

/** A typed design failure; UI branches on `failure.code`, never message text. */
export class DesignClientError extends Error {
  constructor(readonly failure: DesignFailure) {
    super(failure.message);
    this.name = "DesignClientError";
  }
}

export type DesignTransportFailure = "unsupported" | "unauthorized" | "disconnected" | "failed";

/** Classifies a transport rejection without trusting its text for anything but routing. */
export function classifyTransportError(error: unknown): DesignTransportFailure {
  if (error instanceof DesignClientError) return "failed";
  const status = (error as { status?: number } | null)?.status;
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Unknown backend command:")) return "unsupported";
  if (status === 401 || status === 403 || /Authentication required/i.test(message))
    return "unauthorized";
  if (
    (typeof status === "number" && status >= 500) ||
    status === 0 ||
    /fetch|network|disconnect|ECONNREFUSED|not available|Failed to fetch|timed? ?out/i.test(message)
  )
    return "disconnected";
  return "failed";
}

export function failureOf(error: unknown): DesignFailure {
  if (error instanceof DesignClientError) return error.failure;
  const kind = classifyTransportError(error);
  const message = error instanceof Error ? error.message : String(error);
  if (kind === "disconnected")
    return {
      code: "disconnected",
      message: "The backend is unreachable; your edit is kept",
      retry: "review",
    };
  if (kind === "unauthorized")
    return { code: "forbidden", message: "Sign in again to continue editing", retry: "review" };
  if (kind === "unsupported")
    return {
      code: "unsupported",
      message: "This backend does not support that design action",
      retry: "never",
    };
  return {
    code: message.startsWith("Design revision conflict:") ? "conflict" : "storage",
    message: message.slice(0, 300),
    retry: "after-refresh",
  };
}

/** Invokes a typed v2 command and unwraps its envelope. */
export async function designCommand<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const result = await invoke<DesignCommandResult<T>>(command, args);
  if (!result || typeof result !== "object" || !("ok" in result))
    throw new DesignClientError({
      code: "unsupported",
      message: "Unexpected design response",
      retry: "never",
    });
  if (!result.ok) throw new DesignClientError(result.failure);
  return result.value;
}

/** Identity of the connected backend; equal canvas ids on two backends never share state. */
export function designBackendKey(): string {
  return getGatewayBaseUrl() || "local";
}

const capabilities = new Map<string, Promise<DesignCapabilities | null>>();

/** `null` means a v1 backend: use the legacy snapshot/action path. */
export function getCapabilities(backend = designBackendKey()): Promise<DesignCapabilities | null> {
  let cached = capabilities.get(backend);
  if (!cached) {
    cached = designCommand<DesignCapabilities>("design_capabilities").catch((error: unknown) => {
      if (classifyTransportError(error) === "unsupported") return null;
      capabilities.delete(backend);
      throw error;
    });
    capabilities.set(backend, cached);
  }
  return cached;
}

export function resetCapabilities() {
  capabilities.clear();
}

// Legacy v1 surface (retained for old backends and existing callers).
export function designAction<T>(
  environmentId: string,
  action: string,
  input: Record<string, unknown> = {},
): Promise<T> {
  return invoke<T>("design_action", { environmentId, action, input });
}
export function getCanvas(environmentId: string, canvasId: string) {
  return designAction<DesignCanvas>(environmentId, "get_canvas", { canvasId });
}
export function getCanvasState(environmentId: string, canvasId: string) {
  return designAction<DesignCanvasState>(environmentId, "get_canvas_state", { canvasId });
}
export function getChanges(
  environmentId: string,
  canvasId: string,
  generation: string | undefined,
  after: number,
) {
  return invoke<DesignChanges>("design_changes", { environmentId, canvasId, generation, after });
}

// Protocol v2.
export const designApi = {
  readiness: (probe = false) => designCommand<DesignReadiness>("design_readiness", { probe }),
  snapshot: (environmentId: string, canvasId: string) =>
    designCommand<DesignSnapshotResult>("design_snapshot", { environmentId, canvasId }),
  sync: (
    environmentId: string,
    canvasId: string,
    generation: string | undefined,
    after: number,
    statusVersion: number | undefined,
  ) =>
    designCommand<DesignSyncResult>("design_sync", {
      environmentId,
      canvasId,
      generation,
      after,
      statusVersion,
    }),
  prepare: (environmentId: string, descriptor: DesignOperationDescriptor) =>
    designCommand<DesignPrepareResult>("design_prepare", { environmentId, descriptor }),
  execute: (environmentId: string, canvasId: string, token: string, waitMs?: number) =>
    designCommand<DesignOperationStatus>("design_execute", {
      environmentId,
      canvasId,
      token,
      waitMs,
    }),
  status: (environmentId: string, canvasId: string, token: string) =>
    designCommand<DesignOperationStatus>("design_operation_status", {
      environmentId,
      canvasId,
      token,
    }),
  cancel: (environmentId: string, canvasId: string, token: string) =>
    designCommand<DesignOperationStatus>("design_cancel", { environmentId, canvasId, token }),
  library: (environmentId: string, query: DesignLibraryQuery) =>
    designCommand<DesignLibraryPage>("design_library", { environmentId, query }),
  purge: (environmentId: string, canvasId: string) =>
    designCommand<{ purged: true }>("design_purge", { environmentId, canvasId }),
  history: (environmentId: string, canvasId: string, offset?: number, limit?: number) =>
    designCommand<DesignHistoryPage>("design_history", { environmentId, canvasId, offset, limit }),
  checkpoint: (
    environmentId: string,
    canvasId: string,
    entryId: string,
    side: "before" | "after",
  ) =>
    designCommand<DesignCheckpointPreview>("design_checkpoint", {
      environmentId,
      canvasId,
      entryId,
      side,
    }),
  exportPreview: (environmentId: string, canvasId: string, relativePath?: string) =>
    designCommand<DesignExportPreview>("design_export_preview", {
      environmentId,
      canvasId,
      relativePath,
    }),
  exportSave: (
    environmentId: string,
    canvasId: string,
    relativePath: string,
    revision: number,
    replaceFingerprint?: string,
  ) =>
    designCommand<DesignExportReceipt>("design_export_save", {
      environmentId,
      canvasId,
      relativePath,
      revision,
      replaceFingerprint,
    }),
  exportReconcile: (environmentId: string, canvasId: string) =>
    designCommand<{ state: string; receipt?: DesignExportReceipt }>("design_export_reconcile", {
      environmentId,
      canvasId,
    }),
  validate: (environmentId: string, canvasId: string, frameId: string) =>
    designCommand<DesignFrameValidation | null>("design_validate", {
      environmentId,
      canvasId,
      frameId,
    }),
  hierarchy: (
    environmentId: string,
    canvasId: string,
    frameId: string,
    query: { rootSelector?: string; cursor?: string; maxNodes?: number; maxDepth?: number },
  ) =>
    designCommand<{ revision: number; structureId: string; page: DesignHierarchyPage }>(
      "design_hierarchy",
      {
        environmentId,
        canvasId,
        frameId,
        ...query,
      },
    ),
  inspect: (environmentId: string, canvasId: string, frameId: string, selector: string) =>
    designAction<{ revision: number; structureId: string; element: DesignElement }>(
      environmentId,
      "inspect_element",
      {
        canvasId,
        frameId,
        selector,
      },
    ),
  capture: (
    environmentId: string,
    canvasId: string,
    frameId: string,
    priority?: "interactive" | "background",
  ) =>
    designCommand<{
      revision: number;
      contentId: string;
      viewportId: string;
      data: string;
      mimeType: string;
    }>("design_capture", { environmentId, canvasId, frameId, priority }),
  linkSession: (
    environmentId: string,
    canvasId: string,
    link: Omit<DesignSessionLink, "id" | "createdAt">,
    replaceId?: string,
  ) =>
    designCommand<DesignSessionLink>("design_session_link", {
      environmentId,
      canvasId,
      link,
      replaceId,
    }),
  unlinkSession: (environmentId: string, canvasId: string, linkId: string) =>
    designCommand<{ unlinked: true }>("design_session_unlink", { environmentId, canvasId, linkId }),
};
