/**
 * Shared grammar and bounds for graph templates (plan P1.1).
 *
 * Every string and list in a template has an explicit bound, and every name
 * follows one of a few small grammars, so a template read from a project
 * checkout or an import cannot carry unbounded text or names that break tool
 * names, predicate paths or storage keys. The helpers here add to the
 * path-tracking collector in `field-validation.ts`; they measure text in UTF-8
 * bytes, because bytes are what storage, prompts and wire frames pay for.
 */
import { MAX_BUILD_PIPELINE_ITERATIONS } from "../build-pipeline.js";
import {
  FieldErrorCollector,
  checkArray,
  checkFiniteNumber,
  isPlainRecord,
  joinPath,
  jsonDepthExceeds,
} from "../field-validation.js";
import { REVIEW_FANOUT_MAX_REVIEWERS } from "../review-fanout.js";
import { WORKFLOW_RESULT_MAX_BYTES } from "../workflow-results.js";

const KIB = 1024;
const MIB = 1024 * KIB;

/** Every count and byte bound a template guard enforces. */
export const GRAPH_TEMPLATE_BOUNDS = Object.freeze({
  /** Serialized JSON size of a whole template. */
  maxTemplateBytes: 1 * MIB,
  /** Nesting depth of a whole template document. */
  maxTemplateDepth: 48,

  maxIdChars: 64,
  maxKeyChars: 48,
  maxEnumValueChars: 64,
  maxTypeRefChars: 96,
  maxPathChars: 256,
  maxPathSegments: 16,

  maxNameBytes: 200,
  maxLabelBytes: 200,
  maxDescriptionBytes: 4 * KIB,
  maxPortDescriptionBytes: 2 * KIB,

  maxParameters: 32,
  maxEnumOptions: 32,
  maxStringParameterBytes: 4 * KIB,
  /** Magnitude bound for numeric parameters, defaults and system params. */
  maxNumberAbs: 1e12,
  maxRoles: 16,
  maxDefaultsFrom: 8,
  maxTypes: 32,
  maxRunInputs: 16,
  maxRunOutputs: 16,
  maxNodes: 100,
  maxEdges: 400,
  maxLoops: 16,
  maxLoopCarry: 16,
  maxPortsPerDirection: 16,
  maxGateBranches: 16,
  maxChooseOptions: 16,
  maxCapabilityOverrides: 32,
  maxSystemParams: 16,
  maxSystemParamListItems: 32,
  maxSystemParamStringBytes: 2 * KIB,
  maxSubgraphParamBindings: 32,
  maxSubgraphRoleBindings: 16,
  maxTransformsPerEdge: 8,
  maxPickFields: 32,
  maxTransformLimit: 1000,
  maxMergeKeyPaths: 8,
  maxAcknowledgements: 64,
  maxAcknowledgementNoteBytes: 1 * KIB,
  maxLayoutCoordinateAbs: 1_000_000,

  /** Branches per replicated node: today's reviewer panel cap. */
  maxBranches: REVIEW_FANOUT_MAX_REVIEWERS,
  maxReplicateAxes: 3,
  maxLensLabelChars: 64,
  maxLensInstructionBytes: 4 * KIB,
  maxRetryAttempts: 5,
  minTimeoutMs: 1_000,
  /** Human nodes may wait for days; agent and system nodes rarely approach it. */
  maxTimeoutMs: 7 * 24 * 60 * 60 * 1000,
  /** The Build Pipeline's protocol maximum, so its built-in template fits. */
  maxLoopIterations: MAX_BUILD_PIPELINE_ITERATIONS,
  /** Hard cap on agent sessions per run (report §5.11). */
  maxAgentSessions: 200,
  maxConcurrentAgents: REVIEW_FANOUT_MAX_REVIEWERS,
  maxTokens: 1_000_000_000,
  maxWallClockMs: 7 * 24 * 60 * 60 * 1000,

  maxPromptTemplateBytes: 32 * KIB,
  maxHumanInstructionsBytes: 4 * KIB,

  maxTypeVersion: 999,
  maxListDepth: 2,
  maxTypeSchemaBytes: 64 * KIB,
  maxTypeSchemaDepth: 32,
  maxTypeExampleBytes: 64 * KIB,
  maxTypeMarkdownBytes: 16 * KIB,
  maxTypeSummaryFields: 16,
  maxTypeSharedFields: 16,
  maxItemIdPrefixChars: 32,
  /** A value artifact is a workflow result; it shares that cap. */
  maxValueArtifactBytes: WORKFLOW_RESULT_MAX_BYTES,
  /** A reference artifact matches the per-stream log cap (report §5.11). */
  maxReferenceArtifactBytes: 32 * MIB,
  maxArtifactItems: 10_000,

  maxPredicateDepth: 8,
  maxPredicateNodes: 64,
  maxPredicateListValues: 64,
  maxPredicateStringBytes: 1 * KIB,
} as const);

