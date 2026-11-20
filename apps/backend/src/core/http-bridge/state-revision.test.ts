import { describe, expect, test } from "bun:test";
import type { BridgeConnection } from "../agent-provider-contract.js";
import { HttpBridgeProvider } from "./provider.js";

/**
 * A bridge serving the state route and its side routes, with the state
 * revision contract (to-do 8102 task 2) when `revisions` is on.
 */
function fakeBridge(agent: "codex" | "claude" | "pi", options: { revisions: boolean }) {
  const requests: string[] = [];
  const state = {
    revision: 1,
    composerRevision: 1,
    status: { status: "idle", phase: "idle", title: "One" } as Record<string, unknown>,
    approvals: [] as unknown[],
    queue: { items: [] as unknown[] },
    queueUnavailable: false,
    config: { model: "gpt", mode: "build" },
    beforeState: undefined as (() => Promise<void>) | undefined,
    onSideSample: undefined as (() => void) | undefined,
    malformedApprovals: false,
  };
  const composer = { models: [{ id: "m1", label: "M1" }], modes: [], selectedModelId: "m1" };
  const statePath = agent === "claude" ? "/session/s1" : "/session/s1/status";
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requests.push(url.pathname + url.search);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (url.pathname === statePath) {
      if (state.beforeState) await state.beforeState();
      const stateRevision = `gen:${state.revision}`;
      if (!options.revisions) return json(state.status);
      if (url.searchParams.get("knownStateRevision") === stateRevision) {
        return json({ unchanged: true, stateRevision });
      }
      const composerRevision = `cgen:${state.composerRevision}`;
      const composerKnown = url.searchParams.get("knownComposerRevision") === composerRevision;
      return json({
        ...state.status,
        stateRevision,
        ...(agent === "pi" ? { composerRevision, ...(composerKnown ? {} : { composer }) } : {}),
      });
    }
    if (url.pathname === "/session/s1/config") {
      const response = json(state.config);
      state.onSideSample?.();
      return response;
    }
    if (url.pathname === "/session/s1/queue") {
      const response = state.queueUnavailable
        ? new Response(null, { status: 503 })
        : json(state.queue);
      state.onSideSample?.();
      return response;
    }
    if (url.pathname === "/session/s1/approvals")
      return json(state.malformedApprovals ? {} : { approvals: state.approvals });
    if (url.pathname === "/session/s1/interactions") return json({ interactions: [] });
    if (url.pathname === "/session/s1/questions") return json({ questions: [] });
    if (url.pathname === "/session/s1/plan-approvals") return json({ approvals: [] });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const connection: BridgeConnection = {
    agent,
    baseUrl: "http://bridge.invalid",
    authToken: "token",
  };
  const provider = new HttpBridgeProvider(connection, fetchImpl);
  /** One round of the progressive state read: the state and the pending interactions. */
  const round = async () => {
    requests.length = 0;
    const [snapshot, interactions] = await Promise.all([
      provider.sessionStateSnapshot("s1"),
      provider.interactions.listPendingInteractions("s1"),
    ]);
    return {
      snapshot,
      interactions,
      requests: requests.filter((path) => !path.endsWith("/runtime-health")).sort(),
    };
  };
  return { provider, state, round, composer };
}

