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
    install?: () => Promise<void>;
    readGate?: () => Promise<void> | undefined;
  } = {},
) {
  const time = new ManualTime(1_000_000);
  const environment = createEnvironment("/worktree", "env-signal");
  environment.containerId = CONTAINER;
  let fileState = "waiting";
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
      setEnvironmentAgentActivity: async (
        _environmentId: string,
        state: "idle" | "working" | "waiting",
        occurredAt: string,
      ) => ({
        ...environment,
        agentActivitySources: { "claude-terminal": { state, updatedAt: occurredAt } },
      }),
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
    appRoot: "",
    resourceRoot: "",
  } as unknown as CommandContext;

  const manager = new ClaudeStatePollManager({
    readState: async () => {
      reads.push(time.now());
      const value = fileState;
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
      install: async () => {
        installs += 1;
        await options.install?.();
        if (options.probeRings ?? true) ringServer();
      },
    },
  });

  return {
    time,
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
      fileState = state;
      if (ring) ringServer();
    },
    supportCalls: () => supportCalls,
    installs: () => installs,
    currentInterval: () => intervals.at(-1),
  };
}

describe("Claude state signal", () => {
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
    harness.manager.shutdown(CONTAINER);
  });

  test("an installed doorbell is not trusted until its probe ring arrives", async () => {
    const harness = createSignalHarness({ probeRings: false });
    await harness.start();
    expect(harness.installs()).toBe(1);
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

    // Reconciliation inside the window does not re-arm.
    await harness.start();
    expect(harness.issued).toHaveLength(1);

    await harness.time.advance(CLAUDE_STATE_SIGNAL_RETRY_MS);
    await harness.start();
    expect(harness.issued).toHaveLength(2);
    expect(harness.currentInterval()).toBe(CLAUDE_STATE_SAFETY_READ_INTERVAL_MS);
    harness.manager.shutdown(CONTAINER);
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
    harness.manager.shutdown(CONTAINER);
  });

  test("a context without the doorbell keeps the 1 s poll", async () => {
    const harness = createSignalHarness();
    const context = { ...harness.context, agentTools: undefined } as unknown as CommandContext;
    harness.manager.start(CONTAINER, context);
    await harness.time.advance(3_000);
    expect(harness.supportCalls()).toBe(0);
    expect(harness.intervals).toEqual([CLAUDE_STATE_POLL_INTERVAL_MS]);
    harness.manager.shutdown(CONTAINER);
  });
});
