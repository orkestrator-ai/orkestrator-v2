import { describe, expect, test } from "bun:test";
import { FieldErrorCollector } from "../field-validation.js";
import { compile, graphTemplateDigest } from "./compile.js";
import { graphTemplateExample } from "./examples.js";
import {
  GRAPH_MOCK_PIN_BOUNDS,
  GRAPH_MOCK_PIN_ISSUE_CODES,
  checkGraphMockPins,
  graphMockCommit,
  graphMockPinAt,
  graphMockPinIssues,
  graphMockPinKind,
  graphMockPinLabel,
  graphMockPinTargetFromPlan,
  graphMockPinTargetFromTemplate,
  graphMockValue,
  graphMockWorkspace,
  graphSchemaSample,
  mergeGraphMockPins,
  parseGraphMockPins,
  type GraphMockPinIssueCode,
  type GraphMockPins,
} from "./mock.js";
import { graphRunFixture } from "./run-fixtures.test-support.js";
import { validateGraphRun } from "./run.js";
import { validateGraphSchemaValue } from "./schema-subset.js";
import { graphBuiltinTemplateResolver } from "./subgraphs.js";
import { validateGraphTemplate } from "./template.js";
import { GraphTypeLibrary, graphBuiltInTypes, validateGraphArtifactValue } from "./types.js";

function shapeErrors(value: unknown): string[] {
  const errors = new FieldErrorCollector(50);
  checkGraphMockPins(value, "pins", errors);
  return errors.errors.map((error) => `${error.path}:${error.code}`);
}

