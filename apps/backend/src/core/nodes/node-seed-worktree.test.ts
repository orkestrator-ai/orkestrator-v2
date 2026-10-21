import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createLocalWorktree } from "../commands-environment.js";
import { runCommand } from "../shell.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function repository(files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-seed-worktree-"));
  roots.push(root);
  const project = path.join(root, "project");
  await fs.mkdir(project);
  await runCommand("git", ["init", "-q", "-b", "main"], { cwd: project });
  await runCommand(
    "git",
    [
      "-c",
      "user.email=qa@example.com",
      "-c",
      "user.name=QA",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ],
    { cwd: project },
  );
  const remote = path.join(root, "remote.git");
  await runCommand("git", ["init", "-q", "--bare", remote], { cwd: root });
  await runCommand("git", ["remote", "add", "origin", remote], { cwd: project });
  await runCommand("git", ["push", "-q", "origin", "main"], { cwd: project });
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(project, file)), { recursive: true });
    await fs.writeFile(path.join(project, file), content);
  }
  return { root, project };
}

describe("FL-03/FL-04/FL-05 seed files in a leaf environment's worktree", () => {
  test("the node's own files are copied, seed files fill only the gaps", async () => {
    const { root, project } = await repository({ ".env": "FROM=leaf", "config/a.json": "leaf-a" });
    const seed = path.join(root, "seed");
    await fs.mkdir(path.join(seed, "config"), { recursive: true });
    await fs.writeFile(path.join(seed, ".env"), "FROM=command");
    await fs.writeFile(path.join(seed, ".env.local"), "LOCAL=command");
    await fs.writeFile(path.join(seed, "config/a.json"), "command-a");
    await fs.writeFile(path.join(seed, "config/b.json"), "command-b");
    const worktree = await createLocalWorktree(
      project,
      "site",
      "feature-seed",
      "main",
      ["config/a.json", "config/b.json"],
      path.join(root, "worktrees"),
      seed,
    );
    const read = (file: string) => fs.readFile(path.join(worktree.path, file), "utf8");
    expect(await read(".env")).toBe("FROM=leaf");
    expect(await read(".env.local")).toBe("LOCAL=command");
    expect(await read("config/a.json")).toBe("leaf-a");
    expect(await read("config/b.json")).toBe("command-b");
  });

  test("without a seed copy a missing selected file still fails as before", async () => {
    const { root, project } = await repository({});
    await expect(
      createLocalWorktree(
        project,
        "site",
        "feature-missing",
        "main",
        ["config/missing.json"],
        path.join(root, "worktrees"),
      ),
    ).rejects.toThrow("Configured file to copy not found");
  });
});

test("command-only selected seed files reach a worktree with an empty leaf selection", async () => {
  const { root, project } = await repository({});
  const seed = path.join(root, "seed");
  await fs.mkdir(path.join(seed, "config"), { recursive: true });
  await fs.writeFile(path.join(seed, "config/command.json"), "command-only");
  const { recordSeedFile } = await import("./node-seed.js");
  await recordSeedFile(seed, "config/command.json");
  const worktree = await createLocalWorktree(
    project,
    "site",
    "command-only",
    "main",
    [],
    path.join(root, "worktrees"),
    seed,
  );
  expect(await fs.readFile(path.join(worktree.path, "config/command.json"), "utf8")).toBe(
    "command-only",
  );
});
