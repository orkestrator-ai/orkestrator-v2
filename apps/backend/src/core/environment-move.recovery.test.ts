// Moving an environment's worktree: restart recovery, journal edits, admission fences and same-disk moves.
import { describe, expect, test, mock, spyOn, setDefaultTimeout } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Environment } from "./models.js";
import { type CommandContext } from "./commands.js";
import { moveEnvironmentTask, recoverInterruptedEnvironmentMoves } from "./environment-move.js";
import { runCommand } from "./shell.js";
import * as shell from "./shell.js";
import * as tmux from "./tmux-commands.js";
import * as pathSafety from "./path-safety.js";
import { parseWorktreeMoveRecord } from "./storage-projects.js";
import {
  setup,
  addNestedSubmodules,
  expectSubmodulesLinked,
  registeredWorktrees,
  isolatedHomes,
  exists,
  registerEnvironmentMoveFixtureHooks,
} from "./environment-move-test-support.js";

// This slow-tier file creates real repositories/worktrees and waits for
// subprocess cleanup. Give that fixture work its own bounded host budget;
// explicit operation deadlines and shorter test budgets remain unchanged.
setDefaultTimeout(30_000);
registerEnvironmentMoveFixtureHooks();

test("restart recovery re-links submodules of an adopted or abandoned copy", async () => {
  const { root, storage, context, startLocal, projectPath } = await setup();
  const environment = await startLocal();
  const from = environment.worktreePath!;
  await addNestedSubmodules(root, projectPath, from);
  const { stdout: listed } = await runCommand("git", [
    "-C",
    from,
    "submodule",
    "--quiet",
    "foreach",
    "--recursive",
    'printf "%s|%s\\n" "$displaypath" "$(git rev-parse --absolute-git-dir)"',
  ]);
  const submodules = listed
    .trim()
    .split("\n")
    .map((line) => {
      const [relative, gitDir] = line.split("|");
      return { path: relative!, gitDir: gitDir! };
    });
  expect(submodules.map((entry) => entry.path)).toEqual(["libs/sub", "libs/sub/nested"]);

  // Stopped after the copy was renamed into place, before anything was re-linked.
  const to = path.join(root, "moved", "deeper", path.basename(from));
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.cp(from, to, { recursive: true, verbatimSymlinks: true });
  await storage.updateEnvironment(environment.id, {
    worktreeMove: { from, to, submodules, phase: "moving", startedAt: new Date().toISOString() },
    lifecycleOperation: "moving",
  });
  // A half re-link left the source's submodule pointing at the copy.
  await runCommand("git", [
    "config",
    "--file",
    path.join(submodules[0]!.gitDir, "config"),
    "core.worktree",
    path.relative(submodules[0]!.gitDir, path.join(await fs.realpath(to), "libs", "sub")),
  ]);
  await recoverInterruptedEnvironmentMoves(context, { sessionHomes: isolatedHomes(root) });
  let recovered = (await storage.getEnvironment(environment.id))!;
  expect(recovered.worktreePath).toBe(from);
  expect(recovered.lifecycleError).toContain("left a copy");
  await expectSubmodulesLinked(from);

  // The same copy, recorded as finished, is adopted with its submodules.
  await fs.rm(to, { recursive: true, force: true });
  await fs.cp(from, to, { recursive: true, verbatimSymlinks: true });
  await storage.updateEnvironment(environment.id, {
    worktreeMove: {
      from,
      to,
      submodules,
      sourceIdentity: { dev: (await fs.stat(from)).dev, ino: (await fs.stat(from)).ino },
      phase: "copied",
      startedAt: new Date().toISOString(),
    },
    lifecycleOperation: "moving",
  });
  await recoverInterruptedEnvironmentMoves(context, { sessionHomes: isolatedHomes(root) });
  recovered = (await storage.getEnvironment(environment.id))!;
  expect(recovered.worktreePath).toBe(to);
  expect(recovered.worktreeMove).toBeUndefined();
  expect(await exists(from)).toBe(false);
  expect(await registeredWorktrees(projectPath)).toContain(to);
  await expectSubmodulesLinked(to);
});

