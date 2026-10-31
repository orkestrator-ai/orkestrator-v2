import { describe, expect, test } from "bun:test";
import {
  UNATTENDED_AGENT_INTERACTION_POLICY,
  type AgentInteractionOrigin,
} from "@orkestrator/protocol/agent-interactions";
import {
  OpenCodeMessageIdCoordinator,
  findOpenCodeMessageId,
  openCodeRequestMarker,
} from "@orkestrator/protocol/opencode-message-id";
import { readProviderStatus } from "./agent-provider-contract.js";
import { openCodeFake } from "./agent-provider-test-support.js";
import { createNativeAgentProvider } from "./native-agent-provider.js";
import { isOpenCodeCapacityError } from "./opencode-capacity-retry.js";
import { openCodeWorkflowResultToolId } from "./opencode-provider-helpers.js";
import { OPENCODE_PROVIDER_ERROR_CONTINUATION } from "./opencode-turn-recovery.js";

const sessionId = "owned-session";
const requestId = "fix-1";
const tool = openCodeWorkflowResultToolId("submit_validation_plan");
const options = {
  requestId,
  workflowResultTool: "submit_validation_plan",
  agentMcp: {
    url: "http://fixture.invalid/mcp",
    token: "fixture-token",
    workflowResultCapability: "fixture-capability",
  },
};

function apiError(statusCode: number, message: string, responseBody?: string) {
  return {
    name: "APIError",
    data: { statusCode, message, isRetryable: true, ...(responseBody ? { responseBody } : {}) },
  };
}
const OVERLOADED = apiError(503, "Service Unavailable");

type Fake = ReturnType<typeof openCodeFake>;

function setup(
  origin: AgentInteractionOrigin = "automated-review",
  policy: { baseDelayMs?: number; maxAttempts?: number } = { baseDelayMs: 0 },
) {
  const fake = openCodeFake();
  const clock = { now: 1_000_000 };
  const provider = createNativeAgentProvider(
    {
      agent: "opencode",
      baseUrl: "http://opencode.test",
      authToken: "test-token",
      directory: "/workspace",
    },
    {
      openCodeClient: fake.client,
      openCodeMessageIdCoordinator: new OpenCodeMessageIdCoordinator(),
      monitorRetryMs: 1,
      now: () => clock.now,
      openCodeCapacityRetryPolicy: policy,
    },
  );
  provider.registerSession?.(sessionId, {
    origin,
    interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
  });
  return { fake, provider, clock };
}

/** The transcript after the newest dispatched attempt answered. */
function answer(fake: Fake, fields: Record<string, unknown>) {
  const attempts = fake.promptCalls.map((call) => ({
    info: { id: call.messageID, role: "user" },
    parts: [],
  }));
  fake.setMessagesResponse({
    data: [
      ...attempts,
      {
        info: {
          id: `answer-${fake.promptCalls.length}`,
          role: "assistant",
          parentID: fake.promptCalls.at(-1)!.messageID,
          time: { completed: 1 },
          ...fields,
        },
        parts: [],
      },
    ],
  });
}

async function grant(fake: Fake) {
  const result = await fake.client.session.get({ sessionID: sessionId });
  return result.data?.permission?.findLast((rule) => rule.permission === tool)?.action;
}

