/**
 * Plan item 3016: several live nodes neither clear each other's protected
 * content nor multiply cache memory, and capability answers are cached per
 * node scope.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { BackendId } from "@orkestrator/protocol/federation";
import {
  CLIENT_STATE_CAPABILITIES_COMMAND,
  NO_CLIENT_STATE_CAPABILITIES,
} from "@orkestrator/protocol/client-state";
import { TRANSCRIPT_ARTIFACT_COMMANDS } from "@orkestrator/protocol/transcript-artifact-commands";
import { invoke } from "@/lib/native/backend";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import {
  readTranscriptArtifactCapabilities,
  resetTranscriptArtifactCapabilities,
} from "@/hooks/useTranscriptArtifactCapabilities";
import {
  clientStateCapabilities,
  resetClientStateCapabilitiesForTests,
} from "@/lib/client-state-capabilities";
import {
  getChangeTrackingCapabilities,
  resetChangeTrackingCapabilitiesForTests,
} from "@/lib/backend/changes";
import { getCapabilities, resetCapabilities } from "@/lib/design-client";
import {
  invalidateNativeAgentSyncCapability,
  nativeAgentProgressiveSupported,
  nativeAgentSyncSupported,
} from "@/lib/native-agent-sync-capabilities";
import {
  artifactRequestCacheStats,
  clearArtifactRequestCache,
  useArtifactPublication,
} from "./artifact-requests";
import {
  clearImagePreviewCache,
  imagePreviewCacheStats,
  readImagePreviewCache,
  writeImagePreviewCache,
} from "./image-preview-cache";
// Registers the media cache (resolver reads and image previews) with the reset.
import "./rich-markdown/media-resolver";
import { richCacheKey, type RichTranscriptScope } from "./rich-identity";
import { richRenderScheduler } from "./rich-render-cache";
import {
  clearProtectedRichContent,
  noteRichBackendIdentity,
  noteRichContentConnection,
  resetRichContentResetTracking,
  richContentResetCounters,
} from "./rich-content-reset";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const NODE_A = "backend-A" as BackendId;
const NODE_B = "backend-B" as BackendId;

const conversation = (backendId: string): RichTranscriptScope => ({
  backendId,
  environmentId: "env-1",
  logicalSessionKey: "session-1",
  generation: "g1",
});

function renderKey(target: RichTranscriptScope): string {
  return richCacheKey({
    kind: "highlight",
    scope: target,
    contentHash: "same-content",
    rendererVersion: "v",
    theme: "dark",
  });
}

async function settleRender(key: string): Promise<void> {
  await richRenderScheduler.request({
    key,
    lane: "highlight",
    sourceBytes: 4,
    run: async () => ({ value: "tokens", bytes: 8 }),
  }).promise;
}

/** A leaf scope in the app window whose client answers as `nodeId`. */
function openLeaf(nodeId: BackendId, extra: Record<string, unknown> = {}) {
  const client = new FakeNodeClient({
    nodeId,
    invoke: {
      [TRANSCRIPT_ARTIFACT_COMMANDS.capabilities]: { backendId: nodeId, rolloutFlags: {} },
      [TRANSCRIPT_ARTIFACT_COMMANDS.getPublication]: (args: Record<string, unknown>) => ({
        publicationId: args.publicationId,
      }),
      ...extra,
    },
  });
  const scope = getWindowScope().open({ role: "leaf", client });
  opened.push(scope);
  return { client, scope };
}

const opened: NodeScope[] = [];

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((command: string) => {
    if (command === TRANSCRIPT_ARTIFACT_COMMANDS.capabilities) {
      return Promise.resolve({ backendId: "backend-command", rolloutFlags: {} });
    }
    if (command === TRANSCRIPT_ARTIFACT_COMMANDS.getPublication) {
      return Promise.resolve({ publicationId: "pub-1" });
    }
    return Promise.resolve(undefined);
  });
  richRenderScheduler.clear();
  clearArtifactRequestCache();
  clearImagePreviewCache();
  resetTranscriptArtifactCapabilities();
  resetRichContentResetTracking();
});

afterEach(() => {
  cleanup();
  for (const scope of opened.splice(0)) scope.dispose();
  const budgets = getWindowScope().budgets;
  budgets.images.setShownNode(null);
  clearImagePreviewCache();
  clearArtifactRequestCache();
  resetTranscriptArtifactCapabilities();
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
});

