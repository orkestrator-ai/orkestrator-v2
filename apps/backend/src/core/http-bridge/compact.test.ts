/**
 * `/compact` over an HTTP bridge: instructions travel only where the platform
 * honours them, and a bridge that predates them is detected by its answer.
 */
import { describe, expect, test } from "bun:test";
import {
  claudeConnection,
  codexConnection,
  grokConnection,
  httpProvider,
  piConnection,
} from "../agent-provider-test-support.js";
import { ProviderUnavailableError } from "../agent-provider-contract.js";
import { compatibilityPathUsage } from "../compatibility-path-usage.js";

const ignoredCount = () =>
  compatibilityPathUsage.snapshot().paths["compact.instructions-ignored"]?.count ?? 0;

describe("HTTP bridge compaction", () => {
  test.each([
    ["Claude", claudeConnection, { status: "processing" }],
    ["Pi", piConnection, { compacted: true }],
  ] as const)("a plain %s compaction sends no body", async (_name, connection, answer) => {
    const { provider, requests } = httpProvider(() => Response.json(answer), connection);
    await expect(provider.performSessionAction!("s/1", { kind: "compact" })).resolves.toEqual({
      outcome: "applied",
    });
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).pathname).toBe("/session/s%2F1/compact");
    expect(requests[0]!.init.method).toBe("POST");
    expect(requests[0]!.init.body).toBeUndefined();
  });

  test.each([
    ["Claude", claudeConnection, { status: "processing", instructions: "applied" }],
    ["Pi", piConnection, { compacted: true, instructions: "applied" }],
  ] as const)("%s receives instructions and confirms them", async (_name, connection, answer) => {
    const before = ignoredCount();
    const { provider, requests } = httpProvider(() => Response.json(answer), connection);
    await expect(
      provider.performSessionAction!("s-1", { kind: "compact", instructions: " keep the plan " }),
    ).resolves.toEqual({ outcome: "applied" });
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({ instructions: "keep the plan" });
    expect(ignoredCount()).toBe(before);
  });

  test.each([
    ["an older Claude bridge", claudeConnection, () => Response.json({ status: "processing" })],
    ["an older Pi bridge", piConnection, () => Response.json({ compacted: true })],
    ["an unreadable answer", piConnection, () => new Response("not json", { status: 200 })],
  ] as const)(
    "%s compacts without confirming, which is reported, not failed",
    async (_name, connection, answer) => {
      const before = ignoredCount();
      const { provider } = httpProvider(answer, connection);
      await expect(
        provider.performSessionAction!("s-1", { kind: "compact", instructions: "keep the plan" }),
      ).resolves.toEqual({ outcome: "applied", instructionsIgnored: true });
      expect(ignoredCount()).toBe(before + 1);
    },
  );

  test("a compaction Pi was asked to stop is refused in Pi's own words", async () => {
    const message =
      "Compaction was stopped before it finished; the conversation was not compacted.";
    const { provider } = httpProvider(
      () => Response.json({ error: message, cancelled: true }, { status: 409 }),
      piConnection,
    );
    await expect(provider.performSessionAction!("s-1", { kind: "compact" })).rejects.toThrow(
      new Error(message),
    );
    // Any other refusal keeps naming the operation and the status.
    const { provider: busy } = httpProvider(
      () => Response.json({ error: "Session is already running" }, { status: 409 }),
      piConnection,
    );
    await expect(busy.performSessionAction!("s-1", { kind: "compact" })).rejects.toThrow(
      "pi session compaction failed (HTTP 409): Session is already running",
    );
  });

  test.each(["Nothing to compact (session too small)", "Already compacted"])(
    "Pi's %s refusal is a definite failure that carries Pi's reason",
    async (reason) => {
      // The Pi bridge answers these two fixed SDK refusals 409 (not an opaque
      // 500), so the user and a coordinator's run_worker_command read why
      // nothing was compacted, and it is not retried as a bridge outage.
      const { provider, requests } = httpProvider(
        () => Response.json({ error: reason }, { status: 409 }),
        piConnection,
      );
      const refused = await provider.performSessionAction!("s-1", { kind: "compact" }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(Error);
      expect(refused).not.toBeInstanceOf(ProviderUnavailableError);
      expect((refused as Error).message).toBe(`pi session compaction failed (HTTP 409): ${reason}`);
      expect(requests).toHaveLength(1);
    },
  );

  test.each([
    ["Codex", codexConnection],
    ["Grok", grokConnection],
  ] as const)("never sends instructions to %s", async (_name, connection) => {
    const { provider, requests } = httpProvider(() => Response.json({}), connection);
    await expect(
      provider.performSessionAction!("s-1", { kind: "compact", instructions: "keep the plan" }),
    ).rejects.toThrow("cannot take compaction instructions");
    expect(requests).toEqual([]);
  });
});
