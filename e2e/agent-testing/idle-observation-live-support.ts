/**
 * Pure helpers for `idle-observation-live.spec.ts`, kept apart so they are
 * unit-tested without a profile or a browser.
 */

export const IDLE_OBSERVATION_CASES = [
  "missed-final",
  "approval",
  "subagents",
  "background",
  "reconnect",
  "hidden",
  "no-renderer",
  "detach",
] as const;
export type IdleObservationCase = (typeof IDLE_OBSERVATION_CASES)[number];

export type CaseStatus = "passed" | "failed" | "skipped" | "not-exercised";

export interface CaseRecord {
  status: CaseStatus;
  notes: string[];
  timings: Record<string, number | null>;
  error?: string;
}

/** Parse the comma-separated case selection; unknown names are an error. */
export function selectedCases(raw: string | undefined): IdleObservationCase[] {
  const names = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (names.length === 0) return [...IDLE_OBSERVATION_CASES];
  const unknown = names.filter(
    (name) => !(IDLE_OBSERVATION_CASES as readonly string[]).includes(name),
  );
  if (unknown.length > 0) throw new Error(`Unknown idle-observation cases: ${unknown.join(", ")}`);
  return IDLE_OBSERVATION_CASES.filter((name) => names.includes(name));
}

/**
 * Gaps between consecutive native session reads one view made, in ms.
 * `timestamps` must be in request order.
 */
export function readGaps(timestamps: readonly number[]): number[] {
  const gaps: number[] = [];
  for (let index = 1; index < timestamps.length; index += 1) {
    gaps.push(timestamps[index]! - timestamps[index - 1]!);
  }
  return gaps;
}

/** Reads per minute and the largest gap over one observation window. */
export function readCadence(
  timestamps: readonly number[],
  windowStart: number,
  windowEnd: number,
): { reads: number; perMinute: number; maxGapMs: number | null } {
  const inWindow = timestamps.filter((at) => at >= windowStart && at <= windowEnd);
  const minutes = Math.max((windowEnd - windowStart) / 60_000, 1 / 60);
  const gaps = readGaps(inWindow);
  return {
    reads: inWindow.length,
    perMinute: Math.round((inWindow.length / minutes) * 10) / 10,
    maxGapMs: gaps.length > 0 ? Math.max(...gaps) : null,
  };
}

/**
 * Read gaps inside a window, bucketed: back-to-back reads of one tick
 * (under 250 ms) are told apart from ticks at the baseline and backoff steps.
 */
export function gapHistogram(
  timestamps: readonly number[],
  windowStart: number,
  windowEnd: number,
): Record<string, number> {
  const buckets: Record<string, number> = {
    "<250ms": 0,
    "250ms-2s": 0,
    "2-6s": 0,
    "6-12s": 0,
    ">=12s": 0,
  };
  const inWindow = timestamps.filter((at) => at >= windowStart && at <= windowEnd);
  for (const gap of readGaps(inWindow)) {
    if (gap < 250) buckets["<250ms"]! += 1;
    else if (gap < 2_000) buckets["250ms-2s"]! += 1;
    else if (gap < 6_000) buckets["2-6s"]! += 1;
    else if (gap < 12_000) buckets["6-12s"]! += 1;
    else buckets[">=12s"]! += 1;
  }
  return buckets;
}

/**
 * The sidebar's environment icon colour is its activity state
 * (`EnvironmentItem.tsx`): blue pulses for working, amber pulses for
 * waiting, green for idle.
 */
export function sidebarActivityFromClass(className: string | null | undefined): string {
  const classes = new Set((className ?? "").split(/\s+/));
  if (classes.has("text-blue-500")) return "working";
  if (classes.has("text-amber-500")) return "waiting";
  if (classes.has("text-success")) return "idle";
  if (classes.has("text-muted-foreground")) return "stopped";
  return "unknown";
}

/** Whether a gateway frame may be dropped by the fault seam: never a transport control frame. */
export function droppableGatewayEvent(event: string): boolean {
  return event.length > 0 && !event.startsWith("gateway.") && !event.endsWith("-stream-connected");
}

/** The overall test outcome from per-case records: any failure fails the provider. */
export function failedCases(records: Readonly<Record<string, CaseRecord>>): string[] {
  return Object.entries(records)
    .filter(([, record]) => record.status === "failed")
    .map(([name, record]) => `${name}: ${record.error ?? "failed"}`);
}

/** Only result fields on fresh non-user rows can prove a shell emitted output. */
export function freshToolResults(
  messages: readonly { id: string; role: string; parts?: unknown }[],
  previous: ReadonlySet<string>,
): Array<{ toolOutput?: string; detailRef?: string }> {
  const results: Array<{ toolOutput?: string; detailRef?: string }> = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const part = value as Record<string, unknown>;
    if (part.type === "tool-invocation") {
      results.push({
        ...(typeof part.toolOutput === "string" ? { toolOutput: part.toolOutput } : {}),
        ...(typeof part.detailRef === "string" ? { detailRef: part.detailRef } : {}),
      });
    }
    // Descend through task groups, never through tool arguments or output metadata.
    if (part.type === "task-group") {
      visit(part.task);
      visit(part.childTools);
    }
  };
  for (const message of messages) {
    if (message.role === "user" || previous.has(message.id)) continue;
    visit(message.parts);
  }
  return results;
}

/** An echoed command/argument is not the line the shell was asked to emit. */
export function shellOutputContainsMarker(output: string | undefined, marker: string): boolean {
  return output?.split(/\r?\n/).some((line) => line.trim() === marker) ?? false;
}
