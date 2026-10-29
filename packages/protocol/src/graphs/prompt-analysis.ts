/**
 * Static analysis of a parsed prompt template (item 105): what every tag can
 * resolve to, how often it can render, and a size bound.
 *
 * The walk mirrors the renderer's lookup. Each section opens a frame whose
 * element is described by *targets*: a variable source (`input.report`,
 * `item`, …), a path inside it (`issues.[]` for a list's elements) and the
 * schema there, when known. A name resolves in the innermost frame whose
 * schema has it as a required property; a property that may be absent (an
 * optional or unknown field) also keeps searching outwards, exactly where the
 * renderer could find it.
 *
 * Size bound. Every rendered value is a part of some source's value. Values
 * reached from one frame element are disjoint across that frame's
 * iterations, so a tag inside a loop over `issues` renders, in total, at most
 * the bytes of `issues` once. A tag that reads an outer value inside a loop
 * renders it once per iteration: that is its weight. Summing weights along
 * every path of a source's access trie and taking the heaviest path bounds the
 * source's share: `weight × bytes`. Text renders once per execution of its
 * frame. A node template writes each value taken from an input inside an
 * inline evidence frame; the frame's bytes count once per execution of the
 * tag. The bound holds for any value within the source's budget and schema.
 * Browser-safe.
 */
import type { GraphJsonSchema } from "./artifact-type-def.js";
import {
  type GraphPromptScope,
  type GraphPromptSourceBound,
  GRAPH_PROMPT_ITEM_REF_SOURCE,
  graphPromptSchemaChild,
  graphPromptSchemaIsList,
  graphPromptSchemaPresence,
} from "./prompt-scope.js";
import type { GraphPromptNode, GraphPromptTemplate } from "./prompt-template.js";

/** Ceiling on execution counts, so products of loop bounds stay finite. */
const EXECUTION_CAP = 1e15;

const cap = (value: number) => Math.min(EXECUTION_CAP, value);

export type GraphPromptResolutionProblem =
  /** Not a root the language knows, and nothing in scope has it. */
  | "unknown-root"
  /** A known root this node does not have (`lens` on a node without lenses). */
  | "unbound-root"
  | "unknown-port"
  | "unknown-param"
  /** `input` or `params` alone, or `.` at the root. */
  | "container"
  /** The source's schema has no such field. */
  | "unknown-field";

/** One way a tag can resolve. */
export interface GraphPromptTargetUse {
  /** Source key: `input.report`, `params.autoFix`, `lens`, …; `value` for a type template. */
  source: string;
  /** Path inside the source; `[]` stands for any list element. */
  path: string[];
  schema?: GraphJsonSchema;
  /** How many times one value at this path can render through this tag. */
  weight: number;
}

export interface GraphPromptOccurrence {
  kind: "variable" | "section" | "inverted" | "partial";
  node: Exclude<GraphPromptNode, { kind: "text" }>;
  /** Dotted name; `input.<port>` for a partial. */
  name: string;
  depth: number;
  /** How many times the tag can render. */
  executions: number;
  uses: GraphPromptTargetUse[];
  problem?: GraphPromptResolutionProblem;
  /** The name can fail to resolve at run time, so the tag can render as written. */
  mayRenderRaw: boolean;
  /** Reads a value that differs per branch. */
  perBranch: boolean;
  /** For partials: the port. */
  port?: string;
}

export interface GraphPromptAnalysis {
  occurrences: GraphPromptOccurrence[];
  texts: { text: string; offset: number; executions: number }[];
}

/** Where names resolve at the top: a node's scope, or one typed value (type templates). */
export type GraphPromptAnalysisRoot =
  { kind: "scope"; scope: GraphPromptScope } | { kind: "value"; source: GraphPromptSourceBound };

interface Target {
  source: string;
  path: string[];
  schema?: GraphJsonSchema;
}

interface Frame {
  /** Empty for the scope root. */
  targets: Target[];
  scopeRoot: boolean;
  perParent: number;
  executions: number;
  repeat: number;
}

interface Resolution {
  uses: GraphPromptTargetUse[];
  problem?: GraphPromptResolutionProblem;
  certain: boolean;
}

const isIndex = (segment: string) => /^(?:0|[1-9][0-9]*)$/.test(segment);

