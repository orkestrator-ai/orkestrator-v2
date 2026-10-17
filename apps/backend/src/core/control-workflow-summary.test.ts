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
      "The Fix starts automatically if consolidation reports findings, then a PR session once the Fix completes.",
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
        autoPrLaunch: { state: "launched", requestId: "r", tabId: "pr-tab" },
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
