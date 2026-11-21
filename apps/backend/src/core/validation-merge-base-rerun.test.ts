import { describe, expect, test } from "bun:test";
import {
  validationFailureKey,
  type TriagedValidationFailure,
  type ValidationFailureTriage,
} from "@orkestrator/protocol/validation-failure-triage";
import { buildValidationReport } from "@orkestrator/protocol/validation-report";
import {
  bunFailedTestNames,
  MAX_MERGE_BASE_RERUN_FILES,
  rerunFailuresOnMergeBase,
  type MergeBaseRerunExec,
  type MergeBaseRerunResult,
} from "./validation-merge-base-rerun.js";

const BASE = "a".repeat(40);
const CHECKOUT = "/tmp/orkestrator-merge-base-test";

function failure(
  file: string | null,
  name: string,
  overrides: Partial<TriagedValidationFailure> = {},
): TriagedValidationFailure {
  return {
    key: validationFailureKey("bun", file, name),
    runner: "bun",
    file,
    name,
    outcome: "failed",
    verdict: "undetermined",
    reasons: ["reaches-changed-file-indirectly"],
    ...overrides,
  };
}

function triage(
  failures: TriagedValidationFailure[],
  mergeBase: string | null = BASE,
): ValidationFailureTriage {
  return {
    version: 1,
    mergeBase,
    commands: [{ command: "mise run test", failures, omittedFailures: 0, unattributed: false }],
    limitations: [],
  };
}

const ok = (output = ""): MergeBaseRerunResult => ({ exitCode: 0, output, timedOut: false });
const fail = (output: string, exitCode = 1): MergeBaseRerunResult => ({
  exitCode,
  output,
  timedOut: false,
});

interface Call {
  step: "checkout" | "list" | "install" | "test" | "cleanup";
  args: string[];
  timeoutMs: number;
}

/**
 * A fake environment: `files` exist on the merge base, `tests` answers each
 * test file's run. Every call is recorded.
 */
function fakeExec(options: {
  files: string[];
  tests?: Record<string, MergeBaseRerunResult>;
  checkout?: MergeBaseRerunResult;
  install?: MergeBaseRerunResult;
}) {
  const calls: Call[] = [];
  const exec: MergeBaseRerunExec = async (script, args, timeoutMs) => {
    const step = script.includes("worktree add")
      ? "checkout"
      : script.includes("ls-files")
        ? "list"
        : script.includes(" install ")
          ? "install"
          : script.includes(" test ")
            ? "test"
            : "cleanup";
    calls.push({ step, args, timeoutMs });
    if (step === "checkout") return options.checkout ?? ok();
    if (step === "list") {
      const [, ...queried] = args;
      return ok(queried.filter((path) => options.files.includes(path)).join("\n"));
    }
    if (step === "install") return options.install ?? ok();
    if (step === "test") {
      const [directory, relative] = args;
      const prefix = directory === CHECKOUT ? "" : `${directory!.slice(CHECKOUT.length + 1)}/`;
      return options.tests?.[`${prefix}${relative}`] ?? ok(" 3 pass\n 0 fail\n");
    }
    return ok();
  };
  return { exec, calls };
}

const ROOT_CONFIG = ["package.json", "bun.lock", "bunfig.toml"];

describe("bunFailedTestNames", () => {
  test("reads (fail) lines without colour or timings", () => {
    const names = bunFailedTestNames(
      "\u001b[31m(fail)\u001b[0m suite > breaks [12.50ms]\n(pass) suite > works\n(fail) other\r\n",
    );
    expect([...names]).toEqual(["suite > breaks", "other"]);
  });
});

