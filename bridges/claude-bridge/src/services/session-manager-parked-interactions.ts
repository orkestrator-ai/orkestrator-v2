import type {
  CanUseTool,
  ElicitationRequest,
  ElicitationResult,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import { AGENT_INTERACTION_LIMITS } from "@orkestrator/protocol/agent-interactions";
import type {
  ClaudeElicitationRequest,
  ClaudeInteractionOutcome,
  ClaudeInteractionRequest,
  ClaudeToolApprovalRequest,
  SessionState,
} from "../types/index.js";
import { eventEmitter } from "./event-emitter.js";
import {
  INTERACTION_TIMEOUT_MS,
  generateMessageId,
  interactionResolvers,
  pendingInteractions,
} from "./session-manager-core.js";
import { appendTranscriptNotice } from "./session-manager-prompt-handlers/transcript-notice.js";

// MCP elicitations and tool approvals, held until the user answers them
// through `/session/:id/interactions`, the deadline passes, or the turn that
// raised them goes away. Questions and plan approvals keep their own stores
// and routes; the backend maps all of them onto the one interaction card.

/** Longest tool input shown on a generic permission card. */
const MAX_TOOL_INPUT_PREVIEW_LENGTH = 2_000;
const FILE_TOOLS: ReadonlySet<string> = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

function bounded(value: unknown, maximum: number = AGENT_INTERACTION_LIMITS.maxTextLength) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

/**
 * Hold `request` until it is answered, expires or is withdrawn.
 *
 * A request id the SDK redelivers replaces the earlier entry; each waiter only
 * removes its own entry, so the older one cannot delete its replacement.
 */
export async function parkInteraction(
  request: ClaudeInteractionRequest,
  signal?: AbortSignal,
): Promise<ClaudeInteractionOutcome> {
  if (signal?.aborted) return { action: "withdrawn" };
  let resolveOutcome!: (outcome: ClaudeInteractionOutcome) => void;
  const outcome = new Promise<ClaudeInteractionOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  const timeout = setTimeout(() => resolveOutcome({ action: "timeout" }), INTERACTION_TIMEOUT_MS);
  const withdraw = () => resolveOutcome({ action: "withdrawn" });
  signal?.addEventListener("abort", withdraw, { once: true });
  // Store and register the resolver before announcing the request, so an
  // instant answer can never find it missing.
  interactionResolvers.get(request.id)?.({ action: "withdrawn" });
  pendingInteractions.set(request.id, request);
  interactionResolvers.set(request.id, resolveOutcome);
  eventEmitter.emit({ type: "interaction.requested", sessionId: request.sessionId, data: request });
  const settled = await outcome;
  clearTimeout(timeout);
  signal?.removeEventListener("abort", withdraw);
  if (pendingInteractions.get(request.id) === request) pendingInteractions.delete(request.id);
  if (interactionResolvers.get(request.id) === resolveOutcome) {
    interactionResolvers.delete(request.id);
  }
  eventEmitter.emit({
    type: "interaction.resolved",
    sessionId: request.sessionId,
    data: { requestId: request.id, action: settled.action },
  });
  return settled;
}

/**
 * Answer an MCP server's elicitation by parking it for the user.
 *
 * A request the card cannot render (a `url` request without a URL, or a form
 * schema too large to carry) is declined on the spot, with a status row
 * naming the server so the user knows where to go. MCP defines `decline` as
 * an outcome the server handles; anything other than an answer is `cancel`.
 */
export async function answerClaudeElicitation(
  session: SessionState,
  sessionId: string,
  request: ElicitationRequest,
  options: { signal: AbortSignal; requestId: string },
): Promise<ElicitationResult> {
  const now = Date.now();
  const serverName = bounded(request.serverName, 256) ?? "An MCP server";
  const url = request.mode === "url" ? bounded(request.url) : undefined;
  const schema =
    request.mode === "url" ? undefined : (request.requestedSchema ?? { type: "object" });
  const schemaText = schema === undefined ? "" : JSON.stringify(schema);
  if (
    (request.mode === "url" && (!url || url !== request.url)) ||
    new TextEncoder().encode(schemaText).byteLength > AGENT_INTERACTION_LIMITS.maxTextLength
  ) {
    appendTranscriptNotice(session, sessionId, (event) => eventEmitter.emit(event), {
      type: "status",
      severity: "warning",
      content:
        request.mode === "url"
          ? `${serverName} asked you to sign in through a link this tab cannot open. Complete it in a terminal and try again.`
          : `${serverName} asked for input this tab cannot collect, so it was declined.`,
      createdAt: new Date(now).toISOString(),
    });
    return { action: "decline" };
  }
  const title = bounded(request.title, 256);
  const elicitationId =
    typeof request.elicitationId === "string" &&
    request.elicitationId.length <= AGENT_INTERACTION_LIMITS.maxIdLength
      ? request.elicitationId
      : undefined;
  const parked: ClaudeElicitationRequest = {
    id: options.requestId || generateMessageId(),
    sessionId,
    kind: request.mode === "url" ? "mcp-url" : "mcp-form",
    serverName,
    message: bounded(request.message) ?? "",
    requestedAt: now,
    expiresAt: now + INTERACTION_TIMEOUT_MS,
    ...(title ? { title } : {}),
    ...(schema ? { schema } : {}),
    ...(url ? { url } : {}),
    ...(elicitationId ? { elicitationId } : {}),
  };
  const outcome = await parkInteraction(parked, options.signal);
  if (outcome.action === "accept") {
    return outcome.content ? { action: "accept", content: outcome.content } : { action: "accept" };
  }
  return { action: outcome.action === "decline" ? "decline" : "cancel" };
}

/**
 * Ask the user whether a tool call may run, under the `ask` policy.
 *
 * Fails closed: anything but an explicit approval denies. `cancel` also stops
 * the turn, which is what the card's "Cancel turn" means. An allow never
 * carries the SDK's `suggestions`: they are durable rules, and an allow-once
 * decision must not widen permissions.
 */
export async function requestClaudeToolApproval(
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>,
  permissionContext: Parameters<CanUseTool>[2],
): Promise<PermissionResult> {
  const now = Date.now();
  const path = bounded(input.file_path ?? input.notebook_path);
  const command = bounded(input.command);
  // A command or file card is only offered with the command or path it is
  // about; anything else gets the generic card showing the raw input.
  let detail: Pick<ClaudeToolApprovalRequest, "kind" | "command" | "paths" | "input">;
  if (toolName === "Bash" && command) {
    detail = { kind: "command-approval", command };
  } else if (FILE_TOOLS.has(toolName) && path) {
    detail = { kind: "file-approval", paths: [path] };
  } else {
    let inputPreview: string | undefined;
    try {
      inputPreview = bounded(JSON.stringify(input), MAX_TOOL_INPUT_PREVIEW_LENGTH);
    } catch {
      inputPreview = undefined;
    }
    detail = { kind: "permission", ...(inputPreview ? { input: inputPreview } : {}) };
  }
  const title = bounded(permissionContext?.title, 512);
  const description = bounded(permissionContext?.description, 1_024);
  const reason = bounded(permissionContext?.decisionReason, 1_024);
  const blockedPath = bounded(permissionContext?.blockedPath, 1_024);
  const mcpServer = bounded(permissionContext?.mcpServer?.name, 256);
  const request: ClaudeToolApprovalRequest = {
    id: permissionContext?.requestId || generateMessageId(),
    sessionId,
    ...detail,
    toolName: bounded(toolName, 256) ?? "tool",
    requestedAt: now,
    expiresAt: now + INTERACTION_TIMEOUT_MS,
    ...(permissionContext?.toolUseID ? { toolUseId: permissionContext.toolUseID } : {}),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(reason ? { reason } : {}),
    ...(blockedPath ? { blockedPath } : {}),
    ...(mcpServer ? { mcpServer } : {}),
  };
  const outcome = await parkInteraction(request, permissionContext?.signal);
  switch (outcome.action) {
    case "accept":
      return { behavior: "allow", updatedInput: input };
    case "cancel":
      return {
        behavior: "deny",
        message: "The user denied this tool call and stopped the turn.",
        interrupt: true,
      };
    case "timeout":
      return { behavior: "deny", message: "Approval timed out after 5 minutes" };
    case "withdrawn":
      return { behavior: "deny", message: "The approval request was withdrawn" };
    default:
      return { behavior: "deny", message: "The user denied this tool call." };
  }
}
