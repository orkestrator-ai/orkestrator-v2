import { describe, expect, mock, test } from "bun:test";
import path from "node:path";
import type { CommandContext } from "../../../apps/backend/src/core/commands";
import type { Environment } from "../../../apps/backend/src/core/models";
import {
  CLAUDE_STATE_POLL_INTERVAL_MS,
  CLAUDE_STATE_READ_TIMEOUT_MS,
  ClaudeStatePollManager,
  claudeStateReadCommand,
  LIVENESS_CHECK_EVERY_TICKS,
  parsePollSnapshotExecOutput,
  parsePollSnapshotOutput,
  pollSnapshotScript,
  shutdownClaudeStatePolling,
} from "../../../apps/backend/src/core/tmux";
import { setTimeout as delay } from "node:timers/promises";

import { createEnvironment, deferred, waitFor } from "./tmux-test-harness.js";

describe("ClaudeStatePollManager", () => {
  function createPollHarness(
    options: {
      states?: string[];
      readState?: (containerId: string) => Promise<string>;
      environments?: Environment[];
      loadEnvironments?: () => Promise<Environment[]>;
      nowMs?: () => number;
      persist?: (
        environmentId: string,
        state: "idle" | "working" | "waiting",
        occurredAt: string,
        source: "frontend" | "claude-terminal",
      ) => Promise<Environment>;
    } = {},
  ) {
    const scheduled: Array<() => void> = [];
    const cancelled = new Set<unknown>();
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const persisted: Array<{
      environmentId: string;
      state: string;
      occurredAt: string;
      source: string;
    }> = [];
    const states = [...(options.states ?? [])];
    const environment = createEnvironment("/worktree", "env-poll");
    environment.containerId = "container-poll";
    const environments = options.environments ?? [environment];
    const fixedNow = "2026-07-27T12:00:00.000Z";
    const context = {
      storage: {
        loadEnvironments: options.loadEnvironments ?? (async () => environments),
        setEnvironmentAgentActivity: async (
          environmentId: string,
          state: "idle" | "working" | "waiting",
          occurredAt: string,
          source: "frontend" | "claude-terminal",
        ) => {
          persisted.push({ environmentId, state, occurredAt, source });
          if (options.persist) {
            return options.persist(environmentId, state, occurredAt, source);
          }
          return {
            ...environment,
            agentActivityState: state,
            agentActivityUpdatedAt: "2026-07-27T12:00:00.001Z",
            agentActivitySources: {
              "claude-terminal": {
                state,
                updatedAt: occurredAt,
              },
            },
          };
        },
      },
      emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
      appRoot: "",
      resourceRoot: "",
    } as unknown as CommandContext;
    const manager = new ClaudeStatePollManager({
      readState: options.readState ?? (async () => states.shift() ?? ""),
      schedule: (callback) => {
        scheduled.push(callback);
        return callback;
      },
      cancel: (timer) => {
        cancelled.add(timer);
      },
      now: () => fixedNow,
      nowMs: options.nowMs,
    });
    return {
      manager,
      context,
      scheduled,
      cancelled,
      emitted,
      persisted,
      environment,
    };
  }

  test("persists a changed terminal state before emitting its authoritative timestamp", async () => {
    const harness = createPollHarness({ states: ["working", "working"] });

    harness.manager.start("container-poll", harness.context);
    await waitFor(() => harness.emitted.length === 1);

    expect(harness.persisted).toEqual([
      {
        environmentId: "env-poll",
        state: "working",
        occurredAt: "2026-07-27T12:00:00.000Z",
        source: "claude-terminal",
      },
    ]);
    expect(harness.emitted).toEqual([
      {
        event: "claude-state-container-poll",
        payload: {
          container_id: "container-poll",
          state: "working",
          occurred_at: "2026-07-27T12:00:00.000Z",
        },
      },
    ]);

    harness.scheduled[0]!();
    await delay(0);
    expect(harness.persisted).toHaveLength(1);
    expect(harness.emitted).toHaveLength(1);
    harness.manager.shutdown("container-poll");
  });

  test("notifies backend reconciliation for production working-to-waiting completion", async () => {
    const harness = createPollHarness({ states: ["working", "waiting", "idle"] });
    harness.environment.prRecheckAfterAgentCompletionArmedAt = "2026-08-01T12:00:00.000Z";
    const notifyAgentTurnCompleted = mock(async () => undefined);
    harness.context.notifyAgentTurnCompleted = notifyAgentTurnCompleted;

    harness.manager.start("container-poll", harness.context);
    await waitFor(() => harness.emitted.length === 1);
    harness.scheduled[0]!();
    await waitFor(() => notifyAgentTurnCompleted.mock.calls.length === 1);

    expect(notifyAgentTurnCompleted).toHaveBeenCalledWith("env-poll");
    harness.scheduled[0]!();
    await waitFor(() => harness.emitted.length === 3);
    expect(notifyAgentTurnCompleted).toHaveBeenCalledTimes(1);
    harness.manager.shutdown("container-poll");
  });

  test("notifies backend reconciliation for an armed working-to-idle recovery", async () => {
    const harness = createPollHarness({ states: ["working", "idle"] });
    harness.environment.prRecheckAfterAgentCompletionArmedAt = "2026-08-01T12:00:00.000Z";
    const notifyAgentTurnCompleted = mock(async () => undefined);
    harness.context.notifyAgentTurnCompleted = notifyAgentTurnCompleted;

    harness.manager.start("container-poll", harness.context);
    await waitFor(() => harness.emitted.length === 1);
    harness.scheduled[0]!();
    await waitFor(() => notifyAgentTurnCompleted.mock.calls.length === 1);

    expect(notifyAgentTurnCompleted).toHaveBeenCalledWith("env-poll");
    harness.manager.shutdown("container-poll");
  });

  test("recovers an initially waiting or idle armed turn without notifying for an unarmed poll", async () => {
    for (const initialState of ["waiting", "idle"] as const) {
      const armed = createPollHarness({ states: [initialState] });
      armed.environment.prRecheckAfterAgentCompletionArmedAt = "2026-08-01T12:00:00.000Z";
      const armedNotification = mock(async () => undefined);
      armed.context.notifyAgentTurnCompleted = armedNotification;

      armed.manager.start("container-poll", armed.context);
      await waitFor(() => armedNotification.mock.calls.length === 1);
      expect(armedNotification).toHaveBeenCalledWith("env-poll");
      armed.manager.shutdown("container-poll");
    }

    const unarmed = createPollHarness({ states: ["working", "waiting", "idle"] });
    const unarmedNotification = mock(async () => undefined);
    unarmed.context.notifyAgentTurnCompleted = unarmedNotification;
    unarmed.manager.start("container-poll", unarmed.context);
    await waitFor(() => unarmed.emitted.length === 1);
    for (let expectedEmits = 2; expectedEmits <= 3; expectedEmits += 1) {
      unarmed.scheduled[0]!();
      await waitFor(() => unarmed.emitted.length === expectedEmits);
    }
    expect(unarmedNotification).not.toHaveBeenCalled();
    unarmed.manager.shutdown("container-poll");
  });

  test("probes for an agent-created PR on an unarmed terminal turn end", async () => {
    // The regression this whole path exists for: nothing is armed and no PR is
    // stored, so the monitor is not polling this environment at all. A Claude
    // tmux agent that ran `gh pr create` itself would otherwise never be seen.
    for (const endState of ["waiting", "idle"] as const) {
      const harness = createPollHarness({ states: ["working", endState] });
      const probe = mock(async () => undefined);
      const notifyAgentTurnCompleted = mock(async () => undefined);
      harness.context.probeAgentCreatedPullRequest = probe;
      harness.context.notifyAgentTurnCompleted = notifyAgentTurnCompleted;

      harness.manager.start("container-poll", harness.context);
      await waitFor(() => harness.emitted.length === 1);
      expect(probe).not.toHaveBeenCalled();

      harness.scheduled[0]!();
      await waitFor(() => probe.mock.calls.length === 1);
      expect(probe).toHaveBeenCalledWith("env-poll");
      // The armed-only notification is a separate concern and stays gated.
      expect(notifyAgentTurnCompleted).not.toHaveBeenCalled();
      harness.manager.shutdown("container-poll");
    }
  });

  test("probes once per ended terminal turn, never per poll", async () => {
    const harness = createPollHarness({
      states: ["working", "waiting", "waiting", "waiting", "working", "idle"],
    });
    const probe = mock(async () => undefined);
    harness.context.probeAgentCreatedPullRequest = probe;

    harness.manager.start("container-poll", harness.context);
    await waitFor(() => harness.emitted.length === 1);
    harness.scheduled[0]!();
    await waitFor(() => probe.mock.calls.length === 1);

    // This poll runs about once a second per container; re-reading the same
    // ended state is not a new turn and must not be a new `gh` call.
    for (let tick = 0; tick < 2; tick += 1) {
      harness.scheduled[0]!();
      await delay(0);
    }
    expect(probe).toHaveBeenCalledTimes(1);
    expect(harness.emitted).toHaveLength(2);

    // A new turn that ends is a new probe.
    harness.scheduled[0]!();
    await waitFor(() => harness.emitted.length === 3);
    harness.scheduled[0]!();
    await waitFor(() => probe.mock.calls.length === 2);
    harness.manager.shutdown("container-poll");
  });

  test("does not probe a first observation of an already-ended terminal state", async () => {
    // A poll that starts up and immediately reads `waiting` is looking at a turn
    // that ended before this backend existed. Probing it would be one `gh` call
    // per running Claude tmux container on every backend start.
    for (const initialState of ["waiting", "idle"] as const) {
      const harness = createPollHarness({ states: [initialState] });
      const probe = mock(async () => undefined);
      harness.context.probeAgentCreatedPullRequest = probe;

      harness.manager.start("container-poll", harness.context);
      await waitFor(() => harness.emitted.length === 1);
      await delay(0);
      expect(probe).not.toHaveBeenCalled();
      harness.manager.shutdown("container-poll");
    }
  });

  test("a failing PR probe neither stops the poll loop nor suppresses its state emit", async () => {
    const harness = createPollHarness({
      states: ["working", "waiting", "working", "waiting", "working", "waiting"],
    });
    let attempts = 0;
    const probe = mock((): Promise<void> => {
      attempts += 1;
      // A synchronous throw is the harsher case: it happens before any promise
      // exists to attach a rejection handler to.
      if (attempts === 1) throw new Error("probe unavailable");
      if (attempts === 2) return Promise.reject(new Error("probe rejected"));
      return Promise.resolve();
    });
    harness.context.probeAgentCreatedPullRequest = probe;

    harness.manager.start("container-poll", harness.context);
    await waitFor(() => harness.emitted.length === 1);
    for (let expectedEmits = 2; expectedEmits <= 6; expectedEmits += 1) {
      harness.scheduled[0]!();
      await waitFor(() => harness.emitted.length === expectedEmits);
    }

    await waitFor(() => probe.mock.calls.length === 3);
    expect(attempts).toBe(3);
    // The renderer still received every state frame, including the ones whose
    // probe failed.
    expect(harness.emitted.map(({ payload }) => (payload as { state: string }).state)).toEqual([
      "working",
      "waiting",
      "working",
      "waiting",
      "working",
      "waiting",
    ]);
    harness.manager.shutdown("container-poll");
  });

  test("continues polling after a terminal completion notification rejects", async () => {
    const harness = createPollHarness({ states: ["working", "waiting", "working", "waiting"] });
    harness.environment.prRecheckAfterAgentCompletionArmedAt = "2026-08-01T12:00:00.000Z";
    let attempts = 0;
    const notifyAgentTurnCompleted = mock(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary notification failure");
    });
    harness.context.notifyAgentTurnCompleted = notifyAgentTurnCompleted;

    harness.manager.start("container-poll", harness.context);
    await waitFor(() => harness.emitted.length === 1);
    for (let expectedEmits = 2; expectedEmits <= 4; expectedEmits += 1) {
      harness.scheduled[0]!();
      await waitFor(() => harness.emitted.length === expectedEmits);
    }

    await waitFor(() => notifyAgentTurnCompleted.mock.calls.length === 2);
    expect(attempts).toBe(2);
    harness.manager.shutdown("container-poll");
  });

  test("emits the terminal source token when another source owns the aggregate timestamp", async () => {
    let persistenceCount = 0;
    const harness = createPollHarness({
      states: ["working", "idle"],
      persist: async (_environmentId, state) => {
        const sourceUpdatedAt =
          persistenceCount++ === 0 ? "2026-07-27T12:00:00.000Z" : "2026-07-27T12:00:00.001Z";
        return {
          ...createEnvironment("/worktree", "env-poll"),
          containerId: "container-poll",
          agentActivityState: "working",
          agentActivityUpdatedAt: "2026-07-27T12:00:10.000Z",
          agentActivitySources: {
            frontend: {
              state: "working",
              updatedAt: "2026-07-27T12:00:10.000Z",
            },
            "claude-terminal": {
              state,
              updatedAt: sourceUpdatedAt,
            },
          },
        };
      },
    });

    harness.manager.start("container-poll", harness.context);
    await waitFor(() => harness.emitted.length === 1);
    harness.scheduled[0]!();
    await waitFor(() => harness.emitted.length === 2);

    expect(
      harness.emitted.map(({ payload }) => (payload as { occurred_at: string }).occurred_at),
    ).toEqual(["2026-07-27T12:00:00.000Z", "2026-07-27T12:00:00.001Z"]);
    harness.manager.shutdown("container-poll");
  });

  test("keeps one backend-owned poll across idempotent starts until reconciliation retires it", async () => {
    const harness = createPollHarness({
      states: ["working", "idle"],
    });

    harness.manager.start("container-poll", harness.context);
    harness.manager.start("container-poll", harness.context);
    await waitFor(() => harness.emitted.length === 1);

    expect(harness.cancelled.size).toBe(0);
    harness.scheduled[0]!();
    await waitFor(() => harness.emitted.length === 2);
    expect(harness.persisted.map((entry) => entry.state)).toEqual(["working", "idle"]);

    harness.environment.status = "stopped";
    await harness.manager.reconcile(harness.context);
    expect(harness.cancelled.size).toBe(1);
    harness.scheduled[0]!();
    await delay(0);
    expect(harness.persisted).toHaveLength(2);
  });

  test("serializes timer ticks and runs one trailing poll instead of overlapping reads", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const reads: Array<ReturnType<typeof deferred<string>>> = [first, second];
    let readCount = 0;
    const harness = createPollHarness({
      readState: async () => {
        const read = reads[readCount++];
        if (!read) return "";
        return read.promise;
      },
    });

    harness.manager.start("container-poll", harness.context);
    harness.scheduled[0]!();
    harness.scheduled[0]!();
    expect(readCount).toBe(1);

    first.resolve("working");
    await waitFor(() => readCount === 2);
    expect(harness.persisted.map((entry) => entry.state)).toEqual(["working"]);

    second.resolve("idle");
    await waitFor(() => harness.persisted.length === 2);
    expect(harness.persisted.map((entry) => entry.state)).toEqual(["working", "idle"]);
    harness.manager.shutdown("container-poll");
  });

  test("discards an in-flight read after backend shutdown", async () => {
    const state = deferred<string>();
    const harness = createPollHarness({
      readState: async () => state.promise,
    });

    harness.manager.start("container-poll", harness.context);
    harness.manager.shutdown("container-poll");
    state.resolve("working");
    await delay(0);

    expect(harness.persisted).toHaveLength(0);
    expect(harness.emitted).toHaveLength(0);
  });

  test("retries read and persistence failures without emitting stale state", async () => {
    let readCount = 0;
    let persistCount = 0;
    const harness = createPollHarness({
      readState: async () => {
        readCount += 1;
        if (readCount === 1) throw new Error("docker unavailable");
        return "waiting";
      },
      persist: async () => {
        persistCount += 1;
        if (persistCount === 1) throw new Error("disk unavailable");
        return {
          ...createEnvironment("/worktree", "env-poll"),
          containerId: "container-poll",
          agentActivityState: "waiting",
          agentActivityUpdatedAt: "2026-07-27T12:00:00.002Z",
          agentActivitySources: {
            "claude-terminal": {
              state: "waiting",
              updatedAt: "2026-07-27T12:00:00.002Z",
            },
          },
        };
      },
    });

    harness.manager.start("container-poll", harness.context);
    await delay(0);
    expect(harness.emitted).toHaveLength(0);

    harness.scheduled[0]!();
    await waitFor(() => persistCount === 1);
    expect(harness.emitted).toHaveLength(0);

    harness.scheduled[0]!();
    await waitFor(() => harness.emitted.length === 1);
    expect(persistCount).toBe(2);
    harness.manager.shutdown("container-poll");
  });

  test("ignores invalid states and retries an environment-load failure", async () => {
    let loadCount = 0;
    const environment = createEnvironment("/worktree", "env-poll");
    environment.containerId = "container-poll";
    const harness = createPollHarness({
      states: ["busy", "waiting", "waiting"],
      loadEnvironments: async () => {
        loadCount += 1;
        if (loadCount === 2) throw new Error("storage unavailable");
        return [environment];
      },
    });

    harness.manager.start("container-poll", harness.context);
    await delay(0);
    expect(loadCount).toBe(1);
    expect(harness.emitted).toHaveLength(0);

    harness.scheduled[0]!();
    await waitFor(() => loadCount === 2);
    expect(harness.persisted).toHaveLength(0);
    expect(harness.emitted).toHaveLength(0);

    harness.scheduled[0]!();
    await waitFor(() => harness.emitted.length === 1);
    expect(harness.persisted.map((entry) => entry.state)).toEqual(["waiting"]);
    harness.manager.shutdown("container-poll");
  });

  test("stops polling when no environment owns the container", async () => {
    const harness = createPollHarness({
      states: ["idle"],
      environments: [],
    });

    harness.manager.start("container-poll", harness.context);
    await waitFor(() => harness.cancelled.size === 1);

    expect(harness.persisted).toHaveLength(0);
    expect(harness.emitted).toHaveLength(0);
  });

  test("does not emit a state storage refused to record", async () => {
    // Storage rejects tokens older than the one it holds. Emitting anyway would
    // hand the renderer a state the backend does not believe, and advancing
    // lastState would mean the transition is never retried.
    let persistCount = 0;
    const harness = createPollHarness({
      states: ["working", "working", "working"],
      persist: async (_environmentId, state, occurredAt) => {
        persistCount += 1;
        return {
          ...createEnvironment("/worktree", "env-poll"),
          containerId: "container-poll",
          agentActivityState: "idle",
          agentActivityUpdatedAt: "2026-07-27T12:00:05.000Z",
          agentActivitySources:
            persistCount === 1
              ? // Rejected: storage kept its own newer observation for this source.
                {
                  "claude-terminal": {
                    state: "idle" as const,
                    updatedAt: "2026-07-27T12:00:05.000Z",
                  },
                }
              : // A response that lost the source entirely is equally unusable.
                persistCount === 2
                ? {}
                : {
                    "claude-terminal": { state, updatedAt: occurredAt },
                  },
        };
      },
    });

    harness.manager.start("container-poll", harness.context);
    await waitFor(() => persistCount === 1);
    expect(harness.emitted).toHaveLength(0);

    harness.scheduled[0]!();
    await waitFor(() => persistCount === 2);
    expect(harness.emitted).toHaveLength(0);

    // lastState was never advanced, so the same observation is retried and
    // lands as soon as storage accepts it.
    harness.scheduled[0]!();
    await waitFor(() => harness.emitted.length === 1);
    expect(persistCount).toBe(3);
    expect(harness.emitted[0]).toMatchObject({
      payload: { state: "working" },
    });
    harness.manager.shutdown("container-poll");
  });

  test("keeps polling when backend reconciliation cannot read environments", async () => {
    // Storage being unreadable is not evidence that the container stopped.
    const harness = createPollHarness({
      states: ["working"],
      loadEnvironments: async () => {
        throw new Error("storage unavailable");
      },
    });

    harness.manager.start("container-poll", harness.context);
    await expect(harness.manager.reconcile(harness.context)).rejects.toThrow("storage unavailable");
    expect(harness.cancelled.size).toBe(0);
    harness.manager.shutdown("container-poll");
  });

  test("shutting down an unknown container is a no-op", () => {
    const harness = createPollHarness();
    expect(() => harness.manager.shutdown("container-never-started")).not.toThrow();
    expect(harness.cancelled.size).toBe(0);
  });

  test("adopts the newest caller's context for a poll already running", async () => {
    // The first registrant's connection may be gone by the time a later state
    // change is emitted; a later registrant's is at least as live.
    const harness = createPollHarness({ states: ["working"] });
    const secondEmitted: Array<{ event: string; payload: unknown }> = [];
    const secondContext = {
      ...harness.context,
      emit: (event: string, payload: unknown) => secondEmitted.push({ event, payload }),
    } as unknown as CommandContext;

    harness.manager.start("container-poll", harness.context);
    harness.manager.start("container-poll", secondContext);
    await waitFor(() => secondEmitted.length === 1);

    expect(harness.emitted).toHaveLength(0);
    expect(secondEmitted[0]).toMatchObject({
      event: "claude-state-container-poll",
      payload: { state: "working" },
    });
    harness.manager.shutdown("container-poll");
  });

  test("retires a poll for a still-running environment when the container goes away", async () => {
    // stop_environment / delete_environment call this: the next read would exec
    // into a container that is already being torn down.
    const harness = createPollHarness({ states: ["working", "idle"] });

    harness.manager.start("container-poll", harness.context);
    await waitFor(() => harness.emitted.length === 1);
    expect(harness.environment.status).toBe("running");

    harness.manager.shutdown("container-poll");
    expect(harness.cancelled.size).toBe(1);

    harness.scheduled[0]!();
    await delay(0);
    expect(harness.persisted).toHaveLength(1);
    expect(harness.emitted).toHaveLength(1);

    // Shutting down an already-retired poll is safe.
    expect(() => harness.manager.shutdown("container-poll")).not.toThrow();
  });

  test("coalesces any number of ticks behind one in-flight read into a single trailing poll", async () => {
    const reads: Array<ReturnType<typeof deferred<string>>> = [];
    const harness = createPollHarness({
      readState: async () => {
        const read = deferred<string>();
        reads.push(read);
        return read.promise;
      },
    });

    harness.manager.start("container-poll", harness.context);
    for (let tick = 0; tick < 5; tick += 1) harness.scheduled[0]!();
    expect(reads).toHaveLength(1);

    reads[0]!.resolve("working");
    await waitFor(() => reads.length === 2);
    // Five queued ticks collapse to exactly one trailing read, not five.
    expect(reads).toHaveLength(2);

    reads[1]!.resolve("idle");
    await waitFor(() => harness.persisted.length === 2);
    expect(reads).toHaveLength(2);
    harness.manager.shutdown("container-poll");
  });

  test("reads no storage at all on a tick that observed no change", async () => {
    // The read is a full parse of the environments file, once per second per
    // running container. A tick whose state matches the last one has nothing to
    // persist and nothing to emit, so it must not pay for it.
    let loadCount = 0;
    let readCount = 0;
    const environment = createEnvironment("/worktree", "env-poll");
    environment.containerId = "container-poll";
    const harness = createPollHarness({
      readState: async () => {
        readCount += 1;
        return readCount >= 4 ? "idle" : "working";
      },
      loadEnvironments: async () => {
        loadCount += 1;
        return [environment];
      },
    });

    harness.manager.start("container-poll", harness.context);
    await waitFor(() => harness.emitted.length === 1);
    // The first tick is a change, and it also establishes that the environment
    // is running.
    expect(loadCount).toBe(1);

    for (const expectedReads of [2, 3]) {
      harness.scheduled[0]!();
      await waitFor(() => readCount === expectedReads);
      await delay(5);
      expect(loadCount).toBe(1);
      expect(harness.emitted).toHaveLength(1);
    }

    // A real transition still consults storage immediately.
    harness.scheduled[0]!();
    await waitFor(() => harness.emitted.length === 2);
    expect(loadCount).toBe(2);
    expect(harness.persisted.map((entry) => entry.state)).toEqual(["working", "idle"]);
    harness.manager.shutdown("container-poll");
  });

  test("rechecks and retires an unchanged poll after fifteen seconds", async () => {
    let currentMs = 10_000;
    let loadCount = 0;
    const environment = createEnvironment("/worktree", "env-poll");
    environment.containerId = "container-poll";
    const harness = createPollHarness({
      readState: async () => "working",
      nowMs: () => currentMs,
      loadEnvironments: async () => {
        loadCount += 1;
        return [environment];
      },
    });

    harness.manager.start("container-poll", harness.context);
    await waitFor(() => harness.emitted.length === 1);
    expect(loadCount).toBe(1);

    currentMs += 14_999;
    harness.scheduled[0]!();
    await delay(0);
    expect(loadCount).toBe(1);

    environment.status = "stopped";
    currentMs += 1;
    harness.scheduled[0]!();
    await waitFor(() => harness.cancelled.size === 1);
    expect(loadCount).toBe(2);
    expect(harness.persisted).toHaveLength(1);
  });

  test("still retires a poll whose container never reports a usable state", async () => {
    // The storage read the unchanged path skips is also the retirement check.
    // A container that answers with nothing at all never takes the changed
    // branch, so the first tick has to check anyway — otherwise a container
    // that is already gone would be polled forever with nothing to notice it.
    const harness = createPollHarness({
      readState: async () => "",
      environments: [],
    });

    harness.manager.start("container-poll", harness.context);
    await waitFor(() => harness.cancelled.size === 1);
    expect(harness.persisted).toHaveLength(0);
    expect(harness.emitted).toHaveLength(0);
  });

  test("reads container state with a bounded docker exec", () => {
    // Every test above injects readState, so without this the real argv and
    // timeout are unverified — and a typo there degrades to "always idle".
    expect(claudeStateReadCommand("container-abc")).toEqual({
      command: "docker",
      args: ["exec", "container-abc", "cat", "/tmp/.claude-state"],
      options: { timeoutMs: CLAUDE_STATE_READ_TIMEOUT_MS },
    });
    expect(CLAUDE_STATE_READ_TIMEOUT_MS).toBe(5_000);
    expect(CLAUDE_STATE_POLL_INTERVAL_MS).toBe(1_000);
  });

  test("drives itself on a real interval when no scheduler is injected", async () => {
    // Covers the default schedule/cancel wiring: a broken clearInterval here
    // would leak a docker exec per second for the life of the process.
    const environment = createEnvironment("/worktree", "env-default-timer");
    environment.containerId = "container-default-timer";
    let readCount = 0;
    const manager = new ClaudeStatePollManager({
      readState: async () => {
        readCount += 1;
        return "working";
      },
    });
    const emitted: unknown[] = [];
    const context = {
      storage: {
        loadEnvironments: async () => [environment],
        setEnvironmentAgentActivity: async (
          _environmentId: string,
          state: "idle" | "working" | "waiting",
          occurredAt: string,
        ) => ({
          ...environment,
          agentActivitySources: {
            "claude-terminal": { state, updatedAt: occurredAt },
          },
        }),
      },
      emit: (_event: string, payload: unknown) => emitted.push(payload),
      appRoot: "",
      resourceRoot: "",
    } as unknown as CommandContext;

    manager.start("container-default-timer", context);
    await waitFor(() => emitted.length === 1);
    await waitFor(() => readCount >= 2, CLAUDE_STATE_POLL_INTERVAL_MS * 4);

    manager.shutdown("container-default-timer");
    const readsAtShutdown = readCount;
    await delay(CLAUDE_STATE_POLL_INTERVAL_MS * 1.5);
    expect(readCount).toBe(readsAtShutdown);
  }, 10_000);

  test("the exported lifecycle shutdown is idempotent for an unknown container", () => {
    expect(() => shutdownClaudeStatePolling("container-never-started")).not.toThrow();
    expect(() => shutdownClaudeStatePolling("container-never-started")).not.toThrow();
  });
});