describe("graphSchemaSample", () => {
  const schema = {
    type: "object",
    properties: {
      title: { type: "string" },
      headRef: { type: "string" },
      detailsUrl: { type: "string" },
      branch: { type: "string" },
      path: { type: "string" },
      itemId: { type: "string" },
      state: { type: "string", enum: ["passed", "failed"] },
      kind: { type: "string", const: "fixed" },
      count: { type: "integer", minimum: 3, maximum: 9 },
      score: { type: "number", maximum: 0.5 },
      done: { type: "boolean" },
      note: { anyOf: [{ type: "null" }, { type: "string" }] },
      nothing: { type: "null" },
      sources: { type: "array", items: { type: "string" }, "x-orkestrator-sources": true },
      files: {
        type: "array",
        items: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
    required: [
      "title",
      "headRef",
      "detailsUrl",
      "branch",
      "path",
      "itemId",
      "state",
      "kind",
      "count",
      "score",
      "done",
      "note",
      "nothing",
      "sources",
      "files",
    ],
    additionalProperties: false,
  };

  test("follows the documented rules and passes its schema", () => {
    const value = graphSchemaSample(schema) as Record<string, unknown>;
    expect(value).toMatchObject({
      title: "Sample title",
      detailsUrl: "https://example.com/mock/detailsUrl",
      branch: "mock/branch",
      path: "src/example.ts",
      itemId: "itemId-1",
      state: "passed",
      kind: "fixed",
      count: 3,
      score: 0.5,
      done: true,
      note: "Sample note",
      nothing: null,
      sources: [],
      files: [{ path: "src/example.ts" }],
    });
    expect(value.headRef).toMatch(/^[a-f0-9]{40}$/);
    expect(validateGraphSchemaValue(schema, value)).toEqual([]);
  });

  test("is deterministic, and variants and array sizes vary it", () => {
    expect(graphSchemaSample(schema)).toEqual(graphSchemaSample(schema));
    const varied = graphSchemaSample(schema, { variant: 1, arrayItems: 3 }) as Record<
      string,
      unknown
    >;
    expect(varied.state).toBe("failed");
    expect(varied.files).toEqual([
      { path: "src/example-2.ts" },
      { path: "src/example-3.ts" },
      { path: "src/example-4.ts" },
    ]);
    expect(
      (graphSchemaSample(schema, { arrayItems: 99 }) as { files: unknown[] }).files,
    ).toHaveLength(8);
  });

  test("is bounded in depth and lenient outside the subset", () => {
    expect(
      graphSchemaSample(
        {
          type: "object",
          properties: { a: { type: "object", properties: { b: { type: "string" } } } },
        },
        { maxDepth: 1 },
      ),
    ).toEqual({ a: { b: null } });
    expect(graphSchemaSample({ type: ["null", "integer"] })).toBe(1);
    expect(graphSchemaSample({})).toBeNull();
  });
});

describe("graphMockValue", () => {
  test("every built-in type gives a valid example and a valid generated value", () => {
    for (const definition of graphBuiltInTypes()) {
      for (const mode of ["example", "generated"] as const) {
        const result = graphMockValue(definition, mode);
        expect({ type: definition.ref, mode, issues: result.issues }).toEqual({
          type: definition.ref,
          mode,
          issues: [],
        });
        expect(validateGraphArtifactValue(definition, result.value)).toEqual([]);
      }
      expect(graphMockValue(definition, "example").source).toBe("example");
    }
  });

  test("a generated value is preferred when it passes, else the example", () => {
    const library = new GraphTypeLibrary();
    const text = library.definition("text", 1)!;
    expect(graphMockValue(text, "generated")).toEqual({
      value: { text: "Sample text" },
      source: "generated",
      issues: [],
    });
    // A generated check summary does not agree with its own counts: the example is used.
    const checks = library.definition("check-summary", 1)!;
    expect(graphMockValue(checks, "generated").source).toBe("example");
  });

  test("values fit what the port knows", () => {
    const library = new GraphTypeLibrary();
    const decision = graphMockValue(library.definition("decision", 1)!, "example", {
      choices: ["left", "right"],
    });
    expect((decision.value as { choice: string }).choice).toBe("left");
    expect(decision.issues).toEqual([]);
    const verdict = graphMockValue(library.definition("verification-verdict", 1)!, "example", {
      criterionIds: ["c-1", "c-2"],
    });
    expect(
      (verdict.value as { acceptanceCriteria: { id: string }[] }).acceptanceCriteria.map(
        (c) => c.id,
      ),
    ).toEqual(["c-1", "c-2"]);
    expect(verdict.issues).toEqual([]);
    const results = graphMockValue(library.definition("validation-results", 1)!, "example", {
      headRef: "f".repeat(40),
    });
    expect((results.value as { headRef: string }).headRef).toBe("f".repeat(40));
  });

  test("a custom type without an example is generated", () => {
    const template = graphTemplateExample("failure-diagnosis");
    const library = new GraphTypeLibrary(template.types);
    const diagnosis = library.definition("diagnosis", 1)!;
    const result = graphMockValue({ ...diagnosis, example: undefined }, "example");
    expect(result.source).toBe("generated");
    expect(result.issues).toEqual([]);
  });
});

describe("graphMockWorkspace", () => {
  const base = { branch: "feature/x", headRef: "a".repeat(40), baseRef: null };

  test("a writing node commits on top of its input, deterministically", () => {
    const first = graphMockWorkspace({
      runId: "r",
      activationKey: "build#iter=1#attempt=1",
      port: "code",
      writes: true,
      base,
    });
    expect(first).toEqual({
      branch: "feature/x",
      headRef: graphMockCommit("r\0build#iter=1#attempt=1\0code"),
      baseRef: "a".repeat(40),
    });
    expect(
      graphMockWorkspace({
        runId: "r",
        activationKey: "build#iter=1#attempt=1",
        port: "code",
        writes: true,
        base,
      }),
    ).toEqual(first);
    expect(first.headRef).toMatch(/^[a-f0-9]{40}$/);
  });

  test("a reading node passes its input through; no input starts a mock branch", () => {
    expect(
      graphMockWorkspace({ runId: "r", activationKey: "k", port: "code", writes: false, base }),
    ).toEqual(base);
    const fresh = graphMockWorkspace({
      runId: "r",
      activationKey: "k",
      port: "code",
      writes: false,
    });
    expect(fresh.branch).toMatch(/^mock\/run-[a-f0-9]{8}$/);
    expect(fresh.baseRef).toBeNull();
  });
});

describe("pins", () => {
  test("the n-th activation takes the n-th pin and the last repeats", () => {
    const pins: GraphMockPins = { verify: ["example", { fail: "timeout" }, "generated"] };
    expect(graphMockPinAt(pins, "verify", 0)).toBe("example");
    expect(graphMockPinAt(pins, "verify", 1)).toEqual({ fail: "timeout" });
    expect(graphMockPinAt(pins, "verify", 2)).toBe("generated");
    expect(graphMockPinAt(pins, "verify", 7)).toBe("generated");
    expect(graphMockPinAt(pins, "build", 0)).toBeUndefined();
    expect(graphMockPinAt(undefined, "verify", 0)).toBeUndefined();
  });

  test("labels and kinds", () => {
    expect(
      [
        "example",
        "generated",
        "pause",
        { outputs: {} },
        { fail: "timeout" },
        { outlet: "rejected" },
      ].map((pin) => [graphMockPinKind(pin as never), graphMockPinLabel(pin as never)]),
    ).toEqual([
      ["example", "example"],
      ["generated", "generated"],
      ["pause", "pause"],
      ["custom", "custom"],
      ["fail", "fail: timeout"],
      ["outlet", "outlet: rejected"],
    ]);
  });

  test("launch pins replace stored ones node by node; empty sequences drop out", () => {
    expect(
      mergeGraphMockPins({ a: ["example"], b: ["generated"] }, { b: [{ fail: "timeout" }], c: [] }),
    ).toEqual({ a: ["example"], b: [{ fail: "timeout" }] });
    expect(mergeGraphMockPins(undefined, { c: [] })).toBeUndefined();
  });

  test("the shape check refuses what is not a pin", () => {
    expect(shapeErrors({ verify: ["example", { outputs: { verdict: {} } }] })).toEqual([]);
    expect(shapeErrors({ Verify: ["example"] })).toEqual(["pins.Verify:pattern"]);
    expect(shapeErrors({ verify: "example" })).toEqual(["pins.verify:type"]);
    expect(shapeErrors({ verify: ["passed"] })).toEqual(["pins.verify[0]:enum"]);
    expect(shapeErrors({ verify: [{ fail: "oops" }] })).toEqual(["pins.verify[0].fail:enum"]);
    expect(shapeErrors({ verify: [{ fail: "timeout", extra: 1 }] })).toEqual([
      "pins.verify[0].extra:unknown_field",
    ]);
    expect(shapeErrors({ verify: [{ outlet: "Bad Name" }] })).toEqual([
      "pins.verify[0].outlet:pattern",
    ]);
    expect(shapeErrors({ verify: [{ other: 1 }] })).toEqual(["pins.verify[0]:type"]);
    expect(shapeErrors({ verify: [{ outputs: { "bad port": 1 } }] })).toEqual([
      "pins.verify[0].outputs.bad port:pattern",
    ]);
    expect(
      shapeErrors({
        verify: Array.from({ length: GRAPH_MOCK_PIN_BOUNDS.maxPinsPerNode + 1 }, () => "example"),
      }),
    ).toEqual(["pins.verify:too_many"]);
    expect(
      shapeErrors({
        verify: [{ outputs: { text: "x".repeat(GRAPH_MOCK_PIN_BOUNDS.maxPinBytes) } }],
      }),
    ).toContain("pins.verify[0]:too_large");
    // Plan ids: a pin may target a node inlined from a sub-graph (item 402).
    expect(shapeErrors({ "review/fix": ["example"], "a/b/c": ["generated"] })).toEqual([]);
    expect(shapeErrors({ "review//fix": ["example"] })).toEqual(["pins.review//fix:pattern"]);
    expect(shapeErrors({ "/fix": ["example"] })).toEqual(["pins./fix:pattern"]);
    expect(parseGraphMockPins({ verify: ["passed"] })).toEqual({
      ok: false,
      errors: ["pins.verify[0]: Expected one of: example, generated, pause"],
    });
  });

  test("templates store pins outside the digest; runs carry them only when mocked", () => {
    const template = graphTemplateExample("build-pipeline-loop");
    const digest = graphTemplateDigest(template);
    const pinned = { ...template, mockPins: { verify: ["generated" as const] } };
    expect(validateGraphTemplate(pinned).ok).toBe(true);
    expect(graphTemplateDigest(pinned)).toBe(digest);
    expect(validateGraphTemplate({ ...template, mockPins: { verify: ["nope"] } }).ok).toBe(false);

    const run = graphRunFixture({
      mock: true,
      mockOptions: { pins: { verify: ["example"] }, stepMs: 500 },
    });
    expect(validateGraphRun(run).ok).toBe(true);
    const live = validateGraphRun({ ...run, mock: false });
    expect(live.ok ? [] : live.errors.map((error) => `${error.path}:${error.code}`)).toEqual([
      "mockOptions:not_applicable",
    ]);
    const slow = validateGraphRun({ ...run, mockOptions: { stepMs: 20_000 } });
    expect(slow.ok ? [] : slow.errors.map((error) => `${error.path}:${error.code}`)).toEqual([
      "mockOptions.stepMs:range",
    ]);
  });
});

describe("graphMockPinIssues", () => {
  const template = graphTemplateExample("design-bake-off");
  const verdict = { complete: true, rationale: "ok", acceptanceCriteria: [] };
  const cases: Record<GraphMockPinIssueCode, GraphMockPins> = {
    "mock-pin-unknown-node": { nowhere: ["example"] },
    "mock-pin-node-kind": {},
    "mock-pin-form": { judge: [{ outlet: "approved" }] },
    "mock-pin-unknown-port": { judge: [{ outputs: { verdict } }] },
    "mock-pin-required-port": { judge: [{ outputs: { decision: null } }] },
    "mock-pin-value": {
      judge: [{ outputs: { decision: { choice: "speed", rationale: "fast" } } }],
    },
    "mock-pin-outlet": { approve: [{ outlet: "maybe" }] },
  };

  test("reports every code, against the template and the compiled plan", () => {
    const gated = graphTemplateExample("multi-review");
    const planned = compile(gated).plan!;
    for (const code of GRAPH_MOCK_PIN_ISSUE_CODES) {
      const target =
        code === "mock-pin-node-kind"
          ? graphMockPinTargetFromPlan(planned)
          : graphMockPinTargetFromTemplate(template);
      const pins =
        code === "mock-pin-node-kind" ? { "has-findings": ["example" as const] } : cases[code];
      expect(graphMockPinIssues(target, pins).map((issue) => issue.code)).toEqual([code]);
    }
  });

  test("accepts fitting pins, including an edit and a null optional output", () => {
    const target = graphMockPinTargetFromTemplate(template);
    const brief = { summary: "s", approach: "a", risks: [], filesTouched: [] };
    expect(
      graphMockPinIssues(target, {
        design: ["example", "generated", { fail: "provider-error" }],
        judge: [{ outputs: { decision: { choice: "security", rationale: "safest" } } }],
        approve: ["example", "pause", { outlet: "approved", outputs: { brief } }],
        pr: [
          {
            outputs: {
              pr: { status: "created", url: "https://github.com/a/b/pull/1", summary: "s" },
            },
          },
        ],
      }),
    ).toEqual([]);
    const plan = compile(graphTemplateExample("build-pipeline-loop")).plan!;
    expect(
      graphMockPinIssues(graphMockPinTargetFromPlan(plan), {
        verify: [{ outputs: { verdict, code: null } }],
      }).map((issue) => issue.code),
    ).toEqual(["mock-pin-required-port"]);
  });

  test("pins on inlined nodes are checked against the plan, deferred on the template", () => {
    const fix = [{ outputs: { code: null } }] as GraphMockPins[string];
    const target = graphMockPinTargetFromTemplate(template);
    // The template does not know Multi Review's nodes until it is inlined.
    expect(
      graphMockPinIssues(target, { "review/fix": fix, "review/nowhere": ["example"] }),
    ).toEqual([]);
    // A prefix that is not a sub-graph node names nothing.
    expect(
      graphMockPinIssues(target, { "judge/fix": ["example"] }).map((issue) => issue.code),
    ).toEqual(["mock-pin-unknown-node"]);
    expect(graphMockPinIssues(target, { review: ["example"] }).map((issue) => issue.code)).toEqual([
      "mock-pin-node-kind",
    ]);
    const plan = compile(template, { resolveTemplate: graphBuiltinTemplateResolver }).plan!;
    const planned = graphMockPinTargetFromPlan(plan);
    expect(
      graphMockPinIssues(planned, {
        "review/consolidate": ["generated"],
        "review/fix": [{ fail: "provider-error" }, "example"],
      }),
    ).toEqual([]);
    expect(
      graphMockPinIssues(planned, {
        "review/nowhere": ["example"],
        "review/fix": fix,
        "review/has-findings": ["example"],
      }).map((issue) => [issue.nodeId, issue.code]),
    ).toEqual([
      ["review/nowhere", "mock-pin-unknown-node"],
      ["review/fix", "mock-pin-required-port"],
      ["review/has-findings", "mock-pin-node-kind"],
    ]);
  });

  test("a human edit value is checked against the edited input's type", () => {
    const target = graphMockPinTargetFromTemplate(template);
    const issues = graphMockPinIssues(target, {
      approve: [{ outlet: "approved", outputs: { brief: { summary: 1 } } }],
    });
    expect(issues.map((issue) => [issue.code, issue.port])).toEqual([["mock-pin-value", "brief"]]);
    expect(issues[0]!.issues?.length).toBeGreaterThan(0);
  });
});
