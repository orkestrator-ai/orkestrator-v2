import { describe, expect, test } from "bun:test";
import {
  GROK_INTERJECT_METHOD,
  GROK_INTERJECTION_NOTIFICATION,
  MAX_GROK_INTERJECTION_JOURNAL,
  applyGrokInterjectionBroadcast,
  grokRunId,
  markGrokInterjectionQueued,
  prepareGrokInterjection,
  probeGrokInterjectionExtension,
  requestGrokInterjection,
  type GrokInterjectionJournalEntry,
  type GrokRpcRequester,
} from "./grok-interjection.js";

function codedError(code: number): Error & { code: number } {
  return Object.assign(new Error("probe rejected"), { code });
}

describe("Grok interjection extension plumbing", () => {
  test("builds a process-scoped run token", () => {
    expect(grokRunId(7)).toMatch(/^grok:[A-Za-z0-9_-]+:7$/);
    expect(grokRunId(7)).toBe(grokRunId(7));
    expect(grokRunId(8)).not.toBe(grokRunId(7));
  });

  test("types and validates the private RPC result", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const requester: GrokRpcRequester = {
      async request(method, params) {
        calls.push({ method, params });
        return { status: "queued" };
      },
    };

    await expect(
      requestGrokInterjection(requester, {
        sessionId: "provider-session",
        interjectionId: "backend-request",
        text: "change direction",
      }),
    ).resolves.toEqual({ status: "queued" });
    expect(calls).toEqual([
      {
        method: GROK_INTERJECT_METHOD,
        params: {
          sessionId: "provider-session",
          interjectionId: "backend-request",
          text: "change direction",
        },
      },
    ]);

    await expect(
      requestGrokInterjection(
        { request: async () => ({ status: "accepted" }) },
        { sessionId: "provider-session", interjectionId: "request-2", text: "no" },
      ),
    ).rejects.toThrow("invalid interjection result");
  });

  test("pins preparation to the observed run and rejects id conflicts", () => {
    const journal = new Map<string, GrokInterjectionJournalEntry>();
    const input = {
      requestId: "request-1",
      expectedRunId: grokRunId(1),
      currentRunId: grokRunId(1),
      text: "use the smaller patch",
      running: true,
      now: 10,
    };

    expect(prepareGrokInterjection(journal, input).outcome).toBe("prepared");
    expect(prepareGrokInterjection(journal, input)).toEqual({
      outcome: "duplicate",
      state: "prepared",
    });
    expect(prepareGrokInterjection(journal, { ...input, text: "different" }).outcome).toBe(
      "conflict",
    );
    expect(
      prepareGrokInterjection(new Map(), { ...input, currentRunId: grokRunId(2) }).outcome,
    ).toBe("mismatch");
    expect(
      prepareGrokInterjection(new Map(), { ...input, running: false, currentRunId: undefined })
        .outcome,
    ).toBe("idle");
  });

  test("bounds the ledger and correlates only an exact delivery broadcast", () => {
    const journal = new Map<string, GrokInterjectionJournalEntry>();
    const runId = grokRunId(3);
    for (let index = 0; index <= MAX_GROK_INTERJECTION_JOURNAL; index += 1) {
      prepareGrokInterjection(journal, {
        requestId: `request-${index}`,
        expectedRunId: runId,
        currentRunId: runId,
        text: `text-${index}`,
        running: true,
        now: index,
      });
    }
    expect(journal.size).toBe(MAX_GROK_INTERJECTION_JOURNAL);
    expect(journal.has("request-0")).toBe(false);

    const requestId = `request-${MAX_GROK_INTERJECTION_JOURNAL}`;
    expect(markGrokInterjectionQueued(journal, requestId, 300)?.state).toBe("queued");
    expect(
      applyGrokInterjectionBroadcast(journal, "provider-session", GROK_INTERJECTION_NOTIFICATION, {
        sessionId: "provider-session",
        interjectionId: requestId,
        text: "wrong",
      }),
    ).toBeNull();
    expect(journal.get(requestId)?.state).toBe("queued");

    expect(
      applyGrokInterjectionBroadcast(
        journal,
        "provider-session",
        GROK_INTERJECTION_NOTIFICATION,
        {
          sessionId: "provider-session",
          interjectionId: requestId,
          text: `text-${MAX_GROK_INTERJECTION_JOURNAL}`,
        },
        400,
      ),
    ).toEqual({
      sessionId: "provider-session",
      interjectionId: requestId,
      text: `text-${MAX_GROK_INTERJECTION_JOURNAL}`,
    });
    expect(journal.get(requestId)).toMatchObject({ state: "delivered", updatedAt: 400 });
  });

  test("qualification distinguishes method absence from invalid-session rejection", async () => {
    const absent = await probeGrokInterjectionExtension({
      request: async () => {
        throw codedError(-32601);
      },
    });
    expect(absent).toEqual({
      extension: "absent",
      productionSteer: false,
      reason: "method-not-found",
    });

    const recognized = await probeGrokInterjectionExtension({
      request: async () => {
        throw codedError(-32602);
      },
    });
    expect(recognized).toEqual({
      extension: "available",
      productionSteer: false,
      reason: "recognized-invalid-session",
    });

    const unsafe = await probeGrokInterjectionExtension({
      request: async () => ({ status: "queued" }),
    });
    expect(unsafe).toEqual({
      extension: "available",
      productionSteer: false,
      reason: "unsafe-invalid-session-acceptance",
    });
  });
});
