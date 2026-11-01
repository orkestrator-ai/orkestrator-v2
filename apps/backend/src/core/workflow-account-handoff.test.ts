import { expect, test } from "bun:test";
import { createNativeAgentProvider, type BridgeConnection } from "./native-agent-provider.js";

// Exercise the HTTP provider dispatch boundary shared by pipeline, review and
// graph owners, including replacement auth and preserving another live owner.
test("cached workflow dispatch refreshes idle bridge and preserves sibling work", async () => {
  let active = "a";
  let refreshes = 0;
  const dispatched: string[] = [];
  const dependencies = {
    refreshConnection: async (): Promise<BridgeConnection> => {
      refreshes++;
      return { agent: "claude", baseUrl: "http://bridge", authToken: active };
    },
    fetch: (async (_url: unknown, init?: RequestInit) => {
      if (String(_url).endsWith("/prompt"))
        dispatched.push(new Headers(init?.headers).get("X-Orkestrator-Claude-Token") ?? "");
      return Response.json({ status: "idle", sessionId: "session" });
    }) as typeof fetch,
  };
  const first = createNativeAgentProvider(
    { agent: "claude", baseUrl: "http://bridge", authToken: "a" },
    dependencies,
  );
  const second = createNativeAgentProvider(
    { agent: "claude", baseUrl: "http://bridge", authToken: "a" },
    dependencies,
  );
  try {
    await first.send("sibling", "work", { requestId: "one" });
    active = "b";
    await second.prepareDispatch!("next");
    expect(refreshes).toBe(0);
    await first.status("sibling");
    await second.prepareDispatch!("next");
    expect(refreshes).toBe(1);
    await second.send("next", "continue", { requestId: "two" });
    expect(dispatched).toEqual(["a", "b"]);
  } finally {
    first.dispose?.();
    second.dispose?.();
  }
});