test("persisted submodule links are confined to the worktree", () => {
  const base = { from: "/a/one", to: "/b/one", phase: "copied", startedAt: "now" };
  const submodules = [{ path: "libs/sub", gitDir: "/repo/.git/worktrees/one/modules/libs/sub" }];
  expect(parseWorktreeMoveRecord({ ...base, submodules }).submodules).toEqual(submodules);
  expect(parseWorktreeMoveRecord(base).submodules).toBeUndefined();
  for (const bad of ["../escape", "/abs", "libs//sub", ""]) {
    expect(() =>
      parseWorktreeMoveRecord({ ...base, submodules: [{ path: bad, gitDir: "/g" }] }),
    ).toThrow("submodule path");
  }
  expect(() =>
    parseWorktreeMoveRecord({ ...base, submodules: [{ path: "libs/sub", gitDir: "relative" }] }),
  ).toThrow("submodule git dir");
});

test("abandons a final copy without a copied-phase record and repairs the original", async () => {
  const { root, storage, context, startLocal, projectPath } = await setup();
  const environment = await startLocal();
  const from = environment.worktreePath!;
  const to = path.join(root, "moved", path.basename(from));
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.cp(from, to, { recursive: true });
  await runCommand("git", ["-C", projectPath, "worktree", "repair", to]);
  await storage.updateEnvironment(environment.id, {
    worktreeMove: { from, to, phase: "moving", startedAt: new Date().toISOString() },
    lifecycleOperation: "moving",
  });
  await recoverInterruptedEnvironmentMoves(context, { sessionHomes: isolatedHomes(root) });
  const recovered = (await storage.getEnvironment(environment.id))!;
  expect(recovered.worktreePath).toBe(from);
  expect(recovered.worktreeMove).toBeUndefined();
  expect(recovered.lifecycleError).toContain("left a copy");
  expect(await registeredWorktrees(projectPath)).toContain(from);
  expect(await exists(to)).toBe(true);
});

test("source cleanup failure retains a committed copy for restart retry", async () => {
  const { root, storage, context, startLocal } = await setup();
  const environment = await startLocal();
  const removal = spyOn(pathSafety, "removeConfinedDirectory").mockRejectedValueOnce(
    new Error("source cleanup failed"),
  );
  const moved = await moveEnvironmentTask(environment.id, path.join(root, "moved"), context, {
    forceCopy: true,
    sessionHomes: isolatedHomes(root),
  });
  expect(moved.lifecycleError).toContain("source cleanup failed");
  expect(moved.worktreeMove?.phase).toBe("committed");
  expect(await exists(environment.worktreePath!)).toBe(true);
  removal.mockRestore();
  await recoverInterruptedEnvironmentMoves(context, { sessionHomes: isolatedHomes(root) });
  expect(await exists(environment.worktreePath!)).toBe(false);
  expect((await storage.getEnvironment(environment.id))?.worktreeMove).toBeUndefined();
});

test("a storage rejection after publishing the path never rolls it back", async () => {
  const { root, storage, context, startLocal, projectPath } = await setup();
  const environment = await startLocal();
  const update = storage.updateEnvironment.bind(storage);
  let rejected = false;
  spyOn(storage, "updateEnvironment").mockImplementation(async (id, changes) => {
    const result = await update(id, changes);
    if (
      !rejected &&
      (changes.worktreeMove as { phase?: string } | undefined)?.phase === "committed"
    ) {
      rejected = true;
      throw new Error("notification rejected after commit");
    }
    return result;
  });
  const moved = await moveEnvironmentTask(environment.id, path.join(root, "moved"), context, {
    sessionHomes: isolatedHomes(root),
  });
  expect(moved.lifecycleError).toContain("notification rejected after commit");
  expect(moved.worktreeMove?.phase).toBe("committed");
  expect(await exists(moved.worktreePath!)).toBe(true);
  expect(await exists(environment.worktreePath!)).toBe(false);
  expect(await registeredWorktrees(projectPath)).toContain(moved.worktreePath!);
  await recoverInterruptedEnvironmentMoves(context, { sessionHomes: isolatedHomes(root) });
  expect((await storage.getEnvironment(environment.id))?.worktreeMove).toBeUndefined();
});