describe("isOpenCodeCapacityError", () => {
  test.each([
    [apiError(503, "Service Unavailable")],
    [apiError(529, "Overloaded")],
    [apiError(429, "Overloaded", '{"type":"overloaded_error"}')],
    [apiError(429, "The model is at capacity")],
  ])("retries %j", (error) => {
    expect(isOpenCodeCapacityError(error)).toBe(true);
  });

  test.each([
    ["a plain rate limit", apiError(429, "Too Many Requests")],
    ["a 429 with no overload body", apiError(429, "Slow down")],
    ["a rate limit under an overload body", apiError(429, "Overloaded: rate limit reached")],
    ["a usage limit under a 503", apiError(503, "Usage limit reached")],
    ["quota under a 529", apiError(529, "x", '{"error":{"code":"insufficient_quota"}}')],
    ["a Go usage limit", apiError(503, "x", "GoUsageLimitError")],
    ["a login", apiError(503, "Please log in again")],
    ["an auth status", apiError(401, "Overloaded")],
    ["a forbidden status", apiError(403, "Overloaded")],
    ["another status", apiError(500, "Overloaded")],
    ["no status", { name: "APIError", data: { message: "Overloaded" } }],
    ["another error", { name: "UnknownError", data: { statusCode: 503, message: "x" } }],
    ["a stop", { name: "MessageAbortedError" }],
    ["nothing", undefined],
  ])("never retries %s", (_name, error) => {
    expect(isOpenCodeCapacityError(error)).toBe(false);
  });
});

