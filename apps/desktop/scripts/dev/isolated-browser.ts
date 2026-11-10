import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveRuntimeProfile } from "../../electron/runtime-profile.js";
import { parseAgentTestArguments } from "./arguments.js";

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

/** `dev:test` flags a caller may pass through; the runner owns the profile and fixture. */
const PROFILE_FLAGS = new Set([
  "--headless",
  "--no-agent-credentials",
  "--use-dev-worktree-folder",
]);
const PROFILE_OPTIONS = new Set(["--credential-source", "--agent-platforms", "--agent-tools-port"]);

/**
 * The disposable profile's `dev:test` arguments: a credential-free Codex
 * fixture unless the caller chooses credential sources or platforms, for
 * example to provision a provider that a host's startup checks require.
 *
 * Always `--headless`, and `--no-headless` is refused: these runs drive the
 * gateway from their own browser, and the explicit flag beats whatever the
 * caller's terminal or environment says, so a sub-agent's run cannot open a
 * window on the host's desktop.
 */
export function isolatedProfileArguments(extra: readonly string[] = []): string[] {
  for (let index = 0; index < extra.length; index += 1) {
    const argument = extra[index]!;
    if (PROFILE_OPTIONS.has(argument)) index += 1;
    else if (!PROFILE_FLAGS.has(argument)) {
      throw new Error(
        `Unsupported isolated profile option ${argument}; accepted: ${[...PROFILE_OPTIONS, ...PROFILE_FLAGS].join(", ")}`,
      );
    }
  }
  const credentials = extra.some(
    (argument) => argument === "--credential-source" || argument === "--no-agent-credentials",
  );
  const args = [
    "--fixture",
    "--headless",
    ...(credentials ? [] : ["--no-agent-credentials"]),
    ...(extra.includes("--agent-platforms") ? [] : ["--agent-platforms", "codex"]),
    ...extra,
  ];
  parseAgentTestArguments(args);
  return args;
}

/**
 * Backend live tests run against the freshly built image before the fixture
 * starts. Each needs no network and only fake credentials. The M8 suite stages
 * a fake host `~/.claude.json` and proves interactive Claude still starts on
 * its allowlist, so an image change cannot pass review without that evidence.
 */
export const IMAGE_QUALIFICATION_TESTS = ["./tests/claude-config-filter-docker.test.ts"] as const;

function imageQualificationArguments(): string[] {
  return [
    "test",
    "--cwd",
    "apps/backend",
    "--preload",
    "../../tests/setup-node.ts",
    ...IMAGE_QUALIFICATION_TESTS,
    "--parallel=1",
  ];
}

/** A Playwright suite other than the browser agent suite, run in the same disposable profile. */
export interface IsolatedSuite {
  /** Names the suite in progress lines. */
  label: string;
  /** Playwright config, relative to the repository root. */
  config: string;
  /** Applied over the runner's defaults, for example the suite's own opt-in. */
  env?: Record<string, string>;
}

export interface IsolatedBrowserOptions {
  design?: boolean;
  /** Build, smoke and qualify the credential-free Docker fixture. */
  docker?: boolean;
  /** Extra `dev:test` flags; see {@link isolatedProfileArguments}. */
  profileArgs?: readonly string[];
  /** Runs this suite instead of the browser agent suite. */
  suite?: IsolatedSuite;
  /** The disposable profile's name; generated when absent. */
  profile?: string;
  /**
   * Further disposable profiles, started one after another with the same
   * flags once the main profile is ready, and stopped and reset with it. For
   * a suite that needs more than one node (the main profile stays
   * `ORKESTRATOR_AGENT_TEST_PROFILE`; the suite's own env names the others).
   */
  companionProfiles?: readonly string[];
  signal?: AbortSignal;
  root?: string;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  testTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}

