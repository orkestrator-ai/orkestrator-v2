/**
 * What a node's prompt template can name (item 105, report §7.3).
 *
 * Variables come from six roots plus the input partials:
 *
 * | Root | Bound when | Value |
 * | --- | --- | --- |
 * | `input.<port>` | always (one per input port) | the port's artifact; a list port is a list; on an `items` node the replicated port is the branch's element |
 * | `params.<key>` | always (one per template parameter) | the launch value, else the default |
 * | `run.iteration` | always | the loop iteration, 1-based (1 outside loops) |
 * | `lens.key`, `lens.label`, `lens.instruction` | the node replicates over lenses | the branch's lens |
 * | `item`, `item.index`, `item.id` | the node replicates over items | the branch's element; `item.index` is its 1-based position in the input list, `item.id` its stable id (item 401) |
 * | `branch.index`, `branch.key`, `branch.count` | the node is replicated | the branch, 1-based |
 * | `ticket` | the template has a `ticket@N` run input | that run input |
 *
 * `lens`, `item` and `branch` (and the replicated `items` input) differ per
 * branch; everything else is shared by every branch of a node. This module
 * holds the static picture (which names exist, their types and their size
 * bounds) for the linter and the size estimator, and builds the runtime
 * context the renderer reads. Browser-safe.
 */
import type { ArtifactTypeBudgets, ArtifactTypeDef, GraphJsonSchema } from "./artifact-type-def.js";
import { GRAPH_TEMPLATE_BOUNDS, graphUtf8Bytes, parseGraphTypeRef } from "./grammar.js";
import { graphSchemaAtPath, graphSchemaNonNull } from "./schema-subset.js";
import type {
  GraphAgentNode,
  GraphInputPortSpec,
  GraphLens,
  GraphParameter,
  GraphRenderMode,
  GraphReplicateAxis,
  GraphRunInputSpec,
} from "./template-model.js";
import {
  type GraphTypeDefinition,
  GraphTypeLibrary,
  type GraphValueType,
  graphBuiltInType,
  graphValueTypeElement,
  graphValueTypeLabel,
} from "./types.js";

export const GRAPH_PROMPT_ROOTS = [
  "input",
  "params",
  "run",
  "lens",
  "item",
  "branch",
  "ticket",
] as const;
export type GraphPromptRoot = (typeof GRAPH_PROMPT_ROOTS)[number];

/** Roots whose value differs per branch of a replicated node. */
export const GRAPH_PROMPT_BRANCH_ROOTS: readonly GraphPromptRoot[] = ["lens", "item", "branch"];

/** Elements assumed for a list input when the compiler does not say (the fan-out cap). */
export const GRAPH_PROMPT_DEFAULT_LIST_ITEMS = GRAPH_TEMPLATE_BOUNDS.maxBranches;
/** Bytes of a branch key (`reviewer-2.lens-api`); the runtime keeps keys within it. */
export const GRAPH_PROMPT_BRANCH_KEY_MAX_BYTES = 192;
const BRANCH_BYTES = GRAPH_PROMPT_BRANCH_KEY_MAX_BYTES + 64;
const RUN_BYTES = 32;
/** A JSON number within `maxNumberAbs`, with room for a fraction and exponent. */
const NUMBER_BYTES = 32;
const VALUE_CAP = GRAPH_TEMPLATE_BOUNDS.maxValueArtifactBytes;

const RUN_SCHEMA: GraphJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["iteration"],
  properties: { iteration: { type: "integer" } },
};
const BRANCH_SCHEMA: GraphJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["index", "key", "count"],
  properties: { index: { type: "integer" }, key: { type: "string" }, count: { type: "integer" } },
};
/** `item.index` and `item.id` (item 401): the item's position in its input and its stable id. */
const ITEM_REF_SCHEMA: GraphJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["index", "id"],
  properties: { index: { type: "integer" }, id: { type: "string" } },
};
/** An item id (128 characters, `GRAPH_ITEM_ID_MAX_CHARS`) and an index, as JSON. */
const ITEM_REF_BYTES = 192;
/** The source key `item.index` and `item.id` resolve to. */
export const GRAPH_PROMPT_ITEM_REF_SOURCE = "item.ref";
const LENS_SCHEMA: GraphJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["key", "label", "instruction"],
  properties: {
    key: { type: "string" },
    label: { type: "string" },
    instruction: { type: "string" },
  },
};

