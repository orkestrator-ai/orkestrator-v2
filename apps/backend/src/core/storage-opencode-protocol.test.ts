import { describe, expect, test } from "bun:test";
import { INTERACTIVE_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import { isPersistedNativeAgentSession } from "./storage-shared-native-sessions.js";

// `openCodeProtocol` was the OpenCode 2 preview's line marker, retired with
// OpenCode 1.x. Records the preview wrote still carry it and must stay readable.
describe("the retired openCodeProtocol session marker", () => {
  test("a preview record carrying v2 still reads; nothing else was ever written", () => {
    const base = {
      version: 1,
      key: "k",
      environmentId: "env",
      agent: "opencode",
      logicalSessionKey: "tab",
      providerSessionId: "ses",
      origin: "interactive-native",
      interactionPolicy: { ...INTERACTIVE_AGENT_INTERACTION_POLICY },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    expect(isPersistedNativeAgentSession(base)).toBe(true);
    expect(isPersistedNativeAgentSession({ ...base, openCodeProtocol: "v2" })).toBe(true);
    expect(isPersistedNativeAgentSession({ ...base, openCodeProtocol: "legacy" })).toBe(false);
    expect(
      isPersistedNativeAgentSession({ ...base, agent: "claude", openCodeProtocol: "v2" }),
    ).toBe(false);
  });
});
