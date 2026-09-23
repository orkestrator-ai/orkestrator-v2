import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveRuntimeProfile } from "../../electron/runtime-profile.js";

const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
const MAX_STATUS_BYTES = 64 * 1024;

type Exit = { code: number; output: string; failure?: string };

function signalGroup(child: ChildProcess, signal: NodeJS.Signals) {
  try {
    process.kill(-child.pid!, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

/** Every subprocess has an owner, a deadline, and an immediately owned result. */
function launch(
  command: string,
  args: string[],
  options: {
    root: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    capture?: boolean;
    signal?: AbortSignal;
  },
) {
  const child = spawn(command, args, {
    cwd: options.root,
    env: options.env,
    detached: true,
    stdio: options.capture ? ["ignore", "pipe", "ignore"] : ["ignore", "inherit", "inherit"],
  });
  let finished = false;
  let failure: string | undefined;
  let output = Buffer.alloc(0);
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const stop = (reason = "Command cancelled") => {
    if (finished || failure) return;
    failure = reason;
    signalGroup(child, "SIGTERM");
    escalation = setTimeout(() => signalGroup(child, "SIGKILL"), 1000);
  };
  const abort = () => stop();
  const timer = setTimeout(() => stop("Command timed out"), options.timeoutMs);
  const done = new Promise<Exit>((resolve) => {
    child.on("error", () => {
      failure = "Command could not start";
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (output.length + chunk.length > MAX_STATUS_BYTES) {
        stop("Status output exceeded its bound");
        return;
      }
      output = Buffer.concat([output, chunk]);
    });
    child.on("close", (code) => {
      finished = true;
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      options.signal?.removeEventListener("abort", abort);
      signalGroup(child, "SIGKILL");
      resolve({ code: failure ? 1 : (code ?? 1), output: output.toString("utf8"), failure });
    });
  });
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  return {
    done,
    stop,
    get finished() {
      return finished;
    },
  };
}

export interface IsolatedBrowserOptions {
  design?: boolean;
  signal?: AbortSignal;
  root?: string;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  testTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}

/** A foreground launcher is started concurrently, never awaited as a setup command. */
export async function runIsolatedBrowser(options: IsolatedBrowserOptions = {}): Promise<number> {
  const profile = `qa-browser-${randomUUID().slice(0, 12)}`;
  const root = options.root ?? repositoryRoot;
  const runtimeProfile = resolveRuntimeProfile({
    repositoryRoot: root,
    requestedId: profile,
    flavor: "agent-test",
  });
  const env = {
    ...(options.env ?? process.env),
    ORKESTRATOR_AGENT_TEST_PROFILE: profile,
    ORKESTRATOR_AGENT_TEST_RUN_ID: profile,
    // These are ordinary local smoke tasks. Live-provider and Docker coverage
    // remain separate opt-in tasks with their own fixture/credential setup.
    ORKESTRATOR_AGENT_TEST_REVIEW: "0",
    ORKESTRATOR_AGENT_TEST_DOCKER: "0",
    // The browser suite deliberately fills a scheduler to test queueing. Keep
    // that simulated host inside the outer task's two-slot reservation, or its
    // nested weight-2 command would wait for the task that is waiting for it.
    ORKESTRATOR_TEST_SCHEDULER_DIR: path.join(runtimeProfile.profileRoot, "test-scheduler"),
    ORKESTRATOR_TEST_HOST_WORKERS: "2",
    ORKESTRATOR_TEST_HOST_MEMORY_MIB: "2048",
  };
  const startupTimeout = options.startupTimeoutMs ?? 120_000;
  const testTimeout = options.testTimeoutMs ?? 900_000;
  const cleanupTimeout = options.cleanupTimeoutMs ?? 45_000;
  const launchTask = (
    task: string,
    args: string[],
    timeoutMs: number,
    capture = false,
    signal?: AbortSignal,
  ) =>
    launch("mise", ["run", task, "--profile", profile, ...args], {
      root,
      env,
      timeoutMs,
      capture,
      signal,
    });
  let launcher: ReturnType<typeof launch> | undefined;
  let tests: ReturnType<typeof launch> | undefined;
  let result = 1;
  let failure: unknown;
  let cleanupFailure: Error | undefined;
  options.signal?.throwIfAborted();
  try {
    console.log(`Starting isolated browser profile ${profile}`);
    launcher = launchTask(
      "dev:test",
      ["--fixture", "--no-agent-credentials", "--agent-platforms", "codex"],
      startupTimeout + testTimeout,
      false,
      options.signal,
    );
    const deadline = performance.now() + startupTimeout;
    while (true) {
      options.signal?.throwIfAborted();
      if (launcher.finished) throw new Error("Isolated profile exited before browser readiness");
      if (performance.now() >= deadline) throw new Error("Isolated profile startup timed out");
      const status = await launchTask(
        "dev:status",
        ["--json"],
        Math.min(10_000, Math.max(1, deadline - performance.now())),
        true,
        options.signal,
      ).done;
      if (status.failure) throw new Error(status.failure);
      let snapshot: { status?: string; profile?: string; live?: Record<string, boolean> };
      try {
        snapshot = JSON.parse(status.output);
      } catch {
        throw new Error("Isolated profile returned invalid status JSON");
      }
      if (snapshot.profile !== profile)
        throw new Error("Isolated profile status did not match its owner");
      if (snapshot.status === "failed" || snapshot.status === "stopped")
        throw new Error("Isolated profile startup failed");
      if (
        status.code === 0 &&
        snapshot.status === "ready" &&
        ["launcher", "vite", "electron", "backend"].every((name) => snapshot.live?.[name])
      )
        break;
      await Bun.sleep(250);
    }
    options.signal?.throwIfAborted();
    if (launcher.finished) throw new Error("Isolated profile exited before browser tests");
    console.log(
      `Profile ${profile} ready; running ${options.design ? "design canvas" : "browser agent"} tests`,
    );
    tests = launch(
      "bunx",
      [
        "playwright",
        "test",
        "--config",
        "e2e/agent-testing/playwright.browser.config.ts",
        ...(options.design ? ["e2e/agent-testing/design-canvas.spec.ts"] : []),
        "--workers=1",
      ],
      { root, env, timeoutMs: testTimeout, signal: options.signal },
    );
    const completed = await Promise.race([
      tests.done,
      launcher.done.then(() => {
        throw new Error("Isolated profile exited during browser tests");
      }),
    ]);
    if (completed.failure) throw new Error(completed.failure);
    result = completed.code;
  } catch (error) {
    failure = error;
  } finally {
    // Reap the starter before reading/resetting its manifest: it must not write
    // fresh profile state after cleanup has already finished.
    tests?.stop();
    if (tests) await tests.done;
    launcher?.stop();
    if (launcher) await launcher.done;
    console.log(`Cleaning isolated browser profile ${profile}`);
    const stopped = await launchTask("dev:stop", [], cleanupTimeout).done;
    const reset = await launchTask("dev:reset", [], cleanupTimeout).done;
    if (stopped.code !== 0 || reset.code !== 0)
      cleanupFailure = new Error(
        `Isolated profile cleanup failed for ${profile}; inspect dev:status before retrying`,
      );
  }
  if (cleanupFailure)
    throw new AggregateError(
      failure ? [failure, cleanupFailure] : [cleanupFailure],
      cleanupFailure.message,
    );
  if (failure) throw failure;
  console.log(`Isolated browser validation ${result === 0 ? "passed" : "failed"}; profile removed`);
  return result;
}
