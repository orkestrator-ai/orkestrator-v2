import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ENVIRONMENT_ATTENTION_EVENT } from "@orkestrator/protocol/environment-attention";
import type { BackendId } from "@orkestrator/protocol/federation";
import * as nodeEvents from "@/lib/federation/node-events";
import type { NodeScope, NodeScopeTier } from "@/lib/node-scope/node-scope";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { portalStore } from "@/lib/portal/portal-store";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { uiStore } from "@/stores/uiStore";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import {
  ATTENTION_HANDOVER_TIMEOUT_MS,
  attentionHandoff,
  shownEnvironmentOn,
  startWindowAttention,
  type AttentionSource,
  type WindowAttention,
} from "./window-attention";

const SELF = "bk_self" as BackendId;
const LEAF = "bk_leaf" as BackendId;
const OTHER = "bk_other" as BackendId;

interface Subscription {
  subscriber: nodeEvents.NodeEventSubscriber;
  stop: ReturnType<typeof mock>;
  released: boolean;
}
const subscriptions = new Map<string, Subscription[]>();
let subscribe: ReturnType<typeof spyOn>;

function relay(nodeId: string): Subscription | undefined {
  return subscriptions.get(nodeId)?.find((entry) => !entry.released);
}

function attention(attentionId: string, reason = "agent_finished") {
  return {
    attentionId,
    environmentId: "leaf-env",
    projectId: "leaf-project",
    reason,
    occurredAt: new Date(0).toISOString(),
  };
}

function summary(nodeId: string) {
  return { nodeId, available: true, loadedAt: 1, view: { nodeId }, projects: [], environments: [] };
}

function setNodes(...nodeIds: string[]) {
  portalStore.store.setState({ selfId: SELF as never, nodes: nodeIds.map(summary) as never });
}

/** A leaf client whose stream goes live only when the test says so. */
function gatedClient(nodeId: BackendId) {
  const client = new FakeNodeClient({ nodeId });
  let open: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    open = resolve;
  });
  client.eventStreamReady = () => ready;
  return { client, open };
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

let windowScope: WindowScope;
let service: WindowAttention | null;
const seen: string[] = [];

/** Armed handover waits, run by the test instead of the wall clock. */
const waits = new Set<{ run: () => void; ms: number }>();
function schedule(run: () => void, ms: number): () => void {
  const wait = { run, ms };
  waits.add(wait);
  return () => waits.delete(wait);
}
function elapse(): void {
  for (const wait of Array.from(waits)) {
    waits.delete(wait);
    wait.run();
  }
}

function start(): WindowAttention {
  service = startWindowAttention({
    windowScope,
    onAttention: (nodeId, event, source: AttentionSource) =>
      seen.push(`${nodeId}:${event.attentionId}:${source}`),
    schedule,
  });
  return service;
}

/** Shows `nodeId` in the window's own tree: in-tree, and held by the region. */
function holdInTree(...nodeIds: string[]) {
  useRemoteWorkspaceStore.setState({ openNodes: nodeIds });
}

function openLeaf(client: FakeNodeClient, tier: NodeScopeTier = "live"): NodeScope {
  return windowScope.open({ role: "leaf", client, tier });
}

const initialPortal = portalStore.store.getState();

beforeEach(() => {
  seen.length = 0;
  waits.clear();
  service = null;
  subscriptions.clear();
  subscribe = spyOn(nodeEvents, "subscribeNodeEvents").mockImplementation(
    (nodeId: string, subscriber: nodeEvents.NodeEventSubscriber) => {
      const entry: Subscription = { subscriber, stop: mock(), released: false };
      entry.stop.mockImplementation(() => {
        entry.released = true;
      });
      subscriptions.set(nodeId, [...(subscriptions.get(nodeId) ?? []), entry]);
      return entry.stop;
    },
  );
  windowScope = new WindowScope();
  windowScope.open({ role: "command", client: new FakeNodeClient({ nodeId: SELF }) });
  useRemoteWorkspaceStore.setState({ active: null, openNodes: [] });
  setNodes(SELF, LEAF);
});

