import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { TRANSCRIPT_ARTIFACT_COMMANDS } from "@orkestrator/protocol/transcript-artifact-commands";
import { invoke } from "@/lib/native/backend";
import {
  artifactRequestCacheStats,
  clearArtifactRequestCache,
  useArtifactPublication,
} from "@/lib/chat/artifact-requests";
import {
  artifactPublicationCacheSize,
  clearArtifactPublicationCache,
  useArtifactPublications,
} from "@/hooks/useArtifactPublications";
import {
  resetTranscriptArtifactCapabilities,
  useTranscriptArtifactCapabilities,
} from "@/hooks/useTranscriptArtifactCapabilities";
import "@/lib/chat/rich-markdown/markdown-search";
import "@/lib/chat/rich-markdown/media-resolver";
import { richBlockViewKey, richCacheKey, type RichTranscriptScope } from "@/lib/chat/rich-identity";
import { richRenderScheduler } from "@/lib/chat/rich-render-cache";
import { useRichContentViewStore } from "@/stores/richContentViewStore";
import { environmentStore } from "@/stores/environmentStore";
import { createBrowserGatewayApi, installBrowserGatewayApi } from "@/lib/native/web-gateway";
import type { BackendId } from "@orkestrator/protocol/federation";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import {
  clearProtectedRichContent,
  clearRichConversationContent,
  noteRichBackendIdentity,
  noteRichContentConnection,
  registerProtectedRichCache,
  registeredProtectedRichCaches,
  resetRichContentResetTracking,
  richBackendIdentityOf,
  richContentResetCounters,
} from "./rich-content-reset";
import { appCommandStore } from "@/test/app-command-store";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;

function scope(
  environmentId: string,
  logicalSessionKey = "session-1",
  backendId = "backend-A",
): RichTranscriptScope {
  return { backendId, environmentId, logicalSessionKey, generation: "g1" };
}

let capabilitiesBackendId = "backend-A";
let pendingPublication: ((value: unknown) => void) | null = null;
let holdPublications = false;

function backendResponse(command: string, args?: Record<string, unknown>): unknown {
  switch (command) {
    case TRANSCRIPT_ARTIFACT_COMMANDS.capabilities:
      return { backendId: capabilitiesBackendId, rolloutFlags: {} };
    case TRANSCRIPT_ARTIFACT_COMMANDS.getPublication:
      if (holdPublications) {
        return new Promise((resolve) => {
          pendingPublication = resolve;
        });
      }
      return { publicationId: args?.publicationId, environmentId: args?.environmentId };
    case TRANSCRIPT_ARTIFACT_COMMANDS.listPublications:
      return { publications: [], nextSequence: null };
    default:
      return undefined;
  }
}

/** Settle one scheduler entry for `key` (a cached render). */
async function settleRender(key: string): Promise<void> {
  await richRenderScheduler.request({
    key,
    lane: "highlight",
    sourceBytes: 4,
    run: async () => ({ value: "tokens", bytes: 8 }),
  }).promise;
}

function renderKey(target: RichTranscriptScope): string {
  return richCacheKey({
    kind: "highlight",
    scope: target,
    contentHash: "same-content",
    rendererVersion: "v",
    theme: "dark",
  });
}

beforeEach(() => {
  capabilitiesBackendId = "backend-A";
  holdPublications = false;
  pendingPublication = null;
  invokeMock.mockReset();
  invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) =>
    Promise.resolve(backendResponse(command, args)),
  );
  richRenderScheduler.clear();
  useRichContentViewStore.getState().reset();
  clearArtifactRequestCache();
  clearArtifactPublicationCache();
  resetTranscriptArtifactCapabilities();
  resetRichContentResetTracking();
});

afterEach(cleanup);

