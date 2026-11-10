import { PI_FAKE_MODEL_REF } from "./idle-observation-fake-pi";
/**
 * Pure helpers for `idle-observation-live.spec.ts`, kept apart so they are
 * unit-tested without a profile or a browser.
 */

export const IDLE_OBSERVATION_CASES = [
  "missed-final",
  "bridge-restart",
  "async-question",
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
 * The backend's session-invalidation counters as `get_recurring_work_diagnostics`
 * reports them (`sessionInvalidations.byScope`): counts per content-free cause,
 * per platform, plus `environment` for announcements that name no session.
 */
export type InvalidationCounts = Record<string, Record<string, number> | undefined>;

/**
 * What one provider's views were told to re-read during a window, by cause
 * (todo 0049 task 4): the difference of two samples for `scope` and for the
 * environment-wide announcements every view of the environment also honours.
 * Causes that did not move are omitted; the sum is under `total`.
 */
export function invalidationCauseDelta(
  before: InvalidationCounts | undefined,
  after: InvalidationCounts | undefined,
  scope: string,
): Record<string, number> {
  const delta: Record<string, number> = {};
  let total = 0;
  for (const [name, key] of [
    [scope, scope],
    ["environment", "environment:"],
  ] as const) {
    const end = after?.[name] ?? {};
    const start = before?.[name] ?? {};
    for (const [cause, count] of Object.entries(end)) {
      const moved = count - (start[cause] ?? 0);
      if (moved <= 0) continue;
      const label = name === scope ? cause : `${key}${cause}`;
      delta[label] = moved;
      total += moved;
    }
  }
  return { ...delta, total };
}

/**
 * The backend's per-section discovery announcement counters
 * (`sessionInvalidations.discoveryRenewals`, todo 7530): per scope, per
 * section, a count and the content-free value paths that changed.
 */
export type DiscoveryRenewalCounts = Record<
  string,
  Record<string, { count?: number; changed?: Record<string, number> } | undefined> | undefined
>;

/**
 * Which discovery sections of `scope` announced during a window, and which
 * of their value paths changed: `{ runtime: { count: 2, changed: {...} } }`.
 * Sections that did not move are omitted.
 */
export function discoveryRenewalDelta(
  before: DiscoveryRenewalCounts | undefined,
  after: DiscoveryRenewalCounts | undefined,
  scope: string,
): Record<string, { count: number; changed: Record<string, number> }> {
  const delta: Record<string, { count: number; changed: Record<string, number> }> = {};
  for (const [section, end] of Object.entries(after?.[scope] ?? {})) {
    const start = before?.[scope]?.[section];
    const count = (end?.count ?? 0) - (start?.count ?? 0);
    if (count <= 0) continue;
    const changed: Record<string, number> = {};
    for (const [path, total] of Object.entries(end?.changed ?? {})) {
      const moved = total - (start?.changed?.[path] ?? 0);
      if (moved > 0) changed[path] = moved;
    }
    delta[section] = { count, changed };
  }
  return delta;
}

export type SidebarActivity = "working" | "waiting" | "idle" | "stopped" | "unknown";

/**
 * The activity a sidebar row shows, from its `EnvironmentStatusMarker`'s
 * `data-state`: a stopped environment's `inactive` reads as `stopped`, and a
 * missing marker or an unrecognised state as `unknown`. Colour classes are a
 * design choice and are deliberately not read.
 */
export function sidebarActivityFromMarkerState(state: string | null | undefined): SidebarActivity {
  if (state === "working" || state === "waiting" || state === "idle") return state;
  if (state === "inactive") return "stopped";
  return "unknown";
}

/**
 * Runs in the page (Playwright serialises it, so it must not reference
 * anything outside its body). The `data-state` of the status marker in the
 * local sidebar row labelled `environmentName`, or null when there is no such
 * row or the row shows no marker (a spinner while starting, stopping or
 * deleting, or multi-select). Each search stops at the label's own
 * `role="button"` region, so a row without a marker never reports a
 * neighbour's, and a same-named label outside a row is passed over.
 */
export function environmentMarkerState(environmentName: string): string | null {
  for (const label of Array.from(document.querySelectorAll("span[id]"))) {
    if (label.textContent !== environmentName) continue;
    const marker = label
      .closest('[role="button"]')
      ?.querySelector('[data-testid="environment-status-marker"]');
    if (marker) return marker.getAttribute("data-state");
  }
  return null;
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

/**
 * `toolName:toolState` of every tool call on fresh non-user rows, in order,
 * and `subagent:toolState` for every sub-agent card (Codex renders a child as
 * a `subagent` part, not a tool call): content-free evidence of what a
 * command still running at the end of its turn looks like afterwards, and of
 * whether a child was left running (todo 0049 tasks 3 and 8).
 */
export function freshToolStates(
  messages: readonly { id: string; role: string; parts?: unknown }[],
  previous: ReadonlySet<string>,
): string[] {
  const states: string[] = [];
  for (const message of messages) {
    if (message.role === "user" || previous.has(message.id) || !Array.isArray(message.parts)) {
      continue;
    }
    for (const part of message.parts as Array<Record<string, unknown>>) {
      if (part?.type === "subagent") states.push(`subagent:${String(part.toolState ?? "?")}`);
      if (part?.type !== "tool-invocation") continue;
      // A command its turn ended around has no state, only the flag (to-do 7522).
      const state = part.toolLeftRunning === true ? "left-running" : (part.toolState ?? "?");
      states.push(`${String(part.toolName ?? "?")}:${String(state)}`);
    }
  }
  return states;
}

/** An echoed command/argument is not the line the shell was asked to emit. */
export function shellOutputContainsMarker(output: string | undefined, marker: string): boolean {
  return output?.split(/\r?\n/).some((line) => line.trim() === marker) ?? false;
}

export interface BackgroundTaskEvidence {
  id: string;
  status: string;
  outputFile?: string;
}

/**
 * Output files of background tasks that started after `previous` and have
 * completed (todo 0049 task 2). Claude never puts a backgrounded command's
 * stdout into a tool result: the call's result only says the command moved to
 * the background, and the task notification carries the output as a file
 * (`outputFile`), which the renderer shows as a link on the task card. A
 * completed task's file is the output the provider really emits.
 */
export function completedTaskOutputFiles(
  tasks: readonly BackgroundTaskEvidence[] | undefined,
  previous: ReadonlySet<string>,
): string[] {
  return (tasks ?? [])
    .filter((task) => !previous.has(task.id) && task.status === "completed")
    .flatMap((task) => (task.outputFile ? [task.outputFile] : []));
}

/**
 * Which evidence proved a background command's output reached the view:
 * a fresh tool result, else a completed task's output file, else none.
 * Content-free: callers record the kind, never the text.
 */
export function backgroundOutputEvidence(
  toolResultHasMarker: boolean,
  outputFiles: readonly string[],
  readOutputFile: (file: string) => string | undefined,
  marker: string,
): "tool-result" | "output-file" | "none" {
  if (toolResultHasMarker) return "tool-result";
  for (const file of outputFiles) {
    if (shellOutputContainsMarker(readOutputFile(file), marker)) return "output-file";
  }
  return "none";
}

/** Fallback polling can finish a turn even when the observation stream never recovers. */
export function requireRecoveredBackoff(backoffMs: number | null): number {
  if (backoffMs === null)
    throw new Error("observation stream did not recover backoff after the turn");
  return backoffMs;
}

/** Fake Pi runs must never select a billed provider from an environment override. */
export function idleObservationModel(
  platform: string,
  fake: boolean,
  override?: string,
): string | undefined {
  return fake && platform === "pi" ? PI_FAKE_MODEL_REF : override;
}

export function asyncQuestionPrompt(title: string, word: string): string {
  return (
    `Use your request_user_input_async tool to ask me one question, "${title}", ` +
    "with the options IDLEQA_ALPHA and IDLEQA_BETA. Do not wait for my answer: " +
    `right after asking, reply with exactly ${word} and nothing else. ` +
    "After I answer, reply with exactly CODEWORD_CHOSEN=<selected option> and nothing else, replacing <selected option> with my selected option."
  );
}
