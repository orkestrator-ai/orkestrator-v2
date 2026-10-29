/**
 * Pinned mock outputs (item 213, report §7.5: "Verify fails twice, then
 * passes"): what a mock run answers for a node, activation by activation.
 *
 * Pins live in two places, with one shape ({@link GraphMockPins}: node id →
 * a sequence of pins):
 *
 * - **On the template** (`GraphTemplateV1.mockPins`), edited in the designer
 *   and saved with the template. Like `layout`, they are designer data: the
 *   compiler ignores them and they are not part of the template digest, so
 *   editing them never changes trust or a plan.
 * - **On the launch** (`graph_run_mock {pins}`), which replaces the stored
 *   sequence node by node. The effective pins are frozen on the run
 *   (`GraphRun.mockOptions.pins`) so a restarted backend answers the same.
 *
 * The *n*-th activation of a node's branch (counting retries, loop
 * iterations and restarts, in the order the run created them) takes the
 * *n*-th pin; past the end, the last pin repeats. So `[fail, fail, pass]` on
 * a loop's verifier converges on iteration 3, and `[fail]` never converges.
 *
 * A pin is one of:
 *
 * - `"example"`: every output takes its type's `example` (generated when the
 *   type has none). The default for every node without a pin.
 * - `"generated"`: every output is generated from its schema
 *   (`graphSchemaSample`), falling back to the example when the generated
 *   value fails the type's domain checks.
 * - `{ outputs: { <port>: value | null } }`: custom JSON per output port,
 *   checked against the port's type; unnamed ports take the example; `null`
 *   leaves an optional port unproduced.
 * - `{ fail: <cause>, message? }`: the activation fails with that cause, so
 *   retries, `onFailure` and routed `error@1` outputs can be exercised.
 * - Human nodes: `{ outlet, outputs? }` takes an outlet (an `edit` form may
 *   carry the edited value of its edited input), and `"pause"` waits for a
 *   person through the live human executor (item 208).
 *
 * Gates and merges are deterministic and run live in mock runs; they take no
 * pins. Browser-safe.
 */
import { FieldErrorCollector, checkEnum, isPlainRecord, joinPath } from "../field-validation.js";
import type { WorkflowResultValidationIssue } from "../workflow-results.js";
import {
  GRAPH_TEMPLATE_BOUNDS,
  checkBoundedJson,
  checkGraphRecord,
  checkGraphText,
  graphUtf8Bytes,
  isGraphKey,
} from "./grammar.js";
import type { CompiledGraphPlan } from "./plan.js";
import { graphNodeOutlets, type GraphTemplateV1 } from "./template-model.js";
import {
  GRAPH_ERROR_CAUSES,
  GraphTypeLibrary,
  validateGraphArtifactValue,
  type GraphErrorCause,
} from "./types.js";

const KIB = 1024;

export const GRAPH_MOCK_PIN_BOUNDS = Object.freeze({
  /** Pinned nodes (every node of the largest template). */
  maxNodes: GRAPH_TEMPLATE_BOUNDS.maxNodes,
  /** Pins in one node's sequence. */
  maxPinsPerNode: 20,
  /** Serialized bytes of one pin (its custom values). */
  maxPinBytes: 64 * KIB,
  /** Serialized bytes of every pin of a template or run. */
  maxPinsBytes: 256 * KIB,
  maxPinDepth: 24,
  /** A pinned failure's message. */
  maxMessageChars: 500,
  /** `stepMs`: how long each mock activation appears to run. */
  maxStepMs: 10_000,
});

/** Pin modes that take no data. */
export const GRAPH_MOCK_PIN_MODES = ["example", "generated", "pause"] as const;
export type GraphMockPinMode = (typeof GRAPH_MOCK_PIN_MODES)[number];

export type GraphMockPin =
  | GraphMockPinMode
  | { outputs: Record<string, unknown> }
  | { fail: GraphErrorCause; message?: string }
  | { outlet: string; outputs?: Record<string, unknown> };

/**
 * Node id → its pin sequence. Ids are plan node ids: a template's own node,
 * or a node inlined from one of its sub-graphs (`review/fix`, item 402).
 */
