import { createHash } from "node:crypto";
import { canonicalJson } from "@orkestrator/protocol/canonical-json";
import { graphTemplateDigest } from "@orkestrator/protocol/graphs/compile";
import {
  graphActivationKey,
  graphArtifactDigest,
  graphArtifactId,
  parseGraphActivationKey,
  validateGraphArtifact,
  validateGraphRun,
  verifyGraphArtifactIdentity,
  type GraphArtifact,
  type GraphRun,
} from "@orkestrator/protocol/graphs/run";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { graphAgentResultKey, graphAgentSessionKey } from "./graph-agent-state.js";
import type { StorageMigration } from "./storage-database.js";
import { isRecord } from "./storage-shared.js";

/**
 * The one-way rename of the graph and workflow result names to the Rework and
 * Address Findings vocabulary (to-do 4740, tasks 3 and 5).
 *
 * This build knows only the new names: the workflow result kind
 * `address-findings-result` (was `fix-result`), the graph type
 * `address-findings-result@1`, its adapter, the built-in prompts
 * `pipeline-rework`, `address-findings` and `pipeline-address-findings` (were
 * `pipeline-fix`, `fix-review-issues`, `address-review`), the role
 * `addresser` (was `fixer`), the Multi Review parameter `autoAddressFindings`
 * (was `autoFix`) and the action default `addressFindings` (was
 * `fixReviewIssues`). Node ids of the built-ins moved too: a Build Pipeline's
 * `fix` is `rework` and its `address` is `address-findings`; a Multi Review's
 * `fix` is `address-findings` and its `fix-complete` gate
 * `address-findings-complete`. Everything an older build stored under the
 * former names is rewritten once here; the schema bump is the downgrade
 * fence. Names are renamed only in the structural fields that hold them,
 * never in labels, descriptions or prompt text.
 *
 * - `graph-templates`: every user template (and every "Describe a graph"
 *   draft in `graph-describe`), and the saved launch defaults of built-in and
 *   user templates. A node is renamed when its prompt or role says which
 *   step it is (`pipeline-fix` → Rework; `fix-review-issues`,
 *   `address-review` or role `fixer` → Address Findings) and its id has a
 *   `fix` or `address` word; a gate fed by a renamed Address Findings node
 *   whose id says `fix-complete` or `fixed` follows it. Edges, loops,
 *   `firstIterationFrom`, `session.from`, `until` roots, run outputs, layout
 *   and mock pins follow the node; edge ids have the same words replaced.
 *   Verify's `address` input becomes `addressFindings`. A rename that would
 *   collide with a name the template already has is skipped. A pinned digest
 *   of a user sub-graph child that this upgrade changes is re-pinned.
 *   Acknowledgements are keyed by warning digests that include node ids, so
 *   an acknowledged warning on a renamed node shows as pending again (launch
 *   does not need it).
 * - `graph-runs` and `graph-artifacts`: a run freezes its compiled plan,
 *   checked against `plan.digest` on every load, and its artifacts' ids hash
 *   their type, producer node, activation and lineage. A run is rewritten
 *   consistently: the plan with the same renames as a template, its digest
 *   recomputed; activation keys, rewinds, fan-outs, bindings and mock pins;
 *   every artifact whose identity changes gets its digest and id recomputed
 *   (lineage first) and every reference to it follows. Port names keep their
 *   names in a run (built-in prompts bind ports by type). Session keys are
 *   pinned to the key the activation had, so transcripts, provider sessions
 *   and Multi Review session records stay attached, and open workflow result
 *   slots are re-keyed to the key the renamed activation now derives. A run
 *   whose rewrite would not validate is left exactly as it was.
 * - `workflow-results`: entries and receipts of kind `fix-result`, and graph
 *   output slots whose port type is `fix-result@1`.
 * - `scheduled-jobs`: scheduled graph launches of built-in and user
 *   templates, whose roles and parameters are keyed by the template's names.
 *
 * Project templates live in their repositories (`.orkestrator/graphs/`), not
 * here, so they are not rewritten; one that names a former built-in prompt or
 * type fails to compile until it is edited.
 */

export const GRAPH_VOCABULARY_UPGRADE_VERSION = 13;

type Rec = Record<string, unknown>;
type Step = "rework" | "address-findings";

const ROLE_RENAMES: Readonly<Record<string, string>> = { fixer: "addresser" };
const PARAM_RENAMES: Readonly<Record<string, string>> = { autoFix: "autoAddressFindings" };
const PROMPT_RENAMES: Readonly<Record<string, string>> = {
  "pipeline-fix": "pipeline-rework",
  "fix-review-issues": "address-findings",
  "address-review": "pipeline-address-findings",
};
const ADAPTER_RENAMES: Readonly<Record<string, string>> = {
  "fix-result-to-file-list": "address-findings-result-to-file-list",
};
const DEFAULT_SOURCE_RENAMES: Readonly<Record<string, string>> = {
  fixReviewIssues: "addressFindings",
};
const FORMER_KIND = "fix-result";
const CURRENT_KIND = "address-findings-result";
const FORMER_VERIFY_PORT = "address";
const CURRENT_VERIFY_PORT = "addressFindings";

/** Node ids of the built-ins whose ids changed, for pins and keys naming an inlined node. */
const BUILT_IN_NODE_RENAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "multi-review": { fix: "address-findings", "fix-complete": "address-findings-complete" },
  "build-pipeline": { fix: "rework", address: "address-findings" },
};