/** Kebab-case slug: template, node, edge, loop, role, lens, type and built-in names. */
export const GRAPH_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/**
 * Identifier: port, parameter, run input and outlet names. They become MCP tool
 * names (`submit_<port>`), prompt variables and predicate path roots.
 */
export const GRAPH_KEY_PATTERN = /^[a-z][A-Za-z0-9_]*$/;
/** An enum parameter option or a predicate-friendly literal such as `P0`. */
export const GRAPH_ENUM_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
/** One dotted segment of a field path: `report.issues`, `has-findings.findings`. */
export const GRAPH_PATH_SEGMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** `name@major` or `list<…>` around it, at most `maxListDepth` deep. */
export const GRAPH_TYPE_REF_PATTERN = /^(?:list<)*[a-z][a-z0-9]*(?:-[a-z0-9]+)*@[1-9][0-9]*>*$/;
/** Lower-case SHA-256 hex, as the compiler prints warning digests. */
export const GRAPH_DIGEST_PATTERN = /^[a-f0-9]{64}$/;

// Text may not carry C0/C1 controls (newline and tab only in multi-line text)
// or bidirectional overrides that make a label read differently than it acts.
const SINGLE_LINE_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/u;
const MULTI_LINE_FORBIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/u;

export interface GraphTypeRefParts {
  name: string;
  version: number;
  /** 0 for `name@1`, 1 for `list<name@1>`, 2 for `list<list<name@1>>`. */
  listDepth: number;
}

/** Split a type reference; null when it is outside the grammar or the bounds. */
export function parseGraphTypeRef(ref: string): GraphTypeRefParts | null {
  if (ref.length > GRAPH_TEMPLATE_BOUNDS.maxTypeRefChars || !GRAPH_TYPE_REF_PATTERN.test(ref)) {
    return null;
  }
  let inner = ref;
  let listDepth = 0;
  while (inner.startsWith("list<")) {
    if (!inner.endsWith(">")) return null;
    inner = inner.slice(5, -1);
    listDepth++;
  }
  if (inner.includes(">") || listDepth > GRAPH_TEMPLATE_BOUNDS.maxListDepth) return null;
  const at = inner.indexOf("@");
  const name = inner.slice(0, at);
  const version = Number(inner.slice(at + 1));
  if (
    name.length > GRAPH_TEMPLATE_BOUNDS.maxIdChars ||
    !Number.isSafeInteger(version) ||
    version > GRAPH_TEMPLATE_BOUNDS.maxTypeVersion
  ) {
    return null;
  }
  return { name, version, listDepth };
}

export function isGraphId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= GRAPH_TEMPLATE_BOUNDS.maxIdChars &&
    GRAPH_ID_PATTERN.test(value)
  );
}

export function isGraphKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= GRAPH_TEMPLATE_BOUNDS.maxKeyChars &&
    GRAPH_KEY_PATTERN.test(value)
  );
}

export function isGraphFieldPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length > GRAPH_TEMPLATE_BOUNDS.maxPathChars) return false;
  const segments = value.split(".");
  return (
    segments.length <= GRAPH_TEMPLATE_BOUNDS.maxPathSegments &&
    segments.every((segment) => GRAPH_PATH_SEGMENT_PATTERN.test(segment))
  );
}

const encoder = new TextEncoder();

export function graphUtf8Bytes(value: string): number {
  // Every UTF-16 code unit encodes to at most three bytes, so short strings
  // never need encoding to be measured against a larger bound.
  return encoder.encode(value).byteLength;
}

function fitsBytes(value: string, maxBytes: number): boolean {
  return value.length * 3 <= maxBytes || graphUtf8Bytes(value) <= maxBytes;
}

/** Record a missing required field; true when the value is present. */
export function checkPresent(value: unknown, path: string, errors: FieldErrorCollector): boolean {
  if (value !== undefined) return true;
  errors.add(path, "required", "Field is required");
  return false;
}

function checkGrammar(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  pattern: RegExp,
  maxChars: number,
  description: string,
): value is string {
  if (!checkPresent(value, path, errors)) return false;
  if (typeof value !== "string") {
    errors.add(path, "type", "Expected a string");
    return false;
  }
  if (value.length === 0) {
    errors.add(path, "empty", "Must not be empty");
    return false;
  }
  if (value.length > maxChars) {
    errors.add(path, "too_long", `Must contain at most ${maxChars} characters`);
    return false;
  }
  if (!pattern.test(value)) {
    errors.add(path, "pattern", `Must be ${description}`);
    return false;
  }
  return true;
}

