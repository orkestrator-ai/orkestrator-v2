import { describe, expect, test } from "bun:test";
import {
  GRAPH_TEMPLATE_EXAMPLE_KEYS,
  graphTemplateExample,
  graphTemplateExamples,
  type GraphTemplateExampleKey,
} from "./examples";
import { GRAPH_TEMPLATE_BOUNDS as B } from "./grammar";
import {
  GRAPH_CAPABILITY_PROFILES,
  GRAPH_ROLE_DEFAULT_ACTION_KEYS,
  graphNodeOutlets,
  isGraphTemplateV1,
  parseGraphTemplate,
  validateGraphTemplate,
  type GraphNodeSpec,
} from "./template";
import { ACTION_DEFAULT_KEYS } from "../action-defaults";

// Tests edit templates freely, including into shapes the types forbid.
// oxlint-disable-next-line typescript/no-explicit-any
type Draft = any;

function errorsOf(value: unknown) {
  const result = validateGraphTemplate(value);
  return result.ok ? [] : result.errors;
}

function draft(key: GraphTemplateExampleKey = "multi-review"): Draft {
  return graphTemplateExample(key);
}

function nodeIndex(template: Draft, id: string): number {
  const index = (template.nodes as Array<{ id: string }>).findIndex((node) => node.id === id);
  if (index < 0) throw new Error(`no node ${id}`);
  return index;
}

function node(template: Draft, id: string): Draft {
  return template.nodes[nodeIndex(template, id)];
}

const repeat = <T>(count: number, make: (index: number) => T): T[] =>
  Array.from({ length: count }, (_, index) => make(index));

const LONG_ID = `a${"b".repeat(B.maxIdChars)}`;
const DIGEST = "a".repeat(64);

interface Case {
  name: string;
  key?: GraphTemplateExampleKey;
  edit: (template: Draft) => void;
  path: string;
  code: string;
}

function expectCase({ key, edit, path, code }: Case) {
  const template = draft(key);
  edit(template);
  const errors = errorsOf(template);
  expect(errors).toContainEqual(expect.objectContaining({ path, code }));
}

describe("report §9 examples", () => {
  test.each(GRAPH_TEMPLATE_EXAMPLE_KEYS.map((key) => [key]))("%s is accepted", (key) => {
    const result = validateGraphTemplate(graphTemplateExample(key));
    expect(result.ok ? [] : result.errors).toEqual([]);
    expect(isGraphTemplateV1(graphTemplateExample(key))).toBe(true);
  });

  test("they round-trip through JSON text", () => {
    for (const { template } of graphTemplateExamples()) {
      expect(parseGraphTemplate(JSON.stringify(template)).ok).toBe(true);
    }
  });

  test("each accessor returns a fresh copy", () => {
    const first = graphTemplateExample("multi-review") as Draft;
    first.nodes[0].id = "changed";
    first.roles[1].defaultsFrom.push("verify");
    expect(graphTemplateExample("multi-review").nodes[0]!.id).toBe("plan");
    expect(graphTemplateExample("multi-review").roles[1]!.defaultsFrom).toEqual([
      "review",
      "review2",
      "additionalReviewers",
    ]);
  });

  test("they cover every node kind, the §9 loop, fan-in, lenses and items", () => {
    const examples = graphTemplateExamples();
    expect(examples.map((example) => example.reportSection)).toEqual(["9.1", "9.2", "9.3", "9.4"]);
    const kinds = new Set(
      examples.flatMap((example) => example.template.nodes.map((entry) => entry.kind)),
    );
    expect([...kinds].sort()).toEqual(["agent", "gate", "human", "merge", "subgraph", "system"]);
    const replicated = examples.flatMap((example) =>
      example.template.nodes.flatMap((entry) =>
        "replicate" in entry && entry.replicate ? [entry.replicate.over] : [],
      ),
    );
    expect(replicated.sort()).toEqual(["items", "lenses", "panel"]);
    const loop = graphTemplateExample("build-pipeline-loop").loops![0]!;
    expect(loop.maxIterations).toBe(3);
    expect(loop.carry).toHaveLength(2);
  });
});

describe("vocabulary", () => {
  test("role defaults name ActionDefaultKey values", () => {
    for (const key of GRAPH_ROLE_DEFAULT_ACTION_KEYS) {
      expect(ACTION_DEFAULT_KEYS as readonly string[]).toContain(key);
    }
  });

  test("there is no shipper profile (D12)", () => {
    expect(GRAPH_CAPABILITY_PROFILES as readonly string[]).not.toContain("shipper");
  });

  test("bounds are frozen", () => {
    expect(Object.isFrozen(B)).toBe(true);
    expect(B.maxBranches).toBe(32);
    expect(B.maxValueArtifactBytes).toBe(384 * 1024);
  });

  test("graphNodeOutlets lists gate and human outlets", () => {
    const multiReview = graphTemplateExample("multi-review");
    const gate = multiReview.nodes.find((entry) => entry.id === "has-findings")!;
    expect(graphNodeOutlets(gate)).toEqual(["findings", "clean"]);
    const approve = graphTemplateExample("design-bake-off").nodes.find(
      (entry) => entry.id === "approve",
    )!;
    expect(graphNodeOutlets(approve)).toEqual(["approved", "rejected"]);
    const choose = {
      id: "pick",
      kind: "human",
      inputs: [{ name: "x", type: "text@1" }],
      form: {
        kind: "choose",
        options: [
          { to: "left", label: "Left" },
          { to: "right", label: "Right" },
        ],
      },
    } satisfies GraphNodeSpec;
    expect(graphNodeOutlets(choose)).toEqual(["left", "right"]);
    expect(graphNodeOutlets(multiReview.nodes[0]!)).toBeUndefined();
  });
});

describe("document envelope", () => {
  test("rejects non-objects, other formats and versions", () => {
    expect(errorsOf(null)[0]).toMatchObject({ path: "$", code: "type" });
    expect(errorsOf([])[0]).toMatchObject({ path: "$", code: "type" });
    const wrongFormat = draft();
    wrongFormat.format = "orkestrator.flow";
    expect(errorsOf(wrongFormat)[0]).toMatchObject({ path: "format", code: "format" });
    const nextVersion = draft();
    nextVersion.formatVersion = 2;
    expect(errorsOf(nextVersion)[0]).toMatchObject({
      path: "formatVersion",
      code: "unsupported_version",
    });
  });

  test("rejects unknown top-level fields", () => {
    const template = draft();
    template.script = "return 1";
    expect(errorsOf(template)).toContainEqual(
      expect.objectContaining({ path: "script", code: "unknown_field" }),
    );
  });

  test.each([
    "id",
    "revision",
    "name",
    "parameters",
    "roles",
    "inputs",
    "workspace",
    "nodes",
    "edges",
    "limits",
  ])("requires %s", (field) => {
    const template = draft();
    delete template[field];
    expect(errorsOf(template)).toContainEqual(
      expect.objectContaining({ path: field, code: "required" }),
    );
  });

  test("optional sections may be omitted", () => {
    const template = draft("design-bake-off");
    for (const field of [
      "types",
      "outputs",
      "loops",
      "layout",
      "acknowledgements",
      "description",
    ]) {
      delete template[field];
    }
    // design-brief@1 is still referenced, but resolving types is the compiler's job.
    expect(errorsOf(template)).toEqual([]);
  });

  test("rejects a document over the byte bound before walking it", () => {
    const template = draft();
    template.description = "x".repeat(B.maxTemplateBytes);
    expect(errorsOf(template)).toEqual([expect.objectContaining({ path: "$", code: "too_large" })]);
  });

  test("rejects a document over the depth bound", () => {
    const template = draft();
    let deep: Draft = {};
    for (let index = 0; index < B.maxTemplateDepth + 2; index++) deep = { all: [deep] };
    template.nodes[0].when = deep;
    expect(errorsOf(template)).toEqual([expect.objectContaining({ path: "$", code: "too_deep" })]);
  });

  test("rejects values that are not JSON", () => {
    const cyclic = draft();
    cyclic.layout = { plan: { x: 1n, y: 0 } };
    expect(errorsOf(cyclic)).toEqual([expect.objectContaining({ path: "$", code: "not_json" })]);
  });

  test("caps the number of reported errors", () => {
    const template = draft();
    template.nodes = repeat(B.maxNodes, (index) => ({ kind: "agent", id: `n-${index}` }));
    const result = validateGraphTemplate(template);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(50);
      expect(result.omittedErrors).toBeGreaterThan(0);
    }
  });
});

