import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { HumanPromptRegistry } from "./human-prompt-registry.js";
import { spawnPty } from "./pty.js";
import { UserCommandService, type UserCommandHost } from "./user-commands.js";

/**
 * Real processes in a real PTY: the point is that output, input, exit and
 * cancel behave the way a terminal does.
 */

const services: UserCommandService[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function world(options: { fail?: string } = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), "user-commands-"));
  dirs.push(cwd);
  const prompts = new HumanPromptRegistry();
  const announced: string[] = [];
  const host: UserCommandHost = {
    prompts,
    announceDelayMs: 0,
    announce: (environmentId, tabId) => announced.push(`${environmentId}:${tabId}`),
    resolve: async () => {
      if (options.fail) throw new Error(options.fail);
      return {
        target: "worktree",
        cwd,
        spawn: (command) =>
          spawnPty("/bin/sh", ["-c", command], { cwd, cols: 120, rows: 40, coalesceMs: 0 }),
      };
    },
  };
  const service = new UserCommandService(host);
  services.push(service);
  return { service, prompts, announced, cwd };
}

async function until<T>(read: () => T, done: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("running a user command", () => {
  test("runs in the workspace, streams output, and records the exit code", async () => {
    const { service, announced, cwd } = world();
    const started = await service.run({ environmentId: "env", tabId: "tab", command: "pwd; exit 3" });
    expect(started).toMatchObject({ status: "running", command: "pwd; exit 3", cwd });
    const done = await until(
      () => service.get(started.id),
      (record) => record.status !== "running",
    );
    expect(done).toMatchObject({ status: "exited", exitCode: 3 });
    expect(done.output).toContain(path.basename(cwd));
    expect(done.endedAt).toBeString();
    expect(announced).toContain("env:tab");
    expect(service.list("env", "tab").map((record) => record.id)).toEqual([started.id]);
  });

  test("a tab whose workspace is unavailable is refused with the reason", async () => {
    const { service } = world({ fail: "Start the environment's container first." });
    await expect(
      service.run({ environmentId: "env", tabId: "tab", command: "ls" }),
    ).rejects.toThrow("container");
  });

  test("blank and oversized commands are refused", async () => {
    const { service } = world();
    await expect(service.run({ environmentId: "e", tabId: "t", command: "  " })).rejects.toThrow();
    await expect(
      service.run({ environmentId: "e", tabId: "t", command: "x".repeat(9_000) }),
    ).rejects.toThrow("too long");
  });
});

describe("interactive commands", () => {
  test("a sign-in prompt is published, answered with ENTER, and cleared on exit", async () => {
    const { service, prompts } = world();
    const script =
      "printf 'Login at:\\nhttps://www.npmjs.com/login?next=/login/cli/b4cc90fe-8f7e-465f-9d29-702dfda0a967\\nPress ENTER to open in the browser...'; read answer; echo done";
    const started = await service.run({ environmentId: "env", tabId: "tab", command: script });
    const waiting = await until(
      () => service.get(started.id),
      (record) => record.prompt !== undefined,
    );
    expect(waiting.prompt).toMatchObject({
      kind: "sign-in",
      url: "https://www.npmjs.com/login?next=/login/cli/b4cc90fe-8f7e-465f-9d29-702dfda0a967",
      wantsEnter: true,
    });
    expect(prompts.list({ environmentIds: ["env"] })).toEqual([
      expect.objectContaining({
        source: "user-command",
        userCommandId: started.id,
        tabId: "tab",
        command: script,
      }),
    ]);

    service.write(started.id, "");
    const done = await until(
      () => service.get(started.id),
      (record) => record.status !== "running",
    );
    expect(done.output).toContain("done");
    expect(done.prompt).toBeUndefined();
    expect(prompts.list()).toEqual([]);
  });

  test("a line of input reaches the command", async () => {
    const { service } = world();
    const started = await service.run({
      environmentId: "env",
      tabId: "tab",
      command: "printf 'Name: '; read name; echo \"hello $name\"",
    });
    await until(
      () => service.get(started.id),
      (record) => record.output.includes("Name:"),
    );
    service.write(started.id, "Ada");
    const done = await until(
      () => service.get(started.id),
      (record) => record.status !== "running",
    );
    expect(done.output).toContain("hello Ada");
  });

  test("cancel stops the whole command and clears its prompt", async () => {
    const { service, prompts } = world();
    const started = await service.run({
      environmentId: "env",
      tabId: "tab",
      command: "printf '[sudo] password for me: '; sleep 30",
    });
    await until(
      () => prompts.list(),
      (list) => list.length === 1,
    );
    const cancelled = await service.cancel(started.id);
    expect(cancelled.status).toBe("cancelled");
    expect(prompts.list()).toEqual([]);
    expect(() => service.write(started.id, "x")).toThrow("no longer running");
  });

  test("no more than four commands run at once in one tab", async () => {
    const { service } = world();
    for (let index = 0; index < 4; index += 1) {
      await service.run({ environmentId: "env", tabId: "tab", command: "sleep 30" });
    }
    await expect(
      service.run({ environmentId: "env", tabId: "tab", command: "sleep 30" }),
    ).rejects.toThrow("already running");
    // Another tab is unaffected.
    await service.run({ environmentId: "env", tabId: "other", command: "true" });
    await service.terminateForEnvironment("env");
    expect(service.hasRunning("env")).toBe(false);
    expect(service.list("env", "tab")).toEqual([]);
  });
});

describe("telling the agent", () => {
  test("finished commands are offered once and committed only after dispatch", async () => {
    const { service } = world();
    const started = await service.run({ environmentId: "env", tabId: "tab", command: "echo hi" });
    await until(
      () => service.get(started.id),
      (record) => record.status === "exited",
    );
    const first = service.takeContext("env", "tab");
    expect(first.ids).toEqual([started.id]);
    expect(first.block).toContain("$ echo hi");
    // A refused dispatch never commits: the same block is offered again.
    expect(service.takeContext("env", "tab").ids).toEqual([started.id]);
    service.markDelivered(first.ids, "req-1");
    expect(service.takeContext("env", "tab")).toEqual({ block: "", ids: [] });
    expect(service.get(started.id).context).toMatchObject({ state: "delivered", requestId: "req-1" });
  });

  test("a command delivered while running is offered again with how it ended", async () => {
    const { service } = world();
    const started = await service.run({
      environmentId: "env",
      tabId: "tab",
      command: "read x; echo finished",
    });
    const running = service.takeContext("env", "tab");
    expect(running.block).toContain("still running");
    service.markDelivered(running.ids, "req-1");
    service.write(started.id, "");
    await until(
      () => service.get(started.id),
      (record) => record.status === "exited",
    );
    const final = service.takeContext("env", "tab");
    expect(final.ids).toEqual([started.id]);
    expect(final.block).toContain("exit code 0");
    expect(final.block).toContain("finished");
  });
});
