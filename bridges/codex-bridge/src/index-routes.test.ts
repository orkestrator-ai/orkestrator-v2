import { describe, expect, test } from "bun:test";

process.env.CODEX_BRIDGE_NO_ENGINE = "1";
process.env.CODEX_BRIDGE_NO_SERVER = "1";

const { app, __testing } = await import("./index.js");
const runtime = __testing.runtimeForTesting();
const runtimeMethods = runtime as unknown as Record<string, unknown>;

async function withRuntimeMethod(
  name: string,
  replacement: unknown,
  run: () => Promise<void>,
): Promise<void> {
  const original = runtimeMethods[name];
  runtimeMethods[name] = replacement;
  try {
    await run();
  } finally {
    runtimeMethods[name] = original;
  }
}

async function jsonRequest(
  path: string,
  method: "POST" | "DELETE",
  body?: unknown,
): Promise<Response> {
  return app.request(path, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
}

describe("global route outcomes", () => {
  test("serves the fallback model catalog supplied by the runtime", async () => {
    await withRuntimeMethod(
      "listModels",
      async () => ({ models: __testing.FALLBACK_MODELS, source: "fallback" }),
      async () => {
        const response = await app.request("/global/models");
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          models: __testing.FALLBACK_MODELS,
          source: "fallback",
        });
      },
    );
  });

  test("serves serialized slash-command definitions", async () => {
    const response = await app.request("/global/slash-commands");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      commands: expect.any(Array),
      cwd: expect.any(String),
    });
  });
});

describe("session collection route outcomes", () => {
  test("serves the session list", async () => {
    const payload = {
      sessions: [{
        id: "thread-1",
        title: "Existing",
        updatedAt: "2026-07-25T12:00:00.000Z",
      }],
      cwd: "/workspace",
    };
    await withRuntimeMethod("listSessions", async () => payload, async () => {
      const response = await app.request("/session/list");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(payload);
    });
  });

  test("creates a session from a valid or malformed JSON body", async () => {
    const bodies: unknown[] = [];
    await withRuntimeMethod(
      "createSession",
      (body: unknown) => {
        bodies.push(body);
        return { sessionId: `session-${bodies.length}` };
      },
      async () => {
        const valid = await jsonRequest("/session/create", "POST", {
          title: "New session",
        });
        expect(valid.status).toBe(201);
        expect(await valid.json()).toEqual({ sessionId: "session-1" });

        const malformed = await app.request("/session/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{malformed",
        });
        expect(malformed.status).toBe(201);
        expect(await malformed.json()).toEqual({ sessionId: "session-2" });
      },
    );
    expect(bodies).toEqual([{ title: "New session" }, {}]);
  });

  test("maps missing and successful resume outcomes", async () => {
    let outcome: unknown = null;
    await withRuntimeMethod("resumeSession", async () => outcome, async () => {
      const missing = await jsonRequest("/session/resume", "POST", {});
      expect(missing.status).toBe(400);
      expect(await missing.json()).toEqual({ error: "threadId is required" });

      outcome = {
        sessionId: "session-resumed",
        threadId: "thread-1",
        messages: [],
      };
      const resumed = await jsonRequest("/session/resume", "POST", {
        threadId: "thread-1",
      });
      expect(resumed.status).toBe(201);
      expect(await resumed.json()).toEqual(outcome);
    });
  });
});

