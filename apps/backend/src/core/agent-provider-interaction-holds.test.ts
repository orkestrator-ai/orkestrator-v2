import { describe, expect, test } from "bun:test";
import {
  AGENT_INTERACTION_HOLD_CEILING_MS,
  type AgentInteractionHold,
} from "@orkestrator/protocol/agent-interactions";
import {
  answerResolution,
  codexConnection,
  grokConnection,
  httpProvider,
  piConnection,
} from "./agent-provider-test-support.js";

/**
 * A bridge whose families are plain arrays, with a hold route that pauses or
 * resumes the named request the way a real bridge publishes it.
 */
function holdingBridge(families: Record<string, Array<Record<string, unknown>>>, idKey = "id") {
  const holds: Array<{ path: string; body: unknown }> = [];
  const answers: string[] = [];
  let holdStatus = 200;
  const handler = async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/answer")) {
      answers.push(path);
      return Response.json({ status: "answered" });
    }
    const hold = /^\/session\/[^/]+\/([^/]+)\/([^/]+)\/hold$/.exec(path);
    if (hold) {
      const body = JSON.parse(String(init.body)) as { held: boolean };
      holds.push({ path, body });
      if (holdStatus !== 200) return Response.json({ status: "refused" }, { status: holdStatus });
      const entry = families[hold[1]!]?.find(
        (candidate) => candidate[idKey] === decodeURIComponent(hold[2]!),
      );
      if (!entry) return Response.json({ status: "stale" }, { status: 409 });
      const now = Date.now();
      entry.hold = body.held ? { available: true, heldAt: now } : { available: true };
      entry.expiresAt = body.held ? now + AGENT_INTERACTION_HOLD_CEILING_MS : now + 300_000;
      return Response.json({ status: "applied", expiresAt: entry.expiresAt, hold: entry.hold });
    }
    const family = path.split("/").at(-1)!;
    const key = family === "plan-approvals" ? "approvals" : family;
    return Response.json({ [key]: families[family] ?? [] });
  };
  return {
    handler,
    holds,
    answers,
    refuseWith: (status: number) => {
      holdStatus = status;
    },
  };
}

function claudeQuestion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const requestedAt = Date.now();
  return {
    id: "question-1",
    requestedAt,
    expiresAt: requestedAt + 300_000,
    hold: { available: true },
    questions: [{ question: "Which?", header: "Pick", options: [{ label: "A" }] }],
    ...overrides,
  };
}