/** The value as stored JSON: absent fields dropped, as a write would drop them. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Equal as data, whatever the key order (a rewrite rebuilds objects). */
function sameData(left: unknown, right: unknown): boolean {
  return canonicalJson(left, 128) === canonicalJson(right, 128);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function records(value: unknown): Rec[] {
  return asArray(value).filter(isRecord);
}

function renamed(map: Readonly<Record<string, string>>, value: unknown): unknown {
  return typeof value === "string" && Object.hasOwn(map, value) ? map[value] : value;
}

/** `fix-result@N` → `address-findings-result@N`, also inside `list<…>` and a shape's origin. */
function renameTypeText(value: unknown): unknown {
  return typeof value === "string"
    ? value.replace(/(^|[^a-z0-9-])fix-result@/g, `$1${CURRENT_KIND}@`)
    : value;
}

/** A key map with every rename whose new name the owner does not already use. */
function usableRenames(
  map: Readonly<Record<string, string>>,
  existing: readonly unknown[],
): Record<string, string> {
  const names = new Set(existing.filter((name): name is string => typeof name === "string"));
  return Object.fromEntries(
    Object.entries(map).filter(([from, to]) => names.has(from) && !names.has(to)),
  );
}

function renameKeys(value: unknown, map: Readonly<Record<string, string>>): unknown {
  if (!isRecord(value)) return value;
  const next: Rec = {};
  for (const [key, entry] of Object.entries(value)) {
    const target = Object.hasOwn(map, key) && !Object.hasOwn(value, map[key]!) ? map[key]! : key;
    next[target] = entry;
  }
  return next;
}

// ---------------------------------------------------------------- node ids

function splitPlanId(id: string): { prefix: string; local: string } {
  const at = id.lastIndexOf("/");
  return at < 0
    ? { prefix: "", local: id }
    : { prefix: id.slice(0, at + 1), local: id.slice(at + 1) };
}

function agentStep(node: Rec): Step | undefined {
  if (node.kind !== "agent") return undefined;
  const builtIn = isRecord(node.prompt) ? node.prompt.builtIn : undefined;
  if (builtIn === "pipeline-fix") return "rework";
  if (builtIn === "fix-review-issues" || builtIn === "address-review" || node.role === "fixer") {
    return "address-findings";
  }
  return undefined;
}

/** The local id with its step word replaced, or undefined when it has none. */
function renamedAgentLocal(local: string, step: Step): string | undefined {
  const words = local.split("-");
  const index = words.findIndex(
    (word) => word === "fix" || (step === "address-findings" && word === "address"),
  );
  if (index < 0) return undefined;
  words.splice(index, 1, ...step.split("-"));
  return words.join("-");
}

function renamedGateLocal(local: string): string | undefined {
  const words = local.split("-");
  const pair = words.findIndex((word, index) => word === "fix" && words[index + 1] === "complete");
  if (pair >= 0) words.splice(pair, 2, "address", "findings", "complete");
  else {
    const fixed = words.indexOf("fixed");
    if (fixed < 0) return undefined;
    words.splice(fixed, 1, "address", "findings", "complete");
  }
  return words.join("-");
}

/**
 * Old node id → new node id for one graph (a template's nodes, or a plan's,
 * whose ids may carry a sub-graph prefix that is kept).
 */
function nodeRenames(nodes: readonly Rec[], edges: readonly Rec[]): Map<string, string> {
  const ids = new Set(nodes.map((node) => node.id).filter((id) => typeof id === "string"));
  const proposed = new Map<string, string>();
  const addressFindings = new Set<string>();
  for (const node of nodes) {
    if (typeof node.id !== "string") continue;
    const step = agentStep(node);
    if (!step) continue;
    const { prefix, local } = splitPlanId(node.id);
    const next = renamedAgentLocal(local, step);
    if (next) proposed.set(node.id, prefix + next);
    if (step === "address-findings") addressFindings.add(node.id);
  }
  for (const node of nodes) {
    if (node.kind !== "gate" || typeof node.id !== "string") continue;
    const fedByAddressFindings = edges.some(
      (edge) =>
        isRecord(edge.to) &&
        edge.to.node === node.id &&
        isRecord(edge.from) &&
        typeof edge.from.node === "string" &&
        addressFindings.has(edge.from.node),
    );
    if (!fedByAddressFindings) continue;
    const { prefix, local } = splitPlanId(node.id);
    const next = renamedGateLocal(local);
    if (next) proposed.set(node.id, prefix + next);
  }
  const accepted = new Map<string, string>();
  const taken = new Set<string>();
  for (const [from, to] of proposed) {
    // A new id another node keeps, or one already given out, is a collision.
    if ((ids.has(to) && !proposed.has(to)) || taken.has(to)) continue;
    accepted.set(from, to);
    taken.add(to);
  }
  return accepted;
}

/** Replaces whole renamed node ids, word by word, inside an id built from them. */
function renameWords(id: string, locals: ReadonlyMap<string, string>): string {
  const olds = [...locals.keys()].sort((a, b) => b.split("-").length - a.split("-").length);
  const words = id.split("-");
  const out: string[] = [];
  for (let index = 0; index < words.length;) {
    const match = olds.find((old) => {
      const oldWords = old.split("-");
      return oldWords.every((word, offset) => words[index + offset] === word);
    });
    if (match) {
      out.push(...locals.get(match)!.split("-"));
      index += match.split("-").length;
    } else {
      out.push(words[index]!);
      index += 1;
    }
  }
  return out.join("-");
}

/** Old edge id → new edge id: the renamed node ids of the same sub-graph scope, replaced. */
function edgeRenames(
  edges: readonly Rec[],
  nodes: ReadonlyMap<string, string>,
): Map<string, string> {
  const byPrefix = new Map<string, Map<string, string>>();
  for (const [from, to] of nodes) {
    const old = splitPlanId(from);
    const next = splitPlanId(to);
    const locals = byPrefix.get(old.prefix) ?? new Map<string, string>();
    locals.set(old.local, next.local);
    byPrefix.set(old.prefix, locals);
  }
  const ids = new Set(edges.map((edge) => edge.id));
  const accepted = new Map<string, string>();
  for (const edge of edges) {
    if (typeof edge.id !== "string") continue;
    const { prefix, local } = splitPlanId(edge.id);
    const locals = byPrefix.get(prefix);
    if (!locals) continue;
    const next = prefix + renameWords(local, locals);
    if (next === edge.id || ids.has(next) || [...accepted.values()].includes(next)) continue;
    accepted.set(edge.id, next);
  }
  return accepted;
}

// ---------------------------------------------------------------- shared rewriting

interface GraphRenames {
  nodes: ReadonlyMap<string, string>;
  edges: ReadonlyMap<string, string>;
  roles: Readonly<Record<string, string>>;
  params: Readonly<Record<string, string>>;
}

function nodeId(renames: GraphRenames, value: unknown): unknown {
  return typeof value === "string" ? (renames.nodes.get(value) ?? value) : value;
}

function portRef(renames: GraphRenames, value: unknown): unknown {
  return isRecord(value) && typeof value.node === "string"
    ? { ...value, node: nodeId(renames, value.node) }
    : value;
}

/** A predicate with `params.<key>` renamed and, where node ids may be roots, the root node. */
function predicate(renames: GraphRenames, value: unknown, nodeRoots: boolean): unknown {
  if (Array.isArray(value)) return value.map((entry) => predicate(renames, entry, nodeRoots));
  if (!isRecord(value)) return value;
  const next: Rec = { ...value };
  if (typeof value.path === "string") {
    const segments = value.path.split(".");
    if (segments[0] === "params" && segments[1] !== undefined) {
      segments[1] = String(renamed(renames.params, segments[1]));
    } else if (nodeRoots && segments[0] !== undefined) {
      segments[0] = String(nodeId(renames, segments[0]));
    }
    next.path = segments.join(".");
  }
  for (const key of ["all", "any", "not"]) {
    if (key in value) next[key] = predicate(renames, value[key], nodeRoots);
  }
  return next;
}

function transforms(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map((entry) =>
        isRecord(entry) && entry.op === "adapt"
          ? { ...entry, adapter: renamed(ADAPTER_RENAMES, entry.adapter) }
          : entry,
      )
    : value;
}

function role(renames: GraphRenames, value: unknown): unknown {
  return renamed(renames.roles, value);
}

function roleDef(renames: GraphRenames, value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    ...value,
    key: role(renames, value.key),
    ...(Array.isArray(value.defaultsFrom)
      ? {
          defaultsFrom: value.defaultsFrom.map((source) => renamed(DEFAULT_SOURCE_RENAMES, source)),
        }
      : {}),
  };
}

