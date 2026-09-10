import {
  BridgeRunDiagnostics,
  bridgeDebugEnabled,
  readBridgeDebugFlag,
} from "@orkestrator/protocol/bridge-diagnostics";
import { isObject, type SessionState } from "./state.js";

export function cursorDebugEnabled(value = process.env.CURSOR_BRIDGE_DEBUG): boolean {
  return readBridgeDebugFlag(value);
}

export class CursorRunDiagnostics extends BridgeRunDiagnostics {
  constructor(
    state: SessionState,
    now?: () => number,
    write?: (line: string) => void,
    intervalMs?: number,
  ) {
    super("cursor", state, now, write, intervalMs);
  }
  delta(update: unknown): void {
    let nested = false;
    for (let depth = 0; depth < 8 && isObject(update); depth++) {
      const kind = typeof update.type === "string" ? update.type : "unknown";
      this.activity(kind, nested);
      if (kind === "tool-call-delta") {
        nested = true;
        update = update.taskUpdate;
        continue;
      }
      if (
        kind === "partial-tool-call" ||
        kind === "tool-call-started" ||
        kind === "tool-call-completed"
      ) {
        this.tool(
          update.callId,
          isObject(update.toolCall) ? update.toolCall.type : undefined,
          kind === "partial-tool-call"
            ? "partial"
            : kind === "tool-call-started"
              ? "started"
              : "completed",
          nested,
        );
      }
      break;
    }
  }
}
export function createRunDiagnostics(state: SessionState): CursorRunDiagnostics | undefined {
  return bridgeDebugEnabled("cursor") ? new CursorRunDiagnostics(state) : undefined;
}

/** Bounded so one SDK error cannot write an unbounded diagnostic line. */
const MAX_SETUP_DETAIL_BYTES = 300;

/**
 * One gated line for a setup failure that attach deliberately recovers from.
 * Both call sites swallow their error, so without this the only symptom of an
 * unprimed sandbox verdict is a later generic dispatch failure — exactly the
 * ambiguity that made the original incident hard to place.
 *
 * The message is the only field taken from the error: the options in scope at
 * these sites carry an API key and the workspace path.
 */
export function cursorSetupDebug(stage: string, error: unknown): void {
  if (!bridgeDebugEnabled("cursor")) return;
  const detail = (error instanceof Error ? error.message : String(error)).slice(
    0,
    MAX_SETUP_DETAIL_BYTES,
  );
  const entry = JSON.stringify({ bridge: "cursor", event: "setup-failed", stage, detail });
  console.info(`[bridge-diagnostics] ${entry}`);
}
