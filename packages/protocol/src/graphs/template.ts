/**
 * GraphTemplateV1 guard (plan P1.1).
 *
 * `validateGraphTemplate` answers "is this a well-formed, bounded template
 * document?": every field is known, every name follows its grammar, every
 * string and list is within `GRAPH_TEMPLATE_BOUNDS`, names are unique in their
 * scope, and fields that only make sense together agree. It does not check
 * references between parts (edges to nodes and ports, roles, loop members,
 * session sources, type resolution) or graph rules (cycles, workspace
 * concurrency, cardinality): the compiler (item 107) owns those, so its
 * diagnostics can be pinned to a node or an edge. Errors carry stable field
 * paths such as `nodes[3].replicate.lenses[0].label`.
 */
import {
  FieldErrorCollector,
  checkEnum,
  checkFiniteNumber,
  checkObject,
  isPlainRecord,
  joinPath,
  jsonDepthExceeds,
  type FieldValidation,
} from "../field-validation.js";
import { parseStrictJson } from "../canonical-json.js";
import { parseUtcTimestamp } from "../workflow-snapshot.js";
import { checkArtifactTypeDef } from "./artifact-type-def.js";
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
  graphUtf8Bytes,
} from "./grammar.js";
import { checkGraphPredicate } from "./predicate-shape.js";
import { checkGraphEndpoint, checkGraphNode, checkRequiredEnum } from "./template-nodes.js";
import {
  GRAPH_ACKNOWLEDGEMENT_KINDS,
  GRAPH_EDGE_TRANSFORM_OPS,
  GRAPH_ENVIRONMENT_KINDS,
  GRAPH_PARAMETER_TYPES,
  GRAPH_ROLE_DEFAULT_ACTION_KEYS,
  GRAPH_ROLE_MULTIPLICITIES,
  GRAPH_ROLE_PANEL_DEFAULT_SOURCES,
  GRAPH_TEMPLATE_ENGINES,
  GRAPH_TEMPLATE_FORMAT,
  GRAPH_TEMPLATE_FORMAT_VERSION,
  type GraphTemplateV1,
} from "./template-model.js";

export * from "./template-model.js";
export type { ArtifactTypeDef } from "./artifact-type-def.js";
export type { GraphPredicate } from "./predicate-shape.js";

/** Field errors reported per validation; the rest are counted in `omittedErrors`. */
export const GRAPH_TEMPLATE_MAX_ERRORS = 50;

const TEMPLATE_FIELDS = [
  "format",
  "formatVersion",
  "id",
  "revision",
  "name",
  "description",
  "engine",
  "parameters",
  "roles",
  "types",
  "inputs",
  "outputs",
  "workspace",
  "nodes",
  "edges",
  "loops",
  "limits",
  "layout",
  "acknowledgements",
] as const;

// ---------------------------------------------------------------- parameters

