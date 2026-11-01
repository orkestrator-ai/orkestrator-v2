import { afterEach, expect, spyOn, test } from "bun:test";
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
