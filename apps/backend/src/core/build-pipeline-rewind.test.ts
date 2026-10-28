import { describe, expect, test } from "bun:test";
import {
  MAX_PIPELINE_REWINDS,
  MAX_PIPELINE_ROUND_REVIEW_REPORT_BYTES,
  MAX_PIPELINE_ROUND_REVIEW_REPORTS,
  REVIEW_PACKAGE_SESSION_LABEL,
  type BuildPipeline,
  type PipelineRewind,
  type PipelineSession,
  type PipelineSessionPhase,
} from "@orkestrator/protocol/build-pipeline";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import { cleanReview } from "./build-pipeline-service-test-support.js";
import {
  carriesFixBaseline,
  pruneRoundReviewReports,
  recordRewind,
  retainRoundReviewReport,
  roundReviewReport,
  restartStepOrder,
  sessionStepOrder,
  supersedeSessionsFrom,
  verificationFeedbackBefore,
} from "./build-pipeline-rewind.js";

function session(
  phase: PipelineSessionPhase,
  iteration: number,
  overrides: Partial<PipelineSession> = {},
): PipelineSession {
  return {
    phase,
    iteration,
    sessionKey: `${phase}:${iteration}:${overrides.label ?? ""}`,
    sdkSessionId: `${phase}-${iteration}`,
    status: "idle",
    startedAt: new Date(iteration * 1_000).toISOString(),
    label: `${phase} Session`,
    ...overrides,
  };
}

function rewind(overrides: Partial<PipelineRewind> = {}): PipelineRewind {
  return {
    id: "rewind-1",
    at: new Date(10_000).toISOString(),
    fromPhase: "failed",
    fromIteration: 2,
    iteration: 0,
    step: { kind: "session", phase: "verify" },
    supersededSessions: 1,
    ...overrides,
  };
}

/** Build, Review, Verify, then Fix, Review, Verify for each later round. */
function loop(rounds: number): PipelineSession[] {
  const sessions = [session("build", 0), session("review", 0), session("verify", 0)];
  for (let iteration = 1; iteration < rounds; iteration += 1) {
    sessions.push(
      session("fix", iteration),
      session("review", iteration),
      session("verify", iteration),
    );
  }
  return sessions;
}

