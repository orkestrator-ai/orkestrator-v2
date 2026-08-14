import { describe, expect, test } from "bun:test";
import {
  ALLOW_MISSING_PROTOCOL_BINARY_ENV,
  buildConcurrentGroups,
  defaultRunGroup,
  main,
  MAX_AGGREGATE_TEST_WORKERS,
  MIN_AGGREGATE_TEST_WORKERS,
  MIN_BRIDGE_WORKERS,
  planWorkers,
  runAllTests,
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
    expect(invocations.find((entry) => entry.name === BRIDGES)?.env).toEqual(dependencies.env);
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
    // Let the other groups start while the workspace group is still blocked.
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Sequential execution would have started only the first group by now.
    expect(started).toContain(ROOT);
    expect(started).toContain(BRIDGES);
    expect(started).toContain(PROTOCOL);

    release();
    expect(await run).toBe(0);
  });

  test("passes a bounded worker count so concurrent groups cannot oversubscribe", () => {
    const groups = buildConcurrentGroups(10);
    const workspaceGroup = groups.find((group) => group.name === WORKSPACE)!;
    const rootGroup = groups.find((group) => group.name === ROOT)!;
    const bridgeGroup = groups.find((group) => group.name === BRIDGES)!;

    expect(workspaceGroup.args).toContain("--concurrency=2");
    expect(workspaceGroup.env).toEqual({ [WORKSPACE_WORKERS_ENV]: "2" });
    expect(rootGroup.args).toContain("--parallel=4");
    expect(rootGroup.args.slice(0, 2)).toEqual(["test", "./tests"]);
    expect(rootGroup.args).toContain("./e2e/agent-testing/artifact-sanitizer.test.ts");
    expect(rootGroup.args).toContain("./test-fixtures/agent-project/server.test.ts");
    expect(workspaceGroup.args).toContain("--filter=@orkestrator/desktop");
    expect(bridgeGroup.args).toContain("--parallel=2");
  });

  test("the workspace worker count travels by environment, never through Turbo's `--`", () => {
    // Turbo folds passthrough arguments into the hash of the requested task and
    // of its `dependsOn` tasks, so `--` here would give `bun run build` and
    // `bun run test` different `@orkestrator/*#build` hashes and re-run
    // `tsc && vite build` on every alternation between the two.
    const workspaceGroup = buildConcurrentGroups(10).find(
      (group) => group.name === WORKSPACE,
    )!;

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

  test("worker plan bounds aggregate Bun workers across every active package task", () => {
    // Every field is a worker count handed straight to `--parallel` / Turbo's
    // `--concurrency`, so a zero or negative anywhere is a broken command line,
    // not merely a slow run. Degenerate inputs are included because `cores`
    // ultimately comes from `availableParallelism()`.
    for (const cores of [
      -8, -1, 0, 0.5, 1, 1.9, 2, 3, 3.7, 4, 5, 6, 7, 8, 9, 10, 12, 16, 18, 20, 24, 32, 64,
      Number.NaN, Number.POSITIVE_INFINITY,
    ]) {
      const plan = planWorkers(cores);
      const budget = Math.min(
        MAX_AGGREGATE_TEST_WORKERS,
        Math.max(
          MIN_AGGREGATE_TEST_WORKERS,
          Number.isFinite(cores) ? Math.floor(cores) : MIN_AGGREGATE_TEST_WORKERS,
        ),
      );
      const aggregate = plan.root
        + plan.bridges
        + plan.workspace * plan.workspaceConcurrency;

      // Exactly the budget, everywhere: `root` absorbs the integer-division
      // remainder, so the plan neither oversubscribes nor leaves workers idle.
      expect({ cores, aggregate }).toEqual({ cores, aggregate: budget });
      expect(plan.root).toBeGreaterThanOrEqual(1);
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

  test("the root suite outgrows the bridge pool once the budget can pay for it", () => {
    const large = planWorkers(20);
    expect(large.root).toBeGreaterThan(large.bridges);
    expect(
      large.root
      + large.bridges
      + large.workspace * large.workspaceConcurrency,
    ).toBe(MAX_AGGREGATE_TEST_WORKERS);
    // Beyond the cap the plan is constant: more cores must not multiply peak heap.
    expect(planWorkers(64)).toEqual(planWorkers(MAX_AGGREGATE_TEST_WORKERS));
  });

  test("still runs the bridge suites, which turbo does not cover", () => {
    const groups = buildConcurrentGroups(8);
    const bridgeGroup = groups.find((group) => group.name === BRIDGES)!;

    expect(bridgeGroup.command).toBe("bun");
    expect(bridgeGroup.args.slice(0, 2)).toEqual(["test", "bridges"]);
  });

  test("runs the Codex protocol check with an explicit offline fallback", () => {
    const protocolGroup = buildConcurrentGroups(8).find(
      (group) => group.name === PROTOCOL,
    )!;

    expect(protocolGroup.command).toBe("bun");
    expect(protocolGroup.args).toEqual(["run", "codex:protocol:check"]);
    expect(protocolGroup.env).toEqual({
      [ALLOW_MISSING_PROTOCOL_BINARY_ENV]: "1",
    });
  });

  test("runs workspace tests as Turbo package tasks with explicit Bun parallelism", () => {
    const workspaceGroup = buildConcurrentGroups(8).find(
      (group) => group.name === WORKSPACE,
    )!;

    expect(workspaceGroup.command).toBe("turbo");
    expect(workspaceGroup.args.slice(0, 2)).toEqual(["run", "test:workspace"]);
    expect(workspaceGroup.args).toContain("--filter=@orkestrator/web");
    expect(workspaceGroup.args).toContain("--filter=@orkestrator/backend");
    expect(workspaceGroup.args).toContain("--filter=@orkestrator/web-public");
    expect(workspaceGroup.args).toContain("--filter=orkestrator");
    // The shared protocol package has its own suite (the task-list registry
    // both backends depend on); without a filter it would never run.
    expect(workspaceGroup.args).toContain("--filter=@orkestrator/protocol");
    expect(workspaceGroup.env?.[WORKSPACE_WORKERS_ENV]).toMatch(/^\d+$/);
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

  test("prints each group's captured output under its own banner", async () => {
    const { dependencies, logs } = createDependencies({
      outputByName: { [ROOT]: "root suite details", [BRIDGES]: "bridge suite details" },
    });

    await runAllTests(dependencies);
    const report = logs.join("\n");
    expect(report).toContain("root suite details");
    expect(report).toContain("bridge suite details");
    // Buffered per group, so a failure can be attributed to a suite.
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
    expect(report.indexOf(WORKSPACE)).toBeLessThan(report.indexOf(ROOT));
    expect(report.indexOf(ROOT)).toBeLessThan(report.indexOf(BRIDGES));
    expect(report.indexOf(BRIDGES)).toBeLessThan(report.indexOf(PROTOCOL));
  });

  test("runs iOS last and only after the other groups pass", async () => {
    const environment = { DEVELOPER_DIR: "/custom/Xcode/Developer" };
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
      exists: true,
      platform: "darwin",
      statusByName: { [ROOT]: 3 },
    });

    expect(await runAllTests(dependencies)).toBe(3);
    expect(invocations.map((entry) => entry.name)).not.toContain("ios");
  });

  test("uses the standard Xcode path when DEVELOPER_DIR is absent", async () => {
    const { dependencies, existsChecks, invocations } = createDependencies({
      exists: true,
      platform: "darwin",
    });

    expect(await runAllTests(dependencies)).toBe(0);
    expect(existsChecks).toEqual(["/Applications/Xcode.app/Contents/Developer"]);
    expect(invocations.at(-1)?.name).toBe("ios");
  });

  test("propagates an iOS test failure", async () => {
    const { dependencies, invocations } = createDependencies({
      exists: true,
      platform: "darwin",
      statusByName: { ios: 10 },
    });

    expect(await runAllTests(dependencies)).toBe(10);
    expect(invocations).toHaveLength(5);
  });

  test("skips iOS tests when Xcode is missing on macOS", async () => {
    const { dependencies, existsChecks, invocations } = createDependencies({
      exists: false,
      platform: "darwin",
    });

    expect(await runAllTests(dependencies)).toBe(0);
    expect(existsChecks).toHaveLength(1);
    expect(invocations).toHaveLength(4);
  });

  test("does not inspect Xcode or run iOS tests on non-macOS platforms", async () => {
    const { dependencies, existsChecks, invocations } = createDependencies({
      exists: true,
      platform: "linux",
    });

    expect(await runAllTests(dependencies)).toBe(0);
    expect(existsChecks).toHaveLength(0);
    expect(invocations).toHaveLength(4);
  });

  test("CLI entrypoint exits with the failing group status", async () => {
    const { dependencies } = createDependencies({ statusByName: { [ROOT]: 13 } });
    const exitStatuses: number[] = [];

    await main(dependencies, (status) => {
      exitStatuses.push(status);
    });

    expect(exitStatuses).toEqual([13]);
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
    const result = await defaultRunGroup({
      name: "fixture",
      command: process.execPath,
      args: ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
    }, process.env);

    expect(result.status).toBe(0);
    expect(result.output).toContain("out");
    expect(result.output).toContain("err");
  });

  test("default runner converts spawn errors into a failed result", async () => {
    const result = await defaultRunGroup({
      name: "missing",
      command: "/definitely/not/a/real/executable",
      args: [],
    }, process.env);

    expect(result.status).toBe(1);
    expect(result.output).toMatch(/ENOENT|not found/i);
  });
});
