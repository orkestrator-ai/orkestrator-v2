/**
 * Structural guards for graph nodes, ports and their execution settings.
 * `template.ts` calls `checkGraphNode` once per node; everything here checks
 * one node in isolation. References between nodes (edges, roles, sessions,
 * loop members, outlets used by edges) are the compiler's (item 107), so its
 * diagnostics can be pinned to a node or an edge.
 */
import {
  FieldErrorCollector,
  checkEnum,
  checkFiniteNumber,
  checkObject,
  isPlainRecord,
  joinPath,
} from "../field-validation.js";
import {
  GRAPH_DIGEST_PATTERN,
  GRAPH_TEMPLATE_BOUNDS as B,
  GraphNameScope,
  checkGraphBoolean,
  checkGraphDescription,
  checkGraphEnumValue,
  checkGraphFieldPath,
  checkGraphId,
  checkGraphInteger,
  checkGraphKey,
  checkGraphLabel,
  checkGraphList,
  checkGraphRecord,
  checkGraphText,
  checkGraphTypeRef,
  checkPresent,
  parseGraphTypeRef,
} from "./grammar.js";
import { checkGraphPredicate } from "./predicate-shape.js";
import {
  GRAPH_CAPABILITIES,
  GRAPH_CAPABILITY_PROFILES,
  GRAPH_COLLECT_WAITS,
  GRAPH_ENFORCEMENT_TIERS,
  GRAPH_FAILURE_POLICIES,
  GRAPH_HUMAN_FORMS,
  GRAPH_MERGE_STRATEGIES,
  GRAPH_NODE_KINDS,
  GRAPH_ORKESTRATOR_CAPABILITY_GROUPS,
  GRAPH_PROVENANCE_MODES,
  GRAPH_RENDER_MODES,
  GRAPH_REPLICATE_SOURCES,
  GRAPH_RETRY_CAUSES,
  GRAPH_SYSTEM_ACTIONS,
  GRAPH_TEMPLATE_SCOPES,
  GRAPH_VOTE_TIE_POLICIES,
  GRAPH_WORKSPACE_ACCESS,
  GRAPH_WORKSPACE_ISOLATION,
} from "./template-model.js";

// ------------------------------------------------------------- shared pieces

/** A required enum field; reports `required` when missing. */
export function checkRequiredEnum<T extends string>(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  allowed: readonly T[],
): value is T {
  return checkPresent(value, path, errors) && checkEnum(value, path, errors, allowed);
}

function checkOptionalEnum<T extends string>(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  allowed: readonly T[],
): void {
  if (value !== undefined) checkEnum(value, path, errors, allowed);
}

/** `{ node, port, outlet? }`, or also `{ input }` when `allowRunInput`. */
export function checkGraphEndpoint(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  options: { allowRunInput: boolean; allowOutlet: boolean },
): void {
  if (!checkPresent(value, path, errors)) return;
  if (options.allowRunInput && isPlainRecord(value) && "input" in value) {
    if (checkObject(value, path, ["input"], errors)) {
      checkGraphKey(value.input, joinPath(path, "input"), errors);
    }
    return;
  }
  const fields = options.allowOutlet ? ["node", "port", "outlet"] : ["node", "port"];
  if (!checkObject(value, path, fields, errors)) return;
  checkGraphId(value.node, joinPath(path, "node"), errors);
  checkGraphKey(value.port, joinPath(path, "port"), errors);
  if (value.outlet !== undefined) checkGraphKey(value.outlet, joinPath(path, "outlet"), errors);
}

function checkTimeout(value: unknown, path: string, errors: FieldErrorCollector): void {
  checkGraphInteger(value, path, errors, B.minTimeoutMs, B.maxTimeoutMs, true);
}

function checkRetry(value: unknown, path: string, errors: FieldErrorCollector): void {
  if (value === undefined) return;
  if (!checkObject(value, path, ["attempts", "on"], errors)) return;
  checkGraphInteger(value.attempts, joinPath(path, "attempts"), errors, 1, B.maxRetryAttempts);
  const onPath = joinPath(path, "on");
  if (checkGraphList(value.on, onPath, errors, { min: 1, max: GRAPH_RETRY_CAUSES.length })) {
    const scope = new GraphNameScope(errors, "retry cause");
    (value.on as unknown[]).forEach((cause, index) => {
      const causePath = joinPath(onPath, index);
      if (checkEnum(cause, causePath, errors, GRAPH_RETRY_CAUSES)) scope.add(cause, causePath);
    });
  }
}

