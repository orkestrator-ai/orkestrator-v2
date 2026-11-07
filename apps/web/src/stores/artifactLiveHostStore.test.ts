import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import { TRANSCRIPT_ARTIFACT_COMMANDS } from "@orkestrator/protocol/transcript-artifact-commands";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import {
  artifactLiveHostOwner,
  isLiveOccurrence,
  LIVE_HOST_BUDGET_NAME,
  liveAnchorKey,
  useArtifactLiveHostStore,
  type LiveArtifactRequest,
} from "./artifactLiveHostStore";

const NODE_A = "bk_live-node-a" as BackendId;
const NODE_B = "bk_live-node-b" as BackendId;

let sessions = 0;
function liveSession(args: Readonly<Record<string, unknown>>) {
  sessions += 1;
  const id = String(args.publicationId).slice(4, 5);
  return {
    contentUrl: `http://127.0.0.1:9999/artifact/${id}?cap=${sessions}`,
    shellUrl: `http://127.0.0.1:9999/shell/${id}?cap=${sessions}`,
    expiresAt: "2026-10-20T11:00:00.000Z",
    preparedSha256: "e".repeat(64),
    artifactId: `art_${id}abcdefgh`,
    revision: 1,
    generation: `live-gen-${sessions}`,
    readinessNonce: "nonce-12345678",
  };
}

function client(nodeId: BackendId): FakeNodeClient {
  return new FakeNodeClient({
    nodeId,
    invoke: {
      [TRANSCRIPT_ARTIFACT_COMMANDS.openLiveSession]: liveSession,
      [TRANSCRIPT_ARTIFACT_COMMANDS.closeLiveSession]: undefined,
    },
  });
}

/** The same occurrence on every node: occurrence keys and ids are node-local. */
function target(id: string, overrides: Partial<LiveArtifactRequest> = {}): LiveArtifactRequest {
  return {
    occurrenceKey: `occurrence-${id}`,
    publicationId: `pub_${id}abcdefgh`,
    artifactId: `art_${id}abcdefgh`,
    revision: 1,
    title: `Calculator ${id}`,
    scope: {
      backendId: "backend-1",
      environmentId: "env-1",
      logicalSessionKey: "s1",
      generation: "g1",
    },
    ...overrides,
  };
}

let windowScope: WindowScope;
let clientA: FakeNodeClient;
let clientB: FakeNodeClient;

