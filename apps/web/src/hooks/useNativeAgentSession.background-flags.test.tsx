/**
 * Render cost of background reads in the native-agent session hook.
 *
 * The in-flight flags (`isRefreshing`, `sessionStateRefreshing`) only feed the
 * tab's connection surface, which ignores them once session state is
 * authoritative. A background poll over such a view must therefore not raise
 * and clear them, which used to cost the whole tab two renders per tick.
 *
 * Kept apart from `useNativeAgentSession.progressive.test.tsx`, which is far
 * past the file-size guideline.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type {
  NativeAgentDiscoveryUpdate,
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

const identity: NativeAgentViewIdentity = {
  backendInstanceId: "backend-1",
  environmentId: "env-flags",
  platform: "codex",
  logicalSessionKey: "env-env-flags:tab-1",
  providerSessionId: "session-1",
  sourceGeneration: "generation-1",
};

let transcriptUpdates: Array<
  () => NativeAgentTranscriptUpdate<TestMessage> | Promise<NativeAgentTranscriptUpdate<TestMessage>>
> = [];
let stateUpdates: Array<
  () => NativeAgentSessionStateUpdate | Promise<NativeAgentSessionStateUpdate>
> = [];

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getNativeAgentSyncCapabilities: async () => ({
    projectionSyncVersions: [1],
    historyPagingVersions: [1],
    progressiveViewVersions: [1],
    transcriptPatchVersions: [],
  }),
  getNativeAgentTranscriptUpdate: async (input: { knownToken?: string }) => {
    const next = transcriptUpdates.shift();
    if (next) return next();
    return {
      viewVersion: 1,
      status: "unchanged",
      token: input.knownToken ?? "transcript-unscripted",
      identity,
    } satisfies NativeAgentTranscriptUpdate<TestMessage>;
  },
  getNativeAgentSessionStateUpdate: async (input: { knownToken?: string }) => {
    const next = stateUpdates.shift();
    if (next) return next();
    return {
      viewVersion: 1,
      status: "unchanged",
      token: input.knownToken ?? "state-unscripted",
      identity,
    } satisfies NativeAgentSessionStateUpdate;
  },
  getNativeAgentDiscoveryUpdate: async () =>
    ({
      viewVersion: 1,
      status: "unchanged",
      token: "discovery-unscripted",
      identity,
    }) satisfies NativeAgentDiscoveryUpdate,
  ensureNativeAgentSession: async () => ({
    providerSessionId: "session-1",
    logicalSessionKey: identity.logicalSessionKey,
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

function transcriptSnapshot(token: string, messages: TestMessage[]) {
  return {
    viewVersion: 1,
    status: "snapshot",
    token,
    value: {
      identity,
      freshness: messages.length === 0 ? "empty" : "current",
      messages,
      historyEpoch: "epoch-1",
      historyComplete: true,
    },
  } satisfies NativeAgentTranscriptUpdate<TestMessage>;
}

function stateSnapshot(token: string) {
  return {
    viewVersion: 1,
    status: "snapshot",
    token,
    value: {
      identity,
      connection: "connected",
      turn: { phase: "running" },
      interactions: [],
      composerControls: [],
      capabilities: nativeAgentCapabilities("codex"),
      notices: [],
    },
  } satisfies NativeAgentSessionStateUpdate;
}

/** Renders the hook, counting renders and every in-flight flag value seen. */
function renderCountedSession() {
  const seen = { renders: 0, refreshing: [] as boolean[], stateRefreshing: [] as boolean[] };
  const rendered = renderHook(() => {
    const session = useNativeAgentSession<TestMessage>({
      platform: "codex",
      environmentId: identity.environmentId,
      tabId: "tab-1",
      // Inactive, so the hook's own poll loop stays out of the counts and
      // every read below is one this test issued.
      isActive: false,
      enabled: true,
    });
    seen.renders += 1;
    seen.refreshing.push(session.isRefreshing);
    seen.stateRefreshing.push(session.sessionStateRefreshing);
    return session;
  });
  const reset = () => {
    seen.renders = 0;
    seen.refreshing = [];
    seen.stateRefreshing = [];
  };
  return { ...rendered, seen, reset };
}

