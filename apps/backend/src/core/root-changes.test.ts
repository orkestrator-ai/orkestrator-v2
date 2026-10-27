import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandContext } from "./commands-context.js";
import {
  applyRootChanges,
  buildRootChangesPatch,
  listRootChanges,
  parseRootChangeStatus,
  patchPaths,
} from "./root-changes.js";
import { runCommand } from "./shell.js";
import * as shell from "./shell.js";
import { NodeActionRequests } from "./nodes/node-action-requests.js";
import { StorageService } from "./storage.js";
import { EnvironmentMutationFence } from "./environment-replacement-fence.js";

let root: string;
let checkout: string;
let worker: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await runCommand("git", args, { cwd })).stdout;
}

/** Everything that would show a write to the checkout's Git state. */
async function checkoutState(): Promise<string> {
  const objects: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else objects.push(path.relative(checkout, full));
    }
  };
  await walk(path.join(checkout, ".git", "objects"));
  const index = await readFile(path.join(checkout, ".git", "index"));
  return JSON.stringify({
    objects: objects.toSorted(),
    index: createHash("sha256").update(index).digest("hex"),
    status: await git(checkout, "status", "--porcelain=v1", "--untracked-files=all"),
  });
}

function contextFor(environment: Record<string, unknown>): CommandContext {
  return {
    storage: {
      withProjectCreationLock: async (_key: string, operation: () => Promise<unknown>) =>
        operation(),
      getEnvironment: async (id: string) => (id === environment.id ? environment : null),
      getProject: async (id: string) => (id === "project-1" ? { id, localPath: checkout } : null),
    },
    runtime: { environments: { fence: new EnvironmentMutationFence() } },
  } as unknown as CommandContext;
}

const workerEnvironment = () => ({
  id: "worker-1",
  projectId: "project-1",
  environmentType: "local",
  status: "running",
  worktreePath: worker,
});

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ork-root-changes-"));
  checkout = path.join(root, "checkout");
  worker = path.join(root, "worker");
  await runCommand("git", ["init", "-b", "main", checkout]);
  await git(checkout, "config", "user.email", "test@example.invalid");
  await git(checkout, "config", "user.name", "Test");
  await writeFile(path.join(checkout, "edited.txt"), "one\ntwo\n");
  await writeFile(path.join(checkout, "removed.txt"), "gone soon\n");
  await writeFile(path.join(checkout, "kept.txt"), "unchanged\n");
  await writeFile(path.join(checkout, ".gitignore"), "ignored.log\n");
  await git(checkout, "add", ".");
  await git(checkout, "commit", "-m", "base");
  await git(checkout, "worktree", "add", "-b", "worker", worker);
  // Uncommitted work in the checkout: an edit, a deletion, a staged new
  // file, an untracked file (with binary bytes), and an ignored file.
  await writeFile(path.join(checkout, "edited.txt"), "one\ntwo\nthree\n");
  await unlink(path.join(checkout, "removed.txt"));
  await writeFile(path.join(checkout, "staged.txt"), "staged\n");
  await git(checkout, "add", "staged.txt");
  await writeFile(path.join(checkout, "new.bin"), Buffer.from([0, 1, 2, 255, 0, 10]));
  await writeFile(path.join(checkout, "ignored.log"), "noise\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("root changes", () => {
  test("parses porcelain status, leaving conflicts and ignored files out", () => {
    expect(
      parseRootChangeStatus(
        [
          " M a.txt",
          "D  b.txt",
          "A  c.txt",
          "?? d.txt",
          "UU e.txt",
          "!! f.log",
          "AM g.txt",
          "",
        ].join("\0"),
      ),
    ).toEqual({
      files: [
        { path: "a.txt", status: "modified" },
        { path: "b.txt", status: "deleted" },
        { path: "c.txt", status: "added" },
        { path: "d.txt", status: "untracked" },
        { path: "g.txt", status: "added" },
      ],
      conflicts: 1,
    });
  });

  test("lists the checkout's changes without the ignored file", async () => {
    const listing = await listRootChanges(checkout);
    expect(listing.files.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: "edited.txt", status: "modified" },
      { path: "new.bin", status: "untracked" },
      { path: "removed.txt", status: "deleted" },
      { path: "staged.txt", status: "added" },
    ]);
    expect(listing.headCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(listing.conflicts).toBe(0);
  });

  test("building the patch never writes to the checkout", async () => {
    const before = await checkoutState();
    const patch = await buildRootChangesPatch(
      checkout,
      ["edited.txt", "removed.txt", "staged.txt", "new.bin"],
      ["new.bin"],
    );
    expect(patchPaths(patch).toSorted()).toEqual([
      "edited.txt",
      "new.bin",
      "removed.txt",
      "staged.txt",
    ]);
    expect(await checkoutState()).toBe(before);
  });

  test("applies only the picked files to a local worker", async () => {
    const before = await checkoutState();
    const outcome = await applyRootChanges(contextFor(workerEnvironment()), {
      projectId: "project-1",
      environmentId: "worker-1",
      paths: ["edited.txt", "removed.txt", "new.bin"],
    });
    expect(outcome.files.toSorted()).toEqual(["edited.txt", "new.bin", "removed.txt"]);
    expect(await readFile(path.join(worker, "edited.txt"), "utf8")).toBe("one\ntwo\nthree\n");
    expect(await readFile(path.join(worker, "new.bin"))).toEqual(
      Buffer.from([0, 1, 2, 255, 0, 10]),
    );
    expect(await readFile(path.join(worker, "removed.txt")).catch(() => null)).toBeNull();
    // Not picked: stays out of the worker.
    expect(await readFile(path.join(worker, "staged.txt")).catch(() => null)).toBeNull();
    expect(await checkoutState()).toBe(before);
  });

  test("a patch that does not apply leaves the worker untouched", async () => {
    // The worker already diverged on one of the two picked files.
    await writeFile(path.join(worker, "edited.txt"), "something else\n");
    await expect(
      applyRootChanges(contextFor(workerEnvironment()), {
        projectId: "project-1",
        environmentId: "worker-1",
        paths: ["edited.txt", "new.bin"],
      }),
    ).rejects.toThrow("do not apply to the worker");
    expect(await readFile(path.join(worker, "new.bin")).catch(() => null)).toBeNull();
    expect(await readFile(path.join(worker, "edited.txt"), "utf8")).toBe("something else\n");
  });

  test("refuses paths the checkout does not report as changed, and the project home", async () => {
    await expect(
      applyRootChanges(contextFor(workerEnvironment()), {
        projectId: "project-1",
        environmentId: "worker-1",
        paths: ["kept.txt"],
      }),
    ).rejects.toThrow("no longer changed");
    await expect(
      applyRootChanges(contextFor({ ...workerEnvironment(), projectHome: true }), {
        projectId: "project-1",
        environmentId: "worker-1",
        paths: ["edited.txt"],
      }),
    ).rejects.toThrow("cannot receive its own changes");
    await expect(
      applyRootChanges(contextFor({ ...workerEnvironment(), projectId: "other" }), {
        projectId: "project-1",
        environmentId: "worker-1",
        paths: ["edited.txt"],
      }),
    ).rejects.toThrow("not in this project");
  });
});

