/**
 * Guards for the run record and artifacts (plan P2.1).
 *
 * `validateGraphRun` and `validateGraphArtifact` check shape, grammar, the
 * record's internal consistency (keys match their parts, superseded marks name
 * a rewind, a dispatched activation records its policy and tier) and every
 * bound. The bounds that a writer can overrun on purpose are also reported
 * first and alone by `graphRunLimitViolation` and `graphArtifactLimitViolation`
 * with a {@link GraphRunLimitCode}, so storage refuses an overrun with a typed
 * error instead of a generic invalid-record one.
 *
 * Errors use the `field-validation.ts` result and the template guard's codes
 * (`required`, `type`, `unknown_field`, `pattern`, `too_long`, `too_many`, …)
 * plus `digest` (a frozen plan or artifact identity that no longer matches),
 * `mismatch` (a field that disagrees with another) and `unknown_node`.
 */
import { isAgentPlatform, AGENT_PLATFORMS } from "../agent-platforms.js";
import { isPipelineTranscriptReference } from "../build-pipeline.js";
import { canonicalJson } from "../canonical-json.js";
import {
  FieldErrorCollector,
  checkArray,
  checkEnum,
  checkFiniteNumber,
  checkObject,
  checkString,
  isPlainRecord,
  joinPath,
  jsonDepthExceeds,
  type FieldValidation,
} from "../field-validation.js";
import { isNativeAgentExecutionPolicy } from "../native-agent.js";
import { parseUtcTimestamp } from "../workflow-snapshot.js";
import {
  GRAPH_DIGEST_PATTERN,
  GRAPH_ID_PATTERN,
  GRAPH_KEY_PATTERN,
  GRAPH_PLAN_ID_MAX_CHARS,
  GRAPH_PLAN_ID_PATTERN,
  GRAPH_TEMPLATE_BOUNDS,
  checkBoundedJson,
  graphUtf8Bytes,
  parseGraphTypeRef,
} from "./grammar.js";
import {
  GRAPH_PLAN_FORMAT,
  GRAPH_PLAN_FORMAT_VERSION,
  verifyGraphPlanDigest,
  type CompiledGraphPlan,
} from "./plan.js";
import {
  GRAPH_COMMIT_PATTERN,
  GRAPH_SHA256_PATTERN,
  graphArtifactDigest,
  graphArtifactId,
  graphArtifactInlineBytes,
  isGraphBranchKey,
  isGraphRunId,
  parseGraphActivationKey,
  parseGraphArtifactFilePath,
  type GraphHash,
} from "./run-identity.js";
import { graphRunBranchRefPrefix, parseGraphBranchWorktreePath } from "./isolation.js";
import {
  GRAPH_ACTIVATION_STATES,
  GRAPH_ARTIFACT_BUDGETS,
  GRAPH_ARTIFACT_FORMAT_VERSION,
  GRAPH_ARTIFACT_STATES,
  GRAPH_DISPATCH_STATES,
  GRAPH_GUARD_KINDS,
  GRAPH_GUARD_OUTCOMES,
  GRAPH_REWIND_KINDS,
  GRAPH_REWIND_REQUESTERS,
  GRAPH_RUN_BOUNDS,
  GRAPH_RUN_FORMAT,
  GRAPH_RUN_FORMAT_VERSION,
  GRAPH_RUN_INPUT_PRODUCER,
  GRAPH_RUN_LAUNCHERS,
  GRAPH_RUN_STATUSES,
  GRAPH_TEMPLATE_SCOPES,
  type GraphArtifact,
  type GraphRun,
  type GraphRunLimitViolation,
} from "./run-model.js";
import { checkGraphMockRunOptions } from "./mock-pins.js";
import { GRAPH_ENFORCEMENT_TIERS } from "./template-model.js";
import { GRAPH_AGENT_SESSION_FIELDS, checkGraphAgentSessionFields } from "./run-agent-session.js";
import { checkGraphHumanWait } from "./run-human.js";
import { GRAPH_ERROR_CAUSES } from "./types.js";

/** Errors reported per guard call. */
export const GRAPH_RUN_MAX_ERRORS = 50;
/** Nesting the guard walks before anything else (a plan nests deeper than a template). */
const MAX_RECORD_DEPTH = 160;
const B = GRAPH_RUN_BOUNDS;
const BUDGETS = GRAPH_ARTIFACT_BUDGETS;
const RESULT_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

// ---------------------------------------------------------------- small checks

function checkRequired(value: unknown, path: string, errors: FieldErrorCollector): boolean {
  if (value !== undefined) return true;
  errors.add(path, "required", "Field is required");
  return false;
}

function checkTimestamp(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  optional = false,
): void {
  if (value === undefined && optional) return;
  if (!checkRequired(value, path, errors)) return;
  if (typeof value !== "string" || value.length > 40 || parseUtcTimestamp(value) === null) {
    errors.add(path, "timestamp", "Expected an RFC 3339 UTC timestamp");
  }
}

function checkText(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  max: number,
  optional = true,
): value is string {
  if (value === undefined && optional) return false;
  if (!checkRequired(value, path, errors)) return false;
  if (!checkString(value, path, errors, { min: 1, max })) return false;
  if (CONTROL_CHARACTERS.test(value)) {
    errors.add(path, "control_character", "Must not contain control characters");
    return false;
  }
  return true;
}

function checkPattern(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  pattern: RegExp,
  max: number,
  description: string,
): value is string {
  if (!checkRequired(value, path, errors)) return false;
  if (!checkString(value, path, errors, { min: 1, max })) return false;
  if (!pattern.test(value)) {
    errors.add(path, "pattern", `Must be ${description}`);
    return false;
  }
  return true;
}

function checkArtifactId(value: unknown, path: string, errors: FieldErrorCollector): boolean {
  return checkPattern(value, path, errors, GRAPH_SHA256_PATTERN, 64, "an artifact id");
}

function checkCount(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  min: number,
  max: number,
  optional = false,
): void {
  if (value === undefined && optional) return;
  if (!checkRequired(value, path, errors)) return;
  checkFiniteNumber(value, path, errors, { integer: true, min, max });
}