for (const forceCopy of [false, true]) {
  test(`rejected path commit clears the journal and preserves subsequent edits (${forceCopy})`, async () => {
    const { root, storage, context, startLocal, projectPath } = await setup();
    const environment = await startLocal();
    const update = storage.updateEnvironment.bind(storage);
    spyOn(storage, "updateEnvironment").mockImplementation(async (id, changes) => {
      if (
        changes.worktreePath &&
        (changes.worktreeMove as { phase?: string })?.phase === "committed"
      )
        throw new Error("commit rejected");
      return update(id, changes);
    });
    const destination = path.join(root, "rejected");
    await expect(
      moveEnvironmentTask(environment.id, destination, context, {
        forceCopy,
        sessionHomes: isolatedHomes(root),
      }),
    ).rejects.toThrow("commit rejected");
    expect((await storage.getEnvironment(environment.id))?.worktreeMove).toBeUndefined();
    expect(await exists(path.join(destination, path.basename(environment.worktreePath!)))).toBe(
      false,
    );
    await fs.writeFile(path.join(environment.worktreePath!, "README.md"), "edited after rejection");
    await recoverInterruptedEnvironmentMoves(context, { sessionHomes: isolatedHomes(root) });
    expect(await fs.readFile(path.join(environment.worktreePath!, "README.md"), "utf8")).toBe(
      "edited after rejection",
    );
    expect(await registeredWorktrees(projectPath)).toContain(environment.worktreePath!);
  });
}

test("a nonzero Git exit after rename retains recovery and repairs the backlink", async () => {
  const { root, storage, context, startLocal, projectPath } = await setup();
  const environment = await startLocal();
  const from = environment.worktreePath!;
  const to = path.join(root, "renamed", path.basename(from));
  const run = shell.runCommand;
  const command = spyOn(shell, "runCommand").mockImplementation(async (name, args, options) => {
    if (name === "git" && args?.includes("move")) {
      await fs.rename(from, to);
      throw new Error("metadata update failed");
    }
    return run(name, args, options);
  });
  await expect(
    moveEnvironmentTask(environment.id, path.dirname(to), context, {
      sessionHomes: isolatedHomes(root),
    }),
  ).rejects.toThrow("metadata update failed");
  expect((await storage.getEnvironment(environment.id))?.worktreeMove?.phase).toBe("moving");
  command.mockRestore();
  await recoverInterruptedEnvironmentMoves(context, { sessionHomes: isolatedHomes(root) });
  expect((await storage.getEnvironment(environment.id))?.worktreePath).toBe(to);
  expect((await storage.getEnvironment(environment.id))?.worktreeMove).toBeUndefined();
  expect(await registeredWorktrees(projectPath)).toContain(to);
  await runCommand("git", ["-C", to, "status", "--porcelain"]);
  await runCommand("git", ["-C", to, "branch", "recovery-works"]);
});

test("cleanup retries preserve a new directory at the source pathname", async () => {
  const { root, storage, context, startLocal } = await setup();
  const environment = await startLocal();
  spyOn(storage, "clearBackendTerminalSessionIds").mockRejectedValueOnce(
    new Error("bookkeeping failed"),
  );
  const result = await moveEnvironmentTask(environment.id, path.join(root, "moved"), context, {
    forceCopy: true,
    sessionHomes: isolatedHomes(root),
  });
  expect(result.worktreeMove?.sourceCleaned).toBe(true);
  await fs.mkdir(environment.worktreePath!);
  await fs.writeFile(path.join(environment.worktreePath!, "sentinel"), "unrelated");
  // Also exercise a crash after removal but before the cleanup flag write.
  await storage.updateEnvironment(environment.id, {
    worktreeMove: { ...result.worktreeMove!, sourceCleaned: false },
  });
  await recoverInterruptedEnvironmentMoves(context, { sessionHomes: isolatedHomes(root) });
  expect(await fs.readFile(path.join(environment.worktreePath!, "sentinel"), "utf8")).toBe(
    "unrelated",
  );
  expect((await storage.getEnvironment(environment.id))?.worktreeMove).toBeUndefined();
});

