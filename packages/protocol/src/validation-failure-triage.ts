/**
 * Which failing tests in a review package's validation the branch caused.
 *
 * Validation runs every planned command once against the committed snapshot.
 * A failed aggregate command (`mise run test`, `playwright test`) says nothing
 * about which of its tests failed or why, so Verify used to read one red
 * command as one blocking failure, and a test already failing on the target
 * branch sent the pipeline round its loop until the iteration cap. The triage
 * names each failing test the command's output reports and classifies it from
 * data that already exists: the branch diff, the test's static import graph,
 * the runner's own retry verdict, the repository's flake registry, the target
 * branch's CI result and other pipelines validated on the same base. It never
 * runs a test.
 *
 * The package generator (`commands-review.ts`) writes it into the sealed
 * review package; the reference persisted on a workflow carries the compact
 * {@link ValidationFailureSummary}. Browser-safe.
 */

export const VALIDATION_FAILURE_TRIAGE_VERSION = 1;

/** Test runners whose failure output the triage reads. */
export const VALIDATION_FAILURE_RUNNERS = [
  "bun",
  "playwright",
  "vitest",
  "jest",
  "pytest",
] as const;
export type ValidationFailureRunner = (typeof VALIDATION_FAILURE_RUNNERS)[number];

/**
 * - `related`: the branch changed the test or code it reaches. Blocks unless a
 *   later commit repairs it.
 * - `unrelated`: established from evidence not to be this branch's doing.
 *   Never blocks on its own.
 * - `undetermined`: the evidence cannot decide (an end-to-end spec drives the
 *   whole app, or the import graph is incomplete); Verify judges it from the
 *   diff and the diagnostics.
 */
export const VALIDATION_FAILURE_VERDICTS = ["related", "unrelated", "undetermined"] as const;
export type ValidationFailureVerdict = (typeof VALIDATION_FAILURE_VERDICTS)[number];

/** Why a failure received its verdict. A failure lists every reason that applies. */
export const VALIDATION_FAILURE_REASONS = [
  /** The runner retried the test and it passed (Playwright's "flaky"). */
  "passed-on-retry",
  /**
   * An open row in the repository's flake registry names the test. Context
   * only: it never changes the verdict, so a registry row cannot excuse a
   * failure in code the branch changed.
   */
  "known-flaky",
  /** The target branch's CI failed the same test on the merge-base commit. */
  "failed-on-target-ci",
  /** Another pipeline on the same merge-base failed it without having changed it. */
  "failed-on-same-base",
  /** The branch changed the test file itself. */
  "test-file-changed",
  /**
   * The test, a preload or a test helper the test reaches through its own
   * helpers imports a changed file directly, or through one module between
   * them (at most {@link MAX_RELATED_IMPORT_HOPS} hops). Makes it `related`.
   */
  "imports-changed-file",
  /**
   * The test's static import graph reaches a changed file only further away
   * than {@link MAX_RELATED_IMPORT_HOPS} hops: through a widely shared
   * module, say. Leaves it `undetermined` for the verifier, never `unrelated`.
   */
  "reaches-changed-file-indirectly",
  /**
   * The test or a test helper it imports names, in code, a changed file, its
   * basename or a directory above it; or another module it loads names a
   * changed file's full path in code. Comments never count.
   */
  "references-changed-path",
  /** The import graph is complete and reaches no changed file. */
  "no-changed-dependency",
  /** The runner drives the application over a browser or process boundary. */
  "not-import-traceable",
  /** The output did not identify the test's file. */
  "test-file-unknown",
  /** The branch changed configuration every test depends on. */
  "global-change",
  /** An import could not be resolved, or the graph budget ran out. */
  "dependency-graph-incomplete",
] as const;
export type ValidationFailureReason = (typeof VALIDATION_FAILURE_REASONS)[number];

export interface TriagedValidationFailure {
  /** {@link validationFailureKey}: identical across runs, hosts and pipelines. */
  key: string;
  runner: ValidationFailureRunner;
  /** Repository-relative path of the test file, or null when it is unknown. */
  file: string | null;
  /** The test's full title as the runner reports it, without timings. */
  name: string;
  /** `flaky` failed at least once and then passed when the runner retried it. */
  outcome: "failed" | "flaky";
  verdict: ValidationFailureVerdict;
  reasons: ValidationFailureReason[];
  /**
   * For `imports-changed-file`/`reaches-changed-file-indirectly`/
   * `references-changed-path`: the changed file, or the changed directory a
   * test or helper named.
   */
  changedPath?: string;
  /**
   * For `imports-changed-file`/`reaches-changed-file-indirectly`: import edges
   * between the test's own code (the test file, or a helper it reaches
   * through other helpers) and {@link changedPath}; a bunfig preload counts
   * as one. 1 is a direct import.
   */
  changedPathHops?: number;
}

