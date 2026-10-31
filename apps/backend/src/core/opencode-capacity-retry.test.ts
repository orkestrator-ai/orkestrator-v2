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
import {
  OPENCODE_CAPACITY_RETRY_ABANDON_MS,
  isOpenCodeCapacityError,
} from "./opencode-capacity-retry.js";
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
  policy: { baseDelayMs?: number; maxAttempts?: number; maxDelayMs?: number } = { baseDelayMs: 0 },
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

  test("accepted continuation waits through stale refusals without consuming attempts", async () => {
    const { fake, provider } = setup("automated-review", { baseDelayMs: 0, maxAttempts: 3 });
    try {
      await provider.send(sessionId, "Review", options);
      answer(fake, { error: OVERLOADED });
      for (let i = 0; i < 8; i++) {
        expect(await readProviderStatus(provider, sessionId, requestId)).toMatchObject({
          turnSettled: false,
        });
        await expect(provider.turnTerminalError!(sessionId, requestId)).rejects.toThrow(
          "about to retry",
        );
        expect(await grant(fake)).toBe("allow");
      }
      expect(fake.promptCalls).toHaveLength(2);
      answer(fake, { error: OVERLOADED });
      await readProviderStatus(provider, sessionId, requestId);
      expect(fake.promptCalls).toHaveLength(3);
      expect(new Set(fake.promptCalls.map((call) => call.messageID)).size).toBe(3);
      answer(fake, { finish: "stop" });
      expect(await readProviderStatus(provider, sessionId, requestId)).toMatchObject({
        turnSettled: true,
      });
    } finally {
      await provider.dispose?.();
    }
  });

  test.each([404, 409, 408, 425, 429, 500, 503, 529])(
    "reconciles an ambiguous HTTP %s continuation",
    async (status) => {
      const { fake, provider } = setup();
      try {
        await provider.send(sessionId, "Review", options);
        answer(fake, { error: OVERLOADED });
        fake.setPromptResponse({ error: { name: "Unavailable" }, response: { status } });
        for (let i = 0; i < 4; i++) {
          expect(await readProviderStatus(provider, sessionId, requestId)).toMatchObject({
            turnSettled: false,
          });
          expect(await grant(fake)).toBe("allow");
        }
        expect(fake.promptCalls).toHaveLength(2);
        answer(fake, { finish: "stop" });
        expect(await readProviderStatus(provider, sessionId, requestId)).toMatchObject({
          turnSettled: true,
        });
        expect(await grant(fake)).toBe("deny");
      } finally {
        await provider.dispose?.();
      }
    },
  );

  test("retains the schema wrapper and artifact authority on continuation", async () => {
    const { fake, provider } = setup();
    try {
      const schema = { type: "object", properties: { answer: { type: "string" } } };
      await provider.send(sessionId, "Review", {
        ...options,
        schema,
        artifactGrant: "artifact-grant-secret",
      });
      answer(fake, { error: OVERLOADED });
      await readProviderStatus(provider, sessionId, requestId);
      const retry = fake.promptCalls[1]!;
      expect(JSON.stringify(retry.parts)).toContain(OPENCODE_PROVIDER_ERROR_CONTINUATION);
      expect(JSON.stringify(retry.parts)).toContain("answer");
      expect(retry.parts).toEqual([
        { type: "text", text: expect.stringContaining(JSON.stringify(schema)) },
      ]);
      expect(retry.system).toBe(fake.promptCalls[0]!.system);
      expect(retry.system).toContain('scopeCapability set exactly to "artifact-grant-secret"');
    } finally {
      await provider.dispose?.();
    }
  });

  test.each([true, false])(
    "backoff abandonment depends on continued polling: %s",
    async (polling) => {
      const { fake, provider, clock } = setup("build-pipeline", {
        baseDelayMs: 1_000_000,
        maxDelayMs: 1_000_000,
      });
      try {
        await provider.send(sessionId, "Build", options);
        answer(fake, { error: OVERLOADED });
        await readProviderStatus(provider, sessionId, requestId);
        for (let i = 0; i < 6; i++) {
          clock.now += 60_000;
          if (polling)
            expect(await readProviderStatus(provider, sessionId, requestId)).toMatchObject({
              turnSettled: false,
            });
        }
        expect(await readProviderStatus(provider, sessionId, requestId)).toMatchObject({
          turnSettled: !polling,
        });
        expect(fake.promptCalls).toHaveLength(1);
        expect(await grant(fake)).toBe(polling ? "allow" : "deny");
      } finally {
        await provider.dispose?.();
      }
    },
  );

  test("bounds an unmaterialized continuation even while polled", async () => {
    const { fake, provider, clock } = setup();
    try {
      await provider.send(sessionId, "Review", options);
      answer(fake, { error: OVERLOADED });
      await readProviderStatus(provider, sessionId, requestId);
      clock.now += OPENCODE_CAPACITY_RETRY_ABANDON_MS + 1;
      expect(await readProviderStatus(provider, sessionId, requestId)).toMatchObject({
        turnSettled: true,
      });
      expect(fake.promptCalls).toHaveLength(2);
      expect(await grant(fake)).toBe("deny");
    } finally {
      await provider.dispose?.();
    }
  });

  test("continuation waits for an active instance disposal", async () => {
    const { fake, provider } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const disposed = new Promise<void>((resolve) => {
      entered = resolve;
    });
    try {
      await provider.send(sessionId, "Review", options);
      answer(fake, { error: OVERLOADED });
      fake.setInstanceDisposeHandler(async () => {
        entered();
        await gate;
        return { data: true };
      });
      const refresh = provider.refreshCommands!(sessionId);
      await disposed;
      const poll = readProviderStatus(provider, sessionId, requestId);
      await Promise.resolve();
      expect(fake.promptCalls).toHaveLength(1);
      release();
      await refresh;
      expect(await poll).toMatchObject({ turnSettled: false });
      expect(fake.promptCalls).toHaveLength(2);
      expect(fake.mcpAddCalls).toHaveLength(2);
    } finally {
      release();
      await provider.dispose?.();
    }
  });

  test("refresh waits until continuation acknowledgement and a later idle edge", async () => {
    const { fake, provider } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await provider.send(sessionId, "Review", options);
      answer(fake, { error: OVERLOADED });
      fake.setPromptGate(gate);
      const poll = readProviderStatus(provider, sessionId, requestId);
      // Wait for the mocked transport to enter the held acknowledgement.
      for (let i = 0; i < 100 && fake.promptCalls.length < 2; i++) await Bun.sleep(1);
      expect(fake.promptCalls).toHaveLength(2);
      expect(await provider.refreshCommands!(sessionId)).toMatchObject({ outcome: "deferred" });
      expect(fake.instanceDisposeCalls).toHaveLength(0);
      release();
      await poll;
      expect(fake.instanceDisposeCalls).toHaveLength(0);
      answer(fake, { finish: "stop" });
      await provider.refreshCommands!(sessionId);
      expect(fake.instanceDisposeCalls).toHaveLength(1);
    } finally {
      release();
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
      // Absence in several snapshots is unknown, not proof of non-delivery.
      for (let i = 0; i < 4; i++) {
        expect(await readProviderStatus(provider, sessionId, requestId)).toMatchObject({
          turnSettled: false,
        });
        expect(await grant(fake)).toBe("allow");
      }
      answer(fake, { finish: "stop" });
      expect(await readProviderStatus(provider, sessionId, requestId)).toMatchObject({
        turnSettled: true,
      });
      expect(fake.promptCalls).toHaveLength(sent);
    } finally {
      await provider.dispose?.();
    }
  });
});