/** A record whose keys match `pattern`; returns its entries, or null. */
function checkKeyedRecord(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  max: number,
  pattern: RegExp,
): Array<[string, unknown]> | null {
  if (!checkRequired(value, path, errors)) return null;
  if (!isPlainRecord(value)) {
    errors.add(path, "type", "Expected an object");
    return null;
  }
  const entries = Object.entries(value);
  if (entries.length > max) {
    errors.add(path, "too_many", `Must contain at most ${max} entries`);
    return null;
  }
  return entries.filter(([key]) => {
    if (pattern.test(key)) return true;
    errors.add(joinPath(path, key), "pattern", "Key has unsupported characters");
    return false;
  });
}

function checkError(
  record: Record<string, unknown>,
  path: string,
  errors: FieldErrorCollector,
): void {
  if (record.error !== undefined) {
    checkString(record.error, joinPath(path, "error"), errors, {
      min: 1,
      max: B.maxErrorChars,
    });
  }
  if (record.errorCause !== undefined) {
    checkEnum(record.errorCause, joinPath(path, "errorCause"), errors, GRAPH_ERROR_CAUSES);
  }
}

// ---------------------------------------------------------------- limits

function stateOf(value: unknown): unknown {
  return isPlainRecord(value) ? value.state : undefined;
}

/**
 * The first bound a run record overruns, as a typed violation; null when
 * every count is within its bound. Reads only the counted fields, so it runs
 * before (and independently of) the full guard.
 */
export function graphRunLimitViolation(run: unknown): GraphRunLimitViolation | null {
  if (!isPlainRecord(run)) return null;
  const activations = Array.isArray(run.activations) ? run.activations : [];
  if (activations.length > B.maxActivationHistory) {
    return {
      code: "activation-history",
      limit: B.maxActivationHistory,
      actual: activations.length,
      message: `A run keeps at most ${B.maxActivationHistory} activations, superseded ones included`,
    };
  }
  const live = activations.filter((activation) => stateOf(activation) !== "superseded").length;
  if (live > B.maxActivations) {
    return {
      code: "activations",
      limit: B.maxActivations,
      actual: live,
      message: `A run allows at most ${B.maxActivations} activations that are not superseded`,
    };
  }
  const rewinds = Array.isArray(run.rewinds) ? run.rewinds.length : 0;
  if (rewinds > B.maxRewinds) {
    return {
      code: "rewinds",
      limit: B.maxRewinds,
      actual: rewinds,
      message: `A run allows at most ${B.maxRewinds} rewinds`,
    };
  }
  const longest = [run, ...activations].reduce<number>((max, entry) => {
    const error = isPlainRecord(entry) ? entry.error : undefined;
    return typeof error === "string" ? Math.max(max, error.length) : max;
  }, 0);
  if (longest > B.maxErrorChars) {
    return {
      code: "error-length",
      limit: B.maxErrorChars,
      actual: longest,
      message: `Errors are bounded to ${B.maxErrorChars} characters`,
    };
  }
  return null;
}

/** The record-size bound, for a caller that has serialized the record. */
export function graphRunRecordBytesViolation(bytes: number): GraphRunLimitViolation | null {
  return bytes > B.maxRecordBytes
    ? {
        code: "record-bytes",
        limit: B.maxRecordBytes,
        actual: bytes,
        message: `A run record is bounded to ${B.maxRecordBytes} bytes`,
      }
    : null;
}

/** The first per-artifact bound an artifact overruns (run budgets are the store's). */
export function graphArtifactLimitViolation(artifact: unknown): GraphRunLimitViolation | null {
  if (!isPlainRecord(artifact)) return null;
  const body = artifact.body;
  if (isPlainRecord(body)) {
    const file = body.file;
    if (isPlainRecord(file) && typeof file.bytes === "number") {
      if (file.bytes > BUDGETS.maxReferenceBytes) {
        return {
          code: "reference-bytes",
          limit: BUDGETS.maxReferenceBytes,
          actual: file.bytes,
          message: `A reference artifact is bounded to ${BUDGETS.maxReferenceBytes} bytes`,
        };
      }
    }
    if (body.value !== undefined) {
      let bytes: number;
      try {
        bytes = graphArtifactInlineBytes(body as { value: unknown });
      } catch {
        bytes = 0; // Not JSON: the guard reports it.
      }
      if (bytes > BUDGETS.maxValueBytes) {
        return {
          code: "value-bytes",
          limit: BUDGETS.maxValueBytes,
          actual: bytes,
          message: `A value artifact is bounded to ${BUDGETS.maxValueBytes} bytes`,
        };
      }
    }
  }
  const inputs = Array.isArray(artifact.inputs) ? artifact.inputs.length : 0;
  if (inputs > BUDGETS.maxInputs) {
    return {
      code: "artifact-inputs",
      limit: BUDGETS.maxInputs,
      actual: inputs,
      message: `An artifact records at most ${BUDGETS.maxInputs} lineage inputs`,
    };
  }
  const items = Math.max(
    Array.isArray(artifact.itemIds) ? artifact.itemIds.length : 0,
    Array.isArray(artifact.itemSources)
      ? artifact.itemSources.reduce(
          (total: number, sources: unknown) =>
            total + (Array.isArray(sources) ? sources.length : 1),
          0,
        )
      : 0,
  );
  if (items > BUDGETS.maxItemIds) {
    return {
      code: "artifact-items",
      limit: BUDGETS.maxItemIds,
      actual: items,
      message: `An artifact carries at most ${BUDGETS.maxItemIds} item ids`,
    };
  }
  return null;
}

// ---------------------------------------------------------------- run

const RUN_FIELDS = [
  "format",
  "formatVersion",
  "id",
  "projectId",
  "environmentId",
  "template",
  "plan",
  "bindings",
  "launch",
  "status",
  "mock",
  "mockOptions",
  "activations",
  "rewinds",
  "loopIterations",
  "usage",
  "revision",
  "createdAt",
  "updatedAt",
  "startedAt",
  "finishedAt",
  "cancelRequestedAt",
  "error",
  "errorCause",
] as const;