test("a paused copy refuses file writers and new workers before deleting the source", async () => {
  const { root, commands, storage, context, startLocal } = await setup();
  const environment = await startLocal();
  const run = shell.runCommand;
  let ready!: () => void;
  const copying = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  spyOn(shell, "runCommand").mockImplementation(async (name, args, options) => {
    const result = await run(name, args, options);
    if (name === "cp") {
      ready();
      await paused;
    }
    return result;
  });
  const moving = moveEnvironmentTask(environment.id, path.join(root, "moved"), context, {
    forceCopy: true,
    sessionHomes: isolatedHomes(root),
  });
  try {
    await copying;
    for (const [command, args] of [
      [
        "write_local_file",
        {
          worktreePath: environment.worktreePath,
          filePath: "README.md",
          base64Data: Buffer.from("lost save").toString("base64"),
        },
      ],
      [
        "write_local_file",
        {
          worktreePath: path.dirname(environment.worktreePath!),
          filePath: path.join(path.basename(environment.worktreePath!), "README.md"),
          base64Data: Buffer.from("raw lost save").toString("base64"),
        },
      ],
      [
        "write_initial_prompt_attachments",
        {
          environmentId: environment.id,
          attachments: [
            {
              id: "attachment",
              name: "draft.txt",
              base64Data: Buffer.from("draft").toString("base64"),
            },
          ],
        },
      ],
      [
        "revert_local_file",
        { environmentId: environment.id, filePath: "README.md", targetBranch: "main" },
      ],
      [
        "rename_local_file",
        { environmentId: environment.id, filePath: "README.md", newName: "renamed.md" },
      ],
      ["delete_local_file", { environmentId: environment.id, filePath: "README.md" }],
      [
        "create_local_folder",
        { environmentId: environment.id, parentDirectory: "", folderName: "new" },
      ],
    ] as const)
      await expect(
        Promise.resolve().then(() => commands.get(command)!(args, context)),
      ).rejects.toThrow("being moved");
    const { control } = await import("./public-api/exec-control.js");
    await expect(control(environment, context, { action: "start" })).rejects.toThrow("being moved");
    const { controlReviewValidation } = await import("./review-validation-service.js");
    await expect(controlReviewValidation(environment.id, {}, "start", context)).rejects.toThrow(
      "being moved",
    );
    expect((await storage.getEnvironment(environment.id))?.worktreePath).toBe(
      environment.worktreePath,
    );
  } finally {
    resume();
    await moving;
  }
  const moved = (await storage.getEnvironment(environment.id))!;
  expect(await fs.readFile(path.join(moved.worktreePath!, "README.md"), "utf8")).toBe("fixture");
  expect(await exists(environment.worktreePath!)).toBe(false);
});

test("move admission waits for already admitted mutations to settle", async () => {
  const { root, context, startLocal } = await setup();
  const environment = await startLocal();
  const release = context.runtime.environments.fence.beginMutation(environment.id);
  try {
    await expect(
      moveEnvironmentTask(environment.id, path.join(root, "moved"), context),
    ).rejects.toThrow("mutation");
    await fs.writeFile(
      path.join(environment.worktreePath!, "README.md"),
      "acknowledged before move",
    );
  } finally {
    release();
  }
  const moved = await moveEnvironmentTask(environment.id, path.join(root, "moved"), context, {
    forceCopy: true,
    sessionHomes: isolatedHomes(root),
  });
  expect(await fs.readFile(path.join(moved.worktreePath!, "README.md"), "utf8")).toBe(
    "acknowledged before move",
  );
});

