/**
 * A Build Pipeline's key information: the running brief a reader opens from
 * the pipeline header to see where the ticket stands without reading every
 * transcript.
 *
 * The Build stage writes most of it (the problem or objective, context,
 * solution, what was done, decisions, what was not done and the tests run).
 * Address adds how each review issue was handled, and Verify records each
 * round's verdict. The stages write through the `get_key_information` and
 * `update_key_information` agent tools; the backend also records each
 * round's review issues and verification verdict itself, so those sections
 * are never empty just because a stage did not call the tool.
 *
 * Only the backend writes the record, always through
 * {@link applyKeyInformationPatch} or the `record…` helpers, which bound
 * every field. The snapshot guard ({@link isBuildPipelineKeyInformation})
 * checks the same bounds, because a rejected field fails the whole pipeline
 * snapshot.
 */

/** Whether the ticket solves a problem or completes an objective. */
export const KEY_INFORMATION_FRAMINGS = ["problem", "objective"] as const;
export type KeyInformationFraming = (typeof KEY_INFORMATION_FRAMINGS)[number];

export const KEY_INFORMATION_TEST_RESULTS = ["passed", "failed", "skipped", "not-run"] as const;
export type KeyInformationTestResult = (typeof KEY_INFORMATION_TEST_RESULTS)[number];

export const KEY_INFORMATION_ISSUE_STATUSES = [
  "open",
  "resolved",
  "partially-resolved",
  "deferred",
  "wont-fix",
] as const;
export type KeyInformationIssueStatus = (typeof KEY_INFORMATION_ISSUE_STATUSES)[number];

/** The stage that wrote an update; `system` is the backend's own record. */
export const KEY_INFORMATION_AUTHORS = [
  "build",
  "fix",
  "review",
  "address",
  "verify",
  "pr",
  "resolve-conflicts",
  "system",
] as const;
export type KeyInformationAuthor = (typeof KEY_INFORMATION_AUTHORS)[number];

/** The sections an update can name, in display order. */
export const KEY_INFORMATION_SECTIONS = [
  "framing",
  "statement",
  "context",
  "solution",
  "workDone",
  "decisions",
  "notDone",
  "tests",
  "issues",
  "verification",
] as const;
export type KeyInformationSection = (typeof KEY_INFORMATION_SECTIONS)[number];

export interface KeyInformationDecisionOption {
  option: string;
  pros: string[];
  cons: string[];
}

export interface KeyInformationDecision {
  /** What had to be decided. */
  decision: string;
  options: KeyInformationDecisionOption[];
  /** The option suggested and taken. */
  chosen: string;
  rationale?: string;
}

export interface KeyInformationTest {
  /** The command or test name. */
  name: string;
  result: KeyInformationTestResult;
  details?: string;
}

export interface KeyInformationIssue {
  /** Zero-based pipeline round the issue was reported in. */
  round: number;
  issue: string;
  severity?: string;
  /** How it was solved, or why not. Empty until Address handles it. */
  resolution: string;
  status: KeyInformationIssueStatus;
}

export interface KeyInformationCheck {
  check: string;
  passed: boolean;
  details?: string;
}

export interface KeyInformationVerification {
  /** Zero-based pipeline round. */
  round: number;
  /** Absent while the round's verdict is not in yet. */
  passed?: boolean;
  summary: string;
  checks: KeyInformationCheck[];
}

export interface KeyInformationUpdate {
  at: string;
  author: KeyInformationAuthor;
  round: number;
  sections: KeyInformationSection[];
}

export interface BuildPipelineKeyInformation {
  framing: KeyInformationFraming;
  /** The problem being solved, or the objective being completed. */
  statement?: string;
  context?: string;
  solution?: string;
  workDone: string[];
  decisions: KeyInformationDecision[];
  notDone: string[];
  tests: KeyInformationTest[];
  issues: KeyInformationIssue[];
  verifications: KeyInformationVerification[];
  updatedAt: string;
  /** Newest last, at most {@link KEY_INFORMATION_LIMITS.updates}. */
  updates: KeyInformationUpdate[];
}

/**
 * Bounds of every field. The worst case is roughly 200 KB; a real brief is a
 * few kilobytes.
 */
export const KEY_INFORMATION_LIMITS = Object.freeze({
  proseLength: 4_000,
  itemLength: 600,
  listItems: 30,
  decisions: 12,
  decisionLength: 400,
  options: 6,
  optionLength: 300,
  prosCons: 6,
  rationaleLength: 1_000,
  tests: 40,
  testNameLength: 400,
  issues: 60,
  issueLength: 400,
  severityLength: 40,
  resolutionLength: 1_000,
  verifications: 20,
  summaryLength: 2_000,
  checks: 30,
  checkLength: 400,
  updates: 30,
  maxRound: 1_000,
});