function paramDef(renames: GraphRenames, value: unknown): unknown {
  return isRecord(value) ? { ...value, key: renamed(renames.params, value.key) } : value;
}

function replicate(renames: GraphRenames, value: unknown): unknown {
  if (!isRecord(value)) return value;
  const axis = (entry: unknown): unknown => {
    if (!isRecord(entry)) return entry;
    const next: Rec = { ...entry };
    if ("role" in entry) next.role = role(renames, entry.role);
    if (Array.isArray(entry.lenses)) {
      next.lenses = entry.lenses.map((lens) =>
        isRecord(lens) && "role" in lens ? { ...lens, role: role(renames, lens.role) } : lens,
      );
    }
    return next;
  };
  const next = axis(value) as Rec;
  if (Array.isArray(value.axes)) next.axes = value.axes.map(axis);
  if (typeof value.signature === "string") {
    next.signature = value.signature.replace(
      /(^|[^a-z0-9-])panel:([a-zA-Z0-9_-]+)/g,
      (_match, lead: string, key: string) => `${lead}panel:${String(role(renames, key))}`,
    );
  }
  return next;
}

/** Child role or parameter key → value of this graph, both renamed. */
function childBindings(
  value: unknown,
  childKeys: Readonly<Record<string, string>>,
  rewrite: (entry: unknown) => unknown,
): unknown {
  if (!isRecord(value)) return value;
  const next: Rec = {};
  for (const [key, entry] of Object.entries(value)) {
    next[String(renamed(childKeys, key))] = rewrite(entry);
  }
  return next;
}

function paramBinding(renames: GraphRenames, value: unknown): unknown {
  return isRecord(value) && typeof value.param === "string"
    ? { ...value, param: renamed(renames.params, value.param) }
    : value;
}

// ---------------------------------------------------------------- templates

export interface GraphTemplateUpgradeContext {
  /** A user template's node renames, for pins naming its nodes inside a sub-graph. */
  userNodeRenames?: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** A user template's digest before and after this upgrade, for sub-graph pins. */
  userDigests?: ReadonlyMap<string, { before: string; after: string }>;
}

function templateRenames(template: Rec): GraphRenames {
  const nodes = records(template.nodes);
  const edges = records(template.edges);
  const nodeMap = nodeRenames(nodes, edges);
  return {
    nodes: nodeMap,
    edges: edgeRenames(edges, nodeMap),
    roles: usableRenames(
      ROLE_RENAMES,
      records(template.roles).map((entry) => entry.key),
    ),
    params: usableRenames(
      PARAM_RENAMES,
      records(template.parameters).map((entry) => entry.key),
    ),
  };
}

/** Node ids (after renaming) whose Verify input `address` becomes `addressFindings`. */
function verifyPortNodes(nodes: readonly Rec[], renames: GraphRenames): Set<string> {
  const result = new Set<string>();
  for (const node of nodes) {
    if (node.kind !== "agent" || !isRecord(node.prompt) || node.prompt.builtIn !== "verify")
      continue;
    const names = records(node.inputs).map((port) => port.name);
    if (names.includes(FORMER_VERIFY_PORT) && !names.includes(CURRENT_VERIFY_PORT)) {
      result.add(String(nodeId(renames, node.id)));
    }
  }
  return result;
}

function templatePorts(ports: unknown, verifyPorts: boolean): unknown {
  return Array.isArray(ports)
    ? ports.map((port) => {
        if (!isRecord(port)) return port;
        const next: Rec = { ...port, type: renameTypeText(port.type) };
        if (verifyPorts && port.name === FORMER_VERIFY_PORT) next.name = CURRENT_VERIFY_PORT;
        if (Array.isArray(port.inputs)) next.inputs = templatePorts(port.inputs, false);
        return next;
      })
    : ports;
}