/**
 * A static bound on one variable source (an input port, a parameter, `run`,
 * `lens`, `item`, `branch` or `ticket`).
 */
export interface GraphPromptSourceBound {
  /** `input.report`, `params.autoFix`, `run`, `lens`, `item`, `branch`, `ticket`. */
  key: string;
  /**
   * Bytes the whole value, and any set of non-overlapping parts of it, can
   * render to before escaping: its compact JSON size (type budgets), or for a
   * string parameter its text size.
   */
  bytes: number;
  /** The longest list anywhere in the value; unknown when absent. */
  maxItems?: number;
  /** The value's schema; unknown when absent. */
  schema?: GraphJsonSchema;
  perBranch: boolean;
  /** The value may be absent at run time (an optional input). */
  optional: boolean;
}

/** An input port as the prompt sees it. */
export interface GraphPromptPort {
  name: string;
  spec: GraphInputPortSpec;
  /** The value's type: the compiler's (after edge transforms) or the declared one; on an items node, the element. */
  type?: GraphValueType;
  typeLabel: string;
  /** The effective render mode. */
  mode: GraphRenderMode;
  required: boolean;
  /** The replicated input of an `items` node: each branch sees one element. */
  perBranch: boolean;
  /** `list<…>` nesting of `type` (0 for a single artifact). */
  listDepth: number;
  /** Elements per list level. */
  listItems: number;
  /** The library type a markdown or summary render uses (the element's, for lists). */
  definition?: GraphTypeDefinition;
  /** Per-element bound (the value itself when not a list). */
  element: GraphPromptSourceBound;
  bound: GraphPromptSourceBound;
}

export interface GraphPromptScope {
  ports: ReadonlyMap<string, GraphPromptPort>;
  params: ReadonlyMap<string, GraphParameter>;
  /** Every source by key (`input.<port>`, `params.<key>`, `run`, …). */
  sources: ReadonlyMap<string, GraphPromptSourceBound>;
  /** Roots that have a value on this node. */
  bound: ReadonlySet<GraphPromptRoot>;
  lenses: readonly GraphLens[];
  /** The input an `items` node replicates over. */
  itemsPort?: string;
  /** The run input `ticket` reads. */
  ticketInput?: string;
  replicated: boolean;
}

/** What the prompt functions need to know about the node and its template. */
export interface GraphPromptNodeContext {
  node: GraphAgentNode;
  template?: {
    parameters?: readonly GraphParameter[];
    inputs?: readonly Pick<GraphRunInputSpec, "name" | "type">[];
    types?: readonly ArtifactTypeDef[];
  };
  /** Defaults to a library over `template.types`. */
  library?: GraphTypeLibrary;
  /** Port types after edge transforms, as the compiler resolved them (item 107). */
  portTypes?: Readonly<Record<string, GraphValueType>>;
  /** Elements per list level for list ports (the producer's fan-out); default 32. */
  listItems?: Readonly<Record<string, number>>;
}

function replicateAxes(node: GraphAgentNode): GraphReplicateAxis[] {
  if (!node.replicate) return [];
  return node.replicate.over === "cross" ? node.replicate.axes : [node.replicate];
}

/** The lenses a node replicates over, if any. */
export function graphPromptNodeLenses(node: GraphAgentNode): GraphLens[] {
  const axis = replicateAxes(node).find((entry) => entry.over === "lenses");
  return axis?.over === "lenses" ? axis.lenses : [];
}

/** The input an `items` node replicates over, if any. */
export function graphPromptItemsPort(node: GraphAgentNode): string | undefined {
  const axis = replicateAxes(node).find((entry) => entry.over === "items");
  return axis?.over === "items" ? axis.input : undefined;
}