describe("parseGraphTemplate", () => {
  test("refuses duplicate keys, bad JSON and oversized text", () => {
    const duplicate = parseGraphTemplate('{"format":"orkestrator.graph","format":"x"}');
    expect(duplicate.ok ? [] : duplicate.errors).toEqual([
      expect.objectContaining({ code: "invalid_json" }),
    ]);
    const broken = parseGraphTemplate("{");
    expect(broken.ok).toBe(false);
    const oversized = parseGraphTemplate(" ".repeat(B.maxTemplateBytes + 1));
    expect(oversized.ok ? [] : oversized.errors).toEqual([
      expect.objectContaining({ path: "$", code: "too_large" }),
    ]);
  });

  test("keeps prototype keys as data and rejects them by grammar", () => {
    const template = draft();
    const text = JSON.stringify(template).replace(
      '"limits":',
      '"layout":{"__proto__":{"x":1,"y":2}},"limits":',
    );
    const result = parseGraphTemplate(text);
    expect(result.ok ? [] : result.errors).toContainEqual(
      expect.objectContaining({ path: "layout.__proto__", code: "pattern" }),
    );
  });
});

const GRAMMAR_CASES: Case[] = [
  {
    name: "template id grammar",
    edit: (t) => (t.id = "Multi_Review"),
    path: "id",
    code: "pattern",
  },
  { name: "template id length", edit: (t) => (t.id = LONG_ID), path: "id", code: "too_long" },
  { name: "empty id", edit: (t) => (t.id = ""), path: "id", code: "empty" },
  {
    name: "negative revision",
    edit: (t) => (t.revision = -1),
    path: "revision",
    code: "out_of_range",
  },
  {
    name: "fractional revision",
    edit: (t) => (t.revision = 1.5),
    path: "revision",
    code: "not_integer",
  },
  { name: "blank name", edit: (t) => (t.name = "   "), path: "name", code: "empty" },
  {
    name: "multi-line name",
    edit: (t) => (t.name = "a\nb"),
    path: "name",
    code: "control_character",
  },
  {
    name: "bidi override in a label",
    edit: (t) => (t.nodes[0].label = "Plan‮"),
    path: "nodes[0].label",
    code: "control_character",
  },
  { name: "padded name", edit: (t) => (t.name = " Review"), path: "name", code: "whitespace" },
  {
    name: "unknown engine",
    edit: (t) => (t.engine = "feature-build"),
    path: "engine",
    code: "enum",
  },
  {
    name: "node id grammar",
    edit: (t) => (t.nodes[0].id = "plan step"),
    path: "nodes[0].id",
    code: "pattern",
  },
  {
    name: "port name grammar",
    edit: (t) => (t.nodes[0].inputs[0].name = "code-in"),
    path: "nodes[0].inputs[0].name",
    code: "pattern",
  },
  {
    name: "type ref without a version",
    edit: (t) => (t.nodes[0].inputs[0].type = "workspace"),
    path: "nodes[0].inputs[0].type",
    code: "type_ref",
  },
  {
    name: "unbalanced list type",
    edit: (t) => (t.nodes[0].inputs[0].type = "list<workspace@1"),
    path: "nodes[0].inputs[0].type",
    code: "type_ref",
  },
  {
    name: "list nested too deep",
    edit: (t) => (t.nodes[0].inputs[0].type = "list<list<list<workspace@1>>>"),
    path: "nodes[0].inputs[0].type",
    code: "type_ref",
  },
  {
    name: "type version zero",
    edit: (t) => (t.nodes[0].inputs[0].type = "workspace@0"),
    path: "nodes[0].inputs[0].type",
    code: "type_ref",
  },
  {
    name: "predicate path grammar",
    edit: (t) => (node(t, "fix").when = { path: "params..autoFix", op: "exists" }),
    path: "nodes[5].when.path",
    code: "pattern",
  },
  {
    name: "acknowledgement digest",
    edit: (t) =>
      (t.acknowledgements = [
        { kind: "taint", digest: "ABC", acknowledgedAt: "2026-10-29T00:00:00Z" },
      ]),
    path: "acknowledgements[0].digest",
    code: "pattern",
  },
  {
    name: "acknowledgement timestamp",
    edit: (t) =>
      (t.acknowledgements = [{ kind: "taint", digest: DIGEST, acknowledgedAt: "yesterday" }]),
    path: "acknowledgements[0].acknowledgedAt",
    code: "timestamp",
  },
];

describe("ID and label grammar", () => {
  test.each(GRAMMAR_CASES.map((entry) => [entry.name, entry]))("%s", (_name, entry) =>
    expectCase(entry as Case),
  );
});

const longText = (bytes: number) => "x".repeat(bytes + 1);
// Two UTF-8 bytes per character: within a character bound, over a byte bound.
const longMultibyte = (bytes: number) => "é".repeat(Math.floor(bytes / 2) + 1);