// --------------------------------------------------------------------- ports

function checkCollect(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  listTyped: boolean | undefined,
): void {
  if (!checkObject(value, path, ["wait", "count", "minSuccessful", "includeFailures"], errors)) {
    return;
  }
  if (listTyped === false) {
    errors.add(path, "collect_requires_list", "collect applies only to list<…> inputs");
  }
  const waitPath = joinPath(path, "wait");
  const wait = checkRequiredEnum(value.wait, waitPath, errors, GRAPH_COLLECT_WAITS)
    ? value.wait
    : undefined;
  const countPath = joinPath(path, "count");
  if (wait === "all-settled" && value.count !== undefined) {
    errors.add(countPath, "not_applicable", "count is not used with wait: all-settled");
  } else if (wait === "quorum" && value.count === undefined) {
    errors.add(countPath, "required", "wait: quorum needs a count");
  } else {
    checkGraphInteger(value.count, countPath, errors, 1, B.maxBranches, true);
  }
  const minPath = joinPath(path, "minSuccessful");
  if (checkGraphInteger(value.minSuccessful, minPath, errors, 0, B.maxBranches)) {
    if (typeof value.count === "number" && (value.minSuccessful as number) > value.count) {
      errors.add(minPath, "out_of_range", "minSuccessful must not exceed count");
    }
  }
  checkGraphBoolean(value.includeFailures, joinPath(path, "includeFailures"), errors, false);
}

const INPUT_PORT_FIELDS = [
  "name",
  "type",
  "label",
  "description",
  "required",
  "render",
  "collect",
  "firstIterationFrom",
] as const;
const OUTPUT_PORT_FIELDS = [
  "name",
  "type",
  "label",
  "description",
  "required",
  "provenance",
  "choices",
] as const;

function checkPort(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  direction: "input" | "output",
  scope: GraphNameScope,
): void {
  const fields = direction === "input" ? INPUT_PORT_FIELDS : OUTPUT_PORT_FIELDS;
  if (!checkObject(value, path, fields, errors)) return;
  const namePath = joinPath(path, "name");
  if (checkGraphKey(value.name, namePath, errors)) scope.add(value.name, namePath);
  const typePath = joinPath(path, "type");
  const typed = checkGraphTypeRef(value.type, typePath, errors);
  const listTyped = typed ? parseGraphTypeRef(value.type as string)!.listDepth > 0 : undefined;
  checkGraphLabel(value.label, joinPath(path, "label"), errors);
  checkGraphDescription(
    value.description,
    joinPath(path, "description"),
    errors,
    B.maxPortDescriptionBytes,
  );
  checkGraphBoolean(value.required, joinPath(path, "required"), errors);
  if (direction === "input") {
    checkOptionalEnum(value.render, joinPath(path, "render"), errors, GRAPH_RENDER_MODES);
    if (value.collect !== undefined) {
      checkCollect(value.collect, joinPath(path, "collect"), errors, listTyped);
    }
    if (value.firstIterationFrom !== undefined) {
      checkGraphEndpoint(value.firstIterationFrom, joinPath(path, "firstIterationFrom"), errors, {
        allowRunInput: true,
        allowOutlet: true,
      });
    }
  } else {
    checkOptionalEnum(
      value.provenance,
      joinPath(path, "provenance"),
      errors,
      GRAPH_PROVENANCE_MODES,
    );
    if (value.choices !== undefined) {
      checkDecisionChoices(value.choices, joinPath(path, "choices"), errors, value.type);
    }
  }
}

/** A decision output's options: 2 to 32 distinct enum-grammar values. */
function checkDecisionChoices(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  type: unknown,
): void {
  const parsed = typeof type === "string" ? parseGraphTypeRef(type) : null;
  if (parsed && (parsed.name !== "decision" || parsed.listDepth > 0)) {
    errors.add(path, "not_applicable", "choices apply only to decision outputs");
    return;
  }
  if (!checkGraphList(value, path, errors, { min: 2, max: B.maxEnumOptions })) return;
  const scope = new GraphNameScope(errors, "choice");
  (value as unknown[]).forEach((choice, index) => {
    const choicePath = joinPath(path, index);
    if (checkGraphEnumValue(choice, choicePath, errors)) scope.add(choice, choicePath);
  });
}