/**
 * Follow `rest` from a target. `first` is the presence of `rest[0]` when the
 * caller already checked it. `absent` when the schema rules the path out;
 * `certain` when every step is a required, non-null property.
 */
function extend(
  target: Target,
  rest: readonly string[],
  first?: "definite" | "maybe",
): { target: Target; certain: boolean } | { absent: true } {
  let schema = target.schema;
  let certain = true;
  const path = [...target.path];
  for (let index = 0; index < rest.length; index++) {
    const segment = rest[index]!;
    const presence =
      index === 0 && first !== undefined ? first : graphPromptSchemaPresence(schema, segment);
    if (presence === "absent") return { absent: true };
    if (presence !== "definite") certain = false;
    path.push(isIndex(segment) ? "[]" : segment);
    schema = graphPromptSchemaChild(schema, segment);
  }
  return { target: { source: target.source, path, ...(schema ? { schema } : {}) }, certain };
}

function rootResolution(
  scope: GraphPromptScope,
  path: readonly string[],
):
  { target: Target; rest: string[]; certain: boolean } | { problem: GraphPromptResolutionProblem } {
  const [root, second] = path;
  const source = (key: string) => scope.sources.get(key)?.schema;
  switch (root) {
    case "input": {
      if (second === undefined) return { problem: "container" };
      const port = scope.ports.get(second);
      if (!port) return { problem: "unknown-port" };
      const key = `input.${second}`;
      return {
        target: {
          source: key,
          path: [],
          ...(port.bound.schema ? { schema: port.bound.schema } : {}),
        },
        rest: path.slice(2),
        certain: port.required,
      };
    }
    case "params": {
      if (second === undefined) return { problem: "container" };
      if (!scope.params.has(second)) return { problem: "unknown-param" };
      const key = `params.${second}`;
      return {
        target: { source: key, path: [], schema: source(key)! },
        rest: path.slice(2),
        certain: scope.params.get(second)!.default !== undefined,
      };
    }
    case "run":
    case "lens":
    case "branch":
    case "ticket": {
      if (!scope.bound.has(root)) return { problem: "unbound-root" };
      const schema = source(root);
      // Only `run` is always in the context; the runtime supplies the others.
      return {
        target: { source: root, path: [], ...(schema ? { schema } : {}) },
        rest: path.slice(1),
        certain: root === "run",
      };
    }
    case "item": {
      if (!scope.bound.has("item")) return { problem: "unbound-root" };
      // `item.index` and `item.id` name the item, before any field of the element.
      if (path.length === 2 && (second === "index" || second === "id")) {
        return {
          target: {
            source: GRAPH_PROMPT_ITEM_REF_SOURCE,
            path: [],
            schema: source(GRAPH_PROMPT_ITEM_REF_SOURCE)!,
          },
          rest: [second],
          certain: false,
        };
      }
      const schema = source("item");
      return {
        target: { source: "item", path: [], ...(schema ? { schema } : {}) },
        rest: path.slice(1),
        certain: false,
      };
    }
    default:
      return { problem: "unknown-root" };
  }
}

function resolve(
  frames: readonly Frame[],
  path: readonly string[],
  root: GraphPromptAnalysisRoot,
): Resolution {
  const innermost = frames.at(-1)!;
  if (path.length === 1 && path[0] === ".") {
    if (innermost.scopeRoot) return { uses: [], problem: "container", certain: false };
    return {
      uses: innermost.targets.map((target) => ({ ...target, weight: innermost.repeat })),
      certain: true,
    };
  }
  const uses: GraphPromptTargetUse[] = [];
  let problem: GraphPromptResolutionProblem | undefined;
  let certain = false;
  let multiplier = 1;
  for (let level = frames.length - 1; level >= 0; level--) {
    const frame = frames[level]!;
    const weight = multiplier * frame.repeat;
    if (frame.scopeRoot && root.kind === "scope") {
      const resolved = rootResolution(root.scope, path);
      if ("problem" in resolved) {
        if (uses.length === 0) problem = resolved.problem;
        break;
      }
      const extended = extend(resolved.target, resolved.rest);
      if ("absent" in extended) {
        if (uses.length === 0) problem = "unknown-field";
        break;
      }
      uses.push({ ...extended.target, weight });
      certain = resolved.certain && extended.certain;
      break;
    }
    let allDefinite = frame.targets.length > 0;
    for (const target of frame.targets) {
      const presence = graphPromptSchemaPresence(target.schema, path[0]!);
      if (presence === "absent") {
        allDefinite = false;
        continue;
      }
      if (presence !== "definite") allDefinite = false;
      const extended = extend(target, path, presence);
      if ("absent" in extended) {
        if (presence === "definite" && uses.length === 0) problem = "unknown-field";
        continue;
      }
      uses.push({ ...extended.target, weight });
      if (presence === "definite") certain = extended.certain;
    }
    if (allDefinite) break;
    multiplier = cap(multiplier * frame.perParent);
    if (level === 0 && uses.length === 0 && problem === undefined) {
      problem = root.kind === "value" ? "unknown-field" : "unknown-root";
    }
  }
  if (uses.length > 0) problem = undefined;
  // Certain only when exactly one way to resolve exists and every step of it
  // is required: any alternative or optional step can render the tag as written.
  return {
    uses,
    ...(problem ? { problem } : {}),
    certain: certain && uses.length === 1 && problem === undefined,
  };
}

