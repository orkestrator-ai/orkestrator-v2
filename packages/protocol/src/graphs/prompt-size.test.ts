import { describe, expect, test } from "bun:test";
import type { NativeAgentExecutionPolicy } from "../native-agent.js";
import type { ArtifactTypeBudgets, ArtifactTypeDef, GraphJsonSchema } from "./artifact-type-def.js";
import { compileGraphCapabilities } from "./capability-profiles.js";
import { graphTemplateExamples } from "./examples.js";
import { graphUtf8Bytes } from "./grammar.js";
import { renderGraphNodePrompt } from "./prompt-node.js";
import { renderGraphPromptInput } from "./prompt-render.js";
import {
  type GraphPromptValues,
  GRAPH_PROMPT_FILE_PATH_MAX_BYTES,
  graphPromptScope,
} from "./prompt-scope.js";
import {
  GRAPH_PROMPT_CAPABILITY_MAX_CHARS,
  estimateGraphNodePromptSize,
  estimateGraphPromptInput,
  estimateGraphPromptUserSize,
} from "./prompt-size.js";
import { validateGraphSchemaValue } from "./schema-subset.js";
import type { GraphAgentNode, GraphRenderMode } from "./template-model.js";
import { graphBudgetIssues, graphBuiltInType } from "./types.js";

const host: NativeAgentExecutionPolicy = {
  id: "pipeline",
  sandbox: "none",
  approvals: "auto-approve",
  projectResources: false,
  networkAccess: "full",
};

// ------------------------------------------------------------ generators

type Rng = () => number;

function rng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const PLAIN = ["a", "b", " ", "\n", "é", '"', "\\", "\u0001", "z", "{", "}"];
const HOSTILE = ["<", ">", "<", "&", "a"];

interface Shape {
  maxString: number;
  maxItems: number;
  hostile: boolean;
}

function generate(schema: GraphJsonSchema | undefined, random: Rng, shape: Shape): unknown {
  if (!schema) return null;
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf as GraphJsonSchema[];
    return generate(branches[Math.floor(random() * branches.length)], random, shape);
  }
  if (Array.isArray(schema.enum)) return schema.enum[Math.floor(random() * schema.enum.length)];
  if ("const" in schema) return schema.const;
  switch (schema.type) {
    case "object": {
      const properties = (schema.properties ?? {}) as Record<string, GraphJsonSchema>;
      return Object.fromEntries(
        Object.entries(properties).map(([key, child]) => [key, generate(child, random, shape)]),
      );
    }
    case "array": {
      const length = Math.floor(random() * (shape.maxItems + 1));
      return Array.from({ length }, () => generate(schema.items as GraphJsonSchema, random, shape));
    }
    case "string": {
      const alphabet = shape.hostile ? HOSTILE : PLAIN;
      const length = Math.floor(random() * (shape.maxString + 1));
      let text = "";
      for (let index = 0; index < length; index++) {
        text += alphabet[Math.floor(random() * alphabet.length)];
      }
      return text;
    }
    case "integer": {
      const min = typeof schema.minimum === "number" ? schema.minimum : -1000;
      const max = typeof schema.maximum === "number" ? schema.maximum : 1_000_000;
      return Math.floor(min + random() * (max - min + 1));
    }
    case "number":
      return (random() - 0.5) * 1e6;
    case "boolean":
      return random() < 0.5;
    default:
      return null;
  }
}

function stringLeaves(value: unknown, path: (string | number)[] = []): (string | number)[][] {
  if (typeof value === "string") return [path];
  if (Array.isArray(value))
    return value.flatMap((entry, index) => stringLeaves(entry, [...path, index]));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => stringLeaves(entry, [...path, key]));
  }
  return [];
}

function mapStrings(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, map));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, mapStrings(entry, map)]),
    );
  }
  return value;
}

