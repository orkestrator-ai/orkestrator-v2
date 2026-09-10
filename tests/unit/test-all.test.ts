import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  acquireFullSuiteLease,
  ALLOW_MISSING_PROTOCOL_BINARY_ENV,
  buildConcurrentGroups,
  createTestLogDirectory,
  defaultRunGroup,
  finalizeTestLogs,
  INCLUDE_IOS_TESTS_ENV,
  main,
  MAX_AGGREGATE_TEST_WORKERS,
  MIN_AGGREGATE_TEST_WORKERS,
  MIN_BRIDGE_WORKERS,
  planWorkers,
  pruneExpiredTestLogDirectories,
  runAllTests,
  TEST_LOG_DIRECTORY_ENV,
  TEST_LOG_RETENTION_MS,
  TEST_GROUP_TIMEOUT_MS_ENV,
  TEST_LEASE_DIRECTORY_ENV,
  TEST_MAX_OUTPUT_BYTES_ENV,
  TEST_NO_PROGRESS_TIMEOUT_MS_ENV,
  TEST_TIMINGS_DIRECTORY_ENV,
  WORKSPACE_WORKERS_ENV,
  type CommandResult,
  type TestAllDependencies,
  type TestGroup,
} from "../../scripts/test-all";

interface Invocation {
  name: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function createDependencies(
  options: {
    exists?: boolean;
    platform?: NodeJS.Platform;
    /** Per-group exit status, keyed by group name. */
    statusByName?: Record<string, number | null>;
    outputByName?: Record<string, string>;
    environment?: NodeJS.ProcessEnv;
    cores?: number;
    /** Blocks the named group until released, to observe concurrency. */
    gate?: { name: string; release: Promise<void> };
  } = {},
): {
  dependencies: TestAllDependencies;
  existsChecks: string[];
  invocations: Invocation[];
  started: string[];
  logs: string[];
} {
  const invocations: Invocation[] = [];
  const existsChecks: string[] = [];
  const started: string[] = [];
  const logs: string[] = [];

  return {
    dependencies: {
      env: options.environment ?? { TEST_ALL_MARKER: "preserved" },
      cores: options.cores ?? 8,
      exists: (target) => {
        existsChecks.push(target);
        return options.exists ?? false;
      },
      platform: options.platform ?? "linux",
      root: "/test/repository",
      log: (message) => logs.push(message),
      runGroup: async (group: TestGroup, env): Promise<CommandResult> => {
        started.push(group.name);
        invocations.push({
          name: group.name,
          command: group.command,
          args: group.args,
          env,
        });
        if (options.gate && options.gate.name === group.name) {
          await options.gate.release;
        }
        return {
          // A presence check, not `?? 0`: a deliberately configured `null`
          // (signal-terminated child) must reach the code under test intact.
          status:
            options.statusByName && group.name in options.statusByName
              ? options.statusByName[group.name]!
              : 0,
          output: options.outputByName?.[group.name],
        };
      },
    },
    existsChecks,
    invocations,
    started,
    logs,
  };
}

const WORKSPACE = "workspace (web, backend, desktop, web-public, cli, protocol)";
const ROOT = "root and agent-support tests";
const BRIDGES = "bridges";
const PROTOCOL = "codex protocol lockfile";

function isolatedRunnerEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment = { ...process.env, ...overrides };
  delete environment[TEST_LOG_DIRECTORY_ENV];
  return environment;
}

