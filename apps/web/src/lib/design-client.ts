import type { DesignCanvas, DesignElement } from "@orkestrator/protocol/design-canvas";
import type {
  DesignCapabilities,
  DesignCommandResult,
  DesignFailure,
  DesignIntentDraft,
  DesignLibraryQuery,
  DesignOperationDescriptor,
  DesignPreconditions,
  DesignSessionLink,
} from "@orkestrator/protocol/design-operations";
import { incompatibilityOfAnyCommand } from "@orkestrator/protocol/contract/errors";
import {
  designActionCommand,
  designClient,
  designImportCommand,
  designImportHostFileCommand,
  designCancelCommand,
  designCaptureCommand,
  designCheckpointCommand,
  designExecuteCommand,
  designExportPreviewCommand,
  designExportReconcileCommand,
  designExportSaveCommand,
  designHierarchyCommand,
  designHistoryCommand,
  designIntentDiscardCommand,
  designIntentImportCommand,
  designIntentResumeCommand,
  designIntentRunCommand,
  designIntentSaveCommand,
  designIntentsCommand,
  designLibraryCommand,
  designOpenFileCommand,
  designOperationStatusCommand,
  designPrepareCommand,
  designPurgeCommand,
  designReadinessCommand,
  designSessionLinkCommand,
  designSessionLinkStatesCommand,
  designSessionResumeCommand,
  designSessionUnlinkCommand,
  designSnapshotCommand,
  designSyncCommand,
  designValidateCommand,
  type DesignApi,
  type DesignCommandDef,
} from "@orkestrator/protocol/contract/domains/design";
import type { ArgsOf, ResultOf } from "@orkestrator/protocol/contract/command";
import { scopeBackendClient } from "@/lib/backend/client";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope, defineScopedSlot, isAppCommandScope } from "@/lib/node-scope-slots";
import { getGatewayBaseUrl } from "@/lib/gateway-url";
import { domainApi } from "@/lib/node-scope/domains/domain-api";

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
  if (incompatibilityOfAnyCommand(error)) return "unsupported";
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

/**
 * Unwraps a v2 envelope: the value, or the typed failure thrown as a
 * `DesignClientError`. A legacy node's answer is not decoded (the domain
 * client's adapter 0), so its shape is checked here as before.
 */
function unwrap<T>(result: DesignCommandResult<T> | unknown): T {
  if (!result || typeof result !== "object" || !("ok" in result))
    throw new DesignClientError({
      code: "unsupported",
      message: "Unexpected design response",
      retry: "never",
    });
  const envelope = result as DesignCommandResult<T>;
  if (!envelope.ok) throw new DesignClientError(envelope.failure);
  return envelope.value;
}

/**
 * The design domain client of one node scope (plan item 7004): the adapter
 * its negotiated `design` version picks, over the scope's factory client
 * (`@/lib/backend/client`), whose app-command-scope form is
 * `@/lib/native/backend` `invoke`.
 */
const scopeDesign = defineScopedSlot("design-domain", (scope) => {
  const client = scopeBackendClient(scope);
  return () => domainApi(client, designClient);
});

function design(scope?: NodeScope): DesignApi {
  return scopeDesign(scope)();
}

/** Runs a v2 design command on `scope`'s node (default: the command node's) and unwraps it. */
async function v2<C extends DesignCommandDef>(
  def: C,
  args: ArgsOf<C>,
  scope?: NodeScope,
): Promise<V2Value<C>> {
  return unwrap(await design(scope).command(def, args)) as V2Value<C>;
}

/** The value of a v2 command's envelope. */
type V2Value<C extends DesignCommandDef> =
  Extract<ResultOf<C>, { ok: true }> extends {
    value: infer V;
  }
    ? V
    : never;

/** Identity of the connected backend; equal canvas ids on two backends never share state. */
export function designBackendKey(): string {
  return getGatewayBaseUrl() || "local";
}

/**
 * Identity of `scope`'s backend: the window's gateway on the app's command
 * scope (unchanged), the node id elsewhere (plan items 3012, 4007).
 */
export function designBackendKeyFor(scope: NodeScope): string {
  return isAppCommandScope(scope) ? designBackendKey() : scope.nodeId;
}

/**
 * One node's answers, held on its scope (plan item 3016), by backend key: the
 * command scope's backend key moves with the window's gateway.
 */
