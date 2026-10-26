import { expect, test } from "bun:test";
import {
  readProviderStatus,
  ProviderSessionFailedError,
  type ProviderSessionObservation,
  type ProviderDispatchStatus,
} from "./agent-provider-contract.js";

test.each(["observation", "throw"] as const)(
  "a restart reported through %s retains completion proof for the current request",
  async (source) => {
    const settled: string[] = [];
    const provider = {
      async status() {
        return "error" as const;
      },
      async observeSession(): Promise<ProviderSessionObservation> {
        if (source === "throw")
          throw new ProviderSessionFailedError("claude", "old request interrupted", {
            interruption: "restart",
          });
        return { status: "error", interruption: "restart" };
      },
      async settleTurn(sessionId: string, requestId: string) {
        settled.push(`${sessionId}/${requestId}`);
        return requestId === "old";
      },
    };
    expect(await readProviderStatus(provider, "session", "continuation")).toMatchObject({
      status: "error",
      interruption: "restart",
      turnSettled: false,
    });
    expect(await readProviderStatus(provider, "session", "old")).toMatchObject({
      status: "error",
      interruption: "restart",
      turnSettled: true,
    });
    expect(settled).toEqual(["session/continuation", "session/old"]);
    // Status-only readers cannot settle workflow permissions.
    await readProviderStatus(provider, "session");
    expect(settled).toHaveLength(2);
  },
);

test.each(["observation", "throw"] as const)(
  "only a pending watched request supersedes a named restart from %s",
  async (source) => {
    const observation: ProviderSessionObservation = {
      status: "error",
      interruption: "restart",
      interruptedRequestId: "later-turn",
    };
    const provider = {
      async status() {
        return "error" as const;
      },
      async observeSession() {
        if (source === "throw") {
          throw new ProviderSessionFailedError("claude", "later turn interrupted", observation);
        }
        return observation;
      },
    };
    // Isolate the optional-method guard: the notice DOES name another request.
    expect(await readProviderStatus(provider, "session", "finished-turn")).toMatchObject(
      observation,
    );
    for (const acceptance of ["pending", "dispatched", "unknown", "lost", "throws"] as const) {
      const status = await readProviderStatus(
        {
          ...provider,
          async dispatchStatus(
            sessionId: string,
            requestId: string,
          ): Promise<ProviderDispatchStatus> {
            expect([sessionId, requestId]).toEqual(["session", "finished-turn"]);
            if (acceptance === "throws") throw new Error("journal unavailable");
            return acceptance;
          },
        },
        "session",
        "finished-turn",
      );
      if (acceptance === "pending") {
        expect(status).toEqual({ status: "idle", turnSettled: false });
      } else {
        // `dispatched` includes terminal/already-processed requests: their
        // positive journal entry must not mask a later turn's interruption.
        expect(status).toMatchObject(observation);
        expect(status.turnSettled).toBeUndefined();
      }
    }
  },
);