describe("HttpBridgeStateReads", () => {
  test("a quiet Codex round is one small unchanged request; a moved revision reads the side routes", async () => {
    const bridge = fakeBridge("codex", { revisions: true });
    const first = await bridge.round();
    expect(first.requests).toEqual([
      "/session/s1/approvals",
      "/session/s1/config",
      "/session/s1/config",
      "/session/s1/interactions",
      "/session/s1/status",
      "/session/s1/status?knownStateRevision=gen%3A1",
    ]);

    const quiet = await bridge.round();
    expect(quiet.requests).toEqual(["/session/s1/status?knownStateRevision=gen%3A1"]);
    // The reused body maps to the same snapshot.
    expect(quiet.snapshot).toEqual(first.snapshot);
    expect(quiet.interactions.requests).toEqual(first.interactions.requests);

    bridge.state.revision = 2;
    bridge.state.status = { ...bridge.state.status, title: "Two" };
    bridge.state.approvals = [
      {
        approvalId: "a1",
        threadId: "t1",
        kind: "command",
        command: "ls",
        cwd: "/w",
        requestedAt: 1,
        expiresAt: Date.now() + 60_000,
        actionable: true,
      },
    ];
    const moved = await bridge.round();
    expect(moved.requests).toEqual([
      "/session/s1/approvals",
      "/session/s1/config",
      "/session/s1/interactions",
      "/session/s1/status?knownStateRevision=gen%3A1",
      "/session/s1/status?knownStateRevision=gen%3A2",
    ]);
    expect(moved.snapshot).toMatchObject({ title: "Two" });
    expect(bridge.provider.stateReadMetrics()).toMatchObject({
      reads: 5,
      unchanged: 1,
      sideRoutesSkipped: 1,
    });
  });

  test("Claude's side routes are skipped while the revision stands", async () => {
    const bridge = fakeBridge("claude", { revisions: true });
    await bridge.round();
    const quiet = await bridge.round();
    expect(quiet.requests).toEqual(["/session/s1?knownStateRevision=gen%3A1"]);
  });

  test("a bridge without revisions is read in full every round, with no query", async () => {
    const bridge = fakeBridge("codex", { revisions: false });
    await bridge.round();
    const again = await bridge.round();
    expect(again.requests).toEqual([
      "/session/s1/approvals",
      "/session/s1/config",
      "/session/s1/interactions",
      "/session/s1/status",
    ]);
  });

  test("retries Pi's unavailable queue even when its state revision stays the same", async () => {
    const bridge = fakeBridge("pi", { revisions: true });
    bridge.state.queue.items = [{ id: "waiting-1" }];
    bridge.state.queueUnavailable = true;
    expect((await bridge.round()).snapshot).not.toHaveProperty("providerQueue");

    bridge.state.queueUnavailable = false;
    const recovered = await bridge.round();
    expect(recovered.requests).toContain("/session/s1/queue");
    expect(recovered.snapshot).toMatchObject({ providerQueue: bridge.state.queue });
    expect((await bridge.round()).requests).not.toContain("/session/s1/queue");
  });

  test.each(["codex", "pi"] as const)(
    "discards cold speculative side data for %s",
    async (agent) => {
      const bridge = fakeBridge(agent, { revisions: true });
      const held = Promise.withResolvers<void>();
      const sideSampled = Promise.withResolvers<void>();
      bridge.state.beforeState = () => held.promise;
      bridge.state.onSideSample = sideSampled.resolve;
      const first = bridge.provider.sessionStateSnapshot("s1");
      await sideSampled.promise;
      bridge.state.revision += 1;
      bridge.state.queue.items = [{ id: "new" }];
      bridge.state.config.model = "new";
      bridge.state.beforeState = undefined;
      held.resolve();
      const current = await first;
      if (agent === "pi")
        expect(current).toMatchObject({ providerQueue: { items: [{ id: "new" }] } });
      else expect(current).toMatchObject({ controls: { modelId: "new" } });
      expect(await bridge.provider.sessionStateSnapshot("s1")).toEqual(current);
    },
  );

  test("does not cache side responses if the revision moves after sampling", async () => {
    const bridge = fakeBridge("codex", { revisions: true });
    await bridge.round();
    bridge.state.revision = 2;
    bridge.state.config.model = "intermediate";
    bridge.state.onSideSample = () => {
      bridge.state.onSideSample = undefined;
      bridge.state.revision = 3;
      bridge.state.config.model = "final";
    };
    await bridge.round();
    const refreshed = await bridge.round();
    expect(refreshed.requests).toContain("/session/s1/config");
    expect(refreshed.snapshot).toMatchObject({ controls: { modelId: "final" } });
    expect((await bridge.round()).requests).toEqual([
      "/session/s1/status?knownStateRevision=gen%3A3",
    ]);
  });

  test("does not cache malformed approvals under a current revision", async () => {
    const bridge = fakeBridge("codex", { revisions: true });
    bridge.state.malformedApprovals = true;
    await expect(bridge.round()).rejects.toThrow("malformed interaction snapshot");
    bridge.state.malformedApprovals = false;
    bridge.state.approvals = [
      {
        approvalId: "approval",
        threadId: "t1",
        kind: "command",
        command: "ls",
        cwd: "/w",
        requestedAt: 1,
        expiresAt: Date.now() + 60_000,
        actionable: true,
      },
    ];
    const recovered = await bridge.round();
    expect(recovered.requests).toContain("/session/s1/approvals");
    expect(recovered.interactions.requests).toHaveLength(1);
  });

  test("Pi's composer is sent only when its own revision moved", async () => {
    const bridge = fakeBridge("pi", { revisions: true });
    const first = await bridge.round();
    expect(first.snapshot).toMatchObject({ composer: bridge.composer });

    // The state moved, the composer did not: the bridge leaves it out.
    bridge.state.revision = 2;
    bridge.state.status = { ...bridge.state.status, title: "Two" };
    const moved = await bridge.round();
    expect(moved.requests).toContain(
      "/session/s1/status?knownStateRevision=gen%3A1&knownComposerRevision=cgen%3A1",
    );
    expect(moved.snapshot).toMatchObject({ title: "Two", composer: bridge.composer });
    expect(bridge.provider.stateReadMetrics().composerReused).toBe(1);

    const quiet = await bridge.round();
    expect(quiet.requests).toEqual([
      "/session/s1/status?knownStateRevision=gen%3A2&knownComposerRevision=cgen%3A1",
    ]);
    expect(quiet.snapshot).toEqual(moved.snapshot);
  });
});