/** A value within budgets and schema, padded towards the byte budget. */
function sample(
  schema: GraphJsonSchema,
  budgets: ArtifactTypeBudgets,
  random: Rng,
  hostile: boolean,
): unknown {
  let shape: Shape = {
    maxString: Math.min(budgets.maxStringBytes ?? 64, 64),
    maxItems: Math.min(budgets.maxItems ?? 6, 6),
    hostile,
  };
  for (let attempt = 0; attempt < 20; attempt++) {
    const value = generate(schema, random, shape);
    if (validateGraphSchemaValue(schema, value).length > 0) continue;
    if (graphBudgetIssues(budgets, value).length > 0) {
      shape = {
        ...shape,
        maxString: Math.floor(shape.maxString / 2),
        maxItems: Math.floor(shape.maxItems / 2),
      };
      continue;
    }
    // Pad one string so the value sits at its byte budget.
    const leaves = stringLeaves(value);
    if (leaves.length > 0) {
      const path = leaves[Math.floor(random() * leaves.length)]!;
      let parent = value as Record<string | number, unknown>;
      for (const key of path.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>;
      const last = path.at(-1)!;
      const fill = hostile ? "<" : "x";
      const room = budgets.maxBytes - graphUtf8Bytes(JSON.stringify(value));
      const stringRoom =
        (budgets.maxStringBytes ?? Number.POSITIVE_INFINITY) -
        graphUtf8Bytes(parent[last] as string);
      parent[last] =
        `${parent[last] as string}${fill.repeat(Math.max(0, Math.min(room, stringRoom)))}`;
    }
    if (graphBudgetIssues(budgets, value).length === 0) return value;
  }
  return generate({ type: "null" }, random, shape);
}

// --------------------------------------------------------------- fixtures

const RECORD: ArtifactTypeDef = {
  name: "record",
  version: 1,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "body", "tags", "items", "meta"],
    properties: {
      title: { type: "string" },
      body: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "note", "sub"],
          properties: {
            name: { type: "string" },
            note: { anyOf: [{ type: "string" }, { type: "null" }] },
            sub: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["x"],
                properties: { x: { type: "string" } },
              },
            },
          },
        },
      },
      meta: {
        type: "object",
        additionalProperties: false,
        required: ["a", "n"],
        properties: { a: { type: "string" }, n: { type: "integer" } },
      },
    },
  },
  storage: "value",
  budgets: { maxBytes: 700, maxStringBytes: 300, maxItems: 5 },
  render: {
    markdown:
      "# {{title}}\n{{body}}\n{{#tags}}- {{.}}\n{{/tags}}{{#items}}## {{name}} ({{note}})\n{{#sub}}* {{x}} in {{name}} of {{title}}\n{{/sub}}{{/items}}{{meta}} {{meta.n}} {{nope}} {{^tags}}no tags{{/tags}}",
    summary: ["title", "meta.a", "meta", "items"],
  },
};

const TEMPLATES = [
  "Intro {{params.s}}.\n{{> input.a}}\n{{#input.a.items}}{{name}} {{note}} {{#sub}}[{{x}}|{{name}}|{{input.a.title}}]{{/sub}}{{/input.a.items}}\n{{input.a.meta}} {{input.a}} {{input.a.tags.0}}",
  "{{#input.list}}{{> input.a}}{{title}}{{#items}}{{> input.a}}{{/items}}{{/input.list}}{{> input.list}}",
  "{{^input.a.tags}}none{{/input.a.tags}}{{#input.a.tags}}{{.}},{{/input.a.tags}}{{missing}} {{constructor}} {{input.a.nope}} {{#input.a.meta}}{{a}}{{n}}{{title}}{{/input.a.meta}}",
  "{{> input.a}}{{> input.a}}{{lens.instruction}} {{lens}} {{branch.key}} {{item.index}} {{run.iteration}} {{params.n}} {{params.e}}",
  "{{#input.a.items}}{{#input.a.items}}{{#input.a.tags}}{{body}}{{.}}{{/input.a.tags}}{{/input.a.items}}{{/input.a.items}}",
];

function makeNode(
  template: string,
  mode: GraphRenderMode,
  listMode: GraphRenderMode,
): GraphAgentNode {
  return {
    id: "n",
    kind: "agent",
    role: "worker",
    prompt: { template },
    capabilities: { profile: "reviewer" },
    workspaceAccess: "read",
    inputs: [
      { name: "a", type: "record@1", render: mode },
      { name: "list", type: "list<record@1>", render: listMode, required: false },
    ],
    outputs: [
      { name: "report", type: "review-report@1" },
      { name: "notes", type: "markdown@1", required: false },
    ],
    replicate: {
      over: "lenses",
      lenses: [
        { key: "sec", label: "Security <s>", instruction: "Look for <script> holes." },
        { key: "perf", label: "Performance", instruction: "Prefer the fast path." },
      ],
    },
  };
}

const TEMPLATE_CONTEXT = {
  types: [RECORD],
  parameters: [
    { key: "s", type: "string" as const, maxBytes: 40 },
    { key: "n", type: "number" as const },
    { key: "e", type: "enum" as const, options: ["short", "a-longer-option"] },
  ],
};

const MODES: GraphRenderMode[] = ["json-frame", "markdown", "summary", "file", "on-demand"];

