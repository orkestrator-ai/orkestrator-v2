import { describe, expect, test } from "bun:test";
import { reportFor } from "./build-pipeline-review-fanout-test-support.js";
import { validateWorkflowResult } from "./workflow-result-contracts.js";

/** A clean report with neither `reviewScope.outcome` nor `blockedReason`. */
function legacyReport() {
  const report = reportFor("Nothing to address.");
  expect(report.reviewScope).not.toHaveProperty("outcome");
  expect(report.reviewScope).not.toHaveProperty("blockedReason");
  return report;
}

function withScope(extra: Record<string, unknown>) {
  const report = legacyReport();
  return { ...report, reviewScope: { ...report.reviewScope, ...extra } };
}

const paths = (issues: ReturnType<typeof validateWorkflowResult>) =>
  issues.map((issue) => issue.path);

describe("review report structural backfill", () => {
  for (const kind of ["review-report", "consolidated-review"] as const) {
    describe(kind, () => {
      test("a submitted report with neither outcome field reads as reviewed", () => {
        expect(validateWorkflowResult(kind, legacyReport())).toEqual([]);
      });

      test("the wire form of both outcomes passes", () => {
        expect(
          validateWorkflowResult(kind, withScope({ outcome: "reviewed", blockedReason: null })),
        ).toEqual([]);
        expect(
          validateWorkflowResult(
            kind,
            withScope({ outcome: "blocked", blockedReason: "No command could run." }),
          ),
        ).toEqual([]);
      });

      test("a report with only one of the pair is not backfilled", () => {
        expect(validateWorkflowResult(kind, withScope({ outcome: "reviewed" }))).not.toEqual([]);
        expect(
          validateWorkflowResult(kind, withScope({ blockedReason: "No command could run." })),
        ).not.toEqual([]);
      });

      test("an inconsistent pair still fails the domain check", () => {
        const blockedWithoutReason = validateWorkflowResult(
          kind,
          withScope({ outcome: "blocked", blockedReason: null }),
        );
        expect(blockedWithoutReason).not.toEqual([]);
        expect(paths(blockedWithoutReason).some((path) => path.includes("blockedReason"))).toBe(
          true,
        );
      });
    });
  }
});