describe("protected rich content clearing", () => {
  test("every cache of protected content is registered with the central reset", () => {
    expect(registeredProtectedRichCaches().sort()).toEqual(
      [
        "artifact-publications",
        "artifact-requests",
        "markdown-search",
        "media",
        "transcript-artifact-capabilities",
      ].sort(),
    );
  });

  test("logout clears render cache, view state, artifact reads, ledgers and the identity, then re-reads", async () => {
    const conversation = scope("env-1");
    const capabilities = renderHook(() => useTranscriptArtifactCapabilities());
    await waitFor(() => expect(capabilities.result.current?.backendId).toBe("backend-A"));
    const publication = renderHook(() => useArtifactPublication(conversation, "pub-1"));
    await waitFor(() => expect(publication.result.current.status).toBe("ready"));
    renderHook(() => useArtifactPublications(conversation, []));
    await waitFor(() => expect(artifactPublicationCacheSize()).toBe(1));
    await settleRender(renderKey(conversation));
    useRichContentViewStore
      .getState()
      .update(richBlockViewKey(conversation, "m1", "p1", "details:0"), { open: true });

    expect(richRenderScheduler.stats().settled).toBe(1);
    expect(artifactRequestCacheStats().entries).toBe(1);
    const capabilityReads = () =>
      invokeMock.mock.calls.filter(
        ([command]) => command === TRANSCRIPT_ARTIFACT_COMMANDS.capabilities,
      ).length;
    expect(capabilityReads()).toBe(1);

    act(() => clearProtectedRichContent("logout"));

    expect(richRenderScheduler.stats().settled).toBe(0);
    expect(useRichContentViewStore.getState().entries.size).toBe(0);
    expect(artifactRequestCacheStats().entries).toBe(0);
    expect(artifactPublicationCacheSize()).toBe(0);
    expect(richContentResetCounters.all).toBe(1);
    // The mounted readers re-read under the new credentials.
    await waitFor(() => expect(capabilityReads()).toBe(2));
    await waitFor(() => expect(publication.result.current.status).toBe("ready"));
    await waitFor(() => expect(artifactPublicationCacheSize()).toBe(1));
  });

  test("a read in flight across a clear never repopulates the cache", async () => {
    holdPublications = true;
    const publication = renderHook(() => useArtifactPublication(scope("env-1"), "pub-1"));
    await waitFor(() => expect(pendingPublication).not.toBeNull());
    const respond = pendingPublication!;
    pendingPublication = null;
    act(() => clearProtectedRichContent("credentials"));
    respond({ publicationId: "pub-1" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(artifactRequestCacheStats().entries).toBe(0);
    // The reader asked again after the clear rather than showing the stale answer.
    await waitFor(() => expect(pendingPublication).not.toBeNull());
    expect(publication.result.current.status).toBe("loading");
  });

  test("deleting an environment drops only that environment's protected content", async () => {
    const deleted = scope("env-deleted");
    const kept = scope("env-kept");
    for (const target of [deleted, kept]) {
      renderHook(() => useArtifactPublication(target, "pub-1"));
      renderHook(() => useArtifactPublications(target, []));
      await settleRender(renderKey(target));
      useRichContentViewStore
        .getState()
        .update(richBlockViewKey(target, "m1", "p1", "details:0"), { open: true });
    }
    await waitFor(() => expect(artifactRequestCacheStats().entries).toBe(2));
    await waitFor(() => expect(artifactPublicationCacheSize()).toBe(2));

    act(() => appCommandStore(environmentStore).getState().removeEnvironment("env-deleted"));

    expect(richRenderScheduler.peek(renderKey(deleted))).toBeNull();
    expect(richRenderScheduler.peek(renderKey(kept))?.ok).toBe(true);
    const viewKeys = Array.from(useRichContentViewStore.getState().entries.keys());
    expect(viewKeys).toEqual([richBlockViewKey(kept, "m1", "p1", "details:0")]);
    expect(artifactRequestCacheStats().entries).toBe(1);
    expect(artifactPublicationCacheSize()).toBeGreaterThanOrEqual(1);
    expect(richContentResetCounters.environment).toBe(1);
  });

  test("a revoked conversation loses its entries; a sibling conversation keeps them", async () => {
    const revoked = scope("env-1", "session-revoked");
    const sibling = scope("env-1", "session-sibling");
    for (const target of [revoked, sibling]) {
      await settleRender(renderKey(target));
      useRichContentViewStore
        .getState()
        .update(richBlockViewKey(target, "m1", "p1", "code:0"), { wrap: true });
    }
    clearRichConversationContent(revoked);
    expect(richRenderScheduler.peek(renderKey(revoked))).toBeNull();
    expect(richRenderScheduler.peek(renderKey(sibling))?.ok).toBe(true);
    expect(Array.from(useRichContentViewStore.getState().entries.keys())).toEqual([
      richBlockViewKey(sibling, "m1", "p1", "code:0"),
    ]);
  });

  test("a desktop connection switch clears protected content; the first report does not", async () => {
    noteRichContentConnection("local");
    noteRichContentConnection("local");
    expect(richContentResetCounters.all).toBe(0);
    await settleRender(renderKey(scope("env-1")));
    noteRichContentConnection("remote-1");
    expect(richContentResetCounters.all).toBe(1);
    expect(richRenderScheduler.stats().settled).toBe(0);
  });

  test("a different authenticated backend identity clears content derived from the previous one", async () => {
    const first = renderHook(() => useTranscriptArtifactCapabilities());
    await waitFor(() => expect(first.result.current?.backendId).toBe("backend-A"));
    first.unmount();
    await settleRender(renderKey(scope("env-1")));

    // The connection now answers as another backend.
    resetTranscriptArtifactCapabilities();
    capabilitiesBackendId = "backend-B";
    const second = renderHook(() => useTranscriptArtifactCapabilities());
    await waitFor(() => expect(second.result.current?.backendId).toBe("backend-B"));
    expect(richContentResetCounters.all).toBe(1);
    expect(richRenderScheduler.stats().settled).toBe(0);
  });

  test("gateway re-authentication and gateway replacement clear protected content", async () => {
    const connectionList = { activeConnectionId: "remote-1", connections: [] };
    const connections = {
      list: mock(async () => connectionList),
      probe: mock(async () => true),
      connect: mock(async () => connectionList),
      updateToken: mock(async () => connectionList),
      use: mock(async () => connectionList),
      forget: mock(async () => connectionList),
    };
    const api = createBrowserGatewayApi({ token: "old-token-123456", connections });
    await settleRender(renderKey(scope("env-1")));
    await api.connections?.updateToken("remote-1", "new-token-654321");
    expect(richContentResetCounters.all).toBe(1);
    expect(richRenderScheduler.stats().settled).toBe(0);

    const fakeWindow = {
      location: { protocol: "http:" },
      orkestrator: api as unknown as Window["orkestrator"],
      orkestratorGateway: undefined,
    } as unknown as Pick<Window, "location" | "orkestrator" | "orkestratorGateway">;
    installBrowserGatewayApi(fakeWindow, { replaceExisting: true });
    expect(richContentResetCounters.all).toBe(2);
  });
});

describe("protected rich content per node", () => {
  /** Render, view state, an artifact read and a ledger for each scope. */
  async function populate(targets: RichTranscriptScope[]): Promise<void> {
    for (const target of targets) {
      renderHook(() => useArtifactPublication(target, "pub-1"));
      renderHook(() => useArtifactPublications(target, []));
      await settleRender(renderKey(target));
      useRichContentViewStore
        .getState()
        .update(richBlockViewKey(target, "m1", "p1", "details:0"), { open: true });
    }
    await waitFor(() => expect(artifactRequestCacheStats().entries).toBe(targets.length));
    await waitFor(() => expect(artifactPublicationCacheSize()).toBe(targets.length));
  }

  test("a clear by node leaves the other node's entries", async () => {
    const nodeA = scope("env-1", "session-1", "backend-A");
    const nodeB = scope("env-1", "session-1", "backend-B");
    await populate([nodeA, nodeB]);

    act(() => clearProtectedRichContent("credentials", { nodeId: "backend-A" }));

    expect(richRenderScheduler.peek(renderKey(nodeA))).toBeNull();
    expect(richRenderScheduler.peek(renderKey(nodeB))?.ok).toBe(true);
    expect(Array.from(useRichContentViewStore.getState().entries.keys())).toEqual([
      richBlockViewKey(nodeB, "m1", "p1", "details:0"),
    ]);
    expect(artifactRequestCacheStats().entries).toBe(1);
    expect(richContentResetCounters).toMatchObject({ all: 0, node: 1 });
    // B's ledger survived the clear (A's mounted reader may read its own again).
    expect(artifactPublicationCacheSize()).toBeGreaterThanOrEqual(1);
  });

  test("a cache without a per-node clear is cleared entirely by a node clear", () => {
    const cleared: string[] = [];
    const unregister = registerProtectedRichCache("test-only", {
      clearAll: (reason) => cleared.push(`all:${reason}`),
    });
    try {
      clearProtectedRichContent("connection", { nodeId: "backend-A" });
    } finally {
      unregister();
    }
    expect(cleared).toEqual(["all:connection"]);
  });

  test("identities and connections are tracked per node scope, so live nodes do not thrash", async () => {
    const nodeA = scope("env-1", "session-1", "backend-A");
    const nodeB = scope("env-1", "session-1", "backend-B");
    const windowScope = getWindowScope();
    const leafA = windowScope.open({
      role: "leaf",
      client: new FakeNodeClient({ nodeId: "backend-A" as BackendId }),
    });
    const leafB = windowScope.open({
      role: "leaf",
      client: new FakeNodeClient({ nodeId: "backend-B" as BackendId }),
    });
    try {
      await settleRender(renderKey(nodeA));
      await settleRender(renderKey(nodeB));

      // Two live nodes, each reporting its own identity: nothing is cleared.
      noteRichBackendIdentity("backend-A", leafA);
      noteRichBackendIdentity("backend-B", leafB);
      noteRichBackendIdentity("backend-A", leafA);
      noteRichContentConnection("route-a", leafA);
      noteRichContentConnection("route-b", leafB);
      // The command scope's notes are separate from every leaf's.
      noteRichBackendIdentity("backend-B");
      noteRichContentConnection("local");
      expect(richContentResetCounters).toMatchObject({ all: 0, node: 0 });
      expect(richBackendIdentityOf(leafA)).toBe("backend-A");
      expect(richBackendIdentityOf()).toBe("backend-B");

      // B's connection moves: only B's content goes.
      noteRichContentConnection("route-b2", leafB);
      expect(richContentResetCounters).toMatchObject({ all: 0, node: 1 });
      expect(richRenderScheduler.peek(renderKey(nodeB))).toBeNull();
      expect(richRenderScheduler.peek(renderKey(nodeA))?.ok).toBe(true);

      // A leaf now answers as another backend: what the old identity served
      // goes, nothing else.
      await settleRender(renderKey(nodeB));
      noteRichBackendIdentity("backend-C", leafA);
      expect(richContentResetCounters).toMatchObject({ all: 0, node: 2 });
      expect(richRenderScheduler.peek(renderKey(nodeA))).toBeNull();
      expect(richRenderScheduler.peek(renderKey(nodeB))?.ok).toBe(true);

      // The command scope keeps today's behaviour: a new identity clears everything.
      noteRichBackendIdentity("backend-D");
      expect(richContentResetCounters.all).toBe(1);
      expect(richRenderScheduler.stats().settled).toBe(0);
    } finally {
      leafA.dispose();
      leafB.dispose();
    }
  });

  test("a disposed scope's notes go with it; a reopened scope starts fresh", () => {
    const windowScope = getWindowScope();
    const open = () =>
      windowScope.open({
        role: "leaf",
        client: new FakeNodeClient({ nodeId: "backend-A" as BackendId }),
      });
    const first = open();
    noteRichContentConnection("route-a", first);
    first.dispose();
    const second = open();
    try {
      // The first report on the new scope only records it.
      noteRichContentConnection("route-other", second);
      expect(richContentResetCounters).toMatchObject({ all: 0, node: 0 });
    } finally {
      second.dispose();
    }
  });

  test("a node clear reaches content keyed by the identity a scope reported", async () => {
    // The command scope runs under a provisional id in tests; its content is
    // keyed by the identity its capabilities answered.
    const command = scope("env-1", "session-1", "backend-A");
    const other = scope("env-1", "session-1", "backend-B");
    await settleRender(renderKey(command));
    await settleRender(renderKey(other));
    noteRichBackendIdentity("backend-A");
    const cleared: string[] = [];
    const unregister = registerProtectedRichCache("test-only", {
      clearAll: () => cleared.push("all"),
      clearBackend: (nodeId) => cleared.push(nodeId),
    });
    try {
      clearProtectedRichContent("credentials", { nodeId: getWindowScope().commandScope().nodeId });
    } finally {
      unregister();
    }
    expect(cleared.sort()).toEqual([getWindowScope().commandScope().nodeId, "backend-A"].sort());
    expect(richRenderScheduler.peek(renderKey(command))).toBeNull();
    expect(richRenderScheduler.peek(renderKey(other))?.ok).toBe(true);
  });
});

test("superseded media bytes cannot restore the cache or delete a replacement inflight read", async () => {
  const { resolveMediaUrl } = await import("./rich-markdown/media-resolver");
  let finishA!: (value: unknown) => void;
  let finishB!: (value: unknown) => void;
  const ref = { path: "/workspace-storage/same.png" };
  // Pinned bytes are the cacheable kind; a live read is never cached.
  const pin = { environmentId: "env-1", logicalSessionKey: "tab-1", messageId: "m1" };
  const pinned = (dataBase64: string) => ({
    status: "pinned",
    capturedAt: "2026-10-29T00:00:00.000Z",
    sha256: "0".repeat(64),
    byteLength: dataBase64.length,
    dataBase64,
  });
  invokeMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishA = resolve;
      }),
  );
  const a = resolveMediaUrl(ref, { cacheImage: true, pin });
  const rejected = a.catch((error: unknown) => error);
  clearProtectedRichContent("credentials");
  invokeMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishB = resolve;
      }),
  );
  const b = resolveMediaUrl(ref, { cacheImage: true, pin });
  finishA(pinned("OLD"));
  expect(await rejected).toMatchObject({ name: "AbortError" });
  expect(resolveMediaUrl(ref, { cacheImage: true, pin })).toBe(b);
  finishB(pinned("NEW"));
  await expect(b).resolves.toContain("NEW");
  await expect(resolveMediaUrl(ref, { cacheImage: true, pin })).resolves.toContain("NEW");
});