function values(random: Rng, hostile: boolean, listItems: number): GraphPromptValues {
  const record = () => sample(RECORD.schema, RECORD.budgets, random, hostile);
  const fill = hostile ? "<" : "p";
  return {
    inputs: {
      a: record(),
      list: Array.from({ length: listItems }, record),
    },
    params: { s: fill.repeat(40), n: -123456789.123456, e: "a-longer-option" },
    run: { iteration: 10 },
    lens: { key: "sec", label: "Security <s>", instruction: "Look for <script> holes." },
    branch: { index: 32, key: "k".repeat(192), count: 32 },
    files: {
      a: {
        path: fill.repeat(GRAPH_PROMPT_FILE_PATH_MAX_BYTES),
        sha256: "f".repeat(64),
        bytes: Number.MAX_SAFE_INTEGER,
      },
      list: { path: "p", sha256: "0".repeat(64) },
    },
    artifacts: {
      a: [{ id: "i".repeat(128), bytes: Number.MAX_SAFE_INTEGER }],
      list: Array.from({ length: listItems }, (_, index) => ({ id: `item-${index}`, bytes: 1 })),
    },
    resultKeys: { report: "r".repeat(128), notes: "n".repeat(128) },
    capability: "c".repeat(GRAPH_PROMPT_CAPABILITY_MAX_CHARS),
  };
}

// ------------------------------------------------------------------- tests

