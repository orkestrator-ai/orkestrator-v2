import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ENVIRONMENT_ATTENTION_EVENT } from "@orkestrator/protocol/environment-attention";
import { resetClientStateCapabilitiesForTests } from "@/lib/client-state-capabilities";
import * as nodeEvents from "@/lib/federation/node-events";
import * as realNotificationSounds from "@/lib/notification-sounds";
import { portalStore } from "@/lib/portal/portal-store";
import type { BackendId } from "@orkestrator/protocol/federation";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { useConfigStore } from "@/stores/configStore";
import { useInTreeNodesStore } from "@/stores/inTreeNodesStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { FakeNodeClient } from "@/test/render-in-node-scope";

const playConfiguredNotificationSound = mock(async (_kind: string) => true);
const primeNotificationSounds = mock(async () => true);

mock.module("@/lib/notification-sounds", () => ({
  ...realNotificationSounds,
  isNotificationSoundEnabled: () => true,
  playConfiguredNotificationSound,
  primeNotificationSounds,
}));

const { useNotificationSoundService } = await import("./useNotificationSoundService");
const { useRemoteNodeAttention } = await import("./useRemoteNodeAttention");
const { __testing: desktopNotifications } = await import("@/lib/question-desktop-notification");

interface ShownNotification {
  title: string;
  options: NotificationOptions;
  listeners: Map<string, () => void>;
}
const shown: ShownNotification[] = [];
class FakeNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = async () => FakeNotification.permission;
  private readonly entry: ShownNotification;
  constructor(title: string, options: NotificationOptions = {}) {
    this.entry = { title, options, listeners: new Map() };
    shown.push(this.entry);
  }
  addEventListener(event: string, listener: () => void) {
    this.entry.listeners.set(event, listener);
  }
  close() {}
}
const notificationDescriptor = Object.getOwnPropertyDescriptor(window, "Notification");

interface Subscription {
  subscriber: nodeEvents.NodeEventSubscriber;
  stop: ReturnType<typeof mock>;
  released: boolean;
}
const subscriptions = new Map<string, Subscription[]>();
let subscribe: ReturnType<typeof spyOn>;

function live(nodeId: string): Subscription | undefined {
  return subscriptions.get(nodeId)?.find((entry) => !entry.released);
}

function deliver(nodeId: string, payload: unknown, event = ENVIRONMENT_ATTENTION_EVENT): void {
  const entry = live(nodeId);
  if (!entry) throw new Error(`no live subscription for ${nodeId}`);
  entry.subscriber.onEvent(event, payload);
}

function attention(attentionId: string, reason = "agent_finished", environmentId = "leaf-env") {
  return {
    attentionId,
    environmentId,
    projectId: "leaf-project",
    reason,
    occurredAt: new Date(0).toISOString(),
  };
}

function node(nodeId: string, displayName: string) {
  return {
    nodeId,
    available: true,
    loadedAt: 1,
    view: { nodeId, displayName },
    projects: [{ ref: { backendId: nodeId, projectId: "leaf-project" }, name: "Shop" }],
    environments: [
      {
        ref: { backendId: nodeId, environmentId: "leaf-env" },
        projectId: "leaf-project",
        name: "checkout",
        isProjectHome: false,
      },
    ],
  };
}