beforeEach(() => {
  resetNativeAgentSyncCapabilityForTests();
  transcriptUpdates = [];
  stateUpdates = [];
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

describe("useNativeAgentSession background read flags", () => {
  test("unchanged background reads over an authoritative view render nothing", async () => {
    transcriptUpdates = [() => transcriptSnapshot("transcript-1", [{ id: "m1", text: "one" }])];
    stateUpdates = [() => stateSnapshot("state-1")];
    const { result, seen, reset } = renderCountedSession();
    await act(async () => {
      await result.current.refresh();
    });
    await waitFor(() => expect(result.current.sessionStateAvailability).toBe("current"));
    expect(result.current.isRefreshing).toBe(false);
    reset();

    // The first poll after the connecting read may render once: React cannot
    // always bail out early on a same-value state write that closely follows a
    // real update, so it renders the hook and then discards the result. The
    // previous code rendered on every tick.
    await act(async () => {
      await result.current.refresh({ manual: false });
    });
    expect(seen.renders).toBeLessThanOrEqual(1);
    reset();

    for (let tick = 0; tick < 5; tick += 1) {
      await act(async () => {
        await result.current.refresh({ manual: false });
      });
    }

    expect(seen.renders).toBe(0);
    expect(result.current.isRefreshing).toBe(false);
    expect(result.current.sessionStateRefreshing).toBe(false);
    expect(result.current.projection?.connection).toBe("connected");
  });

  test("a background read that changes the transcript still installs it", async () => {
    transcriptUpdates = [() => transcriptSnapshot("transcript-1", [{ id: "m1", text: "one" }])];
    stateUpdates = [() => stateSnapshot("state-1")];
    const { result, seen, reset } = renderCountedSession();
    await act(async () => {
      await result.current.refresh();
    });
    await waitFor(() => expect(result.current.sessionStateAvailability).toBe("current"));
    reset();

    transcriptUpdates = [
      () =>
        transcriptSnapshot("transcript-2", [
          { id: "m1", text: "one" },
          { id: "m2", text: "two" },
        ]),
    ];
    await act(async () => {
      await result.current.refresh({ manual: false });
    });

    expect(result.current.projection?.messages.map(({ id }) => id)).toEqual(["m1", "m2"]);
    expect(seen.refreshing.every((value) => !value)).toBe(true);
    expect(seen.stateRefreshing.every((value) => !value)).toBe(true);
  });

  test("authority loss stays pending until the independent transcript read settles", async () => {
    transcriptUpdates = [() => transcriptSnapshot("transcript-1", [{ id: "m1", text: "one" }])];
    stateUpdates = [() => stateSnapshot("state-1")];
    const { result } = renderCountedSession();
    await act(async () => {
      await result.current.refresh();
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    transcriptUpdates = [
      async () => {
        await gate;
        return { viewVersion: 1, status: "missing" };
      },
    ];
    stateUpdates = [() => ({ viewVersion: 1, status: "missing" })];
    let inFlight!: Promise<unknown>;
    act(() => {
      inFlight = result.current.refresh({ manual: false });
    });
    await waitFor(() => expect(result.current.sessionStateAvailability).toBe("unavailable"));
    // These are the controller's fallback inputs: authority is gone, but the
    // prior completed read must not expose retry controls during this batch.
    expect(result.current.hasCompletedRead).toBe(true);
    expect(result.current.isRefreshing).toBe(true);
    expect(result.current.sessionStateError).toBeNull();
    await act(async () => {
      release();
      await inFlight;
    });
    expect(result.current.isRefreshing).toBe(false);
    expect(result.current.sessionStateRefreshing).toBe(false);
    expect(result.current.projection).toBeNull();
    expect(result.current.sessionStateAvailability).toBe("unavailable");
  });

  test.each(["error response", "thrown error"] as const)(
    "quiet read stays pending after a state %s until the transcript settles",
    async (failure) => {
      transcriptUpdates = [() => transcriptSnapshot("transcript-1", [{ id: "m1", text: "one" }])];
      stateUpdates = [() => stateSnapshot("state-1")];
      const { result } = renderCountedSession();
      await act(async () => {
        await result.current.refresh();
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      transcriptUpdates = [
        async () => {
          await gate;
          return transcriptSnapshot("transcript-2", [{ id: "m2", text: "two" }]);
        },
      ];
      stateUpdates = [
        () => {
          if (failure === "thrown error") throw new Error("state read failed");
          return {
            viewVersion: 1,
            status: "unavailable",
            retryable: true,
            error: "state read failed",
          };
        },
      ];
      let inFlight!: Promise<unknown>;
      act(() => {
        inFlight = result.current.refresh({ manual: false });
      });
      try {
        await waitFor(() => expect(result.current.sessionStateAvailability).toBe("unavailable"));
        expect(result.current.sessionStateError).toBe("state read failed");
        expect(result.current.isRefreshing).toBe(true);
      } finally {
        await act(async () => {
          release();
          await inFlight;
        });
      }
      expect(result.current.isRefreshing).toBe(false);
      expect(result.current.sessionStateRefreshing).toBe(false);
      expect(result.current.projection?.messages.map(({ id }) => id)).toEqual(["m2"]);
      expect(result.current.sessionStateAvailability).toBe("unavailable");
      stateUpdates = [() => stateSnapshot("state-recovered")];
      await act(async () => {
        await result.current.refresh({ manual: false });
      });
      expect(result.current.sessionStateAvailability).toBe("current");
      expect(result.current.sessionStateError).toBeNull();
    },
  );

  test("a manual read still raises and clears the flags", async () => {
    transcriptUpdates = [() => transcriptSnapshot("transcript-1", [{ id: "m1", text: "one" }])];
    stateUpdates = [() => stateSnapshot("state-1")];
    const { result, seen, reset } = renderCountedSession();
    await act(async () => {
      await result.current.refresh();
    });
    await waitFor(() => expect(result.current.sessionStateAvailability).toBe("current"));
    reset();

    // Held open, as a real read is: one that settles at once clears the flags in
    // the batch that raised them, so no render would ever show them.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    transcriptUpdates = [
      () => gate.then(() => transcriptSnapshot("transcript-2", [{ id: "m1", text: "one" }])),
    ];
    stateUpdates = [() => gate.then(() => stateSnapshot("state-2"))];
    let read!: Promise<unknown>;
    await act(async () => {
      read = result.current.refresh({ manual: true });
      await Promise.resolve();
    });
    expect(seen.refreshing).toContain(true);
    expect(seen.stateRefreshing).toContain(true);

    await act(async () => {
      release();
      await read;
    });
    expect(result.current.isRefreshing).toBe(false);
    expect(result.current.sessionStateRefreshing).toBe(false);
  });

  test("a background read before any authoritative state still reports connecting", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    transcriptUpdates = [
      async () => {
        await gate;
        return transcriptSnapshot("transcript-1", [{ id: "m1", text: "one" }]);
      },
    ];
    stateUpdates = [
      async () => {
        await gate;
        return stateSnapshot("state-1");
      },
    ];
    const { result } = renderCountedSession();
    expect(result.current.sessionStateAvailability).not.toBe("current");

    let inFlight!: Promise<unknown>;
    act(() => {
      inFlight = result.current.refresh({ manual: false });
    });
    // Nothing authoritative is held yet, so the surface needs the flags. They
    // are set separately around the capability check; isRefreshing can already
    // be true from mount, so wait for both.
    await waitFor(() => {
      expect(result.current.isRefreshing).toBe(true);
      expect(result.current.sessionStateRefreshing).toBe(true);
    });

    await act(async () => {
      release();
      await inFlight;
    });
    expect(result.current.isRefreshing).toBe(false);
    expect(result.current.sessionStateRefreshing).toBe(false);
    expect(result.current.sessionStateAvailability).toBe("current");
  });
});
