import { afterEach, describe, expect, test } from "bun:test";
import type {
  AgentInteractionHold,
  AgentInteractionRequest,
} from "@orkestrator/protocol/agent-interactions";
import type { PublicInteraction } from "@orkestrator/protocol/public-api-resources";
import { cleanupSessionHarnesses, setup } from "./test-provider.js";

/**
 * `session.interaction.hold` through the real native-agent service and the
 * real `hold_native_agent_interaction` command, with a scripted provider
 * standing in for the bridge that owns the deadline.
 */

afterEach(cleanupSessionHarnesses);

const HOUR = 60 * 60_000;

function approval(
  sessionId: string,
  overrides: Partial<AgentInteractionRequest> = {},
): AgentInteractionRequest {
  return {
    version: 1,
    id: "approval-1",
    provider: "claude",
    kind: "command-approval",
    origin: "interactive-native",
    sessionId,
    state: "pending",
    revision: 2,
    presentation: { title: "Run touch marker", questions: [] },
    createdAt: Date.now() - 1_000,
    updatedAt: Date.now() - 1_000,
    expiresAt: Date.now() + 5 * 60_000,
    hold: { available: true },
    ...overrides,
  } as AgentInteractionRequest;
}

async function holdSetup() {
  const context = await setup();
  const { harness, stub } = context;
  const started = await harness.call<{ sessionId: string; tabId: string; runId: string }>(
    "session.start",
    { environmentId: "env-1", agent: "claude", prompt: "do the thing" },
    { requestId: "hold-start" },
  );
  if (!started.ok) throw new Error(`session.start failed: ${started.error.code}`);
  const providerSessionId = stub.sends[0]!.sessionId;
  const holds: Array<{ interactionId: string; held: boolean }> = [];
  let holdResult = "applied";
  Object.assign(stub.provider.interactions!, {
    holdInteraction: async (sessionId: string, interactionId: string, held: boolean) => {
      holds.push({ interactionId, held });
      const request = stub.pending.find((candidate) => candidate.id === interactionId);
      if (holdResult === "applied" && request) {
        request.hold = held
          ? { available: true, heldAt: Date.now() }
          : ({ available: true } satisfies AgentInteractionHold);
        request.expiresAt = Date.now() + (held ? 24 * HOUR : 5 * 60_000);
      }
      return { result: holdResult, interactionId, sessionId, revision: 3 };
    },
  });
  return {
    ...context,
    sessionId: started.result.sessionId,
    providerSessionId,
    holds,
    setHoldResult(next: string) {
      holdResult = next;
    },
  };
}

