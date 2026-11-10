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
 * Backend live tests run against the freshly built image, at the same time as
 * the fixture profiles start (both only read the image). Each needs no network
 * and only fake credentials. The M8 suite stages a fake host `~/.claude.json`
 * and proves interactive Claude still starts on its allowlist, so an image
 * change cannot pass review without that evidence.
 */
export const IMAGE_QUALIFICATION_TESTS = ["./tests/claude-config-filter-docker.test.ts"] as const;

const IMAGE_BUILD_TIMEOUT_MS = 1_800_000;
const IMAGE_SMOKE_TIMEOUT_MS = 180_000;
const IMAGE_QUALIFICATION_TIMEOUT_MS = 420_000;

/**
 * The `Docker fixture` spec files, split across disposable profiles that run
 * at the same time. Each profile is its own backend with its own fixture
 * container, so a shard runs exactly as the whole selection used to: one file
 * after another against a profile nothing else touches. Within one profile
 * the specs share that fixture and must stay serial.
 *
 * The split balances measured run time (about 380 s a side on the Linux
 * host, 2026-11-10): the three ~3-minute files are kept apart. A spec that
 * gains a `Docker fixture` test must be added to one shard;
 * `isolated-browser.test.ts` fails while one is in no shard or in two.
 */
export const DOCKER_FIXTURE_SHARDS: readonly (readonly string[])[] = [
  [
    "e2e/agent-testing/container-files-wiring.spec.ts",
    "e2e/agent-testing/container-fake-engines.spec.ts",
    "e2e/agent-testing/container-settings.spec.ts",
    "e2e/agent-testing/container-rebuild-cycle.spec.ts",
    "e2e/agent-testing/native-draft-attachments.spec.ts",
    "e2e/agent-testing/design-container-export.spec.ts",
    "e2e/agent-testing/container-root-terminal.spec.ts",
    "e2e/agent-testing/container-bridge-logs.spec.ts",
    "e2e/agent-testing/grok-container-login.spec.ts",
    "e2e/agent-testing/container-terminal-close.spec.ts",
  ],
  [
    "e2e/agent-testing/container-app-wiring.spec.ts",
    "e2e/agent-testing/web-annotations-gateway.spec.ts",
    "e2e/agent-testing/browser-gateway.spec.ts",
    "e2e/agent-testing/container-multi-review-read-only.spec.ts",
    "e2e/agent-testing/container-claude-terminal-signal.spec.ts",
    "e2e/agent-testing/container-approval-stop.spec.ts",
  ],
];

/**
 * The shards this run uses. A fixed `--agent-tools-port` is one port, which
 * only one backend can bind, so that run keeps every spec in one profile.
 */
export function dockerFixtureShards(
  profileArgs: readonly string[],
): readonly (readonly string[])[] {
  return profileArgs.includes("--agent-tools-port")
    ? [DOCKER_FIXTURE_SHARDS.flat()]
    : DOCKER_FIXTURE_SHARDS;
}

/**
 * How long each profile launcher may live. Profiles start one after another,
 * so the first launcher waits through every later startup before its tests
 * begin: its budget covers all of them, not just its own. Docker profiles
 * start while the image is smoked and qualified, so those steps' budgets are
 * a floor for the startup phase rather than an addition to it.
 */
export function isolatedLauncherTimeoutMs(input: {
  startupTimeoutMs: number;
  sequentialStartups: number;
  docker: boolean;
  testTimeoutMs: number;
}): number {
  const startupPhase = Math.max(
    input.startupTimeoutMs * input.sequentialStartups,
    input.docker ? IMAGE_SMOKE_TIMEOUT_MS + IMAGE_QUALIFICATION_TIMEOUT_MS : 0,
  );
  return startupPhase + input.testTimeoutMs;
}

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

/**
 * Runs every step to completion. The first failure aborts the others, which
 * are still awaited so none outlives this call, and is the error thrown,
 * unless `parent` was aborted: then its reason is.
 */