function open(budgets?: { artifacts: number }) {
  windowScope = new WindowScope(budgets ? { budgets } : {});
  clientA = client(NODE_A);
  clientB = client(NODE_B);
  const a = windowScope.open({ role: "command", client: clientA });
  const b = windowScope.open({ role: "leaf", client: clientB });
  return { a, b };
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

beforeEach(() => {
  sessions = 0;
  useArtifactLiveHostStore.getState().resetForTests();
});

afterEach(() => {
  useArtifactLiveHostStore.getState().resetForTests();
  windowScope?.dispose();
});

describe("node-qualified live host", () => {
  test("the session runs on the asking node, and its occurrence is distinct from another node's", async () => {
    const { b } = open();
    expect(useArtifactLiveHostStore.getState().request(b, target("a"))).toBe("started");
    await settle();

    const active = useArtifactLiveHostStore.getState().active;
    expect(active?.target.nodeId).toBe(NODE_B);
    expect(active?.phase).toBe("loading");
    expect(clientB.calls(TRANSCRIPT_ARTIFACT_COMMANDS.openLiveSession)).toHaveLength(1);
    expect(clientA.calls(TRANSCRIPT_ARTIFACT_COMMANDS.openLiveSession)).toHaveLength(0);
    // The same occurrence key on node A is not the active one.
    expect(isLiveOccurrence(active?.target, NODE_B, "occurrence-a")).toBe(true);
    expect(isLiveOccurrence(active?.target, NODE_A, "occurrence-a")).toBe(false);
    expect(artifactLiveHostOwner(NODE_B)).toBe(b);

    useArtifactLiveHostStore.getState().stop();
    expect(clientB.calls(TRANSCRIPT_ARTIFACT_COMMANDS.closeLiveSession)).toEqual([
      {
        command: TRANSCRIPT_ARTIFACT_COMMANDS.closeLiveSession,
        args: { generation: "live-gen-1" },
      },
    ]);
  });

  test("the same occurrence on another node asks for a switch instead of reusing the view", async () => {
    const { a, b } = open();
    useArtifactLiveHostStore.getState().request(a, target("a"));
    expect(useArtifactLiveHostStore.getState().request(a, target("a"))).toBe("already-active");
    expect(useArtifactLiveHostStore.getState().request(b, target("a"))).toBe("switch-pending");
    expect(useArtifactLiveHostStore.getState().pendingSwitch?.nodeId).toBe(NODE_B);
  });

  test("anchors are keyed by node", () => {
    const { a, b } = open();
    const onA = document.createElement("div");
    const onB = document.createElement("div");
    const offA = useArtifactLiveHostStore.getState().registerAnchor(a, "occurrence-a", onA);
    useArtifactLiveHostStore.getState().registerAnchor(b, "occurrence-a", onB);

    const anchors = useArtifactLiveHostStore.getState().anchors;
    expect(anchors.get(liveAnchorKey(NODE_A, "occurrence-a"))).toBe(onA);
    expect(anchors.get(liveAnchorKey(NODE_B, "occurrence-a"))).toBe(onB);
    offA();
    expect(useArtifactLiveHostStore.getState().anchors.size).toBe(1);
  });

  test("disposing a node's scope releases only that node's host, anchors and preview", async () => {
    const { a, b } = open();
    useArtifactLiveHostStore.getState().request(b, target("a", { previewDataUrl: "x".repeat(64) }));
    await settle();
    useArtifactLiveHostStore
      .getState()
      .registerAnchor(a, "occurrence-a", document.createElement("div"));
    useArtifactLiveHostStore
      .getState()
      .registerAnchor(b, "occurrence-a", document.createElement("div"));
    expect(windowScope.budgets.artifacts.usedBytesFor(NODE_B)).toBe(64);

    // Disposing node A touches nothing of node B's.
    a.dispose();
    expect(useArtifactLiveHostStore.getState().active?.target.nodeId).toBe(NODE_B);
    expect(useArtifactLiveHostStore.getState().anchors.size).toBe(1);

    b.dispose();
    const state = useArtifactLiveHostStore.getState();
    expect(state.active).toBeNull();
    expect(state.anchors.size).toBe(0);
    expect(artifactLiveHostOwner(NODE_B)).toBeNull();
    // The session was closed on B's client while it was still open.
    expect(clientB.calls(TRANSCRIPT_ARTIFACT_COMMANDS.closeLiveSession)).toHaveLength(1);
    expect(windowScope.budgets.artifacts.usedBytes).toBe(0);
  });

  test("a disposed scope cannot start a view", async () => {
    const { b } = open();
    b.dispose();
    useArtifactLiveHostStore.getState().request(b, target("a"));
    await settle();
    expect(useArtifactLiveHostStore.getState().active?.phase).toBe("error");
    expect(clientB.calls(TRANSCRIPT_ARTIFACT_COMMANDS.openLiveSession)).toHaveLength(0);
  });
});

describe("saved preview bytes in the window budget", () => {
  test("the preview reserves under its node and is given back when the view stops", () => {
    const { b } = open();
    useArtifactLiveHostStore.getState().request(b, target("a", { previewDataUrl: "p".repeat(40) }));
    const budget = windowScope.budgets.artifacts;
    expect(budget.usedBytesFor(NODE_B)).toBe(40);
    expect(budget.usedBytesFor(NODE_A)).toBe(0);

    useArtifactLiveHostStore.getState().stop();
    expect(budget.usedBytes).toBe(0);
  });

  test("a pending target's preview is released on cancel and kept on switch", () => {
    const { a, b } = open();
    const store = useArtifactLiveHostStore.getState();
    store.request(a, target("a", { previewDataUrl: "a".repeat(10) }));
    store.request(b, target("b", { previewDataUrl: "b".repeat(20) }));
    const budget = windowScope.budgets.artifacts;
    expect(budget.usedBytes).toBe(30);

    useArtifactLiveHostStore.getState().cancelSwitch();
    expect(budget.usedBytesFor(NODE_B)).toBe(0);

    useArtifactLiveHostStore.getState().request(b, target("b", { previewDataUrl: "b".repeat(20) }));
    useArtifactLiveHostStore.getState().confirmSwitch();
    expect(budget.usedBytesFor(NODE_A)).toBe(0);
    expect(budget.usedBytesFor(NODE_B)).toBe(20);
    expect(useArtifactLiveHostStore.getState().active?.target.previewDataUrl).toBe("b".repeat(20));
  });

  test("a preview larger than the budget is dropped; the view still starts", () => {
    const { b } = open({ artifacts: 16 });
    useArtifactLiveHostStore.getState().request(b, target("a", { previewDataUrl: "p".repeat(64) }));
    const active = useArtifactLiveHostStore.getState().active;
    expect(active?.phase).toBe("opening");
    expect(active?.target.previewDataUrl).toBeUndefined();
    expect(windowScope.budgets.artifacts.usedBytes).toBe(0);
  });

  test("another node's reservation evicts the preview, but never the shown node's", () => {
    const { b } = open({ artifacts: 100 });
    const budget = windowScope.budgets.artifacts;
    useArtifactLiveHostStore.getState().request(b, target("a", { previewDataUrl: "p".repeat(60) }));

    // Node B is shown: A's reservation is refused rather than evict B's preview.
    budget.setShownNode(NODE_B);
    expect(budget.reserve(NODE_A, "other-cache\u0000x", 60).granted).toBe(false);
    expect(useArtifactLiveHostStore.getState().active?.target.previewDataUrl).toBe("p".repeat(60));

    // Node A is shown: B's preview is evicted and dropped from the target.
    budget.setShownNode(NODE_A);
    const result = budget.reserve(NODE_A, "other-cache\u0000x", 60);
    expect(result.granted).toBe(true);
    expect(result.evicted).toHaveLength(1);
    expect(result.evicted[0]?.nodeId).toBe(NODE_B);
    expect(result.evicted[0]?.key.startsWith(`${LIVE_HOST_BUDGET_NAME}\u0000`)).toBe(true);
    const active = useArtifactLiveHostStore.getState().active;
    expect(active?.target.nodeId).toBe(NODE_B);
    expect(active?.target.previewDataUrl).toBeUndefined();

    // Stopping afterwards gives nothing back twice.
    useArtifactLiveHostStore.getState().stop();
    expect(budget.usedBytes).toBe(60);
  });
});
