/**
 * The typed Address → Verify handoff of the Build Pipeline.
 *
 * An Address turn opens a `fix-result` workflow result slot, as Multi Review's
 * fix step does. The accepted result is copied, bounded, onto the Address
 * session (`PipelineSession.fixResult`), where the Verify prompt reads it as an
 * evidence frame and the pipeline inspector shows it.
 *
 * `PipelineSession.addressReportKind` is the recorded marker that a session was
 * opened with that slot. An Address session without it was started before the
 * typed handoff existed (or by a provider path with no result transport), and
 * Verify reads that session's last assistant text instead.
 */

/** The result kind an Address session submits; the only value of the marker today. */
export const PIPELINE_ADDRESS_REPORT_KIND = "fix-result" as const;
export type PipelineAddressReportKind = typeof PIPELINE_ADDRESS_REPORT_KIND;

/** One check the Address stage reports it ran. */
export interface PipelineFixResultCommand {
  command: string;
  result: "passed" | "failed";
  summary: string;
}

/** Entries the session bounds dropped, per list. Absent when nothing was dropped. */
export interface PipelineFixResultOmissions {
  filesChanged?: number;
  commandsRun?: number;
  notes?: number;
  limitations?: number;
}

/**
 * The accepted `fix-result` of one Address session, bounded by
 * {@link PIPELINE_FIX_RESULT_LIMITS}. The fields are the workflow result's; a
 * string over its limit ends in `…`, and a list over its limit keeps its first
 * entries (failed commands before passed ones) and counts the rest in
 * {@link omitted}.
 */
export interface PipelineFixResult {
  complete: boolean;
  summary: string;
  filesChanged: string[];
  commandsRun: PipelineFixResultCommand[];
  notes: string[];
  limitations: string[];
  omitted?: PipelineFixResultOmissions;
}

/**
 * Bounds of the copy kept on the session and rendered into the Verify prompt.
 * The worst case is about 50,000 characters; a real report is a few hundred.
 */
export const PIPELINE_FIX_RESULT_LIMITS = Object.freeze({
  summaryLength: 4_000,
  filesChanged: 48,
  pathLength: 300,
  commandsRun: 20,
  commandLength: 500,
  commandSummaryLength: 500,
  notes: 10,
  limitations: 10,
  entryLength: 600,
});

type FixResultInput = Omit<PipelineFixResult, "omitted">;

function truncated(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/**
 * Copies an accepted fix result into the session's bounded shape. The input is
 * a result the workflow-result contract already accepted; this only shortens it.
 */
export function boundPipelineFixResult(value: FixResultInput): PipelineFixResult {
  const limits = PIPELINE_FIX_RESULT_LIMITS;
  const omitted: PipelineFixResultOmissions = {};
  const list = <T>(
    entries: readonly T[],
    limit: number,
    key: keyof PipelineFixResultOmissions,
  ): T[] => {
    if (entries.length > limit) omitted[key] = entries.length - limit;
    return entries.slice(0, limit);
  };
  // A failed check is the evidence Verify most needs, so a long list keeps
  // every failure it can before any pass, in the order the stage reported.
  const failed = value.commandsRun.filter((entry) => entry.result === "failed");
  const kept = new Set(
    [...failed, ...value.commandsRun.filter((entry) => entry.result !== "failed")].slice(
      0,
      limits.commandsRun,
    ),
  );
  if (value.commandsRun.length > limits.commandsRun) {
    omitted.commandsRun = value.commandsRun.length - limits.commandsRun;
  }
  const result: PipelineFixResult = {
    complete: value.complete,
    summary: truncated(value.summary, limits.summaryLength),
    filesChanged: list(value.filesChanged, limits.filesChanged, "filesChanged").map((path) =>
      truncated(path, limits.pathLength),
    ),
    commandsRun: value.commandsRun
      .filter((entry) => kept.has(entry))
      .map((entry) => ({
        command: truncated(entry.command, limits.commandLength),
        result: entry.result,
        summary: truncated(entry.summary, limits.commandSummaryLength),
      })),
    notes: list(value.notes, limits.notes, "notes").map((note) =>
      truncated(note, limits.entryLength),
    ),
    limitations: list(value.limitations, limits.limitations, "limitations").map((limitation) =>
      truncated(limitation, limits.entryLength),
    ),
  };
  if (Object.keys(omitted).length > 0) result.omitted = omitted;
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function boundedText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length <= limit;
}

function boundedTextList(value: unknown, count: number, length: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= count &&
    value.every((entry) => boundedText(entry, length))
  );
}

function isOmissions(value: unknown): value is PipelineFixResultOmissions {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["filesChanged", "commandsRun", "notes", "limitations"]) &&
    Object.values(value).every((count) => Number.isSafeInteger(count) && (count as number) > 0)
  );
}

/** Validates a stored {@link PipelineFixResult} against its bounds. */
export function isPipelineFixResult(value: unknown): value is PipelineFixResult {
  const limits = PIPELINE_FIX_RESULT_LIMITS;
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "complete",
      "summary",
      "filesChanged",
      "commandsRun",
      "notes",
      "limitations",
      "omitted",
    ]) &&
    typeof value.complete === "boolean" &&
    boundedText(value.summary, limits.summaryLength) &&
    boundedTextList(value.filesChanged, limits.filesChanged, limits.pathLength) &&
    Array.isArray(value.commandsRun) &&
    value.commandsRun.length <= limits.commandsRun &&
    value.commandsRun.every(
      (entry) =>
        isRecord(entry) &&
        hasOnlyKeys(entry, ["command", "result", "summary"]) &&
        boundedText(entry.command, limits.commandLength) &&
        (entry.result === "passed" || entry.result === "failed") &&
        boundedText(entry.summary, limits.commandSummaryLength),
    ) &&
    boundedTextList(value.notes, limits.notes, limits.entryLength) &&
    boundedTextList(value.limitations, limits.limitations, limits.entryLength) &&
    (value.omitted === undefined || isOmissions(value.omitted))
  );
}