function checkPlan(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  verifyPlan: (plan: CompiledGraphPlan) => boolean,
): value is CompiledGraphPlan {
  if (!checkRequired(value, path, errors)) return false;
  if (!isPlainRecord(value)) {
    errors.add(path, "type", "Expected an object");
    return false;
  }
  if (value.format !== GRAPH_PLAN_FORMAT || value.formatVersion !== GRAPH_PLAN_FORMAT_VERSION) {
    errors.add(path, "format", "Not a compiled graph plan this build reads");
    return false;
  }
  if (!Array.isArray(value.nodes) || !Array.isArray(value.loops)) {
    errors.add(path, "type", "Plan nodes and loops must be arrays");
    return false;
  }
  if (!verifyPlan(value as unknown as CompiledGraphPlan)) {
    errors.add(path, "digest", "The frozen plan no longer matches its digest");
    return false;
  }
  return true;
}

function checkBinding(value: unknown, path: string, errors: FieldErrorCollector): void {
  if (
    !checkObject(value, path, ["platform", "model", "reasoningEffort", "fastMode", "lens"], errors)
  ) {
    return;
  }
  if (!isAgentPlatform(value.platform)) {
    checkEnum(value.platform, joinPath(path, "platform"), errors, AGENT_PLATFORMS);
  }
  checkText(value.model, joinPath(path, "model"), errors, B.maxShortTextChars);
  checkText(value.reasoningEffort, joinPath(path, "reasoningEffort"), errors, B.maxShortTextChars);
  if (value.fastMode !== undefined && typeof value.fastMode !== "boolean") {
    errors.add(joinPath(path, "fastMode"), "type", "Expected a boolean");
  }
  if (
    value.lens !== undefined &&
    checkObject(value.lens, joinPath(path, "lens"), ["label", "instruction"], errors)
  ) {
    checkText(value.lens.label, joinPath(path, "lens.label"), errors, B.maxShortTextChars, false);
    // The instruction is prose: line breaks are allowed.
    if (checkRequired(value.lens.instruction, joinPath(path, "lens.instruction"), errors)) {
      checkString(value.lens.instruction, joinPath(path, "lens.instruction"), errors, {
        min: 1,
        max: B.maxLensInstructionChars,
      });
    }
  }
}

function checkLaunch(value: unknown, errors: FieldErrorCollector): void {
  if (value === undefined) return;
  if (!checkObject(value, "launch", ["requestedBy", "create", "ticket", "scheduleId"], errors)) {
    return;
  }
  checkEnum(value.requestedBy, "launch.requestedBy", errors, GRAPH_RUN_LAUNCHERS);
  if (value.create !== undefined) {
    checkEnum(value.create, "launch.create", errors, ["worktree", "container"] as const);
  }
  if (
    value.ticket !== undefined &&
    checkObject(value.ticket, "launch.ticket", ["taskId"], errors)
  ) {
    checkText(value.ticket.taskId, "launch.ticket.taskId", errors, B.maxIdChars, false);
  }
  checkText(value.scheduleId, "launch.scheduleId", errors, B.maxIdChars);
}

function checkBindings(value: unknown, path: string, errors: FieldErrorCollector): void {
  if (!checkRequired(value, path, errors)) return;
  if (!checkObject(value, path, ["roles", "params", "inputs"], errors)) return;
  const roles = checkKeyedRecord(
    value.roles,
    joinPath(path, "roles"),
    errors,
    B.maxRoleBindings,
    GRAPH_ID_PATTERN,
  );
  for (const [role, binding] of roles ?? []) {
    const rolePath = joinPath(joinPath(path, "roles"), role);
    if (Array.isArray(binding)) {
      if (!checkArray(binding, rolePath, errors, { min: 1, max: B.maxPanelBindings })) continue;
      binding.forEach((entry, index) => checkBinding(entry, joinPath(rolePath, index), errors));
    } else {
      checkBinding(binding, rolePath, errors);
    }
  }
  const params = checkKeyedRecord(
    value.params,
    joinPath(path, "params"),
    errors,
    B.maxParams,
    GRAPH_KEY_PATTERN,
  );
  for (const [key, param] of params ?? []) {
    const paramPath = joinPath(joinPath(path, "params"), key);
    if (param === null || typeof param === "boolean") continue;
    if (typeof param === "number") {
      checkFiniteNumber(param, paramPath, errors);
    } else if (typeof param === "string") {
      if (graphUtf8Bytes(param) > B.maxParamStringBytes) {
        errors.add(paramPath, "too_large", `Must be at most ${B.maxParamStringBytes} bytes`);
      }
    } else {
      errors.add(paramPath, "type", "Expected a string, number, boolean or null");
    }
  }
  const inputs = checkKeyedRecord(
    value.inputs,
    joinPath(path, "inputs"),
    errors,
    B.maxInputs,
    GRAPH_KEY_PATTERN,
  );
  for (const [name, id] of inputs ?? []) {
    checkArtifactId(id, joinPath(joinPath(path, "inputs"), name), errors);
  }
}

function checkPortArtifacts(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  allowLists: boolean,
): void {
  const entries = checkKeyedRecord(value, path, errors, B.maxPorts, GRAPH_KEY_PATTERN);
  for (const [port, ids] of entries ?? []) {
    const portPath = joinPath(path, port);
    if (allowLists && Array.isArray(ids)) {
      if (!checkArray(ids, portPath, errors, { max: B.maxPortArtifacts })) continue;
      ids.forEach((id, index) => checkArtifactId(id, joinPath(portPath, index), errors));
    } else {
      checkArtifactId(ids, portPath, errors);
    }
  }
}

