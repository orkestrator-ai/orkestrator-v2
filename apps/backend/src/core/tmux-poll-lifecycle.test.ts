import { expect, test } from "bun:test";
import type { CommandContext } from "./commands-context.js";
import type { Environment } from "./models.js";
import type { PtyProcess } from "./pty.js";
import { ContainerLifecycleReactor } from "./container-lifecycle-events.js";
import { ManualTime, flushMicrotasks } from "./recurring-test-support.js";
import { TerminalRuntime } from "./terminal-runtime.js";
import { CLAUDE_STATE_ABSENT_MARKER, ClaudeStatePollManager } from "./tmux-poll.js";
import { TmuxHookSignalManager } from "./tmux-hook-signal.js";

function harness(hooks = new TmuxHookSignalManager()) {
  const time = new ManualTime();
  let reads = 0;
  let lifecycle = false;
  let tabs = 0;
  const terminals = new TerminalRuntime();
  const environment = { id: "env", containerId: "abcdef123456", status: "running" } as Environment;
  const polls = new ClaudeStatePollManager({
    readState: async () => {
      reads += 1;
      return CLAUDE_STATE_ABSENT_MARKER;
    },
    schedule: (callback, ms) => time.setInterval(callback, ms),
    cancel: (timer) => time.clear(timer),
    nowMs: time.now,
  });
  const context = {
    storage: {
      getEnvironment: async () => environment,
      loadEnvironments: async () => [environment],
      readEnvironmentsSnapshot: async () => [environment],
    },
    runtime: {
      terminals,
      environments: {
        hasLifecycleWork: () => lifecycle,
        enqueueLifecycleOperation: async (_id: string, _tasks: unknown, run: () => Promise<void>) =>
          run(),
      },
      diffStats: {
        containerEnded: () => undefined,
        containerStarted: () => undefined,
        sync: async () => undefined,
      },
      prMonitor: {
        containerEnded: () => undefined,
        containerStarted: () => undefined,
        sync: async () => undefined,
      },
      tmux: {
        claudeStatePolls: polls,
        hookSignals: hooks,
        sessions: { sessionsInEnvironment: () => tabs, containerEnded: () => undefined },
      },
    },
  } as unknown as CommandContext;
  return {
    time,
    polls,
    hooks,
    terminals,
    context,
    environment,
    reads: () => reads,
    setTabs: (count: number) => {
      tabs = count;
    },
    setLifecycle: (value: boolean) => {
      lifecycle = value;
    },
  };
}

test("a real terminal registration restores fast reads without another reconcile", async () => {
  const h = harness();
  try {
    await h.polls.reconcile(h.context);
    await flushMicrotasks();
    await h.time.advance(2_000);
    expect(h.reads()).toBe(1);
    h.terminals.rememberSession("shell", {
      kind: "container",
      containerId: h.environment.containerId!,
      cols: 80,
      rows: 24,
    });
    h.terminals.registerProcess("shell", { kill: () => undefined } as unknown as PtyProcess);
    await h.time.advance(1_000);
    expect(h.reads()).toBe(2);
    await h.time.advance(2_000);
    expect(h.reads()).toBe(4);
  } finally {
    h.polls.shutdownAll();
  }
  expect(h.time.pendingTimers).toBe(0);
});

for (const active of [false, true]) {
  test(`end event inhibits reconciliation with stale running status (lifecycle=${active})`, async () => {
    const h = harness();
    const reactor = new ContainerLifecycleReactor(() => h.context, {
      syncStatus: async () => {
        throw new Error("inspect failed");
      },
    });
    try {
      await h.polls.reconcile(h.context);
      await flushMicrotasks();
      h.setLifecycle(active);
      reactor.handle(h.environment.containerId!, "die");
      await reactor.idle();
      await h.polls.reconcile(h.context);
      await h.time.advance(60_000);
      expect(h.reads()).toBe(1);
      expect(h.polls.status().containers).toBe(0);
      h.setLifecycle(false);
      reactor.handle(h.environment.containerId!, "start");
      await reactor.idle();
      await h.polls.reconcile(h.context);
      await flushMicrotasks();
      expect(h.polls.status().containers).toBe(1);
      expect(h.reads()).toBe(2);
    } finally {
      h.polls.shutdownAll();
    }
    expect(h.time.pendingTimers).toBe(0);
  });
}