/** Check a node's port list; returns the valid port names. */
function checkPorts(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  direction: "input" | "output",
  min = 0,
): GraphNameScope {
  const scope = new GraphNameScope(errors, `${direction} port`);
  if (value === undefined && min === 0) return scope;
  if (checkGraphList(value, path, errors, { min, max: B.maxPortsPerDirection })) {
    (value as unknown[]).forEach((port, index) =>
      checkPort(port, joinPath(path, index), errors, direction, scope),
    );
  }
  return scope;
}

// -------------------------------------------------------------- agent pieces

function checkPrompt(value: unknown, path: string, errors: FieldErrorCollector): void {
  if (!checkPresent(value, path, errors)) return;
  if (isPlainRecord(value) && "builtIn" in value) {
    if (checkObject(value, path, ["builtIn"], errors)) {
      checkGraphId(value.builtIn, joinPath(path, "builtIn"), errors);
    }
    return;
  }
  if (!checkObject(value, path, ["template"], errors)) return;
  checkGraphText(value.template, joinPath(path, "template"), errors, {
    maxBytes: B.maxPromptTemplateBytes,
    multiline: true,
  });
}

function isCapabilityName(value: string): boolean {
  if ((GRAPH_CAPABILITIES as readonly string[]).includes(value)) return true;
  if (value.startsWith("orkestrator:")) {
    return (GRAPH_ORKESTRATOR_CAPABILITY_GROUPS as readonly string[]).includes(value.slice(12));
  }
  if (value.startsWith("mcp:")) {
    const server = value.slice(4);
    return (
      server.length > 0 &&
      server.length <= B.maxEnumValueChars &&
      /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(server)
    );
  }
  return false;
}

function checkCapabilities(value: unknown, path: string, errors: FieldErrorCollector): void {
  if (!checkPresent(value, path, errors)) return;
  if (!checkObject(value, path, ["profile", "allow", "deny"], errors)) return;
  checkRequiredEnum(value.profile, joinPath(path, "profile"), errors, GRAPH_CAPABILITY_PROFILES);
  const seen = new Map<string, string>();
  for (const list of ["allow", "deny"] as const) {
    const listPath = joinPath(path, list);
    if (
      !checkGraphList(value[list], listPath, errors, {
        max: B.maxCapabilityOverrides,
        optional: true,
      })
    ) {
      continue;
    }
    (value[list] as unknown[]).forEach((entry, index) => {
      const entryPath = joinPath(listPath, index);
      if (typeof entry !== "string" || !isCapabilityName(entry)) {
        errors.add(
          entryPath,
          "capability",
          "Expected a capability: a native capability, git.commit, git.push, github.write, subagents, mcp:<server> or orkestrator:<group>",
        );
        return;
      }
      const previous = seen.get(entry);
      if (previous !== undefined) {
        errors.add(
          entryPath,
          previous === list ? "duplicate" : "conflict",
          previous === list
            ? `Duplicate capability "${entry}"`
            : `Capability "${entry}" is both allowed and denied`,
        );
        return;
      }
      seen.set(entry, list);
    });
  }
}

function checkSession(value: unknown, path: string, errors: FieldErrorCollector): void {
  if (value === undefined) return;
  if (!isPlainRecord(value)) {
    errors.add(path, "type", "Expected an object");
    return;
  }
  if (value.mode === "continue") {
    if (checkObject(value, path, ["mode", "from"], errors)) {
      checkGraphId(value.from, joinPath(path, "from"), errors);
    }
    return;
  }
  if (checkObject(value, path, ["mode"], errors)) {
    checkRequiredEnum(value.mode, joinPath(path, "mode"), errors, ["fresh", "continue"] as const);
  }
}