function checkSession(value: unknown, path: string, errors: FieldErrorCollector): void {
  const fields = [
    "agent",
    "model",
    "effort",
    "providerSessionId",
    "requestId",
    "dispatchState",
    "resultTransport",
    "resultKeys",
    "tokenCount",
    "cacheReadTokens",
    "transcript",
    ...GRAPH_AGENT_SESSION_FIELDS,
  ];
  if (!checkObject(value, path, fields, errors)) return;
  checkGraphAgentSessionFields(value, path, errors);
  checkEnum(value.agent, joinPath(path, "agent"), errors, AGENT_PLATFORMS);
  checkText(value.model, joinPath(path, "model"), errors, B.maxShortTextChars);
  checkText(value.effort, joinPath(path, "effort"), errors, B.maxShortTextChars);
  checkText(
    value.providerSessionId,
    joinPath(path, "providerSessionId"),
    errors,
    B.maxShortTextChars,
  );
  checkText(value.requestId, joinPath(path, "requestId"), errors, B.maxIdChars, false);
  checkEnum(value.dispatchState, joinPath(path, "dispatchState"), errors, GRAPH_DISPATCH_STATES);
  checkText(value.resultTransport, joinPath(path, "resultTransport"), errors, 64, false);
  if (value.resultKeys !== undefined) {
    const keys = checkKeyedRecord(
      value.resultKeys,
      joinPath(path, "resultKeys"),
      errors,
      B.maxPorts,
      GRAPH_KEY_PATTERN,
    );
    for (const [port, key] of keys ?? []) {
      checkPattern(
        key,
        joinPath(joinPath(path, "resultKeys"), port),
        errors,
        RESULT_KEY_PATTERN,
        B.maxResultKeyChars,
        "a result key",
      );
    }
  }
  checkCount(
    value.tokenCount,
    joinPath(path, "tokenCount"),
    errors,
    0,
    Number.MAX_SAFE_INTEGER,
    true,
  );
  checkCount(
    value.cacheReadTokens,
    joinPath(path, "cacheReadTokens"),
    errors,
    0,
    Number.MAX_SAFE_INTEGER,
    true,
  );
  if (value.transcript !== undefined && !isPipelineTranscriptReference(value.transcript)) {
    errors.add(joinPath(path, "transcript"), "type", "Expected a transcript reference");
  }
}

function checkGuardResult(value: unknown, path: string, errors: FieldErrorCollector): void {
  if (!checkObject(value, path, ["guard", "outcome", "at", "detail", "paths"], errors)) return;
  checkEnum(value.guard, joinPath(path, "guard"), errors, GRAPH_GUARD_KINDS);
  checkEnum(value.outcome, joinPath(path, "outcome"), errors, GRAPH_GUARD_OUTCOMES);
  checkTimestamp(value.at, joinPath(path, "at"), errors);
  checkText(value.detail, joinPath(path, "detail"), errors, B.maxGuardDetailChars);
  if (value.paths !== undefined) {
    const pathsPath = joinPath(path, "paths");
    if (checkArray(value.paths, pathsPath, errors, { max: B.maxGuardPaths })) {
      value.paths.forEach((entry, index) =>
        checkText(entry, joinPath(pathsPath, index), errors, 1024, false),
      );
    }
  }
}

/** Remote names Git accepts in practice, without spaces or control characters. */
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

function checkBaseline(value: unknown, path: string, errors: FieldErrorCollector): void {
  const fields = ["headRef", "pathsDigest", "pathCount", "paths", "capturedAt", "upstream"];
  if (!checkObject(value, path, fields, errors)) return;
  checkPattern(
    value.headRef,
    joinPath(path, "headRef"),
    errors,
    GRAPH_COMMIT_PATTERN,
    64,
    "a full commit SHA",
  );
  checkPattern(
    value.pathsDigest,
    joinPath(path, "pathsDigest"),
    errors,
    GRAPH_DIGEST_PATTERN,
    64,
    "a SHA-256 hex digest",
  );
  checkCount(value.pathCount, joinPath(path, "pathCount"), errors, 0, 1_000_000, true);
  if (value.paths !== undefined) {
    const pathsPath = joinPath(path, "paths");
    if (checkArray(value.paths, pathsPath, errors, { max: B.maxBaselinePaths })) {
      value.paths.forEach((entry, index) =>
        checkText(entry, joinPath(pathsPath, index), errors, B.maxBaselinePathChars, false),
      );
      if (typeof value.pathCount === "number" && value.pathCount !== value.paths.length) {
        errors.add(pathsPath, "mismatch", "The kept paths disagree with pathCount");
      }
    }
  }
  checkTimestamp(value.capturedAt, joinPath(path, "capturedAt"), errors, true);
  if (value.upstream !== undefined) {
    const upstreamPath = joinPath(path, "upstream");
    if (checkArray(value.upstream, upstreamPath, errors, { max: B.maxBaselineUpstreamRefs })) {
      value.upstream.forEach((entry, index) => {
        const entryPath = joinPath(upstreamPath, index);
        if (!checkObject(entry, entryPath, ["remote", "ref", "sha"], errors)) return;
        checkPattern(
          entry.remote,
          joinPath(entryPath, "remote"),
          errors,
          REMOTE_NAME,
          128,
          "a remote name",
        );
        checkText(entry.ref, joinPath(entryPath, "ref"), errors, B.maxShortTextChars, false);
        if (entry.sha !== null) {
          checkPattern(
            entry.sha,
            joinPath(entryPath, "sha"),
            errors,
            GRAPH_COMMIT_PATTERN,
            64,
            "a full commit SHA or null",
          );
        }
      });
    }
  }
}

/** An isolated branch's worktree (item 403): our path grammar, a branch of the run, a commit. */
function checkWorktree(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  runId: unknown,
): void {
  if (!checkObject(value, path, ["path", "branch", "baseRef", "createdAt"], errors)) return;
  const parsed = parseGraphBranchWorktreePath(value.path);
  if (!parsed) {
    errors.add(joinPath(path, "path"), "pattern", "Must be a graph branch worktree path");
  } else if (typeof runId === "string" && parsed.runId !== runId) {
    errors.add(joinPath(path, "path"), "mismatch", "The worktree belongs to another run");
  }
  if (
    typeof value.branch !== "string" ||
    typeof runId !== "string" ||
    !isGraphRunId(runId) ||
    !value.branch.startsWith(graphRunBranchRefPrefix(runId)) ||
    value.branch.length > 512 ||
    !/^[A-Za-z0-9._+/_-]+$/.test(value.branch)
  ) {
    errors.add(joinPath(path, "branch"), "pattern", "Must be a branch of the run");
  }
  checkPattern(
    value.baseRef,
    joinPath(path, "baseRef"),
    errors,
    GRAPH_COMMIT_PATTERN,
    64,
    "a full commit SHA",
  );
  checkTimestamp(value.createdAt, joinPath(path, "createdAt"), errors);
}