function checkParameter(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  scope: GraphNameScope,
): void {
  if (!isPlainRecord(value)) {
    errors.add(path, "type", "Expected an object");
    return;
  }
  if (!checkRequiredEnum(value.type, joinPath(path, "type"), errors, GRAPH_PARAMETER_TYPES)) return;
  const base = ["key", "label", "description", "type", "default"];
  const extra =
    value.type === "integer" || value.type === "number"
      ? ["min", "max"]
      : value.type === "string"
        ? ["maxBytes"]
        : value.type === "enum"
          ? ["options"]
          : [];
  if (!checkObject(value, path, [...base, ...extra], errors)) return;
  const keyPath = joinPath(path, "key");
  if (checkGraphKey(value.key, keyPath, errors)) scope.add(value.key, keyPath);
  checkGraphLabel(value.label, joinPath(path, "label"), errors);
  checkGraphDescription(value.description, joinPath(path, "description"), errors);
  const defaultPath = joinPath(path, "default");

  switch (value.type) {
    case "boolean":
      checkGraphBoolean(value.default, defaultPath, errors);
      break;
    case "integer":
    case "number": {
      const integer = value.type === "integer";
      const bounds: Record<"min" | "max" | "default", number | undefined> = {
        min: undefined,
        max: undefined,
        default: undefined,
      };
      for (const field of ["min", "max", "default"] as const) {
        const fieldValue = value[field];
        if (fieldValue === undefined) continue;
        if (
          checkFiniteNumber(fieldValue, joinPath(path, field), errors, {
            integer,
            maxAbs: B.maxNumberAbs,
          })
        ) {
          bounds[field] = fieldValue as number;
        }
      }
      if (bounds.min !== undefined && bounds.max !== undefined && bounds.min > bounds.max) {
        errors.add(joinPath(path, "max"), "out_of_range", "max must not be below min");
      } else if (bounds.default !== undefined) {
        if (
          (bounds.min !== undefined && bounds.default < bounds.min) ||
          (bounds.max !== undefined && bounds.default > bounds.max)
        ) {
          errors.add(defaultPath, "out_of_range", "default must lie between min and max");
        }
      }
      break;
    }
    case "string": {
      const maxPath = joinPath(path, "maxBytes");
      const maxBytes = checkGraphInteger(
        value.maxBytes,
        maxPath,
        errors,
        1,
        B.maxStringParameterBytes,
        true,
      )
        ? ((value.maxBytes as number | undefined) ?? B.maxStringParameterBytes)
        : B.maxStringParameterBytes;
      checkGraphText(value.default, defaultPath, errors, {
        maxBytes,
        multiline: true,
        optional: true,
        allowEmpty: true,
      });
      break;
    }
    case "enum": {
      const optionsPath = joinPath(path, "options");
      const options = new GraphNameScope(errors, "option");
      if (checkGraphList(value.options, optionsPath, errors, { min: 1, max: B.maxEnumOptions })) {
        (value.options as unknown[]).forEach((option, index) => {
          const optionPath = joinPath(optionsPath, index);
          if (checkGraphEnumValue(option, optionPath, errors)) options.add(option, optionPath);
        });
      }
      if (
        value.default !== undefined &&
        checkGraphEnumValue(value.default, defaultPath, errors) &&
        !options.has(value.default)
      ) {
        errors.add(defaultPath, "enum", "default must be one of the options");
      }
      break;
    }
  }
}

// --------------------------------------------------------------------- roles

const ROLE_DEFAULT_SOURCES = [
  ...GRAPH_ROLE_DEFAULT_ACTION_KEYS,
  ...GRAPH_ROLE_PANEL_DEFAULT_SOURCES,
] as const;

function checkRole(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  scope: GraphNameScope,
): void {
  if (
    !checkObject(
      value,
      path,
      ["key", "label", "description", "multiplicity", "maxPanel", "defaultsFrom"],
      errors,
    )
  ) {
    return;
  }
  const keyPath = joinPath(path, "key");
  if (checkGraphId(value.key, keyPath, errors)) scope.add(value.key, keyPath);
  checkGraphLabel(value.label, joinPath(path, "label"), errors);
  checkGraphDescription(value.description, joinPath(path, "description"), errors);
  const multiplicityPath = joinPath(path, "multiplicity");
  const panel =
    checkRequiredEnum(value.multiplicity, multiplicityPath, errors, GRAPH_ROLE_MULTIPLICITIES) &&
    value.multiplicity === "panel";
  if (value.maxPanel !== undefined) {
    const maxPanelPath = joinPath(path, "maxPanel");
    if (value.multiplicity === "one") {
      errors.add(maxPanelPath, "not_applicable", "maxPanel applies only to panel roles");
    } else {
      checkGraphInteger(value.maxPanel, maxPanelPath, errors, 1, B.maxBranches);
    }
  }
  const defaultsPath = joinPath(path, "defaultsFrom");
  if (
    !checkGraphList(value.defaultsFrom, defaultsPath, errors, {
      max: B.maxDefaultsFrom,
      optional: true,
    })
  ) {
    return;
  }
  const sources = value.defaultsFrom as unknown[];
  const seen = new GraphNameScope(errors, "default source");
  sources.forEach((source, index) => {
    const sourcePath = joinPath(defaultsPath, index);
    if (!checkEnum(source, sourcePath, errors, ROLE_DEFAULT_SOURCES)) return;
    if (!seen.add(source, sourcePath)) return;
    if ((GRAPH_ROLE_PANEL_DEFAULT_SOURCES as readonly string[]).includes(source)) {
      if (!panel) {
        errors.add(sourcePath, "panel_only", `${source} applies only to panel roles`);
      } else if (index !== sources.length - 1) {
        errors.add(sourcePath, "must_be_last", `${source} must be the last default source`);
      }
    }
  });
}