export function checkGraphId(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
): value is string {
  return checkGrammar(
    value,
    path,
    errors,
    GRAPH_ID_PATTERN,
    GRAPH_TEMPLATE_BOUNDS.maxIdChars,
    "a lower-case kebab-case id (a-z, 0-9 and single hyphens, starting with a letter)",
  );
}

export function checkGraphKey(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
): value is string {
  return checkGrammar(
    value,
    path,
    errors,
    GRAPH_KEY_PATTERN,
    GRAPH_TEMPLATE_BOUNDS.maxKeyChars,
    "an identifier (letters, digits and underscores, starting with a lower-case letter)",
  );
}

export function checkGraphEnumValue(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
): value is string {
  return checkGrammar(
    value,
    path,
    errors,
    GRAPH_ENUM_VALUE_PATTERN,
    GRAPH_TEMPLATE_BOUNDS.maxEnumValueChars,
    "letters, digits, '_', '.' or '-', starting with a letter or digit",
  );
}

export function checkGraphFieldPath(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
): value is string {
  if (!checkPresent(value, path, errors)) return false;
  if (typeof value !== "string") {
    errors.add(path, "type", "Expected a string");
    return false;
  }
  if (value.length > GRAPH_TEMPLATE_BOUNDS.maxPathChars) {
    errors.add(
      path,
      "too_long",
      `Must contain at most ${GRAPH_TEMPLATE_BOUNDS.maxPathChars} characters`,
    );
    return false;
  }
  if (value.split(".").length > GRAPH_TEMPLATE_BOUNDS.maxPathSegments) {
    errors.add(
      path,
      "too_many",
      `Must contain at most ${GRAPH_TEMPLATE_BOUNDS.maxPathSegments} segments`,
    );
    return false;
  }
  if (!isGraphFieldPath(value)) {
    errors.add(path, "pattern", "Must be a dotted field path such as report.issues");
    return false;
  }
  return true;
}

export function checkGraphTypeRef(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
): value is string {
  if (!checkPresent(value, path, errors)) return false;
  if (typeof value !== "string") {
    errors.add(path, "type", "Expected a string");
    return false;
  }
  if (value.length > GRAPH_TEMPLATE_BOUNDS.maxTypeRefChars) {
    errors.add(
      path,
      "too_long",
      `Must contain at most ${GRAPH_TEMPLATE_BOUNDS.maxTypeRefChars} characters`,
    );
    return false;
  }
  if (parseGraphTypeRef(value) === null) {
    errors.add(
      path,
      "type_ref",
      `Must be name@major or list<name@major>, at most ${GRAPH_TEMPLATE_BOUNDS.maxListDepth} lists deep`,
    );
    return false;
  }
  return true;
}

export interface GraphTextOptions {
  maxBytes: number;
  /** Also bound code points, for fields whose limit is stated in characters. */
  maxChars?: number;
  multiline?: boolean;
  optional?: boolean;
  /** Allow the empty string (default: text must contain a non-space character). */
  allowEmpty?: boolean;
}

/** Human-readable text: bounded in bytes, free of control and bidi-override characters. */
export function checkGraphText(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  options: GraphTextOptions,
): value is string {
  if (value === undefined && options.optional) return true;
  if (!checkPresent(value, path, errors)) return false;
  if (typeof value !== "string") {
    errors.add(path, "type", "Expected a string");
    return false;
  }
  if (!options.allowEmpty && value.trim().length === 0) {
    errors.add(path, "empty", "Must not be empty");
    return false;
  }
  if (!fitsBytes(value, options.maxBytes)) {
    errors.add(path, "too_large", `Must be at most ${options.maxBytes} UTF-8 bytes`);
    return false;
  }
  if (options.maxChars !== undefined && [...value].length > options.maxChars) {
    errors.add(path, "too_long", `Must contain at most ${options.maxChars} characters`);
    return false;
  }
  const forbidden = options.multiline ? MULTI_LINE_FORBIDDEN : SINGLE_LINE_FORBIDDEN;
  if (forbidden.test(value)) {
    errors.add(
      path,
      "control_character",
      options.multiline
        ? "Must not contain control or bidirectional-override characters"
        : "Must be a single line without control or bidirectional-override characters",
    );
    return false;
  }
  if (!options.multiline && value.trim() !== value) {
    errors.add(path, "whitespace", "Must not start or end with whitespace");
    return false;
  }
  return true;
}

