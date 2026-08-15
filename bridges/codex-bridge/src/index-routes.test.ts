import { afterAll, describe, expect, test } from "bun:test";
import { CompressionStream as NodeCompressionStream } from "node:stream/web";
import { gunzipSync } from "node:zlib";

process.env.CODEX_BRIDGE_NO_ENGINE = "1";
process.env.CODEX_BRIDGE_NO_SERVER = "1";
process.env.CODEX_BRIDGE_AUTH_DISABLED_FOR_TESTING = "1";

// The UI-test preload replaces browser globals before the bridge module is
// evaluated. Hono captures this constructor while installing its middleware.
const originalCompressionStream = globalThis.CompressionStream;
globalThis.CompressionStream = NodeCompressionStream as typeof CompressionStream;
const {
  app,
  __testing,
  boundCodexTranscriptResponse,
  MAX_CODEX_TRANSCRIPT_RESPONSE_BYTES,
} = await import("./index.js");
afterAll(() => {
  globalThis.CompressionStream = originalCompressionStream;
});
const runtime = __testing.runtimeForTesting();
const runtimeMethods = runtime as unknown as Record<string, unknown>;
const AUTH_TOKEN = "test-codex-bridge-token";

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

/**
 * Builds a request carrying an `Origin`.
 *
 * happy-dom — registered globally by the root test preload — treats `Origin` as
 * a forbidden request header and silently drops it from a `Request` init, which
 * would make an origin-policy assertion pass for the wrong reason. Setting it on
 * the built request is not filtered.
 */