/**
 * The element one branch of an `items` fan-out sees (item 401): a list's
 * element, or one entry of the item list of a type that declares `items`.
 * Undefined for a type that holds no items.
 */
export function graphItemsElementType(type: GraphValueType): GraphValueType | undefined {
  if (type.kind === "list") return type.element;
  if (type.kind !== "named" || !type.definition.items) return undefined;
  const { definition } = type;
  const field = graphSchemaAtPath(definition.schema, definition.items!.path);
  const items = field ? graphSchemaNonNull(field.schema).schema.items : undefined;
  if (!items || typeof items !== "object" || Array.isArray(items)) return undefined;
  return {
    kind: "shape",
    schema: items as GraphJsonSchema,
    budgets: definition.budgets,
    origin: `${graphValueTypeLabel(type)}.${definition.items!.path}[]`,
  };
}

/** `file` for types stored by reference (packages), else `json-frame`. */
export function graphPromptDefaultRenderMode(type: GraphValueType | undefined): GraphRenderMode {
  if (!type) return "json-frame";
  const { element } = graphValueTypeElement(type);
  return element.kind === "named" && element.definition.storage === "reference"
    ? "file"
    : "json-frame";
}

function definitionBound(
  key: string,
  definition: GraphTypeDefinition,
  extra: { perBranch: boolean; optional: boolean },
): GraphPromptSourceBound {
  return {
    key,
    bytes: definition.storage === "reference" ? VALUE_CAP : definition.budgets.maxBytes,
    ...(definition.budgets.maxItems !== undefined ? { maxItems: definition.budgets.maxItems } : {}),
    schema: definition.schema,
    ...extra,
  };
}

function shapeBound(
  key: string,
  schema: GraphJsonSchema,
  budgets: ArtifactTypeBudgets,
  extra: { perBranch: boolean; optional: boolean },
): GraphPromptSourceBound {
  return {
    key,
    bytes: budgets.maxBytes,
    ...(budgets.maxItems !== undefined ? { maxItems: budgets.maxItems } : {}),
    schema,
    ...extra,
  };
}

/** A bound for a value of `type`, with `listItems` elements per list level. */
export function graphPromptValueBound(
  key: string,
  type: GraphValueType,
  options: {
    listItems?: number;
    includeFailures?: boolean;
    perBranch?: boolean;
    optional?: boolean;
  } = {},
): GraphPromptSourceBound {
  const extra = { perBranch: options.perBranch ?? false, optional: options.optional ?? false };
  switch (type.kind) {
    case "named":
      return definitionBound(key, type.definition, extra);
    case "shape":
      return shapeBound(key, type.schema, type.budgets, extra);
    case "list": {
      const items = Math.max(0, options.listItems ?? GRAPH_PROMPT_DEFAULT_LIST_ITEMS);
      let element = graphPromptValueBound(key, type.element, {
        ...options,
        includeFailures: false,
      });
      if (options.includeFailures) {
        const failure = graphBuiltInType("error@1");
        if (failure) {
          // A failure marker can stand in for any element (`includeFailures`).
          element = {
            ...element,
            bytes: Math.max(element.bytes, failure.budgets.maxBytes),
            schema: undefined,
          };
        }
      }
      const maxItems =
        element.maxItems === undefined ? undefined : Math.max(items, element.maxItems);
      return {
        key,
        bytes: items * (element.bytes + 1) + 1,
        ...(maxItems !== undefined ? { maxItems } : {}),
        schema: element.schema ? { type: "array", items: element.schema } : { type: "array" },
        ...extra,
      };
    }
  }
}

function parameterBound(parameter: GraphParameter): GraphPromptSourceBound {
  const key = `params.${parameter.key}`;
  const base = { key, perBranch: false, optional: false };
  switch (parameter.type) {
    case "boolean":
      return { ...base, bytes: 5, schema: { type: "boolean" } };
    case "integer":
    case "number":
      return { ...base, bytes: NUMBER_BYTES, schema: { type: parameter.type } };
    case "string":
      return {
        ...base,
        bytes: parameter.maxBytes ?? GRAPH_TEMPLATE_BOUNDS.maxStringParameterBytes,
        schema: { type: "string" },
      };
    case "enum":
      return {
        ...base,
        bytes: Math.max(0, ...parameter.options.map((option) => graphUtf8Bytes(option))),
        schema: { type: "string", enum: [...parameter.options] },
      };
  }
}