const BOUND_CASES: Case[] = [
  {
    name: "name bytes",
    edit: (t) => (t.name = longMultibyte(B.maxNameBytes)),
    path: "name",
    code: "too_large",
  },
  {
    name: "description bytes",
    edit: (t) => (t.description = longText(B.maxDescriptionBytes)),
    path: "description",
    code: "too_large",
  },
  {
    name: "node label bytes",
    edit: (t) => (t.nodes[0].label = longText(B.maxLabelBytes)),
    path: "nodes[0].label",
    code: "too_large",
  },
  {
    name: "port description bytes",
    edit: (t) => (t.nodes[0].outputs[0].description = longText(B.maxPortDescriptionBytes)),
    path: "nodes[0].outputs[0].description",
    code: "too_large",
  },
  {
    name: "parameter count",
    edit: (t) =>
      (t.parameters = repeat(B.maxParameters + 1, (i) => ({ key: `p${i}`, type: "boolean" }))),
    path: "parameters",
    code: "too_many",
  },
  {
    name: "enum option count",
    edit: (t) =>
      (t.parameters = [
        { key: "mode", type: "enum", options: repeat(B.maxEnumOptions + 1, (i) => `o${i}`) },
      ]),
    path: "parameters[0].options",
    code: "too_many",
  },
  {
    name: "string parameter default bytes",
    edit: (t) =>
      (t.parameters = [
        { key: "brief", type: "string", default: longText(B.maxStringParameterBytes) },
      ]),
    path: "parameters[0].default",
    code: "too_large",
  },
  {
    name: "string parameter maxBytes",
    edit: (t) =>
      (t.parameters = [{ key: "brief", type: "string", maxBytes: B.maxStringParameterBytes + 1 }]),
    path: "parameters[0].maxBytes",
    code: "out_of_range",
  },
  {
    name: "string parameter default over its own maxBytes",
    edit: (t) => (t.parameters = [{ key: "brief", type: "string", maxBytes: 4, default: "hello" }]),
    path: "parameters[0].default",
    code: "too_large",
  },
  {
    name: "number parameter magnitude",
    edit: (t) => (t.parameters = [{ key: "n", type: "number", default: 1e13 }]),
    path: "parameters[0].default",
    code: "out_of_range",
  },
  {
    name: "role count",
    edit: (t) => (t.roles = repeat(B.maxRoles + 1, (i) => ({ key: `r${i}`, multiplicity: "one" }))),
    path: "roles",
    code: "too_many",
  },
  {
    name: "maxPanel",
    edit: (t) => (t.roles[1].maxPanel = B.maxBranches + 1),
    path: "roles[1].maxPanel",
    code: "out_of_range",
  },
  {
    name: "defaultsFrom count",
    edit: (t) =>
      (t.roles[1].defaultsFrom = [...GRAPH_ROLE_DEFAULT_ACTION_KEYS, "additionalReviewers", "pr"]),
    path: "roles[1].defaultsFrom",
    code: "too_many",
  },
  {
    name: "type count",
    key: "design-bake-off",
    edit: (t) => (t.types = repeat(B.maxTypes + 1, (i) => ({ ...t.types[0], name: `t${i}` }))),
    path: "types",
    code: "too_many",
  },
  {
    name: "run input count",
    edit: (t) =>
      (t.inputs = repeat(B.maxRunInputs + 1, (i) => ({ name: `in${i}`, type: "text@1" }))),
    path: "inputs",
    code: "too_many",
  },
  {
    name: "run output count",
    edit: (t) =>
      (t.outputs = repeat(B.maxRunOutputs + 1, (i) => ({
        name: `out${i}`,
        type: "text@1",
        from: { node: "plan", port: "plan" },
      }))),
    path: "outputs",
    code: "too_many",
  },
  { name: "no nodes", edit: (t) => (t.nodes = []), path: "nodes", code: "too_few" },
  {
    name: "node count",
    edit: (t) => (t.nodes = repeat(B.maxNodes + 1, (i) => ({ ...t.nodes[1], id: `package-${i}` }))),
    path: "nodes",
    code: "too_many",
  },
  {
    name: "edge count",
    edit: (t) => (t.edges = repeat(B.maxEdges + 1, (i) => ({ ...t.edges[0], id: `e-${i}` }))),
    path: "edges",
    code: "too_many",
  },
  {
    name: "loop count",
    key: "build-pipeline-loop",
    edit: (t) => (t.loops = repeat(B.maxLoops + 1, (i) => ({ ...t.loops[0], id: `l-${i}` }))),
    path: "loops",
    code: "too_many",
  },
  {
    name: "loop iterations",
    key: "build-pipeline-loop",
    edit: (t) => (t.loops[0].maxIterations = B.maxLoopIterations + 1),
    path: "loops[0].maxIterations",
    code: "out_of_range",
  },
  {
    name: "loop without iterations",
    key: "build-pipeline-loop",
    edit: (t) => delete t.loops[0].maxIterations,
    path: "loops[0].maxIterations",
    code: "required",
  },
  {
    name: "loop iterations zero",
    key: "build-pipeline-loop",
    edit: (t) => (t.loops[0].maxIterations = 0),
    path: "loops[0].maxIterations",
    code: "out_of_range",
  },
  {
    name: "loop carry count",
    key: "build-pipeline-loop",
    edit: (t) => (t.loops[0].carry = repeat(B.maxLoopCarry + 1, () => t.loops[0].carry[0])),
    path: "loops[0].carry",
    code: "too_many",
  },
  {
    name: "ports per direction",
    edit: (t) =>
      (t.nodes[0].outputs = repeat(B.maxPortsPerDirection + 1, (i) => ({
        name: `out${i}`,
        type: "text@1",
      }))),
    path: "nodes[0].outputs",
    code: "too_many",
  },
  {
    name: "gate branch count",
    edit: (t) =>
      (node(t, "has-findings").branches = repeat(B.maxGateBranches + 1, (i) => ({
        to: `b${i}`,
        when: { path: "report.issues", op: "nonEmpty" },
      }))),
    path: "nodes[4].branches",
    code: "too_many",
  },
  {
    name: "capability override count",
    edit: (t) =>
      (t.nodes[0].capabilities.deny = repeat(B.maxCapabilityOverrides + 1, (i) => `mcp:s${i}`)),
    path: "nodes[0].capabilities.deny",
    code: "too_many",
  },
  {
    name: "system param count",
    edit: (t) =>
      (t.nodes[1].params = Object.fromEntries(
        repeat(B.maxSystemParams + 1, (i): [string, number] => [`p${i}`, i]),
      )),
    path: "nodes[1].params",
    code: "too_many",
  },
  {
    name: "system param list length",
    edit: (t) => (t.nodes[1].params = { labels: repeat(B.maxSystemParamListItems + 1, () => "x") }),
    path: "nodes[1].params.labels",
    code: "too_many",
  },
  {
    name: "system param string bytes",
    edit: (t) => (t.nodes[1].params = { title: longText(B.maxSystemParamStringBytes) }),
    path: "nodes[1].params.title",
    code: "too_large",
  },
  {
    name: "transforms per edge",
    edit: (t) =>
      (t.edges[0].transform = repeat(B.maxTransformsPerEdge + 1, () => ({
        op: "limit",
        count: 1,
      }))),
    path: "edges[0].transform",
    code: "too_many",
  },
  {
    name: "pick field count",
    edit: (t) =>
      (t.edges[0].transform = [
        { op: "pick", fields: repeat(B.maxPickFields + 1, (i) => `f${i}`) },
      ]),
    path: "edges[0].transform[0].fields",
    code: "too_many",
  },
  {
    name: "limit transform",
    edit: (t) => (t.edges[0].transform = [{ op: "limit", count: B.maxTransformLimit + 1 }]),
    path: "edges[0].transform[0].count",
    code: "out_of_range",
  },
  {
    name: "dedupe key paths",
    key: "failure-diagnosis",
    edit: (t) => (node(t, "dedupe").strategy.key = repeat(B.maxMergeKeyPaths + 1, (i) => `k${i}`)),
    path: "nodes[2].strategy.key",
    code: "too_many",
  },
  {
    name: "lens count",
    key: "design-bake-off",
    edit: (t) =>
      (t.nodes[0].replicate.lenses = repeat(B.maxBranches + 1, (i) => ({
        key: `l${i}`,
        label: "Lens",
        instruction: "Look.",
      }))),
    path: "nodes[0].replicate.lenses",
    code: "too_many",
  },
  {
    name: "lens label characters",
    key: "design-bake-off",
    edit: (t) => (t.nodes[0].replicate.lenses[0].label = "L".repeat(B.maxLensLabelChars + 1)),
    path: "nodes[0].replicate.lenses[0].label",
    code: "too_long",
  },
  {
    name: "lens instruction bytes",
    key: "design-bake-off",
    edit: (t) => (t.nodes[0].replicate.lenses[0].instruction = longText(B.maxLensInstructionBytes)),
    path: "nodes[0].replicate.lenses[0].instruction",
    code: "too_large",
  },
  {
    name: "items maxBranches",
    key: "failure-diagnosis",
    edit: (t) => (t.nodes[1].replicate.maxBranches = B.maxBranches + 1),
    path: "nodes[1].replicate.maxBranches",
    code: "out_of_range",
  },
  {
    name: "samples count",
    edit: (t) => (node(t, "review").replicate = { over: "samples", count: B.maxBranches + 1 }),
    path: "nodes[2].replicate.count",
    code: "out_of_range",
  },
  {
    name: "cross axis count",
    edit: (t) =>
      (node(t, "review").replicate = {
        over: "cross",
        axes: [
          { over: "panel", role: "reviewer" },
          { over: "samples", count: 2 },
          { over: "lenses", lenses: [{ key: "a", label: "A", instruction: "A" }] },
          { over: "items", input: "package", maxBranches: 2 },
        ],
      }),
    path: "nodes[2].replicate.axes",
    code: "too_many",
  },
  {
    name: "retry attempts",
    edit: (t) => (t.nodes[0].retry = { attempts: B.maxRetryAttempts + 1, on: ["timeout"] }),
    path: "nodes[0].retry.attempts",
    code: "out_of_range",
  },
  {
    name: "timeout floor",
    edit: (t) => (t.nodes[0].timeoutMs = B.minTimeoutMs - 1),
    path: "nodes[0].timeoutMs",
    code: "out_of_range",
  },
  {
    name: "timeout ceiling",
    edit: (t) => (t.nodes[0].timeoutMs = B.maxTimeoutMs + 1),
    path: "nodes[0].timeoutMs",
    code: "out_of_range",
  },
  {
    name: "prompt template bytes",
    key: "design-bake-off",
    edit: (t) => (t.nodes[0].prompt.template = longText(B.maxPromptTemplateBytes)),
    path: "nodes[0].prompt.template",
    code: "too_large",
  },
  {
    name: "human instructions bytes",
    key: "design-bake-off",
    edit: (t) => (t.nodes[2].form.instructions = longText(B.maxHumanInstructionsBytes)),
    path: "nodes[2].form.instructions",
    code: "too_large",
  },
  {
    name: "human choice count",
    key: "design-bake-off",
    edit: (t) =>
      (t.nodes[2].form = {
        kind: "choose",
        options: repeat(B.maxChooseOptions + 1, (i) => ({ to: `o${i}`, label: "Option" })),
      }),
    path: "nodes[2].form.options",
    code: "too_many",
  },
  {
    name: "subgraph param bindings",
    key: "design-bake-off",
    edit: (t) =>
      (node(t, "review").params = Object.fromEntries(
        repeat(B.maxSubgraphParamBindings + 1, (i): [string, boolean] => [`p${i}`, true]),
      )),
    path: "nodes[4].params",
    code: "too_many",
  },
  {
    name: "subgraph role bindings",
    key: "design-bake-off",
    edit: (t) =>
      (node(t, "review").roles = Object.fromEntries(
        repeat(B.maxSubgraphRoleBindings + 1, (i): [string, string] => [`r${i}`, "builder"]),
      )),
    path: "nodes[4].roles",
    code: "too_many",
  },
  {
    name: "maxAgentSessions",
    edit: (t) => (t.limits.maxAgentSessions = B.maxAgentSessions + 1),
    path: "limits.maxAgentSessions",
    code: "out_of_range",
  },
  {
    name: "maxConcurrentAgents ceiling",
    edit: (t) => (t.limits.maxConcurrentAgents = B.maxConcurrentAgents + 1),
    path: "limits.maxConcurrentAgents",
    code: "out_of_range",
  },
  {
    name: "maxConcurrentAgents floor",
    edit: (t) => (t.limits.maxConcurrentAgents = 0),
    path: "limits.maxConcurrentAgents",
    code: "out_of_range",
  },
  {
    name: "maxTokens",
    edit: (t) => (t.limits.maxTokens = B.maxTokens + 1),
    path: "limits.maxTokens",
    code: "out_of_range",
  },
  {
    name: "maxWallClockMs",
    edit: (t) => (t.limits.maxWallClockMs = B.maxWallClockMs + 1),
    path: "limits.maxWallClockMs",
    code: "out_of_range",
  },
  {
    name: "layout coordinate",
    edit: (t) => (t.layout = { plan: { x: B.maxLayoutCoordinateAbs + 1, y: 0 } }),
    path: "layout.plan.x",
    code: "out_of_range",
  },
  {
    name: "layout entry count",
    edit: (t) =>
      (t.layout = Object.fromEntries(
        repeat(B.maxNodes + 1, (i): [string, { x: number; y: number }] => [
          `n-${i}`,
          { x: 0, y: 0 },
        ]),
      )),
    path: "layout",
    code: "too_many",
  },
  {
    name: "acknowledgement count",
    edit: (t) =>
      (t.acknowledgements = repeat(B.maxAcknowledgements + 1, (i) => ({
        kind: "taint",
        digest: i.toString(16).padStart(64, "0"),
        acknowledgedAt: "2026-10-29T00:00:00Z",
      }))),
    path: "acknowledgements",
    code: "too_many",
  },
  {
    name: "acknowledgement note bytes",
    edit: (t) =>
      (t.acknowledgements = [
        {
          kind: "taint",
          digest: DIGEST,
          acknowledgedAt: "2026-10-29T00:00:00Z",
          note: longText(B.maxAcknowledgementNoteBytes),
        },
      ]),
    path: "acknowledgements[0].note",
    code: "too_large",
  },
  {
    name: "field path length",
    edit: (t) => (node(t, "fix").when = { path: `a${"b".repeat(B.maxPathChars)}`, op: "exists" }),
    path: "nodes[5].when.path",
    code: "too_long",
  },
  {
    name: "field path segments",
    edit: (t) =>
      (node(t, "fix").when = {
        path: repeat(B.maxPathSegments + 1, () => "a").join("."),
        op: "exists",
      }),
    path: "nodes[5].when.path",
    code: "too_many",
  },
  {
    name: "type ref length",
    edit: (t) => (t.nodes[0].inputs[0].type = `list<list<${"a".repeat(B.maxTypeRefChars)}@1>>`),
    path: "nodes[0].inputs[0].type",
    code: "too_long",
  },
  {
    name: "type schema bytes",
    key: "design-bake-off",
    edit: (t) => (t.types[0].schema.description = longText(B.maxTypeSchemaBytes)),
    path: "types[0].schema",
    code: "too_large",
  },
  {
    name: "type schema depth",
    key: "design-bake-off",
    edit: (t) => {
      let deep: Draft = { type: "string" };
      for (let i = 0; i < B.maxTypeSchemaDepth; i++) deep = { type: "array", items: deep };
      t.types[0].schema = deep;
    },
    path: "types[0].schema",
    code: "too_deep",
  },
  {
    name: "type example bytes",
    key: "design-bake-off",
    edit: (t) => (t.types[0].example = { summary: longText(B.maxTypeExampleBytes) }),
    path: "types[0].example",
    code: "too_large",
  },
  {
    name: "type markdown bytes",
    key: "design-bake-off",
    edit: (t) => (t.types[0].render.markdown = longText(B.maxTypeMarkdownBytes)),
    path: "types[0].render.markdown",
    code: "too_large",
  },
  {
    name: "type summary fields",
    key: "design-bake-off",
    edit: (t) => (t.types[0].render.summary = repeat(B.maxTypeSummaryFields + 1, (i) => `f${i}`)),
    path: "types[0].render.summary",
    code: "too_many",
  },
  {
    name: "type shared fields",
    key: "design-bake-off",
    edit: (t) => (t.types[0].sharedFields = repeat(B.maxTypeSharedFields + 1, (i) => `f${i}`)),
    path: "types[0].sharedFields",
    code: "too_many",
  },
  {
    name: "value type budget",
    key: "design-bake-off",
    edit: (t) => (t.types[0].budgets.maxBytes = B.maxValueArtifactBytes + 1),
    path: "types[0].budgets.maxBytes",
    code: "out_of_range",
  },
  {
    name: "reference type budget",
    key: "design-bake-off",
    edit: (t) => {
      t.types[0].storage = "reference";
      t.types[0].budgets.maxBytes = B.maxReferenceArtifactBytes + 1;
    },
    path: "types[0].budgets.maxBytes",
    code: "out_of_range",
  },
  {
    name: "string budget above the payload budget",
    key: "design-bake-off",
    edit: (t) => (t.types[0].budgets.maxStringBytes = t.types[0].budgets.maxBytes + 1),
    path: "types[0].budgets.maxStringBytes",
    code: "out_of_range",
  },
  {
    name: "item budget",
    key: "design-bake-off",
    edit: (t) => (t.types[0].budgets.maxItems = B.maxArtifactItems + 1),
    path: "types[0].budgets.maxItems",
    code: "out_of_range",
  },
  {
    name: "item id prefix length",
    key: "failure-diagnosis",
    edit: (t) => (t.types[1].items.idPrefix = `f${"a".repeat(B.maxItemIdPrefixChars)}`),
    path: "types[1].items.idPrefix",
    code: "too_long",
  },
  {
    name: "type version",
    key: "design-bake-off",
    edit: (t) => (t.types[0].version = B.maxTypeVersion + 1),
    path: "types[0].version",
    code: "out_of_range",
  },
];

