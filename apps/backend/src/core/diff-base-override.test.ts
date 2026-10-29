import { expect, test } from "bun:test";
import {
  environmentBaselineCommit,
  parseEnvironmentDiffBaseOverride,
} from "@orkestrator/protocol/diff-stats";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { registerDiffBaseCommands } from "./commands-registry-diff-base.js";
import {
  listDiffBaseCommits,
  parseDiffBaseBranches,
  parseDiffBaseCommits,
  resolveDiffBaseOverride,
  validateDiffBaseRef,
  type DiffBaseGit,
} from "./diff-base-override.js";
import type { Environment } from "./models.js";

const TIP = "a".repeat(40);
const OLDER = "b".repeat(40);
const CREATED = "c".repeat(40);
const ADVANCED = "d".repeat(40);

test("branches list local and remote refs and skip the remote HEAD alias", () => {
  expect(
    parseDiffBaseBranches(
      [
        "refs/heads/feature",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
        "refs/tags/v1",
        "",
      ].join("\n"),
    ),
  ).toEqual([
    { ref: "refs/heads/feature", name: "feature", kind: "local" },
    { ref: "refs/remotes/origin/main", name: "origin/main", kind: "remote" },
  ]);
});

test("commits parse subject, author and date and drop malformed records", () => {
  const output =
    `${TIP}\x1fMerge main\x1fAda\x1f2026-10-28T10:00:00+00:00\x1e\n` +
    `not-a-sha\x1fbroken\x1fx\x1fy\x1e\n` +
    `${OLDER.toUpperCase()}\x1fFix: a\x1fb\x1fBob\x1f2026-10-27T10:00:00+00:00\x1e\n`;
  expect(parseDiffBaseCommits(output)).toEqual([
    { commit: TIP, subject: "Merge main", author: "Ada", committedAt: "2026-10-28T10:00:00+00:00" },
    // Fields are split on the unit separator, so a subject never splits on punctuation.
    { commit: OLDER, subject: "Fix: a", author: "b", committedAt: "Bob" },
  ]);
});

test("commit listing follows first parents of a validated branch ref", async () => {
  const calls: string[][] = [];
  const git: DiffBaseGit = async (args) => {
    calls.push(args);
    return `${TIP}\x1fTip\x1fAda\x1f2026-10-28T10:00:00Z\x1e`;
  };
  expect(await listDiffBaseCommits(git, "refs/remotes/origin/main", 10_000)).toHaveLength(1);
  expect(calls[0]).toEqual([
    "log",
    "--first-parent",
    "--max-count=500",
    "--format=%H\x1f%s\x1f%an\x1f%cI\x1e",
    "refs/remotes/origin/main",
    "--",
  ]);
  await expect(listDiffBaseCommits(git, "--output=/tmp/x")).rejects.toThrow();
  await expect(listDiffBaseCommits(git, "main")).rejects.toThrow("Invalid branch ref");
  expect(() => validateDiffBaseRef("refs/tags/v1")).toThrow("Invalid branch ref");
});

test("an override is saved only for a full SHA the checkout can read", async () => {
  const git: DiffBaseGit = async (args) => {
    if (args.at(-2) === `${TIP}^{commit}`) return "Merge main into feature\n";
    throw new Error("unknown revision");
  };
  expect(
    await resolveDiffBaseOverride(git, { ref: "refs/remotes/origin/main", commit: TIP }),
  ).toEqual({ ref: "refs/remotes/origin/main", commit: TIP, subject: "Merge main into feature" });
  await expect(
    resolveDiffBaseOverride(git, { ref: "refs/remotes/origin/main", commit: OLDER }),
  ).rejects.toThrow("is not in this environment's checkout");
  await expect(
    resolveDiffBaseOverride(git, { ref: "refs/remotes/origin/main", commit: "main" }),
  ).rejects.toThrow("full commit SHA");
});

