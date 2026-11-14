import { describe, expect, test } from "bun:test";
import { fakePid } from "@orkestrator/protocol/testing/fake-pids";
import {
  RUNNER_SIGTERM_EXIT_AFTER_MS,
  RUNNER_SIGTERM_EXIT_CODE,
  installPlaywrightRunnerSigterm,
  isPlaywrightRunnerProcess,
  type SignalProcess,
} from "../playwright-runner-sigterm";

// The real signal path, through a Playwright run and the group runner's
// `terminate`, is in playwright-sigterm-webserver.integration.test.ts.

const PID = fakePid(1);
const RUNNER_ARGV = ["/usr/bin/node", "/repo/node_modules/.bin/playwright", "test"];
const WORKER_ARGV = [
  "/usr/bin/node",
  "/repo/node_modules/playwright/lib/worker/workerProcessEntry.js",
];
const LOADER_ARGV = [
  "/usr/bin/node",
  "/repo/node_modules/playwright/lib/loader/loaderProcessEntry.js",
];

function fakeProcess(overrides: { argv?: string[]; env?: NodeJS.ProcessEnv; sigint?: number }) {
  const calls: string[] = [];
  const listeners: Array<() => void> = [];
  const timers: Array<{ callback: () => void; ms: number; unref: boolean }> = [];
  const target: SignalProcess = {
    pid: PID,
    argv: overrides.argv ?? RUNNER_ARGV,
    env: overrides.env ?? {},
    on: (_event, listener) => listeners.push(listener),
    listenerCount: (event) => (event === "SIGINT" ? (overrides.sigint ?? 1) : listeners.length),
    kill: (pid, signal) => calls.push(`kill ${pid} ${signal}`),
    exit: ((code: number) => {
      calls.push(`exit ${code}`);
    }) as SignalProcess["exit"],
  };
  const setTimer = (callback: () => void, ms: number) => {
    const timer = { callback, ms, unref: false };
    timers.push(timer);
    return { unref: () => (timer.unref = true) };
  };
  const sigterm = () => {
    for (const listener of listeners) listener();
  };
  return { target, calls, listeners, timers, setTimer, sigterm };
}

describe("isPlaywrightRunnerProcess", () => {
  test("is the runner only outside Playwright's forked processes", () => {
    expect(isPlaywrightRunnerProcess({ argv: RUNNER_ARGV, env: {} })).toBe(true);
    expect(isPlaywrightRunnerProcess({ argv: WORKER_ARGV, env: {} })).toBe(false);
    expect(isPlaywrightRunnerProcess({ argv: LOADER_ARGV, env: {} })).toBe(false);
    expect(isPlaywrightRunnerProcess({ argv: RUNNER_ARGV, env: { TEST_WORKER_INDEX: "0" } })).toBe(
      false,
    );
  });
});

describe("installPlaywrightRunnerSigterm", () => {
  test("leaves workers and the loader alone, which ignore SIGTERM on purpose", () => {
    for (const fake of [
      fakeProcess({ argv: WORKER_ARGV }),
      fakeProcess({ argv: LOADER_ARGV }),
      fakeProcess({ env: { TEST_WORKER_INDEX: "1" } }),
    ]) {
      expect(installPlaywrightRunnerSigterm(fake.target, { setTimer: fake.setTimer })).toBe(false);
      expect(fake.listeners).toHaveLength(0);
    }
  });

  test("installs once per process", () => {
    const fake = fakeProcess({});
    expect(installPlaywrightRunnerSigterm(fake.target, { setTimer: fake.setTimer })).toBe(true);
    expect(installPlaywrightRunnerSigterm(fake.target, { setTimer: fake.setTimer })).toBe(false);
    expect(fake.listeners).toHaveLength(1);
  });

  test("turns SIGTERM into Playwright's SIGINT shutdown, then exits if it has not finished", () => {
    const fake = fakeProcess({});
    installPlaywrightRunnerSigterm(fake.target, { setTimer: fake.setTimer });

    fake.sigterm();
    expect(fake.calls).toEqual([`kill ${PID} SIGINT`]);
    expect(fake.timers).toHaveLength(1);
    expect(fake.timers[0]!.ms).toBe(RUNNER_SIGTERM_EXIT_AFTER_MS);
    // Inside the one-second SIGKILL grace `terminate` in scripts/test-all.ts allows.
    expect(RUNNER_SIGTERM_EXIT_AFTER_MS).toBeLessThan(1_000);
    // It must not keep a runner alive that finished its shutdown in time.
    expect(fake.timers[0]!.unref).toBe(true);

    // A repeat changes nothing while the shutdown is under way.
    fake.sigterm();
    expect(fake.calls).toEqual([`kill ${PID} SIGINT`]);
    expect(fake.timers).toHaveLength(1);

    fake.timers[0]!.callback();
    expect(fake.calls).toEqual([`kill ${PID} SIGINT`, `exit ${RUNNER_SIGTERM_EXIT_CODE}`]);
  });

  test("exits at once when Playwright has no SIGINT shutdown to run yet", () => {
    // Raising SIGINT with no listener would kill the runner without its exit
    // handlers, the ones that SIGKILL every process group Playwright launched.
    const fake = fakeProcess({ sigint: 0 });
    installPlaywrightRunnerSigterm(fake.target, { setTimer: fake.setTimer });

    fake.sigterm();
    expect(fake.calls).toEqual([`exit ${RUNNER_SIGTERM_EXIT_CODE}`]);
    expect(fake.timers).toHaveLength(0);
  });
});
