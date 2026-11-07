import { registrarFrom } from "./commands-registry-contracts.js";
import { expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { registerTerminalCommands } from "./commands-registry-terminal.js";
import type { RegistryDependencies } from "./commands-registry-types.js";
import * as shell from "./shell.js";
import { REVIEW_WORKTREE_FINGERPRINT_SCRIPT } from "./review-worktree-fingerprint.js";

function harness(environmentType: "local" | "container" = "local") {
  const commands = new Map<string, CommandHandler>();
  registerTerminalCommands(
    registrarFrom((name, handler) => commands.set(name, handler)),
    {} as RegistryDependencies,
  );
  const prefix = randomUUID();
  const context = {
    appRoot: "",
    resourceRoot: "",
    storage: {
      getEnvironment: async (id: string) => ({
        id,
        environmentType,
        worktreePath: `/fixture/${id}`,
        containerId: "fixture-container",
      }),
    },
    runtime: { environments: { fence: { beginMutation: () => () => undefined } } },
  } as unknown as CommandContext;
  return async (environment = "first", fingerprint = false) =>
    commands.get("get_environment_uncommitted_paths")!(
      { environmentId: `${prefix}-${environment}`, fingerprint },
      context,
    );
}

function envelope(label: string, fingerprint = false) {
  return JSON.stringify({
    head: "1".repeat(40),
    status: Buffer.from(`?? ${label}\0`).toString("base64"),
    ...(fingerprint ? { fingerprint: "a".repeat(64) } : {}),
  });
}

test("same environment and kind serialize concurrent callers into one trailing probe", async () => {
  const read = harness();
  const releases: Array<(value: shell.ExecResult) => void> = [];
  const execute = spyOn(shell, "runCommand").mockImplementation(
    () => new Promise((resolve) => releases.push(resolve)),
  );
  const finish = (index: number, label: string) =>
    releases[index]!({ stdout: envelope(label), stderr: "" });
  const pending: Promise<unknown>[] = [];
  try {
    pending.push(read());
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(1);
    pending.push(read(), read(), read());
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(1);

    finish(0, "initial");
    await expect(pending[0]).resolves.toMatchObject({ paths: ["initial"] });
    expect(execute).toHaveBeenCalledTimes(2);
    finish(1, "trailing");
    for (const result of await Promise.all(pending.slice(1))) {
      expect(result).toMatchObject({ paths: ["trailing"] });
    }
    expect(execute).toHaveBeenCalledTimes(2);

    pending.push(read());
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(3);
    finish(2, "fresh");
    await expect(pending.at(-1)).resolves.toMatchObject({ paths: ["fresh"] });
  } finally {
    // Drain test-owned flights even if an assertion fails.
    for (let index = 0; index < 4; index++) {
      for (const release of releases) release({ stdout: envelope("cleanup"), stderr: "" });
      await Promise.resolve();
    }
    await Promise.allSettled(pending);
    execute.mockRestore();
  }
});

for (const environmentType of ["local", "container"] as const) {
  test(`distinct keys run independently with matching budgets and timeouts (${environmentType})`, async () => {
    const read = harness(environmentType);
    const releases: Array<() => void> = [];
    const execute = spyOn(shell, "runCommand").mockImplementation(
      (_command, args) =>
        new Promise((resolve) =>
          releases.push(() =>
            resolve({
              stdout: envelope("independent", args?.includes("fingerprint")),
              stderr: "",
            }),
          ),
        ),
    );
    const pending = [read("first"), read("first", true), read("second")];
    try {
      await Promise.resolve();
      expect(execute).toHaveBeenCalledTimes(3);
      for (const [index, fingerprint] of [false, true, false].entries()) {
        const [command, args, options] = execute.mock.calls[index]!;
        expect(command).toBe(environmentType === "local" ? process.execPath : "docker");
        expect(args).toEqual([
          ...(environmentType === "container"
            ? ["exec", "-w", "/workspace", "fixture-container", "node"]
            : []),
          "-e",
          REVIEW_WORKTREE_FINGERPRINT_SCRIPT,
          ...(fingerprint ? ["fingerprint", "budget-ms=115000"] : ["budget-ms=25000"]),
        ]);
        expect(options?.timeoutMs).toBe(fingerprint ? 120_000 : 30_000);
      }
      for (const release of releases) release();
      const results = await Promise.all(pending);
      expect(results).toEqual([
        { head: "1".repeat(40), paths: ["independent"] },
        { head: "1".repeat(40), paths: ["independent"], fingerprint: "a".repeat(64) },
        { head: "1".repeat(40), paths: ["independent"] },
      ]);
    } finally {
      for (const release of releases) release();
      await Promise.allSettled(pending);
      execute.mockRestore();
    }
  });
}
