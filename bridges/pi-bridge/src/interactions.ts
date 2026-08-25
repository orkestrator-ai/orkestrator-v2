/**
 * The approval gate.
 *
 * Pi ships no permission system — "primitives, not features" is its stated
 * design, and a gate is something you build on the `tool_call` extension hook.
 * This is that gate, and it is off unless `PI_BRIDGE_REQUIRE_APPROVAL=1`,
 * matching the permissive default every other bridge here uses: an Orkestrator
 * agent tab is an interactive session in an already-isolated worktree or
 * container, and the container boundary is what isolates an agent.
 *
 * When it *is* on, the one rule that matters is that nothing approves by
 * default. A timeout, a disconnected renderer, a session closing and a
 * malformed answer all deny, because approving on a technicality runs a
 * command the user never saw.
 *
 * The wire shape is the one the backend's shared interaction mapper already
 * parses for a non-Claude, non-ACP bridge. Answering it identically is what
 * lets Pi approvals render through the same cards as every other platform's.
 */
import { randomBytes } from "node:crypto";
import {
  approvalTimeoutMs,
  approvalsEnabled,
  MAX_PENDING_APPROVALS,
  MAX_TOOL_ARGUMENT_BYTES,
  workingDirectory,
} from "./config.js";
import { schedulePersist } from "./persistence.js";
import { isObject, nonBlank, type JsonObject, type SessionState } from "./state.js";

/** Built-ins that only observe. Gating these is noise, not safety. */
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

export interface ToolCallDecision {
  block: boolean;
  reason?: string;
}

/**
 * Ask the user whether this tool call may run, and wait for the answer.
 *
 * The one place in the bridge that blocks a turn on a person. It is called
 * from Pi's `tool_call` hook, which is allowed to be async — that is the whole
 * reason the gate can exist at all.
 */
export async function requestToolApproval(
  state: SessionState,
  toolCallId: string,
  toolName: string,
  input: unknown,
): Promise<ToolCallDecision> {
  if (!approvalsEnabled()) return { block: false };
  if (READ_ONLY_TOOLS.has(toolName)) return { block: false };
  if (state.approvals.size >= MAX_PENDING_APPROVALS) {
    // Refusing is the only safe answer: parking it would grow the map without
    // bound, and letting it through would approve on a resource limit.
    return { block: true, reason: "Too many tool calls are already awaiting approval." };
  }

  const id = randomBytes(12).toString("hex");
  const now = Date.now();
  return new Promise<ToolCallDecision>((resolve) => {
    let settled = false;
    const settle = (decision: "allow" | "deny", reason?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.approvals.delete(id);
      state.revision += 1;
      resolve(
        decision === "allow"
          ? { block: false }
          : { block: true, reason: reason || "The user denied this tool call." },
      );
    };

    // Read per call rather than at import, so a bridge started with a
    // different budget — or a test proving the denial — gets the value that is
    // actually configured rather than whichever one loaded first.
    const timeoutMs = approvalTimeoutMs();
    const timer = setTimeout(
      () => settle("deny", "The approval request expired before it was answered."),
      timeoutMs,
    );
    // Unref'd so a parked approval cannot by itself hold the process open; the
    // turn awaiting it is what keeps the bridge alive, and shutdown denies.
    timer.unref();

    state.approvals.set(id, {
      id,
      toolCallId,
      toolName,
      input: isObject(input) ? input : {},
      createdAt: now,
      expiresAt: now + timeoutMs,
      settle,
    });
    state.revision += 1;
    schedulePersist();
  });
}

/**
 * Answer one parked approval.
 *
 * Returns false when the id names nothing, which the HTTP layer reports as a
 * 404 so the backend reconciles rather than retrying against a request that
 * has already been settled by a timeout or a closing session.
 */
export function resolveApproval(
  state: SessionState,
  approvalId: string,
  decision: "allow" | "deny",
  reason?: string,
): boolean {
  const pending = state.approvals.get(approvalId);
  if (!pending) return false;
  pending.settle(decision, reason);
  return true;
}

/**
 * Deny every approval this session is holding.
 *
 * Called when the session is closed, aborted or the process is shutting down.
 * A live turn must always be answered — forgetting one leaves it awaiting a
 * promise nothing will ever settle, which wedges the turn and, with it, the
 * environment's activity state.
 */
export function denyAllApprovals(state: SessionState, reason: string): void {
  for (const pending of Array.from(state.approvals.values())) {
    pending.settle("deny", reason);
  }
}

/**
 * Project the parked approvals as the backend's interaction snapshot.
 *
 * `kind` is chosen from what the call can be described as *precisely*: a shell
 * command is a command, an edit or a write is a file change. A custom tool
 * from a project extension is also reported as a command — it is an operation
 * the model asked to run, and naming it with its bounded arguments is the only
 * description this bridge can honestly give for a tool it has never seen.
 */
export function publicApprovals(state: SessionState): JsonObject {
  const approvals = Array.from(state.approvals.values()).map((pending) => {
    const base = {
      approvalId: pending.id,
      requestedAt: pending.createdAt,
      expiresAt: pending.expiresAt,
      reason: `Pi requested to run the ${pending.toolName} tool.`,
    };
    if (pending.toolName === "bash" || pending.toolName === "powershell") {
      return {
        ...base,
        kind: "command",
        command: readString(pending.input.command) || pending.toolName,
        cwd: workingDirectory,
      };
    }
    if (pending.toolName === "edit" || pending.toolName === "write") {
      const path = readString(pending.input.path);
      return {
        ...base,
        kind: "file-change",
        changes: path
          ? [{ path, kind: pending.toolName === "write" ? "create" : "update" }]
          : // No path means the arguments were not what the tool's schema
            // promises. Report it as unactionable rather than approving a
            // change to a file nobody can name.
            [],
        ...(path ? {} : { actionable: false }),
      };
    }
    return {
      ...base,
      kind: "command",
      command: `${pending.toolName} ${boundedArguments(pending.input)}`,
      cwd: workingDirectory,
    };
  });
  return { approvals, revision: state.revision };
}

/**
 * The second interaction family the backend also reads.
 *
 * Pi has no questions, forms or plan reviews of its own, so this is always
 * empty — but it is answered rather than 404'd, because the backend treats two
 * 404s as "this bridge predates the routes" and one as a fault.
 */
export function publicInteractions(state: SessionState): JsonObject {
  return { interactions: [], revision: state.revision };
}

function boundedArguments(input: JsonObject): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(input) ?? "{}";
  } catch {
    return "[unserializable arguments]";
  }
  return Buffer.byteLength(serialized) > MAX_TOOL_ARGUMENT_BYTES
    ? "[arguments omitted]"
    : serialized;
}

function readString(value: unknown): string {
  return nonBlank(value) ? value.trim() : "";
}
