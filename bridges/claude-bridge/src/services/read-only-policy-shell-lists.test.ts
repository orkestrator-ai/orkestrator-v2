import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoordinatorCommandSandbox } from "@orkestrator/protocol/coordinator";
import { protectedDataDirBoundary } from "@orkestrator/protocol/node/coordinator-read-boundary";
import type { ReadBoundary } from "./read-only-path-boundary.js";
import {
  coordinatorProcessPolicy,
  createCoordinatorReadOnlyHook,
  isReadOnlyShellCommand,
} from "./read-only-policy.js";

/**
 * The shell a reviewer actually writes: quoted patterns, `;`/`&&` lists, a
 * variable naming the review artifacts, `cd` into the checkout, `git -C` and
 * `sed -n` ranges. Each command of a list is judged on its own, and what runs
 * is the serialization of the words judged.
 */

const policy = coordinatorProcessPolicy({});
const sandboxed = { commandSandbox: "required", role: "read-only" } as const;
const hardened = {
  commandSandbox: "unavailable",
  gitWithoutSandbox: "harden",
  role: "read-only",
} as const;

let root = "";
let checkout = "";
let boundary: ReadBoundary;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "read-only-lists-")));
  checkout = join(root, "checkout");
  mkdirSync(join(checkout, ".orkestrator", "review-artifacts", "r1"), { recursive: true });
  mkdirSync(join(checkout, "apps", "web"), { recursive: true });
  mkdirSync(join(checkout, "linked"));
  mkdirSync(join(root, "other"), { recursive: true });
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "data", "secret"), "fixture");
  // A directory in the checkout that leads out of it.
  symlinkSync(join(root, "other"), join(checkout, "escape"));
  symlinkSync(join(root, "other"), join(checkout, "apps", "linked"));
  symlinkSync(join(checkout, "apps", "web"), join(checkout, "internal-link"));
  boundary = protectedDataDirBoundary(join(root, "data"), [])!;
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

async function hookAnswer(
  command: string,
  options: {
    commandSandbox: CoordinatorCommandSandbox;
    gitWithoutSandbox?: "harden";
    readBoundary?: ReadBoundary | null;
    cwd?: string;
  },
) {
  const hook = createCoordinatorReadOnlyHook(policy, [], {
    commandSandbox: options.commandSandbox,
    ...(options.gitWithoutSandbox ? { gitWithoutSandbox: options.gitWithoutSandbox } : {}),
    role: "read-only",
    readBoundary: options.readBoundary ?? null,
    workspaceRoot: checkout,
  });
  const output = await hook(
    {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command, description: "Check the reviewed commit" },
      cwd: options.cwd ?? checkout,
    } as never,
    undefined as never,
    { signal: new AbortController().signal } as never,
  );
  return (
    output as {
      hookSpecificOutput?: {
        permissionDecision?: string;
        permissionDecisionReason?: string;
        updatedInput?: Record<string, unknown>;
      };
    }
  ).hookSpecificOutput;
}

