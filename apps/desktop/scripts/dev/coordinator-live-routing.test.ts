import { describe, expect, test } from "bun:test";
import { MULTI_REVIEW_MIN_REVIEWERS } from "@orkestrator/protocol/multi-review";
import type { CoordinatorTranscriptMessage } from "./coordinator-live.js";
import {
  evaluateRoutingBuild,
  evaluateRoutingDeliveryOutcome,
  evaluateRoutingInvestigate,
  evaluateRoutingReview,
  routingAgentSettings,
  routingBuildPrompt,
  routingDeliveryPrompt,
  routingInvestigatePrompt,
  routingReviewPrompt,
  routingToolCalls,
  toolArgsRecord,
  workflowCallCounts,
} from "./coordinator-live-routing.js";

const row = (toolName: string, toolArgs: unknown): CoordinatorTranscriptMessage => ({
  role: "assistant",
  parts: [{ toolName, toolArgs, toolState: "success" }],
});
const failedNames = (checks: Array<{ name: string; passed: boolean }>) =>
  checks.filter((item) => !item.passed).map((item) => item.name);

describe("prompts", () => {
  const probe = { platform: "codex" as const, token: "abc123" };
  const target = {
    environmentId: "env-1",
    name: "routing-review-abc123",
    branch: "routing-review-abc123",
  };

  test("no request names a workflow or a tool", () => {
    for (const prompt of [
      routingBuildPrompt(probe),
      routingInvestigatePrompt(),
      routingReviewPrompt(target),
      routingDeliveryPrompt(probe),
    ]) {
      expect(prompt).not.toMatch(
        /pipeline|ticket|multi review|launch_|create_|start_|environment type|autoFix|autoPr|pull request/i,
      );
    }
  });

  test("the review request names the branch and environment it means", () => {
    expect(routingReviewPrompt(target)).toContain("routing-review-abc123");
  });

  test("the two building requests ask for different files", () => {
    expect(routingBuildPrompt(probe)).toContain("routing-abc123-clamp.ts");
    expect(routingDeliveryPrompt(probe)).toContain("routing-abc123-range.ts");
  });
});

test("saved defaults put every row on the platform and switch the review auto-actions off", () => {
  expect(
    routingAgentSettings(
      { defaultAgent: "claude", multiReview: { autoPr: true, reviewerCount: 4 }, other: 1 },
      "pi",
    ),
  ).toEqual({
    defaultAgent: "pi",
    other: 1,
    multiReview: { autoPr: false, autoFix: false, reviewerCount: MULTI_REVIEW_MIN_REVIEWERS },
  });
});

describe("reading calls", () => {
  test("prefixes are dropped and envelopes unwrapped", () => {
    const calls = routingToolCalls([
      row("mcp__orkestrator__start_build_pipeline", { arguments: { taskId: "t1" } }),
      row("orkestrator_create_ticket", JSON.stringify({ title: "x" })),
      row("orkestrator__launch_multi_review", { input: '{"environmentId":"e1"}' }),
    ]);
    expect(calls.map(({ tool, row: index, args }) => ({ tool, index, args }))).toEqual([
      { tool: "start_build_pipeline", index: 0, args: { taskId: "t1" } },
      { tool: "create_ticket", index: 1, args: { title: "x" } },
      { tool: "launch_multi_review", index: 2, args: { environmentId: "e1" } },
    ]);
  });

  test("an envelope beside other fields is the arguments themselves", () => {
    expect(toolArgsRecord({ input: { a: 1 }, requestId: "r" })).toEqual({
      input: { a: 1 },
      requestId: "r",
    });
    expect(toolArgsRecord("not json")).toBeUndefined();
  });

  test("grouped and sub-agent calls count, at their parent's row", () => {
    const calls = routingToolCalls([
      { role: "user", content: "request" },
      {
        role: "assistant",
        parts: [
          {
            toolName: "Task",
            childTools: [{ toolName: "mcp__orkestrator__launch_environment", toolArgs: {} }],
          },
        ],
      },
    ]);
    expect(workflowCallCounts(calls)).toEqual({ launch_environment: 1 });
    expect(calls.find((call) => call.tool === "launch_environment")?.row).toBe(1);
  });
});