describe("two identities live at once", () => {
  test("neither node's identity or connection report clears the other's content", async () => {
    const a = openLeaf(NODE_A);
    const b = openLeaf(NODE_B);
    // Each scope reads its own identity through its own client.
    expect((await readTranscriptArtifactCapabilities(a.scope))?.backendId).toBe(NODE_A);
    expect((await readTranscriptArtifactCapabilities(b.scope))?.backendId).toBe(NODE_B);
    expect((await readTranscriptArtifactCapabilities())?.backendId).toBe("backend-command");
    expect(a.client.calls(TRANSCRIPT_ARTIFACT_COMMANDS.capabilities)).toHaveLength(1);

    await settleRender(renderKey(conversation(NODE_A)));
    await settleRender(renderKey(conversation(NODE_B)));
    writeImagePreviewCache("shot", "data:image/png;base64,A", undefined, NODE_A);
    writeImagePreviewCache("shot", "data:image/png;base64,B", undefined, NODE_B);
    renderHook(() => useArtifactPublication(conversation(NODE_A), "pub-1"));
    renderHook(() => useArtifactPublication(conversation(NODE_B), "pub-1"));
    await waitFor(() => expect(artifactRequestCacheStats().entries).toBe(2));

    // Both keep reporting, alternately; nothing thrashes.
    for (let round = 0; round < 3; round++) {
      noteRichBackendIdentity(NODE_A, a.scope);
      noteRichBackendIdentity(NODE_B, b.scope);
      noteRichContentConnection("route-a", a.scope);
      noteRichContentConnection("route-b", b.scope);
    }
    expect(richContentResetCounters).toMatchObject({ all: 0, node: 0 });

    // A's credentials change: only A's content goes.
    act(() => clearProtectedRichContent("credentials", { nodeId: NODE_A }));
    expect(richRenderScheduler.peek(renderKey(conversation(NODE_A)))).toBeNull();
    expect(richRenderScheduler.peek(renderKey(conversation(NODE_B)))?.ok).toBe(true);
    expect(readImagePreviewCache("shot", NODE_A)).toBeNull();
    expect(readImagePreviewCache("shot", NODE_B)).toBe("data:image/png;base64,B");
    expect(artifactRequestCacheStats().entries).toBeGreaterThanOrEqual(1);
    expect(getWindowScope().budgets.artifacts.usedBytesFor(NODE_B)).toBeGreaterThan(0);
    // A forgot its identity and reads it again; B and the command scope kept theirs.
    expect(await readTranscriptArtifactCapabilities(a.scope)).not.toBeNull();
    expect(a.client.calls(TRANSCRIPT_ARTIFACT_COMMANDS.capabilities)).toHaveLength(2);
    expect(b.client.calls(TRANSCRIPT_ARTIFACT_COMMANDS.capabilities)).toHaveLength(1);
    const commandReads = invokeMock.mock.calls.filter(
      ([command]) => command === TRANSCRIPT_ARTIFACT_COMMANDS.capabilities,
    );
    expect(commandReads).toHaveLength(1);
  });

  test("a disposed node's cached content leaves the shared budget with it", () => {
    const a = openLeaf(NODE_A);
    openLeaf(NODE_B);
    writeImagePreviewCache("shot", "data:image/png;base64,A", undefined, NODE_A);
    writeImagePreviewCache("shot", "data:image/png;base64,B", undefined, NODE_B);
    const budget = getWindowScope().budgets.images;
    expect(budget.usedBytesFor(NODE_A)).toBeGreaterThan(0);
    a.scope.dispose();
    expect(budget.usedBytesFor(NODE_A)).toBe(0);
    expect(readImagePreviewCache("shot", NODE_A)).toBeNull();
    expect(readImagePreviewCache("shot", NODE_B)).toBe("data:image/png;base64,B");
  });
});