test("replayed end/start lets a surviving tab rearm its original subscription", async () => {
  let onSignal: () => void = () => undefined;
  let wakes = 0;
  const hooks = new TmuxHookSignalManager({
    installer: {
      support: async () => "supported",
      install: async () => {
        onSignal();
      },
    },
  });
  const h = harness(hooks);
  h.context.agentTools = {
    issueTmuxHookSignal: (callback: () => void) => {
      onSignal = callback;
      return { url: "http://localhost/tmux-hook-signal", token: "test", revoke: () => undefined };
    },
  } as CommandContext["agentTools"];
  const reactor = new ContainerLifecycleReactor(() => h.context, {
    syncStatus: async () => h.environment,
  });
  const tab = hooks.attach(h.environment.containerId!, h.context, () => {
    wakes += 1;
  });
  try {
    await flushMicrotasks();
    expect(tab.confirmed()).toBe(true);
    reactor.handle(h.environment.containerId!, "die");
    reactor.handle(h.environment.containerId!, "start");
    await reactor.idle();
    expect(tab.confirmed()).toBe(false);
    await flushMicrotasks();
    expect(tab.confirmed()).toBe(true);
    onSignal();
    expect(wakes).toBe(3);
  } finally {
    tab.release();
    hooks.shutdownAll();
    h.polls.shutdownAll();
  }
});

test("reconciliation cannot re-admit a stopped poll while lifecycle work owns the environment", async () => {
  const h = harness();
  try {
    await h.polls.reconcile(h.context);
    await flushMicrotasks();
    h.polls.shutdown(h.environment.containerId!);
    h.setLifecycle(true);
    await h.polls.reconcile(h.context);
    await h.time.advance(30_000);
    expect(h.reads()).toBe(1);
    expect(h.polls.status().containers).toBe(0);
  } finally {
    h.polls.shutdownAll();
  }
});

test("unrelated lifecycle work retains a live poll and closing demand restores safety cadence", async () => {
  const h = harness();
  try {
    h.terminals.rememberSession("shell", {
      kind: "container",
      containerId: h.environment.containerId!,
      cols: 80,
      rows: 24,
    });
    h.terminals.registerProcess("shell", { kill: () => undefined } as unknown as PtyProcess);
    await h.polls.reconcile(h.context);
    await flushMicrotasks();
    h.setLifecycle(true);
    await h.polls.reconcile(h.context);
    expect(h.polls.status().containers).toBe(1);
    await h.time.advance(2000);
    expect(h.reads()).toBeGreaterThan(1);
    h.setTabs(1);
    h.terminals.explicitlyCloseSession("shell");
    await h.time.advance(2000);
    const withTab = h.reads();
    await h.time.advance(1000);
    expect(h.reads()).toBeGreaterThan(withTab);
    h.setTabs(0);
    await h.time.advance(1000);
    const reads = h.reads();
    await h.time.advance(28000);
    expect(h.reads()).toBe(reads);
    await h.time.advance(2000);
    expect(h.reads()).toBe(reads + 1);
  } finally {
    h.polls.shutdownAll();
  }
});

test("unknown end-event retirement IDs are bounded", () => {
  const h = harness();
  for (let i = 0; i < 10000; i++) h.polls.shutdownMatching(i.toString(16).padStart(64, "0"));
  expect(h.polls["retired"].size).toBeLessThanOrEqual(1024);
  h.polls.shutdownAll();
});