/** A foreground launcher is started concurrently, never awaited as a setup command. */
export async function runIsolatedBrowser(options: IsolatedBrowserOptions = {}): Promise<number> {
  const profileArgs = isolatedProfileArguments(options.profileArgs);
  if (options.docker) profileArgs.push("--fixture-environments", "local,container");
  const profile = options.profile ?? `qa-browser-${randomUUID().slice(0, 12)}`;
  const root = options.root ?? repositoryRoot;
  const runtimeProfile = resolveRuntimeProfile({
    repositoryRoot: root,
    requestedId: profile,
    flavor: "agent-test",
  });
  const env: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    ORKESTRATOR_AGENT_TEST_PROFILE: profile,
    ORKESTRATOR_AGENT_TEST_RUN_ID: profile,
    // These are ordinary local smoke tasks. Live-provider and Docker coverage
    // remain separate opt-in tasks with their own fixture/credential setup.
    ORKESTRATOR_AGENT_TEST_REVIEW: "0",
    ORKESTRATOR_AGENT_TEST_DOCKER: options.docker ? "1" : "0",
    ORKESTRATOR_AGENT_TEST_LIVE_OPENCODE: "0",
    ORKESTRATOR_AGENT_TEST_LIVE_CONTAINER_APPROVAL: "0",
    ORKESTRATOR_AGENT_TEST_LIVE_CLAUDE_TERMINAL: "0",
    ORKESTRATOR_AGENT_TEST_LIVE_GROK_LOGIN: "0",
    ORKESTRATOR_AGENT_TEST_LIVE_MULTI_REVIEW: "0",
    ORKESTRATOR_AGENT_TEST_LIVE_DESIGN: "0",
    ORKESTRATOR_AGENT_TEST_LIVE_IDLE_OBSERVATION: "0",
    ORKESTRATOR_AGENT_TEST_LIVE_REVISION_TOKENS: "0",
    ORKESTRATOR_AGENT_TEST_LIVE_TAB_REQUESTS: "0",
    // The browser suite deliberately fills a scheduler to test queueing. Keep
    // that simulated host inside the outer task's two-slot reservation, or its
    // nested weight-2 command would wait for the task that is waiting for it.
    ORKESTRATOR_TEST_SCHEDULER_DIR: path.join(runtimeProfile.profileRoot, "test-scheduler"),
    ORKESTRATOR_TEST_HOST_WORKERS: "2",
    ORKESTRATOR_TEST_HOST_MEMORY_MIB: "2048",
    ...options.suite?.env,
    // Specs may restart dev:test without the initial command-line flag.
    ORKESTRATOR_AGENT_TEST_HEADLESS: "1",
  };
  if (options.docker) {
    const realDocker = Bun.which("docker", { PATH: env.PATH });
    if (!realDocker) throw new Error("Docker qualification requires Docker");
    Object.assign(env, {
      ORKESTRATOR_QUALIFICATION_DOCKER: realDocker,
      PATH: `${path.join(root, "apps/desktop/scripts/dev/docker-qualification-bin")}:${env.PATH}`,
    });
  }
  const startupTimeout = options.startupTimeoutMs ?? (options.docker ? 300_000 : 120_000);
  // The browser suite has taken from 640 s to past 900 s on a busy Linux host; a
  // run cut off here reports no result for the cases it never reached.
  const testTimeout = options.testTimeoutMs ?? 1_500_000;
  const cleanupTimeout = options.cleanupTimeoutMs ?? 45_000;
  const companions = [...(options.companionProfiles ?? [])];
  if (new Set([profile, ...companions]).size !== companions.length + 1)
    throw new Error("Companion profiles must be distinct from each other and the main profile");
  const launchTask = (
    task: string,
    args: string[],
    timeoutMs: number,
    capture = false,
    signal?: AbortSignal,
    name = profile,
  ) =>
    launch("mise", ["run", task, "--profile", name, ...args], {
      root,
      env,
      timeoutMs,
      capture,
      signal,
    });
  /** Starts one profile's foreground launcher and waits for it to report ready. */
  const startProfile = async (name: string) => {
    const started = launchTask(
      "dev:test",
      profileArgs,
      startupTimeout * (companions.length + 1) + testTimeout,
      false,
      options.signal,
      name,
    );
    launchers.push(started);
    startedNames.add(name);
    const deadline = performance.now() + startupTimeout;
    while (true) {
      options.signal?.throwIfAborted();
      if (started.finished) throw new Error("Isolated profile exited before browser readiness");
      if (performance.now() >= deadline) throw new Error("Isolated profile startup timed out");
      const status = await launchTask(
        "dev:status",
        ["--json"],
        Math.min(10_000, Math.max(1, deadline - performance.now())),
        true,
        options.signal,
        name,
      ).done;
      if (status.failure) throw new Error(status.failure);
      let snapshot: { status?: string; profile?: string; live?: Record<string, boolean> };
      try {
        snapshot = JSON.parse(status.output);
      } catch {
        throw new Error("Isolated profile returned invalid status JSON");
      }
      if (snapshot.profile !== name)
        throw new Error("Isolated profile status did not match its owner");
      if (snapshot.status === "failed" || snapshot.status === "stopped")
        throw new Error("Isolated profile startup failed");
      if (
        status.code === 0 &&
        snapshot.status === "ready" &&
        ["launcher", "vite", "electron", "backend"].every((key) => snapshot.live?.[key])
      )
        return;
      await Bun.sleep(250);
    }
  };
  const launchers: Array<ReturnType<typeof launch>> = [];
  const startedNames = new Set<string>();
  let tests: ReturnType<typeof launch> | undefined;
  let result = 1;
  let failure: unknown;
  let cleanupFailure: Error | undefined;
  options.signal?.throwIfAborted();
  try {
    if (options.docker) {
      const built = await launchTask("docker:build:dev", [], 1_800_000, false, options.signal).done;
      if (built.code !== 0) throw new Error("Docker qualification image build failed");
      const smoke = await launch(
        "bash",
        ["docker/tests/final-image-smoke.sh", runtimeProfile.dockerImage],
        {
          root,
          env,
          timeoutMs: 180_000,
          signal: options.signal,
        },
      ).done;
      if (smoke.code !== 0) throw new Error("Docker qualification image smoke failed");
      const qualified = await launch("bun", imageQualificationArguments(), {
        root,
        env: {
          ...env,
          RUN_LIVE_DOCKER_TESTS: "1",
          ORKESTRATOR_QUALIFICATION_IMAGE: runtimeProfile.dockerImage,
          ORKESTRATOR_QUALIFICATION_REQUIRED: "1",
        },
        timeoutMs: 420_000,
        signal: options.signal,
      }).done;
      if (qualified.code !== 0) throw new Error("Docker qualification image tests failed");
      console.log(`Image qualification passed: ${IMAGE_QUALIFICATION_TESTS.join(", ")}`);
    }
    console.log(`Starting isolated browser profile ${profile}`);
    await startProfile(profile);
    for (const companion of companions) {
      console.log(`Starting companion profile ${companion}`);
      await startProfile(companion);
    }
    options.signal?.throwIfAborted();
    if (launchers.some((started) => started.finished))
      throw new Error("Isolated profile exited before browser tests");
    console.log(
      `Profile ${profile} ready; running ${options.suite?.label ?? (options.design ? "design canvas" : "browser agent")} tests`,
    );
    tests = launch(
      "bunx",
      [
        "playwright",
        "test",
        "--config",
        options.suite?.config ?? "e2e/agent-testing/playwright.browser.config.ts",
        ...(options.design && !options.suite ? ["e2e/agent-testing/design-canvas.spec.ts"] : []),
        ...(options.docker ? ["--grep", "Docker fixture"] : []),
        "--workers=1",
      ],
      { root, env, timeoutMs: testTimeout, signal: options.signal },
    );
    const completed = await Promise.race([
      tests.done,
      ...launchers.map((started) =>
        started.done.then(() => {
          throw new Error("Isolated profile exited during browser tests");
        }),
      ),
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
    for (const started of launchers) started.stop();
    await Promise.all(launchers.map((started) => started.done));
    const failed: string[] = [];
    // The main profile is always cleaned, as before; a companion only once
    // something started it.
    for (const name of [profile, ...companions.filter((name) => startedNames.has(name))]) {
      console.log(`Cleaning isolated browser profile ${name}`);
      const stopped = await launchTask("dev:stop", [], cleanupTimeout, false, undefined, name).done;
      const reset = await launchTask("dev:reset", [], cleanupTimeout, false, undefined, name).done;
      if (stopped.code !== 0 || reset.code !== 0) failed.push(name);
    }
    // dockerImage belongs to the checkout, not this disposable profile.
    // Leave it for the shared-image-aware profile prune workflow.
    if (failed.length > 0)
      cleanupFailure = new Error(
        `Isolated profile cleanup failed for ${failed.join(", ")}; inspect dev:status before retrying`,
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