function checkLens(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  scope: GraphNameScope,
): void {
  if (!checkObject(value, path, ["key", "label", "instruction", "role"], errors)) return;
  const keyPath = joinPath(path, "key");
  if (checkGraphId(value.key, keyPath, errors)) scope.add(value.key, keyPath);
  checkGraphText(value.label, joinPath(path, "label"), errors, {
    maxBytes: B.maxLabelBytes,
    maxChars: B.maxLensLabelChars,
  });
  checkGraphText(value.instruction, joinPath(path, "instruction"), errors, {
    maxBytes: B.maxLensInstructionBytes,
    multiline: true,
  });
  if (value.role !== undefined) checkGraphId(value.role, joinPath(path, "role"), errors);
}

function checkReplicateAxis(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  inputs: GraphNameScope,
): string | undefined {
  if (!isPlainRecord(value)) {
    errors.add(path, "type", "Expected an object");
    return undefined;
  }
  const overPath = joinPath(path, "over");
  if (!checkRequiredEnum(value.over, overPath, errors, GRAPH_REPLICATE_SOURCES)) return undefined;
  switch (value.over) {
    case "panel":
      if (checkObject(value, path, ["over", "role"], errors)) {
        checkGraphId(value.role, joinPath(path, "role"), errors);
      }
      break;
    case "lenses": {
      if (!checkObject(value, path, ["over", "lenses"], errors)) break;
      const lensesPath = joinPath(path, "lenses");
      if (checkGraphList(value.lenses, lensesPath, errors, { min: 1, max: B.maxBranches })) {
        const scope = new GraphNameScope(errors, "lens key");
        (value.lenses as unknown[]).forEach((lens, index) =>
          checkLens(lens, joinPath(lensesPath, index), errors, scope),
        );
      }
      break;
    }
    case "items":
      if (checkObject(value, path, ["over", "input", "maxBranches"], errors)) {
        const inputPath = joinPath(path, "input");
        if (checkGraphKey(value.input, inputPath, errors) && !inputs.has(value.input)) {
          errors.add(inputPath, "unknown_port", "Must name one of this node's input ports");
        }
        checkGraphInteger(
          value.maxBranches,
          joinPath(path, "maxBranches"),
          errors,
          1,
          B.maxBranches,
        );
      }
      break;
    case "samples":
      if (checkObject(value, path, ["over", "count"], errors)) {
        checkGraphInteger(value.count, joinPath(path, "count"), errors, 1, B.maxBranches);
      }
      break;
  }
  return value.over as string;
}

function checkReplicate(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  inputs: GraphNameScope,
): void {
  if (value === undefined) return;
  if (isPlainRecord(value) && value.over === "cross") {
    if (!checkObject(value, path, ["over", "axes"], errors)) return;
    const axesPath = joinPath(path, "axes");
    if (!checkGraphList(value.axes, axesPath, errors, { min: 2, max: B.maxReplicateAxes })) return;
    const scope = new GraphNameScope(errors, "replicate source");
    (value.axes as unknown[]).forEach((axis, index) => {
      const axisPath = joinPath(axesPath, index);
      if (isPlainRecord(axis) && axis.over === "cross") {
        errors.add(joinPath(axisPath, "over"), "nested_cross", "cross axes cannot nest");
        return;
      }
      const over = checkReplicateAxis(axis, axisPath, errors, inputs);
      if (over !== undefined) scope.add(over, joinPath(axisPath, "over"));
    });
    return;
  }
  checkReplicateAxis(value, path, errors, inputs);
}

// ------------------------------------------------------------- system pieces

function checkSystemParamScalar(value: unknown, path: string, errors: FieldErrorCollector): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    checkFiniteNumber(value, path, errors, { maxAbs: B.maxNumberAbs });
    return;
  }
  if (typeof value === "string") {
    checkGraphText(value, path, errors, {
      maxBytes: B.maxSystemParamStringBytes,
      multiline: true,
      allowEmpty: true,
    });
    return;
  }
  errors.add(path, "type", "Expected a string, number, boolean or null");
}

function checkSystemParams(value: unknown, path: string, errors: FieldErrorCollector): void {
  if (value === undefined) return;
  const entries = checkGraphRecord(value, path, errors, { max: B.maxSystemParams, key: "key" });
  for (const [key, entry] of entries ?? []) {
    const entryPath = joinPath(path, key);
    if (Array.isArray(entry)) {
      if (entry.length > B.maxSystemParamListItems) {
        errors.add(
          entryPath,
          "too_many",
          `Must contain at most ${B.maxSystemParamListItems} entries`,
        );
        continue;
      }
      entry.forEach((item, index) =>
        checkSystemParamScalar(item, joinPath(entryPath, index), errors),
      );
    } else {
      checkSystemParamScalar(entry, entryPath, errors);
    }
  }
}

