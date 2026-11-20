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
import { act, cleanup, waitFor } from "@testing-library/react";
import { renderHookInAppCommandScope } from "@/test/render-in-node-scope";
import type {
  NativeAgentDiscoveryUpdate,
  NativeAgentLiveUpdate,
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
const readLiveUpdate = mock(async (): Promise<NativeAgentLiveUpdate<TestMessage>> => {
  throw new Error("Unexpected combined live update");
});
const readCapabilities = mock(async () => ({
  historyPagingVersions: [1],
  progressiveViewVersions: [1],
  transcriptPatchVersions: [],
  liveUpdateVersions: [] as number[],
}));
const readTranscript = mock(async (input: { knownToken?: string; forceSnapshot?: boolean }) => {
  const next = transcriptUpdates.shift();
  if (next) return next();
  return {
    viewVersion: 1,
    status: "unchanged",
    token: input.knownToken ?? "transcript-unscripted",
    identity,
  } satisfies NativeAgentTranscriptUpdate<TestMessage>;
});

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getNativeAgentSyncCapabilities: readCapabilities,
  getNativeAgentLiveUpdate: readLiveUpdate,
  getNativeAgentTranscriptUpdate: readTranscript,
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
}));

const { useNativeAgentSession, resetNativeAgentSyncCapabilityForTests } =
  await import("./useNativeAgentSession");

