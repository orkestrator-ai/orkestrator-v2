import { afterEach, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandContext } from "../commands-context.js";
import * as shell from "../shell.js";
import { stopEnvironmentExecWorkers } from "./exec-control.js";

const environment = {
  id: "env-1",
  environmentType: "containerized",
  containerId: "owned",
  status: "running",
};
const context = {
  storage: { getEnvironment: async () => environment },
} as unknown as CommandContext;
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

test.each(["", "not json", "null", "{}", '["other-operation"]'])(
  "an unreadable goal-check list (%s) does not block stop, but strict verification refuses it",
  async (stdout) => {
    const command = spyOn(shell, "runCommand").mockResolvedValue({
      stdout,
      stderr: "",
    });
    spies.push(
      command,
      spyOn(console, "warn").mockImplementation(() => {}),
    );
    await expect(stopEnvironmentExecWorkers("env-1", context)).resolves.toBeUndefined();
    await expect(
      stopEnvironmentExecWorkers("env-1", context, { requireStopped: true }),
    ).rejects.toThrow("Goal check workers could not be verified stopped");
    expect(command).toHaveBeenCalledTimes(2);
  },
);

test("a missing control runtime is best effort during stop", async () => {
  spies.push(
    spyOn(shell, "runCommand").mockRejectedValue(new Error("bun unavailable")),
    spyOn(console, "warn").mockImplementation(() => {}),
  );
  await expect(stopEnvironmentExecWorkers("env-1", context)).resolves.toBeUndefined();
  await expect(
    stopEnvironmentExecWorkers("env-1", context, { requireStopped: true }),
  ).rejects.toThrow("Goal check workers could not be verified stopped");
});

test("a valid goal-check list cancels and cleans up its worker", async () => {
  const operationId = `goal-check-${"a".repeat(64)}`;
  const actions: unknown[] = [];
  spies.push(
    spyOn(shell, "runCommand").mockImplementation(async (_command, _args, options) => {
      const input = JSON.parse(String(options?.stdin));
      actions.push(input.action);
      return {
        stdout: JSON.stringify(
          input.action === "list-goal-checks" ? [operationId] : { status: "exited" },
        ),
        stderr: "",
      };
    }),
  );
  await stopEnvironmentExecWorkers("env-1", context, { requireStopped: true });
  expect(actions).toEqual(["list-goal-checks", "cancel", "cleanup"]);
});

test("an unreadable local goal-check list prevents teardown even without strict verification", async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-local-goal-drain-"));
  try {
    await fs.mkdir(path.join(dataDir, "exec-runs", `goal-check-${"a".repeat(64)}`), {
      recursive: true,
    });
    const localContext = {
      appRoot: dataDir,
      resourceRoot: dataDir,
      storage: {
        getEnvironment: async () => ({ ...environment, environmentType: "local" }),
        getDataDir: () => dataDir,
      },
    } as unknown as CommandContext;
    const command = spyOn(shell, "runCommand").mockResolvedValue({ stdout: "{}", stderr: "" });
    spies.push(command);
    await expect(stopEnvironmentExecWorkers("env-1", localContext)).rejects.toThrow(
      "Goal check workers could not be verified stopped",
    );
    expect(command).toHaveBeenCalledTimes(1);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