describe("pausing an interaction's deadline through the HTTP bridges", () => {
  test("Claude: publishes the bridge's hold, pauses on the bridge, and still answers", async () => {
    const families = {
      questions: [claudeQuestion()],
      "plan-approvals": [],
      interactions: [],
    };
    const bridge = holdingBridge(families);
    const { provider } = httpProvider(bridge.handler);

    const [request] = (await provider.interactions!.listPendingInteractions("session-1")).requests;
    expect(request?.hold).toEqual({ available: true });

    await expect(
      provider.interactions!.holdInteraction!("session-1", request!.id, true),
    ).resolves.toMatchObject({ result: "applied" });
    expect(bridge.holds).toEqual([
      { path: "/session/session-1/questions/question-1/hold", body: { held: true } },
    ]);

    const [paused] = (await provider.interactions!.listPendingInteractions("session-1")).requests;
    expect(paused?.hold).toEqual({ available: true, heldAt: expect.any(Number) });
    expect(paused!.expiresAt! - Date.now()).toBeGreaterThan(
      AGENT_INTERACTION_HOLD_CEILING_MS - 5_000,
    );
    // `createdAt` is the bridge's `requestedAt`, not "five minutes before the
    // deadline": a paused deadline a day out must not make an answer look early.
    expect(paused!.createdAt).toBe(families.questions[0]!.requestedAt as number);
    const resolution = { ...answerResolution(paused!), resolvedAt: Date.now() };
    await provider.interactions!.resolveInteraction("session-1", paused!.id, resolution);
    expect(bridge.answers).toEqual(["/session/session-1/questions/question-1/answer"]);
  });

  test("Claude: a pause that is already in place, or a resume of a running one, sends nothing", async () => {
    // One clock read: a pause stamped a millisecond before the request it
    // pauses is malformed, so separate `Date.now()` calls failed whenever a
    // millisecond boundary fell between them (flake 0878).
    const requestedAt = Date.now();
    const bridge = holdingBridge({
      questions: [
        claudeQuestion({
          requestedAt,
          expiresAt: requestedAt + 300_000,
          hold: { available: true, heldAt: requestedAt },
        }),
      ],
      interactions: [],
    });
    const { provider } = httpProvider(bridge.handler);
    const [request] = (await provider.interactions!.listPendingInteractions("session-1")).requests;
    await expect(
      provider.interactions!.holdInteraction!("session-1", request!.id, true),
    ).resolves.toMatchObject({ result: "applied" });
    expect(bridge.holds).toEqual([]);
  });

  test("an older bridge publishes no hold: the countdown shows but cannot be paused", async () => {
    const legacy = claudeQuestion();
    delete legacy.hold;
    delete legacy.requestedAt;
    const bridge = holdingBridge({ questions: [legacy], interactions: [] });
    const { provider } = httpProvider(bridge.handler);
    const [request] = (await provider.interactions!.listPendingInteractions("session-1")).requests;
    expect(request?.hold).toEqual({ available: false, reason: "bridge-outdated" });
    await expect(
      provider.interactions!.holdInteraction!("session-1", request!.id, true),
    ).resolves.toMatchObject({ result: "rejected" });
    expect(bridge.holds).toEqual([]);
  });

  test("a malformed hold keeps the card answerable and withholds only the pause", async () => {
    for (const hold of [
      { available: "yes" },
      { available: false },
      { available: true, heldAt: Date.now() + AGENT_INTERACTION_HOLD_CEILING_MS * 2 },
    ]) {
      const bridge = holdingBridge({ questions: [claudeQuestion({ hold })], interactions: [] });
      const { provider } = httpProvider(bridge.handler);
      const snapshot = await provider.interactions!.listPendingInteractions("session-1");
      expect(snapshot.requests).toHaveLength(1);
      expect(snapshot.requests[0]?.hold).toEqual({ available: false, reason: "bridge-outdated" });
    }
  });

  test("passes provider limits through, and refuses a pause the bridge says has no room", async () => {
    const reasons: AgentInteractionHold[] = [
      { available: true, reason: "provider-limit" },
      { available: true, reason: "upstream-may-expire" },
      { available: false, reason: "no-extension" },
    ];
    for (const hold of reasons) {
      const bridge = holdingBridge({ questions: [claudeQuestion({ hold })], interactions: [] });
      const { provider } = httpProvider(bridge.handler);
      const [request] = (await provider.interactions!.listPendingInteractions("session-1"))
        .requests;
      expect(request?.hold).toEqual(hold);
    }
  });

  test("maps bridge refusals: 409 is stale, 422 is rejected, 503 is retryable", async () => {
    for (const [status, result] of [
      [409, "stale"],
      [422, "rejected"],
      [503, "provider-unavailable"],
    ] as const) {
      const bridge = holdingBridge({ questions: [claudeQuestion()], interactions: [] });
      bridge.refuseWith(status);
      const { provider } = httpProvider(bridge.handler);
      const [request] = (await provider.interactions!.listPendingInteractions("session-1"))
        .requests;
      await expect(
        provider.interactions!.holdInteraction!("session-1", request!.id, true),
      ).resolves.toMatchObject({ result });
    }
  });

  test("routes each family to the hold route beside the one it was read from", async () => {
    const requestedAt = Date.now();
    const timing = { requestedAt, expiresAt: requestedAt + 300_000, hold: { available: true } };
    const cases: Array<{
      connection?: typeof codexConnection;
      idKey?: string;
      families: Record<string, Array<Record<string, unknown>>>;
      expected: string[];
    }> = [
      {
        connection: undefined,
        families: {
          questions: [],
          "plan-approvals": [{ id: "plan-1", plan: "# Plan", ...timing }],
          interactions: [
            { id: "tool-1", kind: "command-approval", command: "ls", toolName: "Bash", ...timing },
          ],
        },
        expected: [
          "/session/session-1/plan-approvals/plan-1/hold",
          "/session/session-1/interactions/tool-1/hold",
        ],
      },
      {
        connection: codexConnection,
        idKey: "approvalId",
        families: {
          approvals: [{ approvalId: "apr-1", kind: "command", command: "ls", ...timing }],
          interactions: [],
        },
        expected: ["/session/session-1/approvals/apr-1/hold"],
      },
      {
        connection: piConnection,
        idKey: "approvalId",
        families: {
          approvals: [{ approvalId: "pi-1", kind: "command", command: "ls", ...timing }],
          interactions: [],
        },
        expected: ["/session/session-1/approvals/pi-1/hold"],
      },
      {
        connection: grokConnection,
        families: {
          approvals: [
            {
              id: "perm-1",
              title: "Run ls",
              options: [{ optionId: "allow", name: "Allow" }],
              ...timing,
            },
          ],
          interactions: [
            {
              id: "plan-1",
              kind: "plan-approval",
              plan: "# Plan",
              planTruncated: false,
              ...timing,
            },
          ],
        },
        expected: [
          "/session/session-1/approvals/perm-1/hold",
          "/session/session-1/interactions/plan-1/hold",
        ],
      },
    ];
    for (const { connection, families, expected, idKey } of cases) {
      const bridge = holdingBridge(families, idKey);
      const { provider } = httpProvider(bridge.handler, connection);
      const snapshot = await provider.interactions!.listPendingInteractions("session-1");
      expect(snapshot.requests.map((request) => request.hold)).toEqual(
        expected.map(() => ({ available: true })),
      );
      for (const request of snapshot.requests) {
        await provider.interactions!.holdInteraction!("session-1", request.id, true);
      }
      expect(bridge.holds.map((hold) => hold.path).sort()).toEqual([...expected].sort());
    }
  });

  test("a Codex question without a deadline has nothing to pause", async () => {
    const bridge = holdingBridge({
      approvals: [],
      interactions: [
        {
          interactionId: "ask-1",
          kind: "question",
          requestedAt: Date.now(),
          isBlocking: true,
          questions: [{ id: "q", header: "Q", question: "Which?", options: [{ label: "A" }] }],
        },
      ],
    });
    const { provider } = httpProvider(bridge.handler, codexConnection);
    const [request] = (await provider.interactions!.listPendingInteractions("session-1")).requests;
    expect(request?.expiresAt).toBeUndefined();
    expect(request?.hold).toBeUndefined();
  });
});
