import { prMergeCheckArgs } from "../../../apps/backend/src/core/pull-request-merge-preflight";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

function copyInstaller(repo: string): string {
  const trusted = path.join(repo, "trusted source");
  const scripts = path.join(trusted, "scripts");
  mkdirSync(scripts, { recursive: true });
  cpSync(path.join(root, "scripts/merge-drivers"), path.join(scripts, "merge-drivers"), {
    recursive: true,
  });
  cpSync(
    path.join(root, "scripts/contract-manifest-format.ts"),
    path.join(scripts, "contract-manifest-format.ts"),
  );
  return path.join(scripts, "merge-drivers/install.ts");
}

function write(repo: string, file: string, text: string) {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), text);
}

/** A repository whose two branches each add a to-do row and a command. */
function divergedRepository(): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), "merge-drivers-"));
  dirs.push(repo);
  expect(git(repo, "init", "-q", "-b", "main").status).toBe(0);
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

    const head = git(repo, "rev-parse", "HEAD").out.trim();
    const base = git(repo, "rev-parse", "theirs").out.trim();
    expect(git(repo, ...prMergeCheckArgs(base, head))).toMatchObject({
      status: 0,
      out: "conflict\n",
    });
    const linked = path.join(repo, "linked worktree");
    expect(git(repo, "worktree", "add", "-qb", "linked", linked, head).status).toBe(0);
    // Only Git metadata contains the registered bundle. The new worktree has
    // neither the registration sources nor any workspace dependencies.
    const merge = git(linked, "merge", "--no-edit", "theirs");
    expect(merge.status, merge.out).toBe(0);
    const merged = git(linked, "rev-parse", "HEAD").out.trim();
    expect(git(linked, ...prMergeCheckArgs(base, merged))).toMatchObject({
      status: 0,
      out: "clean\n",
    });
    expect(readFileSync(path.join(linked, INDEX), "utf8")).toBe(
      index([indexRow(1, "0001-a.md"), indexRow(2, "0002-ours.md"), indexRow(3, "0003-theirs.md")]),
    );
    expect(readFileSync(path.join(linked, MANIFEST), "utf8")).toBe(
      manifest(["alpha", "beta", "gamma"]),
    );
  });

  test("concurrent standalone setup is idempotent without workspace dependencies", async () => {
    const repo = divergedRepository();
    const installer = copyInstaller(repo);
    const users = Array.from({ length: 6 }, () =>
      Bun.spawn([process.execPath, installer], { cwd: repo, stdout: "ignore", stderr: "pipe" }),
    );
    for (const program of users) {
      const [status, error] = await Promise.all([
        program.exited,
        new Response(program.stderr).text(),
      ]);
      expect(status, error).toBe(0);
    }
    const config = path.join(repo, ".git/config");
    const inode = statSync(config).ino;
    expect(run(repo, "bun", [installer]).status).toBe(0);
    expect(statSync(config).ino).toBe(inode);
    rmSync(path.dirname(path.dirname(path.dirname(installer))), { recursive: true });
    expect(git(repo, "merge", "--no-edit", "theirs").status).toBe(0);
  });

  test("a registered driver whose script is missing falls back to Git's line merge", () => {
    const repo = divergedRepository();
    expect(run(repo, "bun", [path.join(root, "scripts/merge-drivers/install.ts")]).status).toBe(0);
    rmSync(path.join(repo, ".git", "orkestrator-merge-drivers"), { recursive: true });
    const merge = git(repo, "merge", "--no-edit", "theirs");
    expect(merge.status).not.toBe(0);
    expect(readFileSync(path.join(repo, INDEX), "utf8")).toContain("<<<<<<<");
  });

  test("the registered structured driver writes Git conflict markers when it cannot merge a row", () => {
    const repo = divergedRepository();
    expect(run(repo, "bun", [path.join(root, "scripts/merge-drivers/install.ts")]).status).toBe(0);
    const ours = index([indexRow(1, "0001-a.md")]).replace("Covers.", "Our edit.");
    const theirs = index([indexRow(1, "0001-a.md")]).replace("Covers.", "Their edit.");
    write(repo, INDEX, ours);
    expect(git(repo, "commit", "-qam", "change ours").status).toBe(0);
    expect(git(repo, "checkout", "-q", "theirs").status).toBe(0);
    write(repo, INDEX, theirs);
    expect(git(repo, "commit", "-qam", "change theirs").status).toBe(0);
    expect(git(repo, "checkout", "-q", "main").status).toBe(0);
    const merge = git(repo, "merge", "--no-edit", "theirs");
    expect(merge).toMatchObject({ status: 1 });
    expect(merge.out).toContain("structured merge cannot decide");
    expect(readFileSync(path.join(repo, INDEX), "utf8")).toContain("<<<<<<<");
  });
});