afterEach(() => {
  service?.stop();
  windowScope.dispose();
  subscribe.mockRestore();
  portalStore.store.setState(initialPortal, true);
  useRemoteWorkspaceStore.setState({ active: null, openNodes: [] });
});

describe("sources", () => {
  test("a summary-tier node on the relay, an in-tree leaf on its scope, never its own node", async () => {
    setNodes(SELF, LEAF, OTHER);
    const client = new FakeNodeClient({ nodeId: LEAF });
    openLeaf(client, "warm");
    holdInTree(LEAF);
    const attention_ = start();
    await flush();
    expect(attention_.sourceOf(OTHER)).toBe("relay");
    expect(attention_.sourceOf(LEAF)).toBe("scope");
    expect(attention_.sourceOf(SELF)).toBeNull();
    expect(Array.from(subscriptions.keys())).toEqual([OTHER]);
    expect(client.listenerCount(ENVIRONMENT_ATTENTION_EVENT)).toBe(1);

    client.emit(ENVIRONMENT_ATTENTION_EVENT, attention("a1"));
    relay(OTHER)!.subscriber.onEvent(ENVIRONMENT_ATTENTION_EVENT, attention("a1"));
    expect(seen).toEqual(["bk_leaf:a1:scope", "bk_other:a1:relay"]);
  });

  test("a suspended or summary-tier scope is heard on the relay", () => {
    const client = new FakeNodeClient({ nodeId: LEAF });
    openLeaf(client, "suspended");
    holdInTree(LEAF);
    const attention_ = start();
    expect(attention_.sourceOf(LEAF)).toBe("relay");
    expect(client.listenerCount(ENVIRONMENT_ATTENTION_EVENT)).toBe(0);
  });

  test("ignores other events and malformed payloads, and dedupes per node", () => {
    setNodes(SELF, LEAF, OTHER);
    start();
    relay(LEAF)!.subscriber.onEvent(ENVIRONMENT_ATTENTION_EVENT, { attentionId: "x" });
    relay(LEAF)!.subscriber.onEvent("resource-changed", attention("a0"));
    relay(LEAF)!.subscriber.onEvent(ENVIRONMENT_ATTENTION_EVENT, attention("a1"));
    relay(LEAF)!.subscriber.onEvent(ENVIRONMENT_ATTENTION_EVENT, attention("a1"));
    relay(OTHER)!.subscriber.onEvent(ENVIRONMENT_ATTENTION_EVENT, attention("a1"));
    expect(seen).toEqual(["bk_leaf:a1:relay", "bk_other:a1:relay"]);
  });

  test("a resync replays nothing", () => {
    start();
    relay(LEAF)!.subscriber.onResync();
    relay(LEAF)!.subscriber.onEvent(ENVIRONMENT_ATTENTION_EVENT, attention("a1"));
    relay(LEAF)!.subscriber.onResync();
    relay(LEAF)!.subscriber.onEvent(ENVIRONMENT_ATTENTION_EVENT, attention("a1"));
    expect(seen).toEqual(["bk_leaf:a1:relay"]);
  });
});

