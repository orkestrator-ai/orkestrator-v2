import { appendFileSync } from "node:fs";
import { state, write, type JsonObject } from "./fake-agent-context.js";

let clientMethodPromptId: number | null = null;
let clientMethodPath = "";
let clientMethodTerminalId = "";

export function beginClientMethodExercise(promptId: number, path: string): void {
  clientMethodPromptId = promptId;
  clientMethodPath = path;
  write({
    jsonrpc: "2.0",
    id: 910,
    method: "fs/write_text_file",
    params: { sessionId: "fake-session", path, content: "written by ACP" },
  });
}

export function handleFinalMessage(message: JsonObject): boolean {
  if (message.id === 910 && clientMethodPromptId !== null) {
    write({
      jsonrpc: "2.0",
      id: 911,
      method: "fs/read_text_file",
      params: { sessionId: "fake-session", path: clientMethodPath, line: 1, limit: 1 },
    });
    return true;
  }
  if (message.id === 911 && clientMethodPromptId !== null) {
    write({
      jsonrpc: "2.0",
      id: 912,
      method: "terminal/create",
      params: {
        sessionId: "fake-session",
        command: process.execPath,
        args: ["-e", 'process.stdout.write("terminal-inline")'],
        cwd: process.env.CWD,
        outputByteLimit: 1024,
      },
    });
    return true;
  }
  if (message.id === 912 && clientMethodPromptId !== null) {
    const result = isRecord(message.result) ? message.result : {};
    clientMethodTerminalId = typeof result.terminalId === "string" ? result.terminalId : "";
    write({
      jsonrpc: "2.0",
      id: 913,
      method: "terminal/wait_for_exit",
      params: { sessionId: "fake-session", terminalId: clientMethodTerminalId },
    });
    return true;
  }
  if (message.id === 913 && clientMethodPromptId !== null) {
    write({
      jsonrpc: "2.0",
      id: 914,
      method: "terminal/output",
      params: { sessionId: "fake-session", terminalId: clientMethodTerminalId },
    });
    return true;
  }
  if (message.id === 914 && clientMethodPromptId !== null) {
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "client-terminal",
          title: "ACP terminal",
          content: [{ type: "terminal", terminalId: clientMethodTerminalId }],
        },
      },
    });
    write({
      jsonrpc: "2.0",
      id: 915,
      method: "terminal/release",
      params: { sessionId: "fake-session", terminalId: clientMethodTerminalId },
    });
    return true;
  }
  if (message.id === 915 && clientMethodPromptId !== null) {
    appendFileSync(
      `${clientMethodPath}.result`,
      `${JSON.stringify({ read: message, terminalId: clientMethodTerminalId })}\n`,
    );
    write({ jsonrpc: "2.0", id: clientMethodPromptId, result: { stopReason: "end_turn" } });
    clientMethodPromptId = null;
    return true;
  }
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
    appendFileSync(process.env.FAKE_ACP_VENDOR_REQUEST_FILE, `${JSON.stringify(message)}\n`);
    return true;
  }
  if (message.id === 902 && process.env.FAKE_ACP_VENDOR_MODEL_REQUEST_FILE) {
    appendFileSync(process.env.FAKE_ACP_VENDOR_MODEL_REQUEST_FILE, `${JSON.stringify(message)}\n`);
    return true;
  }
  if (message.id === 903 && process.env.FAKE_ACP_CURSOR_TASK_REQUEST_FILE) {
    appendFileSync(process.env.FAKE_ACP_CURSOR_TASK_REQUEST_FILE, `${JSON.stringify(message)}\n`);
    return true;
  }
  if (message.id === 903 && process.env.FAKE_ACP_CURSOR_TASK_REQUEST_FILE) {
    appendFileSync(process.env.FAKE_ACP_CURSOR_TASK_REQUEST_FILE, `${JSON.stringify(message)}\n`);
    return true;
  }
  if (message.id === 904 && process.env.FAKE_ACP_CURSOR_TODOS_REQUEST_FILE) {
    appendFileSync(process.env.FAKE_ACP_CURSOR_TODOS_REQUEST_FILE, `${JSON.stringify(message)}\n`);
    return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
