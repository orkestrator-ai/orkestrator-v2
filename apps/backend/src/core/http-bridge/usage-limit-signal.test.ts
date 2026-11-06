import { describe, expect, test } from "bun:test";
import { readProviderStatus } from "../native-agent-provider.js";
import { claudeConnection, codexConnection, httpProvider } from "../agent-provider-test-support.js";

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
