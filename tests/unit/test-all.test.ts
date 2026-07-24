import { describe, expect, test } from "bun:test";
import {
  main,
  runAllTests,
  type TestAllDependencies,
} from "../../scripts/test-all";

interface Invocation {
  args: string[];
  command: string;
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: "inherit";
  };
}

function createDependencies(options: {
  exists?: boolean;
  platform?: NodeJS.Platform;
  statuses?: Array<number | null>;
  environment?: NodeJS.ProcessEnv;
} = {}): {
  dependencies: TestAllDependencies;
  existsChecks: string[];
  invocations: Invocation[];
} {
  const invocations: Invocation[] = [];
  const existsChecks: string[] = [];
  const statuses = options.statuses ?? [];
  const environment = options.environment ?? { TEST_ALL_MARKER: "preserved" };

  return {
    dependencies: {
      env: environment,
      exists: (target) => {
        existsChecks.push(target);
        return options.exists ?? false;
      },
      platform: options.platform ?? "linux",
      root: "/test/repository",
      spawn: (command, args, commandOptions) => {
        const invocationIndex = invocations.length;
        invocations.push({ args, command, options: commandOptions });
        return {
          status: invocationIndex < statuses.length
            ? statuses[invocationIndex]
            : 0,
        };
      },
    },
    existsChecks,
    invocations,
  };
}

function invocationNames(invocations: Invocation[]): string[] {
  return invocations.map(({ args, command }) => `${command} ${args.join(" ")}`);
}

describe("scripts/test-all.ts", () => {
  test("runs workspace, root, and bridge suites in order with inherited execution options", () => {
    const { dependencies, invocations } = createDependencies();

    expect(runAllTests(dependencies)).toBe(0);
    expect(invocationNames(invocations)).toEqual([
      "turbo --cwd . run test:workspace --filter=@orkestrator/web --filter=@orkestrator/backend --filter=@orkestrator/web-public --cache-dir .turbo",
      "bun test tests",
      "bun test bridges",
    ]);
    for (const invocation of invocations) {
      expect(invocation.options).toEqual({
        cwd: "/test/repository",
        env: dependencies.env,
        stdio: "inherit",
      });
    }
  });

  for (const [failedStep, status] of [
    [0, 7],
    [1, 8],
    [2, 9],
  ] as const) {
    test(`stops after command ${failedStep + 1} fails`, () => {
      const statuses = [0, 0, 0];
      statuses[failedStep] = status;
      const { dependencies, invocations } = createDependencies({ statuses });

      expect(runAllTests(dependencies)).toBe(status);
      expect(invocations).toHaveLength(failedStep + 1);
    });
  }

  test("maps a signal-terminated child with a null status to failure and stops", () => {
    const { dependencies, invocations } = createDependencies({
      statuses: [null],
    });

    expect(runAllTests(dependencies)).toBe(1);
    expect(invocations).toHaveLength(1);
  });

  test("runs iOS tests last on macOS when the configured developer directory exists", () => {
    const environment = { DEVELOPER_DIR: "/custom/Xcode/Developer" };
    const { dependencies, existsChecks, invocations } = createDependencies({
      environment,
      exists: true,
      platform: "darwin",
    });

    expect(runAllTests(dependencies)).toBe(0);
    expect(existsChecks).toEqual(["/custom/Xcode/Developer"]);
    expect(invocationNames(invocations).at(-1)).toBe("bun scripts/test-ios.ts");
  });

  test("uses the standard Xcode path when DEVELOPER_DIR is absent", () => {
    const { dependencies, existsChecks, invocations } = createDependencies({
      exists: true,
      platform: "darwin",
    });

    expect(runAllTests(dependencies)).toBe(0);
    expect(existsChecks).toEqual(["/Applications/Xcode.app/Contents/Developer"]);
    expect(invocationNames(invocations).at(-1)).toBe("bun scripts/test-ios.ts");
  });

  test("propagates an iOS test failure", () => {
    const { dependencies, invocations } = createDependencies({
      exists: true,
      platform: "darwin",
      statuses: [0, 0, 0, 10],
    });

    expect(runAllTests(dependencies)).toBe(10);
    expect(invocations).toHaveLength(4);
  });

  test("skips iOS tests when Xcode is missing on macOS", () => {
    const { dependencies, existsChecks, invocations } = createDependencies({
      exists: false,
      platform: "darwin",
    });

    expect(runAllTests(dependencies)).toBe(0);
    expect(existsChecks).toHaveLength(1);
    expect(invocations).toHaveLength(3);
  });

  test("does not inspect Xcode or run iOS tests on non-macOS platforms", () => {
    const { dependencies, existsChecks, invocations } = createDependencies({
      exists: true,
      platform: "linux",
    });

    expect(runAllTests(dependencies)).toBe(0);
    expect(existsChecks).toHaveLength(0);
    expect(invocations).toHaveLength(3);
  });

  test("CLI entrypoint exits with the failing child status", () => {
    const { dependencies } = createDependencies({ statuses: [13] });
    const exitStatuses: number[] = [];

    main(dependencies, (status) => {
      exitStatuses.push(status);
    });

    expect(exitStatuses).toEqual([13]);
  });

  test("CLI entrypoint returns normally after successful suites", () => {
    const { dependencies } = createDependencies();
    const exitStatuses: number[] = [];

    main(dependencies, (status) => {
      exitStatuses.push(status);
    });

    expect(exitStatuses).toEqual([]);
  });
});