describe("bounds", () => {
  test.each(BOUND_CASES.map((entry) => [entry.name, entry]))("%s", (_name, entry) =>
    expectCase(entry as Case),
  );

  test("a reference type may use the larger budget", () => {
    const template = draft("design-bake-off");
    template.types[0].storage = "reference";
    template.types[0].budgets.maxBytes = B.maxReferenceArtifactBytes;
    expect(errorsOf(template)).toEqual([]);
  });

  test("text exactly at a byte bound is accepted", () => {
    const template = draft();
    template.name = "é".repeat(B.maxNameBytes / 2);
    template.nodes[0].label = "x".repeat(B.maxLabelBytes);
    expect(errorsOf(template)).toEqual([]);
  });
});

const SHAPE_CASES: Case[] = [
  // nodes
  {
    name: "unknown node kind",
    edit: (t) => (t.nodes[0].kind = "transform"),
    path: "nodes[0].kind",
    code: "enum",
  },
  {
    name: "node without kind",
    edit: (t) => delete t.nodes[0].kind,
    path: "nodes[0].kind",
    code: "required",
  },
  {
    name: "duplicate node id",
    edit: (t) => (t.nodes[1].id = "plan"),
    path: "nodes[1].id",
    code: "duplicate",
  },
  ...(["role", "prompt", "capabilities", "workspaceAccess"] as const).map((field): Case => ({
    name: `agent without ${field}`,
    edit: (t) => delete t.nodes[0][field],
    path: `nodes[0].${field}`,
    code: "required",
  })),
  {
    name: "agent with a gate field",
    edit: (t) => (t.nodes[0].branches = []),
    path: "nodes[0].branches",
    code: "unknown_field",
  },
  {
    name: "gate with declared outputs",
    edit: (t) => (node(t, "has-findings").outputs = [{ name: "x", type: "text@1" }]),
    path: "nodes[4].outputs",
    code: "unknown_field",
  },
  {
    name: "gate with retry",
    edit: (t) => (node(t, "has-findings").retry = { attempts: 2, on: ["timeout"] }),
    path: "nodes[4].retry",
    code: "unknown_field",
  },
  {
    name: "gate without inputs",
    edit: (t) => delete node(t, "has-findings").inputs,
    path: "nodes[4].inputs",
    code: "required",
  },
  {
    name: "gate without branches",
    edit: (t) => (node(t, "has-findings").branches = []),
    path: "nodes[4].branches",
    code: "too_few",
  },
  {
    name: "gate otherwise repeats a branch outlet",
    edit: (t) => (node(t, "has-findings").otherwise = "findings"),
    path: "nodes[4].otherwise",
    code: "duplicate",
  },
  {
    name: "gate branch without a predicate",
    edit: (t) => delete node(t, "has-findings").branches[0].when,
    path: "nodes[4].branches[0].when",
    code: "required",
  },
  {
    name: "merge with retry",
    key: "failure-diagnosis",
    edit: (t) => (node(t, "dedupe").retry = { attempts: 2, on: ["timeout"] }),
    path: "nodes[2].retry",
    code: "unknown_field",
  },
  {
    name: "human with outputs",
    key: "design-bake-off",
    edit: (t) => (node(t, "approve").outputs = []),
    path: "nodes[2].outputs",
    code: "unknown_field",
  },
  // capabilities
  {
    name: "capabilities as a bare profile name",
    edit: (t) => (t.nodes[0].capabilities = "builder"),
    path: "nodes[0].capabilities",
    code: "type",
  },
  {
    name: "shipper profile",
    edit: (t) => (t.nodes[0].capabilities = { profile: "shipper" }),
    path: "nodes[0].capabilities.profile",
    code: "enum",
  },
  {
    name: "unknown capability",
    edit: (t) => (t.nodes[0].capabilities.deny = ["shell.everything"]),
    path: "nodes[0].capabilities.deny[0]",
    code: "capability",
  },
  {
    name: "unknown orkestrator group",
    edit: (t) => (t.nodes[0].capabilities.allow = ["orkestrator:billing"]),
    path: "nodes[0].capabilities.allow[0]",
    code: "capability",
  },
  {
    name: "empty mcp server",
    edit: (t) => (t.nodes[0].capabilities.deny = ["mcp:"]),
    path: "nodes[0].capabilities.deny[0]",
    code: "capability",
  },
  {
    name: "capability allowed and denied",
    edit: (t) =>
      (t.nodes[0].capabilities = { profile: "custom", allow: ["shell"], deny: ["shell"] }),
    path: "nodes[0].capabilities.deny[0]",
    code: "conflict",
  },
  {
    name: "duplicate capability",
    edit: (t) => (t.nodes[0].capabilities.deny = ["network", "network"]),
    path: "nodes[0].capabilities.deny[1]",
    code: "duplicate",
  },
  {
    name: "unknown enforcement tier",
    edit: (t) => (t.nodes[0].minEnforcement = "strict"),
    path: "nodes[0].minEnforcement",
    code: "enum",
  },
  {
    name: "unknown workspace access",
    edit: (t) => (t.nodes[0].workspaceAccess = "admin"),
    path: "nodes[0].workspaceAccess",
    code: "enum",
  },
  {
    name: "askHuman as a string",
    edit: (t) => (t.nodes[0].askHuman = "yes"),
    path: "nodes[0].askHuman",
    code: "type",
  },
  // prompts and sessions
  {
    name: "prompt with both forms",
    edit: (t) => (t.nodes[0].prompt = { builtIn: "build", template: "x" }),
    path: "nodes[0].prompt.template",
    code: "unknown_field",
  },
  {
    name: "empty prompt template",
    edit: (t) => (t.nodes[0].prompt = { template: "" }),
    path: "nodes[0].prompt.template",
    code: "empty",
  },
  {
    name: "built-in prompt id grammar",
    edit: (t) => (t.nodes[0].prompt = { builtIn: "../etc/passwd" }),
    path: "nodes[0].prompt.builtIn",
    code: "pattern",
  },
  {
    name: "continue session without a source",
    edit: (t) => (node(t, "fix").session = { mode: "continue" }),
    path: "nodes[5].session.from",
    code: "required",
  },
  {
    name: "unknown session mode",
    edit: (t) => (node(t, "fix").session = { mode: "resume" }),
    path: "nodes[5].session.mode",
    code: "enum",
  },
  {
    name: "fresh session with a source",
    edit: (t) => (node(t, "fix").session = { mode: "fresh", from: "plan" }),
    path: "nodes[5].session.from",
    code: "unknown_field",
  },
  // retry and failure
  {
    name: "retry without causes",
    edit: (t) => (t.nodes[0].retry = { attempts: 2, on: [] }),
    path: "nodes[0].retry.on",
    code: "too_few",
  },
  {
    name: "unknown retry cause",
    edit: (t) => (t.nodes[0].retry = { attempts: 2, on: ["guard-violation"] }),
    path: "nodes[0].retry.on[0]",
    code: "enum",
  },
  {
    name: "duplicate retry cause",
    edit: (t) => (t.nodes[0].retry = { attempts: 2, on: ["timeout", "timeout"] }),
    path: "nodes[0].retry.on[1]",
    code: "duplicate",
  },
  {
    name: "unknown failure policy",
    edit: (t) => (t.nodes[0].onFailure = "ignore"),
    path: "nodes[0].onFailure",
    code: "enum",
  },
  // replication
  {
    name: "unknown replicate source",
    edit: (t) => (node(t, "review").replicate = { over: "models" }),
    path: "nodes[2].replicate.over",
    code: "enum",
  },
  {
    name: "panel replicate without a role",
    edit: (t) => (node(t, "review").replicate = { over: "panel" }),
    path: "nodes[2].replicate.role",
    code: "required",
  },
  {
    name: "cross with one axis",
    edit: (t) =>
      (node(t, "review").replicate = { over: "cross", axes: [{ over: "samples", count: 2 }] }),
    path: "nodes[2].replicate.axes",
    code: "too_few",
  },
  {
    name: "nested cross",
    edit: (t) =>
      (node(t, "review").replicate = {
        over: "cross",
        axes: [
          { over: "samples", count: 2 },
          { over: "cross", axes: [] },
        ],
      }),
    path: "nodes[2].replicate.axes[1].over",
    code: "nested_cross",
  },
  {
    name: "cross repeats a source",
    edit: (t) =>
      (node(t, "review").replicate = {
        over: "cross",
        axes: [
          { over: "samples", count: 2 },
          { over: "samples", count: 3 },
        ],
      }),
    path: "nodes[2].replicate.axes[1].over",
    code: "duplicate",
  },
  {
    name: "items over an undeclared input",
    key: "failure-diagnosis",
    edit: (t) => (t.nodes[1].replicate.input = "findings"),
    path: "nodes[1].replicate.input",
    code: "unknown_port",
  },
  {
    name: "duplicate lens key",
    key: "design-bake-off",
    edit: (t) => (t.nodes[0].replicate.lenses[1].key = "simplicity"),
    path: "nodes[0].replicate.lenses[1].key",
    code: "duplicate",
  },
  {
    name: "lens without instruction",
    key: "design-bake-off",
    edit: (t) => delete t.nodes[0].replicate.lenses[0].instruction,
    path: "nodes[0].replicate.lenses[0].instruction",
    code: "required",
  },
  // ports
  {
    name: "duplicate input port",
    edit: (t) => t.nodes[1].inputs.push({ name: "plan", type: "text@1" }),
    path: "nodes[1].inputs[2].name",
    code: "duplicate",
  },
  {
    name: "provenance on an input",
    edit: (t) => (t.nodes[0].inputs[0].provenance = "cite"),
    path: "nodes[0].inputs[0].provenance",
    code: "unknown_field",
  },
  {
    name: "render on an output",
    edit: (t) => (t.nodes[0].outputs[0].render = "markdown"),
    path: "nodes[0].outputs[0].render",
    code: "unknown_field",
  },
  {
    name: "unknown render mode",
    edit: (t) => (node(t, "review").inputs[0].render = "html"),
    path: "nodes[2].inputs[0].render",
    code: "enum",
  },
  {
    name: "collect on a single input",
    edit: (t) =>
      (t.nodes[0].inputs[0].collect = {
        wait: "all-settled",
        minSuccessful: 1,
        includeFailures: false,
      }),
    path: "nodes[0].inputs[0].collect",
    code: "collect_requires_list",
  },
  {
    name: "quorum without count",
    edit: (t) => (node(t, "consolidate").inputs[0].collect.wait = "quorum"),
    path: "nodes[3].inputs[0].collect.count",
    code: "required",
  },
  {
    name: "count with all-settled",
    edit: (t) => (node(t, "consolidate").inputs[0].collect.count = 2),
    path: "nodes[3].inputs[0].collect.count",
    code: "not_applicable",
  },
  {
    name: "minSuccessful above count",
    edit: (t) =>
      (node(t, "consolidate").inputs[0].collect = {
        wait: "quorum",
        count: 2,
        minSuccessful: 3,
        includeFailures: true,
      }),
    path: "nodes[3].inputs[0].collect.minSuccessful",
    code: "out_of_range",
  },
  {
    name: "collect without includeFailures",
    edit: (t) => delete node(t, "consolidate").inputs[0].collect.includeFailures,
    path: "nodes[3].inputs[0].collect.includeFailures",
    code: "required",
  },
  {
    name: "firstIterationFrom without a port",
    key: "build-pipeline-loop",
    edit: (t) => (node(t, "prepare").inputs[0].firstIterationFrom = { node: "build" }),
    path: "nodes[2].inputs[0].firstIterationFrom.port",
    code: "required",
  },
  // edges
  {
    name: "duplicate edge id",
    edit: (t) => (t.edges[1].id = t.edges[0].id),
    path: "edges[1].id",
    code: "duplicate",
  },
  {
    name: "edge source mixing a run input and a node",
    edit: (t) => (t.edges[0].from = { input: "target", node: "plan" }),
    path: "edges[0].from.node",
    code: "unknown_field",
  },
  {
    name: "edge target with an outlet",
    edit: (t) => (t.edges[0].to.outlet = "findings"),
    path: "edges[0].to.outlet",
    code: "unknown_field",
  },
  {
    name: "edge target as a run input",
    edit: (t) => (t.edges[0].to = { input: "target" }),
    path: "edges[0].to.input",
    code: "unknown_field",
  },
  {
    name: "unknown transform",
    edit: (t) => (t.edges[0].transform = [{ op: "map", expression: "x => x" }]),
    path: "edges[0].transform[0].op",
    code: "enum",
  },
  {
    name: "filter with a malformed predicate",
    edit: (t) =>
      (t.edges[0].transform = [{ op: "filter", where: { path: "severity", op: "like" } }]),
    path: "edges[0].transform[0].where.op",
    code: "enum",
  },
  {
    name: "adapter name grammar",
    edit: (t) => (t.edges[0].transform = [{ op: "adapt", adapter: "Report To Findings" }]),
    path: "edges[0].transform[0].adapter",
    code: "pattern",
  },
  {
    name: "zip as a string",
    edit: (t) => (t.edges[0].zip = "yes"),
    path: "edges[0].zip",
    code: "type",
  },
  // loops
  {
    name: "duplicate loop member",
    key: "build-pipeline-loop",
    edit: (t) => t.loops[0].nodes.push("fix"),
    path: "loops[0].nodes[7]",
    code: "duplicate",
  },
  {
    name: "loop without until",
    key: "build-pipeline-loop",
    edit: (t) => delete t.loops[0].until,
    path: "loops[0].until",
    code: "required",
  },
  {
    name: "carry from a run input",
    key: "build-pipeline-loop",
    edit: (t) => (t.loops[0].carry[0].from = { input: "ticket" }),
    path: "loops[0].carry[0].from.input",
    code: "unknown_field",
  },
  // roles
  {
    name: "maxPanel on a single role",
    edit: (t) => (t.roles[0].maxPanel = 2),
    path: "roles[0].maxPanel",
    code: "not_applicable",
  },
  {
    name: "additionalReviewers on a single role",
    edit: (t) => (t.roles[0].defaultsFrom = ["reviewPreparation", "additionalReviewers"]),
    path: "roles[0].defaultsFrom[1]",
    code: "panel_only",
  },
  {
    name: "additionalReviewers before an action key",
    edit: (t) => (t.roles[1].defaultsFrom = ["review", "additionalReviewers", "review2"]),
    path: "roles[1].defaultsFrom[1]",
    code: "must_be_last",
  },
  {
    name: "duplicate default source",
    edit: (t) => (t.roles[1].defaultsFrom = ["review", "review"]),
    path: "roles[1].defaultsFrom[1]",
    code: "duplicate",
  },
  {
    name: "action key outside the graph subset",
    edit: (t) => (t.roles[0].defaultsFrom = ["push"]),
    path: "roles[0].defaultsFrom[0]",
    code: "enum",
  },
  {
    name: "duplicate role key",
    edit: (t) => (t.roles[1].key = "preparer"),
    path: "roles[1].key",
    code: "duplicate",
  },
  {
    name: "unknown multiplicity",
    edit: (t) => (t.roles[0].multiplicity = "many"),
    path: "roles[0].multiplicity",
    code: "enum",
  },
  // parameters
  {
    name: "unknown parameter type",
    edit: (t) => (t.parameters[0].type = "date"),
    path: "parameters[0].type",
    code: "enum",
  },
  {
    name: "duplicate parameter key",
    edit: (t) => (t.parameters[1].key = "autoFix"),
    path: "parameters[1].key",
    code: "duplicate",
  },
  {
    name: "boolean default as a string",
    edit: (t) => (t.parameters[0].default = "true"),
    path: "parameters[0].default",
    code: "type",
  },
  {
    name: "fractional integer default",
    edit: (t) => (t.parameters = [{ key: "maxRounds", type: "integer", default: 2.5 }]),
    path: "parameters[0].default",
    code: "not_integer",
  },
  {
    name: "min above max",
    edit: (t) => (t.parameters = [{ key: "maxRounds", type: "integer", min: 5, max: 1 }]),
    path: "parameters[0].max",
    code: "out_of_range",
  },
  {
    name: "default outside min and max",
    edit: (t) =>
      (t.parameters = [{ key: "maxRounds", type: "integer", min: 1, max: 10, default: 11 }]),
    path: "parameters[0].default",
    code: "out_of_range",
  },
  {
    name: "enum default not an option",
    edit: (t) =>
      (t.parameters = [{ key: "severity", type: "enum", options: ["P0", "P1"], default: "P2" }]),
    path: "parameters[0].default",
    code: "enum",
  },
  {
    name: "duplicate enum option",
    edit: (t) => (t.parameters = [{ key: "severity", type: "enum", options: ["P0", "P0"] }]),
    path: "parameters[0].options[1]",
    code: "duplicate",
  },
  {
    name: "field of another parameter type",
    edit: (t) => (t.parameters[0].options = ["a"]),
    path: "parameters[0].options",
    code: "unknown_field",
  },
  // workspace and limits
  {
    name: "unknown workspace kind",
    edit: (t) => (t.workspace = { kind: "cluster" }),
    path: "workspace.kind",
    code: "enum",
  },
  {
    name: "no-workspace with create",
    edit: (t) => (t.workspace = { kind: "none", create: { kind: "worktree" } }),
    path: "workspace.create",
    code: "unknown_field",
  },
  {
    name: "unknown environment kind",
    edit: (t) => (t.workspace = { kind: "environment", create: { kind: "vm" } }),
    path: "workspace.create.kind",
    code: "enum",
  },
  {
    name: "limits without maxAgentSessions",
    edit: (t) => delete t.limits.maxAgentSessions,
    path: "limits.maxAgentSessions",
    code: "required",
  },
  // system, merge, human, subgraph
  {
    name: "unknown system action",
    edit: (t) => (t.nodes[1].action = "deploy"),
    path: "nodes[1].action",
    code: "enum",
  },
  {
    name: "system param key grammar",
    edit: (t) => (t.nodes[1].params = { "base branch": "main" }),
    path: "nodes[1].params.base branch",
    code: "pattern",
  },
  {
    name: "system param object value",
    edit: (t) => (t.nodes[1].params = { target: { branch: "main" } }),
    path: "nodes[1].params.target",
    code: "type",
  },
  {
    name: "vote without a tie policy",
    key: "failure-diagnosis",
    edit: (t) => (node(t, "dedupe").strategy = { kind: "vote" }),
    path: "nodes[2].strategy.tie",
    code: "required",
  },
  {
    name: "dedupe without a key",
    key: "failure-diagnosis",
    edit: (t) => (node(t, "dedupe").strategy = { kind: "dedupe" }),
    path: "nodes[2].strategy.key",
    code: "required",
  },
  {
    name: "best with an unknown preference",
    key: "failure-diagnosis",
    edit: (t) => (node(t, "dedupe").strategy = { kind: "best", score: "score", prefer: "max" }),
    path: "nodes[2].strategy.prefer",
    code: "enum",
  },
  {
    name: "unknown merge strategy",
    key: "failure-diagnosis",
    edit: (t) => (node(t, "dedupe").strategy = { kind: "union" }),
    path: "nodes[2].strategy.kind",
    code: "enum",
  },
  {
    name: "edit form names an undeclared input",
    key: "design-bake-off",
    edit: (t) => (node(t, "approve").form.edit = "plan"),
    path: "nodes[2].form.edit",
    code: "unknown_port",
  },
  {
    name: "choose with one option",
    key: "design-bake-off",
    edit: (t) =>
      (node(t, "approve").form = { kind: "choose", options: [{ to: "only", label: "Only" }] }),
    path: "nodes[2].form.options",
    code: "too_few",
  },
  {
    name: "approve with options",
    key: "design-bake-off",
    edit: (t) => (node(t, "approve").form = { kind: "approve", options: [] }),
    path: "nodes[2].form.options",
    code: "unknown_field",
  },
  {
    name: "unknown human form",
    key: "design-bake-off",
    edit: (t) => (node(t, "approve").form = { kind: "sign" }),
    path: "nodes[2].form.kind",
    code: "enum",
  },
  {
    name: "unknown subgraph scope",
    key: "design-bake-off",
    edit: (t) => (node(t, "review").template.scope = "remote"),
    path: "nodes[4].template.scope",
    code: "enum",
  },
  {
    name: "subgraph param pass-through grammar",
    key: "design-bake-off",
    edit: (t) => (node(t, "review").params = { autoFix: { param: "Auto Fix" } }),
    path: "nodes[4].params.autoFix.param",
    code: "pattern",
  },
  {
    name: "subgraph role binding grammar",
    key: "design-bake-off",
    edit: (t) => (node(t, "review").roles = { reviewer: "Reviewer" }),
    path: "nodes[4].roles.reviewer",
    code: "pattern",
  },
  // types
  {
    name: "duplicate custom type",
    key: "design-bake-off",
    edit: (t) => t.types.push({ ...t.types[0] }),
    path: "types[1].name",
    code: "duplicate",
  },
  {
    name: "type schema not an object",
    key: "design-bake-off",
    edit: (t) => (t.types[0].schema = ["string"]),
    path: "types[0].schema",
    code: "type",
  },
  {
    name: "unknown storage class",
    key: "design-bake-off",
    edit: (t) => (t.types[0].storage = "blob"),
    path: "types[0].storage",
    code: "enum",
  },
  {
    name: "type validator is built-in only",
    key: "design-bake-off",
    edit: (t) => (t.types[0].validator = "ticket-sections"),
    path: "types[0].validator",
    code: "unknown_field",
  },
  {
    name: "non-finite example value",
    key: "design-bake-off",
    edit: (t) => (t.types[0].example = { score: Number.NaN }),
    path: "types[0].example.score",
    code: "not_finite",
  },
  // acknowledgements and layout
  {
    name: "unknown acknowledgement kind",
    edit: (t) =>
      (t.acknowledgements = [
        { kind: "cost", digest: DIGEST, acknowledgedAt: "2026-10-29T00:00:00Z" },
      ]),
    path: "acknowledgements[0].kind",
    code: "enum",
  },
  {
    name: "duplicate acknowledgement",
    edit: (t) =>
      (t.acknowledgements = repeat(2, () => ({
        kind: "taint",
        digest: DIGEST,
        acknowledgedAt: "2026-10-29T00:00:00Z",
      }))),
    path: "acknowledgements[1].digest",
    code: "duplicate",
  },
  {
    name: "layout point without y",
    edit: (t) => (t.layout = { plan: { x: 0 } }),
    path: "layout.plan.y",
    code: "required",
  },
  {
    name: "layout key grammar",
    edit: (t) => (t.layout = { "Plan Node": { x: 0, y: 0 } }),
    path: "layout.Plan Node",
    code: "pattern",
  },
  {
    name: "run output from a run input",
    edit: (t) => (t.outputs[0].from = { input: "target" }),
    path: "outputs[0].from.input",
    code: "unknown_field",
  },
  {
    name: "duplicate run input",
    edit: (t) => t.inputs.push({ name: "target", type: "workspace@1" }),
    path: "inputs[1].name",
    code: "duplicate",
  },
];