function templateNode(
  renames: GraphRenames,
  node: unknown,
  verifyNodes: ReadonlySet<string>,
  context: GraphTemplateUpgradeContext,
): unknown {
  if (!isRecord(node)) return node;
  const next: Rec = { ...node, id: nodeId(renames, node.id) };
  const verify = verifyNodes.has(String(next.id));
  if ("inputs" in node) {
    next.inputs = templatePorts(node.inputs, verify);
    next.inputs = asArray(next.inputs).map((port) =>
      isRecord(port) && isRecord(port.firstIterationFrom)
        ? { ...port, firstIterationFrom: portRef(renames, port.firstIterationFrom) }
        : port,
    );
  }
  if ("outputs" in node) next.outputs = templatePorts(node.outputs, false);
  if ("when" in node) next.when = predicate(renames, node.when, false);
  if ("role" in node) next.role = role(renames, node.role);
  if (isRecord(node.prompt) && "builtIn" in node.prompt) {
    next.prompt = { ...node.prompt, builtIn: renamed(PROMPT_RENAMES, node.prompt.builtIn) };
  }
  if (isRecord(node.session) && typeof node.session.from === "string") {
    next.session = { ...node.session, from: nodeId(renames, node.session.from) };
  }
  if ("replicate" in node) next.replicate = replicate(renames, node.replicate);
  if (Array.isArray(node.branches)) {
    next.branches = node.branches.map((branch) =>
      isRecord(branch) ? { ...branch, when: predicate(renames, branch.when, false) } : branch,
    );
  }
  if (node.kind === "subgraph") {
    next.params = childBindings(node.params, PARAM_RENAMES, (entry) =>
      paramBinding(renames, entry),
    );
    next.roles = childBindings(node.roles, ROLE_RENAMES, (entry) => role(renames, entry));
    const ref = node.template;
    if (isRecord(ref) && ref.scope === "user" && typeof ref.digest === "string") {
      const digests = context.userDigests?.get(String(ref.id));
      if (digests && digests.before === ref.digest)
        next.template = { ...ref, digest: digests.after };
    }
  }
  return next;
}

/** A sub-graph child's node renames, for a key `<subgraph node>/<child node>`. */
function childNodeRenames(
  template: Rec,
  subgraphNode: string,
  context: GraphTemplateUpgradeContext,
): Readonly<Record<string, string>> | ReadonlyMap<string, string> | undefined {
  const node = records(template.nodes).find((entry) => entry.id === subgraphNode);
  if (!node || node.kind !== "subgraph" || !isRecord(node.template)) return undefined;
  if (node.template.scope === "built-in") return BUILT_IN_NODE_RENAMES[String(node.template.id)];
  if (node.template.scope === "user") return context.userNodeRenames?.get(String(node.template.id));
  return undefined;
}

/** Layout and mock pins: keyed by node id, or `<sub-graph node>/<child node>` for pins. */
function nodeKeyed(
  value: unknown,
  renames: GraphRenames,
  template: Rec,
  context: GraphTemplateUpgradeContext,
): unknown {
  if (!isRecord(value)) return value;
  const next: Rec = {};
  for (const [key, entry] of Object.entries(value)) {
    let target = String(nodeId(renames, key));
    const slash = key.indexOf("/");
    if (slash > 0 && key.indexOf("/", slash + 1) < 0) {
      const outer = key.slice(0, slash);
      const inner = key.slice(slash + 1);
      const child = childNodeRenames(template, outer, context);
      const innerNext =
        child instanceof Map ? child.get(inner) : child ? (child as Rec)[inner] : undefined;
      target = `${String(nodeId(renames, outer))}/${typeof innerNext === "string" ? innerNext : inner}`;
    }
    if (target !== key && Object.hasOwn(value, target)) target = key;
    next[target] = entry;
  }
  return next;
}

function upgradeTemplateValue(template: Rec, context: GraphTemplateUpgradeContext): Rec {
  const renames = templateRenames(template);
  const nodes = records(template.nodes);
  const verifyNodes = verifyPortNodes(nodes, renames);
  const target = (value: unknown): unknown => {
    if (!isRecord(value)) return value;
    const node = nodeId(renames, value.node);
    return {
      ...value,
      node,
      ...(verifyNodes.has(String(node)) && value.port === FORMER_VERIFY_PORT
        ? { port: CURRENT_VERIFY_PORT }
        : {}),
    };
  };
  const next: Rec = { ...template };
  if (Array.isArray(template.parameters)) {
    next.parameters = template.parameters.map((entry) => paramDef(renames, entry));
  }
  if (Array.isArray(template.roles)) {
    next.roles = template.roles.map((entry) => roleDef(renames, entry));
  }
  for (const key of ["inputs", "outputs"] as const) {
    if (!Array.isArray(template[key])) continue;
    next[key] = template[key].map((entry) =>
      isRecord(entry)
        ? {
            ...entry,
            type: renameTypeText(entry.type),
            ...("from" in entry ? { from: portRef(renames, entry.from) } : {}),
          }
        : entry,
    );
  }
  if (Array.isArray(template.nodes)) {
    next.nodes = template.nodes.map((node) => templateNode(renames, node, verifyNodes, context));
  }
  if (Array.isArray(template.edges)) {
    next.edges = template.edges.map((edge) =>
      isRecord(edge)
        ? {
            ...edge,
            id: renames.edges.get(String(edge.id)) ?? edge.id,
            from: portRef(renames, edge.from),
            to: target(edge.to),
            ...("transform" in edge ? { transform: transforms(edge.transform) } : {}),
          }
        : edge,
    );
  }
  if (Array.isArray(template.loops)) {
    next.loops = template.loops.map((loop) =>
      isRecord(loop)
        ? {
            ...loop,
            nodes: asArray(loop.nodes).map((entry) => nodeId(renames, entry)),
            until: predicate(renames, loop.until, true),
            carry: asArray(loop.carry).map((carry) =>
              isRecord(carry)
                ? { ...carry, from: portRef(renames, carry.from), to: target(carry.to) }
                : carry,
            ),
          }
        : loop,
    );
  }
  if ("layout" in template) next.layout = nodeKeyed(template.layout, renames, template, context);
  if ("mockPins" in template) {
    next.mockPins = nodeKeyed(template.mockPins, renames, template, context);
  }
  return next;
}

function isGraphTemplate(value: unknown): value is Rec {
  return isRecord(value) && value.format === "orkestrator.graph";
}

/** One template in the current names; the same reference when nothing changed. */
export function upgradeGraphTemplate(
  template: unknown,
  context: GraphTemplateUpgradeContext = {},
): unknown {
  if (!isGraphTemplate(template)) return template;
  try {
    const next = plain(upgradeTemplateValue(template, context));
    return sameData(next, template) ? template : next;
  } catch {
    // A record this upgrade cannot read is left exactly as it was.
    return template;
  }
}

/** The node renames a template gets (for pins naming its nodes from a parent). */
export function graphTemplateNodeRenames(template: unknown): Map<string, string> {
  if (!isGraphTemplate(template)) return new Map();
  return new Map(templateRenames(template).nodes);
}

function safeDigest(template: unknown): string | undefined {
  try {
    return graphTemplateDigest(template as GraphTemplateV1);
  } catch {
    return undefined;
  }
}