describe("session detail route outcomes", () => {
  test("maps every configuration update outcome", async () => {
    let outcome:
      | "updated"
      | "not-found"
      | "running"
      | "unavailable"
      | "memory-only" = "updated";
    await withRuntimeMethod("updateConfig", async () => outcome, async () => {
      const cases = [
        ["not-found", 404, { error: "Session not found" }],
        ["running", 409, { error: "Cannot update settings while session is running" }],
        ["unavailable", 503, { error: "Codex is temporarily unavailable" }],
        ["memory-only", 200, { status: "updated", durable: false }],
        ["updated", 200, { status: "updated", durable: true }],
      ] as const;

      for (const [nextOutcome, status, body] of cases) {
        outcome = nextOutcome;
        const response = await jsonRequest("/session/session-1/config", "POST", {
          mode: "plan",
        });
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual(body);
      }
    });
  });

  test("serves existing config, messages, and status snapshots", async () => {
    await withRuntimeMethod(
      "getConfig",
      async () => ({
        mode: "build",
        fastMode: false,
        durable: true,
      }),
      async () => {
        const response = await app.request("/session/session-1/config");
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          mode: "build",
          fastMode: false,
          durable: true,
        });
      },
    );

    const messages = [{
      id: "message-1",
      role: "assistant",
      content: "done",
      parts: [],
      createdAt: "2026-07-25T12:00:00.000Z",
    }];
    await withRuntimeMethod("getMessages", async () => messages, async () => {
      const response = await app.request("/session/session-1/messages");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ messages });
    });

    await withRuntimeMethod(
      "getStatus",
      () => ({
        status: "running",
        phase: "running",
        engineGeneration: 3,
      }),
      async () => {
        const response = await app.request("/session/session-1/status");
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          status: "running",
          phase: "running",
          engineGeneration: 3,
        });
      },
    );
  });

  test("rejects empty prompts and overlong request identifiers", async () => {
    const empty = await jsonRequest("/session/session-1/prompt", "POST", {
      prompt: "   ",
      requestId: "request-1",
    });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({
      error: "Prompt or image attachment is required",
    });

    const longId = await jsonRequest("/session/session-1/prompt", "POST", {
      prompt: "hello",
      requestId: "x".repeat(201),
    });
    expect(longId.status).toBe(400);
    expect((await longId.json()).error).toContain("at most 200 characters");
  });

  test("filters prompt attachments and maps runtime success and failure", async () => {
    const calls: unknown[] = [];
    let outcome: unknown = {
      ok: true,
      result: {
        status: "processing",
        requestId: "request-1",
        threadId: "thread-1",
      },
    };
    await withRuntimeMethod(
      "prompt",
      async (sessionId: string, input: unknown) => {
        calls.push({ sessionId, input });
        return outcome;
      },
      async () => {
        const accepted = await jsonRequest("/session/session-1/prompt", "POST", {
          prompt: " hello ",
          requestId: " request-1 ",
          attachments: [
            {
              type: "image",
              path: "/tmp/image.png",
              dataUrl: "data:image/png;base64,AA==",
              filename: "image.png",
            },
            { type: "text", path: "/tmp/ignored.txt" },
            null,
          ],
        });
        expect(accepted.status).toBe(202);
        expect(await accepted.json()).toMatchObject({
          status: "processing",
          requestId: "request-1",
        });

        outcome = { ok: false, status: 503, error: "Codex unavailable" };
        const failed = await jsonRequest("/session/session-1/prompt", "POST", {
          prompt: "retry",
          requestId: "request-2",
        });
        expect(failed.status).toBe(503);
        expect(await failed.json()).toEqual({ error: "Codex unavailable" });
      },
    );

    expect(calls[0]).toEqual({
      sessionId: "session-1",
      input: {
        prompt: "hello",
        requestId: "request-1",
        attachments: [{
          type: "image",
          path: "/tmp/image.png",
          dataUrl: "data:image/png;base64,AA==",
          filename: "image.png",
        }],
      },
    });
  });

  test("maps all valid approval response outcomes", async () => {
    let outcome:
      | "applied"
      | "unknown"
      | "wrong-session"
      | "not-actionable" = "applied";
    await withRuntimeMethod("respondToApproval", () => outcome, async () => {
      const cases = [
        ["wrong-session", 403, { error: "Approval does not belong to this session" }],
        ["not-actionable", 422, {
          error: "Approval lacks the detail required to approve it",
        }],
        ["unknown", 409, {
          error: "Approval is no longer pending",
          status: "stale",
        }],
        ["applied", 200, { status: "applied", decision: "approve" }],
      ] as const;

      for (const [nextOutcome, status, body] of cases) {
        outcome = nextOutcome;
        const response = await jsonRequest(
          "/session/session-1/approvals/approval-1",
          "POST",
          { decision: "approve" },
        );
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual(body);
      }
    });
  });

  test("maps abort and delete success and missing-session outcomes", async () => {
    let abortOutcome: unknown = null;
    await withRuntimeMethod("abort", async () => abortOutcome, async () => {
      const missing = await jsonRequest("/session/session-1/abort", "POST");
      expect(missing.status).toBe(404);

      abortOutcome = { status: "cancelling", phase: "cancelling" };
      const accepted = await jsonRequest("/session/session-1/abort", "POST");
      expect(accepted.status).toBe(202);
      expect(await accepted.json()).toEqual(abortOutcome);
    });

    let deleted = false;
    await withRuntimeMethod("deleteSession", async () => deleted, async () => {
      const missing = await jsonRequest("/session/session-1", "DELETE");
      expect(missing.status).toBe(404);

      deleted = true;
      const success = await jsonRequest("/session/session-1", "DELETE");
      expect(success.status).toBe(200);
      expect(await success.json()).toEqual({ status: "deleted" });
    });
  });
});