test("quoted UTF-8 and special Git paths survive patch application and reporting", async () => {
  const paths = [
    "café.txt",
    'a"quote.txt',
    "a\ttab.txt",
    "a\nnewline.txt",
    "a b/name b/file.txt",
    "a space.txt",
  ];
  const { mkdir } = await import("node:fs/promises");
  for (const file of paths) {
    await mkdir(path.dirname(path.join(checkout, file)), { recursive: true });
    await writeFile(path.join(checkout, file), "selected\n");
  }
  const outcome = await applyRootChanges(contextFor(workerEnvironment()), {
    projectId: "project-1",
    environmentId: "worker-1",
    paths,
  });
  expect(outcome.files.toSorted()).toEqual(paths.toSorted());
  for (const file of paths)
    expect(await readFile(path.join(worker, file), "utf8")).toBe("selected\n");
});

test("oversized diff capture errors never expose patch bytes", async () => {
  await writeFile(
    path.join(checkout, "large.txt"),
    "PRIVATE_PATCH_CONTENT".repeat(3 * 1024 * 1024),
  );
  try {
    await buildRootChangesPatch(checkout, ["large.txt"], ["large.txt"]);
    throw new Error("expected oversized capture to fail");
  } catch (error) {
    expect((error as Error).message).toBe(
      "Could not capture the selected changes; pick fewer files and retry.",
    );
    expect(JSON.stringify(error)).not.toContain("PRIVATE_PATCH_CONTENT");
  }
}, 30_000);

test("a completed move before apply admission uses the new worktree", async () => {
  const old = worker;
  const moved = path.join(root, "moved");
  const env = workerEnvironment();
  const context = contextFor(env);
  context.storage.withProjectCreationLock = async (_key, operation) => {
    await git(checkout, "worktree", "move", old, moved);
    env.worktreePath = moved;
    return operation();
  };
  const begin = spyOn(context.runtime.environments.fence, "beginMutation");
  await applyRootChanges(context, {
    projectId: "project-1",
    environmentId: "worker-1",
    paths: ["edited.txt"],
  });
  expect(begin).toHaveBeenCalledTimes(1);
  expect(await readFile(path.join(moved, "edited.txt"), "utf8")).toContain("three");
});