describe("a reviewer's shell lists", () => {
  test("the commands from the review conversations are admitted", async () => {
    for (const command of [
      "git diff abc123..def456",
      "git show def456:apps/web/src/x.ts",
      `git show def456:apps/x.ts | grep -n "useState\\|useEffect" | head -40`,
      "git diff --no-color --no-renames abc...def --stat; git diff abc...def -- apps",
      "git rev-parse HEAD && git status --short | head",
      "git show def456:apps/x.ts | sed -n 120,180p",
      "git show def456:apps/x.ts | cat -n | sed -n '1,40p;200,$p'",
      `git log --format="%h %s" -5 -- apps`,
      "git log --format=%h\\ %s -3",
      `git grep -n -E "mise run|bun " def456 -- docs`,
      "D=.orkestrator/review-artifacts/r1; cat $D/validation-01.stdout.txt; tail -c 2000 $D/validation-01.stderr.txt",
      `jq -c "del(.diff) | keys" .orkestrator/review-artifacts/r1/package.json`,
      "cd .orkestrator/review-artifacts/r1 && cat validation-01.stdout.txt validation-01.stderr.txt",
      `cd ${checkout}; git diff abc..def --stat`,
      `git -C ${checkout} show def456:apps/x.ts | head -20`,
      "git -C apps log --oneline -3",
    ]) {
      for (const options of [
        { commandSandbox: "required" as const },
        { commandSandbox: "unavailable" as const, gitWithoutSandbox: "harden" as const },
      ]) {
        const answer = await hookAnswer(command, options);
        expect({
          command,
          sandbox: options.commandSandbox,
          decision: answer?.permissionDecision,
        }).toEqual({ command, sandbox: options.commandSandbox, decision: undefined });
      }
    }
  });

  test("what runs is the words that were judged, quoted and with variables substituted", async () => {
    const expected: [string, string][] = [
      [`git show d:a.ts | grep -n "a\\|b"`, "git show d:a.ts | grep -n 'a\\|b'"],
      [
        "D=.orkestrator/review-artifacts/r1\ncat $D/a.txt && wc -l ${D}/b.txt",
        "cat .orkestrator/review-artifacts/r1/a.txt && wc -l .orkestrator/review-artifacts/r1/b.txt",
      ],
    ];
    for (const [command, runs] of expected) {
      expect(isReadOnlyShellCommand(command, sandboxed).command).toBe(runs);
      expect(await hookAnswer(command, { commandSandbox: "required" })).toEqual({
        hookEventName: "PreToolUse",
        updatedInput: { command: runs, description: "Check the reviewed commit" },
      });
    }
    // Hardened Git gets its flags in every command of the list.
    expect(
      isReadOnlyShellCommand(`cd apps; git diff a..b -- "web/x y.ts" && git show b:x`, {
        ...hardened,
        cwd: checkout,
      }).command,
    ).toBe(
      `cd -P -- ${join(checkout, "apps")}; git diff --no-ext-diff --no-textconv --submodule=short a..b -- 'web/x y.ts' && git show --no-ext-diff --no-textconv --submodule=short b:x`,
    );
    // A command that needs nothing changed runs as written.
    expect(isReadOnlyShellCommand("git diff a..b; ls", sandboxed).command).toBeUndefined();
  });

  test("one refused command refuses the whole list, wherever it is", async () => {
    for (const command of [
      "git diff a..b; rm -rf src",
      "ls && git commit -m x",
      "cat a || git push",
      "git status; touch x",
      `grep -n "x" a; sort -o out a`,
      `sort "-oout.txt" in`,
      "git diff a..b > out.patch",
      "cat $HOME/.ssh/id_ed25519",
      "D=x; cat $E",
      "git show a:b | sh",
      `cat a; "bin/cat" b`,
      "bun test a.test.ts",
      "env NODE_ENV=test bun test",
      "python3 -I -c print",
    ]) {
      for (const options of [
        { commandSandbox: "required" as const },
        { commandSandbox: "unavailable" as const, gitWithoutSandbox: "harden" as const },
      ]) {
        expect({
          command,
          allowed: isReadOnlyShellCommand(command, { ...options, cwd: checkout }).allowed,
        }).toEqual({ command, allowed: false });
        expect((await hookAnswer(command, options))?.permissionDecision).toBe("deny");
      }
    }
  });

  test("`cd` and `git -C` stay inside the checkout", async () => {
    for (const command of [
      "cd .. && ls",
      "cd / ; cat etc/passwd",
      `cd ${join(root, "other")} && git diff`,
      "cd escape && ls",
      "cd escape/.. && ls",
      "cd missing && ls",
      "cd",
      "cd -",
      "cd -P apps",
      "cd apps web",
      "ls | cd apps",
      "git -C .. status",
      `git -C ${join(root, "other")} log`,
      "git -C escape log",
      "git -C escape/.. log",
      "git -C apps -C linked status",
      "git -C",
    ]) {
      const answer = await hookAnswer(command, { commandSandbox: "required" });
      expect({ command, decision: answer?.permissionDecision }).toEqual({
        command,
        decision: "deny",
      });
    }
    // Without a known directory there is nothing to resolve against.
    expect(isReadOnlyShellCommand("cd apps && ls", sandboxed).allowed).toBe(false);
    // The checkout is fixed for the turn, so a shell left in a subdirectory
    // by an earlier call can still return to its root, and no further.
    const fromSub = { commandSandbox: "required" as const, cwd: join(checkout, "apps") };
    expect((await hookAnswer("cd .. && ls", fromSub))?.permissionDecision).toBeUndefined();
    expect((await hookAnswer("cd ../.. && ls", fromSub))?.permissionDecision).toBe("deny");
  });

  test("directory changes use their physical targets and Git applies -C cumulatively", () => {
    const options = { ...hardened, cwd: checkout };
    const apps = join(checkout, "apps");
    const web = join(apps, "web");
    expect(isReadOnlyShellCommand("cd internal-link/.. && pwd", options).command).toBe(
      `cd -P -- ${apps} && pwd`,
    );
    const git = isReadOnlyShellCommand("git -C apps -C web status", options);
    expect(git.allowed).toBe(true);
    expect(git.command).toBe(`git -C ${apps} -C ${web} status`);
    expect(git.stages?.[0]?.directories).toEqual([web]);
    expect(isReadOnlyShellCommand("git -C internal-link/.. status", options).command).toBe(
      `git -C ${apps} status`,
    );
  });

  test("a successful cd narrows the directories for its && successor", async () => {
    const command = "cd apps && cd web && pwd";
    const verdict = isReadOnlyShellCommand(command, { ...hardened, cwd: checkout });
    expect(verdict.stages).toEqual([
      { words: ["pwd"], directories: [join(checkout, "apps", "web")] },
    ]);
    expect((await hookAnswer(command, hardened))?.permissionDecision).toBeUndefined();
    for (const operator of [";", "||"]) {
      expect((await hookAnswer(`cd apps ${operator} cd web`, hardened))?.permissionDecision).toBe(
        "deny",
      );
    }
  });

  test("paths are checked against every directory a command may run in", async () => {
    const options = { commandSandbox: "required" as const, readBoundary: boundary };
    // From the checkout this names the data directory's secret; from
    // `apps/web` it names a file inside the checkout, and the other way round.
    expect((await hookAnswer("cat ../data/secret", options))?.permissionDecision).toBe("deny");
    expect(
      (await hookAnswer("cat ../../../data/secret", options))?.permissionDecision,
    ).toBeUndefined();
    for (const command of [
      "cd apps/web && cat ../../../data/secret",
      // A `cd` that fails leaves the shell where it was, so both are checked.
      "cd apps/web; cat ../data/secret",
      "cd apps/web || cat ../data/secret",
      "cd apps/web && false || cat ../../../data/secret",
      "git -C apps/web diff --no-index ../../../data/secret x",
    ]) {
      expect({
        command,
        decision: (await hookAnswer(command, options))?.permissionDecision,
      }).toEqual({
        command,
        decision: "deny",
      });
    }
  });

  test("AWK and yq accept simple reads and refuse interpreter side effects", async () => {
    for (const options of [sandboxed, hardened]) {
      for (const command of ["awk '{ print $1, $2 }' fixture.txt", "yq .name.value fixture.yaml"]) {
        expect((await hookAnswer(command, options))?.permissionDecision).toBeUndefined();
      }
      // Inert operands exercise syntax admission. None of these commands run.
      for (const command of [
        `awk 'BEGIN { system("") }'`,
        `awk 'BEGIN { print 1 | "" }'`,
        `awk 'BEGIN { print 1 > "" }'`,
        `awk 'BEGIN { getline < "" }'`,
        "awk '{ print $1 }' mode=1 fixture.txt",
        `yq 'load("")' fixture.yaml`,
        "yq .name fixture.yaml --inplace",
      ]) {
        expect({
          command,
          decision: (await hookAnswer(command, options))?.permissionDecision,
        }).toEqual({
          command,
          decision: "deny",
        });
      }
    }
  });

  test("`sed` prints line ranges and does nothing else", () => {
    for (const command of [
      "sed -n 10,20p a.ts",
      "sed -n 5p a.ts",
      "sed -n '1,$p' a.ts",
      "sed -n '10,20p;40,60p' a.ts b.ts",
      "sed 50q a.ts",
      "sed --quiet -s 1,3p -- a.ts",
    ]) {
      expect({ command, allowed: isReadOnlyShellCommand(command, sandboxed).allowed }).toEqual({
        command,
        allowed: true,
      });
    }
    for (const command of [
      "sed -i s/a/b/ a.ts",
      "sed -n 1p -i a.ts",
      "sed s/a/b/w a.ts",
      "sed -n '1p;w out' a.ts",
      "sed -n 1,5w a.ts",
      "sed e a.ts",
      "sed -e 1p a.ts",
      "sed -f script.sed a.ts",
      "sed -n /x/p a.ts",
      "sed --in-place=bak 1p a.ts",
      "sed -n",
    ]) {
      expect({ command, allowed: isReadOnlyShellCommand(command, sandboxed).allowed }).toEqual({
        command,
        allowed: false,
      });
    }
  });
});