/** The `graph-templates` store: user templates and saved launch defaults. */
export function upgradeGraphTemplatesStore(stored: unknown): unknown {
  if (!isRecord(stored)) return stored;
  const next: Rec = { ...stored };
  let changed = false;
  const templates = isRecord(stored.templates) ? stored.templates : undefined;
  if (templates) {
    const userNodeRenames = new Map<string, ReadonlyMap<string, string>>();
    const userDigests = new Map<string, { before: string; after: string }>();
    for (const [id, row] of Object.entries(templates)) {
      if (!isRecord(row)) continue;
      userNodeRenames.set(id, graphTemplateNodeRenames(row.template));
      const before = safeDigest(row.template);
      const after = safeDigest(upgradeGraphTemplate(row.template, { userNodeRenames }));
      if (before && after && before !== after) userDigests.set(id, { before, after });
    }
    const upgraded: Rec = {};
    for (const [id, row] of Object.entries(templates)) {
      upgraded[id] = row;
      if (!isRecord(row)) continue;
      const template = upgradeGraphTemplate(row.template, { userNodeRenames, userDigests });
      if (template === row.template) continue;
      upgraded[id] = {
        ...row,
        template,
        bytes: Buffer.byteLength(JSON.stringify(template), "utf8"),
      };
      changed = true;
    }
    if (changed) next.templates = upgraded;
  }
  if (isRecord(stored.projects)) {
    const projects: Rec = {};
    let projectsChanged = false;
    for (const [id, settings] of Object.entries(stored.projects)) {
      projects[id] = settings;
      if (!isRecord(settings) || !isRecord(settings.launchDefaults)) continue;
      const defaults: Rec = {};
      let defaultsChanged = false;
      for (const [key, entry] of Object.entries(settings.launchDefaults)) {
        defaults[key] = entry;
        // Project templates keep their names in their repositories.
        if (!isRecord(entry) || key.startsWith("project:")) continue;
        const upgraded = {
          ...entry,
          roles: renameKeys(entry.roles, ROLE_RENAMES),
          params: renameKeys(entry.params, PARAM_RENAMES),
        };
        if (sameData(upgraded, entry)) continue;
        defaults[key] = upgraded;
        defaultsChanged = true;
      }
      if (!defaultsChanged) continue;
      projects[id] = { ...settings, launchDefaults: defaults };
      projectsChanged = true;
    }
    if (projectsChanged) {
      next.projects = projects;
      changed = true;
    }
  }
  return changed ? next : stored;
}

// ---------------------------------------------------------------- plans

function planType(value: unknown): unknown {
  if (!isRecord(value)) return value;
  switch (value.kind) {
    case "named":
      return { ...value, ref: renameTypeText(value.ref) };
    case "list":
      return { ...value, element: planType(value.element) };
    case "shape":
      return { ...value, origin: renameTypeText(value.origin) };
    default:
      return value;
  }
}

function planPorts(renames: GraphRenames, ports: unknown): unknown {
  return asArray(ports).map((port) => {
    if (!isRecord(port)) return port;
    const next: Rec = { ...port, type: renameTypeText(port.type) };
    if ("deliveredType" in port) next.deliveredType = planType(port.deliveredType);
    if ("valueType" in port) next.valueType = planType(port.valueType);
    if (isRecord(port.firstIterationFrom)) {
      next.firstIterationFrom = portRef(renames, port.firstIterationFrom);
    }
    if (Array.isArray(port.edges)) {
      next.edges = port.edges.map((id) => renames.edges.get(String(id)) ?? id);
    }
    return next;
  });
}

function planNode(renames: GraphRenames, node: unknown): unknown {
  if (!isRecord(node)) return node;
  const next: Rec = {
    ...node,
    id: nodeId(renames, node.id),
    inputs: planPorts(renames, node.inputs),
    outputs: planPorts(renames, node.outputs),
  };
  if ("when" in node) next.when = predicate(renames, node.when, false);
  if (isRecord(node.taint) && Array.isArray(node.taint.sources)) {
    next.taint = {
      ...node.taint,
      sources: node.taint.sources.map((source) => nodeId(renames, source)),
    };
  }
  if ("role" in node) next.role = role(renames, node.role);
  if (isRecord(node.prompt) && "builtIn" in node.prompt) {
    next.prompt = { ...node.prompt, builtIn: renamed(PROMPT_RENAMES, node.prompt.builtIn) };
  }
  if (isRecord(node.session) && typeof node.session.from === "string") {
    next.session = { ...node.session, from: nodeId(renames, node.session.from) };
  }
  if ("replicate" in node) next.replicate = replicate(renames, node.replicate);
  if (Array.isArray(node.branches)) {
    next.branches = node.branches.map((branch) =>
      isRecord(branch) ? { ...branch, when: predicate(renames, branch.when, false) } : branch,
    );
  }
  if (node.kind === "subgraph") {
    next.params = childBindings(node.params, PARAM_RENAMES, (entry) =>
      paramBinding(renames, entry),
    );
    next.roles = childBindings(node.roles, ROLE_RENAMES, (entry) => role(renames, entry));
  }
  return next;
}