describe("size estimates bound rendered sizes", () => {
  test("each render mode, plain and hostile values", () => {
    const random = rng(1);
    for (const mode of MODES) {
      for (const listItems of [0, 1, 3]) {
        const node = makeNode("{{> input.a}}{{> input.list}}", mode, mode);
        const scope = graphPromptScope({
          node,
          template: TEMPLATE_CONTEXT,
          listItems: { list: 3 },
        });
        const bounds = new Map(
          [...scope.ports.values()].map((port) => [port.name, estimateGraphPromptInput(port)]),
        );
        for (let round = 0; round < 40; round++) {
          const hostile = round % 2 === 1;
          const input = values(random, hostile, listItems);
          for (const port of scope.ports.values()) {
            const { text } = renderGraphPromptInput(port, input);
            const bytes = graphUtf8Bytes(text);
            const bound = bounds.get(port.name)!;
            expect({ mode, port: port.name, bytes, within: bytes <= bound.maxBytes }).toEqual({
              mode,
              port: port.name,
              bytes,
              within: true,
            });
            if (!hostile && !text.includes("&lt;")) {
              expect({ mode, port: port.name, nominal: bytes <= bound.nominalBytes }).toEqual({
                mode,
                port: port.name,
                nominal: true,
              });
            }
          }
        }
      }
    }
  });

  test("whole prompts, over templates with loops, outer references and partials", () => {
    const random = rng(2);
    const compiled = compileGraphCapabilities({ spec: { profile: "reviewer" }, environment: host });
    for (const template of TEMPLATES) {
      for (const mode of MODES) {
        const node = makeNode(template, mode, mode === "file" ? "summary" : mode);
        const context = { node, template: TEMPLATE_CONTEXT, listItems: { list: 3 } };
        const estimate = estimateGraphNodePromptSize({ ...context, compiled });
        expect(estimate.bounded).toBe(true);
        for (let round = 0; round < 12; round++) {
          const hostile = round % 3 === 0;
          const input = values(random, hostile, round % 4);
          const result = renderGraphNodePrompt({
            ...context,
            compiled,
            values: input,
            enforcement: { tier: "advisory" },
          });
          expect({ template, mode, round, fits: result.bytes <= estimate.maxBytes }).toEqual({
            template,
            mode,
            round,
            fits: true,
          });
          expect(graphUtf8Bytes(result.system)).toBeLessThanOrEqual(estimate.systemBytes);
        }
      }
    }
  });

  test("type markdown templates bound their renders", () => {
    const random = rng(3);
    const node = makeNode("{{> input.a}}", "markdown", "markdown");
    const scope = graphPromptScope({ node, template: TEMPLATE_CONTEXT });
    const port = scope.ports.get("a")!;
    const bound = estimateGraphPromptInput(port);
    let largest = 0;
    for (let round = 0; round < 300; round++) {
      const { text } = renderGraphPromptInput(port, {
        inputs: { a: sample(RECORD.schema, RECORD.budgets, random, round % 2 === 0) },
      });
      largest = Math.max(largest, graphUtf8Bytes(text));
    }
    expect(largest).toBeLessThanOrEqual(bound.maxBytes);
  });

  test("built-in types render within their bounds", () => {
    const random = rng(4);
    for (const ref of [
      "ticket@1",
      "review-report@1",
      "verification-verdict@1",
      "check-summary@1",
      "finding@1",
      "file-list@1",
    ]) {
      const definition = graphBuiltInType(ref)!;
      for (const mode of ["json-frame", "markdown", "summary"] as const) {
        const node = makeNode("{{> input.x}}", mode, mode);
        node.inputs = [{ name: "x", type: ref, render: mode }];
        const port = graphPromptScope({ node }).ports.get("x")!;
        const bound = estimateGraphPromptInput(port);
        const examples = [
          definition.example,
          mapStrings(definition.example, (text) => text.replaceAll("a", "<")),
        ];
        for (let round = 0; round < 10; round++) {
          examples.push(
            sample(
              definition.schema,
              { ...definition.budgets, maxBytes: Math.min(definition.budgets.maxBytes, 20_000) },
              random,
              round % 2 === 0,
            ),
          );
        }
        for (const value of examples) {
          const { text } = renderGraphPromptInput(port, { inputs: { x: value } });
          expect({ ref, mode, fits: graphUtf8Bytes(text) <= bound.maxBytes }).toEqual({
            ref,
            mode,
            fits: true,
          });
        }
      }
    }
  });

  test("an outer value read inside loops counts once per iteration", () => {
    const node = makeNode(
      "{{#input.a.items}}{{#sub}}{{input.a.title}}{{/sub}}{{/input.a.items}}",
      "json-frame",
      "json-frame",
    );
    const items = Array.from({ length: 5 }, () => ({
      name: "",
      note: null,
      sub: Array.from({ length: 5 }, () => ({ x: "" })),
    }));
    const value = { title: "", body: "", tags: [], items, meta: { a: "", n: 0 } };
    value.title = "t".repeat(RECORD.budgets.maxBytes - graphUtf8Bytes(JSON.stringify(value)));
    expect(graphBudgetIssues(RECORD.budgets, value)).toEqual([]);
    const compiled = compileGraphCapabilities({ spec: { profile: "reviewer" }, environment: host });
    const context = { node, template: TEMPLATE_CONTEXT };
    const result = renderGraphNodePrompt({
      ...context,
      compiled,
      values: { inputs: { a: value }, resultKeys: { report: "r", notes: "n" } },
    });
    expect(result.user).toBe(value.title.repeat(25));
    const estimate = estimateGraphPromptUserSize(context);
    expect(graphUtf8Bytes(result.user)).toBeLessThanOrEqual(estimate.nominalBytes);
  });

  test("a json-frame at its budget with nothing to escape is exactly the nominal size", () => {
    const node = makeNode("{{> input.a}}", "json-frame", "json-frame");
    const port = graphPromptScope({ node, template: TEMPLATE_CONTEXT }).ports.get("a")!;
    const value = { title: "", body: "", tags: [], items: [], meta: { a: "", n: 1 } };
    const padding = RECORD.budgets.maxBytes - graphUtf8Bytes(JSON.stringify(value));
    value.title = "x".repeat(Math.min(padding, 300));
    value.body = "x".repeat(padding - value.title.length);
    expect(graphUtf8Bytes(JSON.stringify(value))).toBe(RECORD.budgets.maxBytes);
    const { text } = renderGraphPromptInput(port, { inputs: { a: value } });
    expect(graphUtf8Bytes(text)).toBe(estimateGraphPromptInput(port).nominalBytes);
    // Escaping is what the max covers: the same value in `<` grows beyond nominal.
    const hostile = {
      ...value,
      title: "<".repeat(value.title.length),
      body: "<".repeat(value.body.length),
    };
    const escaped = graphUtf8Bytes(renderGraphPromptInput(port, { inputs: { a: hostile } }).text);
    expect(escaped).toBeGreaterThan(estimateGraphPromptInput(port).nominalBytes);
    expect(escaped).toBeLessThanOrEqual(estimateGraphPromptInput(port).maxBytes);
  });

  test("estimates count expansions and flag built-ins as allowances", () => {
    const node = makeNode(
      "{{#input.a.tags}}{{> input.a}}{{/input.a.tags}}",
      "json-frame",
      "json-frame",
    );
    const estimate = estimateGraphPromptUserSize({ node, template: TEMPLATE_CONTEXT });
    expect(estimate.inputs.find((input) => input.port === "a")?.expansions).toBe(5);
    expect(estimate.inputs.find((input) => input.port === "list")?.expansions).toBe(0);
    for (const example of graphTemplateExamples()) {
      for (const entry of example.template.nodes) {
        if (entry.kind !== "agent") continue;
        const size = estimateGraphPromptUserSize({ node: entry, template: example.template });
        expect(size.bounded).toBe(!("builtIn" in entry.prompt));
        expect(size.maxBytes).toBeGreaterThanOrEqual(size.nominalBytes);
      }
    }
  });
});