// ---------------------------------------------------------- gate/merge/human

function checkOutletName(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  outlets: GraphNameScope,
): void {
  if (checkGraphKey(value, path, errors)) outlets.add(value, path);
}

function checkGateFields(
  node: Record<string, unknown>,
  path: string,
  errors: FieldErrorCollector,
): void {
  const outlets = new GraphNameScope(errors, "outlet");
  const branchesPath = joinPath(path, "branches");
  if (checkGraphList(node.branches, branchesPath, errors, { min: 1, max: B.maxGateBranches })) {
    (node.branches as unknown[]).forEach((branch, index) => {
      const branchPath = joinPath(branchesPath, index);
      if (!checkObject(branch, branchPath, ["to", "when", "label"], errors)) return;
      checkOutletName(branch.to, joinPath(branchPath, "to"), errors, outlets);
      checkGraphPredicate(branch.when, joinPath(branchPath, "when"), errors);
      checkGraphLabel(branch.label, joinPath(branchPath, "label"), errors);
    });
  }
  if (node.otherwise !== undefined) {
    checkOutletName(node.otherwise, joinPath(path, "otherwise"), errors, outlets);
  }
}

function checkMergeStrategy(value: unknown, path: string, errors: FieldErrorCollector): void {
  if (!checkPresent(value, path, errors)) return;
  if (!isPlainRecord(value)) {
    errors.add(path, "type", "Expected an object");
    return;
  }
  if (!checkRequiredEnum(value.kind, joinPath(path, "kind"), errors, GRAPH_MERGE_STRATEGIES)) {
    return;
  }
  switch (value.kind) {
    case "concat":
    case "collect":
      checkObject(value, path, ["kind"], errors);
      break;
    case "dedupe": {
      if (!checkObject(value, path, ["kind", "key"], errors)) break;
      const keyPath = joinPath(path, "key");
      if (checkGraphList(value.key, keyPath, errors, { min: 1, max: B.maxMergeKeyPaths })) {
        const scope = new GraphNameScope(errors, "key path");
        (value.key as unknown[]).forEach((entry, index) => {
          const entryPath = joinPath(keyPath, index);
          if (checkGraphFieldPath(entry, entryPath, errors)) scope.add(entry, entryPath);
        });
      }
      break;
    }
    case "vote":
      if (!checkObject(value, path, ["kind", "tie", "path"], errors)) break;
      checkRequiredEnum(value.tie, joinPath(path, "tie"), errors, GRAPH_VOTE_TIE_POLICIES);
      if (value.path !== undefined) checkGraphFieldPath(value.path, joinPath(path, "path"), errors);
      break;
    case "best":
      if (!checkObject(value, path, ["kind", "score", "prefer"], errors)) break;
      checkGraphFieldPath(value.score, joinPath(path, "score"), errors);
      checkOptionalEnum(value.prefer, joinPath(path, "prefer"), errors, [
        "highest",
        "lowest",
      ] as const);
      break;
  }
}

function checkHumanForm(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  inputs: GraphNameScope,
): void {
  if (!checkPresent(value, path, errors)) return;
  if (!isPlainRecord(value)) {
    errors.add(path, "type", "Expected an object");
    return;
  }
  if (!checkRequiredEnum(value.kind, joinPath(path, "kind"), errors, GRAPH_HUMAN_FORMS)) return;
  const fields =
    value.kind === "edit"
      ? ["kind", "edit", "instructions"]
      : value.kind === "choose"
        ? ["kind", "options", "instructions"]
        : ["kind", "instructions"];
  if (!checkObject(value, path, fields, errors)) return;
  checkGraphDescription(
    value.instructions,
    joinPath(path, "instructions"),
    errors,
    B.maxHumanInstructionsBytes,
  );
  if (value.kind === "edit") {
    const editPath = joinPath(path, "edit");
    if (checkGraphKey(value.edit, editPath, errors) && !inputs.has(value.edit)) {
      errors.add(editPath, "unknown_port", "Must name one of this node's input ports");
    }
  }
  if (value.kind === "choose") {
    const optionsPath = joinPath(path, "options");
    if (checkGraphList(value.options, optionsPath, errors, { min: 2, max: B.maxChooseOptions })) {
      const outlets = new GraphNameScope(errors, "outlet");
      (value.options as unknown[]).forEach((option, index) => {
        const optionPath = joinPath(optionsPath, index);
        if (!checkObject(option, optionPath, ["to", "label", "description"], errors)) return;
        checkOutletName(option.to, joinPath(optionPath, "to"), errors, outlets);
        checkGraphLabel(option.label, joinPath(optionPath, "label"), errors, false);
        checkGraphDescription(option.description, joinPath(optionPath, "description"), errors);
      });
    }
  }
}

