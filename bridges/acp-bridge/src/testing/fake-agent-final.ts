import { appendFileSync } from "node:fs";
import { state, write, type JsonObject } from "./fake-agent-context.js";

export function handleFinalMessage(message: JsonObject): boolean {
  if (message.method === "session/cancel" && state.promptRequestId !== null) {
    write({ jsonrpc: "2.0", id: state.promptRequestId, result: { stopReason: "cancelled" } });
    state.promptRequestId = null;
    return true;
  }
  if (message.id === 900 && typeof message.result === "object" && state.promptRequestId !== null) {
    const result = message.result as { outcome?: { optionId?: unknown } };
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "completed",
          rawOutput: { exitCode: 0, stdout: "ok" },
        },
      },
    });
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `approved:${String(result.outcome?.optionId)}` },
        },
      },
    });
    write({
      jsonrpc: "2.0",
      id: state.promptRequestId,
      result: { stopReason: "end_turn" },
    });
    state.promptRequestId = null;
    return true;
  }
  if (message.id === 901 && process.env.FAKE_ACP_VENDOR_REQUEST_FILE) {
    appendFileSync(
      process.env.FAKE_ACP_VENDOR_REQUEST_FILE,
      `${JSON.stringify(message)}\n`,
    );
    return true;
  }
  if (message.id === 902 && process.env.FAKE_ACP_VENDOR_MODEL_REQUEST_FILE) {
    appendFileSync(
      process.env.FAKE_ACP_VENDOR_MODEL_REQUEST_FILE,
      `${JSON.stringify(message)}\n`,
    );
    return true;
  }
  if (message.id === 903 && process.env.FAKE_ACP_CURSOR_TASK_REQUEST_FILE) {
    appendFileSync(
      process.env.FAKE_ACP_CURSOR_TASK_REQUEST_FILE,
      `${JSON.stringify(message)}\n`,
    );
    return true;
  }
  if (message.id === 903 && process.env.FAKE_ACP_CURSOR_TASK_REQUEST_FILE) {
    appendFileSync(
      process.env.FAKE_ACP_CURSOR_TASK_REQUEST_FILE,
      `${JSON.stringify(message)}\n`,
    );
    return true;
  }
  if (message.id === 904 && process.env.FAKE_ACP_CURSOR_TODOS_REQUEST_FILE) {
    appendFileSync(
      process.env.FAKE_ACP_CURSOR_TODOS_REQUEST_FILE,
      `${JSON.stringify(message)}\n`,
    );
    return true;
  }
  return false;
}