// ------------------------------------------------------------ run inputs/outputs

function checkRunInput(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  scope: GraphNameScope,
): void {
  if (!checkObject(value, path, ["name", "type", "label", "description", "required"], errors)) {
    return;
  }
  const namePath = joinPath(path, "name");
  if (checkGraphKey(value.name, namePath, errors)) scope.add(value.name, namePath);
  checkGraphTypeRef(value.type, joinPath(path, "type"), errors);
  checkGraphLabel(value.label, joinPath(path, "label"), errors);
  checkGraphDescription(
    value.description,
    joinPath(path, "description"),
    errors,
    B.maxPortDescriptionBytes,
  );
  checkGraphBoolean(value.required, joinPath(path, "required"), errors);
}

function checkRunOutput(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  scope: GraphNameScope,
): void {
  if (
    !checkObject(value, path, ["name", "type", "label", "description", "required", "from"], errors)
  ) {
    return;
  }
  const namePath = joinPath(path, "name");
  if (checkGraphKey(value.name, namePath, errors)) scope.add(value.name, namePath);
  checkGraphTypeRef(value.type, joinPath(path, "type"), errors);
  checkGraphLabel(value.label, joinPath(path, "label"), errors);
  checkGraphDescription(
    value.description,
    joinPath(path, "description"),
    errors,
    B.maxPortDescriptionBytes,
  );
  checkGraphBoolean(value.required, joinPath(path, "required"), errors);
  checkGraphEndpoint(value.from, joinPath(path, "from"), errors, {
    allowRunInput: false,
    allowOutlet: true,
  });
}

// ----------------------------------------------------------- workspace/limits

function checkWorkspace(value: unknown, path: string, errors: FieldErrorCollector): void {
  if (!checkPresent(value, path, errors)) return;
  if (!isPlainRecord(value)) {
    errors.add(path, "type", "Expected an object");
    return;
  }
  if (
    !checkRequiredEnum(value.kind, joinPath(path, "kind"), errors, ["environment", "none"] as const)
  ) {
    return;
  }
  if (value.kind === "none") {
    checkObject(value, path, ["kind"], errors);
    return;
  }
  if (!checkObject(value, path, ["kind", "create"], errors) || value.create === undefined) return;
  const createPath = joinPath(path, "create");
  if (checkObject(value.create, createPath, ["kind"], errors)) {
    checkRequiredEnum(
      value.create.kind,
      joinPath(createPath, "kind"),
      errors,
      GRAPH_ENVIRONMENT_KINDS,
    );
  }
}

function checkLimits(value: unknown, path: string, errors: FieldErrorCollector): void {
  if (!checkPresent(value, path, errors)) return;
  if (
    !checkObject(
      value,
      path,
      ["maxAgentSessions", "maxConcurrentAgents", "maxTokens", "maxWallClockMs"],
      errors,
    )
  ) {
    return;
  }
  checkGraphInteger(
    value.maxAgentSessions,
    joinPath(path, "maxAgentSessions"),
    errors,
    0,
    B.maxAgentSessions,
  );
  checkGraphInteger(
    value.maxConcurrentAgents,
    joinPath(path, "maxConcurrentAgents"),
    errors,
    1,
    B.maxConcurrentAgents,
  );
  checkGraphInteger(value.maxTokens, joinPath(path, "maxTokens"), errors, 1, B.maxTokens, true);
  checkGraphInteger(
    value.maxWallClockMs,
    joinPath(path, "maxWallClockMs"),
    errors,
    B.minTimeoutMs,
    B.maxWallClockMs,
    true,
  );
}

// ---------------------------------------------------------------- edges/loops

