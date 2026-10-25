import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandContext } from "./commands-context.js";
import { startLocalServerUnlocked } from "./commands-servers.js";
import { spawnCommand } from "./shell.js";
import { createEnvironment, createProject, StorageService } from "./storage.js";
import { BackendRuntime } from "./backend-runtime.js";

describe("local opencode serve environment", () => {
  let root: string;
  let previousAutoupdate: string | undefined;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ork-opencode-serve-env-")));
    previousAutoupdate = process.env.OPENCODE_DISABLE_AUTOUPDATE;
    // The backend's own environment must not be what makes this pass.
    delete process.env.OPENCODE_DISABLE_AUTOUPDATE;
  });

  afterEach(async () => {
    if (previousAutoupdate === undefined) delete process.env.OPENCODE_DISABLE_AUTOUPDATE;
    else process.env.OPENCODE_DISABLE_AUTOUPDATE = previousAutoupdate;
    await fs.rm(root, { recursive: true, force: true });
  });

  test("starts the pinned binary with OpenCode's update check disabled", async () => {
    const checkout = path.join(root, "checkout");
    await fs.mkdir(checkout);
    const storage = new StorageService(path.join(root, "data"));
    await storage.init();
    const project = await storage.addProject(createProject("remote", checkout));
    const environment = createEnvironment(project.id, {
      name: "local opencode",
      environmentType: "local",
    });
    environment.status = "running";
    environment.worktreePath = checkout;
    await storage.addEnvironment(environment);
    let spawned: { args: string[]; env: NodeJS.ProcessEnv | undefined } | undefined;
    const context = {
      storage,
      appRoot: root,
      resourceRoot: root,
      emit: () => undefined,
      environmentLifecycleTasks: {} as CommandContext["environmentLifecycleTasks"],
      runtime: new BackendRuntime({
        emit: () => undefined,
        localServers: {
          spawn: ((_command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
            spawned = { args, env: options.env };
            throw new Error("captured spawn");
          }) as unknown as typeof spawnCommand,
        },
      }),
    } as CommandContext;

    await expect(startLocalServerUnlocked(environment.id, context, "opencode")).rejects.toThrow(
      "captured spawn",
    );
    expect(spawned?.args[0]).toBe("serve");
    expect(spawned?.env?.OPENCODE_DISABLE_AUTOUPDATE).toBe("1");
    context.runtime.shutdown();
  });
});