function lensBytes(lenses: readonly GraphLens[]): number {
  let bytes = 0;
  for (const lens of lenses) bytes = Math.max(bytes, graphUtf8Bytes(JSON.stringify(lens)));
  return bytes;
}

function resolvePortType(
  port: GraphInputPortSpec,
  context: GraphPromptNodeContext,
  library: GraphTypeLibrary,
): GraphValueType | undefined {
  const given = context.portTypes?.[port.name];
  if (given) return given;
  const resolved = library.resolve(port.type);
  return resolved.ok ? resolved.type : undefined;
}

/** The static scope of a node's prompt. */
export function graphPromptScope(context: GraphPromptNodeContext): GraphPromptScope {
  const { node } = context;
  const library = context.library ?? new GraphTypeLibrary(context.template?.types ?? []);
  const axes = replicateAxes(node);
  const lenses = graphPromptNodeLenses(node);
  const itemsPort = graphPromptItemsPort(node);
  const sources = new Map<string, GraphPromptSourceBound>();
  const ports = new Map<string, GraphPromptPort>();

  for (const spec of node.inputs ?? []) {
    if (ports.has(spec.name)) continue;
    let type = resolvePortType(spec, context, library);
    const perBranch = spec.name === itemsPort;
    // Each branch of an `items` node sees one element of the replicated list
    // (or one entry of the item list of a type with `items`).
    if (perBranch && type) type = graphItemsElementType(type) ?? type;
    const required = spec.required !== false;
    const listItems = Math.max(
      0,
      context.listItems?.[spec.name] ?? GRAPH_PROMPT_DEFAULT_LIST_ITEMS,
    );
    const includeFailures = spec.collect?.includeFailures === true;
    const key = `input.${spec.name}`;
    const extra = { perBranch, optional: !required };
    const bound: GraphPromptSourceBound = type
      ? graphPromptValueBound(key, type, { listItems, includeFailures, ...extra })
      : { key, bytes: VALUE_CAP, ...extra };
    const elementInfo = type ? graphValueTypeElement(type) : undefined;
    const elementType = elementInfo?.element;
    const element: GraphPromptSourceBound = elementType
      ? graphPromptValueBound(key, elementType, extra)
      : { key, bytes: VALUE_CAP, ...extra };
    if (includeFailures && elementInfo && elementInfo.listDepth > 0) {
      const failure = graphBuiltInType("error@1");
      if (failure) element.bytes = Math.max(element.bytes, failure.budgets.maxBytes);
    }
    ports.set(spec.name, {
      name: spec.name,
      spec,
      ...(type ? { type } : {}),
      typeLabel: type ? graphValueTypeLabel(type) : spec.type,
      mode: spec.render ?? graphPromptDefaultRenderMode(type),
      required,
      perBranch,
      listDepth: elementInfo?.listDepth ?? 0,
      listItems,
      ...(elementType?.kind === "named" ? { definition: elementType.definition } : {}),
      element,
      bound,
    });
    sources.set(key, bound);
  }

  const params = new Map<string, GraphParameter>();
  for (const parameter of context.template?.parameters ?? []) {
    if (params.has(parameter.key)) continue;
    params.set(parameter.key, parameter);
    sources.set(`params.${parameter.key}`, parameterBound(parameter));
  }

  const bound = new Set<GraphPromptRoot>(["input", "params", "run"]);
  sources.set("run", {
    key: "run",
    bytes: RUN_BYTES,
    schema: RUN_SCHEMA,
    perBranch: false,
    optional: false,
  });
  if (axes.length > 0) {
    bound.add("branch");
    sources.set("branch", {
      key: "branch",
      bytes: BRANCH_BYTES,
      schema: BRANCH_SCHEMA,
      perBranch: true,
      optional: false,
    });
  }
  if (lenses.length > 0) {
    bound.add("lens");
    sources.set("lens", {
      key: "lens",
      bytes: lensBytes(lenses),
      schema: LENS_SCHEMA,
      perBranch: true,
      optional: false,
    });
  }
  if (itemsPort !== undefined && ports.has(itemsPort)) {
    bound.add("item");
    const port = ports.get(itemsPort)!;
    sources.set("item", { ...port.bound, key: "item", perBranch: true });
    sources.set(GRAPH_PROMPT_ITEM_REF_SOURCE, {
      key: GRAPH_PROMPT_ITEM_REF_SOURCE,
      bytes: ITEM_REF_BYTES,
      schema: ITEM_REF_SCHEMA,
      perBranch: true,
      optional: false,
    });
  }
  const ticketInput = context.template?.inputs?.find(
    (input) =>
      parseGraphTypeRef(input.type)?.name === "ticket" &&
      parseGraphTypeRef(input.type)?.listDepth === 0,
  );
  if (ticketInput) {
    const resolved = library.resolve(ticketInput.type);
    if (resolved.ok) {
      bound.add("ticket");
      sources.set("ticket", graphPromptValueBound("ticket", resolved.type));
    }
  }

  return {
    ports,
    params,
    sources,
    bound,
    lenses,
    ...(itemsPort !== undefined ? { itemsPort } : {}),
    ...(ticketInput ? { ticketInput: ticketInput.name } : {}),
    replicated: axes.length > 0,
  };
}

