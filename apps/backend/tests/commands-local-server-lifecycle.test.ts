import { afterEach, describe, expect, mock, test } from "bun:test";

import { createCommandFixtures } from "./command-fixtures";

const {
  ASYNC_TEST_BUDGET_MS,
  commandTesting,
  createFakeChild,
  createRuntime,
  createTempDir,
  fs,
  localServerHooks,
  path,
  reserveFreePort,
  shutdownLocalServers,
  startControllableHealthServer,
} = await createCommandFixtures();

let verifyRetiredRuntime: (() => Promise<void>) | undefined;
// The fixture's earlier hook has drained owned children and restored defaults.
afterEach(async () => {
  const verify = verifyRetiredRuntime;
  verifyRetiredRuntime = undefined;
  await verify?.();
});

describe("Electron backend command registry", () => {
  // The `security` stub only takes effect on darwin, where `getHostClaudeCredentials`
  // consults the Keychain; elsewhere resolution starts at the on-disk credential.
  // Seeding both with the same payload keeps these tests asserting the same thing
  // on every platform instead of silently depending on the developer's OS.

  test(
    "shared fixture teardown has a budget independent of the caller's registration default",
    async () => {
      const directory = await createTempDir("ork-fixture-hook-budget-");
      const childTest = path.join(directory, "cleanup-budget.test.ts");
      await fs.writeFile(
        childTest,
        `import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { createCommandFixtures } from ${JSON.stringify(path.join(import.meta.dir, "command-fixtures.ts"))};
setDefaultTimeout(1000);
const { createRuntime, createFakeChild, localServerHooks } = await createCommandFixtures();
// Like the command suites, the caller sets its budget after hook registration.
setDefaultTimeout(30000);
let terminated = false;
test("owned fake child teardown", () => {
  const { localServers } = createRuntime();
  localServers.adoptProcess("codex:env-cleanup-budget", createFakeChild(91004));
  localServerHooks.terminateProcessTree = async () => {
    await Bun.sleep(1500);
    terminated = true;
    return true;
  };
});
afterAll(() => expect(terminated).toBe(true));
`,
      );
      const child = Bun.spawn(
        [
          process.execPath,
          "test",
          childTest,
          "--preload",
          "../../tests/setup-node.ts",
          "--parallel=1",
          "--only-failures",
        ],
        { cwd: path.resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, stdout + stderr).toBe(0);
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test("retired fixture runtimes keep fake-child cleanup on their original hooks", () => {
    const child = createFakeChild(91003);
    const { localServers } = createRuntime();
    localServers.adoptProcess("codex:env-retired", child);
    const originalTermination = mock(async () => true);
    localServerHooks.terminateProcessTree = originalTermination;
    let releaseOperation!: () => void;
    const operationGate = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    const operation = localServers.enqueueEnvironmentOperation("env-retired", () => operationGate);

    verifyRetiredRuntime = async () => {
      const restoredTermination = localServerHooks.terminateProcessTree;
      const nextTestTermination = mock(async () => {
        throw new Error("retired fake child reached a new test's process hook");
      });
      localServerHooks.terminateProcessTree = nextTestTermination;
      try {
        // Teardown must reach owned children even though this queue is blocked.
        expect(originalTermination).toHaveBeenCalledTimes(1);
        expect(localServers.processCount()).toBe(0);
        // A startup catch may still hold this child after shutdown removed it.
        await localServers.terminate("codex:env-retired", child);
        expect(originalTermination).toHaveBeenCalledTimes(2);
        expect(nextTestTermination).not.toHaveBeenCalled();
      } finally {
        releaseOperation();
        await operation;
        localServerHooks.terminateProcessTree = restoredTermination;
      }
    };
  });

  test("waits for every shutdown attempt, reports failures, and supports retry", async () => {
    const failedChild = createFakeChild(91001);
    const successfulChild = createFakeChild(91002);
    const { localServers } = createRuntime();
    localServers.adoptProcess("codex:env-failure", failedChild);
    localServers.adoptProcess("claude:env-success", successfulChild);
    const attempted: number[] = [];
    localServerHooks.terminateProcessTree = async (child) => {
      attempted.push(child.pid ?? 0);
      return child !== failedChild;
    };

    await expect(shutdownLocalServers()).rejects.toThrow("Failed to shut down all local servers");
    expect(attempted.sort()).toEqual([91001, 91002]);
    expect(localServers.process("codex:env-failure")).toBe(failedChild);
    expect(localServers.process("claude:env-success")).toBeUndefined();

    localServerHooks.terminateProcessTree = async () => true;
    await expect(shutdownLocalServers()).resolves.toBeUndefined();
    expect(localServers.process("codex:env-failure")).toBeUndefined();
  });

  test("fails a bridge replacement whose port never stops answering health checks", async () => {
    const hostPort = await reserveFreePort();
    const bridge = await startControllableHealthServer(hostPort, () => true);
    try {
      await expect(commandTesting.waitForUnhealthy(hostPort, 2)).rejects.toThrow(
        `Server on port ${hostPort} did not stop`,
      );
      await expect(commandTesting.waitForHttpServerExit(hostPort, 2)).rejects.toThrow(
        `Server on port ${hostPort} did not stop`,
      );
    } finally {
      await bridge.close();
    }
  });
});