export type GraphMockPins = Record<string, GraphMockPin[]>;

/** What a mock run carries (`GraphRun.mockOptions`). */
export interface GraphMockRunOptions {
  /** The effective pins: the template's, replaced node by node by the launch's. */
  pins?: GraphMockPins;
  /** Each mock activation reports `running` for this long first (0–10,000 ms; default 0). */
  stepMs?: number;
}

/** The pin kinds, for labels and the designer's choice list. */
export type GraphMockPinKind = GraphMockPinMode | "custom" | "fail" | "outlet";

export function graphMockPinKind(pin: GraphMockPin): GraphMockPinKind {
  if (typeof pin === "string") return pin;
  if ("fail" in pin) return "fail";
  if ("outlet" in pin) return "outlet";
  return "custom";
}

/** A short label: `example`, `generated`, `custom`, `fail: timeout`, `outlet: rejected`, `pause`. */
export function graphMockPinLabel(pin: GraphMockPin): string {
  if (typeof pin === "string") return pin;
  if ("fail" in pin) return `fail: ${pin.fail}`;
  if ("outlet" in pin) return `outlet: ${pin.outlet}`;
  return "custom";
}

/**
 * The pin of a node's `ordinal`-th activation (0-based, per branch), or
 * undefined when the node has none. Past the sequence's end the last pin
 * repeats.
 */
export function graphMockPinAt(
  pins: GraphMockPins | undefined,
  nodeId: string,
  ordinal: number,
): GraphMockPin | undefined {
  const sequence = pins && Object.hasOwn(pins, nodeId) ? pins[nodeId] : undefined;
  if (!sequence || sequence.length === 0) return undefined;
  return sequence[Math.min(Math.max(0, Math.floor(ordinal)), sequence.length - 1)];
}

