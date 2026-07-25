/**
 * Interactive approval requests: the descriptor the UI renders, and the mapping
 * from a user's answer back onto each method's protocol response shape.
 *
 * Kept separate from the router so the *policy* (which methods can be answered by
 * a human, and what each answer means on the wire) is readable in one place. The
 * router owns lifetime and the never-leave-a-request-unanswered guarantee.
 *
 * Design constraints:
 *
 *  - **Deny is the safe default.** Every timeout, disconnect, generation death and
 *    unparseable answer resolves to a denial. Approving by accident would run a
 *    command the user never saw.
 *  - **The descriptor carries no payload we would not show.** It is emitted over
 *    SSE to the renderer, so it holds the command, the paths, and the reason —
 *    the same things the UI displays — and nothing else.
 *  - **Response shapes are per-method and not interchangeable.** `decision` is a
 *    plain string for the v2 methods and a nested object for the legacy ones; the
 *    permissions method answers with a grant profile instead of a decision.
 */
import type { EngineGeneration } from "../engine/types.js";

/** Methods a human can meaningfully answer. */
export const INTERACTIVE_APPROVAL_METHODS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
] as const;

export type InteractiveApprovalMethod = (typeof INTERACTIVE_APPROVAL_METHODS)[number];

export function isInteractiveApprovalMethod(method: string): method is InteractiveApprovalMethod {
  return (INTERACTIVE_APPROVAL_METHODS as readonly string[]).includes(method);
}

/** What the request is asking for, which decides the UI copy and icon. */
export type ApprovalKind = "command" | "file-change" | "permissions";

/**
 * The user's answer, normalized across methods.
 *
 * `approve-for-session` is only honoured where the protocol has a matching
 * variant; elsewhere it degrades to `approve` rather than being rejected, since
 * the user's intent ("yes, and stop asking") is still satisfiable as "yes".
 */
export type ApprovalDecision = "approve" | "approve-for-session" | "deny" | "cancel";

export const APPROVAL_DECISIONS: readonly ApprovalDecision[] = [
  "approve",
  "approve-for-session",
  "deny",
  "cancel",
];

export function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return typeof value === "string" && (APPROVAL_DECISIONS as readonly string[]).includes(value);
}

/** Why a pending approval stopped being pending, for the UI and the audit trail. */
export type ApprovalResolution =
  | "answered"
  | "timed-out"
  | "engine-restarted"
  | "session-closed"
  | "auto-declined";

/** One parsed file change in an approval request. */
export interface ApprovalFileChange {
  path: string;
  kind: "add" | "delete" | "update";
}

/**
 * The descriptor sent to the renderer.
 *
 * `approvalId` is ours, not app-server's: a fresh opaque id keeps internal
 * JSON-RPC ids out of URLs and makes the id safe to path-encode.
 */
