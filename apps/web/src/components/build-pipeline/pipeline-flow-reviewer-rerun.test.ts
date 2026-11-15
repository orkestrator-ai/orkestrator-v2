import { describe, expect, test } from "bun:test";
import { pipelineIndependentReviewLabel } from "@orkestrator/protocol/build-pipeline";
import {
  pipelineFlowModel,
  pipelineRestartableReviewerId,
  type PipelineFlowModel,
} from "./pipeline-flow";
import { build, session } from "./pipeline-test-fixture";
import type { BuildPipeline } from "@/stores/buildPipelineStore";

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

const reviewer = (slot: number, key: string, start: number, overrides = {}) =>
  session("review", key, start, {
    label: pipelineIndependentReviewLabel(slot),
    reviewPassId: "panel",
    ...overrides,
  });

const PANEL = [
  { agent: "claude" as const, model: "opus" },
  { agent: "codex" as const, model: "gpt" },
];
const SUPERSEDED = { supersededBy: "rerun", supersededAt: "2026-07-29T00:20:00.000Z" };
const RERUN_REWIND = {
  id: "rerun",
  at: "2026-07-29T00:20:00.000Z",
  fromPhase: "paused" as const,
  fromIteration: 0,
  iteration: 0,
  step: { kind: "session" as const, phase: "review" as const },
  sessionKey: "p:review:0:panel:1",
  supersededSessions: 2,
};
const PACKAGE = { headRef: "1".repeat(40) } as unknown as BuildPipeline["reviewPackage"];

/** Reviewer 2 rerun after its pass consolidated and Address had started. */
function rerunAfterConsolidation(overrides: Partial<BuildPipeline> = {}): BuildPipeline {
  return build({
    phase: "reviewing",
    reviewers: PANEL,
    reviewPackage: PACKAGE,
    sessions: [
      session("build", "build", 0),
      reviewer(0, "p:review:0:panel", 60, { reviewerOutcome: "completed" }),
      reviewer(1, "p:review:0:panel:1", 60, { reviewerOutcome: "completed" }),
      session("review", "consolidation", 120, {
        label: "Consolidation",
        reviewPassId: "panel",
        ...SUPERSEDED,
      }),
      session("address", "address", 180, SUPERSEDED),
      reviewer(1, "p:review:0:panel:1:attempt-2", 300, {
        status: "running",
        completedAt: undefined,
      }),
    ],
    reviewFanout: {
      reviewers: [
        {
          id: "panel",
          agent: "claude",
          model: "opus",
          status: "completed",
          sessionKey: "p:review:0:panel",
        },
        {
          id: "panel:1",
          agent: "codex",
          model: "gpt",
          status: "running",
          sessionKey: "p:review:0:panel:1:attempt-2",
        },
      ],
    },
    rewinds: [RERUN_REWIND],
    ...overrides,
  });
}

describe("one reviewer rerun after consolidation", () => {
  test("stays in its panel, beside the kept report, ahead of the superseded Consolidation", () => {
    const model = pipelineFlowModel(rerunAfterConsolidation());

    expect(line(model).slice(3, 6)).toEqual([
      ["Reviewer 1:complete", "Reviewer 2:running"],
      ["Previous attempt:cancelled"],
      ["Consolidation:not-started~"],
    ]);
    expect(model.columns.filter((column) => column.kind === "review")).toHaveLength(1);
    const rerun = model.nodes.find((node) => node.id === "p:review:0:panel:1:attempt-2")!;
    expect(rerun.earlierAttempts).toBe(1);
    expect(model.nodes.find((node) => node.kind === "attempt")?.attemptSessionKeys).toEqual([
      "consolidation",
      "address",
    ]);
  });

  test("the re-consolidation joins the same pass once it starts", () => {
    const pipeline = rerunAfterConsolidation();
    pipeline.sessions.push(
      session("review", "consolidation-2", 400, {
        label: "Consolidation",
        reviewPassId: "panel",
        status: "running",
        completedAt: undefined,
      }),
    );
    pipeline.sessions[5] = {
      ...pipeline.sessions[5]!,
      status: "idle",
      reviewerOutcome: "completed",
    };
    pipeline.reviewFanout!.reviewers[1]!.status = "completed";

    const model = pipelineFlowModel(pipeline);

    expect(line(model).slice(3, 6)).toEqual([
      ["Reviewer 1:complete", "Reviewer 2:complete"],
      ["Previous attempt:cancelled"],
      ["Consolidation:running"],
    ]);
    expect(model.columns.filter((column) => column.kind === "consolidation")).toHaveLength(1);
  });

  test("a reviewer of a retired pass offers Restart reviewer while its round is current", () => {
    const pipeline = build({
      phase: "paused",
      pausedFromPhase: "addressing",
      reviewers: PANEL,
      reviewPackage: PACKAGE,
      currentSessionIndex: 3,
      sessions: [
        session("build", "build", 0),
        reviewer(0, "p:review:0:panel", 60, { reviewerOutcome: "completed" }),
        session("review", "consolidation", 120, {
          label: "Consolidation",
          reviewPassId: "panel",
          sessionlessReviewers: [
            {
              id: "panel:1",
              slot: 1,
              agent: "codex",
              model: "gpt",
              error: "codex bridge directory not found",
              startFailed: true,
            },
          ],
        }),
        session("address", "address", 180),
      ],
    });
    const model = pipelineFlowModel(pipeline);
    const node = (title: string) => model.nodes.find((candidate) => candidate.title === title)!;

    expect(pipelineRestartableReviewerId(pipeline, node("Reviewer 1"))).toBe("p:review:0:panel");
    expect(pipelineRestartableReviewerId(pipeline, node("Reviewer 2"))).toBe("panel:1");
    // A later round's code needs a whole new review.
    const laterRound = { ...pipeline, iteration: 1 };
    expect(pipelineRestartableReviewerId(laterRound, node("Reviewer 2"))).toBeNull();
    expect(pipelineRestartableReviewerId(laterRound, node("Reviewer 1"))).toBeNull();
  });
});