function sectionFrame(
  parent: Frame,
  uses: readonly GraphPromptTargetUse[],
  sources: ReadonlyMap<string, GraphPromptSourceBound>,
): Frame {
  const targets: Target[] = [];
  let perParent = 0;
  let repeat = 0;
  for (const use of uses) {
    const source = sources.get(use.source);
    const listCount = Math.max(
      0,
      Math.min(source?.maxItems ?? Number.POSITIVE_INFINITY, Math.floor((source?.bytes ?? 0) / 2)),
    );
    const isList = graphPromptSchemaIsList(use.schema);
    const element = graphPromptSchemaChild(use.schema, "0");
    if (isList !== false) {
      targets.push({
        source: use.source,
        path: [...use.path, "[]"],
        ...(element ? { schema: element } : {}),
      });
      perParent = Math.max(perParent, listCount);
    }
    if (isList !== true) {
      targets.push({
        source: use.source,
        path: use.path,
        ...(use.schema ? { schema: use.schema } : {}),
      });
      perParent = Math.max(perParent, 1);
    }
    repeat = Math.max(repeat, use.weight);
  }
  return {
    targets,
    scopeRoot: false,
    perParent,
    executions: cap(parent.executions * perParent),
    repeat,
  };
}

/** Walk a parsed template against a scope or a typed value. */
export function analyzeGraphPromptTemplate(
  template: GraphPromptTemplate,
  root: GraphPromptAnalysisRoot,
): GraphPromptAnalysis {
  const sources: ReadonlyMap<string, GraphPromptSourceBound> =
    root.kind === "scope" ? root.scope.sources : new Map([[root.source.key, root.source]]);
  const perBranchSources = new Set(
    [...sources.values()].filter((source) => source.perBranch).map((source) => source.key),
  );
  const occurrences: GraphPromptOccurrence[] = [];
  const texts: GraphPromptAnalysis["texts"] = [];
  const top: Frame =
    root.kind === "scope"
      ? { targets: [], scopeRoot: true, perParent: 1, executions: 1, repeat: 1 }
      : {
          targets: [
            {
              source: root.source.key,
              path: [],
              ...(root.source.schema ? { schema: root.source.schema } : {}),
            },
          ],
          scopeRoot: false,
          perParent: 1,
          executions: 1,
          repeat: 1,
        };

  const walk = (nodes: readonly GraphPromptNode[], frames: Frame[], depth: number) => {
    const frame = frames.at(-1)!;
    for (const node of nodes) {
      if (node.kind === "text") {
        texts.push({ text: node.text, offset: node.offset, executions: frame.executions });
        continue;
      }
      if (node.kind === "partial") {
        const port = root.kind === "scope" ? root.scope.ports.get(node.port) : undefined;
        occurrences.push({
          kind: "partial",
          node,
          name: `input.${node.port}`,
          depth,
          executions: frame.executions,
          uses: [],
          ...(port ? {} : { problem: "unknown-port" as const }),
          mayRenderRaw: !port,
          perBranch: port?.perBranch ?? false,
          port: node.port,
        });
        continue;
      }
      const resolution = resolve(frames, node.path, root);
      const occurrence: GraphPromptOccurrence = {
        kind: node.kind === "variable" ? "variable" : node.inverted ? "inverted" : "section",
        node,
        name: node.path.join("."),
        depth,
        executions: frame.executions,
        uses: resolution.uses,
        ...(resolution.problem ? { problem: resolution.problem } : {}),
        mayRenderRaw: node.kind === "variable" && !resolution.certain,
        perBranch: resolution.uses.some((use) => perBranchSources.has(use.source)),
      };
      occurrences.push(occurrence);
      if (node.kind !== "section") continue;
      if (node.inverted || resolution.uses.length === 0) {
        // Inverted bodies render in the enclosing context; an unresolvable
        // section is falsy (its inverted form renders, in the same context).
        walk(node.children, frames, depth + 1);
        continue;
      }
      walk(node.children, [...frames, sectionFrame(frame, resolution.uses, sources)], depth + 1);
    }
  };
  walk(template.nodes, [top], 0);
  return { occurrences, texts };
}

