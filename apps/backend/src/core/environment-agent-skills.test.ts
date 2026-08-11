import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ENVIRONMENT_AGENT_SKILLS_SCRIPT } from "./environment-agent-skills.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })),
  );
});

function runScanner(cwd: string, provider: string, operation: string, filePath = "") {
  return Bun.spawnSync({
    cmd: [process.execPath, "-e", ENVIRONMENT_AGENT_SKILLS_SCRIPT, provider, operation, filePath],
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("environment agent skills scanner", () => {
  test("lists and reads a project skill from inside the environment", async () => {
    const temporaryWorktree = await fs.mkdtemp(path.join(os.tmpdir(), "ork-environment-skills-"));
    tempDirectories.push(temporaryWorktree);
    // macOS exposes /var through /private/var, while a spawned process reports
    // the real cwd. Build expected paths from the same canonical directory.
    const worktree = await fs.realpath(temporaryWorktree);
    await fs.mkdir(path.join(worktree, ".git"));
    const skillDirectory = path.join(worktree, ".codex", "skills", "review");
    const skillPath = path.join(skillDirectory, "SKILL.md");
    await fs.mkdir(skillDirectory, { recursive: true });
    await fs.writeFile(
      skillPath,
      "---\nname: review\ndescription: Review this environment\n---\n\n# Review\n",
    );

    const listed = runScanner(worktree, "codex", "list");
    expect(listed.exitCode).toBe(0);
    const scan = JSON.parse(listed.stdout.toString()) as {
      skills: Array<{ name: string; filePath: string; scope: string }>;
    };
    expect(scan.skills).toContainEqual(expect.objectContaining({
      name: "review",
      filePath: skillPath,
      scope: "project",
    }));

    const read = runScanner(worktree, "codex", "read", skillPath);
    expect(read.exitCode).toBe(0);
    expect(JSON.parse(read.stdout.toString())).toMatchObject({
      path: skillPath,
      content: expect.stringContaining("# Review"),
      truncated: false,
    });
  });

  test("refuses reads outside the selected agent's skill roots", async () => {
    const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "ork-environment-skills-"));
    tempDirectories.push(worktree);
    await fs.mkdir(path.join(worktree, ".git"));
    const outside = path.join(worktree, "outside", "SKILL.md");
    await fs.mkdir(path.dirname(outside), { recursive: true });
    await fs.writeFile(outside, "# Outside\n");

    const read = runScanner(worktree, "claude", "read", outside);
    expect(read.exitCode).toBe(1);
    expect(read.stderr.toString()).toContain("outside the environment's agent skill directories");
    expect(read.stdout.toString()).toBe("");
  });
});