function checkTransform(value: unknown, path: string, errors: FieldErrorCollector): void {
  if (!isPlainRecord(value)) {
    errors.add(path, "type", "Expected an object");
    return;
  }
  if (!checkRequiredEnum(value.op, joinPath(path, "op"), errors, GRAPH_EDGE_TRANSFORM_OPS)) return;
  switch (value.op) {
    case "pick": {
      if (!checkObject(value, path, ["op", "fields"], errors)) return;
      const fieldsPath = joinPath(path, "fields");
      if (checkGraphList(value.fields, fieldsPath, errors, { min: 1, max: B.maxPickFields })) {
        const scope = new GraphNameScope(errors, "field");
        (value.fields as unknown[]).forEach((field, index) => {
          const fieldPath = joinPath(fieldsPath, index);
          if (checkGraphFieldPath(field, fieldPath, errors)) scope.add(field, fieldPath);
        });
      }
      return;
    }
    case "filter":
      if (checkObject(value, path, ["op", "where"], errors)) {
        checkGraphPredicate(value.where, joinPath(path, "where"), errors);
      }
      return;
    case "limit":
      if (checkObject(value, path, ["op", "count"], errors)) {
        checkGraphInteger(value.count, joinPath(path, "count"), errors, 1, B.maxTransformLimit);
      }
      return;
    case "flatten":
      if (checkObject(value, path, ["op", "path"], errors)) {
        checkGraphFieldPath(value.path, joinPath(path, "path"), errors);
      }
      return;
    case "adapt":
      if (checkObject(value, path, ["op", "adapter"], errors)) {
        checkGraphId(value.adapter, joinPath(path, "adapter"), errors);
      }
      return;
  }
}

function checkEdge(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  scope: GraphNameScope,
): void {
  if (!checkObject(value, path, ["id", "from", "to", "transform", "zip"], errors)) return;
  const idPath = joinPath(path, "id");
  if (checkGraphId(value.id, idPath, errors)) scope.add(value.id, idPath);
  checkGraphEndpoint(value.from, joinPath(path, "from"), errors, {
    allowRunInput: true,
    allowOutlet: true,
  });
  checkGraphEndpoint(value.to, joinPath(path, "to"), errors, {
    allowRunInput: false,
    allowOutlet: false,
  });
  const transformPath = joinPath(path, "transform");
  if (
    checkGraphList(value.transform, transformPath, errors, {
      min: 1,
      max: B.maxTransformsPerEdge,
      optional: true,
    })
  ) {
    (value.transform as unknown[]).forEach((transform, index) =>
      checkTransform(transform, joinPath(transformPath, index), errors),
    );
  }
  checkGraphBoolean(value.zip, joinPath(path, "zip"), errors);
}

function checkLoop(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  scope: GraphNameScope,
): void {
  if (
    !checkObject(value, path, ["id", "label", "nodes", "until", "maxIterations", "carry"], errors)
  ) {
    return;
  }
  const idPath = joinPath(path, "id");
  if (checkGraphId(value.id, idPath, errors)) scope.add(value.id, idPath);
  checkGraphLabel(value.label, joinPath(path, "label"), errors);
  const nodesPath = joinPath(path, "nodes");
  if (checkGraphList(value.nodes, nodesPath, errors, { min: 1, max: B.maxNodes })) {
    const members = new GraphNameScope(errors, "loop member");
    (value.nodes as unknown[]).forEach((node, index) => {
      const nodePath = joinPath(nodesPath, index);
      if (checkGraphId(node, nodePath, errors)) members.add(node, nodePath);
    });
  }
  checkGraphPredicate(value.until, joinPath(path, "until"), errors);
  checkGraphInteger(
    value.maxIterations,
    joinPath(path, "maxIterations"),
    errors,
    1,
    B.maxLoopIterations,
  );
  const carryPath = joinPath(path, "carry");
  if (checkGraphList(value.carry, carryPath, errors, { max: B.maxLoopCarry })) {
    (value.carry as unknown[]).forEach((carry, index) => {
      const entryPath = joinPath(carryPath, index);
      if (!checkObject(carry, entryPath, ["from", "to"], errors)) return;
      checkGraphEndpoint(carry.from, joinPath(entryPath, "from"), errors, {
        allowRunInput: false,
        allowOutlet: true,
      });
      checkGraphEndpoint(carry.to, joinPath(entryPath, "to"), errors, {
        allowRunInput: false,
        allowOutlet: false,
      });
    });
  }
}