function requestWithOrigin(path: string, origin: string, init: RequestInit = {}): Request {
  const request = new Request(`http://localhost${path}`, init);
  request.headers.set("Origin", origin);
  return request;
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

describe("bridge authentication and origin policy", () => {
  test("protects data routes while leaving only the minimal process health public", async () => {
    __testing.setBridgeAuthForTesting(AUTH_TOKEN);
    try {
      expect((await app.request("/global/auth-check")).status).toBe(401);
      expect((await app.request("/global/auth-check", {
        headers: { Authorization: "Bearer wrong" },
      })).status).toBe(401);
      expect((await app.request("/global/auth-check", {
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      })).status).toBe(200);
      expect((await app.request("/global/auth-check", {
        headers: { "X-Orkestrator-Codex-Token": AUTH_TOKEN },
      })).status).toBe(200);

      const health = await app.request("/global/health");
      expect([200, 503]).toContain(health.status);
      const payload = await health.json() as Record<string, unknown>;
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain('"pid"');
      expect(serialized).not.toContain("codexHome");
      expect(serialized).not.toContain("lastError");
    } finally {
      __testing.setBridgeAuthForTesting();
    }
  });

  test("allows only local, file, and explicitly configured origins", () => {
    expect(__testing.isTrustedBridgeOriginForTesting("https://attacker.example"))
      .toBe(false);
    expect(__testing.isTrustedBridgeOriginForTesting("http://127.0.0.1:5173"))
      .toBe(true);
    expect(__testing.isTrustedBridgeOriginForTesting("file://")).toBe(true);
    expect(__testing.isTrustedBridgeOriginForTesting("null")).toBe(true);
  });

  test("reads the configured allowlist, tolerating blanks and trailing slashes", () => {
    const previous = process.env.CODEX_BRIDGE_ALLOWED_ORIGINS;
    process.env.CODEX_BRIDGE_ALLOWED_ORIGINS =
      " https://app.example.test/ , , https://other.example.test ";
    try {
      // A trailing slash on either side is the same origin, and an empty entry
      // from a stray comma must not become an allowlisted empty string.
      expect(__testing.isTrustedBridgeOriginForTesting("https://app.example.test")).toBe(true);
      expect(__testing.isTrustedBridgeOriginForTesting("https://app.example.test/")).toBe(true);
      expect(__testing.isTrustedBridgeOriginForTesting("https://other.example.test")).toBe(true);
      expect(__testing.isTrustedBridgeOriginForTesting("https://attacker.example")).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.CODEX_BRIDGE_ALLOWED_ORIGINS;
      else process.env.CODEX_BRIDGE_ALLOWED_ORIGINS = previous;
    }
  });

  test("rejects a disallowed Origin before the route runs, even on public health", async () => {
    const response = await app.request(
      requestWithOrigin("/global/health", "https://attacker.example"),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Origin is not allowed" });
    // Not a CORS-header omission: the body must not have been produced at all.
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("answers a preflight from a trusted origin with the headers the client needs", async () => {
    const response = await app.request(
      requestWithOrigin("/session/session-1/prompt", "http://127.0.0.1:5173", {
        method: "OPTIONS",
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("http://127.0.0.1:5173");
    expect(response.headers.get("Vary")).toBe("Origin");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, POST, DELETE, OPTIONS",
    );
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
      "Content-Type, Authorization, X-Orkestrator-Codex-Token",
    );
    // Chrome's private-network access check, which the renderer needs to reach a
    // loopback bridge from a page it did not itself serve.
    expect(response.headers.get("Access-Control-Allow-Private-Network")).toBe("true");
    expect(await response.text()).toBe("");
  });

  /**
   * The renderer's health gate calls this route, so an unconditional 200 would
   * let a terminally failed engine pass every check the UI makes.
   */
  test("auth-check mirrors the engine-state semantics of public health", async () => {
    const healthy = await app.request("/global/auth-check");
    expect(healthy.status).toBe(200);
    expect(await healthy.json()).toEqual({ status: "ok" });

    for (const terminal of [
      { state: "failed", circuitOpen: false },
      { state: "restarting", circuitOpen: true },
    ]) {
      await withRuntimeMethod("getHealth", () => terminal, async () => {
        const response = await app.request("/global/auth-check");
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ status: "error" });
      });
    }

    // A restartable blip stays 200 so a transient state does not flap the UI.
    await withRuntimeMethod(
      "getHealth",
      () => ({ state: "restarting", circuitOpen: false }),
      async () => {
        expect((await app.request("/global/auth-check")).status).toBe(200);
      },
    );
  });

  test("public health omits the protocol drift counters that runtime-health carries", async () => {
    await withRuntimeMethod(
      "getHealth",
      () => ({
        state: "ready",
        generation: 1,
        circuitOpen: false,
        restartCount: 0,
        // Present on the engine snapshot, deliberately not fanned out publicly.
        unknownNotifications: 7,
        unsupportedItems: 3,
        serverRequests: { pending: 1 },
        storage: {},
      }),
      async () => {
        const serialized = JSON.stringify(await (await app.request("/global/health")).json());
        expect(serialized).not.toContain("unknownNotifications");
        expect(serialized).not.toContain("unsupportedItems");
        expect(serialized).not.toContain("serverRequests");
      },
    );
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
          clientSessionKey: "env-1:tab-1",
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
    expect(bodies).toEqual([{
      title: "New session",
      clientSessionKey: "env-1:tab-1",
    }, {}]);
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
      expect(await response.json()).toEqual({
        messages,
        messageWindow: { truncated: false },
      });
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

  test("bounds aggregate transcript responses by dropping the oldest messages", () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({
      id: `message-${index}`,
      role: "assistant" as const,
      content: String(index),
      parts: [{ type: "text" as const, content: "x".repeat(1024 * 1024) }],
      createdAt: "2026-07-25T12:00:00.000Z",
    }));

    const bounded = boundCodexTranscriptResponse(messages);
    expect(Buffer.byteLength(JSON.stringify(bounded)))
      .toBeLessThanOrEqual(MAX_CODEX_TRANSCRIPT_RESPONSE_BYTES);
    expect(bounded.messageWindow).toMatchObject({ truncated: true });
    expect(bounded.messages.at(-1)?.id).toBe("message-19");
    expect(bounded.messages[0]?.id).not.toBe("message-0");
  });

  test("trims parts off a single oversized message rather than dropping it", () => {
    // A long turn is one message, so message-level dropping has nothing left to
    // take. The newest parts are what the user is looking at and must survive.
    const parts = Array.from({ length: 40 }, (_, index) => ({
      type: "text" as const,
      content: `${index}:${"x".repeat(1024 * 1024)}`,
    }));
    const bounded = boundCodexTranscriptResponse([{
      id: "message-long-turn",
      role: "assistant" as const,
      content: "done",
      parts,
      createdAt: "2026-07-25T12:00:00.000Z",
    }]);

    expect(bounded.messages).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(bounded)))
      .toBeLessThanOrEqual(MAX_CODEX_TRANSCRIPT_RESPONSE_BYTES);
    expect(bounded.messageWindow.truncated).toBe(true);
    expect(bounded.messageWindow.omittedParts).toBeGreaterThan(0);
    expect(bounded.messageWindow.omittedMessages).toBeUndefined();
    expect(bounded.messages[0]?.parts.at(-1)).toEqual(parts.at(-1)!);
  });

  test("gzip-compresses transcript responses when the client accepts gzip", async () => {
    const messages = [{
      id: "message-compress",
      role: "assistant" as const,
      content: "done",
      parts: [{ type: "text" as const, content: "compressible ".repeat(8_192) }],
      createdAt: "2026-07-25T12:00:00.000Z",
    }];
    await withRuntimeMethod("getMessages", async () => messages, async () => {
      // happy-dom filters Accept-Encoding from RequestInit as a forbidden
      // browser header, so install it on the already-built test request.
      const request = new Request("http://localhost/session/session-1/messages");
      request.headers.set("Accept-Encoding", "gzip");
      const response = await app.request(request);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Encoding")).toBe("gzip");
      expect(response.headers.get("Vary")).toContain("Accept-Encoding");
      const decoded = JSON.parse(gunzipSync(Buffer.from(await response.arrayBuffer())).toString());
      expect(decoded.messages[0]?.id).toBe("message-compress");
    });
  });

  test("reports missing message and status snapshots as missing sessions", async () => {
    await withRuntimeMethod("getMessages", async () => null, async () => {
      const response = await app.request("/session/missing/messages");
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Session not found" });
    });

    await withRuntimeMethod("getStatus", () => null, async () => {
      const response = await app.request("/session/missing/status");
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Session not found" });
    });
  });

  test("answers the activity poll with 200 even for a session it has never seen", async () => {
    // The real runtime, not a stub: an unknown session must reach the in-band
    // `missing` answer rather than a 404. The backend reads a 404 from this path
    // as "the bridge predates this route" and fails the whole environment, so the
    // two cases have to stay distinguishable.
    const response = await app.request("/session/session-never-existed/activity");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ activity: "missing" });
  });

  test("serves the activity state for a known session", async () => {
    await withRuntimeMethod("getActivity", () => "waiting", async () => {
      const response = await app.request("/session/session-1/activity");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ activity: "waiting" });
    });
  });

  test("serves structured output and trims the optional request identifier", async () => {
    const calls: Array<{ sessionId: string; requestId?: string }> = [];
    let outcome: unknown = {
      requestId: "request-1",
      structuredOutput: {
        ok: true,
        provider: "codex",
        requestId: "request-1",
        value: { answer: 42 },
      },
    };

    await withRuntimeMethod(
      "getStructuredOutput",
      (sessionId: string, requestId?: string) => {
        calls.push({ sessionId, requestId });
        return outcome;
      },
      async () => {
        const response = await app.request(
          "/session/session-1/structured-output?requestId=%20request-1%20",
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(outcome);

        outcome = null;
        const missing = await app.request("/session/missing/structured-output");
        expect(missing.status).toBe(404);
        expect(await missing.json()).toEqual({ error: "Session not found" });
      },
    );

    expect(calls).toEqual([
      { sessionId: "session-1", requestId: "request-1" },
      { sessionId: "missing", requestId: undefined },
    ]);
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

  test("forwards a valid output schema and rejects invalid schemas before dispatch", async () => {
    const calls: unknown[] = [];
    const outputSchema = {
      type: "object",
      properties: {
        answer: { type: "string" },
      },
      required: ["answer"],
      additionalProperties: false,
    };

    await withRuntimeMethod(
      "prompt",
      async (sessionId: string, input: unknown) => {
        calls.push({ sessionId, input });
        return {
          ok: true,
          result: {
            status: "processing",
            requestId: "request-schema",
            threadId: "thread-1",
          },
        };
      },
      async () => {
        const accepted = await jsonRequest("/session/session-1/prompt", "POST", {
          prompt: "return structured data",
          requestId: " request-schema ",
          outputSchema,
        });
        expect(accepted.status).toBe(202);

        for (const invalid of [null, [], "object"]) {
          const rejected = await jsonRequest("/session/session-1/prompt", "POST", {
            prompt: "return structured data",
            requestId: "request-invalid",
            outputSchema: invalid,
          });
          expect(rejected.status).toBe(400);
          expect(await rejected.json()).toEqual({
            error: "outputSchema must be a JSON Schema object",
          });
        }
      },
    );

    expect(calls).toEqual([{
      sessionId: "session-1",
      input: {
        prompt: "return structured data",
        requestId: "request-schema",
        attachments: [],
        outputSchema,
      },
    }]);
  });

  test("accepts images, rejects unsupported files, and maps runtime failures", async () => {
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
          ],
        });
        expect(accepted.status).toBe(202);
        expect(await accepted.json()).toMatchObject({
          status: "processing",
          requestId: "request-1",
        });

        const unsupported = await jsonRequest("/session/session-1/prompt", "POST", {
          prompt: "read this file",
          requestId: "request-file",
          attachments: [{ type: "file", path: "/tmp/input.txt" }],
        });
        expect(unsupported.status).toBe(400);
        expect(await unsupported.json()).toEqual({
          error: "Codex supports image attachments only",
        });
        expect(calls).toHaveLength(1);

        /*
         * A partially valid prompt is refused whole rather than silently
         * losing the file: dispatching the image alone would run a turn whose
         * text refers to an attachment Codex never received.
         */
        const mixed = await jsonRequest("/session/session-1/prompt", "POST", {
          prompt: "compare these",
          requestId: "request-mixed",
          attachments: [
            { type: "image", path: "/tmp/image.png", dataUrl: "data:image/png;base64,AA==" },
            { type: "file", path: "/tmp/input.txt" },
          ],
        });
        expect(mixed.status).toBe(400);
        expect(await mixed.json()).toEqual({
          error: "Codex supports image attachments only",
        });
        expect(calls).toHaveLength(1);

        // A malformed entry is not a usable image either.
        for (const attachment of [null, { type: "image" }, { path: "/tmp/x.png" }]) {
          const malformed = await jsonRequest("/session/session-1/prompt", "POST", {
            prompt: "look",
            requestId: "request-malformed",
            attachments: [attachment],
          });
          expect(malformed.status).toBe(400);
          expect(await malformed.json()).toEqual({
            error: "Codex supports image attachments only",
          });
        }
        expect(calls).toHaveLength(1);

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

  /**
   * Driven through the real `forkSession`, not a stub: the point is that an
   * engine rejection is mapped by the route's own outcome switch instead of
   * escaping as a raw Hono 500, and that nothing is left registered behind it.
   */
  test("an engine rejection is mapped to 503 and leaves no orphan session", async () => {
    const engine = (runtime as unknown as {
      options: { engine: { forkThread: unknown } };
    }).options.engine;
    const originalForkThread = engine.forkThread;
    const registry = runtime.getRegistry();
    registry.createSession({
      id: "session-fork-parent",
      threadId: "thread-fork-parent",
      config: { mode: "build", cwd: "/workspace" },
      titleGenerationAttempted: true,
    });
    const before = registry.listSessions().length;
    engine.forkThread = async () => {
      throw new Error("app-server is restarting");
    };

    try {
      const response = await jsonRequest("/session/session-fork-parent/fork", "POST", {});
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "Codex did not return a forked thread" });
      expect(registry.listSessions()).toHaveLength(before);
    } finally {
      engine.forkThread = originalForkThread;
      registry.releaseSession("session-fork-parent");
    }
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
  test("rejects malformed JSON before reaching the runtime", async () => {
    let called = false;
    await withRuntimeMethod("steerSession", async () => {
      called = true;
      return "accepted";
    }, async () => {
      const response = await app.request("/session/session-1/steer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not-json",
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Request body must be valid JSON" });
    });
    expect(called).toBe(false);
  });

  test("validates every required steer field before reaching the runtime", async () => {
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

      for (const requestId of [undefined, "", "   ", 7, null]) {
        const response = await jsonRequest("/session/session-1/steer", "POST", {
          input: "check",
          requestId,
          expectedTurnId: "turn-1",
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "requestId is required" });
      }

      for (const expectedTurnId of [undefined, "", "   ", 7, null]) {
        const response = await jsonRequest("/session/session-1/steer", "POST", {
          input: "check",
          requestId: "req-steer",
          expectedTurnId,
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "expectedTurnId is required" });
      }
    });
    expect(called).toBe(false);
  });

  test("maps every steer outcome and trims the request fields", async () => {
    const calls: unknown[] = [];
    let outcome: "accepted" | "not-found" | "idle" | "mismatch" | "unknown" = "accepted";
    await withRuntimeMethod(
      "steerSession",
      async (sessionId: string, input: string, expectedTurnId: string, requestId: string) => {
        calls.push({ sessionId, input, expectedTurnId, requestId });
        return outcome;
      },
      async () => {
        const cases = [
          ["not-found", 404, { error: "Session not found" }],
          ["idle", 409, { error: "There is no active turn", outcome: "idle" }],
          [
            "mismatch",
            409,
            {
              error: "The active turn changed; the text was not sent",
              outcome: "mismatch",
            },
          ],
          [
            "unknown",
            503,
            {
              error: "Could not confirm whether Codex received the steering text",
              outcome: "unknown",
              requestId: "req-steer",
            },
          ],
          ["accepted", 202, { status: "accepted" }],
        ] as const;

        for (const [nextOutcome, status, body] of cases) {
          outcome = nextOutcome;
          const response = await jsonRequest("/session/session-1/steer", "POST", {
            input: "  also check the tests  ",
            requestId: "  req-steer  ",
            expectedTurnId: "  turn-1  ",
          });
          expect(response.status).toBe(status);
          expect(await response.json()).toEqual(body);
        }
      },
    );

    expect(calls[0]).toEqual({
      sessionId: "session-1",
      input: "also check the tests",
      expectedTurnId: "turn-1",
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
      // Protocol drift is served here, behind auth, rather than on public health.
      protocol: {
        unknownNotifications: 2,
        unsupportedItems: 0,
        serverRequests: { pending: 0, awaitingUser: 0 },
      },
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

  test("returns 404 for an unknown session instead of environment-wide health", async () => {
    await withRuntimeMethod("getRuntimeHealth", async () => null, async () => {
      const response = await app.request("/session/missing/runtime-health");
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Session not found" });
    });
  });
});
