import { describe, expect, test } from "bun:test";
import type {
  SelfImprovementProgress,
  SelfImprovementStage,
} from "@orkestrator/protocol/self-improvement";
import {
  ageMs,
  formatDuration,
  liveness,
  QUIET_MS,
  stageFigures,
  stageSummary,
  type StageContext,
} from "./self-improvement-progress";

const OBSERVED = Date.parse("2026-11-14T10:10:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function progress(overrides: Partial<SelfImprovementProgress> = {}): SelfImprovementProgress {
  return {
    stages: [],
    observedAt: iso(OBSERVED),
    lastActivityAt: iso(OBSERVED - 1000),
    modelCalls: { inFlight: 0, oldestStartedAt: null, timeoutMs: 600_000 },
    ...overrides,
  };
}

const context: StageContext = {
  dryRun: false,
  reviewOn: true,
  models: { notes: "claude-sonnet-5-5", themes: "claude-opus-5-5" },
  modelName: (id) => (id === "claude-opus-5-5" ? "Opus 5.5" : id),
};

const stage = (
  step: SelfImprovementStage["step"],
  state: SelfImprovementStage["state"],
): SelfImprovementStage => ({ step, state });

describe("formatDuration", () => {
  test("reads at a glance from seconds to hours", () => {
    expect(formatDuration(400)).toBe("under a second");
    expect(formatDuration(12_000)).toBe("12 s");
    expect(formatDuration(125_000)).toBe("2 min 05 s");
    expect(formatDuration(3_900_000)).toBe("1 h 05 min");
  });
});

describe("ageMs", () => {
  test("counts from backend timestamps plus the time since the window received them", () => {
    const received = 5_000_000;
    // The window's clock is hours off the backend's: only the gap matters.
    const clock = { now: received + 4000, receivedAt: received };
    expect(ageMs(progress(), iso(OBSERVED - 10_000), clock)).toBe(14_000);
  });

  test("never goes negative and ignores a timestamp it cannot read", () => {
    const clock = { now: 0, receivedAt: 10_000 };
    expect(ageMs(progress(), iso(OBSERVED), clock)).toBe(0);
    expect(ageMs(progress(), "not a date", clock)).toBe(0);
  });
});

describe("liveness", () => {
  const clock = { now: 1000, receivedAt: 1000 };

  test("a recent sign of life reads as moving", () => {
    expect(liveness(progress(), clock)).toMatchObject({ tone: "active" });
    expect(liveness(progress({ lastActivityAt: iso(OBSERVED - 30_000) }), clock).text).toContain(
      "30 s ago",
    );
  });

  test("a model call in flight is waited on, not called stuck, however quiet", () => {
    const waiting = liveness(
      progress({
        lastActivityAt: iso(OBSERVED - 5 * QUIET_MS),
        modelCalls: {
          inFlight: 2,
          oldestStartedAt: iso(OBSERVED - 190_000),
          timeoutMs: 600_000,
        },
      }),
      clock,
    );
    expect(waiting.tone).toBe("waiting");
    expect(waiting.text).toContain("2 model calls");
    expect(waiting.text).toContain("3 min 10 s");
    expect(waiting.text).toContain("10 minutes");
  });

  test("past the quiet limit with nothing to wait on, it may be stuck", () => {
    const quiet = liveness(progress({ lastActivityAt: iso(OBSERVED - QUIET_MS - 5000) }), clock);
    expect(quiet.tone).toBe("quiet");
    expect(quiet.text).toContain("It may be stuck");
  });
});

describe("stageSummary and stageFigures", () => {
  const review = {
    filesChecked: 0,
    files: null as number | null,
    parts: null as number | null,
    read: 0,
    failed: 0,
    notesAdded: 0,
    waiting: 0,
  };
  const reading = (state: SelfImprovementStage["state"]) => stage("reading-conversations", state);

  test("follows the review from listing to scanning to reading", () => {
    const summary = (conversations: typeof review) =>
      stageSummary(reading("running"), progress({ conversations }), context);
    expect(summary(review)).toBe("Looking for conversation history…");
    expect(summary({ ...review, files: 3146, filesChecked: 812 })).toBe(
      "Checking history files: 812 of 3,146",
    );
    expect(summary({ ...review, files: 10, filesChecked: 10, parts: 30, read: 4 })).toBe(
      "Read 4 of 30 parts",
    );
    expect(summary({ ...review, files: 10, filesChecked: 10, parts: 1, read: 0, failed: 1 })).toBe(
      "Read 0 of 1 part, 1 failed",
    );
  });

  test("gives the reason a stage is skipped", () => {
    const p = progress();
    expect(stageSummary(stage("filing", "skipped"), p, { ...context, dryRun: true })).toBe(
      "A preview files nothing.",
    );
    expect(
      stageSummary(stage("grouping-themes", "skipped"), p, { ...context, reviewOn: false }),
    ).toBe("The conversation review is off.");
    expect(stageSummary(stage("grouping-themes", "skipped"), p, context)).toBe(
      "No saved notes needed grouping.",
    );
  });

  test("names the model grouping the notes, and says nothing for a pending stage", () => {
    expect(stageSummary(stage("grouping-themes", "running"), progress(), context)).toBe(
      "Opus 5.5 is grouping the notes",
    );
    expect(stageSummary(stage("filing", "pending"), progress(), context)).toBeNull();
    expect(stageSummary(stage("board", "running"), progress(), context)).toBeNull();
  });

  test("the window adds notes, failures and what waits for the next run", () => {
    const lines = stageFigures(
      reading("running"),
      progress({
        conversations: {
          ...review,
          files: 50,
          filesChecked: 50,
          parts: 30,
          read: 6,
          failed: 2,
          notesAdded: 9,
          waiting: 4,
        },
      }),
    );
    expect(lines).toEqual([
      "50 history files checked of 50",
      "9 notes found so far in 6 parts",
      "2 parts failed; they are read again next run",
      "4 more parts waiting for the next run",
    ]);
    expect(stageFigures(stage("board", "running"), progress())).toEqual([]);
  });
});