afterAll(() => {
  resetNativeAgentSyncCapabilityForTests();
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

function transcriptSnapshot(token: string, messages: TestMessage[], viewIdentity = identity) {
  return {
    viewVersion: 1,
    status: "snapshot",
    token,
    value: {
      identity: viewIdentity,
      freshness: messages.length === 0 ? "empty" : "current",
      messages,
      historyEpoch: "epoch-1",
      historyComplete: true,
    },
  } satisfies NativeAgentTranscriptUpdate<TestMessage>;
}

function stateSnapshot(token: string, viewIdentity = identity) {
  return {
    viewVersion: 1,
    status: "snapshot",
    token,
    value: {
      identity: viewIdentity,
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
  const seen = {
    renders: 0,
    refreshing: [] as boolean[],
    stateRefreshing: [] as boolean[],
    failures: [] as Array<string | null>,
    genericFailures: [] as boolean[],
  };
  const rendered = renderHookInAppCommandScope(() => {
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
    const failure = session.transcriptError ?? session.sessionStateError ?? session.runtimeError;
    seen.failures.push(failure);
    seen.genericFailures.push(
      failure === null &&
        session.sessionStateAvailability !== "current" &&
        session.hasCompletedRead &&
        !session.isRefreshing &&
        !session.transcriptRefreshing &&
        !session.sessionStateRefreshing &&
        session.sessionStateAvailability !== "refreshing",
    );
    return session;
  });
  const reset = () => {
    seen.renders = 0;
    seen.refreshing = [];
    seen.stateRefreshing = [];
    seen.failures = [];
    seen.genericFailures = [];
  };
  return { ...rendered, seen, reset };
}

beforeEach(() => {
  resetNativeAgentSyncCapabilityForTests();
  transcriptUpdates = [];
  stateUpdates = [];
  readTranscript.mockClear();
  readLiveUpdate.mockClear();
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

  test("a runtime-only failure stays visible through a background retry", async () => {
    const unreachable = "Could not read session sync capabilities";
    readCapabilities.mockImplementationOnce(async () => {
      throw new Error(unreachable);
    });
    const { result, seen, reset } = renderCountedSession();
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.runtimeError).toBe(unreachable);
    expect(result.current.transcriptError).toBeNull();
    expect(result.current.sessionStateError).toBeNull();
    expect(result.current.sessionStateAvailability).toBe("unavailable");
    reset();

    const gate = Promise.withResolvers<void>();
    transcriptUpdates = [() => gate.promise.then(() => transcriptSnapshot("transcript-1", []))];
    stateUpdates = [() => gate.promise.then(() => stateSnapshot("state-1"))];
    let inFlight!: Promise<unknown>;
    try {
      await act(async () => {
        inFlight = result.current.refresh({ manual: false });
      });
      expect(transcriptUpdates).toHaveLength(0);
      expect(stateUpdates).toHaveLength(0);
      expect(result.current.runtimeError).toBe(unreachable);
      expect(result.current.isRefreshing).toBe(false);
      expect(result.current.sessionStateRefreshing).toBe(false);
      expect(seen.failures.every((failure) => failure === unreachable)).toBe(true);
    } finally {
      await act(async () => {
        gate.resolve();
        await inFlight;
      });
    }
    expect(result.current.runtimeError).toBeNull();
    expect(result.current.sessionStateAvailability).toBe("current");
    expect(result.current.projection?.connection).toBe("connected");
  });

  test.each(["split", "combined"] as const)(
    "a transcript-only failure stays visible through a %s retry with current state",
    async (readPath) => {
      const combined = readPath === "combined";
      const transcriptFailure = "Transcript read failed";
      if (combined) {
        readCapabilities.mockImplementationOnce(async () => ({
          historyPagingVersions: [1],
          progressiveViewVersions: [1],
          transcriptPatchVersions: [],
          liveUpdateVersions: [1],
        }));
      }
      transcriptUpdates = [() => transcriptSnapshot("transcript-1", [])];
      stateUpdates = [() => stateSnapshot("state-1")];
      const { result, seen, reset } = renderCountedSession();
      await act(async () => {
        await result.current.refresh();
      });

      const failedTranscript = {
        viewVersion: 1,
        status: "unavailable",
        retryable: true,
        error: transcriptFailure,
      } as const;
      const unchangedState = {
        viewVersion: 1,
        status: "unchanged",
        token: "state-1",
        identity,
      } as const;
      if (combined) {
        readLiveUpdate.mockResolvedValueOnce({
          viewVersion: 1,
          transcript: failedTranscript,
          state: unchangedState,
        });
      } else {
        transcriptUpdates = [() => failedTranscript];
      }
      await act(async () => {
        await result.current.refresh({ manual: false });
      });
      expect(result.current.transcriptError).toBe(transcriptFailure);
      expect(result.current.sessionStateError).toBeNull();
      expect(result.current.runtimeError).toBeNull();
      expect(result.current.sessionStateAvailability).toBe("current");
      reset();

      const gate = Promise.withResolvers<void>();
      const recoveredTranscript = transcriptSnapshot("transcript-2", [{ id: "m2", text: "two" }]);
      if (combined) {
        readLiveUpdate.mockImplementationOnce(async () => {
          await gate.promise;
          return { viewVersion: 1, transcript: recoveredTranscript, state: unchangedState };
        });
      } else {
        transcriptUpdates = [() => gate.promise.then(() => recoveredTranscript)];
      }
      readTranscript.mockClear();
      readLiveUpdate.mockClear();
      let inFlight!: Promise<unknown>;
      try {
        await act(async () => {
          inFlight = result.current.refresh({ manual: false });
        });
        expect(readLiveUpdate).toHaveBeenCalledTimes(combined ? 1 : 0);
        expect(readTranscript).toHaveBeenCalledTimes(combined ? 0 : 1);
        expect(result.current.transcriptError).toBe(transcriptFailure);
        expect(result.current.sessionStateAvailability).toBe("current");
        expect(seen.failures.every((failure) => failure === transcriptFailure)).toBe(true);
      } finally {
        await act(async () => {
          gate.resolve();
          await inFlight;
        });
      }
      expect(seen.refreshing).not.toContain(true);
      expect(seen.stateRefreshing).not.toContain(true);
      expect(result.current.transcriptError).toBeNull();
      expect(result.current.sessionStateAvailability).toBe("current");
      expect(result.current.projection?.messages).toEqual(recoveredTranscript.value.messages);
    },
  );

  describe("over a failed view", () => {
    const unreachable = "The connection is awaiting a verified route.";

    /** Connects, then fails one background read the way an unreachable node does. */
    async function renderFailedSession() {
      transcriptUpdates = [() => transcriptSnapshot("transcript-1", [{ id: "m1", text: "one" }])];
      stateUpdates = [() => stateSnapshot("state-1")];
      const rendered = renderCountedSession();
      await act(async () => {
        await rendered.result.current.refresh();
      });
      transcriptUpdates = [
        () => {
          throw new Error(unreachable);
        },
      ];
      stateUpdates = [
        () => {
          throw new Error(unreachable);
        },
      ];
      await act(async () => {
        await rendered.result.current.refresh({ manual: false });
      });
      expect(rendered.result.current.transcriptError).toBe(unreachable);
      expect(rendered.result.current.sessionStateError).toBe(unreachable);
      rendered.reset();
      return rendered;
    }

    test("a failing background retry keeps the failure on screen throughout", async () => {
      const { result, seen } = await renderFailedSession();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      transcriptUpdates = [
        async () => {
          await gate;
          throw new Error(unreachable);
        },
      ];
      stateUpdates = [
        async () => {
          await gate;
          throw new Error(unreachable);
        },
      ];
      let inFlight!: Promise<unknown>;
      await act(async () => {
        inFlight = result.current.refresh({ manual: false });
        await Promise.resolve();
      });
      // The poll is in flight, and the shell still has the failure to show
      // rather than dropping to "connecting" until the poll fails again.
      expect(result.current.transcriptError).toBe(unreachable);
      expect(result.current.sessionStateError).toBe(unreachable);
      expect(result.current.isRefreshing).toBe(false);
      expect(result.current.sessionStateRefreshing).toBe(false);
      expect(result.current.sessionStateAvailability).toBe("unavailable");

      await act(async () => {
        release();
        await inFlight;
      });
      expect(seen.failures.every((failure) => failure === unreachable)).toBe(true);
      expect(seen.refreshing.every((value) => !value)).toBe(true);
      expect(seen.stateRefreshing.every((value) => !value)).toBe(true);
    });

    test("a background retry that succeeds clears the failure", async () => {
      const { result } = await renderFailedSession();
      transcriptUpdates = [() => transcriptSnapshot("transcript-2", [{ id: "m1", text: "one" }])];
      stateUpdates = [() => stateSnapshot("state-2")];
      await act(async () => {
        await result.current.refresh({ manual: false });
      });
      expect(result.current.transcriptError).toBeNull();
      expect(result.current.sessionStateError).toBeNull();
      expect(result.current.sessionStateAvailability).toBe("current");
    });

    test("a new transcript generation keeps recovery pending until session state arrives", async () => {
      const { result, seen } = await renderFailedSession();
      const nextIdentity = { ...identity, sourceGeneration: "generation-2" };
      const transcript = Promise.withResolvers<NativeAgentTranscriptUpdate<TestMessage>>();
      const state = Promise.withResolvers<NativeAgentSessionStateUpdate>();
      transcriptUpdates = [() => transcript.promise];
      stateUpdates = [() => state.promise];
      let inFlight!: Promise<unknown>;
      try {
        await act(async () => {
          inFlight = result.current.refresh({ manual: false });
        });
        expect(result.current.transcriptError).toBe(unreachable);
        expect(result.current.sessionStateError).toBe(unreachable);
        expect(result.current.isRefreshing).toBe(false);
        await act(async () => {
          transcript.resolve(
            transcriptSnapshot("transcript-2", [{ id: "m2", text: "two" }], nextIdentity),
          );
        });
        expect(result.current.projection?.generation).toBe(nextIdentity.sourceGeneration);
        expect(result.current.hasCompletedRead).toBe(true);
        expect(result.current.sessionStateAvailability).toBe("unavailable");
        expect(result.current.transcriptError).toBeNull();
        expect(result.current.sessionStateError).toBeNull();
        expect(result.current.isRefreshing).toBe(true);
      } finally {
        await act(async () => {
          state.resolve(stateSnapshot("state-2", nextIdentity));
          await inFlight;
        });
      }
      expect(seen.genericFailures).not.toContain(true);
      expect(result.current.isRefreshing).toBe(false);
      expect(result.current.sessionStateAvailability).toBe("current");
      expect(result.current.projection?.connection).toBe("connected");
    });

    test("a second unusable delta clears the retained transcript failure and stops retrying", async () => {
      const { result } = await renderFailedSession();
      const staleDelta = {
        viewVersion: 1,
        status: "delta",
        baseToken: "wrong-base",
        token: "transcript-2",
        identity,
        delta: {
          messageUpserts: [{ id: "m2", text: "two" }],
          deletedMessageIds: [],
          freshness: "current",
          historyEpoch: "epoch-1",
          historyComplete: true,
        },
      } satisfies NativeAgentTranscriptUpdate<TestMessage>;
      const fallback = Promise.withResolvers<NativeAgentTranscriptUpdate<TestMessage>>();
      transcriptUpdates = [() => staleDelta, () => fallback.promise];
      stateUpdates = [() => stateSnapshot("state-2")];
      readTranscript.mockClear();
      let inFlight!: Promise<unknown>;
      try {
        await act(async () => {
          inFlight = result.current.refresh({ manual: false });
        });
        expect(readTranscript).toHaveBeenCalledTimes(2);
        expect(readTranscript.mock.calls[0]?.[0]).toMatchObject({ knownToken: "transcript-1" });
        expect(readTranscript.mock.calls[1]?.[0]).toMatchObject({ forceSnapshot: true });
        expect(result.current.transcriptError).toBe(unreachable);
      } finally {
        await act(async () => {
          fallback.resolve(staleDelta);
          await inFlight;
        });
      }
      expect(readTranscript).toHaveBeenCalledTimes(2);
      expect(result.current.transcriptError).toBeNull();
      expect(result.current.transcriptAvailability).toBe("cached");
      expect(result.current.transcriptRefreshing).toBe(false);
      expect(result.current.projection?.messages).toEqual([{ id: "m1", text: "one" }]);
      expect(result.current.sessionStateAvailability).toBe("current");
    });

    test("a background retry that finds the session gone clears the failure", async () => {
      const { result } = await renderFailedSession();
      transcriptUpdates = [() => ({ viewVersion: 1, status: "missing" })];
      stateUpdates = [() => ({ viewVersion: 1, status: "missing" })];
      await act(async () => {
        await result.current.refresh({ manual: false });
      });
      expect(result.current.transcriptError).toBeNull();
      expect(result.current.sessionStateError).toBeNull();
      expect(result.current.projection).toBeNull();
    });

    test("a manual retry still clears the failure while it runs", async () => {
      const { result } = await renderFailedSession();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      transcriptUpdates = [
        () => gate.then(() => transcriptSnapshot("transcript-2", [{ id: "m1", text: "one" }])),
      ];
      stateUpdates = [() => gate.then(() => stateSnapshot("state-2"))];
      let inFlight!: Promise<unknown>;
      await act(async () => {
        inFlight = result.current.refresh({ manual: true });
        await Promise.resolve();
      });
      expect(result.current.transcriptError).toBeNull();
      expect(result.current.sessionStateError).toBeNull();
      expect(result.current.isRefreshing).toBe(true);
      await act(async () => {
        release();
        await inFlight;
      });
      expect(result.current.isRefreshing).toBe(false);
      expect(result.current.sessionStateAvailability).toBe("current");
    });
  });
});