test("a chosen base wins over the automatic baseline and the creation commit", () => {
  const environment = {
    createdFromCommit: CREATED,
    diffBaseline: { createdFromCommit: CREATED, commit: ADVANCED },
  };
  expect(environmentBaselineCommit(environment)).toBe(ADVANCED);
  expect(
    environmentBaselineCommit({
      ...environment,
      diffBaseOverride: { ref: "refs/remotes/origin/main", commit: TIP },
    }),
  ).toBe(TIP);
  // Applies even to an environment created before the creation commit was recorded.
  expect(
    environmentBaselineCommit({
      diffBaseOverride: { ref: "refs/heads/main", commit: TIP },
    }),
  ).toBe(TIP);
  expect(environmentBaselineCommit({ ...environment, diffBaseOverride: null })).toBe(ADVANCED);
});

test("stored overrides are validated and normalised", () => {
  expect(
    parseEnvironmentDiffBaseOverride({
      ref: "refs/remotes/origin/main",
      commit: TIP.toUpperCase(),
      subject: "  Tip  ",
    }),
  ).toEqual({ ref: "refs/remotes/origin/main", commit: TIP, subject: "Tip" });
  expect(() => parseEnvironmentDiffBaseOverride({ ref: "main", commit: TIP })).toThrow();
  expect(() =>
    parseEnvironmentDiffBaseOverride({ ref: "refs/heads/main", commit: "abc" }),
  ).toThrow();
  expect(() => parseEnvironmentDiffBaseOverride({ ref: "refs/heads/a b", commit: TIP })).toThrow();
});

function commandHarness(environment: Environment) {
  const handlers = new Map<string, CommandHandler>();
  const gitCalls: string[][] = [];
  registerDiffBaseCommands((name, handler) => handlers.set(name, handler), {
    gitFor: () => async (args) => {
      gitCalls.push(args);
      if (args[0] === "for-each-ref") return "refs/remotes/origin/main\n";
      return "Tip subject\n";
    },
  });
  let stored: Environment = environment;
  const events: string[] = [];
  const context = {
    storage: {
      getEnvironment: async (id: string) => (id === stored.id ? stored : null),
      updateEnvironment: async (_id: string, updates: Partial<Environment>) => {
        events.push("update");
        stored = { ...stored, ...updates };
        return stored;
      },
    },
    runtime: {
      diffStats: {
        sync: async () => void events.push("sync"),
        service: { refresh: (id: string) => void events.push(`refresh:${id}`) },
      },
    },
  } as unknown as CommandContext;
  const run = (name: string, args: Record<string, unknown>) => handlers.get(name)!(args, context);
  return { run, events, gitCalls, stored: () => stored };
}

test("set_environment_diff_base saves, retargets scans and clears", async () => {
  const harness = commandHarness({ id: "env-1" } as Environment);
  const saved = (await harness.run("set_environment_diff_base", {
    environmentId: "env-1",
    ref: "refs/remotes/origin/main",
    commit: TIP,
  })) as Environment;
  expect(saved.diffBaseOverride).toEqual({
    ref: "refs/remotes/origin/main",
    commit: TIP,
    subject: "Tip subject",
  });
  expect(harness.events).toEqual(["update", "sync", "refresh:env-1"]);

  const cleared = (await harness.run("set_environment_diff_base", {
    environmentId: "env-1",
    ref: null,
    commit: null,
  })) as Environment;
  expect(cleared.diffBaseOverride).toBeNull();

  await expect(
    harness.run("set_environment_diff_base", { environmentId: "env-1", ref: null, commit: TIP }),
  ).rejects.toThrow("ref must be a string");
  await expect(
    harness.run("list_environment_diff_base_branches", { environmentId: "missing" }),
  ).rejects.toThrow("Environment not found");
  expect(
    await harness.run("list_environment_diff_base_branches", { environmentId: "env-1" }),
  ).toEqual([{ ref: "refs/remotes/origin/main", name: "origin/main", kind: "remote" }]);
});