// ------------------------------------------------------------ subgraph pieces

/**
 * A project template file (`isGraphProjectTemplatePath` in library.ts, which
 * imports this module and so cannot be imported here; a test keeps them equal).
 */
export const GRAPH_PROJECT_TEMPLATE_PATH =
  /^\.orkestrator\/graphs\/[A-Za-z0-9][A-Za-z0-9._-]{0,116}\.graph\.json$/;

function checkSubgraphFields(
  node: Record<string, unknown>,
  path: string,
  errors: FieldErrorCollector,
): void {
  const templatePath = joinPath(path, "template");
  if (
    checkPresent(node.template, templatePath, errors) &&
    checkObject(node.template, templatePath, ["scope", "id", "revision", "digest", "path"], errors)
  ) {
    checkRequiredEnum(
      node.template.scope,
      joinPath(templatePath, "scope"),
      errors,
      GRAPH_TEMPLATE_SCOPES,
    );
    checkGraphId(node.template.id, joinPath(templatePath, "id"), errors);
    checkGraphInteger(
      node.template.revision,
      joinPath(templatePath, "revision"),
      errors,
      0,
      Number.MAX_SAFE_INTEGER,
      true,
    );
    const digest = node.template.digest;
    if (
      digest !== undefined &&
      (typeof digest !== "string" || !GRAPH_DIGEST_PATTERN.test(digest))
    ) {
      errors.add(
        joinPath(templatePath, "digest"),
        "pattern",
        "Must be a lower-case SHA-256 hex digest",
      );
    }
    const file = node.template.path;
    if (file !== undefined) {
      if (typeof file !== "string" || !GRAPH_PROJECT_TEMPLATE_PATH.test(file)) {
        errors.add(
          joinPath(templatePath, "path"),
          "pattern",
          "Must name a file in .orkestrator/graphs ending in .graph.json",
        );
      } else if (node.template.scope !== "project") {
        errors.add(
          joinPath(templatePath, "path"),
          "not_applicable",
          "Only a project template has a path",
        );
      }
    }
  }
  if (node.params !== undefined) {
    const paramsPath = joinPath(path, "params");
    const entries = checkGraphRecord(node.params, paramsPath, errors, {
      max: B.maxSubgraphParamBindings,
      key: "key",
    });
    for (const [key, binding] of entries ?? []) {
      const bindingPath = joinPath(paramsPath, key);
      if (isPlainRecord(binding)) {
        if (checkObject(binding, bindingPath, ["param"], errors)) {
          checkGraphKey(binding.param, joinPath(bindingPath, "param"), errors);
        }
      } else {
        checkSystemParamScalar(binding, bindingPath, errors);
      }
    }
  }
  if (node.roles !== undefined) {
    const rolesPath = joinPath(path, "roles");
    const entries = checkGraphRecord(node.roles, rolesPath, errors, {
      max: B.maxSubgraphRoleBindings,
      key: "id",
    });
    for (const [key, role] of entries ?? []) checkGraphId(role, joinPath(rolesPath, key), errors);
  }
}

// --------------------------------------------------------------------- nodes

const COMMON_FIELDS = ["kind", "id", "label", "description", "inputs", "when"] as const;
const EXECUTION_FIELDS = ["retry", "timeoutMs", "onFailure"] as const;