export interface TriagedValidationCommand {
  /** Exactly the package's `validation[].command` this entry explains. */
  command: string;
  failures: TriagedValidationFailure[];
  /** Failures beyond {@link MAX_TRIAGED_FAILURES_PER_COMMAND}, counted but not listed. */
  omittedFailures: number;
  /**
   * True when the command failed in a way the listed tests do not account
   * for: a type or lint error, a crash, a timeout, an unhandled error between
   * tests, or a runner summary whose count the parsed tests do not match.
   */
  unattributed: boolean;
  /** Why {@link unattributed} is true. */
  unattributedReason?: string;
}

export interface ValidationFailureTriage {
  version: typeof VALIDATION_FAILURE_TRIAGE_VERSION;
  /** `git merge-base HEAD origin/<target>`; null when Git could not answer. */
  mergeBase: string | null;
  commands: TriagedValidationCommand[];
  /** Evidence that was unavailable, such as the target branch's CI result. */
  limitations: string[];
}

/**
 * The compact triage a workflow record keeps on its review package reference
 * and validation history: enough for the loop breaker to compare rounds and
 * for another pipeline on the same merge-base to recognise a shared failure,
 * without copying test names into every snapshot.
 */
export interface ValidationFailureSummary {
  mergeBase: string | null;
  /** {@link validationFailureId} of every listed failure, sorted. */
  ids: string[];
  /** The subset of {@link ids} whose verdict was `related`. */
  relatedIds: string[];
  /** Independently unrelated failures; excludes shared-base derived verdicts. Absent on legacy summaries. */
  baseIds?: string[];
  related: number;
  unrelated: number;
  undetermined: number;
  /** Failed commands with {@link TriagedValidationCommand.unattributed}. */
  unattributedCommands: number;
  /** Set when {@link ids} was cut to {@link MAX_VALIDATION_FAILURE_SUMMARY_IDS}. */
  truncated?: boolean;
}

/**
 * How far, in import edges from the test's own code, a changed file may be
 * and still make the failure `related` on its own (to-do 6920). A direct
 * import is one hop; one module between them is two. A backend test's graph
 * holds over a thousand files, so any-depth matching made a change to one
 * widely shared module `related` to most of the repository's failures.
 */
export const MAX_RELATED_IMPORT_HOPS = 2;

export const MAX_TRIAGED_COMMANDS = 32;
export const MAX_TRIAGED_FAILURES_PER_COMMAND = 100;
export const MAX_TRIAGED_FAILURES = 200;
export const MAX_TRIAGE_TEXT_LENGTH = 1_000;
export const MAX_TRIAGE_LIMITATIONS = 20;
export const MAX_VALIDATION_FAILURE_SUMMARY_IDS = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TRIAGE_TEXT_LENGTH;
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isCommitOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^[a-f0-9]{40}$/.test(value));
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

/** Collapses whitespace and drops a trailing runner timing such as `[706.63ms]`. */
export function normalizeValidationTestName(name: string): string {
  return name
    .replace(/\s+\[\d+(?:\.\d+)?\s*m?s\]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The stable identity of one failing test: runner, file and title. */
export function validationFailureKey(
  runner: ValidationFailureRunner,
  file: string | null,
  name: string,
): string {
  return `${runner}:${file ?? "?"}::${normalizeValidationTestName(name)}`;
}

/**
 * A short, deterministic digest of a {@link validationFailureKey} (64-bit
 * FNV-1a, hex). Summaries store these instead of titles so a record's size
 * does not grow with test names.
 */
export function validationFailureId(key: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const bytes = new TextEncoder().encode(key);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

function isTriagedFailure(value: unknown): value is TriagedValidationFailure {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "key",
      "runner",
      "file",
      "name",
      "outcome",
      "verdict",
      "reasons",
      "changedPath",
      "changedPathHops",
    ]) &&
    isBoundedText(value.key) &&
    VALIDATION_FAILURE_RUNNERS.includes(value.runner as ValidationFailureRunner) &&
    (value.file === null || isBoundedText(value.file)) &&
    isBoundedText(value.name) &&
    (value.outcome === "failed" || value.outcome === "flaky") &&
    VALIDATION_FAILURE_VERDICTS.includes(value.verdict as ValidationFailureVerdict) &&
    Array.isArray(value.reasons) &&
    value.reasons.length <= VALIDATION_FAILURE_REASONS.length &&
    value.reasons.every((reason) =>
      VALIDATION_FAILURE_REASONS.includes(reason as ValidationFailureReason),
    ) &&
    (value.changedPath === undefined || isBoundedText(value.changedPath)) &&
    (value.changedPathHops === undefined ||
      (Number.isSafeInteger(value.changedPathHops) && (value.changedPathHops as number) >= 1))
  );
}