// ----------------------------------------------------- layout/acknowledgements

function checkLayout(value: unknown, path: string, errors: FieldErrorCollector): void {
  const entries = checkGraphRecord(value, path, errors, { max: B.maxNodes, key: "id" });
  for (const [nodeId, point] of entries ?? []) {
    const pointPath = joinPath(path, nodeId);
    if (!checkObject(point, pointPath, ["x", "y"], errors)) continue;
    for (const axis of ["x", "y"] as const) {
      const axisPath = joinPath(pointPath, axis);
      if (checkPresent(point[axis], axisPath, errors)) {
        checkFiniteNumber(point[axis], axisPath, errors, { maxAbs: B.maxLayoutCoordinateAbs });
      }
    }
  }
}

function checkAcknowledgement(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  scope: GraphNameScope,
): void {
  if (!checkObject(value, path, ["kind", "digest", "acknowledgedAt", "code", "note"], errors)) {
    return;
  }
  checkRequiredEnum(value.kind, joinPath(path, "kind"), errors, GRAPH_ACKNOWLEDGEMENT_KINDS);
  const digestPath = joinPath(path, "digest");
  if (checkPresent(value.digest, digestPath, errors)) {
    if (typeof value.digest !== "string" || !GRAPH_DIGEST_PATTERN.test(value.digest)) {
      errors.add(digestPath, "pattern", "Must be a lower-case SHA-256 hex digest");
    } else {
      scope.add(`${String(value.kind)}:${value.digest}`, digestPath);
    }
  }
  const atPath = joinPath(path, "acknowledgedAt");
  if (checkPresent(value.acknowledgedAt, atPath, errors)) {
    if (
      typeof value.acknowledgedAt !== "string" ||
      parseUtcTimestamp(value.acknowledgedAt) === null
    ) {
      errors.add(
        atPath,
        "timestamp",
        "Expected an RFC 3339 UTC timestamp (YYYY-MM-DDTHH:MM:SS[.sss]Z)",
      );
    }
  }
  if (value.code !== undefined) checkGraphEnumValue(value.code, joinPath(path, "code"), errors);
  checkGraphText(value.note, joinPath(path, "note"), errors, {
    maxBytes: B.maxAcknowledgementNoteBytes,
    multiline: true,
    optional: true,
  });
}

// ------------------------------------------------------------------ template

function checkNamedList(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  options: { min?: number; max: number; optional?: boolean; what: string },
  check: (entry: unknown, entryPath: string, scope: GraphNameScope) => void,
): void {
  if (!checkGraphList(value, path, errors, options)) return;
  const scope = new GraphNameScope(errors, options.what);
  (value as unknown[]).forEach((entry, index) => check(entry, joinPath(path, index), scope));
}