/** The plan with the renames; its digest is recomputed by the caller. */
function upgradePlan(plan: Rec, renames: GraphRenames): Rec {
  const next: Rec = { ...plan };
  next.parameters = records(plan.parameters).map((entry) => paramDef(renames, entry));
  next.roles = records(plan.roles).map((entry) => roleDef(renames, entry));
  next.typeRefs = asArray(plan.typeRefs)
    .map(renameTypeText)
    .sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
  next.inputs = records(plan.inputs).map((entry) => ({
    ...entry,
    type: renameTypeText(entry.type),
  }));
  next.outputs = records(plan.outputs).map((entry) => ({
    ...entry,
    type: renameTypeText(entry.type),
    from: portRef(renames, entry.from),
  }));
  next.order = asArray(plan.order).map((id) => nodeId(renames, id));
  next.nodes = asArray(plan.nodes).map((node) => planNode(renames, node));
  next.edges = records(plan.edges).map((edge) => ({
    ...edge,
    id: renames.edges.get(String(edge.id)) ?? edge.id,
    from: portRef(renames, edge.from),
    to: portRef(renames, edge.to),
    transform: transforms(edge.transform),
    sourceType: planType(edge.sourceType),
    deliveredType: planType(edge.deliveredType),
  }));
  next.loops = records(plan.loops).map((loop) => ({
    ...loop,
    members: asArray(loop.members).map((id) => nodeId(renames, id)),
    entry: asArray(loop.entry).map((id) => nodeId(renames, id)),
    laterOnly: asArray(loop.laterOnly).map((id) => nodeId(renames, id)),
    until: loopUntil(renames, loop),
    carry: records(loop.carry).map((carry) => ({
      ...carry,
      from: portRef(renames, carry.from),
      to: portRef(renames, carry.to),
      type: planType(carry.type),
    })),
  }));
  if (Array.isArray(plan.subgraphs)) {
    next.subgraphs = records(plan.subgraphs).map((subgraph) => ({
      ...subgraph,
      parameters: records(subgraph.parameters).map((entry) => ({
        ...entry,
        key: renamed(PARAM_RENAMES, entry.key),
      })),
      params: childBindings(subgraph.params, PARAM_RENAMES, (entry) =>
        paramBinding(renames, entry),
      ),
      roles: childBindings(subgraph.roles, ROLE_RENAMES, (entry) => role(renames, entry)),
      nodes: asArray(subgraph.nodes).map((id) => nodeId(renames, id)),
      inputs: isRecord(subgraph.inputs)
        ? Object.fromEntries(
            Object.entries(subgraph.inputs).map(([port, targets]) => [
              port,
              asArray(targets).map((entry) => portRef(renames, entry)),
            ]),
          )
        : subgraph.inputs,
      outputs: isRecord(subgraph.outputs)
        ? Object.fromEntries(
            Object.entries(subgraph.outputs).map(([port, ref]) => [port, portRef(renames, ref)]),
          )
        : subgraph.outputs,
    }));
  }
  if (isRecord(plan.cost)) {
    next.cost = {
      ...plan.cost,
      nodes: records(plan.cost.nodes).map((entry) => ({
        ...entry,
        nodeId: nodeId(renames, entry.nodeId),
      })),
    };
  }
  if (isRecord(plan.acknowledgements)) {
    const refs = (list: unknown) =>
      records(list).map((entry) => ({ ...entry, nodeId: nodeId(renames, entry.nodeId) }));
    next.acknowledgements = {
      ...plan.acknowledgements,
      accepted: refs(plan.acknowledgements.accepted),
      pending: refs(plan.acknowledgements.pending),
    };
  }
  return next;
}

/** `until` roots are node ids of the loop's own scope (its sub-graph prefix). */
function loopUntil(renames: GraphRenames, loop: Rec): unknown {
  const prefix = typeof loop.id === "string" ? splitPlanId(loop.id).prefix : "";
  if (!prefix) return predicate(renames, loop.until, true);
  const scoped = new Map<string, string>();
  for (const [from, to] of renames.nodes) {
    if (from.startsWith(prefix)) scoped.set(from.slice(prefix.length), to.slice(prefix.length));
  }
  return predicate({ ...renames, nodes: new Map([...renames.nodes, ...scoped]) }, loop.until, true);
}

function planRenames(plan: Rec): GraphRenames {
  const nodes = records(plan.nodes);
  const edges = records(plan.edges);
  const nodeMap = nodeRenames(nodes, edges);
  return {
    nodes: nodeMap,
    edges: edgeRenames(edges, nodeMap),
    roles: usableRenames(
      ROLE_RENAMES,
      records(plan.roles).map((entry) => entry.key),
    ),
    params: usableRenames(
      PARAM_RENAMES,
      records(plan.parameters).map((entry) => entry.key),
    ),
  };
}

function nativeHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** `graphPlanDigest` over the native hash (as `verifyGraphPlanDigestNative` checks it). */
function planDigest(plan: Rec): string {
  const { digest: _digest, ...rest } = plan;
  return nativeHash(canonicalJson(rest, 128));
}

// ---------------------------------------------------------------- runs

export interface GraphRunUpgrade {
  run: GraphRun;
  artifacts: GraphArtifact[];
  /** Workflow result slot key before → after, for re-keying `workflow-results`. */
  resultKeys: Map<string, string>;
}

function artifactIds(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((entry) => artifactIds(entry, ids));
  return typeof value === "string" ? (ids.get(value) ?? value) : value;
}

function mappedRecord(value: unknown, map: (entry: unknown) => unknown): unknown {
  return isRecord(value)
    ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, map(entry)]))
    : value;
}

/**
 * The artifacts with their type and producer renamed and their digests and
 * ids recomputed, lineage first, plus old id → new id. An artifact whose
 * stored identity does not verify is kept as it is.
 */
function upgradeArtifacts(
  artifacts: readonly GraphArtifact[],
  renames: GraphRenames,
  keys: ReadonlyMap<string, string>,
): { artifacts: GraphArtifact[]; ids: Map<string, string> } {
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const ids = new Map<string, string>();
  const done = new Map<string, GraphArtifact>();
  const visiting = new Set<string>();
  const upgrade = (artifact: GraphArtifact): GraphArtifact => {
    const cached = done.get(artifact.id);
    if (cached) return cached;
    if (visiting.has(artifact.id) || !verifyGraphArtifactIdentity(artifact, nativeHash).ok) {
      done.set(artifact.id, artifact);
      return artifact;
    }
    visiting.add(artifact.id);
    const inputs = artifact.inputs.map((id) => {
      const source = byId.get(id);
      return source ? upgrade(source).id : id;
    });
    visiting.delete(artifact.id);
    const type = String(renameTypeText(artifact.type));
    const producer = {
      ...artifact.producer,
      nodeId: String(nodeId(renames, artifact.producer.nodeId)),
      activation: keys.get(artifact.producer.activation) ?? artifact.producer.activation,
    };
    const digest =
      type === artifact.type
        ? artifact.digest
        : graphArtifactDigest(type, artifact.body, nativeHash);
    const id = graphArtifactId(
      {
        digest,
        runId: artifact.runId,
        producer,
        inputs,
        ...(artifact.workspace ? { workspace: artifact.workspace } : {}),
        ...(artifact.sourceItem !== undefined ? { sourceItem: artifact.sourceItem } : {}),
      },
      nativeHash,
    );
    const rebuilt: GraphArtifact = { ...artifact, id, digest, type, producer, inputs };
    const next = sameData(rebuilt, artifact) ? artifact : rebuilt;
    if (id !== artifact.id) ids.set(artifact.id, id);
    done.set(artifact.id, next);
    return next;
  };
  return { artifacts: artifacts.map(upgrade), ids };
}