// -------------------------------------------------------------------- size

export interface GraphPromptSizeBound {
  /** With every value at its budget and nothing to escape. */
  nominalBytes: number;
  /** With escaping at its worst: a hard upper bound. */
  maxBytes: number;
}

/**
 * Worst growth of a value's bytes when it is written into a prompt: `<` in
 * JSON becomes `<` (1 byte to 6); in text it becomes `&lt;` (1 to 4).
 */
export const GRAPH_PROMPT_ESCAPE_FACTOR = 6;

export interface GraphPromptBoundOptions {
  /** Bytes a text node renders to (after neutralizing or escaping). */
  textBytes: (text: string) => number;
  /** A partial's bound per expansion. */
  partial?: (port: string) => GraphPromptSizeBound | undefined;
  /**
   * Bytes a variable writes around its value when it resolves through `use`
   * (a node template's inline evidence frame); 0 when it writes it bare.
   */
  valueFrameBytes?: (use: GraphPromptTargetUse) => number;
}

/**
 * The heaviest root-to-node sum of weights in an access trie: how many times
 * the most-read byte of a value can be written.
 */
export function graphPromptHeaviestPath(
  entries: readonly { path: readonly string[]; weight: number }[],
): number {
  let heaviest = 0;
  for (const entry of entries) {
    let total = 0;
    for (const other of entries) {
      if (other.path.length > entry.path.length) continue;
      if (other.path.every((segment, index) => entry.path[index] === segment))
        total += other.weight;
    }
    heaviest = Math.max(heaviest, total);
  }
  return heaviest;
}

/** The size bound of an analyzed template. */
export function graphPromptTemplateBound(
  analysis: GraphPromptAnalysis,
  sources: ReadonlyMap<string, GraphPromptSourceBound>,
  options: GraphPromptBoundOptions,
): GraphPromptSizeBound {
  let fixed = 0;
  let partialNominal = 0;
  let partialMax = 0;
  for (const text of analysis.texts) fixed += options.textBytes(text.text) * text.executions;
  const bySource = new Map<string, { path: string[]; weight: number }[]>();
  for (const occurrence of analysis.occurrences) {
    if (occurrence.kind === "partial") {
      const bound = occurrence.port !== undefined ? options.partial?.(occurrence.port) : undefined;
      if (bound) {
        partialNominal += bound.nominalBytes * occurrence.executions;
        partialMax += bound.maxBytes * occurrence.executions;
      } else {
        fixed += options.textBytes(occurrence.node.raw) * occurrence.executions;
      }
      continue;
    }
    if (occurrence.kind !== "variable") continue;
    if (occurrence.mayRenderRaw)
      fixed += options.textBytes(occurrence.node.raw) * occurrence.executions;
    if (options.valueFrameBytes && occurrence.uses.length > 0) {
      // One execution resolves through one use: the largest frame bounds it.
      const frame = Math.max(...occurrence.uses.map((use) => options.valueFrameBytes!(use)));
      fixed = cap(fixed + frame * occurrence.executions);
    }
    for (const use of occurrence.uses) {
      const entries = bySource.get(use.source) ?? [];
      entries.push({ path: use.path, weight: use.weight });
      bySource.set(use.source, entries);
    }
  }
  let values = 0;
  for (const [key, entries] of bySource) {
    values += graphPromptHeaviestPath(entries) * (sources.get(key)?.bytes ?? 0);
  }
  return {
    nominalBytes: cap(fixed + values + partialNominal),
    maxBytes: cap(fixed + values * GRAPH_PROMPT_ESCAPE_FACTOR + partialMax),
  };
}
