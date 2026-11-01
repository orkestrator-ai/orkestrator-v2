import { expect, test } from "bun:test";
import {
  createNativeAgentProvider,
  ProviderSessionFailedError,
  trackRunningTurns,
  type BridgeConnection,
  type NativeAgentRuntimeProvider,
} from "./native-agent-provider.js";

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

// A bridge reports a failed turn by throwing, so a real stopped turn never reads
// "error" here. Left marked as running, it held its own resend back for two minutes.
test("a turn whose poll throws its failure no longer counts as running", async () => {
  const provider = {
    send: async () => undefined,
    status: async () => {
      throw new ProviderSessionFailedError("claude", "You've hit your weekly limit");
    },
  } as unknown as NativeAgentRuntimeProvider;
  const running = trackRunningTurns(provider);
  await provider.send!("session", "work", { requestId: "one" });
  expect(running()).toBe(true);
  await expect(provider.status("session")).rejects.toBeInstanceOf(ProviderSessionFailedError);
  expect(running()).toBe(false);
});

test("a poll that fails for another reason keeps the turn counted", async () => {
  const provider = {
    send: async () => undefined,
    status: async () => {
      throw new Error("The bridge did not answer");
    },
  } as unknown as NativeAgentRuntimeProvider;
  const running = trackRunningTurns(provider);
  await provider.send!("session", "work", { requestId: "one" });
  await expect(provider.status("session")).rejects.toThrow("did not answer");
  expect(running()).toBe(true);
});

test("cached siblings and new providers adopt the replacement while its turn is running", async () => {
  const { workflowBridgeRunning } = await import("./native-agent-provider.js");
  const { NativeAgentLaunchActivityReconciler } =
    await import("./native-agent-launch-activity-reconciler.js");
  let refreshes = 0;
  const urls: string[] = [];
  const dependencies = {
    bridgeEnvironmentId: "handoff-env",
    refreshConnection: async (): Promise<BridgeConnection> => {
      refreshes++;
      return { agent: "claude", baseUrl: "http://replacement", authToken: "b" };
    },
    fetch: (async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith("/prompt")) {
        urls.push(String(url));
        expect(new Headers(init?.headers).get("X-Orkestrator-Claude-Token")).toBe("b");
      }
      return Response.json({ status: "idle", sessionId: "session" });
    }) as typeof fetch,
  };
  const original: BridgeConnection = {
    agent: "claude",
    baseUrl: "http://original",
    authToken: "a",
  };
  const first = createNativeAgentProvider({ ...original }, dependencies);
  const secondConnection = { ...original, model: "owner-model", effort: "high" };
  const second = createNativeAgentProvider(secondConnection, dependencies);
  let third: NativeAgentRuntimeProvider | undefined;
  try {
    await first.prepareDispatch!("one");
    await first.send("one", "work", { requestId: "one" });
    expect(workflowBridgeRunning("handoff-env", "claude")).toBe(true);
    // This is the busy check used both by native resend and process replacement.
    expect(
      await NativeAgentLaunchActivityReconciler.prototype.hasObservedLiveWork.call(
        {
          providerRegistry: { cached: () => undefined },
          storage: { listNativeAgentSessions: async () => [] },
        } as never,
        "handoff-env",
        "claude",
      ),
    ).toBe(true);
    await second.prepareDispatch!("two");
    await second.send("two", "work", { requestId: "two" });
    third = createNativeAgentProvider(
      { agent: "claude", baseUrl: "http://replacement", authToken: "b" },
      dependencies,
    );
    await third.prepareDispatch!("three");
    expect(refreshes).toBe(1);
    expect(secondConnection.model).toBe("owner-model");
    expect(secondConnection.effort).toBe("high");
    expect(urls).toEqual([
      "http://replacement/session/one/prompt",
      "http://replacement/session/two/prompt",
    ]);
    await first.status("one");
    await second.status("two");
    expect(workflowBridgeRunning("handoff-env", "claude")).toBe(false);
  } finally {
    first.dispose?.();
    second.dispose?.();
    third?.dispose?.();
  }
});
