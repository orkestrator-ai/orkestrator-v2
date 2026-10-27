import { describe, expect, test } from "bun:test";
import {
  REVIEW_PACKAGE_SESSION_LABEL,
  pipelineIndependentReviewLabel,
} from "@orkestrator/protocol/build-pipeline";
import type { ReviewerRecord } from "@orkestrator/protocol/review-fanout";
import {
  pipelineFlowModel,
  pipelineReviewPassNodes,
  type PipelineFlowModel,
} from "./pipeline-flow";
import { pipelineFlowLayout } from "./pipeline-flow-layout";
import { build, session, validationRun } from "./pipeline-test-fixture";
import { TEST_STRUCTURED_REVIEW_REPORT } from "./structured-review-test-fixture";

const PANEL = [
  { agent: "claude" as const, model: "opus" },
  { agent: "codex" as const, model: "gpt-6.1" },
  { agent: "pi" as const, model: "kimi" },
];

/** `title:state`, with a trailing `~` for a faded placeholder, column by column. */
function line(model: PipelineFlowModel): string[][] {
  const byId = new Map(model.nodes.map((node) => [node.id, node]));
  return model.columns.map((column) =>
    column.nodeIds.map((id) => {
      const node = byId.get(id)!;
      return `${node.title}:${node.state}${node.placeholder ? "~" : ""}`;
    }),
  );
}

function reviewer(slot: number, key: string, start: number, overrides = {}) {
  return session("review", key, start, {
    label: pipelineIndependentReviewLabel(slot),
    ...overrides,
  });
}

