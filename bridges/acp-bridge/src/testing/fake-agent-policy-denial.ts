import { write, type JsonObject } from "./fake-agent-context.js";

let active = false;
let attempts = 0;
let pending: number | undefined;

/** Real permission request/answer transport, including duplicate usage carriers. */
export function handlePolicyDenial(message: JsonObject): boolean {
  if (message.id === 975 && pending !== undefined && message.result) {
    const id = pending;
    pending = undefined;
    write({
      jsonrpc: "2.0",
      id,
      result: {
        stopReason: "cancelled",
        usage: { totalTokens: 15, inputTokens: 10, outputTokens: 5, costUsd: 0.1 },
        _meta: { cancellationCategory: "PermissionRejected" },
      },
    });
    return true;
  }
  if (message.method !== "session/prompt" || typeof message.id !== "number") return false;
  const params = message.params as { prompt?: Array<{ text?: string }> };
  const text = params.prompt?.[0]?.text ?? "";
  if (text.startsWith("POLICYDENIAL:")) active = true;
  if (!active) return false;
  attempts += 1;
  const denied = attempts === 1 || process.env.FAKE_ACP_POLICY_EXHAUST === "1";
  const usage = denied
    ? { totalTokens: 15, inputTokens: 10, outputTokens: 5, costUsd: 0.1 }
    : { totalTokens: 27, inputTokens: 20, outputTokens: 7, costUsd: 0.2 };
  for (const sessionUpdate of ["response_completed", "turn_completed"]) {
    write({
      jsonrpc: "2.0",
      method: "x.ai/session/update",
      params: {
        sessionId: "fake-session",
        update: { sessionUpdate, usage },
      },
    });
  }
  for (let duplicate = 0; duplicate < 2; duplicate += 1) {
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: { sessionUpdate: "usage_update", used: denied ? 100 : 80, size: 2000, usage },
      },
    });
  }
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "fake-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: denied ? '{"stale":' : '{"ok":true}',
        },
      },
    },
  });
  if (denied) {
    pending = message.id;
    write({
      jsonrpc: "2.0",
      id: 975,
      method: "session/request_permission",
      params: {
        sessionId: "fake-session",
        toolCall: { toolCallId: `denied-${attempts}`, kind: "edit", title: "Write" },
        options: [{ optionId: "reject-once", kind: "reject_once", name: "Reject" }],
      },
    });
  } else {
    active = false;
    write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn", usage } });
  }
  return true;
}