function setNodes(...nodes: ReturnType<typeof node>[]) {
  act(() => portalStore.store.setState({ selfId: "bk_self" as never, nodes: nodes as never }));
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

const initialPortal = portalStore.store.getState();
const initialHref = window.location.href;
const happyDOM = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;

beforeEach(() => {
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
  useRemoteWorkspaceStore.setState({ active: null, realms: [] });
  playConfiguredNotificationSound.mockReset();
  playConfiguredNotificationSound.mockResolvedValue(true);
  primeNotificationSounds.mockReset();
  primeNotificationSounds.mockResolvedValue(true);
  useConfigStore.getState().updateGlobalConfig({
    notificationSounds: {
      agentStopped: true,
      prMerged: true,
      coordinatorReport: true,
      agentQuestion: true,
      questionDesktopNotification: true,
    },
  });
  shown.length = 0;
  desktopNotifications.reset();
  FakeNotification.permission = "granted";
  Object.defineProperty(window, "Notification", { configurable: true, value: FakeNotification });
  setNodes(node("bk_leaf", "Leaf"));
});

const leafScopes: NodeScope[] = [];

/** `bk_leaf` shown in the window's own tree (plan item 4001), on a live scope. */
function inTreeLeaf(): FakeNodeClient {
  const client = new FakeNodeClient({ nodeId: "bk_leaf" as BackendId });
  leafScopes.push(getWindowScope().open({ role: "leaf", client, tier: "live" }));
  act(() => {
    useInTreeNodesStore.setState({ useRealmsForRemoteMachines: false });
    useRemoteWorkspaceStore.setState({ realms: ["bk_leaf"] });
  });
  return client;
}

afterEach(() => {
  cleanup();
  for (const scope of leafScopes.splice(0)) scope.dispose();
  useInTreeNodesStore.setState({ useRealmsForRemoteMachines: false });
  getWindowScope().select(null);
  subscribe.mockRestore();
  portalStore.store.setState(initialPortal, true);
  useRemoteWorkspaceStore.setState({ active: null, realms: [] });
  if (notificationDescriptor) Object.defineProperty(window, "Notification", notificationDescriptor);
  else delete (window as unknown as { Notification?: unknown }).Notification;
  resetClientStateCapabilitiesForTests();
  happyDOM.setURL(initialHref);
});

describe("subscriptions", () => {
  test("subscribes each other node without a realm, never this node itself", () => {
    setNodes(node("bk_self", "Self"), node("bk_leaf", "Leaf"), node("bk_other", "Other"));
    renderHook(() => useRemoteNodeAttention(() => undefined));
    expect(Array.from(subscriptions.keys()).sort()).toEqual(["bk_leaf", "bk_other"]);
    expect(live("bk_leaf")?.subscriber.events).toEqual([ENVIRONMENT_ATTENTION_EVENT]);
  });

  test("under the rollback setting, leaves a node with an open realm to that realm", () => {
    useInTreeNodesStore.setState({ useRealmsForRemoteMachines: true });
    useRemoteWorkspaceStore.setState({ realms: ["bk_leaf"] });
    renderHook(() => useRemoteNodeAttention(() => undefined));
    expect(subscriptions.has("bk_leaf")).toBe(false);
  });

  test("under the rollback setting, drops a node when its realm opens and takes it back when it closes", () => {
    useInTreeNodesStore.setState({ useRealmsForRemoteMachines: true });
    setNodes(node("bk_leaf", "Leaf"), node("bk_other", "Other"));
    renderHook(() => useRemoteNodeAttention(() => undefined));
    const first = live("bk_leaf")!;
    const other = live("bk_other")!;
    act(() => useRemoteWorkspaceStore.setState({ realms: ["bk_leaf"] }));
    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(live("bk_leaf")).toBeUndefined();
    act(() => useRemoteWorkspaceStore.setState({ realms: [] }));
    expect(live("bk_leaf")).toBeDefined();
    expect(subscriptions.get("bk_leaf")).toHaveLength(2);
    // The other node's lease is untouched by the leaf's realm.
    expect(other.stop).not.toHaveBeenCalled();
    expect(subscriptions.get("bk_other")).toHaveLength(1);
  });

  test("drops a node that leaves the summaries", () => {
    renderHook(() => useRemoteNodeAttention(() => undefined));
    const entry = live("bk_leaf")!;
    setNodes();
    expect(entry.stop).toHaveBeenCalledTimes(1);
  });

  test("releases every subscription on unmount", () => {
    setNodes(node("bk_leaf", "Leaf"), node("bk_other", "Other"));
    const view = renderHook(() => useRemoteNodeAttention(() => undefined));
    const entries = [live("bk_leaf")!, live("bk_other")!];
    view.unmount();
    for (const entry of entries) expect(entry.stop).toHaveBeenCalledTimes(1);
  });

  test("subscribes nothing inside a realm renderer", () => {
    const url = new URL(initialHref);
    url.search = "?realm=workspace&workspace=w1";
    happyDOM.setURL(url.toString());
    renderHook(() => useRemoteNodeAttention(() => undefined));
    expect(subscribe).not.toHaveBeenCalled();
  });

  test("hands each (node, attention) on once, and ignores other events and malformed payloads", () => {
    setNodes(node("bk_leaf", "Leaf"), node("bk_other", "Other"));
    const seen: string[] = [];
    renderHook(() =>
      useRemoteNodeAttention((nodeId, event) => seen.push(`${nodeId}:${event.attentionId}`)),
    );
    deliver("bk_leaf", attention("a1"));
    deliver("bk_leaf", attention("a1"));
    deliver("bk_other", attention("a1"));
    deliver("bk_leaf", { attentionId: "a2" });
    deliver("bk_leaf", attention("a3"), "resource-changed");
    expect(seen).toEqual(["bk_leaf:a1", "bk_other:a1"]);
  });

  test("a resync replays nothing, and an event redelivered after it stays deduplicated", () => {
    const seen: string[] = [];
    renderHook(() => useRemoteNodeAttention((_nodeId, event) => seen.push(event.attentionId)));
    live("bk_leaf")!.subscriber.onResync();
    expect(seen).toEqual([]);
    deliver("bk_leaf", attention("a1"));
    live("bk_leaf")!.subscriber.onResync();
    deliver("bk_leaf", attention("a1"));
    expect(seen).toEqual(["a1"]);
  });

  test("remembers delivered attention across a realm opening and closing", () => {
    const seen: string[] = [];
    renderHook(() => useRemoteNodeAttention((_nodeId, event) => seen.push(event.attentionId)));
    deliver("bk_leaf", attention("a1"));
    act(() => useRemoteWorkspaceStore.setState({ realms: ["bk_leaf"] }));
    act(() => useRemoteWorkspaceStore.setState({ realms: [] }));
    deliver("bk_leaf", attention("a1"));
    expect(seen).toEqual(["a1"]);
  });
});

describe("through the notification sound service", () => {
  async function mounted() {
    const view = renderHook(() => useNotificationSoundService());
    await flush();
    return view;
  }

  test("a leaf without a realm sounds the agent-stopped cue once", async () => {
    await mounted();
    deliver("bk_leaf", attention("a1"));
    deliver("bk_leaf", attention("a1"));
    live("bk_leaf")!.subscriber.onResync();
    expect(playConfiguredNotificationSound).toHaveBeenCalledTimes(1);
    expect(playConfiguredNotificationSound).toHaveBeenCalledWith("agent-stopped");
  });

  test("under the rollback setting, a leaf with an open realm makes no sound from the shell", async () => {
    useInTreeNodesStore.setState({ useRealmsForRemoteMachines: true });
    useRemoteWorkspaceStore.setState({ realms: ["bk_leaf"] });
    await mounted();
    expect(live("bk_leaf")).toBeUndefined();
    expect(playConfiguredNotificationSound).not.toHaveBeenCalled();
  });

  test("a question sounds and shows a notification naming the node, which opens its realm", async () => {
    await mounted();
    deliver("bk_leaf", attention("q1", "agent_question"));
    await flush();
    expect(playConfiguredNotificationSound).toHaveBeenCalledWith("agent-question");
    expect(shown).toHaveLength(1);
    expect(shown[0]!.title).toBe("Agent asked a question");
    expect(shown[0]!.options.body).toBe("Leaf · Shop · checkout: waiting for your answer.");
    expect(shown[0]!.options.tag).toBe("orkestrator-question:bk_leaf:leaf-env");
    expect(shown[0]!.options.silent).toBe(true);
    act(() => shown[0]!.listeners.get("click")!());
    expect(useRemoteWorkspaceStore.getState().active).toMatchObject({
      nodeId: "bk_leaf",
      projectId: "leaf-project",
      environmentId: "leaf-env",
    });
  });

  test("the same attention id on two nodes is two alerts", async () => {
    setNodes(node("bk_leaf", "Leaf"), node("bk_other", "Other"));
    await mounted();
    deliver("bk_leaf", attention("q1", "agent_question"));
    deliver("bk_other", attention("q1", "agent_question"));
    deliver("bk_other", attention("q1", "agent_question"));
    await flush();
    expect(shown.map((entry) => entry.options.tag)).toEqual([
      "orkestrator-question:bk_leaf:leaf-env",
      "orkestrator-question:bk_other:leaf-env",
    ]);
  });

  test("respects the agent-stopped, agent-question and desktop-notification settings", async () => {
    useConfigStore.getState().updateGlobalConfig({
      notificationSounds: {
        agentStopped: false,
        prMerged: true,
        coordinatorReport: true,
        agentQuestion: false,
        questionDesktopNotification: false,
      },
    });
    await mounted();
    deliver("bk_leaf", attention("a1"));
    deliver("bk_leaf", attention("q1", "agent_question"));
    await flush();
    expect(playConfiguredNotificationSound).not.toHaveBeenCalled();
    expect(shown).toHaveLength(0);
  });

  test("a question notification still shows with its own sound off, and is not silent", async () => {
    useConfigStore.getState().updateGlobalConfig({
      notificationSounds: {
        agentStopped: true,
        prMerged: true,
        coordinatorReport: true,
        agentQuestion: false,
        questionDesktopNotification: true,
      },
    });
    await mounted();
    deliver("bk_leaf", attention("q1", "agent_waiting"));
    await flush();
    expect(playConfiguredNotificationSound).not.toHaveBeenCalled();
    expect(shown).toHaveLength(1);
    expect(shown[0]!.options.silent).toBe(false);
  });

  test("an in-tree leaf alerts once from its scope, not the relay, and a click opens it", async () => {
    const client = inTreeLeaf();
    await mounted();
    await flush();
    expect(live("bk_leaf")).toBeUndefined();
    client.emit(ENVIRONMENT_ATTENTION_EVENT, attention("q1", "agent_question"));
    client.emit(ENVIRONMENT_ATTENTION_EVENT, attention("q1", "agent_question"));
    await flush();
    expect(playConfiguredNotificationSound).toHaveBeenCalledTimes(1);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.options.tag).toBe("orkestrator-question:bk_leaf:leaf-env");
    act(() => shown[0]!.listeners.get("click")!());
    expect(useRemoteWorkspaceStore.getState().active).toMatchObject({
      nodeId: "bk_leaf",
      projectId: "leaf-project",
      environmentId: "leaf-env",
    });
  });

  test("the shown in-tree environment stays quiet; another environment of that node sounds", async () => {
    const client = inTreeLeaf();
    act(() => {
      getWindowScope().select({
        nodeId: "bk_leaf" as BackendId,
        projectId: "leaf-project",
        environmentId: "leaf-env",
      });
      useRemoteWorkspaceStore.setState({
        active: { nodeId: "bk_leaf", projectId: "leaf-project", environmentId: "leaf-env" },
      });
    });
    await mounted();
    await flush();
    client.emit(ENVIRONMENT_ATTENTION_EVENT, attention("a1"));
    expect(playConfiguredNotificationSound).not.toHaveBeenCalled();
    client.emit(ENVIRONMENT_ATTENTION_EVENT, attention("a2", "agent_finished", "other-env"));
    expect(playConfiguredNotificationSound).toHaveBeenCalledWith("agent-stopped");
  });
});
