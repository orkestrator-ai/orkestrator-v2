import { expect, test } from "bun:test";
import {
  readProviderStatus,
  ProviderSessionFailedError,
  type ProviderSessionObservation,
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