// ------------------------------------------------------------ schema walk

export type GraphPromptSchemaPresence = "definite" | "maybe" | "absent";

/** Whether `segment` is an own property of every value of `schema`. */
export function graphPromptSchemaPresence(
  schema: GraphJsonSchema | undefined,
  segment: string,
): GraphPromptSchemaPresence {
  if (!schema) return "maybe";
  const { schema: inner, nullable } = graphSchemaNonNull(schema);
  const numeric = /^(?:0|[1-9][0-9]*)$/.test(segment);
  switch (inner.type) {
    case "object": {
      const properties = inner.properties;
      if (properties && typeof properties === "object" && Object.hasOwn(properties, segment)) {
        const required = Array.isArray(inner.required) && inner.required.includes(segment);
        return required && !nullable ? "definite" : "maybe";
      }
      return inner.additionalProperties === false ? "absent" : "maybe";
    }
    case "array":
      return numeric ? "maybe" : "absent";
    case "string":
    case "number":
    case "integer":
    case "boolean":
    case "null":
      return "absent";
    default:
      return "maybe";
  }
}

/** The schema one segment down, when known. */
export function graphPromptSchemaChild(
  schema: GraphJsonSchema | undefined,
  segment: string,
): GraphJsonSchema | undefined {
  if (!schema) return undefined;
  const { schema: inner } = graphSchemaNonNull(schema);
  if (inner.type === "object" && inner.properties && typeof inner.properties === "object") {
    const properties = inner.properties as Record<string, unknown>;
    const next = Object.hasOwn(properties, segment) ? properties[segment] : undefined;
    return next && typeof next === "object" && !Array.isArray(next)
      ? (next as GraphJsonSchema)
      : undefined;
  }
  if (inner.type === "array") {
    const items = inner.items;
    return items && typeof items === "object" && !Array.isArray(items)
      ? (items as GraphJsonSchema)
      : undefined;
  }
  return undefined;
}

/** Whether the schema says its values are lists (`true`), never lists (`false`), or it cannot say. */
export function graphPromptSchemaIsList(schema: GraphJsonSchema | undefined): boolean | undefined {
  if (!schema) return undefined;
  const { schema: inner } = graphSchemaNonNull(schema);
  if (inner.type === "array") return true;
  if (typeof inner.type === "string") return false;
  return undefined;
}

// ----------------------------------------------------------- run context

/** A file the runtime wrote for a `file` input (report §5.6). */
export interface GraphPromptFileRef {
  /** Workspace-relative path, at most {@link GRAPH_PROMPT_FILE_PATH_MAX_BYTES}. */
  path: string;
  /** Lower-case SHA-256 hex of the file. */
  sha256: string;
  bytes?: number;
}