const NODE_FIELDS: Record<(typeof GRAPH_NODE_KINDS)[number], readonly string[]> = {
  agent: [
    ...COMMON_FIELDS,
    ...EXECUTION_FIELDS,
    "outputs",
    "role",
    "prompt",
    "capabilities",
    "workspaceAccess",
    "isolation",
    "minEnforcement",
    "session",
    "replicate",
    "askHuman",
  ],
  system: [...COMMON_FIELDS, ...EXECUTION_FIELDS, "outputs", "action", "params"],
  gate: [...COMMON_FIELDS, "branches", "otherwise"],
  merge: [...COMMON_FIELDS, "outputs", "strategy", "onFailure"],
  human: [...COMMON_FIELDS, "form", "timeoutMs", "onFailure"],
  subgraph: [
    ...COMMON_FIELDS,
    ...EXECUTION_FIELDS,
    "outputs",
    "template",
    "params",
    "roles",
    "replicate",
  ],
};

/**
 * Structural guard for one node at `path`. Returns the node id when it is
 * well-formed enough to be indexed by the caller's uniqueness checks.
 */
export function checkGraphNode(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
): string | undefined {
  if (!isPlainRecord(value)) {
    errors.add(path, "type", "Expected an object");
    return undefined;
  }
  const kindPath = joinPath(path, "kind");
  if (!checkRequiredEnum(value.kind, kindPath, errors, GRAPH_NODE_KINDS)) return undefined;
  const kind = value.kind;
  if (!checkObject(value, path, NODE_FIELDS[kind], errors)) return undefined;

  const idPath = joinPath(path, "id");
  const id = checkGraphId(value.id, idPath, errors) ? value.id : undefined;
  checkGraphLabel(value.label, joinPath(path, "label"), errors);
  checkGraphDescription(value.description, joinPath(path, "description"), errors);
  const needsInput = kind === "gate" || kind === "merge" || kind === "human";
  const inputs = checkPorts(
    value.inputs,
    joinPath(path, "inputs"),
    errors,
    "input",
    needsInput ? 1 : 0,
  );
  if (value.outputs !== undefined) {
    checkPorts(value.outputs, joinPath(path, "outputs"), errors, "output");
  }
  if (value.when !== undefined) checkGraphPredicate(value.when, joinPath(path, "when"), errors);
  checkRetry(value.retry, joinPath(path, "retry"), errors);
  checkTimeout(value.timeoutMs, joinPath(path, "timeoutMs"), errors);
  checkOptionalEnum(value.onFailure, joinPath(path, "onFailure"), errors, GRAPH_FAILURE_POLICIES);

  switch (kind) {
    case "agent":
      checkGraphId(value.role, joinPath(path, "role"), errors);
      checkPrompt(value.prompt, joinPath(path, "prompt"), errors);
      checkCapabilities(value.capabilities, joinPath(path, "capabilities"), errors);
      checkRequiredEnum(
        value.workspaceAccess,
        joinPath(path, "workspaceAccess"),
        errors,
        GRAPH_WORKSPACE_ACCESS,
      );
      checkOptionalEnum(
        value.isolation,
        joinPath(path, "isolation"),
        errors,
        GRAPH_WORKSPACE_ISOLATION,
      );
      checkOptionalEnum(
        value.minEnforcement,
        joinPath(path, "minEnforcement"),
        errors,
        GRAPH_ENFORCEMENT_TIERS,
      );
      checkSession(value.session, joinPath(path, "session"), errors);
      checkReplicate(value.replicate, joinPath(path, "replicate"), errors, inputs);
      checkGraphBoolean(value.askHuman, joinPath(path, "askHuman"), errors);
      break;
    case "system":
      checkRequiredEnum(value.action, joinPath(path, "action"), errors, GRAPH_SYSTEM_ACTIONS);
      checkSystemParams(value.params, joinPath(path, "params"), errors);
      break;
    case "gate":
      checkGateFields(value, path, errors);
      break;
    case "merge":
      checkMergeStrategy(value.strategy, joinPath(path, "strategy"), errors);
      break;
    case "human":
      checkHumanForm(value.form, joinPath(path, "form"), errors, inputs);
      break;
    case "subgraph":
      checkSubgraphFields(value, path, errors);
      checkReplicate(value.replicate, joinPath(path, "replicate"), errors, inputs);
      break;
  }
  return id;
}