describe("build pipeline rewinds", () => {
  test("orders steps the way a round runs them", () => {
    expect(sessionStepOrder(session("build", 0))).toBe(0);
    expect(sessionStepOrder(session("fix", 1))).toBe(0);
    expect(
      sessionStepOrder(session("fix", 1, { label: REVIEW_PACKAGE_SESSION_LABEL })),
    ).toBeGreaterThan(0);
    // A build turn that also wrote the package plan is still the build step.
    expect(sessionStepOrder(session("build", 0, { producedReviewPackagePlan: true }))).toBe(0);
    const order = [
      restartStepOrder({ kind: "session", phase: "build" }),
      restartStepOrder({ kind: "review-package", implementationPhase: "build" }),
      restartStepOrder({ kind: "validation", implementationPhase: "build" }),
      restartStepOrder({ kind: "session", phase: "review" }),
      restartStepOrder({ kind: "session", phase: "address" }),
      restartStepOrder({ kind: "session", phase: "verify" }),
      restartStepOrder({ kind: "session", phase: "pr" }),
      restartStepOrder({ kind: "session", phase: "resolve-conflicts" }),
    ];
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(new Set(order).size).toBe(order.length);
  });

  test("supersedes the restarted step and everything after it, in every later round", () => {
    const pipeline = { sessions: loop(4) };
    pipeline.sessions.at(-1)!.status = "running";

    const count = supersedeSessionsFrom(
      pipeline,
      { iteration: 0, order: restartStepOrder({ kind: "session", phase: "verify" }) },
      "rewind-1",
      "2026-10-27T00:00:00.000Z",
    );

    expect(count).toBe(10);
    expect(pipeline.sessions.slice(0, 2).every((entry) => !entry.supersededBy)).toBe(true);
    expect(
      pipeline.sessions
        .slice(2)
        .every(
          (entry) =>
            entry.supersededBy === "rewind-1" && entry.supersededAt === "2026-10-27T00:00:00.000Z",
        ),
    ).toBe(true);
    // An aborted running turn is settled; settled sessions keep their own times.
    expect(pipeline.sessions.at(-1)).toMatchObject({
      status: "idle",
      completedAt: "2026-10-27T00:00:00.000Z",
    });
    expect(pipeline.sessions[2]?.completedAt).toBeUndefined();
  });

  test("keeps the rewind that first superseded a session", () => {
    const pipeline = { sessions: loop(3) };
    supersedeSessionsFrom(pipeline, { iteration: 1, order: 0 }, "first", "2026-10-27T00:00:00Z");
    const second = supersedeSessionsFrom(
      pipeline,
      { iteration: 0, order: 2 },
      "second",
      "2026-10-27T00:01:00Z",
    );

    expect(second).toBe(2);
    expect(pipeline.sessions.map((entry) => entry.supersededBy)).toEqual([
      undefined,
      "second",
      "second",
      "first",
      "first",
      "first",
      "first",
      "first",
      "first",
    ]);
  });

  test("a package restart keeps the build that wrote the plan; validation keeps the preparation", () => {
    const build = session("build", 0, { producedReviewPackagePlan: true });
    const preparation = session("fix", 0, { label: REVIEW_PACKAGE_SESSION_LABEL });
    const review = session("review", 0);
    const packageRestart = { sessions: [structuredClone(build), structuredClone(review)] };
    supersedeSessionsFrom(
      packageRestart,
      {
        iteration: 0,
        order: restartStepOrder({ kind: "review-package", implementationPhase: "build" }),
      },
      "rewind",
      "2026-10-27T00:00:00Z",
    );
    expect(packageRestart.sessions.map((entry) => entry.supersededBy)).toEqual([
      undefined,
      "rewind",
    ]);

    const validationRestart = { sessions: [build, preparation, review] };
    supersedeSessionsFrom(
      validationRestart,
      {
        iteration: 0,
        order: restartStepOrder({ kind: "validation", implementationPhase: "build" }),
      },
      "rewind",
      "2026-10-27T00:00:00Z",
    );
    expect(validationRestart.sessions.map((entry) => entry.supersededBy)).toEqual([
      undefined,
      undefined,
      "rewind",
    ]);
  });

  test("bounds the rewind history to the newest entries", () => {
    const pipeline: { rewinds?: PipelineRewind[] } = {};
    for (let index = 0; index < MAX_PIPELINE_REWINDS + 3; index += 1) {
      recordRewind(pipeline, rewind({ id: `rewind-${index}` }));
    }
    expect(pipeline.rewinds).toHaveLength(MAX_PIPELINE_REWINDS);
    expect(pipeline.rewinds?.[0]?.id).toBe("rewind-3");
    expect(pipeline.rewinds?.at(-1)?.id).toBe(`rewind-${MAX_PIPELINE_REWINDS + 2}`);
  });

  test("reads the verdict that sent a round into its fix from the live run", () => {
    const sessions = loop(3);
    sessions[2]!.verificationFeedback = "Round one failed";
    sessions[5]!.verificationFeedback = "Round two failed";
    const superseded = session("verify", 0, {
      sessionKey: "old-verify",
      verificationFeedback: "A superseded verdict",
      supersededBy: "rewind-1",
    });

    expect(verificationFeedbackBefore({ sessions: [...sessions, superseded] }, 1)).toBe(
      "Round one failed",
    );
    expect(verificationFeedbackBefore({ sessions }, 2)).toBe("Round two failed");
    // Older records kept no per-session verdict.
    expect(verificationFeedbackBefore({ sessions: loop(3) }, 1)).toBeUndefined();
  });

  test("an earlier fix baseline carries over only within its own round", () => {
    const fix = session("fix", 1);
    expect(carriesFixBaseline({}, fix)).toBe(true);

    const sameRound = rewind({ id: "same", fromIteration: 1, iteration: 1 });
    const supersededHere = { ...fix, supersededBy: "same" };
    expect(carriesFixBaseline({ rewinds: [sameRound] }, supersededHere)).toBe(true);

    const fromLater = rewind({ id: "later", fromIteration: 3, iteration: 0 });
    expect(carriesFixBaseline({ rewinds: [fromLater] }, { ...fix, supersededBy: "later" })).toBe(
      false,
    );
    // Restarted in its own round, then rewound again from a later round.
    expect(
      carriesFixBaseline(
        {
          rewinds: [sameRound, { ...fromLater, at: new Date(20_000).toISOString() }],
        },
        supersededHere,
      ),
    ).toBe(false);
    // A rewind whose record was dropped from the bounded history is not trusted.
    expect(carriesFixBaseline({ rewinds: [] }, supersededHere)).toBe(false);
  });
});