/**
 * One update: each named field replaces its section, an omitted field leaves
 * it alone. `issues` replaces only the current round's issues, and
 * `verification` replaces only the current round's verification, so earlier
 * rounds are kept.
 */
export interface KeyInformationPatch {
  framing?: KeyInformationFraming;
  statement?: string;
  context?: string;
  solution?: string;
  workDone?: string[];
  decisions?: KeyInformationDecision[];
  notDone?: string[];
  tests?: KeyInformationTest[];
  issues?: Array<Omit<KeyInformationIssue, "round">>;
  verification?: Omit<KeyInformationVerification, "round">;
}

export function emptyKeyInformation(at: string): BuildPipelineKeyInformation {
  return {
    framing: "problem",
    workDone: [],
    decisions: [],
    notDone: [],
    tests: [],
    issues: [],
    verifications: [],
    updatedAt: at,
    updates: [],
  };
}

function bounded(value: string, limit: number): string {
  const trimmed = value.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

function boundedOptional(value: string | undefined, limit: number): string | undefined {
  if (value === undefined) return undefined;
  const text = bounded(value, limit);
  return text.length > 0 ? text : undefined;
}

function boundedList(values: readonly string[], items: number, length: number): string[] {
  return values
    .map((value) => bounded(value, length))
    .filter((value) => value.length > 0)
    .slice(0, items);
}

function clampRound(round: number): number {
  return Math.min(KEY_INFORMATION_LIMITS.maxRound, Math.max(0, Math.trunc(round)));
}

function boundDecision(value: KeyInformationDecision): KeyInformationDecision {
  const limits = KEY_INFORMATION_LIMITS;
  const rationale = boundedOptional(value.rationale, limits.rationaleLength);
  return {
    decision: bounded(value.decision, limits.decisionLength),
    options: value.options.slice(0, limits.options).map((option) => ({
      option: bounded(option.option, limits.optionLength),
      pros: boundedList(option.pros, limits.prosCons, limits.optionLength),
      cons: boundedList(option.cons, limits.prosCons, limits.optionLength),
    })),
    chosen: bounded(value.chosen, limits.optionLength),
    ...(rationale ? { rationale } : {}),
  };
}

function boundTest(value: KeyInformationTest): KeyInformationTest {
  const details = boundedOptional(value.details, KEY_INFORMATION_LIMITS.itemLength);
  return {
    name: bounded(value.name, KEY_INFORMATION_LIMITS.testNameLength),
    result: value.result,
    ...(details ? { details } : {}),
  };
}

function boundIssue(value: KeyInformationIssue): KeyInformationIssue {
  const limits = KEY_INFORMATION_LIMITS;
  const severity = boundedOptional(value.severity, limits.severityLength);
  return {
    round: clampRound(value.round),
    issue: bounded(value.issue, limits.issueLength),
    ...(severity ? { severity } : {}),
    resolution: bounded(value.resolution, limits.resolutionLength),
    status: value.status,
  };
}

function boundCheck(value: KeyInformationCheck): KeyInformationCheck {
  const details = boundedOptional(value.details, KEY_INFORMATION_LIMITS.itemLength);
  return {
    check: bounded(value.check, KEY_INFORMATION_LIMITS.checkLength),
    passed: value.passed,
    ...(details ? { details } : {}),
  };
}

function boundVerification(value: KeyInformationVerification): KeyInformationVerification {
  return {
    round: clampRound(value.round),
    ...(typeof value.passed === "boolean" ? { passed: value.passed } : {}),
    summary: bounded(value.summary, KEY_INFORMATION_LIMITS.summaryLength),
    checks: value.checks.slice(0, KEY_INFORMATION_LIMITS.checks).map(boundCheck),
  };
}

/** Issues sorted by round, newest rounds kept when the list is over its bound. */
function boundIssues(issues: KeyInformationIssue[]): KeyInformationIssue[] {
  const sorted = issues.map(boundIssue).sort((left, right) => left.round - right.round);
  return sorted.slice(Math.max(0, sorted.length - KEY_INFORMATION_LIMITS.issues));
}

function boundVerifications(entries: KeyInformationVerification[]): KeyInformationVerification[] {
  const sorted = entries.map(boundVerification).sort((left, right) => left.round - right.round);
  return sorted.slice(Math.max(0, sorted.length - KEY_INFORMATION_LIMITS.verifications));
}

function withUpdate(
  next: BuildPipelineKeyInformation,
  update: KeyInformationUpdate,
): BuildPipelineKeyInformation {
  next.updatedAt = update.at;
  next.updates = [...next.updates, update].slice(-KEY_INFORMATION_LIMITS.updates);
  return next;
}

function copyOf(
  current: BuildPipelineKeyInformation | undefined,
  at: string,
): BuildPipelineKeyInformation {
  return current ? structuredClone(current) : emptyKeyInformation(at);
}

/** The sections a patch names, in display order. */
export function keyInformationPatchSections(patch: KeyInformationPatch): KeyInformationSection[] {
  return KEY_INFORMATION_SECTIONS.filter((section) => patch[section] !== undefined);
}

/**
 * Applies one stage's update to the current record (or an empty one),
 * bounding every field. Returns a new record; the input is not modified.
 */
export function applyKeyInformationPatch(
  current: BuildPipelineKeyInformation | undefined,
  patch: KeyInformationPatch,
  context: { at: string; author: KeyInformationAuthor; round: number },
): BuildPipelineKeyInformation {
  const limits = KEY_INFORMATION_LIMITS;
  const round = clampRound(context.round);
  const next = copyOf(current, context.at);
  if (patch.framing !== undefined) next.framing = patch.framing;
  for (const field of ["statement", "context", "solution"] as const) {
    const value = patch[field];
    if (value === undefined) continue;
    const text = boundedOptional(value, limits.proseLength);
    if (text) next[field] = text;
    else delete next[field];
  }
  if (patch.workDone)
    next.workDone = boundedList(patch.workDone, limits.listItems, limits.itemLength);
  if (patch.notDone) next.notDone = boundedList(patch.notDone, limits.listItems, limits.itemLength);
  if (patch.decisions)
    next.decisions = patch.decisions.slice(0, limits.decisions).map(boundDecision);
  if (patch.tests) next.tests = patch.tests.slice(0, limits.tests).map(boundTest);
  if (patch.issues) {
    next.issues = boundIssues([
      ...next.issues.filter((entry) => entry.round !== round),
      ...patch.issues.slice(0, limits.issues).map((entry) => ({ ...entry, round })),
    ]);
  }
  if (patch.verification) {
    const previous = next.verifications.find((entry) => entry.round === round);
    const passed = patch.verification.passed ?? previous?.passed;
    next.verifications = boundVerifications([
      ...next.verifications.filter((entry) => entry.round !== round),
      {
        round,
        ...(typeof passed === "boolean" ? { passed } : {}),
        summary: patch.verification.summary,
        checks: patch.verification.checks,
      },
    ]);
  }
  return withUpdate(next, {
    at: context.at,
    author: context.author,
    round,
    sections: keyInformationPatchSections(patch),
  });
}

/**
 * Records the issues a round's accepted review reported, as open issues,
 * unless the round already has issues a stage has started resolving: a
 * repeated review of the same round replaces only untouched entries.
 */
export function recordKeyInformationReviewIssues(
  current: BuildPipelineKeyInformation | undefined,
  issues: ReadonlyArray<{ title: string; severity?: string }>,
  context: { at: string; round: number },
): BuildPipelineKeyInformation {
  const round = clampRound(context.round);
  const next = copyOf(current, context.at);
  const existing = next.issues.filter((entry) => entry.round === round);
  if (existing.some((entry) => entry.status !== "open" || entry.resolution.length > 0)) {
    return next;
  }
  next.issues = boundIssues([
    ...next.issues.filter((entry) => entry.round !== round),
    ...issues.slice(0, KEY_INFORMATION_LIMITS.issues).map((issue) => ({
      round,
      issue: issue.title,
      ...(issue.severity ? { severity: issue.severity } : {}),
      resolution: "",
      status: "open" as const,
    })),
  ]);
  return withUpdate(next, { at: context.at, author: "system", round, sections: ["issues"] });
}

/**
 * Records a round's verification verdict. The verdict is authoritative for
 * `passed`; a summary or checks Verify already wrote through the tool are
 * kept, and otherwise come from the verdict's rationale and criteria.
 */
export function recordKeyInformationVerdict(
  current: BuildPipelineKeyInformation | undefined,
  verdict: {
    passed: boolean;
    rationale: string;
    criteria: ReadonlyArray<{ text: string; status: string; evidence: string }>;
  },
  context: { at: string; round: number },
): BuildPipelineKeyInformation {
  const round = clampRound(context.round);
  const next = copyOf(current, context.at);
  const previous = next.verifications.find((entry) => entry.round === round);
  const checks =
    previous && previous.checks.length > 0
      ? previous.checks
      : verdict.criteria
          .filter((criterion) => criterion.status !== "not-checked")
          .map((criterion) => ({
            check: criterion.text,
            passed: criterion.status === "passed",
            ...(criterion.evidence ? { details: criterion.evidence } : {}),
          }));
  next.verifications = boundVerifications([
    ...next.verifications.filter((entry) => entry.round !== round),
    {
      round,
      passed: verdict.passed,
      summary: previous?.summary || verdict.rationale,
      checks,
    },
  ]);
  return withUpdate(next, { at: context.at, author: "system", round, sections: ["verification"] });
}

// ---------------------------------------------------------------------------
// Snapshot guard

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length <= limit;
}