describe("malformed shapes", () => {
  test.each(SHAPE_CASES.map((entry) => [entry.name, entry]))("%s", (_name, entry) =>
    expectCase(entry as Case),
  );
});

describe("accepted variations", () => {
  test("subgraph nodes are part of the schema", () => {
    const template = draft("design-bake-off");
    expect(node(template, "review").kind).toBe("subgraph");
    node(template, "review").template.revision = 4;
    node(template, "review").replicate = { over: "samples", count: 2 };
    expect(errorsOf(template)).toEqual([]);
  });

  test("capability overrides accept the extended vocabulary", () => {
    const template = draft();
    template.nodes[0].capabilities = {
      profile: "custom",
      allow: ["web.search", "orkestrator:tickets.read", "subagents"],
      deny: ["network", "git.push", "github.write", "mcp:github", "git.commit"],
    };
    expect(errorsOf(template)).toEqual([]);
  });

  test("panel and lenses combine with cross", () => {
    const template = draft();
    node(template, "review").replicate = {
      over: "cross",
      axes: [
        { over: "panel", role: "reviewer" },
        {
          over: "lenses",
          lenses: [
            {
              key: "security",
              label: "Security",
              instruction: "Look for injection.",
              role: "reviewer",
            },
            { key: "api", label: "API and compatibility", instruction: "Check callers." },
          ],
        },
      ],
    };
    expect(errorsOf(template)).toEqual([]);
  });

  test("every parameter type, merge strategy, human form and transform", () => {
    const template = draft("failure-diagnosis");
    template.parameters = [
      { key: "autoPr", type: "boolean" },
      { key: "maxRounds", type: "integer", min: 1, max: 10, default: 3, label: "Rounds" },
      { key: "threshold", type: "number", min: 0, max: 1, default: 0.5 },
      { key: "brief", type: "string", maxBytes: 64, default: "" },
      { key: "severity", type: "enum", options: ["P0", "P1", "P2"], default: "P1" },
    ];
    for (const strategy of [
      { kind: "concat" },
      { kind: "collect" },
      { kind: "vote", tie: "first", path: "choice" },
      { kind: "best", score: "score", prefer: "lowest" },
    ]) {
      node(template, "dedupe").strategy = strategy;
      expect(errorsOf(template)).toEqual([]);
    }
    template.edges[2].transform = [
      { op: "flatten", path: "failures" },
      { op: "filter", where: { path: "command", op: "in", value: ["bun test", "lint"] } },
      { op: "pick", fields: ["command", "summary"] },
      { op: "limit", count: 12 },
      { op: "adapt", adapter: "validation-results-to-failures" },
    ];
    template.edges[2].zip = false;
    template.nodes.push(
      {
        id: "confirm",
        kind: "human",
        inputs: [{ name: "results", type: "validation-results@1" }],
        form: { kind: "approve" },
        timeoutMs: 3_600_000,
        onFailure: "route",
      },
      {
        id: "route",
        kind: "human",
        inputs: [{ name: "results", type: "validation-results@1" }],
        form: {
          kind: "choose",
          options: [
            { to: "retry", label: "Retry" },
            { to: "stop", label: "Stop", description: "End the run here." },
          ],
        },
      },
      {
        id: "notify",
        kind: "system",
        action: "notify",
        params: { to: "coordinator", tags: ["graphs", 1, true, null] },
        retry: { attempts: 3, on: ["provider-error", "timeout"] },
        timeoutMs: 60_000,
        onFailure: "skip",
      },
    );
    template.acknowledgements = [
      {
        kind: "enforcement-floor",
        digest: DIGEST,
        acknowledgedAt: "2026-10-29T10:11:12.345Z",
        code: "min-enforcement-lowered",
        note: "Grok is fine for this read-only diagnosis.",
      },
    ];
    template.workspace = { kind: "none" };
    template.engine = "looped-review";
    expect(errorsOf(template)).toEqual([]);
  });

  test("session continue and askHuman", () => {
    const template = draft();
    Object.assign(node(template, "fix"), {
      session: { mode: "continue", from: "plan" },
      askHuman: true,
    });
    expect(errorsOf(template)).toEqual([]);
  });
});