describe("a tier change mid-stream", () => {
  test("summary to warm: the relay stays until the scope is live; nothing missed, nothing twice", async () => {
    const attention_ = start();
    const lease = relay(LEAF)!;
    lease.subscriber.onResync();
    lease.subscriber.onEvent(ENVIRONMENT_ATTENTION_EVENT, attention("a1"));

    const { client, open } = gatedClient(LEAF);
    openLeaf(client, "warm");
    holdInTree(LEAF);
    expect(attention_.sourceOf(LEAF)).toBe("scope");
    expect(attention_.feedsOf(LEAF)).toEqual(["relay", "scope"]);

    // While the scope's stream comes up, both deliver and each event counts once.
    lease.subscriber.onEvent(ENVIRONMENT_ATTENTION_EVENT, attention("a2"));
    client.emit(ENVIRONMENT_ATTENTION_EVENT, attention("a2"));
    client.emit(ENVIRONMENT_ATTENTION_EVENT, attention("a3"));
    lease.subscriber.onEvent(ENVIRONMENT_ATTENTION_EVENT, attention("a3"));
    expect(lease.stop).not.toHaveBeenCalled();

    open();
    await flush();
    expect(lease.stop).toHaveBeenCalledTimes(1);
    expect(attention_.feedsOf(LEAF)).toEqual(["scope"]);
    client.emit(ENVIRONMENT_ATTENTION_EVENT, attention("a4"));
    expect(seen).toEqual([
      "bk_leaf:a1:relay",
      "bk_leaf:a2:relay",
      "bk_leaf:a3:scope",
      "bk_leaf:a4:scope",
    ]);
  });

  test("live to suspended: the scope stays until the relay is live; nothing missed, nothing twice", async () => {
    const client = new FakeNodeClient({ nodeId: LEAF });
    const scope = openLeaf(client, "live");
    holdInTree(LEAF);
    const attention_ = start();
    await flush();
    expect(attention_.feedsOf(LEAF)).toEqual(["scope"]);
    client.emit(ENVIRONMENT_ATTENTION_EVENT, attention("b1"));

    scope.setTier("suspended");
    expect(attention_.sourceOf(LEAF)).toBe("relay");
    expect(attention_.feedsOf(LEAF)).toEqual(["relay", "scope"]);
    const lease = relay(LEAF)!;
    client.emit(ENVIRONMENT_ATTENTION_EVENT, attention("b2"));
    lease.subscriber.onEvent(ENVIRONMENT_ATTENTION_EVENT, attention("b2"));
    lease.subscriber.onEvent(ENVIRONMENT_ATTENTION_EVENT, attention("b1"));
    expect(client.listenerCount(ENVIRONMENT_ATTENTION_EVENT)).toBe(1);

    lease.subscriber.onResync();
    expect(client.listenerCount(ENVIRONMENT_ATTENTION_EVENT)).toBe(0);
    lease.subscriber.onEvent(ENVIRONMENT_ATTENTION_EVENT, attention("b3"));
    expect(seen).toEqual(["bk_leaf:b1:scope", "bk_leaf:b2:scope", "bk_leaf:b3:relay"]);

    // And back: resumed, it is heard on its scope again.
    scope.setTier("warm");
    await flush();
    expect(attention_.feedsOf(LEAF)).toEqual(["scope"]);
    expect(lease.stop).toHaveBeenCalledTimes(1);
  });

  test("a scope the region released moves to the relay while it is still open", async () => {
    const client = new FakeNodeClient({ nodeId: LEAF });
    const scope = openLeaf(client, "live");
    holdInTree(LEAF);
    const attention_ = start();
    await flush();
    useRemoteWorkspaceStore.setState({ openNodes: [] });
    expect(attention_.feedsOf(LEAF)).toEqual(["relay", "scope"]);
    relay(LEAF)!.subscriber.onResync();
    expect(attention_.feedsOf(LEAF)).toEqual(["relay"]);
    // The grace period ends: nothing changes for attention.
    scope.dispose();
    expect(attention_.feedsOf(LEAF)).toEqual(["relay"]);
    expect(relay(LEAF)!.stop).not.toHaveBeenCalled();
  });

  test("the old source goes after a bounded wait when the new one never goes live", async () => {
    const client = new FakeNodeClient({ nodeId: LEAF });
    const scope = openLeaf(client, "live");
    holdInTree(LEAF);
    const attention_ = start();
    await flush();
    scope.setTier("suspended");
    expect(attention_.feedsOf(LEAF)).toEqual(["relay", "scope"]);
    expect(Array.from(waits).map((wait) => wait.ms)).toEqual([ATTENTION_HANDOVER_TIMEOUT_MS]);
    elapse();
    expect(attention_.feedsOf(LEAF)).toEqual(["relay"]);
    expect(client.listenerCount(ENVIRONMENT_ATTENTION_EVENT)).toBe(0);
  });

  test("a disposed and reopened scope is heard on its new client", async () => {
    const first = new FakeNodeClient({ nodeId: LEAF });
    openLeaf(first, "live").dispose();
    holdInTree(LEAF);
    const attention_ = start();
    expect(attention_.sourceOf(LEAF)).toBe("relay");
    const second = new FakeNodeClient({ nodeId: LEAF });
    openLeaf(second, "live");
    await flush();
    expect(attention_.feedsOf(LEAF)).toEqual(["scope"]);
    expect(second.listenerCount(ENVIRONMENT_ATTENTION_EVENT)).toBe(1);
    second.emit(ENVIRONMENT_ATTENTION_EVENT, attention("c1"));
    expect(seen).toEqual(["bk_leaf:c1:scope"]);
  });
});

