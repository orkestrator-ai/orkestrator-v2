import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ALLOW_MISSING_PROTOCOL_BINARY_ENV,
  BACKEND_WORKERS_ENV,
  buildConcurrentGroups,
  createTestLogDirectory,
  DEFAULT_TEST_GROUP_TIMEOUT_MS,
  DEFAULT_TEST_NO_PROGRESS_TIMEOUT_MS,
  defaultRunGroup,
  FAILURE_REPORT_CONTEXT_LINES,
  FailureReportCollector,
  finalizeTestLogs,
  GUARD_STAGE,
  GUARD_STAGE_TEST_FILES,
  INCLUDE_IOS_TESTS_ENV,
  IOS_GROUP_TIMEOUT_MS,
  main,
  MAX_RERUN_FILES,
  RERUN_FILE_TIMEOUT_MS,
  RERUN_TIME_BUDGET_MS,
  packageRerunTargets,
  rerunFlags,
  MAX_AGGREGATE_TEST_WORKERS,
  MAX_BACKEND_TEST_WORKERS,
  MAX_SLOW_BACKEND_TEST_WORKERS,
  MAX_CONSOLE_TAIL_LINE_CHARS,
  MAX_FAILURE_REPORTS,
  MAX_GROUP_OUTPUT_TAIL_BYTES,
  MIN_AGGREGATE_TEST_WORKERS,
  MIN_BRIDGE_WORKERS,
  planWorkers,
  pruneExpiredTestLogDirectories,
  runAllTests,
  TEST_LOG_DIRECTORY_ENV,
  TEST_LOG_RETENTION_MS,
  TEST_GROUP_KEYS,
  TEST_GROUP_TIMEOUT_MS_ENV,
  TEST_GROUPS_ENV,
  TEST_MAX_OUTPUT_BYTES_ENV,
  TEST_NO_PROGRESS_TIMEOUT_MS_ENV,
  TEST_RERUN_FAILED_ENV,
  TEST_SKIP_GUARDS_ENV,
  TEST_TIMINGS_DIRECTORY_ENV,
  terminateActiveGroups,
  TURBO_GROUP_OUTPUT_FLAGS,
  WORKSPACE_WORKERS_ENV,
  type CommandResult,
  type FailingFile,
  type TestAllDependencies,
  type TestGroup,
} from "../../scripts/test-all";
import { SLOW_TESTS, TEST_TIER_ENV } from "../../scripts/test-tiers";

