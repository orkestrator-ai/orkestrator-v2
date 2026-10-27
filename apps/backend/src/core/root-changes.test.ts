import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
      getEnvironment: async (id: string) => (id === environment.id ? environment : null),
      getProject: async (id: string) => (id === "project-1" ? { id, localPath: checkout } : null),
    },
    runtime: { environments: { fence: { beginMutation: () => () => undefined } } },
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
