import path from "node:path";

// Playwright's runner shuts down only on SIGINT. A SIGTERM (the aggregate test
// runner's watchdog and deadline, the host scheduler, a person's `kill`) ends it
// at once, without the teardown that stops its `webServer`, and that server
// leads a process group of its own, so the signal sent to the run's group never
// reaches it either (to-do 8040, retired). The run's Vite fixture server then kept
// listening on the run's port after everything else had gone.
//
// So the runner turns a SIGTERM into its own SIGINT shutdown, which stops the
// workers and the `webServer`. Should that not have finished before the caller's
// SIGKILL is due (`terminate` in scripts/test-all.ts allows one second), the
// runner exits: Playwright's own `exit` handler then SIGKILLs every process
// group it launched, the `webServer` included, by the PID it recorded at spawn.

/** How long Playwright's SIGINT shutdown may take before the runner exits. */
export const RUNNER_SIGTERM_EXIT_AFTER_MS = 500;
/** 128 + SIGTERM, what the runner would have exited with by default. */
export const RUNNER_SIGTERM_EXIT_CODE = 143;

const INSTALLED = Symbol.for("orkestrator.playwrightRunnerSigterm");

/** The part of `process` the handler uses, so tests can drive it without signals. */
export interface SignalProcess {
  readonly pid: number;
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  on(event: "SIGTERM", listener: () => void): unknown;
  listenerCount(event: "SIGINT" | "SIGTERM"): number;
  kill(pid: number, signal: NodeJS.Signals): unknown;
  exit(code: number): never;
}

export interface RunnerSigtermOptions {
  setTimer?: (callback: () => void, ms: number) => { unref?: () => unknown };
  exitAfterMs?: number;
}

/**
 * Whether this process is Playwright's runner rather than one of the processes
 * it forks. Workers and the loader load the config too; they get
 * `TEST_WORKER_INDEX` or run a `*ProcessEntry.js` script, and they ignore
 * SIGTERM on purpose so that the runner can stop them in order.
 */
export function isPlaywrightRunnerProcess(
  target: Pick<SignalProcess, "argv" | "env"> = process,
): boolean {
  if (target.env.TEST_WORKER_INDEX !== undefined) return false;
  const entry = target.argv[1];
  return !(entry && /ProcessEntry\.[cm]?js$/.test(path.basename(entry)));
}

/**
 * Installs the SIGTERM handler in Playwright's runner. Call it from a config
 * that declares a `webServer`; it is a no-op in workers and when already
 * installed in this process. Returns whether it installed the handler.
 */
export function installPlaywrightRunnerSigterm(
  target: SignalProcess = process as unknown as SignalProcess,
  options: RunnerSigtermOptions = {},
): boolean {
  if (!isPlaywrightRunnerProcess(target)) return false;
  const marked = target as unknown as Record<symbol, boolean>;
  if (marked[INSTALLED]) return false;
  marked[INSTALLED] = true;
  const setTimer =
    options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const exitAfterMs = options.exitAfterMs ?? RUNNER_SIGTERM_EXIT_AFTER_MS;
  let received = false;
  target.on("SIGTERM", () => {
    // Repeats change nothing: the shutdown is already under way.
    if (received) return;
    received = true;
    // Playwright listens for SIGINT only while a run is in progress. Before
    // that it has started no `webServer`, and a SIGINT with no listener would
    // kill the runner without running its `exit` handlers, so exit directly.
    if (target.listenerCount("SIGINT") === 0) {
      target.exit(RUNNER_SIGTERM_EXIT_CODE);
      return;
    }
    target.kill(target.pid, "SIGINT");
    setTimer(() => target.exit(RUNNER_SIGTERM_EXIT_CODE), exitAfterMs).unref?.();
  });
  return true;
}