describe("interaction route outcomes", () => {
  test("serves pending interactions for rehydration, and [] for an unknown session", async () => {
    const interactions = [{ interactionId: "ask-1", kind: "question", threadId: "thread-1" }];
    await withRuntimeMethod("listInteractions", () => interactions, async () => {
      const response = await app.request("/session/session-1/interactions");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ interactions });
    });

    await withRuntimeMethod("listInteractions", () => [], async () => {
      // A stale tab polling a closed session should see "nothing pending", not a
      // 404 it would report as an error.
      const response = await app.request("/session/session-gone/interactions");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ interactions: [] });
    });
  });

  test("rejects an action that is not accept, decline or cancel", async () => {
    for (const body of [{}, { action: "approve" }, { action: 1 }, { action: null }]) {
      const response = await jsonRequest(
        "/session/session-1/interactions/ask-1",
        "POST",
        body,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "action must be accept, decline, or cancel",
      });
    }
  });

  /**
   * The regression: `{"action":"accept","answers":{"q":"TypeScript"}}` used to
   * reach a `.some()` call on a string, throw a TypeError and surface as a 500
   * while the interaction stayed parked until its auto-cancel.
   */
  test("rejects a malformed answers map with 400, never a 500", async () => {
    let called = false;
    await withRuntimeMethod("respondToInteraction", () => {
      called = true;
      return "applied";
    }, async () => {
      for (const answers of [
        { q: "TypeScript" },
        { q: [] },
        { q: [""] },
        { q: [1] },
        ["TypeScript"],
        "TypeScript",
      ]) {
        const response = await jsonRequest(
          "/session/session-1/interactions/ask-1",
          "POST",
          { action: "accept", answers },
        );
        expect(response.status).toBe(400);
        expect((await response.json()).error).toContain("non-empty array");
      }
    });
    // The runtime is never reached with an unchecked shape.
    expect(called).toBe(false);
  });

  test("maps every interaction response outcome", async () => {
    let outcome: "applied" | "unknown" | "wrong-session" | "invalid" = "applied";
    await withRuntimeMethod("respondToInteraction", () => outcome, async () => {
      const cases = [
        ["wrong-session", 403, { error: "Interaction does not belong to this session" }],
        ["invalid", 400, { error: "Interaction answer is malformed" }],
        ["unknown", 409, { error: "Interaction is no longer pending", status: "stale" }],
        ["applied", 200, { status: "applied", action: "accept" }],
      ] as const;

      for (const [nextOutcome, status, body] of cases) {
        outcome = nextOutcome;
        const response = await jsonRequest(
          "/session/session-1/interactions/ask-1",
          "POST",
          { action: "accept", answers: { q: ["Yes"] } },
        );
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual(body);
      }
    });
  });

  test("passes a well-formed answer through as a typed InteractionAnswer", async () => {
    const calls: unknown[] = [];
    await withRuntimeMethod(
      "respondToInteraction",
      (sessionId: string, interactionId: string, answer: unknown) => {
        calls.push({ sessionId, interactionId, answer });
        return "applied";
      },
      async () => {
        await jsonRequest("/session/session-1/interactions/ask-1", "POST", {
          action: "accept",
          answers: { q: ["Yes"] },
          content: { region: "eu-west-1" },
          meta: { formId: "f-1" },
        });
        await jsonRequest("/session/session-1/interactions/ask-2", "POST", {
          action: "cancel",
          // Answers on a cancel are meaningless and must not be forwarded.
          answers: { q: ["Yes"] },
        });
      },
    );

    expect(calls).toEqual([
      {
        sessionId: "session-1",
        interactionId: "ask-1",
        answer: {
          action: "accept",
          answers: { q: ["Yes"] },
          content: { region: "eu-west-1" },
          meta: { formId: "f-1" },
        },
      },
      { sessionId: "session-1", interactionId: "ask-2", answer: { action: "cancel" } },
    ]);
  });
});