test("Cursor read failure retains recovery until the store can follow the destination", async () => {
  const { root, storage, context, startLocal } = await setup();
  const environment = await startLocal();
  const homes = isolatedHomes(root);
  const file = path.join(homes.cursorStateDir, "cursor-sdk", "agents.ndjson");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({ agentId: "cursor-1", cwd: environment.worktreePath }) + "\n",
  );
  const read = fs.readFile.bind(fs);
  const failing = spyOn(fs, "readFile").mockImplementation(((
    name: Parameters<typeof fs.readFile>[0],
    ...args: unknown[]
  ) => {
    if (String(name) === file)
      return Promise.reject(Object.assign(new Error("read failed"), { code: "EIO" }));
    return (read as (...args: unknown[]) => Promise<unknown>)(name, ...args);
  }) as typeof fs.readFile);
  let moved: Environment;
  try {
    moved = await moveEnvironmentTask(environment.id, path.join(root, "moved"), context, {
      forceCopy: true,
      sessionHomes: homes,
    });
  } finally {
    failing.mockRestore();
  }
  expect(moved.lifecycleError).toContain("Cursor");
  expect(moved.worktreeMove?.phase).toBe("committed");
  expect(await exists(environment.worktreePath!)).toBe(true);
  expect(() => context.runtime.environments.fence.assertAcceptsAgentWork(environment.id)).toThrow(
    "recovery is pending",
  );
  await expect(
    moveEnvironmentTask(environment.id, path.join(root, "again"), context),
  ).rejects.toThrow("recovery is pending");
  await recoverInterruptedEnvironmentMoves(context, { sessionHomes: homes });
  expect(JSON.parse(await fs.readFile(file, "utf8")).cwd).toBe(moved.worktreePath);
  expect((await storage.getEnvironment(environment.id))?.worktreeMove).toBeUndefined();
  expect(await exists(environment.worktreePath!)).toBe(false);
  expect(() =>
    context.runtime.environments.fence.assertAcceptsAgentWork(environment.id),
  ).not.toThrow();
});

test("an acknowledged native turn with persisted idle prevents move before quiescing", async () => {
  const { root, storage, context, startLocal } = await setup();
  const environment = await startLocal();
  const { NativeAgentService } = await import("./native-agent-service.js");
  const { createProviderStub } = await import("./native-agent-service-projection-test-support.js");
  const stub = createProviderStub("codex", { activity: async () => "working" });
  const service = new NativeAgentService(
    storage,
    async () => {
      throw new Error("unexpected start");
    },
    { provider: async () => stub.provider },
  );
  context.nativeAgents = service;
  const quiesce = spyOn(tmux, "cleanupEnvironmentTmux");
  try {
    await service.dispatchPrompt({
      environmentId: environment.id,
      agent: "codex",
      logicalSessionKey: "tab",
      prompt: "fixture",
      requestId: "active-before-sweep",
    });
    expect((await storage.getEnvironment(environment.id))?.agentActivityState ?? "idle").toBe(
      "idle",
    );
    expect((await storage.listNativeAgentSessions())[0]?.pendingDispatch).toBeUndefined();
    await expect(
      moveEnvironmentTask(environment.id, path.join(root, "moved"), context, {
        sessionHomes: isolatedHomes(root),
      }),
    ).rejects.toThrow("agent is running");
    expect(quiesce).not.toHaveBeenCalled();
    expect(stub.abort).not.toHaveBeenCalled();
    expect(stub.dispose).not.toHaveBeenCalled();
    expect(await exists(environment.worktreePath!)).toBe(true);
  } finally {
    await service.shutdown();
  }
});

test("a file write admitted first blocks copying until its acknowledged edit is present", async () => {
  const { root, context, commands, startLocal } = await setup();
  const environment = await startLocal();
  const write = shell.writeFileBase64;
  let entered!: () => void;
  const writing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const paused = spyOn(shell, "writeFileBase64").mockImplementation(async (...args) => {
    entered();
    await gate;
    return write(...args);
  });
  const saving = Promise.resolve(
    commands.get("write_local_file")!(
      {
        worktreePath: environment.worktreePath,
        filePath: "README.md",
        base64Data: Buffer.from("acknowledged edit").toString("base64"),
      },
      context,
    ),
  );
  try {
    await writing;
    await expect(
      moveEnvironmentTask(environment.id, path.join(root, "moved"), context, {
        forceCopy: true,
        sessionHomes: isolatedHomes(root),
      }),
    ).rejects.toThrow("file mutation or worker start is in progress");
  } finally {
    finish();
    await saving;
    paused.mockRestore();
  }
  const moved = await moveEnvironmentTask(environment.id, path.join(root, "moved"), context, {
    forceCopy: true,
    sessionHomes: isolatedHomes(root),
  });
  expect(await fs.readFile(path.join(moved.worktreePath!, "README.md"), "utf8")).toBe(
    "acknowledged edit",
  );
});

