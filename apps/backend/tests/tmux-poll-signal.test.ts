import { describe, expect, test } from "bun:test";
import type { CommandContext } from "../src/core/commands";
import type { StateSignalCredential } from "../src/core/agent-tools";
import {
  CLAUDE_STATE_POLL_INTERVAL_MS,
  CLAUDE_STATE_SAFETY_READ_INTERVAL_MS,
  CLAUDE_STATE_SIGNAL_MAX_RINGS_PER_MINUTE,
  CLAUDE_STATE_SIGNAL_RETRY_MS,
  ClaudeStatePollManager,
  type ClaudeStateSignalSupport,
} from "../src/core/tmux";
import { CLAUDE_STATE_ABSENT_MARKER } from "../src/core/tmux-poll";
import { RecurringWorkMetrics } from "../src/core/recurring-work-metrics";
import { ManualTime, deferred, flushMicrotasks } from "../src/core/recurring-test-support";
import { createEnvironment } from "./tmux-test-harness.js";

const CONTAINER = "container-signal";

type IssuedSignal = {
  credential: StateSignalCredential;
  onSignal: () => void;
  revoked: boolean;
};

function createSignalHarness(
  options: {
    support?: ClaudeStateSignalSupport[];
    /** Whether the install's probe ring reaches the backend. */
    probeRings?: boolean;
    install?: (credential: StateSignalCredential, isCurrent: () => boolean) => Promise<void>;
    legacy?: boolean;
    /** No state file yet: terminal Claude has never run in the container. */
    absent?: boolean;
    rejectPersistence?: () => boolean;
    readGate?: () => Promise<void> | undefined;
  } = {},
) {
  const time = new ManualTime(1_000_000);
  const environment = createEnvironment("/worktree", "env-signal");
  environment.containerId = CONTAINER;
  let fileState = options.absent ? CLAUDE_STATE_ABSENT_MARKER : "waiting";
  let revision = 0;
  let completions = 0;
  const completed: string[] = [];
  const completionRecords: string[] = [];
  const probes: string[] = [];
  environment.prRecheckAfterAgentCompletionArmedAt = new Date(0).toISOString();
  const reads: number[] = [];
  const intervals: number[] = [];
  const emitted: Array<{ event: string; state: unknown }> = [];
  const issued: IssuedSignal[] = [];
  const supportAnswers = [...(options.support ?? ["supported"])];
  let supportCalls = 0;
  let installs = 0;

  /** What the agent tools server does on a POST: ring an unrevoked credential. */
  const ringServer = (signal: IssuedSignal | undefined = issued.at(-1)): boolean => {
    if (!signal || signal.revoked) return false;
    signal.onSignal();
    return true;
  };

  const context = {
    storage: {
      loadEnvironments: async () => [environment],
      recordEnvironmentSessionCompletion: async (id: string) => {
        completionRecords.push(id);
        return environment;
      },
      setEnvironmentAgentActivity: async (
        _environmentId: string,
        state: "idle" | "working" | "waiting",
        occurredAt: string,
      ) =>
        options.rejectPersistence?.()
          ? undefined
          : {
              ...environment,
              agentActivitySources: { "claude-terminal": { state, updatedAt: occurredAt } },
            },
    },
    emit: (event: string, payload: { state: unknown }) =>
      emitted.push({ event, state: payload.state }),
    agentTools: {
      issueStateSignal: (onSignal: () => void) => {
        const signal: IssuedSignal = {
          credential: {
            url: "http://host.docker.internal:1/claude-state-signal",
            token: `token-${issued.length}`,
            revoke: () => {
              signal.revoked = true;
            },
          },
          onSignal,
          revoked: false,
        };
        issued.push(signal);
        return signal.credential;
      },
    },
    notifyAgentTurnCompleted: async (id: string) => {
      completed.push(id);
    },
    probeAgentCreatedPullRequest: async (id: string) => {
      probes.push(id);
    },
    appRoot: "",
    resourceRoot: "",
  } as unknown as CommandContext;

  const manager = new ClaudeStatePollManager({
    readState: async () => {
      reads.push(time.now());
      const value =
        options.legacy || fileState === "" || fileState === CLAUDE_STATE_ABSENT_MARKER
          ? fileState
          : `${fileState} ${revision} ${completions}`;
      await options.readGate?.();
      return value;
    },
    schedule: (callback, intervalMs) => {
      intervals.push(intervalMs);
      return time.setInterval(callback, intervalMs);
    },
    cancel: (timer) => time.clear(timer),
    now: () => new Date(time.now()).toISOString(),
    nowMs: time.now,
    metrics: new RecurringWorkMetrics({ now: time.now }),
    signal: {
      support: async () => {
        supportCalls += 1;
        return supportAnswers.length > 1 ? supportAnswers.shift()! : supportAnswers[0]!;
      },
      install: async (_containerId, credential, _context, isCurrent) => {
        installs += 1;
        await options.install?.(credential, isCurrent);
        if (options.probeRings ?? true)
          ringServer(issued.find((signal) => signal.credential === credential));
      },
    },
  });

  return {
    time,
    completed,
    completionRecords,
    probes,
    manager,
    context,
    reads,
    intervals,
    emitted,
    issued,
    ringServer,
    start: async () => {
      manager.start(CONTAINER, context);
      await flushMicrotasks();
    },
    /** The hook: write the file, then (optionally) ring. */
    hook: (state: string, ring = true) => {
      if (state !== "") {
        revision += 1;
        if (fileState === "working" && state === "waiting") completions += 1;
      }
      fileState = state;
      if (ring) ringServer();
    },
    supportCalls: () => supportCalls,
    installs: () => installs,
    currentInterval: () => intervals.at(-1),
  };
}