/** An artifact an `on-demand` input lists; the agent reads it with `read_artifact`. */
export interface GraphPromptArtifactRef {
  /** At most {@link GRAPH_PROMPT_ARTIFACT_ID_MAX_BYTES}. */
  id: string;
  bytes?: number;
}

/**
 * What the runtime knows about one artifact of an input (item 205): the
 * value itself for a single-value port, each list element for a list port.
 */
export interface GraphPromptElement {
  /** The stable ids of the artifact's items (`run-items.ts`), in item order. */
  itemIds?: readonly string[];
  /** A failed branch's `error@1` marker in a fan-in list (`includeFailures`). */
  failure?: boolean;
  /** The upstream item the artifact stands for (`GraphArtifact.sourceItem`, item 401). */
  sourceItem?: string;
}

export const GRAPH_PROMPT_FILE_PATH_MAX_BYTES = 1024;
export const GRAPH_PROMPT_ARTIFACT_ID_MAX_BYTES = 128;

/** Everything a render reads that is not in the template. */
export interface GraphPromptValues {
  /** Port → value; a list port's value is a list; on an items node the replicated port holds the branch's element. */
  inputs: Readonly<Record<string, unknown>>;
  params?: Readonly<Record<string, unknown>>;
  run?: { iteration: number };
  lens?: GraphLens;
  /** 1-based index, the branch key, and the number of branches. */
  branch?: { index: number; key: string; count: number };
  /** An `items` branch's item (item 401): its 1-based position in the input and its stable id. */
  item?: { index: number; id: string };
  /** The `ticket` run input's value. */
  ticket?: unknown;
  /** `file` inputs: what the runtime wrote. */
  files?: Readonly<Record<string, GraphPromptFileRef>>;
  /** `on-demand` inputs: the artifacts the node may read (one per element for lists). */
  artifacts?: Readonly<Record<string, readonly GraphPromptArtifactRef[]>>;
  /**
   * Per input port, one entry per artifact in value order: item ids a
   * consolidator cites (§5.9) and failed branches' markers. Runtime only;
   * a preview has none.
   */
  elements?: Readonly<Record<string, readonly GraphPromptElement[]>>;
  /** Output port → its result slot's key. */
  resultKeys?: Readonly<Record<string, string>>;
  /** The activation's result capability, when the transport needs one in the prompt. */
  capability?: string;
}

/** The root context object and aliases a node template renders against. */
export function graphPromptRenderContext(
  scope: GraphPromptScope,
  values: GraphPromptValues,
): { context: Record<string, unknown>; aliases: Map<string, unknown> } {
  const input: Record<string, unknown> = Object.create(null);
  for (const port of scope.ports.values()) {
    if (Object.hasOwn(values.inputs, port.name)) input[port.name] = values.inputs[port.name];
    else if (!port.required) input[port.name] = null;
  }
  const params: Record<string, unknown> = Object.create(null);
  for (const parameter of scope.params.values()) {
    if (values.params && Object.hasOwn(values.params, parameter.key)) {
      params[parameter.key] = values.params[parameter.key];
    } else if (parameter.default !== undefined) {
      params[parameter.key] = parameter.default;
    }
  }
  const context: Record<string, unknown> = Object.create(null);
  context.input = input;
  context.params = params;
  context.run = { iteration: values.run?.iteration ?? 1 };
  const aliases = new Map<string, unknown>();
  if (scope.bound.has("branch") && values.branch) context.branch = { ...values.branch };
  if (scope.bound.has("lens") && values.lens) {
    context.lens = {
      key: values.lens.key,
      label: values.lens.label,
      instruction: values.lens.instruction,
    };
  }
  if (scope.bound.has("item") && scope.itemsPort !== undefined) {
    if (Object.hasOwn(input, scope.itemsPort)) context.item = input[scope.itemsPort];
    if (values.item) {
      aliases.set("item.index", values.item.index);
      aliases.set("item.id", values.item.id);
    }
  }
  if (scope.bound.has("ticket") && values.ticket !== undefined) context.ticket = values.ticket;
  return { context, aliases };
}