describe("pipelineFlowModel", () => {
  test.each([false, true])("full panel restart preserves history (legacy=%s)", (legacy) => {
    const pass = (id: string) => (legacy ? {} : { reviewPassId: id });
    const model = pipelineFlowModel(
      build({
        phase: "reviewing",
        reviewers: PANEL.slice(0, 2),
        sessions: [
          session("build", "build", 0),
          reviewer(0, "pipeline-1:review:0:old-1", 60, pass("old")),
          reviewer(1, "pipeline-1:review:0:old-2", 60, pass("old")),
          session("review", "old-consolidation", 120, { label: "Consolidation", ...pass("old") }),
          reviewer(0, "pipeline-1:review:0:new-1", 180, {
            ...pass("new"),
            status: "running",
            completedAt: undefined,
          }),
          reviewer(1, "pipeline-1:review:0:new-2", 180, {
            ...pass("new"),
            status: "running",
            completedAt: undefined,
          }),
        ],
      }),
    );
    const reviews = model.columns.filter((c) => c.kind === "review");
    expect(reviews).toHaveLength(2);
    const old = pipelineReviewPassNodes(model, reviews[0]!.key);
    const fresh = pipelineReviewPassNodes(model, reviews[1]!.key);
    expect(old.map((n) => n.id)).toContain("old-consolidation");
    expect(old.filter((n) => n.kind === "reviewer")).toHaveLength(2);
    expect(fresh.some((n) => n.id === "old-consolidation")).toBe(false);
    expect(fresh.filter((n) => n.kind === "reviewer")).toHaveLength(2);
  });

  test("a full panel relaunched before its first session does not replace the previous panel", () => {
    const model = pipelineFlowModel(
      build({
        phase: "reviewing",
        reviewers: PANEL.slice(0, 2),
        sessions: [
          reviewer(0, "old-1", 60, { reviewPassId: "old", reviewerOutcome: "cancelled" }),
          reviewer(1, "old-2", 60, { reviewPassId: "old", reviewerOutcome: "failed" }),
        ],
        reviewFanout: {
          reviewers: [
            { id: "new", agent: "claude", model: "opus", status: "pending" },
            { id: "new-2", agent: "codex", model: "gpt", status: "pending" },
          ],
        },
      }),
    );
    expect(model.columns.filter((c) => c.kind === "review")).toHaveLength(2);
    expect(model.nodes.some((n) => n.id === "old-1")).toBe(true);
    expect(model.nodes.some((n) => n.id === "old-2")).toBe(true);
  });

  test("a single reviewer retry stays in its durable panel", () => {
    const model = pipelineFlowModel(
      build({
        phase: "reviewing",
        reviewers: PANEL.slice(0, 2),
        sessions: [
          reviewer(0, "old", 60, { reviewPassId: "panel", reviewerOutcome: "failed" }),
          reviewer(1, "peer", 60, { reviewPassId: "panel", reviewerOutcome: "completed" }),
          reviewer(0, "old:attempt-2", 180, {
            reviewPassId: "panel",
            status: "running",
            completedAt: undefined,
          }),
        ],
      }),
    );
    expect(model.columns.filter((c) => c.kind === "review")).toHaveLength(1);
    expect(model.nodes.find((n) => n.id === "old:attempt-2")?.earlierAttempts).toBe(1);
  });

  test("discarded consolidation stays cancelled and loses its accepted report", () => {
    const model = pipelineFlowModel(
      build({
        phase: "reviewing",
        reviewers: PANEL.slice(0, 2),
        sessions: [
          reviewer(0, "rev-1", 60, { reviewPassId: "panel", reviewerOutcome: "completed" }),
          reviewer(1, "rev-2", 60, { reviewPassId: "panel", reviewerOutcome: "failed" }),
          session("review", "discarded", 120, {
            label: "Consolidation",
            reviewPassId: "panel",
            superseded: true,
          }),
        ],
        reviewFanout: {
          reviewers: [
            {
              id: "panel",
              agent: "claude",
              model: "opus",
              status: "completed",
              sessionKey: "rev-1",
            },
            { id: "r2", agent: "codex", model: "gpt", status: "pending" },
          ],
        },
      }),
    );
    expect(model.nodes.find((n) => n.id === "discarded")).toMatchObject({
      state: "cancelled",
      issueCounts: undefined,
    });
  });

  test("Address handoff ignores leftover live fanout and preserves its completed pass", () => {
    const model = pipelineFlowModel(
      build({
        phase: "addressing",
        reviewers: PANEL.slice(0, 2),
        currentSessionIndex: 3,
        sessions: [
          reviewer(0, "rev-1", 60),
          reviewer(1, "rev-2", 60),
          session("review", "consolidation", 120, { label: "Consolidation" }),
          session("address", "address", 180, { status: "running", completedAt: undefined }),
        ],
        reviewFanout: {
          reviewers: [
            { id: "r1", agent: "claude", model: "opus", status: "completed", sessionKey: "rev-1" },
            { id: "r2", agent: "codex", model: "gpt", status: "completed", sessionKey: "rev-2" },
          ],
          consolidation: {
            sessionKey: "consolidation",
            providerSessionId: "sdk",
            requestId: "request",
            state: "prepared",
            agent: "claude",
            createdAt: "2026-07-29T00:00:00.000Z",
          },
        },
      }),
    );
    expect(model.columns.filter((c) => c.kind === "review")).toHaveLength(1);
    expect(model.nodes.find((n) => n.id === "consolidation")?.state).toBe("complete");
  });

  test("historical failures keep only their own error", () => {
    const model = pipelineFlowModel(
      build({
        phase: "failed",
        error: "Verify failed",
        currentSessionIndex: 3,
        failureContext: {
          phase: "verifying",
          kind: "stage-transition",
          sessionId: "verify-session",
        },
        sessions: [
          session("build", "first-build", 0, { status: "error", error: "Build failed" }),
          session("review", "old-consolidation", 60, { label: "Consolidation", status: "error" }),
          session("build", "build-retry", 120),
          session("verify", "verify", 180, { status: "error" }),
        ],
      }),
    );
    expect(model.nodes.find((n) => n.id === "first-build")?.error).toBe("Build failed");
    expect(model.nodes.find((n) => n.id === "old-consolidation")?.error).toBeUndefined();
    expect(model.nodes.find((n) => n.id === "verify")?.error).toBe("Verify failed");
  });

  test("live consolidation falls back to the configured model and effort on old sessions", () => {
    const model = pipelineFlowModel(
      build({
        phase: "reviewing",
        reviewers: PANEL.slice(0, 2),
        sessions: [
          reviewer(0, "rev-1", 60),
          reviewer(1, "rev-2", 60),
          session("review", "consolidation", 120, { label: "Consolidation" }),
        ],
        reviewFanout: {
          reviewers: [
            { id: "r1", agent: "claude", model: "opus", status: "completed", sessionKey: "rev-1" },
            { id: "r2", agent: "codex", model: "gpt", status: "completed", sessionKey: "rev-2" },
          ],
          consolidation: {
            sessionKey: "consolidation",
            providerSessionId: "sdk",
            requestId: "request",
            state: "prepared",
            agent: "claude",
            model: "opus",
            reasoningEffort: "high",
            createdAt: "2026-07-29T00:00:00.000Z",
          },
        },
      }),
    );
    expect(model.nodes.find((n) => n.id === "consolidation")).toMatchObject({
      model: "opus",
      reasoningEffort: "high",
    });
  });

  test("failed preparation carries the failure without a synthetic Fix or another Prepare", () => {
    const model = pipelineFlowModel(
      build({
        phase: "failed",
        reviewers: PANEL,
        error: "Preparation failed",
        currentSessionIndex: 1,
        failureContext: { phase: "fixing", kind: "stage-transition", sessionId: "prep-session" },
        sessions: [
          session("build", "build", 0),
          session("fix", "prep", 60, { label: REVIEW_PACKAGE_SESSION_LABEL, status: "error" }),
        ],
      }),
    );
    expect(model.nodes.filter((n) => n.kind === "prepare")).toHaveLength(1);
    expect(model.nodes.some((n) => n.kind === "fix")).toBe(false);
    expect(model.nodes.find((n) => n.id === "prep")).toMatchObject({
      state: "failed",
      error: "Preparation failed",
    });
  });

  test("review startup failure has no empty columns and remains connected", () => {
    const model = pipelineFlowModel(
      build({
        phase: "failed",
        reviewers: PANEL,
        error: "Settings unavailable",
        failureContext: { phase: "reviewing", kind: "stage-transition" },
        sessions: [session("build", "build", 0)],
      }),
    );
    expect(model.columns.every((column) => column.nodeIds.length > 0)).toBe(true);
    for (let index = 1; index < model.columns.length; index++) {
      expect(
        model.edges.some(
          (edge) =>
            model.columns[index - 1]!.nodeIds.includes(edge.from) &&
            model.columns[index]!.nodeIds.includes(edge.to),
        ),
      ).toBe(true);
    }
    expect(model.nodes.find((n) => n.id.endsWith(":startup"))).toMatchObject({
      kind: "review",
      state: "failed",
      error: "Settings unavailable",
    });
  });

  test("a new pipeline shows Ticket and Setup, then every definite step faded", () => {
    const model = pipelineFlowModel(build({ phase: "waiting-for-setup", sessions: [] }));
    expect(line(model)).toEqual([
      ["Ticket:complete"],
      ["Setup:running"],
      ["Build:not-started~"],
      ["Review:not-started~"],
      ["Verify:not-started~"],
      ["Ship:not-started~"],
      ["PR:not-started~"],
    ]);
    // Address, Fix and conflict resolution only appear once they start.
    expect(model.nodes.some((node) => ["address", "fix", "conflicts"].includes(node.kind))).toBe(
      false,
    );
  });

  test("a fan-out pipeline shows its preparation, every reviewer and consolidation ahead", () => {
    const model = pipelineFlowModel(
      build({
        phase: "building",
        reviewers: PANEL,
        sessions: [session("build", "build", 0, { status: "running", completedAt: undefined })],
      }),
    );
    expect(line(model)).toEqual([
      ["Ticket:complete"],
      ["Setup:complete"],
      ["Build:running"],
      ["Prepare:not-started~"],
      ["Reviewer 1:not-started~", "Reviewer 2:not-started~", "Reviewer 3:not-started~"],
      ["Consolidation:not-started~"],
      ["Verify:not-started~"],
      ["Ship:not-started~"],
      ["PR:not-started~"],
    ]);
    const placeholderReviewer = model.nodes.find((node) => node.title === "Reviewer 2");
    expect(placeholderReviewer).toMatchObject({ agent: "codex", model: "gpt-6.1" });
  });

  test("repeated passes run to the right as new nodes, never looping back", () => {
    const model = pipelineFlowModel(
      build({
        phase: "verifying",
        iteration: 1,
        currentSessionIndex: 6,
        sessions: [
          session("build", "build", 0),
          session("review", "review", 60, { label: "Review Session" }),
          session("address", "address", 120),
          session("verify", "verify", 180),
          session("fix", "fix", 240, { iteration: 1 }),
          session("review", "review-2", 300, { iteration: 1, label: "Review Session" }),
          session("verify", "verify-2", 360, {
            iteration: 1,
            status: "running",
            completedAt: undefined,
          }),
        ],
      }),
    );
    expect(line(model)).toEqual([
      ["Ticket:complete"],
      ["Setup:complete"],
      ["Build:complete"],
      ["Review:complete"],
      ["Address:complete"],
      ["Verify:complete"],
      ["Fix:complete"],
      ["Review 2:complete"],
      ["Verify 2:running"],
      ["Ship:not-started~"],
      ["PR:not-started~"],
    ]);
    expect(model.columns.map((column) => column.label)).toEqual([
      "Ticket",
      "Setup",
      "Build",
      "Review",
      "Address",
      "Verify",
      "Fix",
      "Review 2",
      "Verify 2",
      "Ship",
      "PR",
    ]);
    // Every edge runs from one column to the next one.
    const columnOf = new Map<string, number>();
    model.columns.forEach((column, index) =>
      column.nodeIds.forEach((id) => columnOf.set(id, index)),
    );
    for (const edge of model.edges) {
      expect(columnOf.get(edge.to)! - columnOf.get(edge.from)!).toBe(1);
    }
  });

  test("projects the live fan-out: queue position, admission and failures", () => {
    const reviewers: ReviewerRecord[] = [
      {
        id: "r1",
        agent: "claude",
        model: "opus",
        status: "running",
        sessionKey: "rev-1",
        providerSessionId: "rev-1-session",
      },
      {
        id: "r2",
        agent: "codex",
        model: "gpt",
        status: "failed",
        error: "Provider exited\nwith a trace",
        sessionKey: "rev-2",
        providerSessionId: "rev-2-session",
      },
      {
        id: "r3",
        agent: "pi",
        model: "kimi",
        status: "pending",
        admissionState: "queued",
        queuePosition: 1,
      },
    ];
    const model = pipelineFlowModel(
      build({
        phase: "reviewing",
        reviewers: PANEL,
        reviewFanout: { reviewers },
        sessions: [
          session("build", "build", 0),
          session("fix", "prep", 60, { label: REVIEW_PACKAGE_SESSION_LABEL }),
          reviewer(0, "rev-1", 120, { status: "running", completedAt: undefined }),
          reviewer(1, "rev-2", 120),
        ],
        validationRun: validationRun(),
      }),
    );
    expect(line(model).slice(3)).toEqual([
      ["Prepare:complete"],
      ["Reviewer 1:running", "Reviewer 2:failed", "Reviewer 3:not-started"],
      ["Consolidation:not-started~"],
      ["Verify:not-started~"],
      ["Ship:not-started~"],
      ["PR:not-started~"],
    ]);
    const prepare = model.nodes.find((node) => node.kind === "prepare")!;
    expect(prepare.hasValidation).toBe(true);
    const failed = model.nodes.find((node) => node.title === "Reviewer 2")!;
    expect(failed.error).toBe("Provider exited\nwith a trace");
    const queued = model.nodes.find((node) => node.title === "Reviewer 3")!;
    expect(queued.reviewer?.queuePosition).toBe(1);
    expect(queued.placeholder).toBe(false);
    // A queued reviewer waits for admission, not input: its edge stays pending.
    expect(model.edges.find((edge) => edge.to === queued.id)?.state).toBe("pending");
  });

  test("keeps a retired pass's reviewer outcomes and issue counts from the sessions", () => {
    const model = pipelineFlowModel(
      build({
        phase: "addressing",
        reviewers: PANEL.slice(0, 2),
        currentSessionIndex: 4,
        sessions: [
          session("build", "build", 0),
          reviewer(0, "rev-1", 60, {
            reviewerOutcome: "completed",
            reviewIssueCounts: { P0: 1, P1: 0, P2: 2 },
          }),
          reviewer(1, "rev-2", 60, { reviewerOutcome: "failed", error: "Out of credit" }),
          session("review", "consolidation", 120, {
            label: "Consolidation",
            reviewReport: TEST_STRUCTURED_REVIEW_REPORT,
          }),
          session("address", "address", 180, { status: "running", completedAt: undefined }),
        ],
      }),
    );
    const byTitle = new Map(model.nodes.map((node) => [node.title, node]));
    expect(byTitle.get("Reviewer 1")?.issueCounts).toEqual({ P0: 1, P1: 0, P2: 2 });
    expect(byTitle.get("Reviewer 2")).toMatchObject({ state: "failed", error: "Out of credit" });
    expect(byTitle.get("Consolidation")?.issueCounts).toBeDefined();
    expect(byTitle.get("Address")?.state).toBe("running");
  });

  test("a retried reviewer replaces its failed attempt in the same slot", () => {
    const model = pipelineFlowModel(
      build({
        phase: "reviewing",
        reviewers: PANEL.slice(0, 2),
        reviewFanout: {
          reviewers: [
            { id: "r1", agent: "claude", model: "opus", status: "completed", sessionKey: "rev-1" },
            {
              id: "r2",
              agent: "codex",
              model: "gpt",
              status: "pending",
              admissionState: "admitting",
            },
          ],
        },
        sessions: [
          session("build", "build", 0),
          reviewer(0, "rev-1", 60, { reviewerOutcome: "completed" }),
          reviewer(1, "rev-2", 60, { reviewerOutcome: "failed", error: "boom" }),
        ],
      }),
    );
    const slot = model.nodes.filter((node) => node.title === "Reviewer 2");
    expect(slot).toHaveLength(1);
    expect(slot[0]).toMatchObject({ state: "not-started", earlierAttempts: 1 });
    expect(slot[0]!.reviewer?.admissionState).toBe("admitting");
  });

  test("a fan-out that failed without consolidating carries the failure on consolidation", () => {
    const model = pipelineFlowModel(
      build({
        phase: "failed",
        error: "No reviewer produced a valid report",
        failureContext: { phase: "reviewing", kind: "stage-transition" },
        reviewers: PANEL.slice(0, 2),
        reviewFanout: {
          reviewers: [
            { id: "r1", agent: "claude", model: "opus", status: "failed", sessionKey: "rev-1" },
            { id: "r2", agent: "codex", model: "gpt", status: "failed", sessionKey: "rev-2" },
          ],
        },
        sessions: [
          session("build", "build", 0),
          reviewer(0, "rev-1", 60),
          reviewer(1, "rev-2", 60),
        ],
      }),
    );
    // The reviewers failed on their own records, so the stage keeps its error
    // on the reviewers; nothing extra is invented.
    expect(model.nodes.filter((node) => node.state === "failed").map((node) => node.title)).toEqual(
      ["Reviewer 1", "Reviewer 2"],
    );
    const consolidation = model.nodes.find((node) => node.kind === "consolidation");
    expect(consolidation?.state).toBe("not-started");
  });

  test("a stage that failed before its session existed gets a failed node of its own", () => {
    const model = pipelineFlowModel(
      build({
        phase: "failed",
        error: "Could not start the verifier",
        failureContext: { phase: "verifying", kind: "stage-transition" },
        sessions: [
          session("build", "build", 0),
          session("review", "review", 60, { label: "Review Session" }),
        ],
      }),
    );
    const verify = model.nodes.find((node) => node.kind === "verify" && !node.placeholder);
    expect(verify).toMatchObject({ state: "failed", error: "Could not start the verifier" });
  });

  test.each(["verifying", "creating-pr"] as const)(
    "historical reviewer failure cannot mask %s startup failure",
    (phase) => {
      const model = pipelineFlowModel(
        build({
          phase: "failed",
          error: "Could not start next stage",
          failureContext: { phase, kind: "stage-transition" },
          reviewers: PANEL.slice(0, 2),
          sessions: [
            session("build", "build", 0),
            reviewer(0, "rev-1", 60, { reviewerOutcome: "completed" }),
            reviewer(1, "rev-2", 60, { reviewerOutcome: "failed", error: "Old failure" }),
            session("review", "consolidation", 120, { label: "Consolidation" }),
            ...(phase === "creating-pr" ? [session("verify", "verify", 180)] : []),
          ],
        }),
      );
      expect(
        model.nodes.find((node) => node.kind === (phase === "verifying" ? "verify" : "ship")),
      ).toMatchObject({
        placeholder: false,
        state: "failed",
        error: "Could not start next stage",
      });
      expect(model.nodes.find((node) => node.id === "rev-2")?.state).toBe("failed");
    },
  );

  test.each(["planned", "running", "completed", "cancelled", "failed"] as const)(
    "dedicated preparation carries %s validation status and completion time",
    (status) => {
      const run = validationRun({
        status,
        completedAt:
          status === "planned" || status === "running" ? undefined : "2026-07-29T00:04:00.000Z",
        error: status === "failed" ? "Runner died" : undefined,
      });
      const model = pipelineFlowModel(
        build({
          phase: "reviewing",
          reviewers: PANEL,
          sessions: [
            session("build", "build", 0),
            session("fix", "prep", 60, { label: REVIEW_PACKAGE_SESSION_LABEL }),
          ],
          validationRun: run,
        }),
      );
      const prep = model.nodes.find((node) => node.id === "prep")!;
      expect(prep).toMatchObject({
        state:
          status === "planned" || status === "running"
            ? "running"
            : status === "completed"
              ? "complete"
              : status,
        hasValidation: true,
        completedAt: run.completedAt,
      });
      expect(prep.session?.sessionKey).toBe("prep");
      if (status === "failed") expect(prep.error).toBe("Runner died");
    },
  );

  test.each(["build", "fix"] as const)(
    "single-review %s validation continues at Review without a Build placeholder",
    (phase) => {
      const model = pipelineFlowModel(
        build({
          phase: "reviewing",
          iteration: phase === "fix" ? 1 : 0,
          sessions: [session(phase, phase, 0, { iteration: phase === "fix" ? 1 : 0 })],
          validationRun: validationRun({ status: "running", completedAt: undefined }),
        }),
      );
      expect(model.columns.map((column) => column.kind)).toEqual([
        "ticket",
        "setup",
        phase,
        "prepare",
        "review",
        "verify",
        "ship",
        "pr",
      ]);
      expect(model.nodes.some((node) => node.kind === "build" && node.placeholder)).toBe(false);
    },
  );

  test("cancelled and paused pipelines mark the step they stopped in", () => {
    const cancelled = pipelineFlowModel(
      build({
        phase: "failed",
        error: "Build cancelled",
        currentSessionIndex: 0,
        sessions: [session("build", "build", 0, { completedAt: undefined })],
      }),
    );
    expect(cancelled.nodes.find((node) => node.kind === "build")?.state).toBe("cancelled");
    expect(cancelled.nodes.some((node) => node.placeholder)).toBe(false);
    expect(cancelled.nodes.some((node) => node.kind === "pr")).toBe(false);

    const paused = pipelineFlowModel(
      build({
        phase: "paused",
        pausedFromPhase: "building",
        currentSessionIndex: 0,
        sessions: [session("build", "build", 0, { completedAt: undefined })],
      }),
    );
    expect(paused.nodes.find((node) => node.kind === "build")?.state).toBe("paused");
    expect(paused.nodes.some((node) => node.placeholder)).toBe(true);
  });

  test("the PR node shows the environment's PR only once the pipeline reached Ship", () => {
    const pullRequest = {
      url: "https://github.com/acme/app/pull/12",
      state: "open" as const,
      checks: { passed: 3, total: 4, pending: 1 },
    };
    const early = pipelineFlowModel(
      build({ phase: "building", sessions: [session("build", "build", 0)] }),
      pullRequest,
    );
    expect(early.nodes.at(-1)).toMatchObject({
      kind: "pr",
      state: "not-started",
      placeholder: true,
    });

    const shipped = pipelineFlowModel(
      build({
        phase: "complete",
        currentSessionIndex: 1,
        sessions: [session("build", "build", 0), session("pr", "pr", 60)],
      }),
      pullRequest,
    );
    expect(line(shipped)).toEqual([
      ["Ticket:complete"],
      ["Setup:complete"],
      ["Build:complete"],
      ["Ship:complete"],
      ["PR:complete"],
    ]);
    const closed = pipelineFlowModel(
      build({ phase: "complete", sessions: [session("pr", "pr", 0)] }),
      { ...pullRequest, state: "closed" },
    );
    expect(closed.nodes.at(-1)?.state).toBe("cancelled");
  });

  test("conflict resolution appears after Ship only once it runs", () => {
    const model = pipelineFlowModel(
      build({
        phase: "resolving-conflicts",
        currentSessionIndex: 2,
        sessions: [
          session("build", "build", 0),
          session("pr", "pr", 60),
          session("resolve-conflicts", "conflicts", 120, {
            status: "running",
            completedAt: undefined,
          }),
        ],
      }),
    );
    expect(line(model).slice(3)).toEqual([
      ["Ship:complete"],
      ["Resolve conflicts:running"],
      ["PR:not-started~"],
    ]);
  });

  test("an older pipeline without the outcome fields renders from what it has", () => {
    const model = pipelineFlowModel(
      build({
        phase: "complete",
        reviewers: PANEL.slice(0, 2),
        sessions: [
          session("build", "build", 0, { agent: undefined }),
          reviewer(0, "rev-1", 60),
          reviewer(1, "rev-2", 60, { status: "error" }),
          session("review", "consolidation", 120, { label: "Consolidation" }),
          session("verify", "verify", 180),
        ],
      }),
    );
    expect(line(model)[3]).toEqual(["Reviewer 1:complete", "Reviewer 2:failed"]);
    expect(model.nodes.find((node) => node.kind === "build")?.agent).toBe("codex");
    expect(model.nodes.some((node) => node.placeholder)).toBe(false);
  });

  test("falls back to the configured reviewer model and the pipeline's report", () => {
    const model = pipelineFlowModel(
      build({
        phase: "addressing",
        reviewers: PANEL.slice(0, 2),
        structuredReview: TEST_STRUCTURED_REVIEW_REPORT,
        structuredReviewRequestId: "request-1",
        sessions: [session("build", "build", 0), reviewer(1, "rev-2", 60, { model: undefined })],
      }),
    );
    expect(model.nodes.find((node) => node.title === "Reviewer 2")?.model).toBe("gpt-6.1");

    const classic = pipelineFlowModel(
      build({
        phase: "addressing",
        structuredReview: TEST_STRUCTURED_REVIEW_REPORT,
        structuredReviewRequestId: "request-1",
        sessions: [
          session("build", "build", 0),
          session("review", "review", 60, {
            label: "Review Session",
            structuredRequestId: "request-1",
          }),
        ],
      }),
    );
    const total = TEST_STRUCTURED_REVIEW_REPORT.issues.length;
    const counts = classic.nodes.find((node) => node.kind === "review")?.issueCounts;
    expect(counts && counts.P0 + counts.P1 + counts.P2).toBe(total);
  });

  test("narrows to one review pass with its preparation", () => {
    const model = pipelineFlowModel(
      build({
        phase: "addressing",
        reviewers: PANEL.slice(0, 2),
        sessions: [
          session("build", "build", 0),
          session("fix", "prep", 30, { label: REVIEW_PACKAGE_SESSION_LABEL }),
          reviewer(0, "rev-1", 60),
          reviewer(1, "rev-2", 60),
          session("review", "consolidation", 120, { label: "Consolidation" }),
          session("address", "address", 180),
        ],
      }),
    );
    const passKey = model.nodes.find((node) => node.kind === "reviewer")!.passKey!;
    expect(pipelineReviewPassNodes(model, passKey).map((node) => node.title)).toEqual([
      "Prepare",
      "Reviewer 1",
      "Reviewer 2",
      "Consolidation",
    ]);
  });
});