describe("OpenCode capacity retry", () => {
  test("continues an unattended turn under its own request, grant and result", async () => {
    const { fake, provider } = setup();
    try {
      await provider.send(sessionId, "Discover validation", { ...options, readOnly: true });
      answer(fake, { error: OVERLOADED });

      // The refusal is not the turn's outcome, and no workflow may read it as one.
      expect(await readProviderStatus(provider, sessionId, requestId)).toMatchObject({
        status: "idle",
        turnSettled: false,
      });
      expect(fake.promptCalls).toHaveLength(2);
      const [first, retry] = fake.promptCalls as Array<Record<string, unknown>>;
      expect(retry!.messageID).not.toBe(first!.messageID);
      expect(String(retry!.messageID).endsWith(openCodeRequestMarker(requestId))).toBe(true);
      expect(String(retry!.messageID) > String(first!.messageID)).toBe(true);
      expect(retry!.parts).toEqual([{ type: "text", text: OPENCODE_PROVIDER_ERROR_CONTINUATION }]);
      // Everything but the prompt rides again; the tools of a read-only turn too.
      for (const field of ["model", "agent", "variant", "tools"]) {
        expect(retry![field]).toEqual(first![field]);
      }
      expect(await grant(fake)).toBe("allow");

      // The continuation has no answer yet.
      fake.setMessagesResponse({
        data: fake.promptCalls.map((call) => ({
          info: { id: call.messageID, role: "user" },
          parts: [],
        })),
      });
      expect(await readProviderStatus(provider, sessionId, requestId)).toMatchObject({
        turnSettled: false,
      });

      answer(fake, { finish: "stop" });
      expect(findOpenCodeMessageId((await provider.messages(sessionId)) ?? [], requestId)).toBe(
        retry!.messageID as string,
      );
      expect(await provider.turnTerminalError?.(sessionId, requestId)).toBeNull();
      expect(await readProviderStatus(provider, sessionId, requestId)).toMatchObject({
        status: "idle",
        turnSettled: true,
      });
      expect(fake.promptCalls).toHaveLength(2);
      expect(await grant(fake)).toBe("deny");
    } finally {
      await provider.dispose?.();
    }
  });

  test("waits out the backoff before it sends, and reports no outcome meanwhile", async () => {
    const { fake, provider, clock } = setup("build-pipeline", { baseDelayMs: 10_000 });
    try {
      await provider.send(sessionId, "Build it", options);
      answer(fake, { error: OVERLOADED });

      await expect(provider.turnTerminalError?.(sessionId, requestId)).rejects.toThrow(
        "about to retry",
      );
      expect(await readProviderStatus(provider, sessionId, requestId)).toMatchObject({
        turnSettled: false,
      });
      expect(fake.promptCalls).toHaveLength(1);

      clock.now += 4_000;
      await readProviderStatus(provider, sessionId, requestId);
      expect(fake.promptCalls).toHaveLength(1);

      // At most the nominal wait, whatever the jitter drew.
      clock.now += 6_001;
      await readProviderStatus(provider, sessionId, requestId);
      expect(fake.promptCalls).toHaveLength(2);
    } finally {
      await provider.dispose?.();
    }
  });

  test("gives up after the last attempt and the turn fails with the refusal", async () => {
    const { fake, provider } = setup("automated-review", { baseDelayMs: 0, maxAttempts: 3 });
    try {
      await provider.send(sessionId, "Review", options);
      answer(fake, { error: OVERLOADED });
      await readProviderStatus(provider, sessionId, requestId);
      answer(fake, { error: OVERLOADED });
      await readProviderStatus(provider, sessionId, requestId);
      expect(fake.promptCalls).toHaveLength(3);

      answer(fake, { error: OVERLOADED });
      expect(await readProviderStatus(provider, sessionId, requestId)).toMatchObject({
        turnSettled: true,
      });
      expect(fake.promptCalls).toHaveLength(3);
      expect(await provider.turnTerminalError?.(sessionId, requestId)).toBe("Service Unavailable");
      expect(await grant(fake)).toBe("deny");
    } finally {
      await provider.dispose?.();
    }
  });

  test.each([
    ["a rate limit", apiError(429, "Too Many Requests")],
    ["a usage limit", apiError(503, "Usage limit reached")],
    ["a refused login", apiError(401, "Unauthorized")],
    ["a bad request", apiError(400, "Bad Request")],
  ])("fails %s at once", async (_name, error) => {
    const { fake, provider } = setup();
    try {
      await provider.send(sessionId, "Review", options);
      answer(fake, { error });
      expect(await readProviderStatus(provider, sessionId, requestId)).toMatchObject({
        turnSettled: true,
      });
      expect(fake.promptCalls).toHaveLength(1);
    } finally {
      await provider.dispose?.();
    }
  });

  test("leaves an interactive session to turn recovery", async () => {
    const { fake, provider } = setup("interactive-native");
    try {
      await provider.send(sessionId, "Hello", options);
      answer(fake, { error: OVERLOADED });
      expect(await readProviderStatus(provider, sessionId, requestId)).toMatchObject({
        turnSettled: true,
      });
      expect(fake.promptCalls).toHaveLength(1);
    } finally {
      await provider.dispose?.();
    }
  });

  test("Stop during the wait ends the retry", async () => {
    const { fake, provider, clock } = setup("automated-review", { baseDelayMs: 10_000 });
    try {
      await provider.send(sessionId, "Review", options);
      answer(fake, { error: OVERLOADED });
      await readProviderStatus(provider, sessionId, requestId);

      await provider.abort(sessionId);
      clock.now += 60_000;
      expect(await readProviderStatus(provider, sessionId, requestId)).toMatchObject({
        turnSettled: true,
      });
      expect(fake.promptCalls).toHaveLength(1);
    } finally {
      await provider.dispose?.();
    }
  });

  test("a rejected continuation ends the turn with the refusal", async () => {
    const { fake, provider } = setup();
    try {
      await provider.send(sessionId, "Review", options);
      answer(fake, { error: OVERLOADED });
      fake.setPromptResponse({ error: { name: "BadRequest" }, response: { status: 400 } });
      expect(await readProviderStatus(provider, sessionId, requestId)).toMatchObject({
        turnSettled: true,
      });
    } finally {
      await provider.dispose?.();
    }
  });

  test("an ambiguous continuation is never sent twice", async () => {
    const { fake, provider } = setup();
    try {
      await provider.send(sessionId, "Review", options);
      answer(fake, { error: OVERLOADED });
      fake.setPromptError(new Error("connection reset"));
      expect(await readProviderStatus(provider, sessionId, requestId)).toMatchObject({
        turnSettled: false,
      });
      const sent = fake.promptCalls.length;
      // The transcript shows no continuation, so the refusal stands.
      expect(await readProviderStatus(provider, sessionId, requestId)).toMatchObject({
        turnSettled: true,
      });
      expect(fake.promptCalls).toHaveLength(sent);
    } finally {
      await provider.dispose?.();
    }
  });
});
