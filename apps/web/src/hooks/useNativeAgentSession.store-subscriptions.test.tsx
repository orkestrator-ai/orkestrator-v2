/**
 * What in the shared projection store re-renders the native session hook, and
 * with it the whole agent tab (WEB-2's narrower subscriptions).
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type {
  NativeAgentSessionProjection,
  NativeAgentSessionStateUpdate,
  NativeAgentTranscriptUpdate,
  NativeAgentViewIdentity,
} from "@orkestrator/protocol/native-agent";
import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import * as realBackend from "@/lib/backend";
import { nativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import { appCommandStore } from "@/test/app-command-store";

interface TestMessage {
  id: string;
  text: string;
}

const realBackendSnapshot = { ...realBackend };
const SESSION_KEY = "env-env-subs:tab-1";

const identity: NativeAgentViewIdentity = {
  backendInstanceId: "backend-1",
  environmentId: "env-subs",
  platform: "codex",
  logicalSessionKey: SESSION_KEY,
  providerSessionId: "session-1",
  sourceGeneration: "generation-1",
};

const transcriptKnownTokens: Array<string | undefined> = [];

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getNativeAgentSyncCapabilities: async () => ({
    projectionSyncVersions: [1],
    historyPagingVersions: [1],
    progressiveViewVersions: [1],
    transcriptPatchVersions: [],
  }),
  getNativeAgentTranscriptUpdate: async (input: { knownToken?: string }) => {
    transcriptKnownTokens.push(input.knownToken);
    if (input.knownToken) {
      return { viewVersion: 1, status: "unchanged", token: input.knownToken, identity };
    }
    return {
      viewVersion: 1,
      status: "snapshot",
      token: "transcript-1",
      value: {
        identity,
        freshness: "current",
        messages: [{ id: "m1", text: "one" }],
        historyEpoch: "epoch-1",
        historyComplete: true,
      },
    } satisfies NativeAgentTranscriptUpdate<TestMessage>;
  },
  getNativeAgentSessionStateUpdate: async () =>
    ({
      viewVersion: 1,
      status: "snapshot",
      token: "state-1",
      value: {
        identity,
        connection: "connected",
        turn: { phase: "running" },
        interactions: [],
        composerControls: [],
        capabilities: nativeAgentCapabilities("codex"),
        notices: [],
      },
    }) satisfies NativeAgentSessionStateUpdate,
  getNativeAgentDiscoveryUpdate: async () => ({
    viewVersion: 1,
    status: "unchanged",
    token: "discovery-1",
    identity,
  }),
  ensureNativeAgentSession: async () => ({
    providerSessionId: "session-1",
    logicalSessionKey: SESSION_KEY,
    environmentId: identity.environmentId,
    agent: "codex",
  }),
  adoptNativeAgentSession: async () => ({}),
  getNativeAgentProjection: async () => null,
  getNativeAgentProjectionUpdate: async () => {
    throw new Error("Unexpected joined projection request");
  },
}));

const { useNativeAgentSession, resetNativeAgentSyncCapabilityForTests } =
  await import("./useNativeAgentSession");

afterAll(() => {
  resetNativeAgentSyncCapabilityForTests();
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

function renderCountedSession() {
  const seen = { renders: 0 };
  const rendered = renderHook(() => {
    seen.renders += 1;
    return useNativeAgentSession<TestMessage>({
      platform: "codex",
      environmentId: identity.environmentId,
      tabId: "tab-1",
      // Inactive, so the hook's own poll loop stays out of the counts.
      isActive: false,
      enabled: true,
    });
  });
  return { ...rendered, seen };
}

async function settledSession() {
  const session = renderCountedSession();
  await act(async () => {
    await session.result.current.refresh();
  });
  await waitFor(() => expect(session.result.current.sessionStateAvailability).toBe("current"));
  await waitFor(() =>
    expect(
      appCommandStore(nativeAgentProjectionStore).getState().progressiveCaches.has(SESSION_KEY),
    ).toBe(true),
  );
  session.seen.renders = 0;
  return session;
}

beforeEach(() => {
  resetNativeAgentSyncCapabilityForTests();
  transcriptKnownTokens.length = 0;
  appCommandStore(paneLayoutStore).setState({
    environments: new Map(),
    hydration: new Map(),
    activeEnvironmentId: null,
  });
  appCommandStore(nativeAgentProjectionStore).getState().reset();
});

afterEach(() => {
  cleanup();
  appCommandStore(nativeAgentProjectionStore).getState().reset();
});

describe("useNativeAgentSession store subscriptions", () => {
  test("a progressive cache write does not re-render the hook", async () => {
    const { seen } = await settledSession();
    const store = appCommandStore(nativeAgentProjectionStore).getState();
    const entry = store.progressiveCaches.get(SESSION_KEY)!;

    act(() => {
      for (let tick = 1; tick <= 3; tick += 1) {
        appCommandStore(nativeAgentProjectionStore)
          .getState()
          .setProgressiveCache(SESSION_KEY, { ...entry, discoveryToken: `moved-${tick}` });
      }
    });
    expect(
      appCommandStore(nativeAgentProjectionStore).getState().progressiveCaches.get(SESSION_KEY),
    ).toEqual({
      ...entry,
      discoveryToken: "moved-3",
    });
    expect(seen.renders).toBe(0);
  });

  test("a sync cache write that keeps the projection does not re-render the hook", async () => {
    const { seen } = await settledSession();
    const projection = appCommandStore(nativeAgentProjectionStore)
      .getState()
      .projections.get(SESSION_KEY)!;

    act(() => {
      appCommandStore(nativeAgentProjectionStore)
        .getState()
        .setProjection(SESSION_KEY, projection, {
          token: "sync-moved",
          liveProjection: projection,
          historyMessages: [],
          historyBytes: 0,
          historyComplete: true,
        });
    });
    expect(
      appCommandStore(nativeAgentProjectionStore).getState().syncCaches.get(SESSION_KEY)?.token,
    ).toBe("sync-moved");
    expect(seen.renders).toBe(0);
  });

  test("a new shared projection still reaches the hook", async () => {
    const { result, seen } = await settledSession();
    const store = appCommandStore(nativeAgentProjectionStore).getState();
    const projection = store.projections.get(
      SESSION_KEY,
    ) as NativeAgentSessionProjection<TestMessage>;
    const next = {
      ...projection,
      revision: projection.revision + 1,
      messages: [...projection.messages, { id: "m2", text: "two" }],
    };

    act(() => {
      appCommandStore(nativeAgentProjectionStore)
        .getState()
        .setProjection(SESSION_KEY, next, store.syncCaches.get(SESSION_KEY) ?? null);
    });
    expect(seen.renders).toBeGreaterThan(0);
    expect(result.current.projection?.messages.map((message) => message.id)).toEqual(["m1", "m2"]);
  });

  test("a remount still restores what the caches hold", async () => {
    const first = await settledSession();
    first.unmount();
    transcriptKnownTokens.length = 0;

    const second = renderCountedSession();
    expect(second.result.current.projection?.messages.map((message) => message.id)).toEqual(["m1"]);
    await act(async () => {
      await second.result.current.refresh();
    });
    expect(transcriptKnownTokens[0]).toBe("transcript-1");
  });
});
