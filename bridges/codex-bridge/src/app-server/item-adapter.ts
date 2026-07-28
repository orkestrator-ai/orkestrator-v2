/**
 * Adapts app-server `ThreadItem`s onto the SDK's item shape.
 *
 * The two protocols describe the same concepts with different spellings:
 * app-server uses camelCase discriminants (`agentMessage`, `commandExecution`)
 * and richer status enums, while the SDK uses snake_case (`agent_message`,
 * `command_execution`).
 *
 * Adapting *into* the SDK shape — rather than rewriting the renderer — is what
 * keeps `itemToParts`, the subagent timeline reconciler and their existing tests
 * engine-neutral. Both engines then produce byte-identical normalized messages
 * for the same conversation, which is the parity requirement for rollback.
 *
 * Every field is treated as untrusted runtime data: app-server is experimental,
 * so a malformed or unknown item returns null and is counted rather than throwing
 * inside the reducer.
 */
import type { EngineItem } from "../engine/types.js";
import type { CodexCollabAgentStatus, CodexCollabToolCallItem } from "../codex-collaboration.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** app-server `inProgress` → SDK `in_progress`; `declined` has no SDK peer. */
function commandStatus(value: unknown): "in_progress" | "completed" | "failed" {
  switch (value) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    // A declined command did not run and will not; surfacing it as failed is the
    // closest honest mapping — "in progress" would spin forever in the UI.
    case "declined":
      return "failed";
    default:
      return "in_progress";
  }
}

/** SDK `PatchApplyStatus` is only completed|failed, so in-progress folds in. */
function patchStatus(value: unknown): "completed" | "failed" {
  return value === "failed" || value === "declined" ? "failed" : "completed";
}

/** app-server nests the kind in an object; the SDK wants a bare string. */
function changeKind(value: unknown): "add" | "delete" | "update" {
  const type = isRecord(value) ? value.type : value;
  return type === "add" ? "add" : type === "delete" ? "delete" : "update";
}

/** app-server statuses are camelCase; the existing collab code expects snake. */
function collabAgentStatus(value: unknown): CodexCollabAgentStatus | undefined {
  switch (value) {
    case "pendingInit":
      return "pending_init";
    case "running":
      return "running";
    case "interrupted":
      return "interrupted";
    case "completed":
      return "completed";
    case "errored":
      return "errored";
    case "shutdown":
      return "shutdown";
    case "notFound":
      return "not_found";
    default:
      return undefined;
  }
}

function collabToolCallStatus(value: unknown): CodexCollabToolCallItem["status"] {
  switch (value) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "inProgress":
      return "in_progress";
    default:
      return undefined;
  }
}

