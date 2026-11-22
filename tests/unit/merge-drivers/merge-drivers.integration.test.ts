import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { serializeContractManifest } from "../../../scripts/generate-contract-manifest";

// Real Git merges through the registered drivers: two branches that both add
// a to-do and a command merge with no hand edits (slow tier: real Git).

const root = path.resolve(import.meta.dir, "../../..");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(cwd: string, command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const git = (cwd: string, ...args: string[]) => run(cwd, "git", args);

const indexRow = (rank: number, file: string) =>
  `| ${rank} | [${file}](${file}) | Low | backlog | — | Covers. | Why. |`;
const index = (rows: string[]) =>
  `# Area\n\n| Rank | File | Criticality | Status | Needs you | Covers | Why this rating |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows.join("\n")}\n`;

function manifest(names: string[]): string {
  const commands = Object.fromEntries(
    names.sort().map((name) => [name, { domain: "a", untyped: true, read: false }]),
  );
  return serializeContractManifest({
    schemaVersion: 1,
    generatedBy: "scripts/generate-contract-manifest.ts (mise run contract:manifest)",
    counts: { commands: names.length, defined: 0, untyped: names.length, events: 0 },
    untypedByDomain: { a: names.length },
    domains: {},
    commands,
    events: {},
  } as unknown as Parameters<typeof serializeContractManifest>[0]);
}

const INDEX = "docs/todo/area/0000-index.md";
const MANIFEST = "packages/protocol/contracts/manifest.json";

function write(repo: string, file: string, text: string) {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), text);
}

/** A repository whose two branches each add a to-do row and a command. */
function divergedRepository(): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), "merge-drivers-"));
  dirs.push(repo);
  expect(git(repo, "init", "-q", "-b", "main").status).toBe(0);
  // The drivers resolve from the worktree being merged; point it at this checkout's.
  symlinkSync(path.join(root, "scripts"), path.join(repo, "scripts"));
  writeFileSync(path.join(repo, ".gitattributes"), readFileSync(path.join(root, ".gitattributes")));
  write(repo, INDEX, index([indexRow(1, "0001-a.md")]));
  write(repo, MANIFEST, manifest(["alpha"]));
  git(repo, "add", ".gitattributes", INDEX, MANIFEST);
  expect(git(repo, "commit", "-qm", "base").status).toBe(0);

  git(repo, "checkout", "-qb", "theirs");
  write(repo, INDEX, index([indexRow(1, "0001-a.md"), indexRow(2, "0003-theirs.md")]));
  write(repo, MANIFEST, manifest(["alpha", "gamma"]));
  expect(git(repo, "commit", "-qam", "theirs").status).toBe(0);

  git(repo, "checkout", "-q", "main");
  write(repo, INDEX, index([indexRow(1, "0001-a.md"), indexRow(2, "0002-ours.md")]));
  write(repo, MANIFEST, manifest(["alpha", "beta"]));
  expect(git(repo, "commit", "-qam", "ours").status).toBe(0);
  return repo;
}

describe("merge drivers", () => {
  test("without the registration Git's line merge conflicts on both files", () => {
    const repo = divergedRepository();
    const merge = git(repo, "merge", "--no-edit", "theirs");
    expect(merge.status).not.toBe(0);
    expect(
      git(repo, "diff", "--name-only", "--diff-filter=U").out.trim().split("\n").sort(),
    ).toEqual([INDEX, MANIFEST].sort());
  });

  test("registered, two branches that both add a to-do and a command merge cleanly", () => {
    const repo = divergedRepository();
    const check = run(repo, "bun", [
      path.join(root, "scripts/merge-drivers/install.ts"),
      "--check",
    ]);
    expect(check.status).toBe(1);
    expect(run(repo, "bun", [path.join(root, "scripts/merge-drivers/install.ts")]).status).toBe(0);
    expect(
      run(repo, "bun", [path.join(root, "scripts/merge-drivers/install.ts"), "--check"]).status,
    ).toBe(0);

    const merge = git(repo, "merge", "--no-edit", "theirs");
    expect(merge.status, merge.out).toBe(0);
    expect(readFileSync(path.join(repo, INDEX), "utf8")).toBe(
      index([indexRow(1, "0001-a.md"), indexRow(2, "0002-ours.md"), indexRow(3, "0003-theirs.md")]),
    );
    expect(readFileSync(path.join(repo, MANIFEST), "utf8")).toBe(
      manifest(["alpha", "beta", "gamma"]),
    );
  });

  test("a registered driver whose script is missing falls back to Git's line merge", () => {
    const repo = divergedRepository();
    expect(run(repo, "bun", [path.join(root, "scripts/merge-drivers/install.ts")]).status).toBe(0);
    rmSync(path.join(repo, "scripts"));
    const merge = git(repo, "merge", "--no-edit", "theirs");
    expect(merge.status).not.toBe(0);
    expect(readFileSync(path.join(repo, INDEX), "utf8")).toContain("<<<<<<<");
  });
});
