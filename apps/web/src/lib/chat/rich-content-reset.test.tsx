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
import { useEnvironmentStore } from "@/stores/environmentStore";
import { createBrowserGatewayApi, installBrowserGatewayApi } from "@/lib/native/web-gateway";
import {
  clearProtectedRichContent,
  clearRichConversationContent,
  noteRichContentConnection,
  registeredProtectedRichCaches,
  resetRichContentResetTracking,
  richContentResetCounters,
} from "./rich-content-reset";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;

function scope(environmentId: string, logicalSessionKey = "session-1"): RichTranscriptScope {
  return { backendId: "backend-A", environmentId, logicalSessionKey, generation: "g1" };
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

    act(() => useEnvironmentStore.getState().removeEnvironment("env-deleted"));

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

test("superseded media bytes cannot restore the cache or delete a replacement inflight read", async () => {
  const { resolveMediaUrl } = await import("./rich-markdown/media-resolver");
  let finishA!: (value: string) => void;
  let finishB!: (value: string) => void;
  const ref = { path: "/workspace-storage/same.png" };
  invokeMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishA = resolve;
      }),
  );
  const a = resolveMediaUrl(ref, { cacheImage: true });
  const rejected = a.catch((error: unknown) => error);
  clearProtectedRichContent("credentials");
  invokeMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishB = resolve;
      }),
  );
  const b = resolveMediaUrl(ref, { cacheImage: true });
  finishA("OLD");
  expect(await rejected).toMatchObject({ name: "AbortError" });
  expect(resolveMediaUrl(ref, { cacheImage: true })).toBe(b);
  finishB("NEW");
  await expect(b).resolves.toContain("NEW");
  await expect(resolveMediaUrl(ref, { cacheImage: true })).resolves.toContain("NEW");
});