export interface ApprovalRequest {
  approvalId: string;
  kind: ApprovalKind;
  method: InteractiveApprovalMethod;
  threadId: string | null;
  turnId: string | null;
  itemId: string | null;
  generation: EngineGeneration;
  /** Milliseconds since epoch, from our clock — not app-server's. */
  requestedAt: number;
  /** When this auto-denies, so the UI can show a countdown. */
  expiresAt: number;
  /** Present for command approvals. */
  command?: string;
  cwd?: string;
  /**
   * Present for the legacy `applyPatchApproval`, which carries the changes inline.
   *
   * The v2 `item/fileChange/requestApproval` does **not**: its params are only
   * ids plus a reason, and the changes live on the `fileChange` item the UI
   * already has. So an empty `changes` here is normal, not a parse failure.
   */
  changes?: ApprovalFileChange[];
  /** Present for permission escalation. */
  permissions?: { network: boolean; fileSystem: boolean };
  /** app-server's own explanation, e.g. "needs network access". */
  reason?: string;
  /** Write access being requested for the rest of the session. */
  grantRoot?: string;
  /** Host being reached, for a managed-network prompt. */
  networkHost?: string;
  /** True when the protocol has a real "and stop asking" variant for this method. */
  supportsApproveForSession: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function changeKind(value: unknown): "add" | "delete" | "update" {
  const type = isRecord(value) ? value.type : value;
  return type === "add" ? "add" : type === "delete" ? "delete" : "update";
}

/**
 * The v2 method sends `command` as a string; the legacy one sends `Array<string>`
 * argv. Rendering argv naively would show `["bash","-lc","ls"]` in the prompt, so
 * join it — with the caveat that this is for *display*, never for re-execution.
 */
function commandText(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (Array.isArray(value)) {
    const parts = value.filter((entry): entry is string => typeof entry === "string");
    return parts.length > 0 ? parts.join(" ") : undefined;
  }
  return undefined;
}

/**
 * Builds the renderer-facing descriptor from raw request params.
 *
 * Every field is optional in the protocol and treated as untrusted: a missing
 * command still yields a usable prompt ("Codex wants to run a command") rather
 * than throwing inside the read loop's handoff.
 */
export function describeApproval(options: {
  approvalId: string;
  method: InteractiveApprovalMethod;
  params: unknown;
  generation: EngineGeneration;
  requestedAt: number;
  expiresAt: number;
}): ApprovalRequest {
  const params = isRecord(options.params) ? options.params : {};
  const kind: ApprovalKind =
    options.method === "item/permissions/requestApproval"
      ? "permissions"
      : options.method === "item/fileChange/requestApproval" || options.method === "applyPatchApproval"
        ? "file-change"
        : "command";

  /**
   * `applyPatchApproval` carries `fileChanges` as a path → change map, where the
   * change is an internally-tagged `FileChange`. The v2 method has no changes at
   * all, so this is the only source when it is present.
   */
  const changes = isRecord(params.fileChanges)
    ? Object.entries(params.fileChanges).map(([path, change]) => ({
        path,
        kind: changeKind(isRecord(change) ? change.type : undefined),
      }))
    : undefined;

  const permissions = isRecord(params.permissions)
    ? {
        network: params.permissions.network != null,
        fileSystem: params.permissions.fileSystem != null,
      }
    : undefined;

  const networkContext = isRecord(params.networkApprovalContext)
    ? str(params.networkApprovalContext.host)
    : undefined;

  return {
    approvalId: options.approvalId,
    kind,
    method: options.method,
    // The legacy methods spell the thread `conversationId`.
    threadId: str(params.threadId) ?? str(params.conversationId) ?? null,
    turnId: str(params.turnId) ?? null,
    // Legacy methods use `callId` where v2 uses `itemId`.
    itemId: str(params.itemId) ?? str(params.callId) ?? null,
    generation: options.generation,
    requestedAt: options.requestedAt,
    expiresAt: options.expiresAt,
    ...(commandText(params.command) ? { command: commandText(params.command) } : {}),
    ...(str(params.cwd) ? { cwd: str(params.cwd) } : {}),
    ...(changes?.length ? { changes } : {}),
    ...(permissions ? { permissions } : {}),
    ...(str(params.reason) ? { reason: str(params.reason) } : {}),
    ...(str(params.grantRoot) ? { grantRoot: str(params.grantRoot) } : {}),
    ...(networkContext ? { networkHost: networkContext } : {}),
    /**
     * Every interactive method can express "yes, and stop asking": the v2 methods
     * as `acceptForSession`, the legacy ones as `approved_for_session`, and
     * permissions as `scope: "session"`. Kept as a field rather than hardcoded in
     * the UI so a future method without it can say so.
     */
    supportsApproveForSession: true,
  };
}

export interface ApprovalResponsePayload {
  /** Sent as a successful JSON-RPC result. */
  result: unknown;
}

/**
 * Maps a normalized decision onto the wire shape for one method.
 *
 * `cancel` means "stop the whole turn", which the v2 methods express directly.
 * The legacy methods have no cancel variant, so it degrades to a denial with a
 * rejection string — honest about what actually happens.
 */
export function buildApprovalResponse(
  method: InteractiveApprovalMethod,
  decision: ApprovalDecision,
  rawParams: unknown,
): ApprovalResponsePayload {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval": {
      const wire =
        decision === "approve"
          ? "accept"
          : decision === "approve-for-session"
            ? "acceptForSession"
            : decision === "cancel"
              ? "cancel"
              : "decline";
      return { result: { decision: wire } };
    }

    case "execCommandApproval":
    case "applyPatchApproval": {
      // Legacy `ReviewDecision`: snake_case unit variants plus an externally
      // tagged `denied`. It has a real `abort`, so cancel maps cleanly.
      if (decision === "approve") return { result: { decision: "approved" } };
      if (decision === "approve-for-session") {
        return { result: { decision: "approved_for_session" } };
      }
      if (decision === "cancel") return { result: { decision: "abort" } };
      return {
        result: { decision: { denied: { rejection: "The user declined this action" } } },
      };
    }

    /**
     * Permissions answer with a grant profile, not a decision. Approving echoes
     * back exactly what was requested — never more — and denying grants an empty
     * profile, which lets the turn continue sandboxed instead of erroring out.
     */
    case "item/permissions/requestApproval": {
      const params = isRecord(rawParams) ? rawParams : {};
      const requested = isRecord(params.permissions) ? params.permissions : {};
      const granting = decision === "approve" || decision === "approve-for-session";
      return {
        result: {
          permissions: granting
            ? {
                ...(requested.network != null ? { network: requested.network } : {}),
                ...(requested.fileSystem != null ? { fileSystem: requested.fileSystem } : {}),
              }
            : {},
          scope: decision === "approve-for-session" ? "session" : "turn",
        },
      };
    }
  }

}

/** Human-readable line for the transcript when an approval was not granted. */
export function describeApprovalOutcome(
  request: ApprovalRequest,
  decision: ApprovalDecision,
  resolution: ApprovalResolution,
): string | null {
  if (decision === "approve" || decision === "approve-for-session") return null;

  // Phrased as an object of "asked for", so one template reads correctly for a
  // command, a patch and a permission grant alike.
  const subject =
    request.kind === "command"
      ? request.command
        ? `permission to run \`${request.command}\``
        : "permission to run a command"
      : request.kind === "file-change"
        ? request.changes?.length
          ? `permission to change ${request.changes.length} file(s)`
          : "permission to apply a file change"
        : "additional permissions";

  switch (resolution) {
    case "timed-out":
      return `Codex asked for ${subject}. The request expired without an answer, so it was declined.`;
    case "engine-restarted":
      return `Codex asked for ${subject}, but the Codex process restarted before it was answered.`;
    case "session-closed":
      return `Codex asked for ${subject}, but the session closed before it was answered.`;
    case "auto-declined":
      return `Codex asked for ${subject}. Orkestrator declined it because interactive approval is not available.`;
    case "answered":
      return decision === "cancel"
        ? `You cancelled the turn when Codex asked for ${subject}.`
        : `You declined ${subject}.`;
  }
}