function checkTemplateBody(value: Record<string, unknown>, errors: FieldErrorCollector): void {
  checkGraphId(value.id, "id", errors);
  checkGraphInteger(value.revision, "revision", errors, 0, Number.MAX_SAFE_INTEGER);
  checkGraphText(value.name, "name", errors, { maxBytes: B.maxNameBytes });
  checkGraphDescription(value.description, "description", errors);
  if (value.engine !== undefined) checkEnum(value.engine, "engine", errors, GRAPH_TEMPLATE_ENGINES);

  checkNamedList(
    value.parameters,
    "parameters",
    errors,
    { max: B.maxParameters, what: "parameter key" },
    (entry, path, scope) => checkParameter(entry, path, errors, scope),
  );
  checkNamedList(
    value.roles,
    "roles",
    errors,
    { max: B.maxRoles, what: "role key" },
    (entry, path, scope) => checkRole(entry, path, errors, scope),
  );
  checkNamedList(
    value.types,
    "types",
    errors,
    { max: B.maxTypes, optional: true, what: "type" },
    (entry, path, scope) => {
      checkArtifactTypeDef(entry, path, errors);
      if (
        isPlainRecord(entry) &&
        typeof entry.name === "string" &&
        typeof entry.version === "number"
      ) {
        scope.add(`${entry.name}@${entry.version}`, joinPath(path, "name"));
      }
    },
  );
  checkNamedList(
    value.inputs,
    "inputs",
    errors,
    { max: B.maxRunInputs, what: "run input" },
    (entry, path, scope) => checkRunInput(entry, path, errors, scope),
  );
  checkNamedList(
    value.outputs,
    "outputs",
    errors,
    { max: B.maxRunOutputs, optional: true, what: "run output" },
    (entry, path, scope) => checkRunOutput(entry, path, errors, scope),
  );
  checkWorkspace(value.workspace, "workspace", errors);
  checkNamedList(
    value.nodes,
    "nodes",
    errors,
    { min: 1, max: B.maxNodes, what: "node id" },
    (entry, path, scope) => {
      const id = checkGraphNode(entry, path, errors);
      if (id !== undefined) scope.add(id, joinPath(path, "id"));
    },
  );
  checkNamedList(
    value.edges,
    "edges",
    errors,
    { max: B.maxEdges, what: "edge id" },
    (entry, path, scope) => checkEdge(entry, path, errors, scope),
  );
  checkNamedList(
    value.loops,
    "loops",
    errors,
    { max: B.maxLoops, optional: true, what: "loop id" },
    (entry, path, scope) => checkLoop(entry, path, errors, scope),
  );
  checkLimits(value.limits, "limits", errors);
  if (value.layout !== undefined) checkLayout(value.layout, "layout", errors);
  checkNamedList(
    value.acknowledgements,
    "acknowledgements",
    errors,
    { max: B.maxAcknowledgements, optional: true, what: "acknowledgement" },
    (entry, path, scope) => checkAcknowledgement(entry, path, errors, scope),
  );
}

/** Validate an untrusted value as a `GraphTemplateV1`, with field-path errors. */
export function validateGraphTemplate(value: unknown): FieldValidation<GraphTemplateV1> {
  const errors = new FieldErrorCollector(GRAPH_TEMPLATE_MAX_ERRORS);
  const result = () => errors.result(value as GraphTemplateV1);
  if (!isPlainRecord(value)) {
    errors.add("", "type", "Expected a template object");
    return result();
  }
  // Size first: nothing below should walk an unbounded document.
  if (jsonDepthExceeds(value, B.maxTemplateDepth)) {
    errors.add("", "too_deep", `A template nests at most ${B.maxTemplateDepth} levels deep`);
    return result();
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    errors.add("", "not_json", "A template must be a JSON value");
    return result();
  }
  if (graphUtf8Bytes(serialized) > B.maxTemplateBytes) {
    errors.add("", "too_large", `A template serializes to at most ${B.maxTemplateBytes} bytes`);
    return result();
  }
  if (value.format !== GRAPH_TEMPLATE_FORMAT) {
    errors.add("format", "format", `Expected format "${GRAPH_TEMPLATE_FORMAT}"`);
    return result();
  }
  if (value.formatVersion !== GRAPH_TEMPLATE_FORMAT_VERSION) {
    errors.add(
      "formatVersion",
      "unsupported_version",
      `Only formatVersion ${GRAPH_TEMPLATE_FORMAT_VERSION} is supported`,
    );
    return result();
  }
  if (!checkObject(value, "", TEMPLATE_FIELDS, errors)) return result();
  checkTemplateBody(value, errors);
  return result();
}

export function isGraphTemplateV1(value: unknown): value is GraphTemplateV1 {
  return validateGraphTemplate(value).ok;
}

/**
 * Parse template JSON text (an import or a project file). Duplicate object
 * keys are refused, so two documents that read differently cannot share a
 * digest; size is checked before parsing.
 */
export function parseGraphTemplate(text: string): FieldValidation<GraphTemplateV1> {
  if (graphUtf8Bytes(text) > B.maxTemplateBytes) {
    return {
      ok: false,
      errors: [
        {
          path: "$",
          code: "too_large",
          message: `A template is at most ${B.maxTemplateBytes} bytes`,
        },
      ],
      omittedErrors: 0,
    };
  }
  const parsed = parseStrictJson(text, B.maxTemplateDepth);
  if (!parsed.ok) {
    return {
      ok: false,
      errors: [{ path: parsed.path, code: "invalid_json", message: parsed.message.slice(0, 300) }],
      omittedErrors: 0,
    };
  }
  return validateGraphTemplate(parsed.value);
}
