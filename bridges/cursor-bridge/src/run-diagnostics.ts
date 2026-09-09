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