/** The template's pins with the launch's sequences replacing them node by node. */
export function mergeGraphMockPins(
  stored: GraphMockPins | undefined,
  launch: GraphMockPins | undefined,
): GraphMockPins | undefined {
  const merged: GraphMockPins = { ...stored, ...launch };
  for (const [nodeId, sequence] of Object.entries(merged)) {
    if (sequence.length === 0) delete merged[nodeId];
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

// ---------------------------------------------------------------- shape

function checkPortValues(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
): value is Record<string, unknown> {
  if (!isPlainRecord(value)) {
    errors.add(path, "type", "Expected an object of output values by port name");
    return false;
  }
  const entries = Object.entries(value);
  if (entries.length > GRAPH_TEMPLATE_BOUNDS.maxPortsPerDirection) {
    errors.add(
      path,
      "too_many",
      `At most ${GRAPH_TEMPLATE_BOUNDS.maxPortsPerDirection} ports may be pinned`,
    );
    return false;
  }
  for (const [port] of entries) {
    if (!isGraphKey(port)) errors.add(joinPath(path, port), "pattern", "Not a port name");
  }
  return true;
}

function checkPin(value: unknown, path: string, errors: FieldErrorCollector): void {
  if (typeof value === "string") {
    checkEnum(value, path, errors, GRAPH_MOCK_PIN_MODES);
    return;
  }
  if (!isPlainRecord(value)) {
    errors.add(path, "type", `Expected ${GRAPH_MOCK_PIN_MODES.join(", ")} or a pin object`);
    return;
  }
  if (
    !checkBoundedJson(value, path, errors, {
      maxBytes: GRAPH_MOCK_PIN_BOUNDS.maxPinBytes,
      maxDepth: GRAPH_MOCK_PIN_BOUNDS.maxPinDepth,
    })
  ) {
    return;
  }
  const keys = Object.keys(value);
  const allowed = (fields: readonly string[]) => {
    for (const key of keys) {
      if (!fields.includes(key)) errors.add(joinPath(path, key), "unknown_field", "Unknown field");
    }
  };
  if ("fail" in value) {
    allowed(["fail", "message"]);
    checkEnum(value.fail, joinPath(path, "fail"), errors, GRAPH_ERROR_CAUSES);
    checkGraphText(value.message, joinPath(path, "message"), errors, {
      maxBytes: GRAPH_MOCK_PIN_BOUNDS.maxMessageChars,
      optional: true,
    });
    return;
  }
  if ("outlet" in value) {
    allowed(["outlet", "outputs"]);
    if (typeof value.outlet !== "string" || !isGraphKey(value.outlet)) {
      errors.add(joinPath(path, "outlet"), "pattern", "Expected an outlet name");
    }
    if (value.outputs !== undefined)
      checkPortValues(value.outputs, joinPath(path, "outputs"), errors);
    return;
  }
  if ("outputs" in value) {
    allowed(["outputs"]);
    checkPortValues(value.outputs, joinPath(path, "outputs"), errors);
    return;
  }
  errors.add(path, "type", "Expected outputs, fail or outlet");
}

/** The structural check of a pin record (template and run guards). */
export function checkGraphMockPins(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
): void {
  // Plan node ids: a pin may target a node inlined from a sub-graph (`review/fix`).
  const entries = checkGraphRecord(value, path, errors, {
    max: GRAPH_MOCK_PIN_BOUNDS.maxNodes,
    key: "plan-id",
  });
  if (!entries) return;
  for (const [nodeId, sequence] of entries) {
    const sequencePath = joinPath(path, nodeId);
    if (!Array.isArray(sequence)) {
      errors.add(sequencePath, "type", "Expected a list of pins");
      continue;
    }
    if (sequence.length > GRAPH_MOCK_PIN_BOUNDS.maxPinsPerNode) {
      errors.add(
        sequencePath,
        "too_many",
        `A node takes at most ${GRAPH_MOCK_PIN_BOUNDS.maxPinsPerNode} pins`,
      );
      continue;
    }
    sequence.forEach((pin, index) => checkPin(pin, joinPath(sequencePath, index), errors));
  }
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    encoded = undefined;
  }
  if (encoded === undefined || graphUtf8Bytes(encoded) > GRAPH_MOCK_PIN_BOUNDS.maxPinsBytes) {
    errors.add(
      path,
      "too_large",
      `Pins serialize to at most ${GRAPH_MOCK_PIN_BOUNDS.maxPinsBytes} bytes`,
    );
  }
}

/** The structural check of a run's `mockOptions`. */
export function checkGraphMockRunOptions(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
): void {
  if (!isPlainRecord(value)) {
    errors.add(path, "type", "Expected an object");
    return;
  }
  for (const key of Object.keys(value)) {
    if (key !== "pins" && key !== "stepMs") {
      errors.add(joinPath(path, key), "unknown_field", "Unknown field");
    }
  }
  if (value.pins !== undefined) checkGraphMockPins(value.pins, joinPath(path, "pins"), errors);
  if (
    value.stepMs !== undefined &&
    (!Number.isSafeInteger(value.stepMs) ||
      (value.stepMs as number) < 0 ||
      (value.stepMs as number) > GRAPH_MOCK_PIN_BOUNDS.maxStepMs)
  ) {
    errors.add(
      joinPath(path, "stepMs"),
      "range",
      `Expected an integer from 0 to ${GRAPH_MOCK_PIN_BOUNDS.maxStepMs}`,
    );
  }
}

/** Parses untrusted pins (a command argument); the errors are field-path messages. */
export function parseGraphMockPins(
  value: unknown,
): { ok: true; pins: GraphMockPins } | { ok: false; errors: string[] } {
  const errors = new FieldErrorCollector(20);
  checkGraphMockPins(value, "pins", errors);
  const result = errors.result(value as GraphMockPins);
  if (result.ok) return { ok: true, pins: result.value };
  return {
    ok: false,
    errors: result.errors.map((error) => `${error.path}: ${error.message}`),
  };
}

// ---------------------------------------------------------------- against the graph

/** One output port a pin may set. */
export interface GraphMockPinPort {
  name: string;
  type: string;
  required: boolean;
  choices?: readonly string[];
}

/** One node as pins see it. */
export interface GraphMockPinNode {
  kind: string;
  outputs: readonly GraphMockPinPort[];
  /** Human (and gate) nodes: the outlets. */
  outlets?: readonly string[];
  /** Human `edit` forms: the input the user may edit. */
  edit?: GraphMockPinPort;
}

/** What pins are checked against: each node's kind and ports. */
export interface GraphMockPinTarget {
  library: GraphTypeLibrary;
  nodes: ReadonlyMap<string, GraphMockPinNode>;
  /**
   * A template's sub-graph nodes. Their inlined children (`<id>/...`) exist
   * only once the child is resolved and inlined, so pins on them are checked
   * at launch against the compiled plan, not against the template.
   */
  subgraphs?: ReadonlySet<string>;
}

/** Whether a pin targets a node inlined from one of the target's unresolved sub-graphs. */
function inlinedIntoUnresolved(target: GraphMockPinTarget, nodeId: string): boolean {
  const slash = nodeId.indexOf("/");
  return slash > 0 && target.subgraphs?.has(nodeId.slice(0, slash)) === true;
}

export const GRAPH_MOCK_PIN_ISSUE_CODES = [
  /** No node with this id. */
  "mock-pin-unknown-node",
  /** Gates, merges and sub-graphs take no pins. */
  "mock-pin-node-kind",
  /** The pin's form does not apply to the node's kind (an outlet on an agent). */
  "mock-pin-form",
  /** The node has no output port of that name. */
  "mock-pin-unknown-port",
  /** `null` on a required output. */
  "mock-pin-required-port",
  /** The value fails the port's type. */
  "mock-pin-value",
  /** The human node has no such outlet. */
  "mock-pin-outlet",
] as const;
export type GraphMockPinIssueCode = (typeof GRAPH_MOCK_PIN_ISSUE_CODES)[number];

export interface GraphMockPinIssue {
  code: GraphMockPinIssueCode;
  nodeId: string;
  /** The pin's position in the node's sequence. */
  index?: number;
  port?: string;
  message: string;
  /** `mock-pin-value`: the type's issues (paths and codes, never values). */
  issues?: WorkflowResultValidationIssue[];
}

const PINNABLE = new Set(["agent", "system", "human"]);

/** The targets of a template (the designer). */
export function graphMockPinTargetFromTemplate(template: GraphTemplateV1): GraphMockPinTarget {
  const nodes = new Map<string, GraphMockPinNode>();
  const subgraphs = new Set<string>();
  for (const node of template.nodes) {
    if (node.kind === "subgraph") subgraphs.add(node.id);
    const declared = "outputs" in node ? (node.outputs ?? []) : [];
    const outputs: GraphMockPinPort[] = declared.map((port) => ({
      name: port.name,
      type: port.type,
      required: port.required ?? true,
      ...(port.choices ? { choices: port.choices } : {}),
    }));
    const outlets = graphNodeOutlets(node);
    let edit: GraphMockPinPort | undefined;
    if (node.kind === "human" && node.form.kind === "edit") {
      const name = node.form.edit;
      const input = (node.inputs ?? []).find((port) => port.name === name);
      if (input) edit = { name, type: input.type, required: false };
    }
    nodes.set(node.id, {
      kind: node.kind,
      outputs,
      ...(outlets ? { outlets } : {}),
      ...(edit ? { edit } : {}),
    });
  }
  return { library: new GraphTypeLibrary(template.types ?? []), nodes, subgraphs };
}

/** The targets of a compiled plan (the backend, at launch). */
export function graphMockPinTargetFromPlan(plan: CompiledGraphPlan): GraphMockPinTarget {
  const nodes = new Map<string, GraphMockPinNode>();
  for (const node of plan.nodes) {
    const outputs: GraphMockPinPort[] = node.outputs.map((port) => ({
      name: port.name,
      type: port.type,
      required: port.required,
      ...(port.choices ? { choices: port.choices } : {}),
    }));
    let edit: GraphMockPinPort | undefined;
    if (node.kind === "human" && node.form.kind === "edit") {
      const name = node.form.edit;
      const input = node.inputs.find((port) => port.name === name);
      if (input) edit = { name, type: input.type, required: false };
    }
    nodes.set(node.id, {
      kind: node.kind,
      outputs,
      ...(node.kind === "human" || node.kind === "gate" ? { outlets: node.outlets } : {}),
      ...(edit ? { edit } : {}),
    });
  }
  return { library: new GraphTypeLibrary(plan.types), nodes };
}

function checkValues(
  target: GraphMockPinTarget,
  nodeId: string,
  index: number,
  values: Record<string, unknown>,
  ports: readonly GraphMockPinPort[],
  issues: GraphMockPinIssue[],
): void {
  for (const [name, value] of Object.entries(values)) {
    const port = ports.find((candidate) => candidate.name === name);
    if (!port) {
      issues.push({
        code: "mock-pin-unknown-port",
        nodeId,
        index,
        port: name,
        message: `${nodeId} has no output ${name} to pin`,
      });
      continue;
    }
    if (value === null) {
      if (port.required) {
        issues.push({
          code: "mock-pin-required-port",
          nodeId,
          index,
          port: name,
          message: `${name} is required, so it cannot be left unproduced`,
        });
      }
      continue;
    }
    const resolved = target.library.resolve(port.type);
    if (!resolved.ok || resolved.type.kind !== "named") continue;
    const problems = validateGraphArtifactValue(
      resolved.type.definition,
      value,
      port.choices ? { choices: port.choices } : {},
    );
    if (problems.length > 0) {
      issues.push({
        code: "mock-pin-value",
        nodeId,
        index,
        port: name,
        message: `The value for ${name} fails ${port.type}: ${problems
          .slice(0, 3)
          .map((problem) => `${problem.path} ${problem.code}`)
          .join(", ")}`,
        issues: problems.slice(0, 8),
      });
    }
  }
}

/**
 * Checks pins against the graph: the nodes exist and take pins, each pin's
 * form fits the node, named ports exist and custom values pass their port's
 * type (with a decision port's choices). A ticket's criteria are not known
 * here, so a verdict's criterion ids are checked when the mock stores it.
 */
export function graphMockPinIssues(
  target: GraphMockPinTarget,
  pins: GraphMockPins | undefined,
): GraphMockPinIssue[] {
  const issues: GraphMockPinIssue[] = [];
  for (const [nodeId, sequence] of Object.entries(pins ?? {})) {
    const node = target.nodes.get(nodeId);
    if (!node && inlinedIntoUnresolved(target, nodeId)) continue;
    if (!node) {
      issues.push({
        code: "mock-pin-unknown-node",
        nodeId,
        message: `The graph has no node ${nodeId}`,
      });
      continue;
    }
    if (!PINNABLE.has(node.kind)) {
      issues.push({
        code: "mock-pin-node-kind",
        nodeId,
        message: `${node.kind} nodes run as they would in a real run and take no pins`,
      });
      continue;
    }
    sequence.forEach((pin, index) => {
      const kind = graphMockPinKind(pin);
      const human = node.kind === "human";
      const fits =
        kind === "fail" ||
        (human
          ? kind === "outlet" || kind === "pause" || kind === "example"
          : kind !== "outlet" && kind !== "pause");
      if (!fits) {
        issues.push({
          code: "mock-pin-form",
          nodeId,
          index,
          message: human
            ? "A human node takes an outlet, pause, example (the default answer) or fail"
            : `A ${node.kind} node takes example, generated, custom outputs or fail`,
        });
        return;
      }
      if (typeof pin === "string" || "fail" in pin) return;
      if ("outlet" in pin) {
        if (!node.outlets?.includes(pin.outlet)) {
          issues.push({
            code: "mock-pin-outlet",
            nodeId,
            index,
            message: `${nodeId} has no outlet ${pin.outlet} (outlets: ${(node.outlets ?? []).join(", ")})`,
          });
        }
        if (pin.outputs) {
          checkValues(target, nodeId, index, pin.outputs, node.edit ? [node.edit] : [], issues);
        }
        return;
      }
      checkValues(target, nodeId, index, pin.outputs, node.outputs, issues);
    });
  }
  return issues;
}
