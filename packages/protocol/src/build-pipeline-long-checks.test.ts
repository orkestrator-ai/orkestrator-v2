import { describe, expect, test } from "bun:test";
import {
  PIPELINE_LONG_CHECK_LIMITS,
  formatLongCheckDuration,
  isPipelineLongCheck,
  isPipelineLongCheckList,
  longCheckStatusFromRun,
  longCheckTicketComment,
  retainLongChecks,
  type PipelineLongCheck,
} from "./build-pipeline-long-checks.js";
import { newReviewValidationRun, type ReviewValidationRun } from "./review-validation.js";

const HEAD = "a".repeat(40);

function run(id: string, statuses: ReviewValidationRun["results"][number]["status"][]) {
  const planned = newReviewValidationRun(id, {
    headRef: HEAD,
    commands: statuses.map((_, index) => ({
      id: `c${index + 1}`,
      command: `bun run parity --part ${index + 1}`,
      cwd: ".",
      dependsOn: [],
      resources: [],
      weight: 2,
      timeoutMs: 60_000,
      scope: index === 0 ? "changed" : "general",
    })),
    limitations: [],
  });
  return {
    ...planned,
    results: planned.results.map((result, index) => ({
      ...result,
      status: statuses[index]!,
      exitCode: statuses[index] === "passed" ? 0 : statuses[index] === "failed" ? 1 : null,
      limitation: statuses[index] === "incomplete" ? "Validation command timed out" : null,
    })),
  };
}

function check(overrides: Partial<PipelineLongCheck> = {}): PipelineLongCheck {
  const id = overrides.id ?? "long-check-1";
  return {
    id,
    name: "corpus parity",
    phase: "verify",
    iteration: 0,
    sessionKey: "pipeline:verify:0",
    status: "running",
    startedAt: "2026-11-22T10:00:00.000Z",
    run: run(id, ["pending"]),
    ...overrides,
  };
}

describe("long check status", () => {
  test("follows the run: unsettled runs, then per-command results", () => {
    expect(longCheckStatusFromRun(run("long-check-1", ["running"]))).toBe("running");
    expect(
      longCheckStatusFromRun({
        ...run("long-check-1", ["passed", "skipped"]),
        results: run("long-check-1", ["passed", "skipped"]).results.map((result) =>
          result.status === "skipped"
            ? { ...result, limitation: "Covered by c1 (identical command)" }
            : result,
        ),
        status: "completed",
      }),
    ).toBe("passed");
    const skipped = run("long-check-1", ["skipped"]);
    skipped.results[0]!.limitation = "On demand, not run: trigger absent";
    expect(longCheckStatusFromRun({ ...skipped, status: "completed" })).toBe("incomplete");
    expect(
      longCheckStatusFromRun({ ...run("long-check-1", ["passed", "failed"]), status: "completed" }),
    ).toBe("failed");
    expect(
      longCheckStatusFromRun({
        ...run("long-check-1", ["passed", "incomplete"]),
        status: "completed",
      }),
    ).toBe("incomplete");
    expect(
      longCheckStatusFromRun({
        ...run("long-check-1", ["passed", "incomplete"]),
        status: "cancelled",
      }),
    ).toBe("incomplete");
    expect(
      longCheckStatusFromRun({ ...run("long-check-1", ["incomplete"]), status: "failed" }),
    ).toBe("error");
  });
});

describe("long check records", () => {
  test("a running check has no settlement time, and a settled one has one", () => {
    expect(isPipelineLongCheck(check())).toBe(true);
    expect(isPipelineLongCheck(check({ settledAt: "2026-11-22T10:30:00.000Z" }))).toBe(false);
    expect(
      isPipelineLongCheck(check({ status: "passed", settledAt: "2026-11-22T10:30:00.000Z" })),
    ).toBe(true);
    expect(isPipelineLongCheck(check({ status: "passed" }))).toBe(false);
  });

  test("the run must be the check's own", () => {
    expect(isPipelineLongCheck(check({ run: run("long-check-2", ["pending"]) }))).toBe(false);
    expect(isPipelineLongCheck({ ...check(), id: "other" })).toBe(false);
  });

  test("lists are bounded and unique", () => {
    expect(isPipelineLongCheckList([check(), check()])).toBe(false);
    const many = Array.from({ length: PIPELINE_LONG_CHECK_LIMITS.retained + 1 }, (_, index) =>
      check({ id: `long-check-${index}`, run: run(`long-check-${index}`, ["pending"]) }),
    );
    expect(isPipelineLongCheckList(many)).toBe(false);
  });

  test("retention drops the oldest settled checks and never a running one", () => {
    const settled = (index: number) =>
      check({
        id: `long-check-${index}`,
        run: run(`long-check-${index}`, ["passed"]),
        status: "passed",
        ticketComment: "posted",
        settledAt: "2026-11-22T10:30:00.000Z",
      });
    const running = check({ id: "long-check-run", run: run("long-check-run", ["running"]) });
    const kept = retainLongChecks([
      running,
      ...Array.from({ length: PIPELINE_LONG_CHECK_LIMITS.retained }, (_, index) => settled(index)),
    ]);
    expect(kept).toHaveLength(PIPELINE_LONG_CHECK_LIMITS.retained);
    expect(kept[0]!.id).toBe("long-check-run");
    expect(kept.map((entry) => entry.id)).not.toContain("long-check-0");
  });
});

describe("long check ticket comment", () => {
  test("names the check, its stage and round, every command and where the evidence is", () => {
    const settled = check({
      status: "incomplete",
      settledAt: "2026-11-22T10:31:12.000Z",
      criterion: "ac-1",
      run: {
        ...run("long-check-1", ["passed", "incomplete"]),
        status: "completed",
      },
    });
    settled.run.results[0]!.command = "test --token sentinel-secret";
    settled.run.results[0]!.executedCommand = "test --endpoint private-sentinel";
    settled.run.results[1]!.limitation = "credential sentinel-secret";
    settled.error = "failed with private-sentinel";
    const comment = longCheckTicketComment(settled);
    expect(comment).toContain(
      "**Long check “corpus parity”** (Verify, round 1) incomplete after 31m 12s.",
    );
    expect(comment).toContain("Criterion: ac-1");
    expect(comment).toContain("Command 1 (changed): passed");
    expect(comment).toContain("Command 2 (general): incomplete");
    expect(comment).not.toContain("sentinel");
    expect(comment).toContain("`.orkestrator/review-artifacts/long-check-1/`");
  });

  test("durations read naturally", () => {
    expect(formatLongCheckDuration(45_000)).toBe("45s");
    expect(formatLongCheckDuration(31 * 60_000 + 12_000)).toBe("31m 12s");
    expect(formatLongCheckDuration(62 * 60_000)).toBe("1h 02m");
  });
});