async function allOrAbort(
  steps: Array<(signal: AbortSignal) => Promise<void>>,
  parent?: AbortSignal,
): Promise<void> {
  const controller = new AbortController();
  const forward = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", forward, { once: true });
  if (parent?.aborted) forward();
  let failure: { error: unknown } | undefined;
  try {
    await Promise.all(
      steps.map((step) =>
        step(controller.signal).catch((error: unknown) => {
          if (failure) return;
          failure = { error };
          controller.abort();
        }),
      ),
    );
  } finally {
    parent?.removeEventListener("abort", forward);
  }
  // A step stopped by the owner's cancel reports its own failure (a killed
  // smoke exits non-zero); the cancel is what happened.
  parent?.throwIfAborted();
  if (failure) throw failure.error;
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
  /**
   * Build, smoke and qualify the image, then run the `Docker fixture` specs in
   * one disposable profile per {@link DOCKER_FIXTURE_SHARDS} entry.
   */
  docker?: boolean;
  /** Extra `dev:test` flags; see {@link isolatedProfileArguments}. */
  profileArgs?: readonly string[];
  /** Runs this suite instead of the browser agent suite. */
  suite?: IsolatedSuite;
  /**
   * The disposable profile's name; generated when absent. Further Docker
   * shard profiles are named after it (`<profile>-2`, …).
   */
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
  const companions = [...(options.companionProfiles ?? [])];
  if (new Set([profile, ...companions]).size !== companions.length + 1)
    throw new Error("Companion profiles must be distinct from each other and the main profile");
  if (options.docker && companions.length > 0)
    throw new Error("Docker qualification runs its own shard profiles, not companion profiles");
  // One Playwright run per entry, each in its own profile; `undefined` is the
  // whole configured selection.
  const shards: ReadonlyArray<readonly string[] | undefined> = options.docker
    ? dockerFixtureShards(profileArgs)
    : [undefined];
  const runProfiles = shards.map((_, index) => (index === 0 ? profile : `${profile}-${index + 1}`));
  const baseEnv: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
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
    ORKESTRATOR_TEST_HOST_WORKERS: "2",
    ORKESTRATOR_TEST_HOST_MEMORY_MIB: "2048",
    ...options.suite?.env,
    // Specs may restart dev:test without the initial command-line flag.
    ORKESTRATOR_AGENT_TEST_HEADLESS: "1",
  };
  if (options.docker) {
    const realDocker = Bun.which("docker", { PATH: baseEnv.PATH });
    if (!realDocker) throw new Error("Docker qualification requires Docker");
    Object.assign(baseEnv, {
      ORKESTRATOR_QUALIFICATION_DOCKER: realDocker,
      PATH: `${path.join(root, "apps/desktop/scripts/dev/docker-qualification-bin")}:${baseEnv.PATH}`,
    });
  }
  /** The environment of one run profile's launcher and Playwright run. */
  const envFor = (name: string): NodeJS.ProcessEnv => ({
    ...baseEnv,
    ORKESTRATOR_AGENT_TEST_PROFILE: name,
    ORKESTRATOR_AGENT_TEST_RUN_ID: name,
    // The browser suite deliberately fills a scheduler to test queueing. Keep
    // that simulated host inside the outer task's reservation, or its nested
    // weight-2 command would wait for the task that is waiting for it.
    ORKESTRATOR_TEST_SCHEDULER_DIR: path.join(
      resolveRuntimeProfile({ repositoryRoot: root, requestedId: name, flavor: "agent-test" })
        .profileRoot,
      "test-scheduler",
    ),
    ...options.suite?.env,
    ORKESTRATOR_AGENT_TEST_HEADLESS: "1",
  });
  const env = envFor(profile);
  const imageTag = resolveRuntimeProfile({
    repositoryRoot: root,
    requestedId: profile,
    flavor: "agent-test",
  }).dockerImage;
  const startupTimeout = options.startupTimeoutMs ?? (options.docker ? 300_000 : 120_000);
  // The browser suite has taken from 640 s to past 900 s on a busy Linux host; a
  // run cut off here reports no result for the cases it never reached.
  const testTimeout = options.testTimeoutMs ?? 1_500_000;
  const cleanupTimeout = options.cleanupTimeoutMs ?? 45_000;
  const launcherTimeout = isolatedLauncherTimeoutMs({
    startupTimeoutMs: startupTimeout,
    sequentialStartups: runProfiles.length + companions.length,
    docker: options.docker === true,
    testTimeoutMs: testTimeout,
  });
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
      env: runProfiles.includes(name) ? envFor(name) : env,
      timeoutMs,
      capture,
      signal,
    });
  /**
   * Starts one profile's foreground launcher and waits for it to report
   * ready. `signal` cancels only the wait; the launcher is stopped in cleanup.
   */
  const startProfile = async (name: string, signal = options.signal) => {
    const started = launchTask(
      "dev:test",
      profileArgs,
      launcherTimeout,
      false,
      options.signal,
      name,
    );
    launchers.push({ name, handle: started });
    startedNames.add(name);
    const deadline = performance.now() + startupTimeout;
    while (true) {
      signal?.throwIfAborted();
      if (started.finished) throw new Error("Isolated profile exited before browser readiness");
      if (performance.now() >= deadline) throw new Error("Isolated profile startup timed out");
      const status = await launchTask(
        "dev:status",
        ["--json"],
        Math.min(10_000, Math.max(1, deadline - performance.now())),
        true,
        signal,
        name,
      ).done;
      signal?.throwIfAborted();
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
  const launchers: Array<{ name: string; handle: ReturnType<typeof launch> }> = [];
  const startedNames = new Set<string>();
  const tests: Array<ReturnType<typeof launch>> = [];
  let result = 1;
  let failure: unknown;
  let cleanupFailure: Error | undefined;
  options.signal?.throwIfAborted();
  try {
    if (options.docker) {
      const built = await launchTask(
        "docker:build:dev",
        [],
        IMAGE_BUILD_TIMEOUT_MS,
        false,
        options.signal,
      ).done;
      if (built.code !== 0) throw new Error("Docker qualification image build failed");
      // The image exists now, so a starting profile finds it rather than
      // building its own. The smoke, the image qualification and the
      // profiles' startup only read it, so they run side by side. The
      // profiles start one after another, as companions do: each startup
      // compiles Electron and the bridges into this one checkout.
      console.log(
        `Image built; smoking and qualifying it while ${runProfiles.length} isolated profile(s) start in turn: ${runProfiles.join(", ")}`,
      );
      await allOrAbort(
        [
          async (signal) => {
            const smoke = await launch("bash", ["docker/tests/final-image-smoke.sh", imageTag], {
              root,
              env,
              timeoutMs: IMAGE_SMOKE_TIMEOUT_MS,
              signal,
            }).done;
            if (smoke.code !== 0) throw new Error("Docker qualification image smoke failed");
          },
          async (signal) => {
            const qualified = await launch("bun", imageQualificationArguments(), {
              root,
              env: {
                ...env,
                RUN_LIVE_DOCKER_TESTS: "1",
                ORKESTRATOR_QUALIFICATION_IMAGE: imageTag,
                ORKESTRATOR_QUALIFICATION_REQUIRED: "1",
              },
              timeoutMs: IMAGE_QUALIFICATION_TIMEOUT_MS,
              signal,
            }).done;
            if (qualified.code !== 0) throw new Error("Docker qualification image tests failed");
            console.log(`Image qualification passed: ${IMAGE_QUALIFICATION_TESTS.join(", ")}`);
          },
          async (signal) => {
            for (const name of runProfiles) await startProfile(name, signal);
          },
        ],
        options.signal,
      );
    } else {
      console.log(`Starting isolated browser profile ${profile}`);
      await startProfile(profile);
      for (const companion of companions) {
        console.log(`Starting companion profile ${companion}`);
        await startProfile(companion);
      }
    }
    options.signal?.throwIfAborted();
    if (launchers.some((started) => started.handle.finished))
      throw new Error("Isolated profile exited before browser tests");
    const label =
      options.suite?.label ??
      (options.docker ? "Docker fixture" : options.design ? "design canvas" : "browser agent");
    const runs = runProfiles.map((name, index) => {
      const files = shards[index];
      console.log(
        `Profile ${name} ready; running ${label} tests${
          files && shards.length > 1
            ? ` (shard ${index + 1}/${shards.length}, ${files.length} files)`
            : ""
        }`,
      );
      const handle = launch(
        "bunx",
        [
          "playwright",
          "test",
          "--config",
          options.suite?.config ?? "e2e/agent-testing/playwright.browser.config.ts",
          ...(options.design && !options.suite ? ["e2e/agent-testing/design-canvas.spec.ts"] : []),
          ...(files ?? []),
          ...(options.docker ? ["--grep", "Docker fixture"] : []),
          "--workers=1",
        ],
        { root, env: envFor(name), timeoutMs: testTimeout, signal: options.signal },
      );
      tests.push(handle);
      return { name, handle };
    });
    // A run fails when its own profile, or a companion it relies on, exits
    // while it is still running; another shard's profile is not its concern.
    const completed = await Promise.all(
      runs.map(({ name, handle }) =>
        Promise.race([
          handle.done,
          ...launchers
            .filter((started) => started.name === name || companions.includes(started.name))
            .map((started) =>
              started.handle.done.then(() => {
                throw new Error("Isolated profile exited during browser tests");
              }),
            ),
        ]),
      ),
    );
    const timedOut = completed.find((run) => run.failure);
    if (timedOut) throw new Error(timedOut.failure);
    result = completed.find((run) => run.code !== 0)?.code ?? 0;
  } catch (error) {
    failure = error;
  } finally {
    // Reap the starters before reading/resetting their manifests: none may
    // write fresh profile state after cleanup has already finished.
    for (const run of tests) run.stop();
    await Promise.all(tests.map((run) => run.done));
    for (const started of launchers) started.handle.stop();
    await Promise.all(launchers.map((started) => started.handle.done));
    // The main profile is always cleaned, as before; any other only once
    // something started it. Profiles are independent, so they clean together.
    const cleaned = [
      profile,
      ...[...runProfiles.slice(1), ...companions].filter((name) => startedNames.has(name)),
    ];
    const outcomes = await Promise.all(
      cleaned.map(async (name) => {
        console.log(`Cleaning isolated browser profile ${name}`);
        const stopped = await launchTask("dev:stop", [], cleanupTimeout, false, undefined, name)
          .done;
        const reset = await launchTask("dev:reset", [], cleanupTimeout, false, undefined, name)
          .done;
        return stopped.code === 0 && reset.code === 0;
      }),
    );
    const failed = cleaned.filter((_, index) => !outcomes[index]);
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
  console.log(
    `Isolated browser validation ${result === 0 ? "passed" : "failed"}; ${
      startedNames.size > 1 ? "profiles" : "profile"
    } removed`,
  );
  return result;
}