describe("pipelineFlowLayout", () => {
  test("puts columns left to right at a fixed width and stacks a column's nodes", () => {
    const geometry = pipelineFlowLayout({
      width: 600,
      columns: [
        { key: "a", label: "A", nodes: [{ id: "a", height: 64 }] },
        {
          key: "b",
          label: "B",
          nodes: [
            { id: "b1", height: 64 },
            { id: "b2", height: 64 },
          ],
        },
        { key: "c", label: "C", nodes: [{ id: "c", height: 64 }] },
      ],
    });
    const a = geometry.rects.get("a")!;
    const b1 = geometry.rects.get("b1")!;
    const b2 = geometry.rects.get("b2")!;
    const c = geometry.rects.get("c")!;
    expect(b1.x).toBeGreaterThan(a.x + a.width);
    expect(c.x).toBeGreaterThan(b1.x + b1.width);
    expect(b2.y).toBeGreaterThan(b1.y + b1.height);
    // Single nodes centre on the stack.
    expect(a.y + a.height / 2).toBeCloseTo((b1.y + b2.y + b2.height) / 2, 0);
    expect(geometry.width).toBeGreaterThanOrEqual(c.x + c.width);
    expect(geometry.labels.map((label) => label.text)).toEqual(["A", "B", "C"]);
  });
});
