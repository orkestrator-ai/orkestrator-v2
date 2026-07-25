import { describe, expect, test } from "bun:test";
import {
  buildConcurrentGroups,
  defaultRunGroup,
  main,
  MAX_AGGREGATE_TEST_WORKERS,
  planWorkers,
  runAllTests,
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

const WORKSPACE = "workspace (web, backend, web-public)";
const ROOT = "root (tests/)";
const BRIDGES = "bridges";

describe("scripts/test-all.ts", () => {
  test("runs the workspace, root, and bridge groups with inherited environment", async () => {
    const { dependencies, invocations } = createDependencies();

    expect(await runAllTests(dependencies)).toBe(0);
    expect(invocations.map((entry) => entry.name).sort()).toEqual(
      [WORKSPACE, ROOT, BRIDGES].sort(),
    );
    for (const invocation of invocations) {
      expect(invocation.env).toEqual(dependencies.env);
    }
  });

  test("the three groups run concurrently, not one after another", async () => {
    let release = () => {};
    const gate = {
      name: WORKSPACE,
      release: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    const { dependencies, started } = createDependencies({ gate });

    const run = runAllTests(dependencies);
    // Let the other two groups start while the workspace group is still blocked.
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Sequential execution would have started only the first group by now.
    expect(started).toContain(ROOT);
    expect(started).toContain(BRIDGES);

    release();
    expect(await run).toBe(0);
  });

  test("passes a bounded worker count so concurrent groups cannot oversubscribe", () => {
    const groups = buildConcurrentGroups(10);
    const workspaceGroup = groups.find((group) => group.name === WORKSPACE)!;
    const rootGroup = groups.find((group) => group.name === ROOT)!;
    const bridgeGroup = groups.find((group) => group.name === BRIDGES)!;

    expect(workspaceGroup.args).toContain("--concurrency=2");
    expect(workspaceGroup.args.slice(-2)).toEqual(["--", "--parallel=2"]);
    expect(rootGroup.args).toContain("--parallel=5");
    expect(bridgeGroup.args).toContain("--parallel=1");
  });

  test("worker plan bounds aggregate Bun workers across every active package task", () => {
    for (const cores of [1, 2, 4, 8, 20]) {
      const plan = planWorkers(cores);
      const aggregate = plan.root
        + plan.bridges
        + plan.workspace * plan.workspaceConcurrency;
      expect(aggregate).toBeLessThanOrEqual(
        Math.min(MAX_AGGREGATE_TEST_WORKERS, Math.max(3, cores)),
      );
      expect(plan.workspaceConcurrency).toBeGreaterThanOrEqual(1);
      expect(plan.workspaceConcurrency).toBeLessThanOrEqual(3);
    }

    const large = planWorkers(20);
    expect(large.root).toBeGreaterThan(large.bridges);
    expect(
      large.root
      + large.bridges
      + large.workspace * large.workspaceConcurrency,
    ).toBe(MAX_AGGREGATE_TEST_WORKERS);
  });

  test("still runs the bridge suites, which turbo does not cover", () => {
    const groups = buildConcurrentGroups(8);
    const bridgeGroup = groups.find((group) => group.name === BRIDGES)!;

    expect(bridgeGroup.command).toBe("bun");
    expect(bridgeGroup.args.slice(0, 2)).toEqual(["test", "bridges"]);
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
    expect(workspaceGroup.args.at(-1)).toMatch(/^--parallel=\d+$/);
  });

  test("reports every failing group rather than stopping at the first", async () => {
    const { dependencies, invocations, logs } = createDependencies({
      statusByName: { [ROOT]: 7, [BRIDGES]: 9 },
    });

    expect(await runAllTests(dependencies)).toBe(7);
    // All three still ran; a re-run should not be needed to see both failures.
    expect(invocations).toHaveLength(3);
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
    expect(invocations).toHaveLength(4);
  });

  test("skips iOS tests when Xcode is missing on macOS", async () => {
    const { dependencies, existsChecks, invocations } = createDependencies({
      exists: false,
      platform: "darwin",
    });

    expect(await runAllTests(dependencies)).toBe(0);
    expect(existsChecks).toHaveLength(1);
    expect(invocations).toHaveLength(3);
  });

  test("does not inspect Xcode or run iOS tests on non-macOS platforms", async () => {
    const { dependencies, existsChecks, invocations } = createDependencies({
      exists: true,
      platform: "linux",
    });

    expect(await runAllTests(dependencies)).toBe(0);
    expect(existsChecks).toHaveLength(0);
    expect(invocations).toHaveLength(3);
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