describe("fork route outcomes", () => {
  test("maps every fork outcome to its own status", async () => {
    let result: unknown = { outcome: "not-found" };
    await withRuntimeMethod("forkSession", async () => result, async () => {
      const cases = [
        [{ outcome: "not-found" }, 404, { error: "Session not found" }],
        [
          { outcome: "running" },
          409,
          { error: "Session cannot be forked while it is running" },
        ],
        [
          { outcome: "unknown-message" },
          404,
          { error: "lastMessageId is not a message in this session" },
        ],
        [
          { outcome: "no-fork-point" },
          422,
          {
            error:
              "That message is not a usable fork point: it belongs to no Codex turn",
          },
        ],
        [
          { outcome: "unavailable" },
          503,
          { error: "Codex did not return a forked thread" },
        ],
      ] as const;

      for (const [nextResult, status, body] of cases) {
        result = nextResult;
        const response = await jsonRequest("/session/session-1/fork", "POST", {});
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual(body);
      }
    });
  });

  test("returns the created session without leaking the internal outcome tag", async () => {
    await withRuntimeMethod(
      "forkSession",
      async () => ({
        outcome: "created",
        sessionId: "session-fork",
        title: "Parent (fork)",
        threadId: "fork-1",
        messages: [],
      }),
      async () => {
        const response = await jsonRequest("/session/session-1/fork", "POST", {});
        expect(response.status).toBe(201);
        expect(await response.json()).toEqual({
          sessionId: "session-fork",
          title: "Parent (fork)",
          threadId: "fork-1",
          messages: [],
        });
      },
    );
  });

  test("forwards only a string lastMessageId", async () => {
    const calls: unknown[] = [];
    await withRuntimeMethod(
      "forkSession",
      async (sessionId: string, lastMessageId: unknown) => {
        calls.push({ sessionId, lastMessageId });
        return { outcome: "not-found" };
      },
      async () => {
        await jsonRequest("/session/session-1/fork", "POST", { lastMessageId: "message-1" });
        await jsonRequest("/session/session-1/fork", "POST", { lastMessageId: 7 });
        await jsonRequest("/session/session-1/fork", "POST", {});
      },
    );

    expect(calls).toEqual([
      { sessionId: "session-1", lastMessageId: "message-1" },
      { sessionId: "session-1", lastMessageId: undefined },
      { sessionId: "session-1", lastMessageId: undefined },
    ]);
  });
});

describe("compact route outcomes", () => {
  test("maps every compaction outcome", async () => {
    let outcome: "accepted" | "not-found" | "running" | "unavailable" = "accepted";
    await withRuntimeMethod("compactSession", async () => outcome, async () => {
      const cases = [
        ["not-found", 404, { error: "Session not found" }],
        ["running", 409, { error: "Session is running" }],
        ["unavailable", 503, { error: "Compaction could not be started" }],
        // 202: the rewrite has not happened yet, so this is not a completion.
        ["accepted", 202, { status: "accepted" }],
      ] as const;

      for (const [nextOutcome, status, body] of cases) {
        outcome = nextOutcome;
        const response = await jsonRequest("/session/session-1/compact", "POST");
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual(body);
      }
    });
  });
});

describe("steer route outcomes", () => {
  test("rejects an empty or non-string input before reaching the runtime", async () => {
    let called = false;
    await withRuntimeMethod("steerSession", async () => {
      called = true;
      return "accepted";
    }, async () => {
      for (const body of [{}, { input: "   " }, { input: 7 }, { input: null }]) {
        const response = await jsonRequest("/session/session-1/steer", "POST", body);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "input is required" });
      }
    });
    expect(called).toBe(false);
  });

  test("maps every steer outcome and trims the input", async () => {
    const calls: unknown[] = [];
    let outcome: "accepted" | "not-found" | "idle" | "mismatch" = "accepted";
    await withRuntimeMethod(
      "steerSession",
      async (sessionId: string, input: string, requestId?: string) => {
        calls.push({ sessionId, input, requestId });
        return outcome;
      },
      async () => {
        const cases = [
          ["not-found", 404, { error: "Session not found" }],
          ["idle", 409, { error: "There is no active turn" }],
          [
            "mismatch",
            409,
            { error: "The active turn changed; the text was not sent" },
          ],
          ["accepted", 202, { status: "accepted" }],
        ] as const;

        for (const [nextOutcome, status, body] of cases) {
          outcome = nextOutcome;
          const response = await jsonRequest("/session/session-1/steer", "POST", {
            input: "  also check the tests  ",
            requestId: "req-steer",
          });
          expect(response.status).toBe(status);
          expect(await response.json()).toEqual(body);
        }
      },
    );

    expect(calls[0]).toEqual({
      sessionId: "session-1",
      input: "also check the tests",
      requestId: "req-steer",
    });
  });
});