describe("scripts/test-all.ts", () => {
  test("runs every non-iOS group with inherited environment", async () => {
    const { dependencies, invocations } = createDependencies();

    expect(await runAllTests(dependencies)).toBe(0);
    expect(invocations.map((entry) => entry.name).sort()).toEqual(
      [WORKSPACE, ROOT, BRIDGES, PROTOCOL].sort(),
    );
    for (const invocation of invocations) {
      // Every group inherits the parent environment. Group-specific variables
      // must be layered onto it rather than replacing it.
      expect(invocation.env).toMatchObject(dependencies.env);
    }
    expect(invocations.find((entry) => entry.name === ROOT)?.env).toEqual(dependencies.env);
    expect(invocations.find((entry) => entry.name === BRIDGES)?.env).toEqual({
      ...dependencies.env,
      [WORKSPACE_WORKERS_ENV]: "1",
    });
    expect(invocations.find((entry) => entry.name === PROTOCOL)?.env).toMatchObject({
      ...dependencies.env,
      [ALLOW_MISSING_PROTOCOL_BINARY_ENV]: "1",
    });
  });

  test("the non-iOS groups run concurrently, not one after another", async () => {
    let release = () => {};
    const gate = {
      name: WORKSPACE,
      release: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    const { dependencies, started } = createDependencies({ gate });

    const run = runAllTests(dependencies);
    // Pruning old runner artifacts precedes group creation. Keep this wait
    // bounded and capture the pre-release starts so a sequential regression
    // names the missing groups instead of deadlocking on the WORKSPACE gate.
    const deadline = Date.now() + 15_000;
    while (started.length < 4 && Date.now() < deadline) await Bun.sleep(5);
    const startedBeforeRelease = Array.from(started);

    release();
    expect(await run).toBe(0);

    // Sequential execution would have started only WORKSPACE before release.
    expect(startedBeforeRelease).toContain(ROOT);
    expect(startedBeforeRelease).toContain(BRIDGES);
    expect(startedBeforeRelease).toContain(PROTOCOL);
  }, 30_000);

  test("passes a bounded worker count so concurrent groups cannot oversubscribe", () => {
    const groups = buildConcurrentGroups(10);
    const workspaceGroup = groups.find((group) => group.name === WORKSPACE)!;
    const rootGroup = groups.find((group) => group.name === ROOT)!;
    const bridgeGroup = groups.find((group) => group.name === BRIDGES)!;

    expect(workspaceGroup.args).toContain("--concurrency=2");
    expect(workspaceGroup.env).toEqual({ [WORKSPACE_WORKERS_ENV]: "1" });
    expect(rootGroup.args).toContain("--parallel=4");
    expect(rootGroup.args.slice(0, 2)).toEqual(["test", "./tests"]);
    expect(rootGroup.args).toContain("./e2e/agent-testing/artifact-sanitizer.test.ts");
    expect(rootGroup.args).toContain("./test-fixtures/agent-project/server.test.ts");
    expect(workspaceGroup.args).toContain("--filter=@orkestrator/desktop");
    expect(bridgeGroup.command).toBe("bunx");
    expect(bridgeGroup.args.slice(0, 3)).toEqual(["turbo", "run", "test:bridge"]);
    expect(bridgeGroup.args).toContain("--concurrency=2");
    expect(bridgeGroup.env).toEqual({ [WORKSPACE_WORKERS_ENV]: "1" });
  });

  test("the workspace worker count travels by environment, never through Turbo's `--`", () => {
    // Turbo folds passthrough arguments into the hash of the requested task and
    // of its `dependsOn` tasks, so `--` here would give `bun run build` and
    // `bun run test` different `@orkestrator/*#build` hashes and re-run
    // `tsc && vite build` on every alternation between the two.
    const workspaceGroup = buildConcurrentGroups(10).find((group) => group.name === WORKSPACE)!;

    expect(workspaceGroup.args).not.toContain("--");
    expect(workspaceGroup.args.some((argument) => argument.startsWith("--parallel"))).toBe(false);
    expect(WORKSPACE_WORKERS_ENV).toBe("ORKESTRATOR_TEST_WORKERS");
  });

  test("the workspace group's environment is layered onto the inherited one", async () => {
    const { dependencies, invocations } = createDependencies({
      environment: { TEST_ALL_MARKER: "preserved" },
    });

    await runAllTests(dependencies);
    const workspace = invocations.find((entry) => entry.name === WORKSPACE)!;
    expect(workspace.env.TEST_ALL_MARKER).toBe("preserved");
    expect(workspace.env[WORKSPACE_WORKERS_ENV]).toMatch(/^\d+$/);
    // The caller's environment object must not be mutated.
    expect(dependencies.env[WORKSPACE_WORKERS_ENV]).toBeUndefined();
  });

  test("removes ambient bridge diagnostics flags from every aggregate group", async () => {
    const { dependencies, invocations } = createDependencies({
      environment: {
        TEST_ALL_MARKER: "preserved",
        ORKESTRATOR_BRIDGE_DEBUG: "1",
        CURSOR_BRIDGE_DEBUG: "1",
      },
    });

    await runAllTests(dependencies);
    for (const invocation of invocations) {
      expect(invocation.env.TEST_ALL_MARKER).toBe("preserved");
      expect(invocation.env.ORKESTRATOR_BRIDGE_DEBUG).toBeUndefined();
      expect(invocation.env.CURSOR_BRIDGE_DEBUG).toBeUndefined();
    }
    expect(dependencies.env.ORKESTRATOR_BRIDGE_DEBUG).toBe("1");
  });

  test("worker plan bounds aggregate Bun workers across every active package task", () => {
    // Every field is a worker count handed straight to `--parallel` / Turbo's
    // `--concurrency`, so a zero or negative anywhere is a broken command line,
    // not merely a slow run. Degenerate inputs are included because `cores`
    // ultimately comes from `availableParallelism()`.
    for (const cores of [
      -8,
      -1,
      0,
      0.5,
      1,
      1.9,
      2,
      3,
      3.7,
      4,
      5,
      6,
      7,
      8,
      9,
      10,
      12,
      16,
      18,
      20,
      24,
      32,
      64,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      const plan = planWorkers(cores);
      const budget = Math.min(
        MAX_AGGREGATE_TEST_WORKERS,
        Math.max(
          MIN_AGGREGATE_TEST_WORKERS,
          Number.isFinite(cores) ? Math.floor(cores) : MIN_AGGREGATE_TEST_WORKERS,
        ),
      );
      const aggregate = plan.root + plan.bridges + plan.workspace * plan.workspaceConcurrency;

      // Exactly the budget, everywhere: `root` absorbs the integer-division
      // remainder, so the plan neither oversubscribes nor leaves workers idle.
      expect({ cores, aggregate }).toEqual({ cores, aggregate: budget });
      expect(plan.root).toBeGreaterThanOrEqual(1);
      expect(plan.root).toBeLessThanOrEqual(4);
      expect(plan.bridges).toBeGreaterThanOrEqual(MIN_BRIDGE_WORKERS);
      expect(plan.workspace).toBeGreaterThanOrEqual(1);
      expect(plan.workspaceConcurrency).toBeGreaterThanOrEqual(1);
      expect(plan.workspaceConcurrency).toBeLessThanOrEqual(3);
      for (const value of Object.values(plan)) expect(Number.isInteger(value)).toBe(true);
    }
  });

  test("the bridge group keeps a real worker pool on every machine size", () => {
    // Regression: a proportional 20% share of the capped budget floors to 1 at
    // every reachable core count, which left the ~50-file bridge suite running
    // single-worker on an 18-core workstation.
    for (const cores of [1, 2, 4, 8, 10, 16, 18, 24, 32]) {
      expect(planWorkers(cores).bridges).toBe(2);
    }
  });

  test("the root suite receives bounded additional large-host capacity", () => {
    const large = planWorkers(20);
    expect(large.root).toBe(4);
    expect(large.workspaceConcurrency).toBe(2);
    expect(large.root + large.bridges + large.workspace * large.workspaceConcurrency).toBe(
      MAX_AGGREGATE_TEST_WORKERS,
    );
    // Beyond the cap the plan is constant: more cores must not multiply peak heap.
    expect(planWorkers(64)).toEqual(planWorkers(MAX_AGGREGATE_TEST_WORKERS));
  });

  test("runs bridge suites as cacheable Turbo package tasks", () => {
    const groups = buildConcurrentGroups(8);
    const bridgeGroup = groups.find((group) => group.name === BRIDGES)!;

    expect(bridgeGroup.command).toBe("bunx");
    expect(bridgeGroup.args).toContain("test:bridge");
    expect(bridgeGroup.args).toContain("--filter=./bridges/*");
    expect(bridgeGroup.args).not.toContain("--cache-dir");
  });

  test("runs the Codex protocol check with an explicit offline fallback", () => {
    const protocolGroup = buildConcurrentGroups(8).find((group) => group.name === PROTOCOL)!;

    expect(protocolGroup.command).toBe("mise");
    expect(protocolGroup.args).toEqual(["run", "codex:protocol:check"]);
    expect(protocolGroup.env).toEqual({
      [ALLOW_MISSING_PROTOCOL_BINARY_ENV]: "1",
    });
  });

  test("runs workspace tests as Turbo package tasks with explicit Bun parallelism", () => {
    const workspaceGroup = buildConcurrentGroups(8).find((group) => group.name === WORKSPACE)!;

    expect(workspaceGroup.command).toBe("bunx");
    expect(workspaceGroup.args.slice(0, 3)).toEqual(["turbo", "run", "test:workspace"]);
    expect(workspaceGroup.args).toContain("--filter=@orkestrator/web");
    expect(workspaceGroup.args).toContain("--filter=@orkestrator/backend");
    expect(workspaceGroup.args).toContain("--filter=@orkestrator/web-public");
    expect(workspaceGroup.args).toContain("--filter=orkestrator");
    // The shared protocol package has its own suite (the task-list registry
    // both backends depend on); without a filter it would never run.
    expect(workspaceGroup.args).toContain("--filter=@orkestrator/protocol");
    expect(workspaceGroup.env?.[WORKSPACE_WORKERS_ENV]).toMatch(/^\d+$/);
    expect(workspaceGroup.args).not.toContain("--cache-dir");
    expect(workspaceGroup.args).toContain("--summarize");
  });

  test("offers an affected fast path while keeping the default suite complete", () => {
    const complete = buildConcurrentGroups(8);
    const affected = buildConcurrentGroups(8, true);

    expect(complete.flatMap((group) => group.args)).not.toContain("--affected");
    expect(complete.flatMap((group) => group.args)).not.toContain("--changed=main");
    expect(affected.find((group) => group.name === WORKSPACE)?.args).toContain("--affected");
    expect(affected.find((group) => group.name === BRIDGES)?.args).toContain("--affected");
    expect(affected.find((group) => group.name === ROOT)?.args).toContain("--changed=main");
    expect(affected.find((group) => group.name === ROOT)?.args).toContain("--pass-with-no-tests");
  });

  test("uses persistent duration data to start slow root files first", () => {
    const timingsDirectory = "/tmp/orkestrator-timings-fixture";
    const rootGroup = buildConcurrentGroups(8, false, timingsDirectory).find(
      (group) => group.name === ROOT,
    )!;

    expect(rootGroup.args).toContain("--timings");
    expect(rootGroup.args).toContain(path.join(timingsDirectory, "root.json"));
    expect(rootGroup.args).toContain("--update-timings");
    expect(TEST_TIMINGS_DIRECTORY_ENV).toBe("ORKESTRATOR_TEST_TIMINGS_DIR");
  });

  test("reports every failing group rather than stopping at the first", async () => {
    const { dependencies, invocations, logs } = createDependencies({
      statusByName: { [ROOT]: 7, [BRIDGES]: 9 },
    });

    expect(await runAllTests(dependencies)).toBe(7);
    // Every group still ran; a re-run should not be needed to see both failures.
    expect(invocations).toHaveLength(4);
    const report = logs.join("\n");
    expect(report).toContain(`FAIL  ${ROOT}`);
    expect(report).toContain(`FAIL  ${BRIDGES}`);
    expect(report).toContain(`PASS  ${WORKSPACE}`);
  });

  test("maps a signal-terminated group with a null status to failure", async () => {
    const { dependencies } = createDependencies({ statusByName: { [ROOT]: null } });
    expect(await runAllTests(dependencies)).toBe(1);
  });

  test("prints only failing output under its group banner", async () => {
    const { dependencies, logs } = createDependencies({
      statusByName: { [ROOT]: 1 },
      outputByName: { [ROOT]: "root suite details", [BRIDGES]: "bridge suite details" },
    });

    await runAllTests(dependencies);
    const report = logs.join("\n");
    expect(report).toContain("root suite details");
    expect(report).not.toContain("bridge suite details");
    expect(report.indexOf(ROOT)).toBeLessThan(report.indexOf("root suite details"));
  });

  test("orders the report by declaration, not completion", async () => {
    // The root group finishes last here, but must still be reported second.
    let release = () => {};
    const gate = {
      name: ROOT,
      release: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    const { dependencies, logs } = createDependencies({ gate });
    const run = runAllTests(dependencies);
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    await run;

    const report = logs.join("\n");
    expect(report.indexOf(`PASS  ${WORKSPACE}`)).toBeLessThan(report.indexOf(`PASS  ${ROOT}`));
    expect(report.indexOf(`PASS  ${ROOT}`)).toBeLessThan(report.indexOf(`PASS  ${BRIDGES}`));
    expect(report.indexOf(`PASS  ${BRIDGES}`)).toBeLessThan(report.indexOf(`PASS  ${PROTOCOL}`));
  });

  test("reports group completion before slower groups finish", async () => {
    let release = () => {};
    const gate = {
      name: ROOT,
      release: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    const { dependencies, logs } = createDependencies({ gate });
    const run = runAllTests(dependencies);
    const deadline = Date.now() + 5_000;
    while (!logs.some((line) => line.includes("finished (")) && Date.now() < deadline) {
      await Bun.sleep(5);
    }

    expect(logs.some((line) => line.includes("finished ("))).toBe(true);
    expect(logs.join("\n")).not.toContain(`PASS  ${ROOT}`);
    release();
    expect(await run).toBe(0);
  });

  test("runs iOS last and only after the other groups pass", async () => {
    const environment = {
      DEVELOPER_DIR: "/custom/Xcode/Developer",
      [INCLUDE_IOS_TESTS_ENV]: "1",
    };
    const { dependencies, existsChecks, invocations } = createDependencies({
      environment,
      exists: true,
      platform: "darwin",
    });

    expect(await runAllTests(dependencies)).toBe(0);
    expect(existsChecks).toEqual(["/custom/Xcode/Developer"]);
    // Alone at the end: the simulator is a single shared resource.
    expect(invocations.at(-1)?.name).toBe("ios");
    expect(invocations.at(-1)?.args).toEqual(["scripts/test-ios.ts"]);
  });

  test("skips iOS when another group failed", async () => {
    const { dependencies, invocations } = createDependencies({
      environment: { [INCLUDE_IOS_TESTS_ENV]: "1" },
      exists: true,
      platform: "darwin",
      statusByName: { [ROOT]: 3 },
    });

    expect(await runAllTests(dependencies)).toBe(3);
    expect(invocations.map((entry) => entry.name)).not.toContain("ios");
  });

  test("uses the standard Xcode path when DEVELOPER_DIR is absent", async () => {
    const { dependencies, existsChecks, invocations } = createDependencies({
      environment: { [INCLUDE_IOS_TESTS_ENV]: "1" },
      exists: true,
      platform: "darwin",
    });

    expect(await runAllTests(dependencies)).toBe(0);
    expect(existsChecks).toEqual(["/Applications/Xcode.app/Contents/Developer"]);
    expect(invocations.at(-1)?.name).toBe("ios");
  });

  test("propagates an iOS test failure", async () => {
    const { dependencies, invocations } = createDependencies({
      environment: { [INCLUDE_IOS_TESTS_ENV]: "1" },
      exists: true,
      platform: "darwin",
      statusByName: { ios: 10 },
    });

    expect(await runAllTests(dependencies)).toBe(10);
    expect(invocations).toHaveLength(5);
  });

  test("skips iOS tests when Xcode is missing on macOS", async () => {
    const { dependencies, existsChecks, invocations } = createDependencies({
      environment: { [INCLUDE_IOS_TESTS_ENV]: "1" },
      exists: false,
      platform: "darwin",
    });

    expect(await runAllTests(dependencies)).toBe(0);
    expect(existsChecks).toHaveLength(1);
    expect(invocations).toHaveLength(4);
  });

  test("does not inspect Xcode or run iOS tests on non-macOS platforms", async () => {
    const { dependencies, existsChecks, invocations } = createDependencies({
      environment: { [INCLUDE_IOS_TESTS_ENV]: "1" },
      exists: true,
      platform: "linux",
    });

    expect(await runAllTests(dependencies)).toBe(0);
    expect(existsChecks).toHaveLength(0);
    expect(invocations).toHaveLength(4);
  });

  test("keeps the default suite platform-independent and leaves iOS opt-in", async () => {
    const { dependencies, existsChecks, invocations } = createDependencies({
      exists: true,
      platform: "darwin",
    });

    expect(await runAllTests(dependencies)).toBe(0);
    expect(existsChecks).toHaveLength(0);
    expect(invocations.map((entry) => entry.name)).not.toContain("ios");
  });

  test("CLI entrypoint exits with the failing group status", async () => {
    const { dependencies } = createDependencies({ statusByName: { [ROOT]: 13 } });
    const exitStatuses: number[] = [];

    await main(dependencies, (status) => {
      exitStatuses.push(status);
    });

    expect(exitStatuses).toEqual([13]);
  });

  test("the default exit path sets a status instead of tearing the process down", async () => {
    // A direct `process.exit` could truncate the bounded failure summary or
    // interrupt artifact finalization.
    const previousExitCode = process.exitCode;
    try {
      const { dependencies } = createDependencies({ statusByName: { [ROOT]: 13 } });
      await main(dependencies);
      expect(process.exitCode).toBe(13);
    } finally {
      // `undefined` does not clear it in Bun, and leaving 13 behind would fail
      // this file's own run. Bun tracks test failures itself, so restoring 0 as
      // the "no status yet" value cannot mask one.
      process.exitCode = previousExitCode ?? 0;
    }
  });

  test("CLI entrypoint returns normally after successful suites", async () => {
    const { dependencies } = createDependencies();
    const exitStatuses: number[] = [];

    await main(dependencies, (status) => {
      exitStatuses.push(status);
    });

    expect(exitStatuses).toEqual([]);
  });

  test("default runner captures child output and close status", async () => {
    const result = await defaultRunGroup(
      {
        name: "fixture",
        command: process.execPath,
        args: ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
      },
      isolatedRunnerEnvironment(),
    );

    expect(result.status).toBe(0);
    expect(result.output).toContain("out");
    expect(result.output).toContain("err");
    if (result.logPath) await rm(path.dirname(result.logPath), { recursive: true, force: true });
  });

  test("default runner converts spawn errors into a failed result", async () => {
    const result = await defaultRunGroup(
      {
        name: "missing",
        command: "/definitely/not/a/real/executable",
        args: [],
      },
      isolatedRunnerEnvironment(),
    );

    expect(result.status).toBe(1);
    expect(result.output).toMatch(/ENOENT|not found/i);
    if (result.logPath) await rm(path.dirname(result.logPath), { recursive: true, force: true });
  });

  test("terminates a group whose diagnostic output exceeds the byte budget", async () => {
    const result = await defaultRunGroup(
      {
        name: "noisy fixture",
        command: process.execPath,
        args: ["-e", "process.stdout.write('x'.repeat(32_000))"],
      },
      isolatedRunnerEnvironment({ [TEST_MAX_OUTPUT_BYTES_ENV]: "4096" }),
    );

    expect(result.status).toBe(1);
    expect(result.outputLimitExceeded).toBe(true);
    expect(result.output).toContain("Output exceeded 4096 bytes");
    if (result.logPath) await rm(path.dirname(result.logPath), { recursive: true, force: true });
  });

  test("terminates a process group that stops making observable progress", async () => {
    const result = await defaultRunGroup(
      {
        name: "wedged fixture",
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
      },
      isolatedRunnerEnvironment({
        [TEST_NO_PROGRESS_TIMEOUT_MS_ENV]: "50",
        [TEST_GROUP_TIMEOUT_MS_ENV]: "1000",
      }),
    );

    expect(result.status).toBe(1);
    expect(result.timeoutReason).toBe("no-progress");
    expect(result.output).toContain("No output for 50ms");
    if (result.logPath) await rm(path.dirname(result.logPath), { recursive: true, force: true });
  });

  test("enforces an absolute deadline even while a group keeps printing", async () => {
    const result = await defaultRunGroup(
      {
        name: "busy fixture",
        command: process.execPath,
        args: ["-e", "setInterval(() => process.stdout.write('.'), 10)"],
      },
      isolatedRunnerEnvironment({
        [TEST_NO_PROGRESS_TIMEOUT_MS_ENV]: "1000",
        [TEST_GROUP_TIMEOUT_MS_ENV]: "75",
      }),
    );

    expect(result.status).toBe(1);
    expect(result.timeoutReason).toBe("absolute");
    expect(result.output).toContain("Exceeded the 75ms group deadline");
    if (result.logPath) await rm(path.dirname(result.logPath), { recursive: true, force: true });
  });

  test("serializes full suites across linked worktrees and cleans stale leases", async () => {
    const leaseDirectory = await mkdtemp(path.join(os.tmpdir(), "ork-suite-lease-parent-"));
    const lock = path.join(leaseDirectory, "suite.lock");
    try {
      const repositoryRoot = path.resolve(import.meta.dir, "../..");
      const first = acquireFullSuiteLease(repositoryRoot, { [TEST_LEASE_DIRECTORY_ENV]: lock });
      expect(first?.directory).toBe(lock);
      expect(() =>
        acquireFullSuiteLease(repositoryRoot, { [TEST_LEASE_DIRECTORY_ENV]: lock }),
      ).toThrow(/already running/);
      first?.release();

      await mkdir(lock);
      await writeFile(
        path.join(lock, "owner.json"),
        JSON.stringify({ version: 1, pid: 2_147_483_647, root: "/stale" }),
      );
      const replacement = acquireFullSuiteLease(repositoryRoot, {
        [TEST_LEASE_DIRECTORY_ENV]: lock,
      });
      expect(replacement?.directory).toBe(lock);
      replacement?.release();
      expect(await stat(lock).catch(() => null)).toBeNull();
    } finally {
      await rm(leaseDirectory, { recursive: true, force: true });
    }
  });

  test("fails a group when its authoritative log cannot be opened", async () => {
    const logDirectory = await mkdtemp(path.join(os.tmpdir(), "ork-test-log-error-"));
    await mkdir(path.join(logDirectory, "fixture.log"));
    try {
      const result = await defaultRunGroup(
        {
          name: "fixture",
          command: process.execPath,
          args: ["-e", "process.stdout.write('hi')"],
        },
        { ...process.env, [TEST_LOG_DIRECTORY_ENV]: logDirectory },
      );

      expect(result.status).toBe(1);
      expect(result.output).toMatch(/EISDIR|directory/i);
    } finally {
      await rm(logDirectory, { recursive: true, force: true });
    }
  });

  test("prunes expired completed and abandoned runs but preserves unsafe or recent targets", async () => {
    const now = Date.now();
    const expired = createTestLogDirectory();
    const recent = createTestLogDirectory();
    const invalid = createTestLogDirectory();
    const unrelated = await mkdtemp(path.join(os.tmpdir(), "unrelated-test-log-"));
    const oldCreatedAt = new Date(now - TEST_LOG_RETENTION_MS - 1_000).toISOString();
    try {
      await writeFile(
        path.join(expired, ".orkestrator-test-log"),
        JSON.stringify({
          version: 1,
          pid: process.pid,
          createdAt: oldCreatedAt,
        }),
      );
      await writeFile(
        path.join(invalid, ".orkestrator-test-log"),
        JSON.stringify({
          version: 999,
          createdAt: oldCreatedAt,
        }),
      );

      await pruneExpiredTestLogDirectories(now);

      expect(await stat(expired).catch(() => null)).toBeNull();
      expect(await stat(recent).catch(() => null)).not.toBeNull();
      expect(await stat(invalid).catch(() => null)).not.toBeNull();
      expect(await stat(unrelated).catch(() => null)).not.toBeNull();
    } finally {
      await Promise.all(
        [recent, invalid, unrelated].map((target) =>
          rm(target, {
            recursive: true,
            force: true,
          }),
        ),
      );
    }
  });

  test("finalizes passing and failing logs with bounded private artifacts", async () => {
    const passingDirectory = createTestLogDirectory();
    const failingDirectory = createTestLogDirectory();
    const passingLog = path.join(passingDirectory, "passing.log");
    const failingLog = path.join(failingDirectory, "failing.log");
    const group = { name: "fixture", command: "bun", args: [] };
    await writeFile(passingLog, "passing output", { mode: 0o600 });
    await writeFile(failingLog, "failing output", { mode: 0o600 });
    try {
      await finalizeTestLogs(
        passingDirectory,
        [
          {
            group,
            result: { status: 0, logPath: passingLog, outputBytes: 14 },
            elapsedMs: 1,
          },
        ],
        true,
      );
      await finalizeTestLogs(
        failingDirectory,
        [
          {
            group,
            result: { status: 1, logPath: failingLog, outputBytes: 14 },
            elapsedMs: 2,
          },
        ],
        false,
      );

      expect(await stat(passingLog).catch(() => null)).toBeNull();
      expect(await stat(`${failingLog}.gz`)).not.toBeNull();
      expect(await stat(failingLog).catch(() => null)).toBeNull();
      const passingSummary = JSON.parse(
        await readFile(path.join(passingDirectory, "summary.json"), "utf8"),
      ) as { succeeded: boolean };
      const failingSummary = JSON.parse(
        await readFile(path.join(failingDirectory, "summary.json"), "utf8"),
      ) as { succeeded: boolean; groups: Array<{ artifact?: string }> };
      expect(passingSummary.succeeded).toBe(true);
      expect(failingSummary.succeeded).toBe(false);
      expect(failingSummary.groups[0]?.artifact).toBe("failing.log.gz");
      expect((await stat(passingDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(passingDirectory, "summary.json"))).mode & 0o777).toBe(0o600);
    } finally {
      await Promise.all(
        [passingDirectory, failingDirectory].map((target) =>
          rm(target, {
            recursive: true,
            force: true,
          }),
        ),
      );
    }
  });

  test("records missing and unreadable logs without aborting finalization", async () => {
    const directory = createTestLogDirectory();
    const missingLog = path.join(directory, "missing.log");
    const unreadableLog = path.join(directory, "unreadable.log");
    await mkdir(unreadableLog);
    try {
      await finalizeTestLogs(
        directory,
        [missingLog, unreadableLog].map((logPath) => ({
          group: { name: path.basename(logPath), command: "bun", args: [] },
          result: { status: 1, logPath },
          elapsedMs: 1,
        })),
        false,
      );
      const summary = JSON.parse(await readFile(path.join(directory, "summary.json"), "utf8")) as {
        groups: Array<{ artifactError?: string }>;
      };
      expect(summary.groups).toHaveLength(2);
      expect(summary.groups.every((entry) => Boolean(entry.artifactError))).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
