import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextNumber, numbersIn } from "../../../scripts/number-claims";

// "The next number after the highest in use" let two branches cut from the
// same main claim the same to-do or flake number.

describe("number:next", () => {
  test("reads numbers from file and claim names, not the index", () => {
    expect(
      numbersIn(["0000-index.md", "8314-follow-ups.md", "10009", "README.md", "area/0741-x.md"]),
    ).toEqual([8314, 10009, 741]);
  });

  test("steps a random 1 to spread above the highest", () => {
    expect(nextNumber(8314, { spread: 10, random: () => 0 })).toBe("8315");
    expect(nextNumber(8314, { spread: 10, random: () => 0.999 })).toBe("8324");
    expect(nextNumber(41, { random: () => 0 })).toBe("0042");
  });

  test("stays within the register's digits", () => {
    expect(nextNumber(9995, { spread: 10, maxDigits: 4, random: () => 0.999 })).toBe("9999");
    expect(() => nextNumber(9999, { maxDigits: 4 })).toThrow("4 digits");
    expect(nextNumber(10009, { spread: 1 })).toBe("10010");
  });
});

const script = new URL("../../../scripts/number-claims.ts", import.meta.url).pathname;
const workspaces: string[] = [];

afterEach(() => {
  for (const directory of workspaces.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(cwd: string, args: string[], stdin?: string, commitDate?: string): string {
  const result = spawnSync("git", args, {
    cwd,
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, ...(commitDate ? { GIT_COMMITTER_DATE: commitDate } : {}) },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function allocate(cwd: string, args: string[]) {
  const child = Bun.spawn([process.execPath, script, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
}

test("the CLI scans all remote branches and reserves unique numbers in linked worktrees", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ork-number-claims-"));
  workspaces.push(directory);
  const remote = join(directory, "remote");
  const checkout = join(directory, "checkout");
  const linked = join(directory, "linked");
  git(directory, ["init", "-q", "-b", "main", remote]);
  mkdirSync(join(remote, "docs/number-claims/todo"), { recursive: true });
  writeFileSync(join(remote, "docs/number-claims/todo/9500"), "area/9500-remote.md\n");
  git(remote, ["add", "."]);
  git(remote, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "claim",
  ]);
  const claimed = git(remote, ["rev-parse", "HEAD"]);
  git(remote, ["branch", "old-claim", claimed]);
  git(remote, ["rm", "-q", "docs/number-claims/todo/9500"]);
  git(remote, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "new branch tip",
  ]);
  const tip = git(remote, ["rev-parse", "HEAD"]);
  git(
    remote,
    ["update-ref", "--stdin"],
    Array.from({ length: 301 }, (_, i) => `create refs/heads/worker-${i} ${tip}\n`).join(""),
  );
  git(directory, ["clone", "-q", "--single-branch", remote, checkout]);
  git(checkout, ["worktree", "add", "-qb", "linked", linked]);
  mkdirSync(join(checkout, "docs/todo/area"), { recursive: true });

  const discovered = await Promise.all(
    Array.from({ length: 3 }, () => allocate(linked, ["next", "todo", "--spread", "1"])),
  );
  expect(discovered.map(([status]) => status)).toEqual([0, 0, 0]);
  expect(discovered.map(([, stdout]) => stdout.trim()).sort()).toEqual(["9501", "9502", "9503"]);

  writeFileSync(join(checkout, "docs/todo/area/9504-local.md"), "# Local\n");
  const [local, localNumber] = await allocate(checkout, [
    "next",
    "todo",
    "--no-fetch",
    "--spread",
    "1",
  ]);
  expect([local, localNumber.trim()]).toEqual([0, "9505"]);
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      allocate(index % 2 === 0 ? checkout : linked, [
        "next",
        "todo",
        "--no-fetch",
        "--spread",
        "1",
      ]),
    ),
  );
  expect(results.map(([status]) => status)).toEqual(Array(6).fill(0));
  const numbers = results.map(([, text]) => Number(text)).sort((a, b) => a - b);
  expect(new Set(numbers).size).toBe(6);
  expect(numbers).toEqual([9506, 9507, 9508, 9509, 9510, 9511]);

  const [usage, , usageError] = await allocate(checkout, ["next", "constructor"]);
  expect(usage).toBe(2);
  expect(usageError).toContain("usage:");
  git(checkout, ["remote", "set-url", "origin", join(directory, "missing")]);
  const [failed, noNumber, fetchError] = await allocate(checkout, ["next", "todo"]);
  expect(failed).toBe(1);
  expect(noNumber).toBe("");
  expect(fetchError).toContain("Could not fetch every branch");
});
