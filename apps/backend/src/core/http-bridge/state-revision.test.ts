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
  };
  const composer = { models: [{ id: "m1", label: "M1" }], modes: [], selectedModelId: "m1" };
  const statePath = agent === "claude" ? "/session/s1" : "/session/s1/status";
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requests.push(url.pathname + url.search);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (url.pathname === statePath) {
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
    if (url.pathname === "/session/s1/config") return json({ model: "gpt", mode: "build" });
    if (url.pathname === "/session/s1/queue") return json({ items: [] });
    if (url.pathname === "/session/s1/approvals") return json({ approvals: state.approvals });
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
      "/session/s1/interactions",
      "/session/s1/status",
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
    ]);
    expect(moved.snapshot).toMatchObject({ title: "Two" });
    expect(bridge.provider.stateReadMetrics()).toMatchObject({
      reads: 3,
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
