/**
 * A cancelled build or review is reported to its coordinator as someone's
 * decision to stop the work, never as a failure to recover from (to-do 7545
 * task 4: a Codex coordinator restarted a build the user had cancelled).
 */
import { describe, expect, test } from "bun:test";
import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import { coordinatorRestartRefusal } from "./build-pipeline-restart-targets.js";
import {
  BUILD_CANCELLED_NOTICE,
  buildPipelineStatus,
} from "./coordinator-build-pipeline-status.js";
import {
  MULTI_REVIEW_CANCELLED_NOTICE,
  multiReviewStatus,
  renderCoordinatorStatusNotice,
} from "./coordinator-status-wakes.js";
import { resumeRefusal } from "./control-mcp/coordinator-tools.js";
import { workflowSummary } from "./control-workflow-summary.js";

const CANCELLED_AT = "2026-11-10T01:00:00.000Z";
const RESTART_TOOLS = /restart_build_pipeline_step|resume_build_pipeline|start_build_pipeline/;

describe("a cancelled build's coordinator notice", () => {
  test("is a cancel, not a failure, and offers nothing that would restart it", () => {
    const status = buildPipelineStatus(
      {
        phase: "failed",
        cancelledAt: CANCELLED_AT,
        error: "Build cancelled",
        taskTitle: "Add clampPercent",
        // A step failure before the cancel does not make it restartable.
        failureContext: { phase: "fixing", kind: "stage-transition" },
      },
      "pipeline-1",
    )!;
    expect(status).toMatchObject({
      state: "cancelled",
      tone: "info",
      terminal: true,
      headline: "was cancelled",
      mode: "off",
    });
    expect(status.details).toEqual(["Task: Add clampPercent", BUILD_CANCELLED_NOTICE]);
    expect(status.tools).toEqual(['get_build_pipeline { "pipelineId": "pipeline-1" }']);

    const rendered = renderCoordinatorStatusNotice(
      { kind: "build-pipeline", id: "pipeline-1", label: "Add clampPercent" },
      status,
    );
    expect(rendered.subject).toBe("Build pipeline Add clampPercent was cancelled");
    expect(rendered.notice).toMatchObject({ state: "cancelled", tone: "info" });
    expect(rendered.body).toContain(BUILD_CANCELLED_NOTICE);
    expect(rendered.body).not.toMatch(RESTART_TOOLS);
    expect(rendered.body.split("\n")[0]).toBe("Build pipeline `pipeline-1` was cancelled.");
  });

  test("says whose decision it is and not to start another build unasked", () => {
    expect(BUILD_CANCELLED_NOTICE).toContain("If you did not cancel it yourself, the user did");
    expect(BUILD_CANCELLED_NOTICE).toContain(
      "do not start another build for this ticket, unless the user asks you to",
    );
  });

  test("a legacy cancel recorded only in the error reads the same", () => {
    expect(buildPipelineStatus({ phase: "failed", error: "Build cancelled" }, "p")).toMatchObject({
      state: "cancelled",
      details: [BUILD_CANCELLED_NOTICE],
    });
  });

  test("keeps the reason when stopping every agent could not be confirmed", () => {
    const error = "Build cancelled, but stopping every agent could not be confirmed: offline";
    expect(
      buildPipelineStatus({ phase: "failed", cancelledAt: CANCELLED_AT, error }, "p")?.details,
    ).toEqual([`Error: ${error}`, BUILD_CANCELLED_NOTICE]);
  });

  test("each cancel is its own notice; a real failure is still a failure", () => {
    const key = (cancelledAt: string) =>
      buildPipelineStatus({ phase: "failed", cancelledAt, error: "Build cancelled" }, "p")!.key;
    // A build the user restarted from the UI and cancelled again is news again.
    expect(key(CANCELLED_AT)).not.toBe(key("2026-11-10T02:00:00.000Z"));
    expect(key(CANCELLED_AT)).not.toBe("failed");
    const failed = buildPipelineStatus(
      {
        phase: "failed",
        error: "Claude usage limit reached",
        failureContext: { phase: "fixing", kind: "stage-transition" },
      },
      "p",
    )!;
    expect(failed).toMatchObject({ key: "failed", state: "failed", tone: "failure" });
    expect(failed.details.join(" ")).not.toContain(BUILD_CANCELLED_NOTICE);
  });
});

describe("refusals a coordinator gets on a cancelled build", () => {
  const cancelled = {
    phase: "failed",
    cancelledAt: CANCELLED_AT,
    error: "Build cancelled",
  } as unknown as BuildPipeline;

  test("restart_build_pipeline_step does not invite a new build", () => {
    const message = coordinatorRestartRefusal(cancelled, undefined)?.message ?? "";
    expect(message).toContain("was cancelled, so it cannot be restarted");
    expect(message).toContain("the user did");
    expect(message).toContain("do not start another build for this ticket unless the user asks");
    // The wording Codex followed into a second build (to-do 7545 task 4).
    expect(message).not.toContain("Start a new build if the work is still wanted");
  });

  test("resume_build_pipeline says the same", () => {
    const message = resumeRefusal({ phase: "failed", error: "Build cancelled" });
    expect(message).toContain("cancelled, not paused");
    expect(message).toContain("do not start another build for this ticket unless the user asks");
  });

  test("get_build_pipeline shows that the failed build was cancelled", () => {
    expect(
      workflowSummary({
        id: "p",
        phase: "failed",
        error: "Build cancelled",
        cancelledAt: CANCELLED_AT,
      }),
    ).toMatchObject({ phase: "failed", cancelledAt: CANCELLED_AT });
    expect(workflowSummary({ id: "p", phase: "failed", error: "boom" })).not.toHaveProperty(
      "cancelledAt",
    );
  });
});

describe("a cancelled Multi Review's coordinator notice", () => {
  test("says the same: stopped on purpose, not to be launched again unasked", () => {
    const status = multiReviewStatus({ phase: "cancelled" }, "review-1")!;
    expect(status).toMatchObject({ state: "cancelled", headline: "was cancelled", terminal: true });
    expect(status.details).toEqual([MULTI_REVIEW_CANCELLED_NOTICE]);
    expect(MULTI_REVIEW_CANCELLED_NOTICE).toContain(
      "If you did not cancel it yourself, the user did",
    );
    expect(MULTI_REVIEW_CANCELLED_NOTICE).toContain(
      "Do not launch it again unless the user asks you to",
    );
    expect(status.tools.join(" ")).not.toMatch(/launch_multi_review|start_multi_review/);
  });
});