describe("review route outcomes", () => {
  /**
   * The regression: every malformed or partially specified target used to
   * degrade silently to `uncommittedChanges`, starting a *different* review from
   * the one asked for — spending a turn and tokens — and answering 202.
   */
  test("rejects a named target whose required field is missing or blank", async () => {
    let called = false;
    await withRuntimeMethod("startNativeReview", async () => {
      called = true;
      return { outcome: "accepted", turnId: "turn-review" };
    }, async () => {
      const cases = [
        [{ type: "baseBranch" }, "branch is required for a baseBranch review"],
        [{ type: "baseBranch", branch: "   " }, "branch is required for a baseBranch review"],
        [{ type: "baseBranch", branch: 7 }, "branch is required for a baseBranch review"],
        [{ type: "commit" }, "sha is required for a commit review"],
        [{ type: "commit", sha: "" }, "sha is required for a commit review"],
        [{ type: "custom" }, "instructions are required for a custom review"],
        [
          { type: "custom", instructions: "  " },
          "instructions are required for a custom review",
        ],
      ] as const;

      for (const [body, error] of cases) {
        const response = await jsonRequest("/session/session-1/review", "POST", body);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error });
      }

      const unknownType = await jsonRequest("/session/session-1/review", "POST", {
        type: "everything",
      });
      expect(unknownType.status).toBe(400);
      expect((await unknownType.json()).error).toContain("type must be");
    });
    expect(called).toBe(false);
  });

  test("forwards each well-formed target, defaulting only when type is absent", async () => {
    const targets: unknown[] = [];
    await withRuntimeMethod(
      "startNativeReview",
      async (_sessionId: string, target: unknown) => {
        targets.push(target);
        return { outcome: "accepted", turnId: "turn-review" };
      },
      async () => {
        await jsonRequest("/session/session-1/review", "POST", {});
        await jsonRequest("/session/session-1/review", "POST", { type: "uncommittedChanges" });
        await jsonRequest("/session/session-1/review", "POST", {
          type: "baseBranch",
          branch: "  main  ",
        });
        await jsonRequest("/session/session-1/review", "POST", {
          type: "commit",
          sha: " abc123 ",
        });
        await jsonRequest("/session/session-1/review", "POST", {
          type: "commit",
          sha: "abc123",
          title: "Fix the bridge",
        });
        await jsonRequest("/session/session-1/review", "POST", {
          type: "custom",
          instructions: " check the auth path ",
        });
      },
    );

    expect(targets).toEqual([
      { type: "uncommittedChanges" },
      { type: "uncommittedChanges" },
      { type: "baseBranch", branch: "main" },
      { type: "commit", sha: "abc123", title: null },
      { type: "commit", sha: "abc123", title: "Fix the bridge" },
      { type: "custom", instructions: "check the auth path" },
    ]);
  });

  test("maps every review outcome", async () => {
    let result: unknown = { outcome: "not-found" };
    await withRuntimeMethod("startNativeReview", async () => result, async () => {
      const cases = [
        [{ outcome: "not-found" }, 404, { error: "Session not found" }],
        [{ outcome: "running" }, 409, { error: "Session is running" }],
        [{ outcome: "unavailable" }, 503, { error: "Native review failed" }],
        [
          { outcome: "accepted", turnId: "turn-review" },
          202,
          { status: "processing", turnId: "turn-review" },
        ],
      ] as const;

      for (const [nextResult, status, body] of cases) {
        result = nextResult;
        const response = await jsonRequest("/session/session-1/review", "POST", {});
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual(body);
      }
    });
  });

  test("a malformed JSON body reviews uncommitted changes rather than 400-ing", async () => {
    // An absent type is the documented default, and an unparseable body has no
    // type at all.
    const targets: unknown[] = [];
    await withRuntimeMethod(
      "startNativeReview",
      async (_sessionId: string, target: unknown) => {
        targets.push(target);
        return { outcome: "accepted", turnId: "turn-review" };
      },
      async () => {
        const response = await app.request("/session/session-1/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{malformed",
        });
        expect(response.status).toBe(202);
      },
    );
    expect(targets).toEqual([{ type: "uncommittedChanges" }]);
  });
});

describe("runtime-health route", () => {
  test("serves the engine snapshot as-is", async () => {
    const payload = {
      engine: { state: "ready" },
      mcp: { data: [] },
      skills: { data: [] },
      hooks: { data: [] },
      notices: [],
      rateLimits: {},
    };
    await withRuntimeMethod("getRuntimeHealth", async () => payload, async () => {
      const response = await app.request("/session/session-1/runtime-health");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(payload);
    });
  });

  test("passes the session id through so the MCP list can be thread-scoped", async () => {
    const calls: unknown[] = [];
    await withRuntimeMethod(
      "getRuntimeHealth",
      async (sessionId: string) => {
        calls.push(sessionId);
        return {};
      },
      async () => {
        await app.request("/session/session-42/runtime-health");
      },
    );
    expect(calls).toEqual(["session-42"]);
  });
});