/**
 * One run and its artifacts in the current names, or null when nothing
 * changes or the rewritten run would not validate.
 */
export function upgradeGraphRun(
  run: unknown,
  artifacts: readonly unknown[],
): GraphRunUpgrade | null {
  if (!isRecord(run) || !isRecord(run.plan) || typeof run.id !== "string") return null;
  try {
    return upgradeReadableGraphRun(run as Rec & { plan: Rec; id: string }, artifacts);
  } catch {
    // A record this upgrade cannot read is left exactly as it was.
    return null;
  }
}

function upgradeReadableGraphRun(
  run: Rec & { plan: Rec; id: string },
  artifacts: readonly unknown[],
): GraphRunUpgrade | null {
  const plan = run.plan;
  const renames = planRenames(plan);
  const nextPlan = plain(upgradePlan(plan, renames));
  nextPlan.digest = planDigest(nextPlan);

  // Activation keys of renamed nodes.
  const keys = new Map<string, string>();
  for (const activation of records(run.activations)) {
    if (typeof activation.key !== "string" || typeof activation.nodeId !== "string") continue;
    const to = renames.nodes.get(activation.nodeId);
    const parts = parseGraphActivationKey(activation.key);
    if (!to || !parts) continue;
    keys.set(activation.key, graphActivationKey({ ...parts, nodeId: to }));
  }
  const key = (value: unknown) => (typeof value === "string" ? (keys.get(value) ?? value) : value);

  const storedArtifacts = artifacts.filter(
    (artifact): artifact is GraphArtifact =>
      isRecord(artifact) && artifact.runId === run.id && typeof artifact.id === "string",
  );
  const upgradedArtifacts = upgradeArtifacts(storedArtifacts, renames, keys);
  const ids = upgradedArtifacts.ids;

  // Output ports by node, for the result slot keys a renamed activation derives.
  const outputPorts = new Map<string, string[]>();
  for (const node of records(plan.nodes)) {
    outputPorts.set(
      String(node.id),
      records(node.outputs).map((port) => String(port.name)),
    );
  }
  const resultKeys = new Map<string, string>();

  const activations = records(run.activations).map((activation) => {
    const next: Rec = {
      ...activation,
      nodeId: nodeId(renames, activation.nodeId),
      key: key(activation.key),
      inputs: mappedRecord(activation.inputs, (entry) => artifactIds(entry, ids)),
      outputs: mappedRecord(activation.outputs, (entry) => artifactIds(entry, ids)),
    };
    if (isRecord(activation.session)) {
      const session: Rec = { ...activation.session };
      if (typeof session.continuedFrom === "string")
        session.continuedFrom = key(session.continuedFrom);
      const oldKey = String(activation.key);
      const newKey = String(next.key);
      if (newKey !== oldKey) {
        // The provider session, its transcripts and a Multi Review's record
        // were derived from the former key: keep that key.
        if (session.sessionKey === undefined) {
          session.sessionKey = graphAgentSessionKey(run.id, oldKey);
        }
        if (typeof session.requestId === "string") {
          for (const port of outputPorts.get(String(activation.nodeId)) ?? []) {
            resultKeys.set(
              graphAgentResultKey(run.id, oldKey, session.requestId, port),
              graphAgentResultKey(run.id, newKey, session.requestId, port),
            );
          }
        }
        if (isRecord(session.resultKeys)) {
          session.resultKeys = mappedRecord(session.resultKeys, (entry) =>
            typeof entry === "string" ? (resultKeys.get(entry) ?? entry) : entry,
          );
        }
      }
      next.session = session;
    }
    if (isRecord(activation.human) && isRecord(activation.human.answer)) {
      const answer = activation.human.answer;
      if (isRecord(answer.edited)) {
        next.human = {
          ...activation.human,
          answer: {
            ...answer,
            edited: { ...answer.edited, artifactId: artifactIds(answer.edited.artifactId, ids) },
          },
        };
      }
    }
    return next;
  });

  const bindings = isRecord(run.bindings) ? run.bindings : {};
  const rebuilt: Rec = {
    ...run,
    plan: nextPlan,
    bindings: {
      ...bindings,
      roles: renameKeys(bindings.roles, renames.roles),
      params: renameKeys(bindings.params, renames.params),
      inputs: mappedRecord(bindings.inputs, (entry) => artifactIds(entry, ids)),
    },
    activations,
    rewinds: records(run.rewinds).map((rewind) => ({
      ...rewind,
      nodeId: nodeId(renames, rewind.nodeId),
      activation: key(rewind.activation),
      superseded: isRecord(rewind.superseded)
        ? {
            ...rewind.superseded,
            activations: asArray(rewind.superseded.activations).map(key),
            artifacts: artifactIds(rewind.superseded.artifacts, ids),
          }
        : rewind.superseded,
    })),
  };
  if (Array.isArray(run.fanOuts)) {
    rebuilt.fanOuts = records(run.fanOuts).map((fanOut) => ({
      ...fanOut,
      nodeId: nodeId(renames, fanOut.nodeId),
      sources: artifactIds(fanOut.sources, ids),
      items: records(fanOut.items).map((item) => ({
        ...item,
        artifact: artifactIds(item.artifact, ids),
      })),
    }));
  }
  if (isRecord(run.mockOptions) && isRecord(run.mockOptions.pins)) {
    rebuilt.mockOptions = {
      ...run.mockOptions,
      pins: renameKeys(run.mockOptions.pins, Object.fromEntries(renames.nodes)),
    };
  }

  const next = plain(rebuilt);
  const changedArtifacts = upgradedArtifacts.artifacts.some(
    (artifact, index) => artifact !== storedArtifacts[index],
  );
  if (!changedArtifacts && sameData(next, run)) return null;

  const validation = validateGraphRun(next, {
    verifyPlan: (candidate) => candidate.digest === planDigest(candidate as unknown as Rec),
  });
  if (!validation.ok) return null;
  for (const artifact of upgradedArtifacts.artifacts) {
    if (!validateGraphArtifact(artifact).ok) return null;
  }
  return { run: validation.value, artifacts: upgradedArtifacts.artifacts, resultKeys };
}