test("an incomplete copy rollback never asks recovery to adopt its partially removed destination", async () => {
  const { root, storage, context, startLocal, projectPath } = await setup();
  const environment = await startLocal();
  const update = storage.updateEnvironment.bind(storage);
  spyOn(storage, "updateEnvironment").mockImplementation(async (id, changes) => {
    if (changes.worktreePath && (changes.worktreeMove as { phase?: string })?.phase === "committed")
      throw new Error("commit rejected");
    return update(id, changes);
  });
  const remove = spyOn(pathSafety, "removeConfinedDirectory").mockImplementationOnce(
    async (parent, relative) => {
      await fs.rm(path.join(parent, relative, "README.md"));
      throw new Error("partial removal");
    },
  );
  await expect(
    moveEnvironmentTask(environment.id, path.join(root, "moved"), context, {
      forceCopy: true,
      sessionHomes: isolatedHomes(root),
    }),
  ).rejects.toThrow("commit rejected");
  expect((await storage.getEnvironment(environment.id))?.worktreeMove?.phase).toBe("moving");
  remove.mockRestore();
  await recoverInterruptedEnvironmentMoves(context, { sessionHomes: isolatedHomes(root) });
  expect((await storage.getEnvironment(environment.id))?.worktreePath).toBe(
    environment.worktreePath,
  );
  expect((await storage.getEnvironment(environment.id))?.worktreeMove).toBeUndefined();
  expect(await fs.readFile(path.join(environment.worktreePath!, "README.md"), "utf8")).toBe(
    "fixture",
  );
  expect(await registeredWorktrees(projectPath)).toContain(environment.worktreePath!);
});

test("a running user command refuses move before quiescing or recording a lifecycle error", async () => {
  const { root, context, startLocal, storage } = await setup();
  const environment = await startLocal();
  const terminate = mock(async () => []);
  const original = context.runtime.terminals.terminateSessionsForEnvironment;
  context.runtime.terminals.terminateSessionsForEnvironment = terminate;
  context.userCommands = { hasRunning: () => true } as unknown as CommandContext["userCommands"];
  try {
    await expect(
      moveEnvironmentTask(environment.id, path.join(root, "destination"), context),
    ).rejects.toThrow("still running");
    expect(terminate).not.toHaveBeenCalled();
    const current = await storage.getEnvironment(environment.id);
    expect(current?.lifecycleError).toBeFalsy();
    expect(current?.lifecycleOperation).toBeUndefined();
    expect(current?.worktreePath).toBe(environment.worktreePath);
  } finally {
    context.runtime.terminals.terminateSessionsForEnvironment = original;
  }
});