describe("per-round review report copies", () => {
  const report = (summary: string): StructuredReviewReport => ({
    ...cleanReview,
    reviewSummary: summary,
  });
  const record = (sessions: PipelineSession[]) =>
    ({ sessions }) as Pick<BuildPipeline, "sessions" | "roundReviewReports">;

  test("keeps one copy per round and reads it while its review is the newest", () => {
    const first = session("review", 0);
    const second = session("review", 1);
    const pipeline = record([first, second]);
    retainRoundReviewReport(pipeline, first, report("round 0"));
    retainRoundReviewReport(pipeline, second, report("round 1"));
    expect(roundReviewReport(pipeline, 0)?.reviewSummary).toBe("round 0");
    expect(roundReviewReport(pipeline, 1)?.reviewSummary).toBe("round 1");

    // A second accepted review of round 0 replaces that round's copy.
    const retried = session("review", 0, { sessionKey: "review:0:retry" });
    pipeline.sessions.push(retried);
    expect(roundReviewReport(pipeline, 0)).toBeUndefined();
    retainRoundReviewReport(pipeline, retried, report("round 0 again"));
    expect(pipeline.roundReviewReports?.map((entry) => entry.sessionKey)).toEqual([
      "review:0:retry",
      second.sessionKey,
    ]);
    expect(roundReviewReport(pipeline, 0)?.reviewSummary).toBe("round 0 again");
  });

  test("drops copies whose review a rewind superseded or a reviewer retry discarded", () => {
    const first = session("review", 0);
    const second = session("review", 1);
    const pipeline = record([first, second]);
    retainRoundReviewReport(pipeline, first, report("round 0"));
    retainRoundReviewReport(pipeline, second, report("round 1"));
    second.supersededBy = "rewind-1";
    first.superseded = true;
    pruneRoundReviewReports(pipeline);
    expect(pipeline.roundReviewReports).toBeUndefined();
  });

  test("stays within the byte budget, oldest rounds first, and skips an oversized report", () => {
    const filler = "x".repeat(Math.floor(MAX_PIPELINE_ROUND_REVIEW_REPORT_BYTES / 3));
    const sessions = [0, 1, 2, 3].map((iteration) => session("review", iteration));
    const pipeline = record(sessions);
    for (const entry of sessions) {
      retainRoundReviewReport(pipeline, entry, report(`${entry.iteration}${filler}`));
    }
    const size = (pipeline.roundReviewReports ?? []).reduce(
      (sum, entry) => sum + new TextEncoder().encode(JSON.stringify(entry.report)).length,
      0,
    );
    expect(size).toBeLessThanOrEqual(MAX_PIPELINE_ROUND_REVIEW_REPORT_BYTES);
    expect(pipeline.roundReviewReports?.map((entry) => entry.iteration)).toEqual([2, 3]);

    const huge = session("review", 4);
    pipeline.sessions.push(huge);
    retainRoundReviewReport(
      pipeline,
      huge,
      report("y".repeat(MAX_PIPELINE_ROUND_REVIEW_REPORT_BYTES + 1)),
    );
    expect(roundReviewReport(pipeline, 4)).toBeUndefined();
    expect(pipeline.roundReviewReports?.map((entry) => entry.iteration)).toEqual([2, 3]);
  });

  test("keeps no more copies than a record may hold", () => {
    const sessions = Array.from({ length: MAX_PIPELINE_ROUND_REVIEW_REPORTS + 1 }, (_, index) =>
      session("review", index),
    );
    const pipeline = record(sessions);
    for (const entry of sessions) retainRoundReviewReport(pipeline, entry, report("small"));
    expect(pipeline.roundReviewReports).toHaveLength(MAX_PIPELINE_ROUND_REVIEW_REPORTS);
    expect(pipeline.roundReviewReports?.[0]?.iteration).toBe(1);
  });
});