describe("one window budget is shared", () => {
  test("image previews of two nodes reserve from the window's single images budget", () => {
    openLeaf(NODE_A);
    openLeaf(NODE_B);
    const budget = getWindowScope().budgets.images;
    const big = "d".repeat(7 * 1024 * 1024);
    const perNode = Math.floor(budget.totalBytes / big.length);
    for (let index = 0; index < perNode; index++) {
      writeImagePreviewCache(`a-${index}`, big, undefined, NODE_A);
    }
    expect(budget.usedBytesFor(NODE_A)).toBe(perNode * big.length);

    // B's previews do not get a budget of their own: they take A's oldest.
    writeImagePreviewCache("b-0", big, undefined, NODE_B);
    writeImagePreviewCache("b-1", big, undefined, NODE_B);
    expect(readImagePreviewCache("a-0", NODE_A)).toBeNull();
    expect(readImagePreviewCache("a-1", NODE_A)).toBeNull();
    expect(readImagePreviewCache("b-1", NODE_B)).toBe(big);
    expect(budget.usedBytes).toBeLessThanOrEqual(budget.totalBytes);
    expect(imagePreviewCacheStats().bytes).toBe(budget.usedBytes);

    // The shown node is never evicted: a full budget refuses B instead.
    budget.setShownNode(NODE_A);
    for (let index = 0; index < perNode; index++) {
      writeImagePreviewCache(`a-shown-${index}`, big, undefined, NODE_A);
    }
    const shownBytes = budget.usedBytesFor(NODE_A);
    writeImagePreviewCache("b-late", big, undefined, NODE_B);
    expect(budget.usedBytesFor(NODE_A)).toBe(shownBytes);
    expect(budget.usedBytes).toBeLessThanOrEqual(budget.totalBytes);
  });
});

describe("a scope's capability cache is independent", () => {
  test("client-state, change-tracking, design, sync and artifact capabilities are per scope", async () => {
    const a = openLeaf(NODE_A, {
      [CLIENT_STATE_CAPABILITIES_COMMAND]: {
        ...NO_CLIENT_STATE_CAPABILITIES,
        noticeDismissals: true,
      },
      changes_get_capabilities: { capability: "change-tracking", history: true },
      design_capabilities: { ok: true, value: { library: true } },
      get_native_agent_sync_capabilities: {
        projectionSyncVersions: [1],
        historyPagingVersions: [1],
        progressiveViewVersions: [1],
      },
    });
    // The command node is an older backend without any of these.
    invokeMock.mockImplementation((command: string) =>
      Promise.reject(new Error(`Unknown backend command: ${command}`)),
    );
    resetClientStateCapabilitiesForTests();
    resetChangeTrackingCapabilitiesForTests();
    resetCapabilities();
    invalidateNativeAgentSyncCapability();

    expect((await clientStateCapabilities(a.scope)).noticeDismissals).toBe(true);
    expect((await clientStateCapabilities()).noticeDismissals).toBe(false);
    expect(await getChangeTrackingCapabilities(a.scope)).toMatchObject({ history: true });
    expect(await getChangeTrackingCapabilities()).toBeNull();
    expect(await getCapabilities("key", a.scope)).toEqual({ library: true } as never);
    await expect(getCapabilities("key")).rejects.toThrow(/too old for the design canvas/);
    expect(await nativeAgentSyncSupported(a.scope)).toBe(true);
    expect(await nativeAgentProgressiveSupported(a.scope)).toBe(true);
    expect(await nativeAgentSyncSupported()).toBe(false);

    // Cached on the scope: asking again does not read A again.
    await clientStateCapabilities(a.scope);
    await getChangeTrackingCapabilities(a.scope);
    await getCapabilities("key", a.scope);
    await nativeAgentSyncSupported(a.scope);
    for (const command of [
      CLIENT_STATE_CAPABILITIES_COMMAND,
      "changes_get_capabilities",
      "design_capabilities",
      "get_native_agent_sync_capabilities",
    ]) {
      expect(a.client.calls(command)).toHaveLength(1);
    }

    // Resetting the command scope's answers leaves A's.
    resetClientStateCapabilitiesForTests();
    resetChangeTrackingCapabilitiesForTests();
    resetCapabilities();
    invalidateNativeAgentSyncCapability();
    expect((await clientStateCapabilities(a.scope)).noticeDismissals).toBe(true);
    expect(a.client.calls(CLIENT_STATE_CAPABILITIES_COMMAND)).toHaveLength(1);

    // A reconnect of A's event stream makes only A ask again.
    a.client.emit("native-event-stream-connected", {});
    await clientStateCapabilities(a.scope);
    expect(a.client.calls(CLIENT_STATE_CAPABILITIES_COMMAND)).toHaveLength(2);

    // A disposed scope takes its answers (and its listener) with it.
    a.scope.dispose();
    expect(a.client.listenerCount()).toBe(0);
    const reopened = openLeaf(NODE_A, {
      [CLIENT_STATE_CAPABILITIES_COMMAND]: { ...NO_CLIENT_STATE_CAPABILITIES },
    });
    expect((await clientStateCapabilities(reopened.scope)).noticeDismissals).toBe(false);
    expect(reopened.client.calls(CLIENT_STATE_CAPABILITIES_COMMAND)).toHaveLength(1);
  });
});