const scopeCapabilities = defineScopedSlot(
  "design-capabilities",
  () => new Map<string, Promise<DesignCapabilities>>(),
);

/**
 * Every backend in the support window serves `design_capabilities` (it shipped
 * in v2.21.0, the floor), so a backend without it is too old for the canvas and
 * gets a typed failure rather than a v1 fallback. Failures are not cached.
 * Cached per node scope (default: the command node's).
 */
export function getCapabilities(
  backend = designBackendKey(),
  scope?: NodeScope,
): Promise<DesignCapabilities> {
  const target = scope ?? appCommandScope();
  const capabilities = scopeCapabilities(target);
  let cached = capabilities.get(backend);
  if (!cached) {
    cached = design(target)
      .capabilities()
      .then((result) => unwrap<DesignCapabilities>(result))
      .catch((error: unknown) => {
        capabilities.delete(backend);
        if (classifyTransportError(error) === "unsupported")
          throw new DesignClientError({
            code: "unsupported",
            message: "This backend is too old for the design canvas. Update it to continue.",
            retry: "never",
          });
        throw error;
      });
    capabilities.set(backend, cached);
  }
  return cached;
}

export function resetCapabilities(scope?: NodeScope) {
  scopeCapabilities(scope).clear();
}

// The `design_action` surface, still used for canvas lifecycle and listing.
// Each action answers its own record, so the caller names the type.
export async function designAction<T>(
  environmentId: string,
  action: string,
  input: Record<string, unknown>,
  /** The canvas's node (plan items 3012, 4007). */
  scope: NodeScope,
): Promise<T> {
  return (await design(scope).command(designActionCommand, { environmentId, action, input })) as T;
}
/** Imports a serialized `.orkdes` document as a new canvas on `scope`'s node. */
export function importDesignDocument(
  environmentId: string,
  document: string,
  scope: NodeScope,
): Promise<DesignCanvas> {
  return design(scope).command(designImportCommand, { environmentId, document });
}
/** Imports an `.orkdes` file `scope`'s backend reads from its host. */
export function importDesignHostFile(
  environmentId: string,
  path: string,
  scope: NodeScope,
): Promise<DesignCanvas> {
  return design(scope).command(designImportHostFileCommand, { environmentId, path });
}

// Protocol v2.
/**
 * The v2 design commands on `scope`'s node (plan item 3012). Every caller
 * names its canvas's node through `designApiFor(scope)`; there is no
 * command-bound default (plan item 4007), so one canvas never splits its
 * operations across two nodes.
 */
