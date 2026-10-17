import { multiReviewFixIdentity } from "./multi-review-fix-identity.js";
import { describe, expect, test } from "bun:test";
import { workflowSummary } from "./control-workflow-summary.js";

const findings = { issues: [{ severity: "P1" }], testCoverageGaps: [] };
const auto = { autoFix: true, autoPr: true };

describe("Multi Review automation summary", () => {
  test("build pipelines carry no automation block", () => {
    expect(workflowSummary({ id: "pipeline", phase: "building" })).not.toHaveProperty("automation");
  });

  test("reports what runs next at each stage", () => {
    const next = (workflow: Record<string, unknown>) =>
      (workflowSummary(workflow).automation as { next: string }).next;
    const fix = (status: string) => ({ sessionKey: "fix", status });
    expect(next({ ...auto, phase: "reviewing" })).toBe(
      "The Fix starts automatically if consolidation reports findings, then a PR session once the Fix completes; a clean report starts the PR session directly.",
    );
    expect(next({ autoFix: false, phase: "reviewing" })).toBe(
      "Stops at ready; address_multi_review starts the Fix.",
    );
    expect(next({ ...auto, phase: "ready", consolidatedReport: { issues: [] } })).toBe(
      "Consolidation found nothing to fix, so no Fix or PR session starts.",
    );
    expect(
      next({ autoFix: false, autoPr: true, phase: "ready", consolidatedReport: findings }),
    ).toBe(
      "Waiting for address_multi_review to start the Fix; a PR session starts once that Fix completes.",
    );
    const cleanLaunch = (state: string) => ({
      ...auto,
      phase: "ready",
      consolidatedReport: { issues: [], testCoverageGaps: [] },
      autoPrLaunch: { basis: "clean-review", state, requestId: "pr", tabId: "agent-job-pr" },
    });
    expect(next(cleanLaunch("pending"))).toBe(
      "Consolidation found nothing to fix; the PR session is starting.",
    );
    expect(next(cleanLaunch("launched"))).toContain("The PR session started in tab agent-job-pr");
    // A Fix started after the clean report's PR is not covered by that PR.
    expect(
      next({ ...cleanLaunch("launched"), phase: "interactive", fixSession: fix("running") }),
    ).toBe(
      "The Fix is running; the earlier PR does not confirm inclusion of this Fix's changes, so review and update it manually.",
    );
    expect(next({ autoFix: false, autoPr: true, phase: "reviewing" })).toBe(
      "Stops at ready if consolidation reports findings; address_multi_review starts the Fix; a PR session starts once that Fix completes. A clean report starts the PR session directly.",
    );
    expect(next({ ...auto, phase: "interactive", addressPromptPending: true })).toBe(
      "The Fix handoff is being delivered; a PR session starts once that Fix completes.",
    );
    expect(next({ ...auto, phase: "interactive", fixSession: fix("running") })).toBe(
      "The Fix is running; a PR session starts once that Fix completes.",
    );
    expect(next({ ...auto, phase: "interactive", fixSession: fix("failed") })).toBe(
      "The Fix failed; no PR session starts.",
    );
    expect(
      next({
        ...auto,
        phase: "interactive",
        fixSession: fix("idle"),
        autoPrLaunch: { state: "pending", requestId: "r" },
      }),
    ).toBe("The Fix completed; the PR session is starting.");
    expect(
      next({
        ...auto,
        phase: "interactive",
        fixSession: fix("idle"),
        autoPrLaunch: {
          state: "launched",
          requestId: "r",
          tabId: "pr-tab",
          fixIdentity: multiReviewFixIdentity(fix("idle")),
        },
      }),
    ).toContain("The PR session started in tab pr-tab");
    // A later Fix may still queue the PR an earlier one skipped.
    expect(
      next({
        ...auto,
        phase: "interactive",
        fixSession: fix("running"),
        autoPrLaunch: { state: "skipped", requestId: "r", message: "stopped" },
      }),
    ).toBe("The Fix is running; a PR session starts once that Fix completes.");
    expect(
      next({
        ...auto,
        phase: "interactive",
        fixSession: fix("idle"),
        autoPrLaunch: { state: "failed", requestId: "r", message: "tab limit" },
      }),
    ).toBe("No PR session could start: tab limit");
  });

  test.each(["issues", "testCoverageGaps"])(
    "a retained clean-review launch does not hide current %s",
    (kind) => {
      const automation = workflowSummary({
        autoFix: false,
        autoPr: true,
        phase: "ready",
        consolidatedReport: { issues: [], testCoverageGaps: [], [kind]: [{}] },
        autoPrLaunch: {
          basis: "clean-review",
          state: "launched",
          requestId: "pr",
          tabId: "old-pr",
        },
      }).automation as { next: string };
      expect(automation.next).toContain("Waiting for address_multi_review");
      expect(automation.next).toContain("earlier PR does not confirm inclusion");
      expect(automation.next).not.toContain("The PR session started");
    },
  );

  test.each([true, false])(
    "a retained PR does not hide a new Fix (pending handoff: %s)",
    (pending) => {
      const automation = workflowSummary({
        ...auto,
        phase: "interactive",
        addressPromptPending: pending,
        fixSession: { sessionKey: "new-fix", status: "running" },
        autoPrLaunch: {
          state: "launched",
          requestId: "pr",
          fixIdentity: multiReviewFixIdentity({ sessionKey: "old-fix" }),
        },
      }).automation as { next: string };
      expect(automation.next).toContain(
        pending ? "The Fix handoff is being delivered" : "The Fix is running",
      );
      expect(automation.next).toContain("earlier PR does not confirm inclusion");
      expect(automation.next).not.toContain("a PR session starts");
    },
  );

  test.each(["pending", "running", "idle"])(
    "a custom Fix requires manual PR review when %s",
    (status) => {
      const automation = workflowSummary({
        ...auto,
        phase: "interactive",
        addressPromptPending: status === "pending",
        fixLaunch: { kind: "custom" },
        fixSession: { sessionKey: "custom-fix", status },
      }).automation as { next: string };
      expect(automation.next).toContain("review its result and start or update the PR manually");
      expect(automation.next).not.toContain("a PR session starts");
      expect(automation.next).toContain(
        status === "pending"
          ? "handoff is being delivered"
          : status === "running"
            ? "Fix is running"
            : "turn ended",
      );
    },
  );

  test.each([true, false])(
    "an idle Fix without a launch makes no PR promise (autoPr: %s)",
    (autoPr) => {
      const automation = workflowSummary({
        ...auto,
        autoPr,
        phase: "interactive",
        fixSession: { sessionKey: "fix", status: "idle" },
      }).automation as { next: string };
      expect(automation.next).toBe(
        autoPr
          ? "The Fix turn ended without proof it completed, so no PR session starts."
          : "The Fix turn ended. Nothing else runs automatically.",
      );
    },
  );

  test.each(["completed", "failed", "cancelled", "cancelling"])(
    "reports the %s next step",
    (phase) => {
      const automation = workflowSummary({ ...auto, phase }).automation as { next: string };
      expect(automation.next).toBe(
        phase === "cancelling"
          ? "Cancelling; nothing else runs automatically."
          : "Nothing else runs automatically.",
      );
    },
  );

  test("an idle later Fix is not described as an earlier PR launch", () => {
    const automation = workflowSummary({
      ...auto,
      phase: "interactive",
      fixSession: { sessionKey: "new", status: "idle" },
      autoPrLaunch: { state: "launched", requestId: "pr" },
    }).automation as { next: string };
    expect(automation.next).toContain("The Fix turn ended");
    expect(automation.next).toContain("update the PR manually");
  });

  test("reports the PR launch state with a bounded message", () => {
    const summary = workflowSummary({
      ...auto,
      phase: "interactive",
      autoPrLaunch: { state: "failed", requestId: "r", attempts: 3, message: "m".repeat(5_000) },
    });
    const automation = summary.automation as {
      prLaunch: { state: string; attempts: number; message: string };
      next: string;
    };
    expect(automation.prLaunch).toMatchObject({ state: "failed", attempts: 3 });
    expect(automation.prLaunch.message.length).toBe(400);
    expect(automation.next.length).toBeLessThan(450);
    expect(automation.prLaunch).not.toHaveProperty("requestId");
  });
});
