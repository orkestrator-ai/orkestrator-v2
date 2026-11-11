/**
 * The arithmetic and the pass rule of the remote bandwidth matrix
 * (`remote-bandwidth-live.spec.ts`), kept apart from the browser so they can
 * be unit-tested.
 *
 * A cell qualifies only when it has every sample it was meant to take, every
 * terminal burst finished and settled, and each budgeted latency is inside its
 * p95 budget. A cell that falls short is still recorded as evidence, with its
 * outcome and the reasons, and the spec fails at the end of its run instead of
 * passing on numbers it never took.
 */
import { percentile } from "./remote-bandwidth-meter";

export interface LatencySummary {
  /** Samples taken. */
  n: number;
  /** Samples that timed out (null). */
  missing: number;
  min: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export function summary(values: ReadonlyArray<number | null>): LatencySummary {
  const numbers = values.filter((value): value is number => value !== null);
  return {
    n: numbers.length,
    missing: values.length - numbers.length,
    min: numbers.length ? Math.min(...numbers) : null,
    p50: percentile(numbers, 0.5),
    p95: percentile(numbers, 0.95),
    max: numbers.length ? Math.max(...numbers) : null,
  };
}

/**
 * The time from the model's last streamed delta to the client showing the
 * answer's last line: null when either is unknown, never a substitute such as
 * the time the model started answering.
 */
export function completionAfterLastDelta(
  doneAt: number | null | undefined,
  streamedAt: number | null | undefined,
): number | null {
  if (doneAt === null || doneAt === undefined) return null;
  if (streamedAt === null || streamedAt === undefined) return null;
  return doneAt - streamedAt;
}

/** The time from a burst's write to the last stream byte a client received, null if none since. */
export function lastStreamByteMs(startedAt: number, lastDelivery: number): number | null {
  return lastDelivery > startedAt ? lastDelivery - startedAt : null;
}

export type ProblemKind = "incomplete" | "over-budget";
export interface Problem {
  kind: ProblemKind;
  detail: string;
}
export type Outcome = "qualified" | ProblemKind;

/**
 * What is wrong with one latency series: fewer samples than expected, a
 * timed-out sample, a negative one (a probe that matched before its event),
 * or a p95 past its budget.
 */
export function latencyProblems(
  label: string,
  latency: LatencySummary,
  expectation: { samples: number; budgetMs?: number },
): Problem[] {
  const problems: Problem[] = [];
  const taken = latency.n + latency.missing;
  if (taken < expectation.samples) {
    problems.push({
      kind: "incomplete",
      detail: `${label}: ${taken} of ${expectation.samples} samples taken`,
    });
  }
  if (latency.missing > 0) {
    problems.push({ kind: "incomplete", detail: `${label}: ${latency.missing} samples timed out` });
  }
  if (latency.min !== null && latency.min < 0) {
    problems.push({ kind: "incomplete", detail: `${label}: negative sample ${latency.min} ms` });
  }
  if (
    expectation.budgetMs !== undefined &&
    latency.p95 !== null &&
    latency.p95 > expectation.budgetMs
  ) {
    problems.push({
      kind: "over-budget",
      detail: `${label}: p95 ${latency.p95} ms over the ${expectation.budgetMs} ms budget`,
    });
  }
  return problems;
}

/** What is wrong with one terminal burst: unfinished in the backend, unsettled, or unseen. */
export function terminalProblems(
  label: string,
  burst: { backendDoneMs: number | null; settled: boolean; lastStreamByteMs: LatencySummary },
  clients: number,
): Problem[] {
  const problems: Problem[] = [];
  if (burst.backendDoneMs === null) {
    problems.push({ kind: "incomplete", detail: `${label}: the command never finished` });
  }
  if (!burst.settled) {
    problems.push({ kind: "incomplete", detail: `${label}: the streams never went quiet` });
  }
  problems.push(
    ...latencyProblems(`${label} last stream byte`, burst.lastStreamByteMs, { samples: clients }),
  );
  return problems;
}

export function outcomeOf(problems: readonly Problem[]): Outcome {
  if (problems.some((problem) => problem.kind === "incomplete")) return "incomplete";
  return problems.length > 0 ? "over-budget" : "qualified";
}
