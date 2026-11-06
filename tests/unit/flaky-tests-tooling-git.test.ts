/**
 * The recurrence check and stale report against a small registry in a
 * temporary Git repository. Real Git puts this file in the slow tier.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkRecurrence, formatReport } from "../../scripts/flaky-tests/recurrence-check";
import { formatReport as formatStale, staleReport } from "../../scripts/flaky-tests/stale-report";

let root: string;
let repo: string;
let feature: string;
const commits: Record<string, string> = {};

function git(cwd: string, args: string[], date = "2026-09-01T12:00:00Z"): string {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.toString("utf8").trim();
}

function write(relative: string, content: string) {
  const target = path.join(repo, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function commit(name: string, date: string) {
  git(repo, ["add", "-A"], date);
  git(repo, ["commit", "-q", "-m", name], date);
  commits[name] = git(repo, ["rev-parse", "HEAD"]);
}

const REGISTRY = "docs/tests/flaky-tests";

function caseFile(group: string, id: string, slug: string, status: string, body: string) {
  write(
    `${REGISTRY}/${group}/${id}-${slug}.md`,
    `# Case ${id}\n\n- **ID:** ${id}\n- **Status:** ${status}\n${body}\n`,
  );
}

function index(group: string, rows: Array<[string, string, string, string]>) {
  write(
    `${REGISTRY}/${group}/0000-index.md`,
    [
      `# Flaky tests: ${group}`,
      "",
      "| ID | Status | Test | File | Symptom | Case |",
      "| --- | --- | --- | --- | --- | --- |",
      ...rows.map(
        ([id, status, file, slug]) =>
          `| ${id} | ${status} | \`Test ${id}\` | ${file} | Symptom. | [${id}-${slug}.md](${id}-${slug}.md) |`,
      ),
      "",
    ].join("\n"),
  );
}

function groupG(resolved: boolean, cited?: string) {
  index("g", [
    ["0001", "open", "tests/a.test.ts", "open-old"],
    ["0002", resolved ? "resolved" : "open", "tests/b.test.ts", "fixed"],
    ["0003", "open", "tests/gone.test.ts:4", "gone"],
    ["0004", "open", "tests/a.test.ts", "fresh"],
    ["0005", "environmental", "tests/a.test.ts", "env"],
    ...(cited ? ([["0006", "open", "`tests/b.test.ts`", "cited"]] as const) : []),
  ] as Array<[string, string, string, string]>);
}

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "flaky-tools-git-"));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);

  write("tests/a.test.ts", "a\n");
  write("tests/b.test.ts", "b\n");
  write("tests/gone.test.ts", "gone\n");
  write(`${REGISTRY}/0000-index.md`, "# Flaky tests\n");
  groupG(false);
  caseFile("g", "0001", "open-old", "open", "- **Date observed:** 2026-09-01");
  caseFile("g", "0002", "fixed", "open", "- **Date observed:** 2026-09-01");
  caseFile("g", "0003", "gone", "open", "- **Date observed:** 2026-09-02");
  caseFile(
    "g",
    "0004",
    "fresh",
    "open",
    "- **Date observed:** 2026-09-01\n- **Recurrence (2026-11-01).**",
  );
  caseFile("g", "0005", "env", "environmental", "- **Date observed:** 2026-08-01");
  index("h", [["0007", "open", "Several suites; see case", "prose"]]);
  caseFile("h", "0007", "prose", "open", "- **Date observed:** 2026-08-01");
  commit("base", "2026-09-01T12:00:00Z");

  // A branch commit that is never merged, standing in for one later squashed.
  git(repo, ["checkout", "-q", "-b", "side"]);
  write("tests/b.test.ts", "b side fix\n");
  commit("side", "2026-09-05T12:00:00Z");
  git(repo, ["checkout", "-q", "main"]);

  // The fix flips its case to resolved in the same change.
  write("tests/b.test.ts", "b fixed\n");
  groupG(true);
  caseFile(
    "g",
    "0002",
    "fixed",
    "resolved",
    `- **Date observed:** 2026-09-01\n\n## Resolution (2026-09-10)\n\nFirst tried on \`${commits.side}\`.`,
  );
  commit("fix", "2026-09-10T12:00:00Z");

  // An actual fix can predate retrospective closure of its registry entry.
  caseFile("h", "0008", "retrospective", "open", "- **Date observed:** 2026-09-01");
  commit("before-retrospective-fix", "2026-09-11T12:00:00Z");
  write("tests/retrospective.test.ts", "fixed\n");
  commit("earlier-fix", "2026-09-12T12:00:00Z");
  caseFile(
    "h",
    "0008",
    "retrospective",
    "resolved",
    `## Resolution\n\nFixed by \`${commits["earlier-fix"]}\`.`,
  );
  commit("retrospective-closure", "2026-09-13T12:00:00Z");

  // Later work: one owner changes, another is deleted, a case cites an old commit.
  write("tests/a.test.ts", "a changed\n");
  rmSync(path.join(repo, "tests/gone.test.ts"));
  groupG(true, commits.base);
  caseFile(
    "g",
    "0006",
    "cited",
    "open",
    `- **Date observed:** 2026-09-20\n- Observed at \`${commits.base!.slice(0, 9)}\`.`,
  );
  commit("later", "2026-09-15T12:00:00Z");

  // A worktree on a branch cut before the fix: its own registry still says open.
  git(repo, ["branch", "feature", commits.base!]);
  feature = path.join(root, "feature");
  git(repo, ["worktree", "add", "-q", feature, "feature"]);
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("recurrence check", () => {
  test("uses the earlier fix without requiring retrospective registry closure", async () => {
    const after = await checkRecurrence({ query: "0008", base: commits["earlier-fix"]!, repo });
    expect(after.cases[0]!.statusFlip).toEqual({
      commit: commits["retrospective-closure"]!,
      inBase: false,
    });
    expect(after.cases[0]!.verdict).toEqual({
      kind: "real-recurrence",
      fixes: [commits["earlier-fix"]!],
    });
    const before = await checkRecurrence({
      query: "0008",
      base: commits["before-retrospective-fix"]!,
      repo,
    });
    expect(before.cases[0]!.verdict).toEqual({
      kind: "base-predates-fix",
      missing: [commits["earlier-fix"]!],
    });
  });

  test("a base that contains the fix makes it a real recurrence", async () => {
    const report = await checkRecurrence({ query: "2", base: "HEAD", repo });
    const [entry] = report.cases;
    expect(entry!.record.status).toBe("resolved");
    expect(entry!.statusFlip).toEqual({ commit: commits.fix!, inBase: true });
    expect(entry!.verdict).toEqual({ kind: "real-recurrence", fixes: [commits.fix!] });
    // The unmerged branch commit is listed but cannot decide the verdict.
    expect(entry!.cited).toEqual([
      {
        cited: commits.side!,
        commit: commits.side!,
        inBase: false,
        onRegistryRef: false,
        inResolution: true,
      },
    ]);
    expect(formatReport(report)).toContain("This is a real recurrence: reopen the case");
  });

  test("a base that predates the fix is not a recurrence", async () => {
    const report = await checkRecurrence({ query: "0002", base: commits.base!, repo });
    expect(report.cases[0]!.verdict).toEqual({
      kind: "base-predates-fix",
      missing: [commits.fix!],
    });
    expect(formatReport(report)).toContain(
      `resolved, but the base predates fix ${commits.fix!.slice(0, 10)}`,
    );
  });

  test("a branch reads the resolution from the registry ref, not its stale copy", async () => {
    const base = git(feature, ["merge-base", "HEAD", "main"]);
    const stale = await checkRecurrence({ query: "0002", base, repo: feature });
    expect(stale.cases[0]!.verdict.kind).toBe("open");
    const current = await checkRecurrence({
      query: "0002",
      base,
      registryRef: "main",
      repo: feature,
    });
    expect(current.registry).toBe("main");
    expect(current.cases[0]!.verdict).toEqual({
      kind: "base-predates-fix",
      missing: [commits.fix!],
    });
  });

  test("open and environmental cases say how to record the failure", async () => {
    const open = await checkRecurrence({ query: "0001-open-old", base: "HEAD", repo });
    expect(open.cases[0]!.verdict.kind).toBe("open");
    const environmental = await checkRecurrence({ query: "0005", base: "HEAD", repo });
    expect(environmental.cases[0]!.verdict.kind).toBe("environmental");
    await expect(checkRecurrence({ query: "0099", base: "HEAD", repo })).rejects.toThrow(
      /No case file matches/,
    );
    await expect(checkRecurrence({ query: "0001", base: "nope", repo })).rejects.toThrow(
      /--base nope is not a commit/,
    );
  });
});

describe("stale report", () => {
  test("lists stale open cases, most closable first", async () => {
    const report = await staleReport({ days: 21, today: "2026-11-06", repo });
    expect(report.openCases).toBe(5);
    expect(report.cases.map((entry) => [entry.row.id, entry.signal])).toEqual([
      ["0003", "file-gone"],
      ["0001", "file-changed"],
      ["0006", "cited-in-head"],
      ["0007", "none"],
    ]);
    const [gone, changed, cited, prose] = report.cases;
    // The deletion is the change that matters here.
    expect(gone!.files).toEqual([
      { path: "tests/gone.test.ts", exists: false, changedBy: [commits.later!.slice(0, 10)] },
    ]);
    // The commit made on the observation day itself does not count.
    expect(changed!.files[0]!.changedBy).toEqual([commits.later!.slice(0, 10)]);
    expect(changed!.ageDays).toBe(66);
    expect(cited!.citedInHead).toEqual([commits.base!.slice(0, 9)]);
    expect(cited!.files[0]).toMatchObject({ path: "tests/b.test.ts", changedBy: [] });
    expect(prose!.files).toEqual([]);

    const text = formatStale(report);
    expect(text.split("\n")[0]).toBe(
      "Stale flake cases: 4 of 5 open cases were last observed more than 21 days before 2026-11-06.",
    );
    expect(text).toContain(
      "owning file gone: 1; owning file changed since: 2; cited commit in HEAD: 1; no owning file named: 1",
    );
  });

  test("narrows to one group and to a longer window", async () => {
    const group = await staleReport({ days: 21, today: "2026-11-06", repo, group: "g" });
    expect(group.openCases).toBe(4);
    expect(group.cases.map((entry) => entry.row.id)).toEqual(["0003", "0001", "0006"]);
    const longer = await staleReport({ days: 65, today: "2026-11-06", repo });
    expect(longer.cases.map((entry) => entry.row.id)).toEqual(["0001", "0007"]);
  });
});