test("real Turbo invalidates both stamp-consuming builds and restores the matching cached artifacts", async () => {
  const repositoryRoot = path.resolve(import.meta.dir, "../..");
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ork-turbo-commit-"));
  const env = {
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`,
    TURBO_TELEMETRY_DISABLED: "1",
    CI: "1",
  };
  const run = async (command: string[], environment: NodeJS.ProcessEnv = env) => {
    const child = Bun.spawn(command, {
      cwd: fixture,
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode, stderr + stdout).toBe(0);
    return stdout;
  };
  try {
    const config = JSON.parse(await readFile(path.join(repositoryRoot, "turbo.json"), "utf8"));
    await writeFile(
      path.join(fixture, "turbo.json"),
      JSON.stringify({
        ...config,
        tasks: {
          build: config.tasks.build,
          "@orkestrator/backend#build": config.tasks["@orkestrator/backend#build"],
        },
      }),
    );
    await writeFile(
      path.join(fixture, "package.json"),
      JSON.stringify({
        name: "commit-cache-fixture",
        private: true,
        packageManager: `bun@${Bun.version}`,
        workspaces: ["apps/*", "packages/*"],
      }),
    );
    await writeFile(
      path.join(fixture, ".gitignore"),
      "node_modules/\ndist/\n.turbo/\n.executions\n",
    );
    for (const [directory, name] of [
      ["apps/backend", "@orkestrator/backend"],
      ["packages/cli", "orkestrator"],
    ]) {
      const target = path.join(fixture, directory!);
      await mkdir(target, { recursive: true });
      await writeFile(
        path.join(target, "package.json"),
        JSON.stringify({ name, scripts: { build: "bun build.ts" } }),
      );
      await writeFile(
        path.join(target, "build.ts"),
        `
const count = Bun.file(".executions");
await Bun.write(".executions", String((await count.exists() ? Number(await count.text()) : 0) + 1));
await Bun.write("dist/commit.json", JSON.stringify(process.env.ORKESTRATOR_BUILD_COMMIT ?? null));
`,
      );
    }
    await writeFile(
      path.join(fixture, "packages/cli/turbo.json"),
      await readFile(path.join(repositoryRoot, "packages/cli/turbo.json")),
    );
    await run([process.execPath, "install", "--ignore-scripts"]);
    const turbo = [
      path.join(repositoryRoot, "node_modules/.bin/turbo"),
      "run",
      "build",
      "--cache=local:rw",
    ];
    const hashes = async (commit?: string) => {
      const result = JSON.parse(
        await run([...turbo, "--dry=json"], {
          ...env,
          ...(commit ? { ORKESTRATOR_BUILD_COMMIT: commit } : {}),
        }),
      ) as { tasks: Array<{ taskId: string; hash: string }> };
      return Object.fromEntries(result.tasks.map((task) => [task.taskId, task.hash]));
    };
    const build = (commit?: string) =>
      run(turbo, { ...env, ...(commit ? { ORKESTRATOR_BUILD_COMMIT: commit } : {}) });
    const assertArtifacts = async (commit: string | null, executions: number) => {
      for (const directory of ["apps/backend", "packages/cli"]) {
        expect(
          JSON.parse(await readFile(path.join(fixture, directory, "dist/commit.json"), "utf8")),
        ).toBe(commit);
        expect(await readFile(path.join(fixture, directory, ".executions"), "utf8")).toBe(
          String(executions),
        );
      }
    };
    const first = await hashes("abc1234");
    expect(Object.keys(first).sort()).toEqual(["@orkestrator/backend#build", "orkestrator#build"]);
    await build("abc1234");
    await assertArtifacts("abc1234", 1);
    const second = await hashes("def5678");
    for (const task of Object.keys(first)) expect(second[task]).not.toBe(first[task]);
    await build("def5678");
    await assertArtifacts("def5678", 2);
    for (const directory of ["apps/backend", "packages/cli"])
      await rm(path.join(fixture, directory, "dist"), { recursive: true });
    await build("abc1234");
    await assertArtifacts("abc1234", 2);
    await build();
    await assertArtifacts(null, 3);
    const unstamped = await hashes();
    await mkdir(path.join(fixture, "apps/web"));
    await writeFile(path.join(fixture, "apps/web/renderer.ts"), "// unrelated renderer change\n");
    expect(await hashes()).toEqual(unstamped);
    await build();
    await assertArtifacts(null, 3);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}, 60_000);

interface Invocation {
  name: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  deadline?: number;
}

function createDependencies(
  options: {
    exists?: boolean;
    platform?: NodeJS.Platform;
    /** Per-group exit status, keyed by group name. */
    statusByName?: Record<string, number | null>;
    outputByName?: Record<string, string>;
    failureReportsByName?: Record<string, { reports: string[]; omitted?: number }>;
    failingFilesByName?: Record<string, FailingFile[]>;
    /** Groups that end as infrastructure failures (no verdict), keyed by name. */
    infrastructureErrorByName?: Record<string, string>;
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
          timeoutMs: group.timeoutMs,
          deadline: group.deadline,
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
          failureReports: options.failureReportsByName?.[group.name]?.reports,
          omittedFailureReports: options.failureReportsByName?.[group.name]?.omitted,
          failingFiles: options.failingFilesByName?.[group.name],
          ...(options.infrastructureErrorByName && group.name in options.infrastructureErrorByName
            ? { infrastructureError: true, output: options.infrastructureErrorByName[group.name] }
            : {}),
        };
      },
    },
    existsChecks,
    invocations,
    started,
    logs,
  };
}

const WORKSPACE = "workspace (web, backend, desktop, web-public, cli, protocol, toolchain)";
const ROOT = "root and agent-support tests";
const BRIDGES = "bridges";
const PROTOCOL = "codex protocol lockfile";

function isolatedRunnerEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment[TEST_LOG_DIRECTORY_ENV];
  // CI raises the group deadline through this variable, and it takes
  // precedence over a fixture's own timeoutMs.
  delete environment[TEST_GROUP_TIMEOUT_MS_ENV];
  return { ...environment, ...overrides };
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

  test("reports a still-running group so a wrapping watchdog sees progress", async () => {
    let release = () => {};
    const gate = {
      name: WORKSPACE,
      release: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    // The heartbeat is half the no-progress budget, so a 40 ms budget beats
    // every 20 ms while the gated group is the only one left.
    const { dependencies, logs } = createDependencies({
      gate,
      environment: { [TEST_NO_PROGRESS_TIMEOUT_MS_ENV]: "40" },
    });

    const run = runAllTests(dependencies);
    const deadline = Date.now() + 15_000;
    while (!logs.some((line) => line.startsWith("STILL RUNNING")) && Date.now() < deadline) {
      await Bun.sleep(5);
    }
    const heartbeats = logs.filter((line) => line.startsWith("STILL RUNNING"));
    release();
    expect(await run).toBe(0);

    expect(heartbeats.length).toBeGreaterThan(0);
    expect(heartbeats.at(-1)).toContain(WORKSPACE);
    // Finished groups are not reported as running, and nothing beats after the run.
    const lastHeartbeat = heartbeats.at(-1)!;
    expect(lastHeartbeat).not.toContain(ROOT);
    const settledLogCount = logs.length;
    await Bun.sleep(60);
    expect(logs).toHaveLength(settledLogCount);
  }, 30_000);

  test("passes a bounded worker count so concurrent groups cannot oversubscribe", () => {
    const groups = buildConcurrentGroups(10);
    const workspaceGroup = groups.find((group) => group.name === WORKSPACE)!;
    const rootGroup = groups.find((group) => group.name === ROOT)!;
    const bridgeGroup = groups.find((group) => group.name === BRIDGES)!;

    expect(workspaceGroup.args).toContain("--concurrency=2");
    expect(workspaceGroup.env).toEqual({
      [WORKSPACE_WORKERS_ENV]: "2",
      [BACKEND_WORKERS_ENV]: "3",
    });
    expect(rootGroup.args).toContain("--parallel=1");
    expect(rootGroup.args.slice(0, 2)).toEqual(["test", "./tests"]);
    expect(rootGroup.args).toContain("./e2e/agent-testing/artifact-sanitizer.test.ts");
    expect(rootGroup.args).toContain("./e2e/agent-testing/mcp-apply-live-support.test.ts");
    expect(rootGroup.args).toContain("./e2e/agent-testing/mcp-apply-live-safety.test.ts");
    expect(rootGroup.args).toContain("./e2e/agent-testing/idle-observation-live-support.test.ts");
    expect(rootGroup.args).toContain("./e2e/agent-testing/coordinator-mail-tiles.test.ts");
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
    // `bun check && vite build` on every alternation between the two.
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

  test("the default tier leaves slow root tests out and says how to run them", async () => {
    const { dependencies, invocations, logs } = createDependencies();

    expect(await runAllTests(dependencies)).toBe(0);
    const rootArgs = invocations.find((entry) => entry.name === ROOT)!.args;
    expect(rootArgs.slice(0, 2)).toEqual(["test", "./tests"]);
    for (const pattern of SLOW_TESTS["."]!)
      expect(rootArgs).toContain(`--path-ignore-patterns=${pattern}`);
    expect(logs.some((line) => line.includes("mise run test:slow"))).toBe(true);
  });

  describe("the guard stage", () => {
    /** Dependencies whose guard stage records when it ran and returns `status`. */
    function withGuards(status: number, environment: NodeJS.ProcessEnv = {}) {
      const created = createDependencies({
        environment: { TEST_ALL_MARKER: "preserved", ...environment },
      });
      const guardRuns: { group: TestGroup; startedGroups: number }[] = [];
      created.dependencies.runGuards = async (group) => {
        guardRuns.push({ group, startedGroups: created.started.length });
        return {
          status,
          output: status === 0 ? "" : "FAIL dom-absence\nGuards failed: dom-absence",
        };
      };
      return { ...created, guardRuns };
    }

    test("runs first, before any group, and the root group then skips the files it ran", async () => {
      const { dependencies, guardRuns, invocations } = withGuards(0);

      expect(await runAllTests(dependencies)).toBe(0);
      expect(guardRuns).toEqual([{ group: GUARD_STAGE, startedGroups: 0 }]);
      expect(GUARD_STAGE.args).toEqual(["scripts/guards.ts"]);
      expect(invocations.map((entry) => entry.name).sort()).toEqual(
        [WORKSPACE, ROOT, BRIDGES, PROTOCOL].sort(),
      );
      const rootArgs = invocations.find((entry) => entry.name === ROOT)!.args;
      for (const file of GUARD_STAGE_TEST_FILES)
        expect(rootArgs).toContain(`--path-ignore-patterns=${file}`);
    });

    test("a failure stops the run before any group is admitted and says how to skip it", async () => {
      const { dependencies, guardRuns, invocations, logs } = withGuards(1);

      expect(await runAllTests(dependencies)).toBe(1);
      expect(guardRuns).toHaveLength(1);
      expect(invocations).toHaveLength(0);
      const output = logs.join("\n");
      expect(output).toContain("FAIL guards");
      expect(output).toContain("Guards failed: dom-absence");
      expect(output).toContain("no test group was started");
      expect(output).toContain(`${TEST_SKIP_GUARDS_ENV}=1`);
    });

    test(`${TEST_SKIP_GUARDS_ENV}=1 skips it and keeps its files in the root group`, async () => {
      const { dependencies, guardRuns, invocations } = withGuards(1, {
        [TEST_SKIP_GUARDS_ENV]: "1",
      });

      expect(await runAllTests(dependencies)).toBe(0);
      expect(guardRuns).toHaveLength(0);
      const rootArgs = invocations.find((entry) => entry.name === ROOT)!.args;
      for (const file of GUARD_STAGE_TEST_FILES)
        expect(rootArgs).not.toContain(`--path-ignore-patterns=${file}`);
    });

    test("runs only with the root group, and not in the slow tier", async () => {
      for (const environment of [
        { [TEST_GROUPS_ENV]: "backend" },
        { [TEST_GROUPS_ENV]: "workspace,bridges,codex-protocol" },
        { [TEST_TIER_ENV]: "slow" },
      ]) {
        const { dependencies, guardRuns } = withGuards(1, environment);
        expect(await runAllTests(dependencies)).toBe(0);
        expect(guardRuns).toHaveLength(0);
      }
      const { dependencies, guardRuns } = withGuards(0, {
        [TEST_GROUPS_ENV]: "root,bridges,codex-protocol",
        [TEST_TIER_ENV]: "all",
      });
      expect(await runAllTests(dependencies)).toBe(0);
      expect(guardRuns).toHaveLength(1);
    });

    test("a substituted group runner without a guard runner runs no guard stage", async () => {
      const { dependencies, invocations } = createDependencies();
      expect(await runAllTests(dependencies)).toBe(0);
      expect(invocations.map((entry) => entry.name)).not.toContain(GUARD_STAGE.name);
    });
  });

  test("the slow tier runs only slow root files and skips the protocol check", () => {
    const groups = buildConcurrentGroups(8, false, undefined, "slow");
    expect(groups.map((group) => group.name)).not.toContain(PROTOCOL);
    const rootArgs = groups.find((group) => group.name === ROOT)!.args;
    expect(rootArgs).not.toContain("./tests");
    expect(rootArgs).toContain("./tests/unit/firewall-policy.test.ts");
    expect(rootArgs.some((argument) => argument.startsWith("--path-ignore-patterns"))).toBe(false);
  });

  test("the full tier runs every root test", () => {
    const rootArgs = buildConcurrentGroups(8, false, undefined, "all").find(
      (group) => group.name === ROOT,
    )!.args;
    expect(rootArgs.slice(0, 2)).toEqual(["test", "./tests"]);
    expect(rootArgs.some((argument) => argument.startsWith("--path-ignore-patterns"))).toBe(false);
  });

  test("an unknown tier fails before any group starts", async () => {
    const { dependencies, invocations, logs } = createDependencies({
      environment: { [TEST_TIER_ENV]: "quick" },
    });

    expect(await runAllTests(dependencies)).toBe(75);
    expect(invocations).toHaveLength(0);
    expect(logs.join("\n")).toContain("ORKESTRATOR_TEST_TIER must be one of");
  });

  test("a group selection runs only the named groups", async () => {
    const { dependencies, invocations } = createDependencies({
      environment: { [TEST_GROUPS_ENV]: " root, bridges ,codex-protocol" },
    });

    expect(await runAllTests(dependencies)).toBe(0);
    expect(invocations.map((entry) => entry.name).sort()).toEqual([BRIDGES, PROTOCOL, ROOT].sort());
  });

  test("an unknown or empty group selection fails before any group starts", async () => {
    for (const value of ["backend,web", ","]) {
      const { dependencies, invocations, logs } = createDependencies({
        environment: { [TEST_GROUPS_ENV]: value },
      });

      expect(await runAllTests(dependencies)).toBe(75);
      expect(invocations).toHaveLength(0);
      expect(logs.join("\n")).toContain(`${TEST_GROUPS_ENV} must list groups from`);
    }
  });

  test("the CI matrix dispatches all-tier shards on four-core hosts and propagates failures", async () => {
    const workflow = Bun.YAML.parse(
      await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
    ) as {
      jobs: { "test-shard": { strategy: { matrix: { include: { groups: string }[] } } } };
    };
    const expectedNames = [
      ["backend"],
      ["workspace (web, desktop, web-public, cli, protocol, toolchain)"],
      [ROOT, BRIDGES, PROTOCOL],
    ];
    const shards = workflow.jobs["test-shard"].strategy.matrix.include;
    expect(shards).toHaveLength(expectedNames.length);

    for (const [index, shard] of shards.entries()) {
      const names = expectedNames[index]!;
      // Fail each constituent in turn: a successful sibling must never mask it.
      for (const failedGroup of [undefined, ...names]) {
        const { dependencies, invocations } = createDependencies({
          cores: 4,
          environment: { [TEST_GROUPS_ENV]: shard.groups, [TEST_TIER_ENV]: "all" },
          statusByName: failedGroup ? { [failedGroup]: 1 } : undefined,
        });
        expect(await runAllTests(dependencies)).toBe(failedGroup ? 1 : 0);
        expect(invocations.map((entry) => entry.name)).toEqual(names);
        for (const invocation of invocations) {
          expect(invocation.env[TEST_TIER_ENV]).toBe("all");
          if (invocation.name === "backend") {
            expect(invocation.env[BACKEND_WORKERS_ENV]).toBe("2");
            expect(invocation.args).toContain("--filter=@orkestrator/backend");
          } else if (invocation.name === names[0] && index === 1) {
            expect(invocation.env[WORKSPACE_WORKERS_ENV]).toBe("1");
            expect(invocation.args).not.toContain("--filter=@orkestrator/backend");
          } else if (invocation.name === ROOT) {
            expect(invocation.args).toContain("--parallel=1");
            expect(invocation.args).not.toContain("--path-ignore-patterns");
          } else if (invocation.name === BRIDGES) {
            expect(invocation.env[WORKSPACE_WORKERS_ENV]).toBe("1");
            expect(invocation.args).toContain("--concurrency=2");
          }
        }
      }
    }
  });

  test("a selection with no group in the tier is incomplete, not a pass", async () => {
    const { dependencies, invocations, logs } = createDependencies({
      environment: { [TEST_GROUPS_ENV]: "codex-protocol", [TEST_TIER_ENV]: "slow" },
    });

    expect(await runAllTests(dependencies)).toBe(75);
    expect(invocations).toHaveLength(0);
    expect(logs.join("\n")).toContain("selects no slow-tier test groups");
  });

  test("backend and workspace selections split the workspace group by package", () => {
    const groupsFor = (keys: (typeof TEST_GROUP_KEYS)[number][], cores = 4, tier?: "all") =>
      buildConcurrentGroups(cores, false, undefined, tier, new Set(keys));
    const filters = (group: TestGroup) =>
      group.args.filter((argument) => argument.startsWith("--filter="));

    const combined = buildConcurrentGroups(8).find((group) => group.name === WORKSPACE)!;
    // Selecting both is exactly the default combined group.
    expect(groupsFor(["backend", "workspace"], 8)).toEqual(
      buildConcurrentGroups(8).filter((group) => group.name === WORKSPACE),
    );

    const [backend] = groupsFor(["backend"]);
    expect(backend!.name).toBe("backend");
    expect(filters(backend!)).toEqual(["--filter=@orkestrator/backend"]);
    expect(backend!.args).toContain("--concurrency=1");

    const [workspace] = groupsFor(["workspace"]);
    expect(workspace!.name).toBe("workspace (web, desktop, web-public, cli, protocol, toolchain)");
    expect(filters(workspace!)).not.toContain("--filter=@orkestrator/backend");
    // Together the two halves cover every package of the combined group.
    expect([...filters(backend!), ...filters(workspace!)].sort()).toEqual(filters(combined).sort());
    expect(workspace!.args).toContain("--concurrency=1");
    expect(workspace!.workers).toBe(planWorkers(4).workspace);
  });

  test("a backend-only run uses its host, leaving one core and the tier ceiling", () => {
    const backendOnly = (cores: number, tier: "default" | "all") =>
      buildConcurrentGroups(cores, false, undefined, tier, new Set(["backend"] as const))[0]!;

    // On a four-core CI shard the shared plan gave the backend one worker.
    expect(planWorkers(4, "all").backend).toBe(1);
    expect(backendOnly(4, "all").env?.[BACKEND_WORKERS_ENV]).toBe(
      String(MAX_SLOW_BACKEND_TEST_WORKERS),
    );
    expect(backendOnly(4, "default").env?.[BACKEND_WORKERS_ENV]).toBe("3");
    expect(backendOnly(4, "default").workers).toBe(3);
    expect(backendOnly(64, "default").env?.[BACKEND_WORKERS_ENV]).toBe(
      String(MAX_BACKEND_TEST_WORKERS),
    );
    expect(backendOnly(1, "default").env?.[BACKEND_WORKERS_ENV]).toBe("1");

    // Beside another group it keeps the shared plan.
    const shared = buildConcurrentGroups(
      4,
      false,
      undefined,
      "all",
      new Set(["backend", "root"] as const),
    ).find((group) => group.name === "backend")!;
    expect(shared.env?.[BACKEND_WORKERS_ENV]).toBe(String(planWorkers(4, "all").backend));
  });

  test("removes the ambient bridge diagnostics flag from every aggregate group", async () => {
    const { dependencies, invocations } = createDependencies({
      environment: {
        TEST_ALL_MARKER: "preserved",
        ORKESTRATOR_BRIDGE_DEBUG: "1",
      },
    });

    await runAllTests(dependencies);
    for (const invocation of invocations) {
      expect(invocation.env.TEST_ALL_MARKER).toBe("preserved");
      expect(invocation.env.ORKESTRATOR_BRIDGE_DEBUG).toBeUndefined();
    }
    expect(dependencies.env.ORKESTRATOR_BRIDGE_DEBUG).toBe("1");
  });

  test("removes an ambient NODE_ENV so every Bun test group defaults to test", async () => {
    const { dependencies, invocations } = createDependencies({
      environment: { NODE_ENV: "production" },
    });

    await runAllTests(dependencies);
    expect(invocations.length).toBeGreaterThan(0);
    for (const invocation of invocations) expect(invocation.env.NODE_ENV).toBeUndefined();
    expect(dependencies.env.NODE_ENV).toBe("production");
  });

  test("removes an inherited build commit before the workspace build and every test group", async () => {
    const { dependencies, invocations } = createDependencies({
      environment: { ORKESTRATOR_BUILD_COMMIT: "abc1234", TEST_ALL_MARKER: "preserved" },
    });
    expect(await runAllTests(dependencies)).toBe(0);
    expect(invocations.some((invocation) => invocation.name === WORKSPACE)).toBe(true);
    for (const invocation of invocations) {
      expect(invocation.env).not.toHaveProperty("ORKESTRATOR_BUILD_COMMIT");
      expect(invocation.env.TEST_ALL_MARKER).toBe("preserved");
    }
    expect(dependencies.env.ORKESTRATOR_BUILD_COMMIT).toBe("abc1234");
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
      const aggregate = 1 + plan.root + plan.bridges + plan.workspace * plan.workspaceConcurrency;

      // Exactly the budget, everywhere: `root` absorbs the integer-division
      // remainder, so the plan neither oversubscribes nor leaves workers idle.
      expect({ cores, aggregate }).toEqual({ cores, aggregate: budget });
      expect(plan.root).toBeGreaterThanOrEqual(1);
      expect(plan.root).toBeLessThanOrEqual(4);
      expect(plan.bridges).toBeGreaterThanOrEqual(MIN_BRIDGE_WORKERS);
      expect(plan.workspace).toBeGreaterThanOrEqual(1);
      expect(plan.workspaceConcurrency).toBeGreaterThanOrEqual(1);
      expect(plan.workspaceConcurrency).toBeLessThanOrEqual(3);
      expect(plan.backend).toBeGreaterThanOrEqual(plan.workspace);
      expect(plan.backend).toBeLessThanOrEqual(Math.max(plan.workspace, MAX_BACKEND_TEST_WORKERS));
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

  test("package tasks receive bounded additional large-host capacity", () => {
    // Backend integration suites run in the backend package, which made it the
    // long pole once each package task was limited to one worker.
    const large = planWorkers(20);
    expect(large.workspace).toBe(2);
    expect(large.workspaceConcurrency).toBe(2);
    expect(large.root).toBe(1);
    expect(1 + large.root + large.bridges + large.workspace * large.workspaceConcurrency).toBe(
      MAX_AGGREGATE_TEST_WORKERS,
    );
    // Beyond the cap the UI plan is constant: more cores must not multiply peak heap.
    const { backend: _large, ...largeUi } = planWorkers(64);
    const { backend: _capped, ...cappedUi } = planWorkers(MAX_AGGREGATE_TEST_WORKERS);
    expect(largeUi).toEqual(cappedUi);
  });

  test("the backend package is capped at four workers on large hosts", async () => {
    // Its subprocess and wall-clock suites run in the slow tier, so the rest
    // can use a larger pool without starving port-reservation fixtures.
    expect(planWorkers(4).backend).toBe(planWorkers(4).workspace);
    expect(MAX_BACKEND_TEST_WORKERS).toBe(4);
    expect(planWorkers(8).backend).toBe(2);
    expect(planWorkers(12).backend).toBe(4);
    expect(planWorkers(18).backend).toBe(MAX_BACKEND_TEST_WORKERS);
    expect(planWorkers(64).backend).toBe(MAX_BACKEND_TEST_WORKERS);

    const workspace = buildConcurrentGroups(18).find((group) => group.name === WORKSPACE)!;
    // The backend task fills one concurrent slot; the other keeps its usual pool.
    expect(workspace.workers).toBe(MAX_BACKEND_TEST_WORKERS + planWorkers(18).workspace);
    expect(workspace.env?.[BACKEND_WORKERS_ENV]).toBe(String(MAX_BACKEND_TEST_WORKERS));
    expect(workspace.env?.[WORKSPACE_WORKERS_ENV]).toBe(String(planWorkers(18).workspace));
    // A reservation never exceeds the capacity it is granted.
    expect(buildConcurrentGroups(1).find((group) => group.name === WORKSPACE)!.workers).toBe(1);

    const manifest = JSON.parse(
      await readFile(path.join(import.meta.dir, "../../apps/backend/package.json"), "utf8"),
    );
    expect(manifest.scripts["test:workspace"]).toContain(
      `--parallel=\${${BACKEND_WORKERS_ENV}:-\${${WORKSPACE_WORKERS_ENV}:-2}}`,
    );
  });

  test.each(["slow", "all"] as const)(
    "%s keeps real-process backend suites within their two-worker ceiling",
    (tier) => {
      for (const cores of [1, 4, 8, 12, 18, 64]) {
        const plan = planWorkers(cores, tier);
        expect(plan.backend).toBeLessThanOrEqual(MAX_SLOW_BACKEND_TEST_WORKERS);
        const workspace = buildConcurrentGroups(cores, false, undefined, tier).find(
          (group) => group.name === WORKSPACE,
        )!;
        expect(workspace.env?.[BACKEND_WORKERS_ENV]).toBe(String(plan.backend));
        expect(workspace.workers).toBe(
          Math.min(cores, plan.backend + plan.workspace * (plan.workspaceConcurrency - 1)),
        );
      }
      expect(planWorkers(18, tier).backend).toBe(2);
      expect(planWorkers(18, "default").backend).toBe(4);
    },
  );

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
    expect(workspaceGroup.args.slice(0, 4)).toEqual(["turbo", "run", "build", "test:workspace"]);
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

  test("Turbo groups stream output and report every failing package", () => {
    // A four-core CI runner plans one Bun worker per package, where grouped CI
    // output starved the no-progress watchdog and a first failure hid the rest.
    for (const cores of [4, 8]) {
      const turboGroups = buildConcurrentGroups(cores).filter((group) => group.args[0] === "turbo");
      expect(turboGroups.map((group) => group.name).sort()).toEqual([BRIDGES, WORKSPACE].sort());
      for (const group of turboGroups) {
        for (const flag of TURBO_GROUP_OUTPUT_FLAGS) expect(group.args).toContain(flag);
      }
    }
    expect(TURBO_GROUP_OUTPUT_FLAGS).toContain("--log-order=stream");
    expect(TURBO_GROUP_OUTPUT_FLAGS).toContain("--continue=dependencies-successful");
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

  test("hands the durations directory to every group, not only the root arguments", async () => {
    // Workspace and bridge packages name their own durations file from this
    // variable inside their `test:workspace` / `test:bridge` script, so it has
    // to survive into each group's environment.
    const timingsDirectory = "/tmp/orkestrator-timings-fixture";
    const { dependencies, invocations } = createDependencies({
      environment: { TEST_ALL_MARKER: "preserved", [TEST_TIMINGS_DIRECTORY_ENV]: timingsDirectory },
    });

    expect(await runAllTests(dependencies)).toBe(0);
    expect(invocations.length).toBeGreaterThan(0);
    for (const invocation of invocations) {
      expect(invocation.env[TEST_TIMINGS_DIRECTORY_ENV]).toBe(timingsDirectory);
    }
    expect(invocations.find((entry) => entry.name === ROOT)?.args).toContain(
      path.join(timingsDirectory, "root.json"),
    );
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

  test("lists every failure report of a failing group after its tail", async () => {
    const { dependencies, logs } = createDependencies({
      statusByName: { [ROOT]: 1 },
      outputByName: { [ROOT]: "only the tail" },
      failureReportsByName: {
        [ROOT]: { reports: ["error: lost\n(fail) suite > lost case [1.00ms]"], omitted: 2 },
        [BRIDGES]: { reports: ["(fail) never printed for a passing group"] },
      },
    });

    await runAllTests(dependencies);
    const report = logs.join("\n");
    const tailAt = report.indexOf("only the tail");
    const listAt = report.indexOf(`--- Failing tests in ${ROOT}: 3 (first 1 shown) ---`);
    expect(tailAt).toBeGreaterThan(-1);
    expect(listAt).toBeGreaterThan(tailAt);
    expect(report.indexOf("(fail) suite > lost case [1.00ms]")).toBeGreaterThan(listAt);
    expect(report).not.toContain("never printed for a passing group");
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

  test("default runner keeps failure reports the output tail has dropped", async () => {
    const noiseLines = Math.ceil(MAX_GROUP_OUTPUT_TAIL_BYTES / "noise\n".length) + 1_000;
    const result = await defaultRunGroup(
      {
        name: "noisy failure fixture",
        command: process.execPath,
        args: [
          "-e",
          `process.stdout.write("error: expect(received).toBe(expected)\\n(fail) suite > lost case [1.00ms]\\n" + "noise\\n".repeat(${noiseLines})); process.exitCode = 1;`,
        ],
      },
      isolatedRunnerEnvironment(),
    );

    expect(result.status).toBe(1);
    expect(result.output).not.toContain("(fail)");
    expect(result.failureReports).toEqual([
      "error: expect(received).toBe(expected)\n(fail) suite > lost case [1.00ms]",
    ]);
    if (result.logPath) await rm(path.dirname(result.logPath), { recursive: true, force: true });
  });

  test("default runner caps each tail line so one huge line cannot hide the summary", async () => {
    const result = await defaultRunGroup(
      {
        name: "huge line fixture",
        command: process.execPath,
        args: [
          "-e",
          `process.stdout.write("x".repeat(${MAX_CONSOLE_TAIL_LINE_CHARS + 500}) + "\\nafter\\n"); process.exitCode = 1;`,
        ],
      },
      isolatedRunnerEnvironment(),
    );

    const lines = result.output?.split("\n") ?? [];
    expect(lines[0]).toBe(
      `${"x".repeat(MAX_CONSOLE_TAIL_LINE_CHARS)}… [500 more characters in the group log]`,
    );
    expect(lines[1]).toBe("after");
    if (result.logPath) {
      expect((await readFile(result.logPath, "utf8")).split("\n")[0]).toHaveLength(
        MAX_CONSOLE_TAIL_LINE_CHARS + 500,
      );
      await rm(path.dirname(result.logPath), { recursive: true, force: true });
    }
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

  test("gives a slow group far more headroom than the slowest run ever recorded", () => {
    // The workspace group has been measured at roughly four minutes on a cold
    // cache. A deadline anywhere near that turns a slow run into a reported
    // failure, so the budget has to be a multiple of it, not a margin on it.
    const slowestRecordedGroupMs = 4 * 60 * 1_000;
    expect(DEFAULT_TEST_GROUP_TIMEOUT_MS).toBeGreaterThanOrEqual(slowestRecordedGroupMs * 4);
    expect(DEFAULT_TEST_NO_PROGRESS_TIMEOUT_MS).toBeGreaterThanOrEqual(5 * 60 * 1_000);
    // A group only ever goes quiet for a whole no-progress window if it is
    // wedged, so that window must stay well inside the absolute deadline.
    expect(DEFAULT_TEST_NO_PROGRESS_TIMEOUT_MS).toBeLessThan(DEFAULT_TEST_GROUP_TIMEOUT_MS);
    expect(IOS_GROUP_TIMEOUT_MS).toBeGreaterThan(DEFAULT_TEST_GROUP_TIMEOUT_MS);
  });

  test("gives the simulator group its own deadline rather than the Bun default", async () => {
    const { dependencies, invocations } = createDependencies({
      exists: true,
      platform: "darwin",
      environment: { [INCLUDE_IOS_TESTS_ENV]: "1" },
    });

    expect(await runAllTests(dependencies)).toBe(0);
    const ios = invocations.find((entry) => entry.name === "ios");
    expect(ios?.timeoutMs).toBe(IOS_GROUP_TIMEOUT_MS);
    // Every Bun group keeps the shared default, which stays implicit.
    for (const entry of invocations.filter((candidate) => candidate.name !== "ios")) {
      expect(entry.timeoutMs).toBeUndefined();
    }
  });

  test("honours a per-group deadline and lets the environment override it", async () => {
    const busyFixture = {
      name: "per-group deadline fixture",
      command: process.execPath,
      args: ["-e", "setInterval(() => process.stdout.write('.'), 10)"],
      timeoutMs: 75,
    };
    const viaGroup = await defaultRunGroup(busyFixture, isolatedRunnerEnvironment());
    expect(viaGroup.timeoutReason).toBe("absolute");
    expect(viaGroup.output).toContain("Exceeded the 75ms group deadline");
    if (viaGroup.logPath)
      await rm(path.dirname(viaGroup.logPath), { recursive: true, force: true });

    const viaEnvironment = await defaultRunGroup(
      busyFixture,
      isolatedRunnerEnvironment({ [TEST_GROUP_TIMEOUT_MS_ENV]: "40" }),
    );
    expect(viaEnvironment.output).toContain("Exceeded the 40ms group deadline");
    if (viaEnvironment.logPath) {
      await rm(path.dirname(viaEnvironment.logPath), { recursive: true, force: true });
    }
  });

  test("an interrupt can reach descendants the group spawned, not just the group", async () => {
    // Groups are spawned detached, so Ctrl+C no longer reaches them and the
    // runner has to relay it across the whole process tree. A grandchild is the
    // case that matters: Bun workers and fixture servers all live at that depth.
    const directory = await mkdtemp(path.join(os.tmpdir(), "ork-tree-terminate-"));
    const pidFile = path.join(directory, "grandchild.pid");
    const grandchild = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      process.stdout.write("spawned\\n");
      setInterval(() => {}, 1000);
    `;
    try {
      const run = defaultRunGroup(
        { name: "tree fixture", command: process.execPath, args: ["-e", grandchild] },
        isolatedRunnerEnvironment(),
      );

      const deadline = Date.now() + 5_000;
      let grandchildPid = 0;
      while (!grandchildPid && Date.now() < deadline) {
        grandchildPid = Number(await readFile(pidFile, "utf8").catch(() => 0));
        if (!grandchildPid) await Bun.sleep(10);
      }
      expect(grandchildPid).toBeGreaterThan(0);

      expect(terminateActiveGroups("SIGKILL")).toBeGreaterThan(0);
      const result = await run;
      expect(result.status).not.toBe(0);

      let alive = true;
      const grandchildDeadline = Date.now() + 5_000;
      while (alive && Date.now() < grandchildDeadline) {
        try {
          process.kill(grandchildPid, 0);
          await Bun.sleep(10);
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
      // A finished group must stop being a signal target.
      expect(terminateActiveGroups("SIGKILL")).toBe(0);
      if (result.logPath) await rm(path.dirname(result.logPath), { recursive: true, force: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
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

describe("rerunning failing test files alone", () => {
  const WEB = "@orkestrator/web:test:workspace: ";
  const resolveRerun = (taskPrefix: string) =>
    taskPrefix === ""
      ? { directory: ".", flags: ["--parallel=1"] }
      : taskPrefix === WEB
        ? { directory: "apps/web", flags: ["--only-failures", "--parallel=1"] }
        : undefined;

  test("the collector names each failing file once, with the task that ran it", () => {
    const collector = new FailureReportCollector();
    collector.push(
      Buffer.from(
        [
          "tests/unit/a.test.ts:",
          "error: expect(received).toBe(expected)",
          "(fail) a > one [1.00ms]",
          "(fail) a > two [1.00ms]",
          `${WEB}src/b.test.tsx:`,
          "tests/unit/c.test.ts:",
          `${WEB}(fail) b > one [2.00ms]`,
          "(fail) c > one [1.00ms]",
          "./tests/unit/d.spec.ts:",
          "(fail) d > one",
          "",
        ].join("\n"),
      ),
    );
    collector.finish();
    expect(collector.failingFiles).toEqual([
      { taskPrefix: "", file: "tests/unit/a.test.ts" },
      { taskPrefix: WEB, file: "src/b.test.tsx" },
      { taskPrefix: "", file: "tests/unit/c.test.ts" },
      { taskPrefix: "", file: "tests/unit/d.spec.ts" },
    ]);
  });

  test("the collector reads Bun's GitHub Actions group header as the file, not a path", () => {
    const BACKEND = "@orkestrator/backend:test:workspace: ";
    const collector = new FailureReportCollector();
    collector.push(
      Buffer.from(
        [
          `${BACKEND}::group::tests/a.test.ts:`,
          `${BACKEND}error: expect(received).toBe(expected)`,
          `${BACKEND}(fail) a > one [1.00ms]`,
          `${BACKEND}::endgroup::`,
          "::group::tests/unit/b.test.ts:",
          "(fail) b > one [1.00ms]",
          "",
        ].join("\n"),
      ),
    );
    collector.finish();
    expect(collector.failingFiles).toEqual([
      { taskPrefix: BACKEND, file: "tests/a.test.ts" },
      { taskPrefix: "", file: "tests/unit/b.test.ts" },
    ]);
  });

  test("a package's flags keep its preloads and drop worker counts and timings", () => {
    expect(
      rerunFlags(
        "bun --no-env-file ../../scripts/bun-test-tier.ts apps/backend src tests -- --preload ../../tests/setup-node.ts --only-failures ${ORKESTRATOR_TEST_TIMINGS_DIR:+--timings=$ORKESTRATOR_TEST_TIMINGS_DIR/backend.json --update-timings} --parallel=${ORKESTRATOR_BACKEND_TEST_WORKERS:-2}",
      ),
    ).toEqual(["--preload", "../../tests/setup-node.ts", "--only-failures", "--parallel=1"]);
    const resolve = packageRerunTargets(path.resolve(import.meta.dir, "../.."));
    expect(resolve("")).toEqual({ directory: ".", flags: ["--parallel=1"] });
    expect(resolve("@orkestrator/backend:test:workspace: ")).toEqual({
      directory: "apps/backend",
      flags: ["--preload", "../../tests/setup-node.ts", "--only-failures", "--parallel=1"],
    });
    expect(resolve("claude-bridge:test:bridge: ")?.directory).toBe("bridges/claude-bridge");
    expect(resolve("@orkestrator/web:build: ")).toBeUndefined();
  });

  test("classifies each failing file by a lone rerun and keeps the run failing", async () => {
    const { dependencies, invocations, logs } = createDependencies({
      statusByName: {
        [ROOT]: 1,
        [WORKSPACE]: 1,
        "rerun tests/unit/flaky.test.ts": 0,
        "rerun apps/web/src/broken.test.tsx": 1,
      },
      failingFilesByName: {
        [ROOT]: [{ taskPrefix: "", file: "tests/unit/flaky.test.ts" }],
        [WORKSPACE]: [
          { taskPrefix: WEB, file: "src/broken.test.tsx" },
          { taskPrefix: "@orkestrator/web:build: ", file: "src/odd.test.ts" },
        ],
      },
    });
    dependencies.rerunFailedFiles = true;
    dependencies.resolveRerun = resolveRerun;

    expect(await runAllTests(dependencies)).toBe(1);
    const reruns = invocations.filter((entry) => entry.name.startsWith("rerun "));
    expect(reruns.map((entry) => [entry.name, entry.args])).toEqual([
      [
        "rerun apps/web/src/broken.test.tsx",
        ["test", "./src/broken.test.tsx", "--only-failures", "--parallel=1"],
      ],
      ["rerun tests/unit/flaky.test.ts", ["test", "./tests/unit/flaky.test.ts", "--parallel=1"]],
    ]);
    const output = logs.join("\n");
    expect(output).toContain("PASSED ALONE  tests/unit/flaky.test.ts");
    expect(output).toContain("docs/tests/flaky-tests");
    expect(output).toContain("FAILED ALONE  apps/web/src/broken.test.tsx");
    expect(output).toContain(
      'Cannot rerun src/odd.test.ts alone: no suite for "@orkestrator/web:build:"',
    );
    expect(output).toContain("The run still fails");
  });

  test("every rerun carries the budget's absolute deadline, and one that never ran keeps the run failing", async () => {
    const queued = "Group deadline passed while waiting for host capacity; tests did not run";
    const { dependencies, invocations, logs } = createDependencies({
      statusByName: { [ROOT]: 1, "rerun tests/unit/queued.test.ts": 75 },
      failingFilesByName: {
        [ROOT]: [
          { taskPrefix: "", file: "tests/unit/queued.test.ts" },
          { taskPrefix: "", file: "tests/unit/next.test.ts" },
        ],
      },
      infrastructureErrorByName: { "rerun tests/unit/queued.test.ts": queued },
    });
    dependencies.rerunFailedFiles = true;
    dependencies.resolveRerun = resolveRerun;

    const before = Date.now();
    expect(await runAllTests(dependencies)).toBe(1);
    const after = Date.now();
    const reruns = invocations.filter((entry) => entry.name.startsWith("rerun "));
    expect(reruns).toHaveLength(2);
    // One deadline for the whole budget, not a fresh one per file, so a
    // queue wait for one file is charged against every later one.
    expect(new Set(reruns.map((entry) => entry.deadline)).size).toBe(1);
    const deadline = reruns[0]!.deadline!;
    expect(deadline).toBeGreaterThanOrEqual(before + RERUN_TIME_BUDGET_MS);
    expect(deadline).toBeLessThanOrEqual(after + RERUN_TIME_BUDGET_MS);
    for (const entry of reruns) expect(entry.timeoutMs).toBeLessThanOrEqual(RERUN_FILE_TIMEOUT_MS);
    const output = logs.join("\n");
    expect(output).toContain("INCOMPLETE    tests/unit/queued.test.ts");
    expect(output).toContain("The run still fails");
  });

  test(`reruns at most ${MAX_RERUN_FILES} files, and none with ${TEST_RERUN_FAILED_ENV}=0`, async () => {
    const failingFiles = Array.from({ length: MAX_RERUN_FILES + 3 }, (_, index) => ({
      taskPrefix: "",
      file: `tests/unit/f${index}.test.ts`,
    }));
    const capped = createDependencies({
      statusByName: { [ROOT]: 1 },
      failingFilesByName: { [ROOT]: failingFiles },
    });
    capped.dependencies.rerunFailedFiles = true;
    capped.dependencies.resolveRerun = resolveRerun;
    expect(await runAllTests(capped.dependencies)).toBe(1);
    expect(capped.invocations.filter((entry) => entry.name.startsWith("rerun "))).toHaveLength(
      MAX_RERUN_FILES,
    );
    expect(capped.logs.join("\n")).toContain(
      `(${MAX_RERUN_FILES} of ${MAX_RERUN_FILES + 3}; at most`,
    );

    const off = createDependencies({
      environment: { [TEST_RERUN_FAILED_ENV]: "0" },
      statusByName: { [ROOT]: 1 },
      failingFilesByName: { [ROOT]: failingFiles },
    });
    off.dependencies.rerunFailedFiles = true;
    off.dependencies.resolveRerun = resolveRerun;
    expect(await runAllTests(off.dependencies)).toBe(1);
    expect(off.invocations.some((entry) => entry.name.startsWith("rerun "))).toBe(false);
  });
});

describe("FailureReportCollector", () => {
  const web = "@orkestrator/web:test:workspace: ";
  const backend = "@orkestrator/backend:test:workspace: ";

  test("keeps each failing task's own preceding lines across interleaved, split chunks", () => {
    const collector = new FailureReportCollector();
    const output = Buffer.from(
      [
        `${web}error: expect(received).toBe(expected)`,
        `${backend}[backend] unrelated noise`,
        `${web}Expected: 1`,
        `${web}Received: 2`,
        `${web}(fail) Widget > renders [12.00ms]`,
        `${backend}(fail) Store > saves [5001.00ms]`,
        `${backend}  ^ this test timed out after 5000ms.`,
        "\u001b[31m(fail)\u001b[0m root > colored [1.00ms]",
        "",
      ].join("\n"),
    );
    for (let at = 0; at < output.byteLength; at += 7) collector.push(output.subarray(at, at + 7));
    collector.finish();

    expect(collector.reports).toEqual([
      [
        `${web}error: expect(received).toBe(expected)`,
        `${web}Expected: 1`,
        `${web}Received: 2`,
        `${web}(fail) Widget > renders [12.00ms]`,
      ].join("\n"),
      [
        `${backend}[backend] unrelated noise`,
        `${backend}(fail) Store > saves [5001.00ms]`,
        `${backend}  ^ this test timed out after 5000ms.`,
      ].join("\n"),
      "(fail) root > colored [1.00ms]",
    ]);
  });

  test("bounds each report's context and counts failures past the report limit", () => {
    const collector = new FailureReportCollector();
    const lines = Array.from(
      { length: FAILURE_REPORT_CONTEXT_LINES + 10 },
      (_, index) => `noise ${index}`,
    );
    lines.push("(fail) first [1.00ms]");
    for (let index = 0; index < MAX_FAILURE_REPORTS + 2; index++) {
      lines.push(`(fail) extra ${index} [1.00ms]`);
    }
    collector.push(Buffer.from(`${lines.join("\n")}\n`));
    collector.finish();

    const first = collector.reports[0]!.split("\n");
    expect(first).toHaveLength(FAILURE_REPORT_CONTEXT_LINES + 1);
    expect(first[0]).toBe("noise 10");
    expect(collector.reports).toHaveLength(MAX_FAILURE_REPORTS);
    expect(collector.omitted).toBe(3);
  });

  test("ignores a mention of (fail) that is not Bun's failure line", () => {
    const collector = new FailureReportCollector();
    collector.push(Buffer.from(`${web}a log line that quotes "(fail) something"\n`));
    collector.finish();
    expect(collector.reports).toEqual([]);
  });
});