function isOptionalText(value: unknown, limit: number): boolean {
  return value === undefined || isText(value, limit);
}

function isTextList(value: unknown, items: number, length: number): value is string[] {
  return (
    Array.isArray(value) && value.length <= items && value.every((entry) => isText(entry, length))
  );
}

function isRound(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= KEY_INFORMATION_LIMITS.maxRound
  );
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function isDecision(value: unknown): boolean {
  const limits = KEY_INFORMATION_LIMITS;
  return (
    isRecord(value) &&
    isText(value.decision, limits.decisionLength) &&
    isText(value.chosen, limits.optionLength) &&
    isOptionalText(value.rationale, limits.rationaleLength) &&
    Array.isArray(value.options) &&
    value.options.length <= limits.options &&
    value.options.every(
      (option) =>
        isRecord(option) &&
        isText(option.option, limits.optionLength) &&
        isTextList(option.pros, limits.prosCons, limits.optionLength) &&
        isTextList(option.cons, limits.prosCons, limits.optionLength),
    )
  );
}

function isTest(value: unknown): boolean {
  return (
    isRecord(value) &&
    isText(value.name, KEY_INFORMATION_LIMITS.testNameLength) &&
    oneOf(KEY_INFORMATION_TEST_RESULTS, value.result) &&
    isOptionalText(value.details, KEY_INFORMATION_LIMITS.itemLength)
  );
}

