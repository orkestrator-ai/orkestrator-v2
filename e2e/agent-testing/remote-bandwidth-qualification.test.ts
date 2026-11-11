import { describe, expect, test } from "bun:test";
import {
  completionAfterLastDelta,
  lastStreamByteMs,
  latencyProblems,
  outcomeOf,
  summary,
  terminalProblems,
} from "./remote-bandwidth-qualification";

describe("arithmetic", () => {
  test("a summary counts timed-out samples apart from the percentiles", () => {
    expect(summary([300, null, 100, 200])).toEqual({
      n: 3,
      missing: 1,
      min: 100,
      p50: 200,
      p95: 300,
      max: 300,
    });
    expect(summary([])).toEqual({ n: 0, missing: 0, min: null, p50: null, p95: null, max: null });
  });

  test("completion runs from the model's last delta to the client's last line", () => {
    // The answer started at 1,000, the client showed its last line 6,300 ms
    // later, the model wrote its last delta at 6,000.
    const answeredAt = 1_000;
    expect(completionAfterLastDelta(answeredAt + 6_300, 6_000)).toBe(1_300);
  });

  test("completion is unknown, never guessed, when either end is missing", () => {
    expect(completionAfterLastDelta(null, 6_000)).toBeNull();
    // A stream that never ended has no last delta to measure from.
    expect(completionAfterLastDelta(7_300, undefined)).toBeNull();
  });

  test("a burst's last stream byte counts only bytes after its write", () => {
    expect(lastStreamByteMs(10_000, 10_450)).toBe(450);
    expect(lastStreamByteMs(10_000, 9_000)).toBeNull();
    expect(lastStreamByteMs(10_000, 0)).toBeNull();
  });
});

describe("qualification", () => {
  test("a full series inside its budget qualifies", () => {
    const problems = latencyProblems("completion", summary([400, 700, 900]), {
      samples: 3,
      budgetMs: 3_000,
    });
    expect(problems).toEqual([]);
    expect(outcomeOf(problems)).toBe("qualified");
  });

  test("timed-out and missing samples make a cell incomplete", () => {
    const problems = latencyProblems("approval", summary([200, null]), {
      samples: 5,
      budgetMs: 2_000,
    });
    expect(problems.map((problem) => problem.detail)).toEqual([
      "approval: 2 of 5 samples taken",
      "approval: 1 samples timed out",
    ]);
    expect(outcomeOf(problems)).toBe("incomplete");
  });

  test("a p95 past its budget is over budget", () => {
    const problems = latencyProblems("completion", summary([400, 3_500]), {
      samples: 2,
      budgetMs: 3_000,
    });
    expect(problems).toEqual([
      { kind: "over-budget", detail: "completion: p95 3500 ms over the 3000 ms budget" },
    ]);
    expect(outcomeOf(problems)).toBe("over-budget");
  });

  test("a negative sample, a probe that matched before its event, is not evidence", () => {
    const problems = latencyProblems("completion", summary([-120, 400]), { samples: 2 });
    expect(problems).toEqual([
      { kind: "incomplete", detail: "completion: negative sample -120 ms" },
    ]);
  });

  test("a series with no budget checks only its samples", () => {
    expect(latencyProblems("first update", summary([90_000]), { samples: 1 })).toEqual([]);
  });

  test("a terminal burst must finish, settle and reach every client", () => {
    expect(
      terminalProblems(
        "terminal-build",
        { backendDoneMs: 800, settled: true, lastStreamByteMs: summary([500, 520, 530]) },
        3,
      ),
    ).toEqual([]);
    const problems = terminalProblems(
      "terminal-build",
      { backendDoneMs: null, settled: false, lastStreamByteMs: summary([500, null]) },
      3,
    );
    expect(problems.map((problem) => problem.detail)).toEqual([
      "terminal-build: the command never finished",
      "terminal-build: the streams never went quiet",
      "terminal-build last stream byte: 2 of 3 samples taken",
      "terminal-build last stream byte: 1 samples timed out",
    ]);
    expect(outcomeOf(problems)).toBe("incomplete");
  });

  test("incomplete outranks over budget", () => {
    expect(
      outcomeOf([
        { kind: "over-budget", detail: "a" },
        { kind: "incomplete", detail: "b" },
      ]),
    ).toBe("incomplete");
  });
});
