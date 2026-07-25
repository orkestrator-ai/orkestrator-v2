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
