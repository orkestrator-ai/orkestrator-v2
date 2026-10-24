import { describe, expect, test } from "bun:test";

import { createCommandFixtures } from "./command-fixtures";

const {
  commandTesting,
  createFakeChild,
  createRuntime,
  localServerHooks,
  reserveFreePort,
  shutdownLocalServers,
  startControllableHealthServer,
} = await createCommandFixtures();

describe("Electron backend command registry", () => {
  // The `security` stub only takes effect on darwin, where `getHostClaudeCredentials`
  // consults the Keychain; elsewhere resolution starts at the on-disk credential.
  // Seeding both with the same payload keeps these tests asserting the same thing
  // on every platform instead of silently depending on the developer's OS.

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