function isIssue(value: unknown): boolean {
  const limits = KEY_INFORMATION_LIMITS;
  return (
    isRecord(value) &&
    isRound(value.round) &&
    isText(value.issue, limits.issueLength) &&
    isOptionalText(value.severity, limits.severityLength) &&
    isText(value.resolution, limits.resolutionLength) &&
    oneOf(KEY_INFORMATION_ISSUE_STATUSES, value.status)
  );
}

function isVerification(value: unknown): boolean {
  const limits = KEY_INFORMATION_LIMITS;
  return (
    isRecord(value) &&
    isRound(value.round) &&
    (value.passed === undefined || typeof value.passed === "boolean") &&
    isText(value.summary, limits.summaryLength) &&
    Array.isArray(value.checks) &&
    value.checks.length <= limits.checks &&
    value.checks.every(
      (check) =>
        isRecord(check) &&
        isText(check.check, limits.checkLength) &&
        typeof check.passed === "boolean" &&
        isOptionalText(check.details, limits.itemLength),
    )
  );
}

function isUpdate(value: unknown): boolean {
  return (
    isRecord(value) &&
    isIsoDate(value.at) &&
    oneOf(KEY_INFORMATION_AUTHORS, value.author) &&
    isRound(value.round) &&
    Array.isArray(value.sections) &&
    value.sections.length <= KEY_INFORMATION_SECTIONS.length &&
    value.sections.every((section) => oneOf(KEY_INFORMATION_SECTIONS, section))
  );
}

export function isBuildPipelineKeyInformation(
  value: unknown,
): value is BuildPipelineKeyInformation {
  const limits = KEY_INFORMATION_LIMITS;
  return (
    isRecord(value) &&
    oneOf(KEY_INFORMATION_FRAMINGS, value.framing) &&
    isOptionalText(value.statement, limits.proseLength) &&
    isOptionalText(value.context, limits.proseLength) &&
    isOptionalText(value.solution, limits.proseLength) &&
    isTextList(value.workDone, limits.listItems, limits.itemLength) &&
    isTextList(value.notDone, limits.listItems, limits.itemLength) &&
    Array.isArray(value.decisions) &&
    value.decisions.length <= limits.decisions &&
    value.decisions.every(isDecision) &&
    Array.isArray(value.tests) &&
    value.tests.length <= limits.tests &&
    value.tests.every(isTest) &&
    Array.isArray(value.issues) &&
    value.issues.length <= limits.issues &&
    value.issues.every(isIssue) &&
    Array.isArray(value.verifications) &&
    value.verifications.length <= limits.verifications &&
    value.verifications.every(isVerification) &&
    isIsoDate(value.updatedAt) &&
    Array.isArray(value.updates) &&
    value.updates.length <= limits.updates &&
    value.updates.every(isUpdate)
  );
}

/** Whether anything beyond the default framing has been written. */
export function hasKeyInformation(value: BuildPipelineKeyInformation | undefined): boolean {
  return Boolean(
    value &&
    (value.statement ||
      value.context ||
      value.solution ||
      value.workDone.length ||
      value.decisions.length ||
      value.notDone.length ||
      value.tests.length ||
      value.issues.length ||
      value.verifications.length),
  );
}

/** The agent tools that read and update a pipeline's key information. */
export const KEY_INFORMATION_TOOL_NAMES = Object.freeze([
  "get_key_information",
  "update_key_information",
] as const);