const ACTIVATION_FIELDS = [
  "key",
  "nodeId",
  "iteration",
  "branchKey",
  "attempt",
  "state",
  "inputs",
  "outputs",
  "outlet",
  "session",
  "human",
  "policy",
  "enforcement",
  "enforcementReason",
  "baseline",
  "worktree",
  "guards",
  "error",
  "errorCause",
  "createdAt",
  "startedAt",
  "finishedAt",
  "supersededBy",
];

function checkActivation(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  context: {
    nodeIds: ReadonlySet<string> | null;
    rewindIds: ReadonlySet<string>;
    runId: unknown;
  },
): string | null {
  if (!checkObject(value, path, ACTIVATION_FIELDS, errors)) return null;
  const keyPath = joinPath(path, "key");
  const parts = parseGraphActivationKey(value.key);
  if (!parts) {
    if (checkRequired(value.key, keyPath, errors)) {
      errors.add(keyPath, "pattern", "Must be node#iter=<n>[#branch=<key>]#attempt=<n>");
    }
  } else if (
    parts.nodeId !== value.nodeId ||
    parts.iteration !== value.iteration ||
    parts.attempt !== value.attempt ||
    parts.branchKey !== value.branchKey
  ) {
    errors.add(
      keyPath,
      "mismatch",
      "The key does not match nodeId, iteration, branchKey and attempt",
    );
  }
  if (typeof value.nodeId === "string" && context.nodeIds && !context.nodeIds.has(value.nodeId)) {
    errors.add(joinPath(path, "nodeId"), "unknown_node", "The frozen plan has no such node");
  }
  checkCount(value.iteration, joinPath(path, "iteration"), errors, 1, B.maxIteration);
  checkCount(value.attempt, joinPath(path, "attempt"), errors, 1, B.maxAttempt);
  if (value.branchKey !== undefined && !isGraphBranchKey(value.branchKey)) {
    errors.add(joinPath(path, "branchKey"), "pattern", "Branch key has unsupported characters");
  }
  checkEnum(value.state, joinPath(path, "state"), errors, GRAPH_ACTIVATION_STATES);
  checkPortArtifacts(value.inputs, joinPath(path, "inputs"), errors, true);
  checkPortArtifacts(value.outputs, joinPath(path, "outputs"), errors, false);
  if (value.outlet !== undefined) {
    checkPattern(
      value.outlet,
      joinPath(path, "outlet"),
      errors,
      GRAPH_KEY_PATTERN,
      GRAPH_TEMPLATE_BOUNDS.maxKeyChars,
      "an outlet name",
    );
  }
  if (value.session !== undefined) checkSession(value.session, joinPath(path, "session"), errors);
  if (value.human !== undefined) checkGraphHumanWait(value.human, joinPath(path, "human"), errors);
  if (value.policy !== undefined && !isNativeAgentExecutionPolicy(value.policy)) {
    errors.add(joinPath(path, "policy"), "type", "Expected a native agent execution policy");
  }
  if (value.enforcement !== undefined) {
    checkEnum(value.enforcement, joinPath(path, "enforcement"), errors, GRAPH_ENFORCEMENT_TIERS);
  }
  if ((value.policy === undefined) !== (value.enforcement === undefined)) {
    errors.add(
      joinPath(path, value.policy === undefined ? "policy" : "enforcement"),
      "required",
      "An activation records its policy and its enforcement tier together",
    );
  } else if (value.session !== undefined && value.policy === undefined) {
    errors.add(
      joinPath(path, "policy"),
      "required",
      "A dispatched activation records the policy and tier it actually got",
    );
  }
  checkText(value.enforcementReason, joinPath(path, "enforcementReason"), errors, 512);
  if (value.baseline !== undefined)
    checkBaseline(value.baseline, joinPath(path, "baseline"), errors);
  if (value.worktree !== undefined) {
    checkWorktree(value.worktree, joinPath(path, "worktree"), errors, context.runId);
  }
  if (value.guards !== undefined) {
    const guardsPath = joinPath(path, "guards");
    if (checkArray(value.guards, guardsPath, errors, { max: B.maxGuardResults })) {
      value.guards.forEach((entry, index) =>
        checkGuardResult(entry, joinPath(guardsPath, index), errors),
      );
    }
  }
  checkError(value, path, errors);
  checkTimestamp(value.createdAt, joinPath(path, "createdAt"), errors);
  checkTimestamp(value.startedAt, joinPath(path, "startedAt"), errors, true);
  checkTimestamp(value.finishedAt, joinPath(path, "finishedAt"), errors, true);
  const supersededPath = joinPath(path, "supersededBy");
  if (value.state === "superseded") {
    if (
      checkRequired(value.supersededBy, supersededPath, errors) &&
      !context.rewindIds.has(value.supersededBy as string)
    ) {
      errors.add(supersededPath, "mismatch", "Must name one of the run's rewinds");
    }
  } else if (value.supersededBy !== undefined) {
    errors.add(supersededPath, "mismatch", "Only a superseded activation names a rewind");
  }
  return typeof value.key === "string" ? value.key : null;
}