for (const container of [false, true])
  test(`concurrent ${container ? "container" : "local"} applies serialize check and write under the move fence`, async () => {
    const storage = new StorageService(path.join(root, "data"));
    await storage.init();
    const context = contextFor({
      ...workerEnvironment(),
      ...(container ? { environmentType: "containerized", containerId: "fixture-container" } : {}),
    });
    context.storage.withProjectCreationLock = storage.withProjectCreationLock.bind(storage);
    const original = shell.runCommand;
    const events: string[] = [];
    const command = spyOn(shell, "runCommand").mockImplementation(
      async (executable, args = [], options) => {
        if (executable === "docker" || args[0] === "apply") {
          const gitArgs = executable === "docker" ? args.slice(args.indexOf("git") + 1) : args;
          const check = gitArgs.includes("--check");
          events.push(check ? "check" : "apply");
          expect(() => context.runtime.environments.fence.beginMove("worker-1")).toThrow(
            "mutation",
          );
          await new Promise((resolve) => setTimeout(resolve, 15));
          return original("git", gitArgs, { ...options, cwd: worker });
        }
        return original(executable, args, options);
      },
    );
    try {
      const outcomes = await Promise.all(
        ["edited.txt", "new.bin"].map((file) =>
          applyRootChanges(context, {
            projectId: "project-1",
            environmentId: "worker-1",
            paths: [file],
          }),
        ),
      );
      expect(events).toEqual(["check", "apply", "check", "apply"]);
      expect(outcomes.flatMap((outcome) => outcome.files).toSorted()).toEqual([
        "edited.txt",
        "new.bin",
      ]);
      expect(await readFile(path.join(worker, "edited.txt"), "utf8")).toContain("three");
      expect(await readFile(path.join(worker, "new.bin"))).toEqual(
        Buffer.from([0, 1, 2, 255, 0, 10]),
      );
      expect(context.runtime.environments.fence.beginMove("worker-1")).toBe(true);
      context.runtime.environments.fence.endMove("worker-1");
    } finally {
      command.mockRestore();
    }
  });

for (const status of ["stopped", "running"])
  test(`container apply refuses ${status === "stopped" ? "stopped containers" : "missing container IDs"}`, async () => {
    await expect(
      applyRootChanges(
        contextFor({
          ...workerEnvironment(),
          environmentType: "containerized",
          status,
          ...(status === "stopped" ? { containerId: "container" } : {}),
        }),
        { projectId: "project-1", environmentId: "worker-1", paths: ["edited.txt"] },
      ),
    ).rejects.toThrow("Start the worker container");
  });

test("container check failure skips apply and releases the mutation fence", async () => {
  const context = contextFor({
    ...workerEnvironment(),
    environmentType: "containerized",
    containerId: "container",
  });
  const original = shell.runCommand;
  const calls: string[][] = [];
  const command = spyOn(shell, "runCommand").mockImplementation(
    async (executable, args = [], options) => {
      if (executable === "docker") {
        calls.push(args);
        throw new Error("error: patch does not apply");
      }
      return original(executable, args, options);
    },
  );
  try {
    await expect(
      applyRootChanges(context, {
        projectId: "project-1",
        environmentId: "worker-1",
        paths: ["edited.txt"],
      }),
    ).rejects.toThrow("do not apply");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--check");
    expect(context.runtime.environments.fence.beginMove("worker-1")).toBe(true);
    context.runtime.environments.fence.endMove("worker-1");
  } finally {
    command.mockRestore();
  }
});

test("move admission stays held while patch capture is paused", async () => {
  const context = contextFor(workerEnvironment());
  const original = shell.runCommandBuffer;
  const capture = spyOn(shell, "runCommandBuffer").mockImplementation(async (...args) => {
    expect(() => context.runtime.environments.fence.beginMove("worker-1")).toThrow("mutation");
    return original(...args);
  });
  try {
    await applyRootChanges(context, {
      projectId: "project-1",
      environmentId: "worker-1",
      paths: ["edited.txt"],
    });
  } finally {
    capture.mockRestore();
  }
});

test("diff command failure persists and mails only a content-free approval error", async () => {
  const capture = spyOn(shell, "runCommandBuffer").mockRejectedValue(
    new Error("PRIVATE_PATCH_BYTES"),
  );
  let persisted: unknown;
  let mailed: unknown;
  const actions = new NodeActionRequests({
    load: async () => [],
    save: async (requests) => {
      persisted = structuredClone(requests);
    },
    emit: () => {},
    notify: async (request) => {
      mailed = request;
    },
    executors: {
      "apply-root-changes": async () => {
        await applyRootChanges(contextFor(workerEnvironment()), {
          projectId: "project-1",
          environmentId: "worker-1",
          paths: ["edited.txt"],
        });
        return { code: "applied", message: "Applied" };
      },
    },
  });
  try {
    const request = await actions.create({
      kind: "apply-root-changes",
      targets: [{ nodeId: "self", nodeName: "Self" }],
      requestedBy: {
        coordinatorEnvironmentId: "coordinator:c:v",
        coordinatorTabId: "c",
        projectId: "project-1",
      },
    });
    const resolved = await actions.resolve(request.requestId, "approve");
    expect(resolved).toMatchObject({
      state: "failed",
      result: { message: "Could not capture the selected changes; pick fewer files and retry." },
    });
    expect(JSON.stringify(persisted)).not.toContain("PRIVATE_PATCH_BYTES");
    expect(JSON.stringify(mailed)).not.toContain("PRIVATE_PATCH_BYTES");
  } finally {
    capture.mockRestore();
  }
});