/** The `graph-runs` and `graph-artifacts` stores, and the slot keys to move. */
export function upgradeGraphRunStores(
  runs: unknown,
  artifacts: unknown,
): { runs: unknown; artifacts: unknown; resultKeys: Map<string, string> } {
  const resultKeys = new Map<string, string>();
  if (!isRecord(runs)) return { runs, artifacts, resultKeys };
  const artifactRows = isRecord(artifacts) ? artifacts : {};
  const byRun = new Map<string, unknown[]>();
  for (const row of Object.values(artifactRows)) {
    if (!isRecord(row) || typeof row.runId !== "string" || typeof row.id !== "string") continue;
    const list = byRun.get(row.runId) ?? [];
    list.push(row);
    byRun.set(row.runId, list);
  }
  let nextRuns: Rec | undefined;
  let nextArtifacts: Rec | undefined;
  for (const [id, run] of Object.entries(runs)) {
    const upgrade = upgradeGraphRun(run, byRun.get(id) ?? []);
    if (!upgrade) continue;
    nextRuns ??= { ...runs };
    nextRuns[id] = upgrade.run;
    nextArtifacts ??= { ...artifactRows };
    for (const old of byRun.get(id) ?? []) delete nextArtifacts[`${id}/${(old as Rec).id}`];
    for (const artifact of upgrade.artifacts) nextArtifacts[`${id}/${artifact.id}`] = artifact;
    for (const [from, to] of upgrade.resultKeys) resultKeys.set(from, to);
  }
  return { runs: nextRuns ?? runs, artifacts: nextArtifacts ?? artifacts, resultKeys };
}

// ---------------------------------------------------------------- other stores

/** `workflow-results`: the kind, receipts, graph output port types and re-keyed slots. */
export function upgradeWorkflowResultsStore(
  stored: unknown,
  resultKeys: ReadonlyMap<string, string> = new Map(),
): unknown {
  if (!isRecord(stored) || !isRecord(stored.entries)) return stored;
  let changed = false;
  const entries: Rec = {};
  for (const [key, entry] of Object.entries(stored.entries)) {
    if (!isRecord(entry)) {
      entries[key] = entry;
      continue;
    }
    const target = resultKeys.get(key);
    const nextKey = target && !Object.hasOwn(stored.entries, target) ? target : key;
    const next: Rec = { ...entry, kind: renamed({ [FORMER_KIND]: CURRENT_KIND }, entry.kind) };
    if (nextKey !== key) next.resultKey = nextKey;
    if (isRecord(entry.receipt)) {
      next.receipt = {
        ...entry.receipt,
        kind: renamed({ [FORMER_KIND]: CURRENT_KIND }, entry.receipt.kind),
        ...(nextKey !== key ? { resultKey: nextKey } : {}),
      };
    }
    if (isRecord(entry.context) && entry.context.type === "graph-output") {
      next.context = { ...entry.context, artifactType: renameTypeText(entry.context.artifactType) };
    }
    if (nextKey === key && sameData(next, entry)) {
      entries[key] = entry;
      continue;
    }
    changed = true;
    entries[nextKey] = next;
  }
  return changed ? { ...stored, entries } : stored;
}

/** `scheduled-jobs`: graph launches of built-in and user templates. */
export function upgradeScheduledJobsStore(stored: unknown): unknown {
  if (!isRecord(stored)) return stored;
  let changed = false;
  const next: Rec = {};
  for (const [id, job] of Object.entries(stored)) {
    next[id] = job;
    if (!isRecord(job) || !isRecord(job.action) || job.action.kind !== "graph") continue;
    const request = job.action.request;
    if (!isRecord(request) || !isRecord(request.ref) || request.ref.scope === "project") continue;
    const upgraded = {
      ...request,
      ...("roles" in request ? { roles: renameKeys(request.roles, ROLE_RENAMES) } : {}),
      ...("params" in request ? { params: renameKeys(request.params, PARAM_RENAMES) } : {}),
    };
    if (sameData(upgraded, request)) continue;
    next[id] = { ...job, action: { ...job.action, request: upgraded } };
    changed = true;
  }
  return changed ? next : stored;
}

/** `graph-describe`: a completed job's unsaved draft. */
export function upgradeGraphDescribeStore(stored: unknown): unknown {
  if (!isRecord(stored)) return stored;
  let changed = false;
  const next: Rec = {};
  for (const [id, job] of Object.entries(stored)) {
    next[id] = job;
    if (!isRecord(job) || !("template" in job)) continue;
    const template = upgradeGraphTemplate(job.template);
    if (template === job.template) continue;
    next[id] = { ...job, template };
    changed = true;
  }
  return changed ? next : stored;
}

export const graphVocabularyUpgradeMigration: StorageMigration = {
  version: GRAPH_VOCABULARY_UPGRADE_VERSION,
  name: "rename-graph-vocabulary",
  up({ database }) {
    // Absent or unreadable: nothing an older build wrote is left to upgrade.
    const rewrite = (store: string, upgrade: (value: unknown) => unknown) => {
      const stored = database.readStoreValueInTransaction(store);
      if (!stored) return;
      const next = upgrade(stored.value);
      if (next !== stored.value) database.writeStoreInTransaction(store, next);
    };
    rewrite("graph-templates", upgradeGraphTemplatesStore);
    rewrite("graph-describe", upgradeGraphDescribeStore);
    rewrite("scheduled-jobs", upgradeScheduledJobsStore);

    let resultKeys = new Map<string, string>();
    const runs = database.readStoreValueInTransaction("graph-runs");
    if (runs) {
      const artifacts = database.readStoreValueInTransaction("graph-artifacts");
      const upgraded = upgradeGraphRunStores(runs.value, artifacts?.value ?? {});
      resultKeys = upgraded.resultKeys;
      if (upgraded.runs !== runs.value)
        database.writeStoreInTransaction("graph-runs", upgraded.runs);
      if (artifacts && upgraded.artifacts !== artifacts.value) {
        database.writeStoreInTransaction("graph-artifacts", upgraded.artifacts);
      }
    }
    rewrite("workflow-results", (value) => upgradeWorkflowResultsStore(value, resultKeys));
  },
};