describe("Claude state signal", () => {
  test("recovers a whole turn with both rings lost and runs completion work once", async () => {
    const harness = createSignalHarness();
    await harness.start();
    harness.completed.length = 0; // The durable armed intent is honoured at cold start.
    harness.hook("working", false);
    harness.hook("waiting", false);
    await harness.time.advance(CLAUDE_STATE_SAFETY_READ_INTERVAL_MS);
    expect(harness.completed).toEqual(["env-signal"]);
    expect(harness.probes).toEqual(["env-signal"]);
    expect(harness.completionRecords).toEqual(["env-signal"]);
    expect(harness.issued[0]!.revoked).toBe(true);
    await harness.time.advance(CLAUDE_STATE_SAFETY_READ_INTERVAL_MS);
    expect(harness.completed).toHaveLength(1);
    expect(harness.probes).toHaveLength(1);
    expect(harness.completionRecords).toHaveLength(1);
    harness.manager.shutdown(CONTAINER);
  });

  for (const failure of ["unknown", "rejected", "thrown"] as const) {
    test(`retries a ${failure} ring observation promptly without demoting its credential`, async () => {
      let reject = false;
      const harness = createSignalHarness({
        rejectPersistence: () => {
          if (reject && failure === "thrown") throw new Error("storage unavailable");
          return reject;
        },
      });
      await harness.start();
      reject = failure !== "unknown";
      harness.hook(failure === "unknown" ? "" : "working");
      await flushMicrotasks();
      expect(harness.currentInterval()).toBe(CLAUDE_STATE_POLL_INTERVAL_MS);
      reject = false;
      if (failure === "unknown") harness.hook("working", false);
      await harness.time.advance(CLAUDE_STATE_POLL_INTERVAL_MS);
      expect(harness.emitted.at(-1)?.state).toBe("working");
      expect(harness.currentInterval()).toBe(CLAUDE_STATE_SAFETY_READ_INTERVAL_MS);
      await harness.time.advance(CLAUDE_STATE_SAFETY_READ_INTERVAL_MS);
      expect(harness.issued[0]!.revoked).toBe(false);
      harness.manager.shutdown(CONTAINER);
    });
  }

  test("serializes installs across retirement and fences an old config publication", async () => {
    const gate = deferred<void>();
    let sharedToken: string | undefined;
    let calls = 0;
    const harness = createSignalHarness({
      install: async (credential, isCurrent) => {
        calls += 1;
        if (calls === 1) await gate.promise;
        if (isCurrent()) sharedToken = credential.token;
      },
    });
    await harness.start();
    const retired = harness.issued[0]!;
    harness.manager.shutdown(CONTAINER);
    await harness.start();
    expect(calls).toBe(1); // The successor cannot publish before the old writer settles.
    gate.resolve();
    await flushMicrotasks();
    expect(calls).toBe(2);
    expect(retired.revoked).toBe(true);
    expect(sharedToken).toBe(harness.issued[1]!.credential.token);
    expect(harness.ringServer()).toBe(true);
    expect(harness.currentInterval()).toBe(CLAUDE_STATE_SAFETY_READ_INTERVAL_MS);
    harness.manager.shutdown(CONTAINER);
  });

  test("a ring with a legacy snapshot cannot slow polling", async () => {
    const harness = createSignalHarness({ legacy: true });
    await harness.start();
    expect(harness.currentInterval()).toBe(CLAUDE_STATE_POLL_INTERVAL_MS);
    await harness.time.advance(3_000);
    expect(harness.reads.length).toBeGreaterThanOrEqual(4);
    harness.manager.shutdown(CONTAINER);
  });

  test("an image without the signal keeps the 1 s poll and is never asked again", async () => {
    const harness = createSignalHarness({ support: ["unsupported"] });
    await harness.start();
    await harness.time.advance(10_000);

    expect(harness.reads).toHaveLength(11);
    expect(harness.intervals).toEqual([CLAUDE_STATE_POLL_INTERVAL_MS]);
    expect(harness.issued).toHaveLength(0);

    await harness.time.advance(CLAUDE_STATE_SIGNAL_RETRY_MS);
    await harness.start();
    expect(harness.supportCalls()).toBe(1);
    expect(harness.installs()).toBe(0);
    expect(harness.manager.status()).toMatchObject({
      containers: 1,
      states: { unsupported: 1, confirmed: 0 },
      fallback: 1,
    });
    harness.manager.shutdown(CONTAINER);
  });

  test("an installed doorbell is not trusted until its probe ring arrives", async () => {
    const harness = createSignalHarness({ probeRings: false });
    await harness.start();
    expect(harness.installs()).toBe(1);
    expect(harness.manager.status().states).toMatchObject({ armed: 1, confirmed: 0 });
    await harness.time.advance(5_000);
    expect(harness.reads).toHaveLength(6);
    expect(harness.currentInterval()).toBe(CLAUDE_STATE_POLL_INTERVAL_MS);

    // The ring is read at once and moves the poll to the safety read.
    expect(harness.ringServer()).toBe(true);
    await flushMicrotasks();
    expect(harness.reads).toHaveLength(7);
    expect(harness.currentInterval()).toBe(CLAUDE_STATE_SAFETY_READ_INTERVAL_MS);
    await harness.time.advance(CLAUDE_STATE_SAFETY_READ_INTERVAL_MS - 1);
    expect(harness.reads).toHaveLength(7);
    await harness.time.advance(1);
    expect(harness.reads).toHaveLength(8);
    harness.manager.shutdown(CONTAINER);
  });

  test("reads on each doorbell and costs two reads a minute when idle", async () => {
    const harness = createSignalHarness();
    await harness.start();
    expect(harness.currentInterval()).toBe(CLAUDE_STATE_SAFETY_READ_INTERVAL_MS);
    expect(harness.emitted).toEqual([{ event: `claude-state-${CONTAINER}`, state: "waiting" }]);

    harness.hook("working");
    await flushMicrotasks();
    harness.hook("waiting");
    await flushMicrotasks();
    expect(harness.emitted.map((entry) => entry.state)).toEqual(["waiting", "working", "waiting"]);

    const before = harness.reads.length;
    await harness.time.advance(10 * 60_000);
    expect(harness.reads.length - before).toBe(20);
    expect(harness.currentInterval()).toBe(CLAUDE_STATE_SAFETY_READ_INTERVAL_MS);
    harness.manager.shutdown(CONTAINER);
  });

  test("a change only the safety read finds demotes to the 1 s poll until the retry window", async () => {
    const harness = createSignalHarness();
    await harness.start();
    const first = harness.issued[0]!;

    harness.hook("working", false);
    await harness.time.advance(CLAUDE_STATE_SAFETY_READ_INTERVAL_MS);
    // Still surfaced, from the safety read.
    expect(harness.emitted.map((entry) => entry.state)).toEqual(["waiting", "working"]);
    expect(harness.currentInterval()).toBe(CLAUDE_STATE_POLL_INTERVAL_MS);
    expect(first.revoked).toBe(true);
    expect(harness.ringServer(first)).toBe(false);
    // Visible in diagnostics, not only in a log line.
    expect(harness.manager.status()).toMatchObject({
      containers: 1,
      states: { demoted: 1, confirmed: 0 },
      fallback: 1,
      demotions: { "missed-change": 1 },
    });

    // Reconciliation inside the window does not re-arm.
    await harness.start();
    expect(harness.issued).toHaveLength(1);

    await harness.time.advance(CLAUDE_STATE_SIGNAL_RETRY_MS);
    await harness.start();
    expect(harness.issued).toHaveLength(2);
    expect(harness.currentInterval()).toBe(CLAUDE_STATE_SAFETY_READ_INTERVAL_MS);
    expect(harness.manager.status()).toMatchObject({
      states: { demoted: 0, confirmed: 1 },
      fallback: 0,
      demotions: { "missed-change": 1 },
    });
    harness.manager.shutdown(CONTAINER);
    expect(harness.manager.status().containers).toBe(0);
  });

  test("a doorbell during a read that ran before the write still announces it", async () => {
    let gate: ReturnType<typeof deferred<void>> | undefined;
    const harness = createSignalHarness({ readGate: () => gate?.promise });
    await harness.start();

    gate = deferred<void>();
    await harness.time.advance(CLAUDE_STATE_SAFETY_READ_INTERVAL_MS);
    // The safety read has taken the old value; the hook writes and rings now.
    harness.hook("working");
    const pending = gate;
    gate = undefined;
    pending.resolve();
    await flushMicrotasks();

    expect(harness.emitted.map((entry) => entry.state)).toEqual(["waiting", "working"]);
    expect(harness.currentInterval()).toBe(CLAUDE_STATE_SAFETY_READ_INTERVAL_MS);
    expect(harness.issued[0]!.revoked).toBe(false);
    harness.manager.shutdown(CONTAINER);
  });

  test("shutdown revokes the credential and a racing ring reads nothing", async () => {
    const harness = createSignalHarness();
    await harness.start();
    const signal = harness.issued[0]!;
    harness.manager.shutdown(CONTAINER);
    expect(signal.revoked).toBe(true);

    const reads = harness.reads.length;
    signal.onSignal();
    await flushMicrotasks();
    expect(harness.reads).toHaveLength(reads);
    expect(harness.time.pendingTimers).toBe(0);
  });

  test("a failed install revokes its credential and retries after the window", async () => {
    let fail = true;
    const harness = createSignalHarness({
      install: async () => {
        if (fail) throw new Error("docker exec failed");
      },
    });
    await harness.start();
    expect(harness.issued[0]!.revoked).toBe(true);
    expect(harness.currentInterval()).toBe(CLAUDE_STATE_POLL_INTERVAL_MS);
    expect(harness.manager.status()).toMatchObject({
      states: { demoted: 1 },
      demotions: { "arm-failed": 1 },
    });

    fail = false;
    await harness.time.advance(CLAUDE_STATE_SIGNAL_RETRY_MS - 1_000);
    await harness.start();
    expect(harness.installs()).toBe(1);
    await harness.time.advance(1_000);
    await harness.start();
    expect(harness.installs()).toBe(2);
    expect(harness.currentInterval()).toBe(CLAUDE_STATE_SAFETY_READ_INTERVAL_MS);
    harness.manager.shutdown(CONTAINER);
  });

  test("an unreadable image manifest is asked again after the window", async () => {
    const harness = createSignalHarness({ support: ["unknown", "supported"] });
    await harness.start();
    expect(harness.issued).toHaveLength(0);
    await harness.time.advance(CLAUDE_STATE_SIGNAL_RETRY_MS);
    await harness.start();
    expect(harness.supportCalls()).toBe(2);
    expect(harness.currentInterval()).toBe(CLAUDE_STATE_SAFETY_READ_INTERVAL_MS);
    harness.manager.shutdown(CONTAINER);
  });

  test("a container that rings too often falls back to the 1 s poll", async () => {
    const harness = createSignalHarness();
    await harness.start();
    const signal = harness.issued[0]!;
    // The probe ring opened the window; a minute later it starts afresh.
    await harness.time.advance(60_000);
    const reads = harness.reads.length;
    for (let ring = 0; ring < CLAUDE_STATE_SIGNAL_MAX_RINGS_PER_MINUTE; ring += 1) {
      expect(harness.ringServer(signal)).toBe(true);
      await flushMicrotasks();
    }
    expect(harness.reads).toHaveLength(reads + CLAUDE_STATE_SIGNAL_MAX_RINGS_PER_MINUTE);
    expect(harness.currentInterval()).toBe(CLAUDE_STATE_SAFETY_READ_INTERVAL_MS);

    expect(harness.ringServer(signal)).toBe(true);
    await flushMicrotasks();
    expect(signal.revoked).toBe(true);
    expect(harness.reads).toHaveLength(reads + CLAUDE_STATE_SIGNAL_MAX_RINGS_PER_MINUTE);
    expect(harness.currentInterval()).toBe(CLAUDE_STATE_POLL_INTERVAL_MS);
    // The server now refuses the credential, so a flood costs no read.
    expect(harness.ringServer(signal)).toBe(false);
    expect(harness.manager.status().demotions).toEqual({ "rang-too-often": 1 });
    harness.manager.shutdown(CONTAINER);
  });

  test("a container that never ran terminal Claude costs only the safety read", async () => {
    const harness = createSignalHarness({ absent: true });
    await harness.start();
    // The probe ring confirmed the doorbell; no state file is an answer.
    expect(harness.currentInterval()).toBe(CLAUDE_STATE_SAFETY_READ_INTERVAL_MS);
    const before = harness.reads.length;
    await harness.time.advance(10 * 60_000);
    expect(harness.reads.length - before).toBe(20);
    expect(harness.emitted).toEqual([]);
    expect(harness.manager.status()).toMatchObject({ states: { confirmed: 1 }, fallback: 0 });

    // The first hook is read and shown at once.
    harness.hook("working");
    await flushMicrotasks();
    expect(harness.emitted).toEqual([{ event: `claude-state-${CONTAINER}`, state: "working" }]);
    harness.hook("waiting");
    await flushMicrotasks();
    expect(harness.emitted.map((entry) => entry.state)).toEqual(["working", "waiting"]);
    expect(harness.currentInterval()).toBe(CLAUDE_STATE_SAFETY_READ_INTERVAL_MS);
    harness.manager.shutdown(CONTAINER);
  });

  test("a whole first turn with both rings lost is still recovered from the counters", async () => {
    const harness = createSignalHarness({ absent: true });
    await harness.start();
    harness.completionRecords.length = 0;
    harness.hook("working", false);
    harness.hook("waiting", false);
    await harness.time.advance(CLAUDE_STATE_SAFETY_READ_INTERVAL_MS);
    expect(harness.emitted.map((entry) => entry.state)).toEqual(["waiting"]);
    expect(harness.probes).toEqual(["env-signal"]);
    expect(harness.completionRecords).toEqual(["env-signal"]);
    harness.manager.shutdown(CONTAINER);
  });

  test("without the doorbell an absent state file keeps the 1 s poll", async () => {
    const harness = createSignalHarness({ absent: true, support: ["unsupported"] });
    await harness.start();
    await harness.time.advance(10_000);
    expect(harness.intervals).toEqual([CLAUDE_STATE_POLL_INTERVAL_MS]);
    expect(harness.reads).toHaveLength(11);
    harness.manager.shutdown(CONTAINER);
  });

  test("a context without the doorbell keeps the 1 s poll", async () => {
    const harness = createSignalHarness();
    const context = { ...harness.context, agentTools: undefined } as unknown as CommandContext;
    harness.manager.start(CONTAINER, context);
    await harness.time.advance(3_000);
    expect(harness.supportCalls()).toBe(0);
    expect(harness.intervals).toEqual([CLAUDE_STATE_POLL_INTERVAL_MS]);
    expect(harness.manager.status().states.unarmed).toBe(1);
    harness.manager.shutdown(CONTAINER);
  });
});