describe("build cases", () => {
  const ticket = { id: "t1", sections: { acceptanceCriteria: [{ id: "ac-1", text: "passes" }] } };
  const pipeline = { id: "p1", taskId: "t1", phase: "building" };
  const messages = [
    row("create_ticket", { title: "x" }),
    row("start_build_pipeline", { taskId: "t1", baseBranch: "main" }),
  ];

  test("a ticket with criteria, then a build for it on the defaults, passes", () => {
    const checks = evaluateRoutingBuild({
      prefix: "build",
      messages,
      newTickets: [ticket],
      newPipelineIds: ["p1"],
      pipeline,
    });
    expect(failedNames(checks)).toEqual([]);
  });

  test("a ticket without criteria fails, and plain-text criteria count", () => {
    const base = { prefix: "build" as const, messages, newPipelineIds: ["p1"], pipeline };
    expect(failedNames(evaluateRoutingBuild({ ...base, newTickets: [{ id: "t1" }] }))).toEqual([
      "build-ticket-created",
    ]);
    expect(
      failedNames(
        evaluateRoutingBuild({ ...base, newTickets: [{ id: "t1", acceptanceCriteria: "- ok" }] }),
      ),
    ).toEqual([]);
  });

  test("a build on some other ticket fails", () => {
    const checks = evaluateRoutingBuild({
      prefix: "delivery",
      messages,
      newTickets: [ticket],
      newPipelineIds: ["p1"],
      pipeline: { ...pipeline, taskId: "older" },
    });
    expect(failedNames(checks)).toEqual(["delivery-pipeline-started"]);
  });

  test("a build started before its ticket was created fails the order check", () => {
    const checks = evaluateRoutingBuild({
      prefix: "build",
      messages: [messages[1]!, messages[0]!],
      newTickets: [ticket],
      newPipelineIds: ["p1"],
      pipeline,
    });
    expect(failedNames(checks)).toEqual(["build-ticket-before-build"]);
  });

  test("each override is named, and a worker beside the build fails", () => {
    const checks = evaluateRoutingBuild({
      prefix: "build",
      messages: [
        messages[0]!,
        row("start_build_pipeline", { taskId: "t1", steps: {}, reviewers: [] }),
        row("launch_environment", {}),
      ],
      newTickets: [ticket],
      newPipelineIds: ["p1"],
      pipeline,
    });
    expect(failedNames(checks)).toEqual(["build-defaults-kept", "build-no-other-workflow"]);
    expect(checks.find((item) => item.name === "build-defaults-kept")?.detail).toBe(
      "overrode steps, reviewers",
    );
  });

  test("a commit-only build passes only when complete with no PR session", () => {
    const done = {
      id: "p1",
      taskId: "t1",
      phase: "complete",
      delivery: { policy: "commit-only" },
      sessions: [{ phase: "build" }, { phase: "review" }, { phase: "verify" }],
    };
    expect(failedNames(evaluateRoutingDeliveryOutcome({ pipeline: done, messages: [] }))).toEqual(
      [],
    );
    expect(
      failedNames(
        evaluateRoutingDeliveryOutcome({
          pipeline: { ...done, delivery: { policy: "open-pr" }, sessions: [{ phase: "pr" }] },
          messages: [],
        }),
      ),
    ).toEqual(["delivery-commit-only-complete", "delivery-no-pr-stage"]);
    expect(
      failedNames(
        evaluateRoutingDeliveryOutcome({
          pipeline: { ...done, cancelledAt: "2026-11-08" },
          messages: [],
        }),
      ),
    ).toEqual(["delivery-commit-only-complete"]);
    expect(failedNames(evaluateRoutingDeliveryOutcome({ messages: [] }))).toEqual([
      "delivery-commit-only-complete",
      "delivery-no-pr-stage",
    ]);
    // Woken by the finished build, the coordinator must not raise a PR itself.
    expect(
      failedNames(
        evaluateRoutingDeliveryOutcome({
          pipeline: done,
          messages: [row("mcp__orkestrator__create_pr", { environmentId: "e1" })],
        }),
      ),
    ).toEqual(["delivery-no-coordinator-pr"]);
  });
});

describe("investigation case", () => {
  const counts = { newTickets: 0, newPipelines: 0, newReviews: 0 };

  test("one worker by any worker tool passes", () => {
    for (const tool of ["launch_environment", "launch_job", "send_prompt_to_tab"]) {
      expect(
        failedNames(
          evaluateRoutingInvestigate({ messages: [row(tool, {})], newWorkers: 1, ...counts }),
        ),
      ).toEqual([]);
    }
  });

  test("answering without a worker fails, and so does a ticket", () => {
    expect(
      failedNames(evaluateRoutingInvestigate({ messages: [], newWorkers: 0, ...counts })),
    ).toEqual(["investigate-delegated"]);
    expect(
      failedNames(
        evaluateRoutingInvestigate({
          messages: [row("launch_environment", {}), row("create_ticket", {})],
          newWorkers: 1,
          ...counts,
          newTickets: 1,
        }),
      ),
    ).toEqual(["investigate-no-build-or-review"]);
  });
});

describe("review case", () => {
  const target = { environmentId: "env-1", name: "routing-review-x", branch: "routing-review-x" };
  const base = { target, newReviewIds: ["r1"], newTickets: 0, newPipelines: 0 };

  test("one launch on the named environment with auto-actions left out passes", () => {
    const checks = evaluateRoutingReview({
      ...base,
      messages: [row("launch_multi_review", { environmentId: "env-1" })],
      review: { id: "r1", environmentId: "env-1", autoFix: false, autoPr: false },
    });
    expect(failedNames(checks)).toEqual([]);
  });

  test("explicit false passes; a workflow that turned them on fails even when the call left them out", () => {
    expect(
      failedNames(
        evaluateRoutingReview({
          ...base,
          messages: [
            row("launch_multi_review", { environmentId: "env-1", autoFix: false, autoPr: false }),
          ],
          review: { id: "r1", environmentId: "env-1" },
        }),
      ),
    ).toEqual([]);
    expect(
      failedNames(
        evaluateRoutingReview({
          ...base,
          messages: [row("launch_multi_review", { environmentId: "env-1" })],
          review: { id: "r1", environmentId: "env-1", autoPr: true },
        }),
      ),
    ).toEqual(["review-auto-actions-off"]);
  });

  test("a review of another environment, or a build instead, fails", () => {
    expect(
      failedNames(
        evaluateRoutingReview({
          ...base,
          messages: [row("launch_multi_review", { environmentId: "env-2" })],
          review: { id: "r1", environmentId: "env-2" },
        }),
      ),
    ).toEqual(["review-launched"]);
    expect(
      failedNames(
        evaluateRoutingReview({
          ...base,
          newReviewIds: [],
          newPipelines: 1,
          newTickets: 1,
          messages: [row("create_ticket", {}), row("start_build_pipeline", {})],
        }),
      ),
    ).toEqual(["review-launched", "review-auto-actions-off", "review-no-other-workflow"]);
  });
});