describe("session.interaction.hold", () => {
  test("lists hold state, pauses and resumes, and replays a key without holding twice", async () => {
    const { harness, stub, sessionId, providerSessionId, holds } = await holdSetup();
    stub.pending.push(approval(providerSessionId, { hold: { available: true } }));

    const listed = await harness.call<{ items: PublicInteraction[] }>("session.interactions", {
      sessionId,
    });
    expect(listed.ok && listed.result.items[0]?.hold).toEqual({ available: true });

    const paused = await harness.call<{ interactionId: string; held: boolean; expiresAt: number }>(
      "session.interaction.hold",
      { sessionId, interactionId: "approval-1", held: true },
      { requestId: "hold-1" },
    );
    expect(paused.ok).toBe(true);
    if (!paused.ok) return;
    expect(paused.result).toMatchObject({ interactionId: "approval-1", held: true });
    expect(paused.result.expiresAt).toBeGreaterThan(Date.now() + 23 * HOUR);
    expect(paused.receipt?.resources).toMatchObject({ interactionId: "approval-1" });
    expect(holds).toEqual([{ interactionId: "approval-1", held: true }]);

    const relisted = await harness.call<{ items: PublicInteraction[] }>("session.interactions", {
      sessionId,
    });
    expect(relisted.ok && typeof relisted.result.items[0]?.hold?.heldAt).toBe("number");

    const replay = await harness.call(
      "session.interaction.hold",
      { sessionId, interactionId: "approval-1", held: true },
      { requestId: "hold-1" },
    );
    expect(replay.receipt?.replayed).toBe(true);
    expect(holds).toHaveLength(1);

    const conflict = await harness.call(
      "session.interaction.hold",
      { sessionId, interactionId: "approval-1", held: false },
      { requestId: "hold-1" },
    );
    expect(!conflict.ok && conflict.error.code).toBe("request-conflict");
    expect(holds).toHaveLength(1);

    const resumed = await harness.call(
      "session.interaction.hold",
      { sessionId, interactionId: "approval-1", held: false },
      { requestId: "hold-2" },
    );
    expect(resumed.ok).toBe(true);
    expect(holds.at(-1)).toEqual({ interactionId: "approval-1", held: false });
    // Pausing never answers anything.
    expect(stub.resolutions).toHaveLength(0);
  });

  test("an unknown or expired interaction is stale and nothing reaches the provider", async () => {
    const { harness, stub, sessionId, providerSessionId, holds } = await holdSetup();
    const unknown = await harness.call(
      "session.interaction.hold",
      { sessionId, interactionId: "missing", held: true },
      { requestId: "hold-missing" },
    );
    expect(!unknown.ok && unknown.error.code).toBe("interaction-stale");

    stub.pending.push(approval(providerSessionId, { expiresAt: Date.now() - 1 }));
    const expired = await harness.call(
      "session.interaction.hold",
      { sessionId, interactionId: "approval-1", held: true },
      { requestId: "hold-expired" },
    );
    expect(!expired.ok && expired.error.code).toBe("interaction-stale");
    expect(holds).toHaveLength(0);
  });

  test("an outdated bridge, an unavailable pause or no countdown is refused before the provider", async () => {
    const { harness, stub, sessionId, providerSessionId, holds } = await holdSetup();
    stub.pending.push(
      approval(providerSessionId, {
        id: "outdated",
        hold: { available: false, reason: "bridge-outdated" },
      }),
      approval(providerSessionId, {
        id: "no-extension",
        hold: { available: false, reason: "no-extension" },
      }),
      approval(providerSessionId, { id: "unpublished", hold: undefined }),
      approval(providerSessionId, { id: "no-deadline", expiresAt: undefined, hold: undefined }),
    );

    const outdated = await harness.call(
      "session.interaction.hold",
      { sessionId, interactionId: "outdated", held: true },
      { requestId: "hold-outdated" },
    );
    expect(!outdated.ok && outdated.error).toMatchObject({
      code: "unsupported",
      details: { reason: "bridge-outdated" },
    });
    const noExtension = await harness.call(
      "session.interaction.hold",
      { sessionId, interactionId: "no-extension", held: true },
      { requestId: "hold-no-extension" },
    );
    expect(!noExtension.ok && noExtension.error).toMatchObject({
      code: "unsupported",
      details: { reason: "no-extension" },
    });
    const unpublished = await harness.call(
      "session.interaction.hold",
      { sessionId, interactionId: "unpublished", held: true },
      { requestId: "hold-unpublished" },
    );
    expect(!unpublished.ok && unpublished.error.code).toBe("unsupported");
    const noDeadline = await harness.call(
      "session.interaction.hold",
      { sessionId, interactionId: "no-deadline", held: true },
      { requestId: "hold-no-deadline" },
    );
    expect(!noDeadline.ok && noDeadline.error.code).toBe("unsupported");
    expect(holds).toHaveLength(0);
  });

  test("provider outcomes map onto stale, retryable and refused failures", async () => {
    const { harness, stub, sessionId, providerSessionId, setHoldResult } = await holdSetup();
    stub.pending.push(approval(providerSessionId));

    setHoldResult("provider-unavailable");
    const unavailable = await harness.call(
      "session.interaction.hold",
      { sessionId, interactionId: "approval-1", held: true },
      { requestId: "hold-unavailable" },
    );
    expect(!unavailable.ok && unavailable.error.code).toBe("connection-failed");

    setHoldResult("stale");
    const stale = await harness.call(
      "session.interaction.hold",
      { sessionId, interactionId: "approval-1", held: true },
      { requestId: "hold-stale" },
    );
    expect(!stale.ok && stale.error.code).toBe("interaction-stale");

    setHoldResult("rejected");
    const rejected = await harness.call(
      "session.interaction.hold",
      { sessionId, interactionId: "approval-1", held: true },
      { requestId: "hold-rejected" },
    );
    expect(!rejected.ok && rejected.error.code).toBe("unsupported");
  });

  test("held is required and must be a boolean", async () => {
    const { harness, sessionId } = await holdSetup();
    const missing = await harness.call(
      "session.interaction.hold",
      { sessionId, interactionId: "approval-1" },
      { requestId: "hold-no-held" },
    );
    expect(!missing.ok && missing.error.code).toBe("invalid-input");
    const wrong = await harness.call(
      "session.interaction.hold",
      { sessionId, interactionId: "approval-1", held: "yes" },
      { requestId: "hold-bad-held" },
    );
    expect(!wrong.ok && wrong.error.code).toBe("invalid-input");
  });
});
