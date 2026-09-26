/**
 * Mapping of the bridge's definitive steer refusal (HTTP 429 +
 * `{ outcome: "rejected", reason, requestId, message }`). Only that exact
 * shape for the request's own id proves "not sent"; everything else must stay
 * on the conservative path, where a thrown error or `unknown` keeps the steer
 * parked for reconciliation.
 */
import { describe, expect, test } from "bun:test";
import { MAX_NATIVE_AGENT_STEER_REJECTION_MESSAGE_CHARS } from "@orkestrator/protocol/native-agent";
import {
  claudeConnection,
  cursorConnection,
  httpProvider,
  piConnection,
} from "./agent-provider-test-support.js";

const steer = (requestId = "steer-1") => ({
  kind: "steer" as const,
  text: "Keep the change narrow",
  requestId,
  expectedRunId: "run-1",
});

const refusal = {
  outcome: "rejected",
  reason: "steer-capacity-exceeded",
  requestId: "steer-1",
  message: "Wait for this turn to finish, then send again.",
};

describe("HTTP bridge steer rejection mapping", () => {
  test.each([
    ["cursor", cursorConnection],
    ["pi", piConnection],
    ["claude", claudeConnection],
  ] as const)(
    "maps the verified %s 429 refusal to a typed rejection",
    async (_name, connection) => {
      const { provider, requests } = httpProvider(
        () => Response.json(refusal, { status: 429 }),
        connection,
      );

      await expect(provider.performSessionAction!("session-1", steer())).resolves.toEqual({
        outcome: "rejected",
        reason: "steer-capacity-exceeded",
        requestId: "steer-1",
        message: "Wait for this turn to finish, then send again.",
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url.endsWith("/session/session-1/steer")).toBe(true);
    },
  );

  test("maps history-unavailable and bounds the bridge's message", async () => {
    const { provider } = httpProvider(
      () =>
        Response.json(
          {
            ...refusal,
            reason: "steer-history-unavailable",
            message: `Line one\n${"x".repeat(2_000)}`,
          },
          { status: 429 },
        ),
      cursorConnection,
    );

    const outcome = await provider.performSessionAction!("session-1", steer());
    expect(outcome).toMatchObject({
      outcome: "rejected",
      reason: "steer-history-unavailable",
      requestId: "steer-1",
    });
    const message = (outcome as { message?: string }).message!;
    expect(message.startsWith("Line one x")).toBe(true);
    expect(message.length).toBeLessThanOrEqual(MAX_NATIVE_AGENT_STEER_REJECTION_MESSAGE_CHARS);
  });

  test("omits a missing or blank message rather than inventing one", async () => {
    const { provider } = httpProvider(
      () => Response.json({ ...refusal, message: " \n " }, { status: 429 }),
      cursorConnection,
    );
    await expect(provider.performSessionAction!("session-1", steer())).resolves.toEqual({
      outcome: "rejected",
      reason: "steer-capacity-exceeded",
      requestId: "steer-1",
    });
  });

  test.each([
    ["a generic 429", 429, { error: "Too many requests" }],
    ["an empty 429", 429, ""],
    ["a malformed 429 body", 429, "{not json"],
    ["a 429 for another request id", 429, { ...refusal, requestId: "steer-2" }],
    ["a 429 without a request id", 429, { ...refusal, requestId: undefined }],
    ["a 429 with an unknown reason", 429, { ...refusal, reason: "rate-limited" }],
    ["a 503 carrying the refusal shape", 503, refusal],
    ["a 500", 500, { error: "boom" }],
  ] as const)("keeps %s conservative", async (_name, status, body) => {
    const { provider } = httpProvider(
      () =>
        typeof body === "string"
          ? new Response(body, { status, headers: { "content-type": "application/json" } })
          : Response.json(body, { status }),
      cursorConnection,
    );

    // Either an ambiguous outcome or a throw (which the storage barrier parks
    // as unknown) is acceptable; a definitive rejection is not.
    const outcome = await provider.performSessionAction!("session-1", steer()).catch(() => ({
      outcome: "thrown" as const,
    }));
    expect(["unknown", "thrown"]).toContain(outcome.outcome);
  });

  test("never reports a 2xx refusal-shaped body as applied", async () => {
    const { provider } = httpProvider(
      () => Response.json(refusal, { status: 200 }),
      cursorConnection,
    );
    await expect(provider.performSessionAction!("session-1", steer())).resolves.toEqual({
      outcome: "unknown",
      requestId: "steer-1",
    });
  });

  test("treats a transport failure as unknown, never as rejected", async () => {
    const { provider } = httpProvider(() => {
      throw new TypeError("fetch failed");
    }, cursorConnection);
    await expect(provider.performSessionAction!("session-1", steer())).resolves.toEqual({
      outcome: "unknown",
      requestId: "steer-1",
    });
  });

  test("leaves the other steer outcomes unchanged", async () => {
    for (const [status, body, expected] of [
      [202, { outcome: "applied" }, { outcome: "applied" }],
      [200, { outcome: "idle" }, { outcome: "idle" }],
      [409, { outcome: "mismatch" }, { outcome: "mismatch" }],
      [503, { outcome: "unknown" }, { outcome: "unknown", requestId: "steer-1" }],
    ] as const) {
      const { provider } = httpProvider(() => Response.json(body, { status }), cursorConnection);
      await expect(provider.performSessionAction!("session-1", steer())).resolves.toEqual(expected);
    }
  });

  test("maps an unpublished steer record to a definitive refusal", async () => {
    // The bridge prepared the record but could not publish it, so it refused
    // before any provider side effect: provably not sent.
    const { provider, requests } = httpProvider(
      () =>
        Response.json(
          { ...refusal, reason: "steer-not-recorded", message: "Send it again." },
          { status: 429 },
        ),
      cursorConnection,
    );
    await expect(provider.performSessionAction!("session-1", steer())).resolves.toEqual({
      outcome: "rejected",
      reason: "steer-not-recorded",
      requestId: "steer-1",
      message: "Send it again.",
    });
    expect(requests).toHaveLength(1);
  });

  test.each([
    ["the bare fenced-run answer", { outcome: "unknown" }],
    ["one naming this request", { outcome: "unknown", requestId: "steer-1" }],
    [
      "one carrying a refusal reason and message",
      {
        outcome: "unknown",
        requestId: "steer-1",
        reason: "steer-history-unavailable",
        message: "History for this run was evicted.",
      },
    ],
    ["a refusal-shaped not-recorded body", { ...refusal, reason: "steer-not-recorded" }],
  ] as const)(
    "never treats a 503 for a fenced run with a missing record (%s) as definitive",
    async (_name, body) => {
      // A retry whose record was evicted for a still-targetable run may already
      // have been delivered; only reconciliation can settle it.
      const { provider } = httpProvider(
        () => Response.json(body, { status: 503 }),
        cursorConnection,
      );
      await expect(provider.performSessionAction!("session-1", steer())).resolves.toEqual({
        outcome: "unknown",
        requestId: "steer-1",
      });
    },
  );
});