function createDesignApi(scope: NodeScope) {
  const call = <C extends DesignCommandDef>(def: C, args: ArgsOf<C>) => v2(def, args, scope);
  return {
    readiness: (probe = false) => call(designReadinessCommand, { probe }),
    snapshot: (environmentId: string, canvasId: string) =>
      call(designSnapshotCommand, { environmentId, canvasId }),
    sync: (
      environmentId: string,
      canvasId: string,
      generation: string | undefined,
      after: number,
      statusVersion: number | undefined,
    ) =>
      call(designSyncCommand, {
        environmentId,
        canvasId,
        generation,
        after,
        statusVersion,
      }),
    prepare: (environmentId: string, descriptor: DesignOperationDescriptor) =>
      call(designPrepareCommand, { environmentId, descriptor }),
    execute: (environmentId: string, canvasId: string, token: string, waitMs?: number) =>
      call(designExecuteCommand, {
        environmentId,
        canvasId,
        token,
        waitMs,
      }),
    status: (environmentId: string, canvasId: string, token: string) =>
      call(designOperationStatusCommand, {
        environmentId,
        canvasId,
        token,
      }),
    cancel: (environmentId: string, canvasId: string, token: string) =>
      call(designCancelCommand, { environmentId, canvasId, token }),
    /** The document's backend-owned intent queue, reconciled from backend state. */
    intents: (environmentId: string, canvasId: string) =>
      call(designIntentsCommand, { environmentId, canvasId }),
    saveIntents: (
      environmentId: string,
      canvasId: string,
      clientId: string,
      drafts: DesignIntentDraft[],
    ) =>
      call(designIntentSaveCommand, {
        environmentId,
        canvasId,
        clientId,
        drafts,
      }),
    /** One-time import of this browser's legacy localStorage intents. */
    importIntents: (
      environmentId: string,
      canvasId: string,
      clientId: string,
      intents: unknown[],
    ) =>
      call(designIntentImportCommand, {
        environmentId,
        canvasId,
        clientId,
        intents,
      }),
    runIntent: (
      environmentId: string,
      canvasId: string,
      intent: DesignIntentDraft,
      waitMs?: number,
    ) =>
      call(designIntentRunCommand, {
        environmentId,
        canvasId,
        intent,
        waitMs,
      }),
    resumeIntent: (
      environmentId: string,
      canvasId: string,
      intentId: string,
      clientId: string,
      rebaseTo?: DesignPreconditions,
    ) =>
      call(designIntentResumeCommand, {
        environmentId,
        canvasId,
        intentId,
        clientId,
        rebaseTo,
      }),
    discardIntent: (environmentId: string, canvasId: string, intentId: string) =>
      call(designIntentDiscardCommand, {
        environmentId,
        canvasId,
        intentId,
      }),
    library: (environmentId: string, query: DesignLibraryQuery) =>
      call(designLibraryCommand, { environmentId, query }),
    purge: (environmentId: string, canvasId: string) =>
      call(designPurgeCommand, { environmentId, canvasId }),
    history: (environmentId: string, canvasId: string, offset?: number, limit?: number) =>
      call(designHistoryCommand, { environmentId, canvasId, offset, limit }),
    checkpoint: (
      environmentId: string,
      canvasId: string,
      entryId: string,
      side: "before" | "after",
    ) =>
      call(designCheckpointCommand, {
        environmentId,
        canvasId,
        entryId,
        side,
      }),
    exportPreview: (environmentId: string, canvasId: string, relativePath?: string) =>
      call(designExportPreviewCommand, {
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
      call(designExportSaveCommand, {
        environmentId,
        canvasId,
        relativePath,
        revision,
        replaceFingerprint,
      }),
    /** Opens a repository `.orkdes` file as a canvas (reusing one already made from it). */
    openFile: (environmentId: string, relativePath: string) =>
      call(designOpenFileCommand, {
        environmentId,
        relativePath,
      }),
    exportReconcile: (environmentId: string, canvasId: string) =>
      call(designExportReconcileCommand, {
        environmentId,
        canvasId,
      }),
    validate: (environmentId: string, canvasId: string, frameId: string) =>
      call(designValidateCommand, {
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
      call(designHierarchyCommand, {
        environmentId,
        canvasId,
        frameId,
        ...query,
      }),
    inspect: (environmentId: string, canvasId: string, frameId: string, selector: string) =>
      designAction<{ revision: number; structureId: string; element: DesignElement }>(
        environmentId,
        "inspect_element",
        {
          canvasId,
          frameId,
          selector,
        },
        scope,
      ),
    capture: (
      environmentId: string,
      canvasId: string,
      frameId: string,
      priority?: "interactive" | "background",
    ) => call(designCaptureCommand, { environmentId, canvasId, frameId, priority }),
    linkSession: (
      environmentId: string,
      canvasId: string,
      link: Omit<DesignSessionLink, "id" | "createdAt">,
      replaceId?: string,
    ) =>
      call(designSessionLinkCommand, {
        environmentId,
        canvasId,
        link,
        replaceId,
      }),
    /** One storage read per link on the backend; call on demand, never on a timer. */
    sessionLinkStates: (environmentId: string, canvasId: string) =>
      call(designSessionLinkStatesCommand, {
        environmentId,
        canvasId,
      }),
    resumeSessionLink: (
      environmentId: string,
      canvasId: string,
      input: { linkId: string; expectedTabId: string; tabId: string },
    ) =>
      call(designSessionResumeCommand, {
        environmentId,
        canvasId,
        ...input,
      }),
    unlinkSession: (environmentId: string, canvasId: string, linkId: string) =>
      call(designSessionUnlinkCommand, { environmentId, canvasId, linkId }),
  };
}

export type DesignV2Api = ReturnType<typeof createDesignApi>;

const scopeDesignApis = defineScopedSlot("design-v2-api", (scope) => createDesignApi(scope));

/** `scope`'s node's v2 design commands, made once per scope. */
export function designApiFor(scope: NodeScope): DesignV2Api {
  return scopeDesignApis(scope);
}