describe("rerunFailuresOnMergeBase", () => {
  test("labels a test that also fails on the merge base pre-existing", async () => {
    const { exec, calls } = fakeExec({
      files: [...ROOT_CONFIG, "tests/unit/a.test.ts"],
      tests: {
        "tests/unit/a.test.ts": fail("(fail) suite > breaks [3ms]\n 1 pass\n 1 fail\n"),
      },
    });
    const input = triage([
      failure("tests/unit/a.test.ts", "suite > breaks"),
      failure("tests/unit/a.test.ts", "suite > new regression"),
    ]);
    const result = await rerunFailuresOnMergeBase({
      triage: input,
      changedFiles: ["src/x.ts"],
      exec,
      checkoutDir: CHECKOUT,
    });
    const [preExisting, regression] = result.commands[0]!.failures;
    expect(preExisting).toMatchObject({
      verdict: "unrelated",
      reasons: ["reaches-changed-file-indirectly", "failed-on-merge-base"],
    });
    expect(regression).toMatchObject({
      verdict: "undetermined",
      reasons: ["reaches-changed-file-indirectly", "passed-on-merge-base"],
    });
    expect(result.limitations).toEqual([]);
    // Never mutates its input.
    expect(input.commands[0]!.failures[0]!.reasons).toEqual(["reaches-changed-file-indirectly"]);

    expect(calls.map((call) => call.step)).toEqual([
      "checkout",
      "list",
      "install",
      "test",
      "cleanup",
    ]);
    expect(calls[0]!.args).toEqual([CHECKOUT, BASE]);
    expect(calls[2]!.args).toEqual([CHECKOUT]);
    expect(calls[3]!.args).toEqual([CHECKOUT, "tests/unit/a.test.ts"]);
    expect(calls.at(-1)!.args).toEqual([CHECKOUT]);

    const report = buildValidationReport({
      validation: [{ command: "mise run test", status: "failed", exitCode: 1 }],
      failureTriage: result,
    });
    expect(report.failures.map((entry) => [entry.label, entry.onMergeBase])).toEqual([
      ["pre-existing", "failed"],
      ["undetermined", "passed"],
    ]);
  });

  test("runs a package's test from its bunfig directory and installs once per lockfile", async () => {
    const { exec, calls } = fakeExec({
      files: [
        ...ROOT_CONFIG,
        "apps/backend/bunfig.toml",
        "apps/backend/package.json",
        "apps/backend/src/core/a.test.ts",
        "apps/backend/src/core/b.test.ts",
        "bridges/claude-bridge/package.json",
        "bridges/claude-bridge/bun.lock",
        "bridges/claude-bridge/src/c.test.ts",
      ],
    });
    await rerunFailuresOnMergeBase({
      triage: triage([
        failure("apps/backend/src/core/a.test.ts", "a"),
        failure("apps/backend/src/core/b.test.ts", "b"),
        failure("bridges/claude-bridge/src/c.test.ts", "c"),
      ]),
      changedFiles: [],
      exec,
      checkoutDir: CHECKOUT,
    });
    expect(calls.filter((call) => call.step === "install").map((call) => call.args)).toEqual([
      [CHECKOUT],
      [`${CHECKOUT}/bridges/claude-bridge`],
    ]);
    expect(calls.filter((call) => call.step === "test").map((call) => call.args)).toEqual([
      [`${CHECKOUT}/apps/backend`, "src/core/a.test.ts"],
      [`${CHECKOUT}/apps/backend`, "src/core/b.test.ts"],
      [`${CHECKOUT}/bridges/claude-bridge`, "src/c.test.ts"],
    ]);
  });

  test("skips changed tests, files new on the branch, other runners and known base failures", async () => {
    const { exec, calls } = fakeExec({ files: [...ROOT_CONFIG, "tests/changed.test.ts"] });
    const input = triage([
      failure("tests/changed.test.ts", "changed", { reasons: ["test-file-changed"] }),
      failure("tests/new.test.ts", "new"),
      failure(null, "unknown file"),
      failure("e2e/a.spec.ts", "spec", { runner: "playwright" }),
      failure("tests/ci.test.ts", "ci", {
        verdict: "unrelated",
        reasons: ["failed-on-target-ci"],
      }),
      failure("../outside.test.ts", "escape"),
    ]);
    const result = await rerunFailuresOnMergeBase({
      triage: input,
      changedFiles: ["tests/changed.test.ts"],
      exec,
      checkoutDir: CHECKOUT,
    });
    expect(result).toEqual(input);
    // Only the new file was a candidate, and it does not exist on the base.
    expect(calls.map((call) => call.step)).toEqual(["checkout", "list", "cleanup"]);
  });

  test("does nothing without a merge base or a candidate", async () => {
    const { exec, calls } = fakeExec({ files: ROOT_CONFIG });
    const noBase = triage([failure("tests/a.test.ts", "a")], null);
    expect(
      await rerunFailuresOnMergeBase({
        triage: noBase,
        changedFiles: [],
        exec,
        checkoutDir: CHECKOUT,
      }),
    ).toBe(noBase);
    const playwright = triage([failure("e2e/a.spec.ts", "a", { runner: "playwright" })]);
    expect(
      await rerunFailuresOnMergeBase({
        triage: playwright,
        changedFiles: [],
        exec,
        checkoutDir: CHECKOUT,
      }),
    ).toBe(playwright);
    expect(calls).toEqual([]);
  });

  test("a file that cannot load or times out on the base is no evidence", async () => {
    const { exec } = fakeExec({
      files: [...ROOT_CONFIG, "tests/a.test.ts", "tests/b.test.ts"],
      tests: {
        "tests/a.test.ts": fail("error: Cannot find module './gone'\n"),
        "tests/b.test.ts": { exitCode: null, output: "", timedOut: true },
      },
    });
    const input = triage([failure("tests/a.test.ts", "a"), failure("tests/b.test.ts", "b")]);
    const result = await rerunFailuresOnMergeBase({
      triage: input,
      changedFiles: [],
      exec,
      checkoutDir: CHECKOUT,
    });
    expect(result.commands).toEqual(input.commands);
    expect(result.limitations).toEqual([
      "tests/a.test.ts could not run on the merge base",
      "tests/b.test.ts did not finish on the merge base in time",
    ]);
  });

  test("a failed checkout or install becomes a limitation and still cleans up", async () => {
    for (const broken of ["checkout", "install"] as const) {
      const { exec, calls } = fakeExec({
        files: [...ROOT_CONFIG, "tests/a.test.ts"],
        ...(broken === "checkout"
          ? { checkout: fail("fatal: invalid reference", 128) }
          : { install: fail("error: lockfile had changes, but lockfile is frozen") }),
      });
      const input = triage([failure("tests/a.test.ts", "a")]);
      const result = await rerunFailuresOnMergeBase({
        triage: input,
        changedFiles: [],
        exec,
        checkoutDir: CHECKOUT,
      });
      expect(result.commands).toEqual(input.commands);
      expect(result.limitations).toHaveLength(1);
      expect(result.limitations[0]).toContain(
        broken === "checkout" ? "could not be checked out" : "could not be installed",
      );
      expect(calls.at(-1)!.step).toBe("cleanup");
      expect(calls.some((call) => call.step === "test")).toBe(false);
    }
  });

  test("a throwing exec is a limitation, never an error", async () => {
    const calls: string[] = [];
    const result = await rerunFailuresOnMergeBase({
      triage: triage([failure("tests/a.test.ts", "a")]),
      changedFiles: [],
      exec: async (script) => {
        calls.push(script);
        throw new Error("docker unavailable");
      },
      checkoutDir: CHECKOUT,
    });
    expect(result.limitations).toEqual(["The merge-base rerun could not run"]);
    // The cleanup was attempted too.
    expect(calls).toHaveLength(2);
  });

  test("bounds the files it reruns and the time it spends", async () => {
    const files = Array.from(
      { length: MAX_MERGE_BASE_RERUN_FILES + 3 },
      (_, index) => `tests/f${index}.test.ts`,
    );
    const { exec, calls } = fakeExec({ files: [...ROOT_CONFIG, ...files] });
    const result = await rerunFailuresOnMergeBase({
      triage: triage(files.map((file) => failure(file, "t"))),
      changedFiles: [],
      exec,
      checkoutDir: CHECKOUT,
    });
    expect(calls.filter((call) => call.step === "test")).toHaveLength(MAX_MERGE_BASE_RERUN_FILES);
    expect(result.limitations).toEqual([
      `3 failing test files were not rerun on the merge base (limit ${MAX_MERGE_BASE_RERUN_FILES})`,
    ]);

    let clock = 0;
    const timed = fakeExec({ files: [...ROOT_CONFIG, ...files.slice(0, 3)] });
    const slow: MergeBaseRerunExec = async (script, args, timeoutMs) => {
      clock += 40_000;
      return timed.exec(script, args, timeoutMs);
    };
    const bounded = await rerunFailuresOnMergeBase({
      triage: triage(files.slice(0, 3).map((file) => failure(file, "t"))),
      changedFiles: [],
      exec: slow,
      checkoutDir: CHECKOUT,
      budgetMs: 150_000,
      now: () => clock,
    });
    const tests = timed.calls.filter((call) => call.step === "test");
    // checkout, list and install spend 120 s; one test fits before the rest.
    expect(tests).toHaveLength(1);
    expect(tests[0]!.timeoutMs).toBeLessThanOrEqual(30_000);
    expect(bounded.limitations).toContain(
      "The merge-base rerun ran out of time before every failing test file ran",
    );
    expect(timed.calls.at(-1)!.step).toBe("cleanup");
  });

  test("reruns open failures before already-unrelated ones", async () => {
    const files = Array.from(
      { length: MAX_MERGE_BASE_RERUN_FILES },
      (_, i) => `tests/u${i}.test.ts`,
    );
    const { exec, calls } = fakeExec({ files: [...ROOT_CONFIG, ...files, "tests/open.test.ts"] });
    await rerunFailuresOnMergeBase({
      triage: triage([
        ...files.map((file) =>
          failure(file, "u", { verdict: "unrelated", reasons: ["no-changed-dependency"] }),
        ),
        failure("tests/open.test.ts", "open"),
      ]),
      changedFiles: [],
      exec,
      checkoutDir: CHECKOUT,
    });
    expect(calls.find((call) => call.step === "test")!.args[1]).toBe("tests/open.test.ts");
  });
});