function checkRewind(value: unknown, path: string, errors: FieldErrorCollector): string | null {
  const fields = [
    "id",
    "kind",
    "nodeId",
    "activation",
    "iteration",
    "requestedAt",
    "requestedBy",
    "superseded",
    "code",
  ];
  if (!checkObject(value, path, fields, errors)) return null;
  const idOk = checkPattern(
    value.id,
    joinPath(path, "id"),
    errors,
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
    B.maxIdChars,
    "a rewind id",
  );
  checkEnum(value.kind, joinPath(path, "kind"), errors, GRAPH_REWIND_KINDS);
  checkPattern(
    value.nodeId,
    joinPath(path, "nodeId"),
    errors,
    GRAPH_PLAN_ID_PATTERN,
    GRAPH_PLAN_ID_MAX_CHARS,
    "a node id",
  );
  if (!parseGraphActivationKey(value.activation)) {
    errors.add(joinPath(path, "activation"), "pattern", "Must be an activation key");
  }
  checkCount(value.iteration, joinPath(path, "iteration"), errors, 1, B.maxIteration);
  checkTimestamp(value.requestedAt, joinPath(path, "requestedAt"), errors);
  checkEnum(value.requestedBy, joinPath(path, "requestedBy"), errors, GRAPH_REWIND_REQUESTERS);
  const supersededPath = joinPath(path, "superseded");
  if (
    checkRequired(value.superseded, supersededPath, errors) &&
    checkObject(value.superseded, supersededPath, ["activations", "artifacts"], errors)
  ) {
    const activationsPath = joinPath(supersededPath, "activations");
    if (
      checkArray(value.superseded.activations, activationsPath, errors, {
        max: B.maxActivationHistory,
      })
    ) {
      value.superseded.activations.forEach((key, index) => {
        if (!parseGraphActivationKey(key)) {
          errors.add(joinPath(activationsPath, index), "pattern", "Must be an activation key");
        }
      });
    }
    const artifactsPath = joinPath(supersededPath, "artifacts");
    if (
      checkArray(value.superseded.artifacts, artifactsPath, errors, {
        max: BUDGETS.maxArtifactsPerRun,
      })
    ) {
      value.superseded.artifacts.forEach((id, index) =>
        checkArtifactId(id, joinPath(artifactsPath, index), errors),
      );
    }
  }
  if (value.code !== undefined) {
    const codePath = joinPath(path, "code");
    if (
      checkObject(
        value.code,
        codePath,
        ["headRef", "backupRef", "from", "upstream", "upstreamCommitsDropped", "pending"],
        errors,
      )
    ) {
      if (value.code.pending !== undefined && value.code.pending !== true) {
        errors.add(joinPath(codePath, "pending"), "type", "Expected true when present");
      }
      checkPattern(
        value.code.headRef,
        joinPath(codePath, "headRef"),
        errors,
        GRAPH_COMMIT_PATTERN,
        64,
        "a full commit SHA",
      );
      checkText(value.code.backupRef, joinPath(codePath, "backupRef"), errors, 256);
      if (value.code.from !== undefined) {
        checkPattern(
          value.code.from,
          joinPath(codePath, "from"),
          errors,
          GRAPH_COMMIT_PATTERN,
          64,
          "a full commit SHA",
        );
      }
      checkText(value.code.upstream, joinPath(codePath, "upstream"), errors, 256);
      checkCount(
        value.code.upstreamCommitsDropped,
        joinPath(codePath, "upstreamCommitsDropped"),
        errors,
        0,
        1_000_000,
        true,
      );
    }
  }
  return idOk ? (value.id as string) : null;
}

export interface GraphRunValidationOptions {
  /**
   * Re-checks the frozen plan's digest. Defaults to `verifyGraphPlanDigest`;
   * the backend passes the same check over its native SHA-256.
   */
  verifyPlan?: (plan: CompiledGraphPlan) => boolean;
}