/** `spawnAgent` → `spawn_agent`, matching the tool names the collab code keys on. */
function collabToolName(value: unknown): string | undefined {
  const tool = str(value);
  if (!tool) return undefined;
  return tool.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export interface ItemAdaptationResult {
  item: EngineItem | null;
  /** Set when the item is structurally valid but has no normalized rendering. */
  unsupportedType?: string;
}

/**
 * Converts one app-server item. Returns `{ item: null }` for shapes we cannot
 * render, with `unsupportedType` set so the caller can count it.
 */
export function adaptAppServerItem(raw: unknown): ItemAdaptationResult {
  if (!isRecord(raw)) return { item: null };
  const id = str(raw.id);
  const type = str(raw.type);
  if (!type) return { item: null };
  // `webSearch`/`sleep`/`imageGeneration` are flattened unions in the protocol,
  // so an id is required for everything we render.
  if (!id) return { item: null, unsupportedType: type };

  switch (type) {
    case "agentMessage":
      return {
        item: { id, type: "agent_message", text: str(raw.text) ?? "" } as EngineItem,
      };

    case "reasoning": {
      // The SDK collapses reasoning to one string. Prefer the summary, which is
      // what the UI has always shown, and fall back to raw content.
      const summary = strArray(raw.summary);
      const content = strArray(raw.content);
      const text = (summary.length > 0 ? summary : content).join("\n\n");
      return { item: { id, type: "reasoning", text } as EngineItem };
    }

    case "commandExecution": {
      const exitCode = typeof raw.exitCode === "number" ? raw.exitCode : undefined;
      return {
        item: {
          id,
          type: "command_execution",
          command: str(raw.command) ?? "",
          aggregated_output: typeof raw.aggregatedOutput === "string" ? raw.aggregatedOutput : "",
          status: commandStatus(raw.status),
          ...(exitCode === undefined ? {} : { exit_code: exitCode }),
        } as EngineItem,
      };
    }

    case "fileChange": {
      const changes = Array.isArray(raw.changes)
        ? raw.changes
            .filter(isRecord)
            .map((change) => ({ path: str(change.path) ?? "", kind: changeKind(change.kind) }))
            .filter((change) => change.path.length > 0)
        : [];
      return {
        item: { id, type: "file_change", changes, status: patchStatus(raw.status) } as EngineItem,
      };
    }

    case "mcpToolCall": {
      const error = isRecord(raw.error) ? str(raw.error.message) : undefined;
      const result = isRecord(raw.result)
        ? {
            content: Array.isArray(raw.result.content) ? raw.result.content : [],
            structured_content: raw.result.structuredContent ?? null,
          }
        : undefined;
      return {
        item: {
          id,
          type: "mcp_tool_call",
          server: str(raw.server) ?? "",
          tool: str(raw.tool) ?? "",
          arguments: raw.arguments ?? {},
          status: commandStatus(raw.status),
          ...(result ? { result } : {}),
          ...(error ? { error: { message: error } } : {}),
        } as EngineItem,
      };
    }

    case "dynamicToolCall": {
      const tool = str(raw.tool);
      if (!tool) return { item: null, unsupportedType: type };
      return {
        item: {
          id,
          type: "dynamic_tool_call",
          ...(str(raw.namespace) ? { namespace: str(raw.namespace)! } : {}),
          tool,
          arguments: raw.arguments,
          content_items: Array.isArray(raw.contentItems) ? raw.contentItems : [],
          // `success` is authoritative for a call that has finished, but it must
          // not settle one that is still running: reporting a terminal outcome
          // for an in-flight call is the same class of mistake as reporting
          // `idle` for a turn that is still executing.
          status: raw.status === "inProgress"
            ? "in_progress"
            : raw.success === false
              ? "failed"
              : commandStatus(raw.status),
        } as EngineItem,
      };
    }

    case "webSearch":
      return { item: { id, type: "web_search", query: str(raw.query) ?? "" } as EngineItem };

    case "plan":
      return { item: { id, type: "plan", text: str(raw.text) ?? "" } };

    /**
     * Multi-agent collaboration. Mapped to the existing snake_case shape so the
     * rollout-based subagent reconciler and its tests keep working while native
     * items are validated against them.
     */
    case "collabAgentToolCall": {
      const tool = collabToolName(raw.tool);
      if (!tool) return { item: null, unsupportedType: type };
      const agentsStates: Record<string, { status?: CodexCollabAgentStatus; message?: string | null }> =
        {};
      if (isRecord(raw.agentsStates)) {
        for (const [agentId, state] of Object.entries(raw.agentsStates)) {
          if (!isRecord(state)) continue;
          const status = collabAgentStatus(state.status);
          const message = state.message === null ? null : str(state.message);
          if (status || message !== undefined) {
            agentsStates[agentId] = { ...(status ? { status } : {}), message };
          }
        }
      }
      const status = collabToolCallStatus(raw.status);
      const prompt = raw.prompt === null ? null : str(raw.prompt);
      return {
        item: {
          id,
          type: "collab_tool_call",
          tool,
          ...(str(raw.senderThreadId) ? { sender_thread_id: str(raw.senderThreadId) } : {}),
          receiver_thread_ids: strArray(raw.receiverThreadIds),
          ...(prompt !== undefined ? { prompt } : {}),
          ...(status ? { status } : {}),
          agents_states: agentsStates,
        } satisfies CodexCollabToolCallItem,
      };
    }

    case "subAgentActivity": {
      const agentThreadId = str(raw.agentThreadId);
      if (!agentThreadId) return { item: null, unsupportedType: type };
      const kind = raw.kind;
      return {
        item: {
          id,
          type: "subagent_activity",
          activity:
            kind === "interacted" ? "interacted" : kind === "interrupted" ? "interrupted" : "started",
          agent_thread_id: agentThreadId,
          ...(str(raw.agentPath) ? { agent_path: str(raw.agentPath)! } : {}),
        },
      };
    }

    /**
     * Structurally understood but intentionally not rendered.
     *
     * `userMessage` is the prompt itself — it is used for dispatch reconciliation
     * via `clientId`, never drawn as part of the assistant's reply. The rest have
     * no place in the current UI; they are named explicitly so a genuinely new
     * item type is still distinguishable from these.
     */
    case "userMessage":
    case "hookPrompt":
    case "imageView":
    case "imageGeneration":
    case "sleep":
    case "enteredReviewMode":
    case "exitedReviewMode":
    case "contextCompaction":
      return { item: null, unsupportedType: type };

    default:
      return { item: null, unsupportedType: type };
  }
}

/**
 * Builds a `todo_list` item from a `turn/plan/updated` notification.
 *
 * app-server reports the plan as a turn-level notification rather than an item,
 * but the UI has always rendered it as a todo list, so it is synthesized into one
 * under a stable per-turn id.
 */
export function planUpdateToTodoList(
  turnId: string,
  plan: unknown,
): EngineItem | null {
  if (!Array.isArray(plan)) return null;
  const items = plan
    .filter(isRecord)
    .map((step) => ({
      text: str(step.step) ?? "",
      completed: step.status === "completed",
    }))
    .filter((step) => step.text.length > 0);
  if (items.length === 0) return null;

  // Stable id: successive plan updates replace one another rather than stacking.
  return { id: `plan-${turnId}`, type: "todo_list", items } as EngineItem;
}

/** Extracts `clientId` from a persisted `userMessage`, for dispatch recovery. */
export function userMessageClientId(raw: unknown): string | null {
  if (!isRecord(raw) || raw.type !== "userMessage") return null;
  return typeof raw.clientId === "string" ? raw.clientId : null;
}
