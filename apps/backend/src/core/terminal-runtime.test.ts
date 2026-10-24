import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  installControlledTimeout,
  type ControlledTimeout,
} from "../../../../tests/helpers/controlled-timeout.js";
import { BackendRuntime } from "./backend-runtime.js";
import type { CommandContext } from "./commands-context.js";
import { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import { createEnvironment, type StorageService } from "./storage.js";
import {
  TERMINAL_ACTIVITY_PERSIST_RETRY_DELAYS_MS,
  TERMINAL_ACTIVITY_SETTLE_MS,
  TERMINAL_COMPLETION_NOTIFY_RETRY_DELAYS_MS,
  TERMINAL_OUTPUT_RETENTION_MS,
} from "./terminal-runtime.js";

const runtimes: BackendRuntime[] = [];
const clocks: ControlledTimeout[] = [];

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.shutdown();
  // Each clock wraps the preceding one; unwind them in installation order's reverse.
  for (const clock of clocks.splice(0).reverse()) clock.restore();
});

function controlTimer(delay: number): ControlledTimeout {
  const clock = installControlledTimeout(delay, { maxPending: 2, label: "terminal runtime" });
  clocks.push(clock);
  return clock;
}

function controlRetries(): Map<number, ControlledTimeout> {
  const delays = new Set([
    ...TERMINAL_ACTIVITY_PERSIST_RETRY_DELAYS_MS,
    ...TERMINAL_COMPLETION_NOTIFY_RETRY_DELAYS_MS,
  ]);
  return new Map(Array.from(delays, (delay) => [delay, controlTimer(delay)]));
}

function fixture() {
  const environment = { ...createEnvironment("project"), id: "environment" };
  const recordEnvironmentActivity = mock(async (_id: string, occurredAt: string) => ({
    ...environment,
    lastActivityAt: occurredAt,
  }));
  const recordEnvironmentCompletion = mock(async (_id: string, occurredAt: string) => ({
    ...environment,
    lastActivityAt: occurredAt,
  }));
  const emit = mock((_event: string, _payload: unknown) => undefined);
  const notifyAgentTurnCompleted = mock(async (_id: string) => undefined);
  const runtime = new BackendRuntime({ emit });
  runtimes.push(runtime);
  const context: CommandContext = {
    storage: {
      recordEnvironmentActivity,
      recordEnvironmentCompletion,
    } as unknown as StorageService,
    emit,
    notifyAgentTurnCompleted,
    appRoot: "",
    resourceRoot: "",
    environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
    runtime,
  };
  const terminals = runtime.terminals;
  terminals.rememberSession("terminal", {
    kind: "local",
    environmentId: environment.id,
    cols: 80,
    rows: 24,
    trackEnvironmentActivity: true,
  });
  terminals.recordInputActivity("terminal", "prompt\n", context);
  return {
    runtime,
    terminals,
    environment,
    emit,
    recordEnvironmentCompletion,
    notifyAgentTurnCompleted,
    hooks: terminals.activityHooks("terminal", context),
  };
}