/** The structural guard for a stored or about-to-be-stored run record. */
export function validateGraphRun(
  value: unknown,
  options: GraphRunValidationOptions = {},
): FieldValidation<GraphRun> {
  const errors = new FieldErrorCollector(GRAPH_RUN_MAX_ERRORS);
  if (jsonDepthExceeds(value, MAX_RECORD_DEPTH)) {
    errors.add("$", "too_deep", `Must be nested at most ${MAX_RECORD_DEPTH} levels deep`);
    return errors.result(value as GraphRun);
  }
  if (!checkObject(value, "$", RUN_FIELDS, errors)) return errors.result(value as GraphRun);
  if (value.format !== GRAPH_RUN_FORMAT) {
    errors.add("format", "format", `Expected "${GRAPH_RUN_FORMAT}"`);
    return errors.result(value as unknown as GraphRun);
  }
  if (value.formatVersion !== GRAPH_RUN_FORMAT_VERSION) {
    errors.add("formatVersion", "unsupported_version", "This build reads run format 1");
    return errors.result(value as unknown as GraphRun);
  }
  if (!isGraphRunId(value.id)) errors.add("id", "pattern", "Must be a run id");
  checkText(value.projectId, "projectId", errors, B.maxIdChars, false);
  checkText(value.environmentId, "environmentId", errors, B.maxIdChars);

  if (checkRequired(value.template, "template", errors)) {
    const template = value.template;
    if (checkObject(template, "template", ["id", "revision", "digest", "scope"], errors)) {
      checkPattern(template.id, "template.id", errors, GRAPH_ID_PATTERN, 64, "a template id");
      checkCount(template.revision, "template.revision", errors, 0, Number.MAX_SAFE_INTEGER);
      checkPattern(
        template.digest,
        "template.digest",
        errors,
        GRAPH_DIGEST_PATTERN,
        64,
        "a SHA-256 hex digest",
      );
      if (template.scope !== undefined) {
        checkEnum(template.scope, "template.scope", errors, GRAPH_TEMPLATE_SCOPES);
      }
    }
  }
  const plan = checkPlan(value.plan, "plan", errors, options.verifyPlan ?? verifyGraphPlanDigest)
    ? value.plan
    : null;
  if (plan && isPlainRecord(value.template)) {
    if (
      plan.template.id !== value.template.id ||
      plan.template.revision !== value.template.revision
    ) {
      errors.add("plan.template", "mismatch", "The plan was compiled from another template");
    }
    if (plan.templateDigest !== value.template.digest) {
      errors.add("plan.templateDigest", "mismatch", "The plan was compiled from another template");
    }
  }
  checkBindings(value.bindings, "bindings", errors);
  checkLaunch(value.launch, errors);
  checkEnum(value.status, "status", errors, GRAPH_RUN_STATUSES);
  if (typeof value.mock !== "boolean") errors.add("mock", "type", "Expected a boolean");
  if (value.mockOptions !== undefined) {
    if (value.mock !== true) {
      errors.add("mockOptions", "not_applicable", "Only a mock run carries mock options");
    } else {
      checkGraphMockRunOptions(value.mockOptions, "mockOptions", errors);
    }
  }

  const rewindIds = new Set<string>();
  if (
    checkRequired(value.rewinds, "rewinds", errors) &&
    checkArray(value.rewinds, "rewinds", errors, { max: B.maxRewinds })
  ) {
    value.rewinds.forEach((rewind, index) => {
      const id = checkRewind(rewind, joinPath("rewinds", index), errors);
      if (id === null) return;
      if (rewindIds.has(id))
        errors.add(joinPath("rewinds", index), "duplicate", "Duplicate rewind id");
      rewindIds.add(id);
    });
  }
  if (
    checkRequired(value.activations, "activations", errors) &&
    checkArray(value.activations, "activations", errors, { max: B.maxActivationHistory })
  ) {
    const nodeIds = plan ? new Set(plan.nodes.map((node) => node.id)) : null;
    const keys = new Set<string>();
    let live = 0;
    value.activations.forEach((activation, index) => {
      const path = joinPath("activations", index);
      const key = checkActivation(activation, path, errors, {
        nodeIds,
        rewindIds,
        runId: value.id,
      });
      if (stateOf(activation) !== "superseded") live++;
      if (key === null) return;
      if (keys.has(key)) errors.add(joinPath(path, "key"), "duplicate", "Duplicate activation key");
      keys.add(key);
    });
    if (live > B.maxActivations) {
      errors.add(
        "activations",
        "too_many",
        `At most ${B.maxActivations} activations may be other than superseded`,
      );
    }
  }
  const loops = checkKeyedRecord(
    value.loopIterations,
    "loopIterations",
    errors,
    B.maxLoops,
    GRAPH_PLAN_ID_PATTERN,
  );
  const loopIds = plan ? new Set(plan.loops.map((loop) => loop.id)) : null;
  for (const [loop, iteration] of loops ?? []) {
    const loopPath = joinPath("loopIterations", loop);
    if (loopIds && !loopIds.has(loop)) {
      errors.add(loopPath, "unknown_node", "The frozen plan has no such loop");
    }
    checkCount(iteration, loopPath, errors, 1, B.maxIteration);
  }
  if (
    checkRequired(value.usage, "usage", errors) &&
    checkObject(value.usage, "usage", ["agentSessions", "tokens", "cacheReadTokens"], errors)
  ) {
    checkCount(
      value.usage.agentSessions,
      "usage.agentSessions",
      errors,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    checkCount(value.usage.tokens, "usage.tokens", errors, 0, Number.MAX_SAFE_INTEGER);
    checkCount(
      value.usage.cacheReadTokens,
      "usage.cacheReadTokens",
      errors,
      0,
      Number.MAX_SAFE_INTEGER,
      true,
    );
  }
  checkCount(value.revision, "revision", errors, 0, Number.MAX_SAFE_INTEGER);
  checkTimestamp(value.createdAt, "createdAt", errors);
  checkTimestamp(value.updatedAt, "updatedAt", errors);
  checkTimestamp(value.startedAt, "startedAt", errors, true);
  checkTimestamp(value.finishedAt, "finishedAt", errors, true);
  checkTimestamp(value.cancelRequestedAt, "cancelRequestedAt", errors, true);
  checkError(value, "", errors);
  return errors.result(value as unknown as GraphRun);
}

export function isGraphRun(value: unknown): value is GraphRun {
  return validateGraphRun(value).ok;
}

// ---------------------------------------------------------------- artifact

const ARTIFACT_FIELDS = [
  "formatVersion",
  "id",
  "digest",
  "type",
  "runId",
  "producer",
  "inputs",
  "workspace",
  "createdAt",
  "bytes",
  "body",
  "itemIds",
  "itemSources",
  "state",
  "supersededBy",
] as const;

function checkProducer(value: unknown, path: string, errors: FieldErrorCollector): void {
  if (!checkRequired(value, path, errors)) return;
  if (!checkObject(value, path, ["nodeId", "activation", "port"], errors)) return;
  if (value.nodeId === GRAPH_RUN_INPUT_PRODUCER) {
    if (value.activation !== GRAPH_RUN_INPUT_PRODUCER) {
      errors.add(joinPath(path, "activation"), "mismatch", "A run input has no activation");
    }
  } else {
    checkPattern(
      value.nodeId,
      joinPath(path, "nodeId"),
      errors,
      GRAPH_PLAN_ID_PATTERN,
      GRAPH_PLAN_ID_MAX_CHARS,
      "a node id",
    );
    const parts = parseGraphActivationKey(value.activation);
    if (!parts) {
      errors.add(joinPath(path, "activation"), "pattern", "Must be an activation key");
    } else if (parts.nodeId !== value.nodeId) {
      errors.add(joinPath(path, "activation"), "mismatch", "The activation is another node's");
    }
  }
  checkPattern(value.port, joinPath(path, "port"), errors, GRAPH_KEY_PATTERN, 48, "a port name");
}

function checkBody(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  runId: unknown,
): void {
  if (!checkRequired(value, path, errors)) return;
  if (!isPlainRecord(value)) {
    errors.add(path, "type", "Expected an object");
    return;
  }
  const valuePath = joinPath(path, "value");
  if (value.file === undefined) {
    if (!checkObject(value, path, ["value"], errors)) return;
    checkBoundedJson(value.value, valuePath, errors, {
      maxBytes: BUDGETS.maxValueBytes,
      maxDepth: 64,
    });
    return;
  }
  if (!checkObject(value, path, ["file", "value"], errors)) return;
  const filePath = joinPath(path, "file");
  if (checkObject(value.file, filePath, ["path", "sha256", "bytes"], errors)) {
    const parsed = parseGraphArtifactFilePath(value.file.path);
    if (!parsed) {
      errors.add(joinPath(filePath, "path"), "pattern", "Must be a graph artifact path");
    } else if (parsed.runId !== runId || parsed.sha256 !== value.file.sha256) {
      errors.add(joinPath(filePath, "path"), "mismatch", "The path names another run or hash");
    }
    checkPattern(
      value.file.sha256,
      joinPath(filePath, "sha256"),
      errors,
      GRAPH_SHA256_PATTERN,
      64,
      "a SHA-256 hex digest",
    );
    checkCount(value.file.bytes, joinPath(filePath, "bytes"), errors, 0, BUDGETS.maxReferenceBytes);
  }
  if (value.value !== undefined) {
    checkBoundedJson(value.value, valuePath, errors, {
      maxBytes: BUDGETS.maxValueBytes,
      maxDepth: 64,
    });
  }
}

/** The structural guard for a stored artifact envelope. */
export function validateGraphArtifact(value: unknown): FieldValidation<GraphArtifact> {
  const errors = new FieldErrorCollector(GRAPH_RUN_MAX_ERRORS);
  if (!checkObject(value, "$", ARTIFACT_FIELDS, errors))
    return errors.result(value as GraphArtifact);
  if (value.formatVersion !== GRAPH_ARTIFACT_FORMAT_VERSION) {
    errors.add("formatVersion", "unsupported_version", "This build reads artifact format 1");
    return errors.result(value as unknown as GraphArtifact);
  }
  checkArtifactId(value.id, "id", errors);
  checkPattern(value.digest, "digest", errors, GRAPH_SHA256_PATTERN, 64, "a SHA-256 hex digest");
  const typeRef = typeof value.type === "string" ? parseGraphTypeRef(value.type) : null;
  if (!typeRef || typeRef.listDepth !== 0) {
    errors.add("type", "type_ref", "Must be a type reference name@version (not a list)");
  }
  if (!isGraphRunId(value.runId)) errors.add("runId", "pattern", "Must be a run id");
  checkProducer(value.producer, "producer", errors);
  if (
    checkRequired(value.inputs, "inputs", errors) &&
    checkArray(value.inputs, "inputs", errors, { max: BUDGETS.maxInputs })
  ) {
    value.inputs.forEach((id, index) => checkArtifactId(id, joinPath("inputs", index), errors));
  }
  if (value.workspace !== undefined) {
    if (checkObject(value.workspace, "workspace", ["headRef", "baseRef"], errors)) {
      checkPattern(
        value.workspace.headRef,
        "workspace.headRef",
        errors,
        GRAPH_COMMIT_PATTERN,
        64,
        "a full commit SHA",
      );
      if (value.workspace.baseRef !== undefined) {
        checkPattern(
          value.workspace.baseRef,
          "workspace.baseRef",
          errors,
          GRAPH_COMMIT_PATTERN,
          64,
          "a full commit SHA",
        );
      }
    }
  }
  checkTimestamp(value.createdAt, "createdAt", errors);
  checkCount(value.bytes, "bytes", errors, 0, BUDGETS.maxReferenceBytes);
  checkBody(value.body, "body", errors, value.runId);
  if (value.itemIds !== undefined) {
    if (checkArray(value.itemIds, "itemIds", errors, { max: BUDGETS.maxItemIds })) {
      const seen = new Set<string>();
      value.itemIds.forEach((id, index) => {
        const path = joinPath("itemIds", index);
        if (!checkText(id, path, errors, BUDGETS.maxItemIdChars, false)) return;
        if (seen.has(id)) errors.add(path, "duplicate", "Duplicate item id");
        seen.add(id);
      });
    }
  }
  if (value.itemSources !== undefined) {
    const itemCount = Array.isArray(value.itemIds) ? value.itemIds.length : -1;
    if (checkArray(value.itemSources, "itemSources", errors, { max: BUDGETS.maxItemIds })) {
      if (value.itemSources.length !== itemCount) {
        errors.add("itemSources", "mismatch", "Item sources run parallel to item ids");
      }
      value.itemSources.forEach((sources, index) => {
        const path = joinPath("itemSources", index);
        if (!checkArray(sources, path, errors, { min: 1, max: BUDGETS.maxItemIds })) return;
        sources.forEach((id, position) =>
          checkText(id, joinPath(path, position), errors, BUDGETS.maxItemIdChars, false),
        );
      });
    }
  }
  checkEnum(value.state, "state", errors, GRAPH_ARTIFACT_STATES);
  if (value.state === "superseded") {
    checkPattern(
      value.supersededBy,
      "supersededBy",
      errors,
      /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
      B.maxIdChars,
      "a rewind id",
    );
  } else if (value.supersededBy !== undefined) {
    errors.add("supersededBy", "mismatch", "Only a superseded artifact names a rewind");
  }
  return errors.result(value as unknown as GraphArtifact);
}

export function isGraphArtifact(value: unknown): value is GraphArtifact {
  return validateGraphArtifact(value).ok;
}

/**
 * Whether an artifact's `digest`, `id` and `bytes` still follow from its
 * content: what a consumer checks of a value artifact before using it. A
 * reference artifact's file is checked against `body.file` on disk as well.
 */
export function verifyGraphArtifactIdentity(
  artifact: GraphArtifact,
  hash?: GraphHash,
): { ok: true } | { ok: false; field: "digest" | "id" | "bytes" } {
  let digest: string;
  try {
    digest = graphArtifactDigest(artifact.type, artifact.body, hash);
  } catch {
    return { ok: false, field: "digest" };
  }
  if (digest !== artifact.digest) return { ok: false, field: "digest" };
  const id = graphArtifactId(
    {
      digest,
      runId: artifact.runId,
      producer: artifact.producer,
      inputs: artifact.inputs,
      ...(artifact.workspace ? { workspace: artifact.workspace } : {}),
    },
    hash,
  );
  if (id !== artifact.id) return { ok: false, field: "id" };
  const bytes =
    "file" in artifact.body
      ? artifact.body.file.bytes
      : graphUtf8Bytes(canonicalJson(artifact.body.value, 128));
  return bytes === artifact.bytes ? { ok: true } : { ok: false, field: "bytes" };
}