function isTriagedCommand(value: unknown): value is TriagedValidationCommand {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "command",
      "failures",
      "omittedFailures",
      "unattributed",
      "unattributedReason",
    ]) &&
    typeof value.command === "string" &&
    value.command.length > 0 &&
    Array.isArray(value.failures) &&
    value.failures.length <= MAX_TRIAGED_FAILURES_PER_COMMAND &&
    value.failures.every(isTriagedFailure) &&
    isCount(value.omittedFailures) &&
    typeof value.unattributed === "boolean" &&
    (value.unattributedReason === undefined || isBoundedText(value.unattributedReason))
  );
}

export function isValidationFailureTriage(value: unknown): value is ValidationFailureTriage {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["version", "mergeBase", "commands", "limitations"]) &&
    value.version === VALIDATION_FAILURE_TRIAGE_VERSION &&
    isCommitOrNull(value.mergeBase) &&
    Array.isArray(value.commands) &&
    value.commands.length <= MAX_TRIAGED_COMMANDS &&
    value.commands.every(isTriagedCommand) &&
    value.commands.reduce((total, command) => total + command.failures.length, 0) <=
      MAX_TRIAGED_FAILURES &&
    Array.isArray(value.limitations) &&
    value.limitations.length <= MAX_TRIAGE_LIMITATIONS &&
    value.limitations.every(isBoundedText)
  );
}

function isFailureIdList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_VALIDATION_FAILURE_SUMMARY_IDS &&
    value.every((id) => typeof id === "string" && /^[a-f0-9]{16}$/.test(id))
  );
}

export function isValidationFailureSummary(value: unknown): value is ValidationFailureSummary {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "mergeBase",
      "ids",
      "relatedIds",
      "baseIds",
      "related",
      "unrelated",
      "undetermined",
      "unattributedCommands",
      "truncated",
    ]) &&
    isCommitOrNull(value.mergeBase) &&
    isFailureIdList(value.ids) &&
    isFailureIdList(value.relatedIds) &&
    (value.baseIds === undefined ||
      (isFailureIdList(value.baseIds) &&
        value.baseIds.every(
          (id) =>
            (value.ids as string[]).includes(id) && !(value.relatedIds as string[]).includes(id),
        ))) &&
    isCount(value.related) &&
    isCount(value.unrelated) &&
    isCount(value.undetermined) &&
    isCount(value.unattributedCommands) &&
    (value.truncated === undefined || value.truncated === true)
  );
}

export function summarizeValidationFailureTriage(
  triage: ValidationFailureTriage,
): ValidationFailureSummary {
  const failures = triage.commands.flatMap((command) => command.failures);
  const ids = [...new Set(failures.map((failure) => validationFailureId(failure.key)))].sort();
  const relatedIds = [
    ...new Set(
      failures
        .filter((failure) => failure.verdict === "related")
        .map((failure) => validationFailureId(failure.key)),
    ),
  ].sort();
  const omitted = triage.commands.some((command) => command.omittedFailures > 0);
  const truncated = omitted || ids.length > MAX_VALIDATION_FAILURE_SUMMARY_IDS;
  return {
    mergeBase: triage.mergeBase,
    ids: ids.slice(0, MAX_VALIDATION_FAILURE_SUMMARY_IDS),
    relatedIds: relatedIds.slice(0, MAX_VALIDATION_FAILURE_SUMMARY_IDS),
    baseIds: [
      ...new Set(
        failures
          .filter(
            (failure) =>
              failure.verdict === "unrelated" && !failure.reasons.includes("failed-on-same-base"),
          )
          .map((failure) => validationFailureId(failure.key)),
      ),
    ]
      .sort()
      .filter(
        (id) =>
          ids.slice(0, MAX_VALIDATION_FAILURE_SUMMARY_IDS).includes(id) && !relatedIds.includes(id),
      ),
    related: failures.filter((failure) => failure.verdict === "related").length,
    unrelated: failures.filter((failure) => failure.verdict === "unrelated").length,
    undetermined: failures.filter((failure) => failure.verdict === "undetermined").length,
    // Omitted failures were never classified, so they count against the
    // command as surely as an unparsed crash does.
    unattributedCommands: triage.commands.filter(
      (command) => command.unattributed || command.omittedFailures > 0,
    ).length,
    ...(truncated ? { truncated: true as const } : {}),
  };
}

/**
 * Failures another pipeline on `mergeBase` recorded without having caused
 * them independently. Legacy summaries lack provenance and supply no evidence.
 */
export function failuresSharedOnBase(
  mergeBase: string,
  summaries: Iterable<ValidationFailureSummary>,
): Set<string> {
  const shared = new Set<string>();
  for (const summary of summaries) {
    if (summary.mergeBase !== mergeBase) continue;
    for (const id of summary.baseIds ?? []) shared.add(id);
  }
  return shared;
}