describe("handoff and stop", () => {
  test("attentionHandoff moves a node to the relay ahead of closing its scope", async () => {
    const client = new FakeNodeClient({ nodeId: LEAF });
    openLeaf(client, "live");
    holdInTree(LEAF);
    const attention_ = start();
    await flush();
    let done = false;
    void attentionHandoff(windowScope, LEAF).then(() => {
      done = true;
    });
    await flush();
    expect(done).toBe(false);
    expect(attention_.feedsOf(LEAF)).toEqual(["relay", "scope"]);
    relay(LEAF)!.subscriber.onResync();
    await flush();
    expect(done).toBe(true);
    expect(attention_.feedsOf(LEAF)).toEqual(["relay"]);
    // Nothing to hand off: resolves at once.
    await attentionHandoff(windowScope, OTHER);
    await attentionHandoff(new WindowScope(), LEAF);
  });

  test("stop ends every subscription and handover timer", () => {
    setNodes(SELF, LEAF, OTHER);
    const { client } = gatedClient(LEAF);
    openLeaf(client, "live");
    const attention_ = start();
    holdInTree(LEAF);
    expect(attention_.feedsOf(LEAF)).toEqual(["relay", "scope"]);
    expect(waits.size).toBe(1);
    attention_.stop();
    expect(waits.size).toBe(0);
    attention_.stop();
    for (const entries of subscriptions.values())
      for (const entry of entries) expect(entry.stop).toHaveBeenCalledTimes(1);
    expect(client.listenerCount(ENVIRONMENT_ATTENTION_EVENT)).toBe(0);
    client.emit(ENVIRONMENT_ATTENTION_EVENT, attention("d1"));
    expect(seen).toEqual([]);
    // Later store changes start nothing.
    useRemoteWorkspaceStore.setState({ openNodes: [] });
    expect(relay(LEAF)).toBeUndefined();
  });

  test("a second service for the same window stops the first", () => {
    const first = start();
    const lease = relay(LEAF)!;
    start();
    expect(lease.stop).toHaveBeenCalledTimes(1);
    expect(first.sourceOf(LEAF)).toBeNull();
  });
});

describe("shownEnvironmentOn", () => {
  test("names the shown in-tree node's environment, a project home only on its Home tab", () => {
    const scope = openLeaf(new FakeNodeClient({ nodeId: LEAF }), "live");
    holdInTree(LEAF);
    expect(shownEnvironmentOn(windowScope, LEAF)).toBeNull();
    windowScope.select({ nodeId: LEAF, projectId: "leaf-project", environmentId: "leaf-env" });
    useRemoteWorkspaceStore.setState({
      active: { nodeId: LEAF, projectId: "leaf-project", environmentId: "leaf-env" },
    });
    expect(shownEnvironmentOn(windowScope, LEAF)).toBe("leaf-env");
    expect(shownEnvironmentOn(windowScope, OTHER)).toBeNull();
    windowScope.select({
      nodeId: LEAF,
      projectId: "leaf-project",
      environmentId: "leaf-env",
      projectHome: true,
    });
    scope.store(uiStore).setState({ projectBoardTab: "kanban" });
    expect(shownEnvironmentOn(windowScope, LEAF)).toBeNull();
    scope.store(uiStore).setState({ projectBoardTab: "home" });
    expect(shownEnvironmentOn(windowScope, LEAF)).toBe("leaf-env");
  });
});