export function checkGraphLabel(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  optional = true,
): value is string {
  return checkGraphText(value, path, errors, {
    maxBytes: GRAPH_TEMPLATE_BOUNDS.maxLabelBytes,
    optional,
  });
}

export function checkGraphDescription(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  maxBytes: number = GRAPH_TEMPLATE_BOUNDS.maxDescriptionBytes,
): value is string {
  return checkGraphText(value, path, errors, { maxBytes, multiline: true, optional: true });
}

export function checkGraphInteger(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  min: number,
  max: number,
  optional = false,
): value is number {
  if (value === undefined && optional) return true;
  if (!checkPresent(value, path, errors)) return false;
  return checkFiniteNumber(value, path, errors, { integer: true, min, max });
}

export function checkGraphBoolean(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  optional = true,
): value is boolean {
  if (value === undefined && optional) return true;
  if (!checkPresent(value, path, errors)) return false;
  if (typeof value !== "boolean") {
    errors.add(path, "type", "Expected a boolean");
    return false;
  }
  return true;
}

/** A required, bounded array; optional arrays pass `undefined` through. */
export function checkGraphList(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  options: { min?: number; max: number; optional?: boolean },
): value is unknown[] {
  if (value === undefined && options.optional) return false;
  if (!checkPresent(value, path, errors)) return false;
  return checkArray(value, path, errors, options);
}

/** A bounded record whose keys follow a grammar; returns its entries when valid. */
export function checkGraphRecord(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  options: { max: number; key: "id" | "key" },
): Array<[string, unknown]> | null {
  if (!isPlainRecord(value)) {
    errors.add(path, "type", "Expected an object");
    return null;
  }
  const entries = Object.entries(value);
  if (entries.length > options.max) {
    errors.add(path, "too_many", `Must contain at most ${options.max} entries`);
    return null;
  }
  const valid: Array<[string, unknown]> = [];
  for (const [key, entry] of entries) {
    const keyPath = joinPath(path, key);
    const ok = options.key === "id" ? isGraphId(key) : isGraphKey(key);
    if (!ok) {
      errors.add(
        keyPath,
        "pattern",
        options.key === "id" ? "Key must be a kebab-case id" : "Key must be an identifier",
      );
      continue;
    }
    valid.push([key, entry]);
  }
  return valid;
}

/**
 * Track uniqueness of names within one scope. `add` records a duplicate error
 * at `path` and returns false the second time a name is seen.
 */
export class GraphNameScope {
  private readonly seen = new Set<string>();

  constructor(
    private readonly errors: FieldErrorCollector,
    private readonly what: string,
  ) {}

  add(name: string, path: string): boolean {
    if (this.seen.has(name)) {
      this.errors.add(path, "duplicate", `Duplicate ${this.what} "${name}"`);
      return false;
    }
    this.seen.add(name);
    return true;
  }

  has(name: string): boolean {
    return this.seen.has(name);
  }
}

/**
 * An opaque JSON value with byte and depth bounds: plain objects, arrays,
 * strings, finite numbers, booleans and null only. Later items refine what the
 * value means (a JSON schema, an example payload); this only keeps it bounded.
 */
export function checkBoundedJson(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  options: { maxBytes: number; maxDepth: number; requireObject?: boolean },
): boolean {
  if (!checkPresent(value, path, errors)) return false;
  if (options.requireObject && !isPlainRecord(value)) {
    errors.add(path, "type", "Expected an object");
    return false;
  }
  if (jsonDepthExceeds(value, options.maxDepth)) {
    errors.add(path, "too_deep", `Must be nested at most ${options.maxDepth} levels deep`);
    return false;
  }
  const stack: Array<[unknown, string]> = [[value, path]];
  while (stack.length > 0) {
    const [current, currentPath] = stack.pop()!;
    if (current === null || typeof current === "string" || typeof current === "boolean") continue;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        errors.add(currentPath, "not_finite", "Must be a finite number");
        return false;
      }
      continue;
    }
    if (Array.isArray(current)) {
      current.forEach((child, index) => stack.push([child, joinPath(currentPath, index)]));
      continue;
    }
    if (isPlainRecord(current)) {
      for (const [key, child] of Object.entries(current)) {
        stack.push([child, joinPath(currentPath, key)]);
      }
      continue;
    }
    errors.add(currentPath, "not_json", "Must be a JSON value");
    return false;
  }
  if (graphUtf8Bytes(JSON.stringify(value)) > options.maxBytes) {
    errors.add(path, "too_large", `Must serialize to at most ${options.maxBytes} bytes`);
    return false;
  }
  return true;
}