/** Drain continuations from storage and notification promises without advancing timers. */
function settlePromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("terminal runtime shutdown", () => {
  test("cancels only its own output-retention and activity timers", async () => {
    const retention = controlTimer(TERMINAL_OUTPUT_RETENTION_MS);
    const activity = controlTimer(TERMINAL_ACTIVITY_SETTLE_MS);
    const stopped = fixture();
    const live = fixture();
    await settlePromises();
    for (const owner of [stopped, live]) {
      owner.emit.mockClear();
      // Retain a separate exited session while the tracked terminal is settling.
      owner.terminals.appendOutput("exited", "retained output");
      owner.terminals.cleanupSession("exited");
      owner.hooks.onData();
      expect(owner.terminals.retainedOutputCount()).toBe(1);
    }
    expect(retention.pendingCount()).toBe(2);
    expect(activity.pendingCount()).toBe(2);

    stopped.runtime.shutdown();
    expect(stopped.terminals.retainedOutputCount()).toBe(0);
    expect(live.terminals.retainedOutputCount()).toBe(1);
    expect(retention.pendingCount()).toBe(1);
    expect(activity.pendingCount()).toBe(1);
    expect(retention.advance()).toBe(1);
    expect(activity.advance()).toBe(1);
    await settlePromises();

    expect(stopped.terminals.readOutput("exited")).toBe("retained output");
    expect(live.terminals.readOutput("exited")).toBe("");
    expect(stopped.recordEnvironmentCompletion).not.toHaveBeenCalled();
    expect(stopped.emit).not.toHaveBeenCalled();
    expect(stopped.notifyAgentTurnCompleted).not.toHaveBeenCalled();
    expect(live.recordEnvironmentCompletion).toHaveBeenCalledTimes(1);
    expect(live.notifyAgentTurnCompleted).toHaveBeenCalledWith("environment");
    expect(live.emit).toHaveBeenCalledWith("environment-activity-recorded", {
      environment_id: "environment",
      occurred_at: expect.any(String),
      activity_kind: "completed",
    });
    retention.assertDrained();
    activity.assertDrained();
  });

  for (const phase of ["persistence", "notification"] as const) {
    test(`cancels pending ${phase} retries while another runtime retries successfully`, async () => {
      const retries = controlRetries();
      const stopped = fixture();
      const live = fixture();
      await settlePromises();
      for (const owner of [stopped, live]) {
        owner.emit.mockClear();
        const operation =
          phase === "persistence"
            ? owner.recordEnvironmentCompletion
            : owner.notifyAgentTurnCompleted;
        operation.mockRejectedValueOnce(new Error("temporarily unavailable"));
        owner.hooks.onExit();
      }
      await settlePromises();
      const delay =
        phase === "persistence"
          ? TERMINAL_ACTIVITY_PERSIST_RETRY_DELAYS_MS[0]
          : TERMINAL_COMPLETION_NOTIFY_RETRY_DELAYS_MS[0];
      const retry = retries.get(delay)!;
      expect(retry.pendingCount()).toBe(2);

      stopped.runtime.shutdown();
      expect(retry.pendingCount()).toBe(1);
      expect(retry.advance()).toBe(1);
      await settlePromises();

      expect(stopped.recordEnvironmentCompletion).toHaveBeenCalledTimes(1);
      expect(stopped.notifyAgentTurnCompleted).toHaveBeenCalledTimes(
        phase === "notification" ? 1 : 0,
      );
      expect(live.recordEnvironmentCompletion).toHaveBeenCalledTimes(
        phase === "persistence" ? 2 : 1,
      );
      expect(live.notifyAgentTurnCompleted).toHaveBeenCalledTimes(phase === "notification" ? 2 : 1);
      expect(stopped.emit).toHaveBeenCalledTimes(phase === "notification" ? 1 : 0);
      expect(live.emit).toHaveBeenCalledTimes(1);
      for (const clock of retries.values()) {
        expect(clock.advance()).toBe(0);
        clock.assertDrained();
      }
    });
  }

  for (const outcome of ["success", "failure"] as const) {
    test(`ignores in-flight completion persistence ${outcome} after shutdown`, async () => {
      const retries = controlRetries();
      const owner = fixture();
      await settlePromises();
      owner.emit.mockClear();
      const persistedEnvironment = {
        ...owner.environment,
        lastActivityAt: new Date().toISOString(),
      };
      let resolve!: (environment: typeof persistedEnvironment) => void;
      let reject!: (reason: Error) => void;
      const pending = new Promise<typeof persistedEnvironment>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      owner.recordEnvironmentCompletion.mockImplementationOnce(() => pending);
      owner.hooks.onExit();
      expect(owner.recordEnvironmentCompletion).toHaveBeenCalledTimes(1);
      owner.runtime.shutdown();

      if (outcome === "success") resolve(persistedEnvironment);
      else reject(new Error("storage failed after shutdown"));
      await settlePromises();

      expect(owner.emit).not.toHaveBeenCalled();
      expect(owner.notifyAgentTurnCompleted).not.toHaveBeenCalled();
      expect(owner.recordEnvironmentCompletion).toHaveBeenCalledTimes(1);
      for (const clock of retries.values()) {
        expect(clock.advance()).toBe(0);
        clock.assertDrained();
      }
    });
  }

  test("does not schedule a retry when an in-flight notification fails after shutdown", async () => {
    const retries = controlRetries();
    const owner = fixture();
    let reject!: (reason: Error) => void;
    const pending = new Promise<undefined>((_resolve, fail) => {
      reject = fail;
    });
    owner.notifyAgentTurnCompleted.mockImplementationOnce(() => pending);
    owner.hooks.onExit();
    await settlePromises();
    expect(owner.notifyAgentTurnCompleted).toHaveBeenCalledTimes(1);
    owner.runtime.shutdown();
    reject(new Error("notification failed after shutdown"));
    await settlePromises();

    for (const clock of retries.values()) {
      expect(clock.advance()).toBe(0);
      clock.assertDrained();
    }
    expect(owner.notifyAgentTurnCompleted).toHaveBeenCalledTimes(1);
  });
});