// git refuses to move a worktree with submodules even within one disk; that
// move is a rename, and only another disk copies.
describe("same-disk move of a worktree git will not move", () => {
  function countCopies() {
    const run = shell.runCommand;
    const calls = { copies: 0 };
    spyOn(shell, "runCommand").mockImplementation(async (command, args, options) => {
      if (command === "cp") calls.copies++;
      return run(command, args, options);
    });
    return calls;
  }

  test("renames the folder instead of copying it", async () => {
    const { root, projectPath, storage, context, startLocal } = await setup();
    const environment = await startLocal();
    const from = environment.worktreePath!;
    await addNestedSubmodules(root, projectPath, from);
    await fs.mkdir(path.join(from, "node_modules", "dep"), { recursive: true });
    await fs.writeFile(path.join(from, "node_modules", "dep", "index.js"), "ignored");
    const inode = (await fs.stat(path.join(from, "node_modules", "dep", "index.js"))).ino;
    const calls = countCopies();
    const destination = path.join(root, "deeper", "elsewhere");

    const moved = await moveEnvironmentTask(environment.id, destination, context, {
      sessionHomes: isolatedHomes(root),
    });

    const to = path.join(destination, path.basename(from));
    expect(calls.copies).toBe(0);
    expect(moved.worktreePath).toBe(to);
    expect(moved.lifecycleError).toBeFalsy();
    expect(moved.worktreeMove).toBeUndefined();
    expect((await fs.stat(path.join(to, "node_modules", "dep", "index.js"))).ino).toBe(inode);
    expect(await exists(from)).toBe(false);
    expect(await registeredWorktrees(projectPath)).toContain(to);
    expect(await registeredWorktrees(projectPath)).not.toContain(from);
    await expectSubmodulesLinked(to);
    expect((await storage.getEnvironment(environment.id))?.worktreePath).toBe(to);
  });

  test("copies only when the rename reports another disk", async () => {
    const { root, projectPath, context, startLocal } = await setup();
    const environment = await startLocal();
    const from = environment.worktreePath!;
    await addNestedSubmodules(root, projectPath, from);
    const destination = path.join(root, "elsewhere");
    const to = path.join(destination, path.basename(from));
    const rename = fs.rename.bind(fs);
    spyOn(fs, "rename").mockImplementation(async (source, target) => {
      if (source === from && target === to) {
        throw Object.assign(new Error("EXDEV: cross-device link not permitted"), {
          code: "EXDEV",
        });
      }
      return rename(source, target);
    });
    const calls = countCopies();

    const moved = await moveEnvironmentTask(environment.id, destination, context, {
      sessionHomes: isolatedHomes(root),
    });

    expect(calls.copies).toBe(1);
    expect(moved.worktreePath).toBe(to);
    expect(moved.lifecycleError).toBeFalsy();
    expect(await exists(from)).toBe(false);
    expect(await registeredWorktrees(projectPath)).toContain(to);
    await expectSubmodulesLinked(to);
  });

  test("a failed repair after the rename puts the folder back", async () => {
    const { root, projectPath, storage, context, startLocal } = await setup();
    const environment = await startLocal();
    const from = environment.worktreePath!;
    await addNestedSubmodules(root, projectPath, from);
    const destination = path.join(root, "elsewhere");
    const to = path.join(destination, path.basename(from));
    const run = shell.runCommand;
    spyOn(shell, "runCommand").mockImplementation(async (command, args, options) => {
      if (command === "git" && args?.includes("repair") && args.includes(to)) {
        throw new Error("repair failed");
      }
      return run(command, args, options);
    });

    await expect(
      moveEnvironmentTask(environment.id, destination, context, {
        sessionHomes: isolatedHomes(root),
      }),
    ).rejects.toThrow("repair failed");

    expect(await exists(to)).toBe(false);
    const current = (await storage.getEnvironment(environment.id))!;
    expect(current.worktreePath).toBe(from);
    expect(current.worktreeMove).toBeUndefined();
    expect(await registeredWorktrees(projectPath)).toContain(from);
    await expectSubmodulesLinked(from);
  });

  test.each(["repair", "relink"])(
    "a failed source %s after rename-back retains recovery until all links are repaired",
    async (failure) => {
      const { root, projectPath, storage, context, startLocal } = await setup();
      const environment = await startLocal();
      const from = environment.worktreePath!;
      await addNestedSubmodules(root, projectPath, from);
      const destination = path.join(root, "elsewhere");
      const to = path.join(destination, path.basename(from));
      const run = shell.runCommand;
      let fail = true;
      const commandSpy = spyOn(shell, "runCommand").mockImplementation(
        async (command, args, options) => {
          if (fail && command === "git") {
            // Destination repair succeeds, but relinking fails. Rename-back then
            // succeeds before either source repair or source relinking fails.
            if (args?.[0] === "config" && args.includes("core.worktree"))
              throw new Error("relink failed");
            if (failure === "repair" && args?.includes("repair") && args.includes(from))
              throw new Error("source repair failed");
          }
          return run(command, args, options);
        },
      );

      await expect(
        moveEnvironmentTask(environment.id, destination, context, {
          sessionHomes: isolatedHomes(root),
        }),
      ).rejects.toThrow("relink failed");
      expect(await exists(from)).toBe(true);
      expect(await exists(to)).toBe(false);
      expect((await storage.getEnvironment(environment.id))?.worktreeMove?.phase).toBe("moving");
      expect(() =>
        context.runtime.environments.fence.assertAcceptsAgentWork(environment.id),
      ).toThrow("recovery");

      // A restart while the source is still unrepairable must also keep the
      // journal and fence, including when only a submodule relink fails.
      await recoverInterruptedEnvironmentMoves(context, { sessionHomes: isolatedHomes(root) });
      expect((await storage.getEnvironment(environment.id))?.worktreeMove).toBeDefined();
      expect(() =>
        context.runtime.environments.fence.assertAcceptsAgentWork(environment.id),
      ).toThrow("recovery");

      fail = false;
      await recoverInterruptedEnvironmentMoves(context, { sessionHomes: isolatedHomes(root) });
      commandSpy.mockRestore();
      const recovered = (await storage.getEnvironment(environment.id))!;
      expect(recovered.worktreePath).toBe(from);
      expect(recovered.worktreeMove).toBeUndefined();
      expect(() =>
        context.runtime.environments.fence.assertAcceptsAgentWork(environment.id),
      ).not.toThrow();
      expect(await registeredWorktrees(projectPath)).toContain(from);
      expect(await registeredWorktrees(projectPath)).not.toContain(to);
      await expectSubmodulesLinked(from);
    },
  );

  test("a rejected commit renames the folder back", async () => {
    const { root, projectPath, storage, context, startLocal } = await setup();
    const environment = await startLocal();
    const from = environment.worktreePath!;
    await addNestedSubmodules(root, projectPath, from);
    const update = storage.updateEnvironment.bind(storage);
    spyOn(storage, "updateEnvironment").mockImplementation(async (id, changes) => {
      if ((changes.worktreeMove as { phase?: string } | undefined)?.phase === "committed")
        throw new Error("commit rejected");
      return update(id, changes);
    });
    const destination = path.join(root, "moved");

    await expect(
      moveEnvironmentTask(environment.id, destination, context, {
        sessionHomes: isolatedHomes(root),
      }),
    ).rejects.toThrow("commit rejected");

    expect(await exists(path.join(destination, path.basename(from)))).toBe(false);
    const current = (await storage.getEnvironment(environment.id))!;
    expect(current.worktreePath).toBe(from);
    expect(current.worktreeMove).toBeUndefined();
    expect(await registeredWorktrees(projectPath)).toContain(from);
    await expectSubmodulesLinked(from);
  });

  test("restart recovery adopts a rename that was not repaired", async () => {
    const { root, projectPath, storage, context, startLocal } = await setup();
    const environment = await startLocal();
    const from = environment.worktreePath!;
    await addNestedSubmodules(root, projectPath, from);
    const destination = path.join(root, "elsewhere");
    const to = path.join(destination, path.basename(from));
    // The folder moved, then the backend lost track before repairing git.
    const rename = fs.rename.bind(fs);
    const renameSpy = spyOn(fs, "rename").mockImplementation(async (source, target) => {
      await rename(source, target);
      if (source === from && target === to) throw new Error("backend stopped");
    });

    await expect(
      moveEnvironmentTask(environment.id, destination, context, {
        sessionHomes: isolatedHomes(root),
      }),
    ).rejects.toThrow("backend stopped");
    const pending = (await storage.getEnvironment(environment.id))!;
    expect(pending.worktreePath).toBe(from);
    expect(pending.worktreeMove?.phase).toBe("moving");
    expect(pending.worktreeMove?.submodules?.map((entry) => entry.path)).toEqual([
      "libs/sub",
      "libs/sub/nested",
    ]);
    renameSpy.mockRestore();

    await recoverInterruptedEnvironmentMoves(context, { sessionHomes: isolatedHomes(root) });

    const recovered = (await storage.getEnvironment(environment.id))!;
    expect(recovered.worktreePath).toBe(to);
    expect(recovered.worktreeMove).toBeUndefined();
    expect(await registeredWorktrees(projectPath)).toContain(to);
    await expectSubmodulesLinked(to);
  });
});