describe("poll snapshot", () => {
  const paths = { pendingDir: "/tmp/run/pending", timeoutDir: "/tmp/run/timeout" };

  test("asks for both hook listings and the transcript size in one script", () => {
    const script = pollSnapshotScript(paths.pendingDir, paths.timeoutDir, "/home/node/t.jsonl");
    expect(script).toContain(`ls -1 '${paths.pendingDir}'`);
    expect(script).toContain(`ls -1 '${paths.timeoutDir}'`);
    expect(script).toContain("stat -c %s '/home/node/t.jsonl'");
  });

  test("reports a zero size before the transcript has been discovered", () => {
    const script = pollSnapshotScript(paths.pendingDir, paths.timeoutDir, undefined);
    expect(script).not.toContain("stat -c %s");
    expect(parsePollSnapshotOutput("__ork_pending__\n__ork_timeout__\n__ork_size__\n0\n")).toEqual({
      pending: [],
      timeouts: [],
      transcriptSize: 0,
    });
  });

  test("partitions the combined output back into its three sections", () => {
    expect(
      parsePollSnapshotOutput(
        [
          "__ork_pending__",
          "PreToolUse-1.json",
          "Stop-2.json",
          "__ork_timeout__",
          "PermissionRequest-3.json",
          "__ork_size__",
          "4096",
          "",
        ].join("\n"),
      ),
    ).toEqual({
      pending: ["PreToolUse-1.json", "Stop-2.json"],
      timeouts: ["PermissionRequest-3.json"],
      transcriptSize: 4096,
    });
  });

  test("rejects malformed or incomplete output instead of inventing an empty snapshot", () => {
    expect(() =>
      parsePollSnapshotOutput("__ork_pending__\n__ork_timeout__\n__ork_size__\nnot-a-number\n"),
    ).toThrow("Malformed tmux poll snapshot transcript size");
    expect(() => parsePollSnapshotOutput("")).toThrow("Incomplete tmux poll snapshot");
    expect(() =>
      parsePollSnapshotOutput("__ork_pending__\n__ork_timeout__\n__ork_size__\n"),
    ).toThrow("Incomplete tmux poll snapshot");
  });

  test("rejects a failed combined poll before its empty stdout can reset a tail", () => {
    expect(() =>
      parsePollSnapshotExecOutput({
        status: 1,
        stdout: "",
        stderr: "docker exec failed",
      }),
    ).toThrow("docker exec failed");
  });

  test("checks liveness on a slower cadence than the hook and transcript reads", () => {
    // Every check is its own process spawn (a `docker exec` in container mode)
    // and can only report a session that has already ended.
    expect(LIVENESS_CHECK_EVERY_TICKS).toBe(8);
  });
});
