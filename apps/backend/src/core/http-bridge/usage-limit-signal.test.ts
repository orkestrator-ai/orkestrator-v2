import { describe, expect, test } from "bun:test";
import { readProviderStatus } from "../native-agent-provider.js";
import { claudeConnection, codexConnection, httpProvider } from "../agent-provider-test-support.js";
import { nativeTerminalMessages } from "../native-terminal-messages.js";
import { bridgeSessionErrorFields } from "./transport.js";

/**
 * The bridges' structured usage-limit signal (`errorCode: "usage-limit"`
 * beside a failed turn's `error`) reaches status readers as `failureKind`; a
 * bridge that predates it still reports its error text, which readers then
 * classify themselves.
 */
describe("bridge usage-limit errorCode", () => {
  for (const connection of [claudeConnection, codexConnection]) {
    test(`${connection.agent}: errorCode usage-limit becomes failureKind`, async () => {
      const { provider } = httpProvider(
        () =>
          Response.json({ status: "error", error: "Request refused.", errorCode: "usage-limit" }),
        connection,
      );
      await expect(readProviderStatus(provider, "session-1")).resolves.toEqual({
        status: "error",
        error: "Request refused.",
        failureKind: "usage-limit",
      });
    });

    test(`${connection.agent}: an older bridge without errorCode keeps its text only`, async () => {
      const { provider } = httpProvider(
        () => Response.json({ status: "error", error: "You've hit your limit · resets 3pm" }),
        connection,
      );
      const observation = await readProviderStatus(provider, "session-1");
      expect(observation).toEqual({ status: "error", error: "You've hit your limit · resets 3pm" });
      expect(observation).not.toHaveProperty("failureKind");
    });
  }

  test("an unknown errorCode is not a usage limit", async () => {
    const { provider } = httpProvider(
      () => Response.json({ status: "error", error: "Overloaded", errorCode: "overloaded" }),
      codexConnection,
    );
    expect(await readProviderStatus(provider, "session-1")).toEqual({
      status: "error",
      error: "Overloaded",
    });
  });
});

describe("bridge failureReason", () => {
  test("a known reason travels beside the error only", () => {
    expect(bridgeSessionErrorFields({ error: "API error", failureReason: "billing" })).toEqual({
      error: "API error",
      failureReason: "billing",
    });
    // An unknown value, or a reason with no error, is dropped.
    expect(bridgeSessionErrorFields({ error: "API error", failureReason: "nope" })).toEqual({
      error: "API error",
    });
    expect(bridgeSessionErrorFields({ failureReason: "billing" })).toEqual({});
  });
});

test("Claude full and progressive reads project the same rejected-window reset", async () => {
  const failedTurn = {
    id: "failed-turn",
    occurredAt: "2026-11-19T10:00:00.000Z",
    resetsAt: "2026-11-21T00:00:00.000Z",
  };
  const { provider } = httpProvider(() =>
    Response.json({
      status: "error",
      error: "It failed.",
      failureReason: "usage-limit",
      failedTurn,
      rateLimits: [
        { label: "Weekly", usedPercent: 100, resetsAt: failedTurn.resetsAt },
        { label: "5-hour", usedPercent: 100, resetsAt: "2026-11-19T12:00:00.000Z" },
      ],
    }),
  );
  const full = await provider.interactiveSnapshot!("session-1");
  const progressive = await provider.sessionStateSnapshot!("session-1");
  expect(progressive.rateLimits).toEqual(full.rateLimits);
  expect(progressive.rateLimits).toHaveLength(2);
  expect(nativeTerminalMessages(progressive)).toEqual(nativeTerminalMessages(full));
  expect(nativeTerminalMessages(progressive)[0]?.failure).toEqual({
    reason: "usage-limit",
    resetsAt: failedTurn.resetsAt,
  });
});
