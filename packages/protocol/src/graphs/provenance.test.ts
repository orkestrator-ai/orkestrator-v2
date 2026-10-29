import { describe, expect, test } from "bun:test";
import {
  GRAPH_PROVENANCE_BOUNDS,
  GRAPH_PROVENANCE_DROPPED_FIELD,
  graphProvenanceDroppedSchema,
  graphProvenancePlanForSchema,
  graphProvenancePlanProblem,
  graphProvenanceSourcesProblem,
  validateGraphProvenance,
  type GraphProvenancePlan,
} from "./provenance";
import { validateGraphSchemaSubset } from "./schema-subset";

const ids = { type: "array", items: { type: "string" }, "x-orkestrator-sources": true };

/** A custom consolidated design brief: options cite the briefs they came from. */
const BRIEF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "options", "dropped"],
  properties: {
    summary: { type: "string" },
    options: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "sources"],
        properties: { title: { type: "string" }, sources: ids },
      },
    },
    dropped: graphProvenanceDroppedSchema(),
  },
};

const SOURCES = {
  "brief-1/option-1": "option@1",
  "brief-1/option-2": "option@1",
  "brief-2/option-1": "option@1",
};

function cite(): GraphProvenancePlan {
  return graphProvenancePlanForSchema("cite", BRIEF_SCHEMA)!;
}

describe("provenance plans", () => {
  test("a plan reads the schema's x-orkestrator-sources fields and its dropped list", () => {
    expect(validateGraphSchemaSubset(BRIEF_SCHEMA).ok).toBe(true);
    expect(cite()).toEqual({ mode: "cite", fields: [{ segments: ["options", "[]", "sources"] }] });
    expect(graphProvenancePlanForSchema("accountForAll", BRIEF_SCHEMA)).toEqual({
      mode: "accountForAll",
      fields: [{ segments: ["options", "[]", "sources"] }],
      droppedField: GRAPH_PROVENANCE_DROPPED_FIELD,
    });
  });

  test("a type without a dropped list must cite every source under accountForAll", () => {
    const { dropped: _dropped, ...properties } = BRIEF_SCHEMA.properties;
    const schema = { ...BRIEF_SCHEMA, required: ["summary", "options"], properties };
    const plan = graphProvenancePlanForSchema("accountForAll", schema)!;
    expect(plan.droppedField).toBeUndefined();
    const issues = validateGraphProvenance(
      { summary: "S", options: [{ title: "A", sources: ["brief-1/option-1"] }] },
      plan,
      SOURCES,
    );
    expect(issues.map((issue) => [issue.path, issue.code])).toEqual([
      ["$", "unaccounted_source"],
      ["$", "unaccounted_source"],
    ]);
  });

  test("a schema outside the subset has no plan", () => {
    expect(graphProvenancePlanForSchema("cite", { type: "object", pattern: "x" })).toBeNull();
  });

  test("guards reject malformed persisted plans and source maps", () => {
    expect(graphProvenancePlanProblem(cite())).toBeNull();
    expect(graphProvenancePlanProblem({ mode: "all", fields: [] })).toContain("mode");
    expect(
      graphProvenancePlanProblem({ mode: "cite", fields: [{ segments: ["a", "[]"] }] }),
    ).toContain("segments");
    expect(
      graphProvenancePlanProblem({
        mode: "cite",
        fields: [{ segments: ["a"] }],
        droppedField: "dropped",
      }),
    ).toContain("droppedField");
    expect(
      graphProvenancePlanProblem({ mode: "cite", fields: [{ segments: ["a"], minCitations: -1 }] }),
    ).toContain("minCitations");
    expect(graphProvenanceSourcesProblem(SOURCES)).toBeNull();
    expect(graphProvenanceSourcesProblem({ a: "" })).toContain("class");
    const tooMany = Object.fromEntries(
      Array.from({ length: GRAPH_PROVENANCE_BOUNDS.maxSources + 1 }, (_, index) => [
        `s-${index}`,
        "x",
      ]),
    );
    expect(graphProvenanceSourcesProblem(tooMany)).toContain("at most");
  });
});

describe("cite", () => {
  test("cited IDs must name an item of the node's inputs", () => {
    const value = {
      summary: "S",
      options: [
        { title: "A", sources: ["brief-1/option-1", "brief-9/option-1"] },
        { title: "B", sources: [] },
        { title: "C", sources: [7] },
      ],
      dropped: [],
    };
    expect(validateGraphProvenance(value, cite(), SOURCES)).toEqual([
      {
        path: "$.options[0].sources[1]",
        code: "invalid_value",
        message: "The source does not identify an item in the node's inputs.",
      },
      {
        path: "$.options[2].sources[0]",
        code: "invalid_value",
        message: "The source does not identify an item in the node's inputs.",
      },
    ]);
  });

  test("an ID inherited from Object.prototype is not a source", () => {
    const value = {
      summary: "S",
      options: [{ title: "A", sources: ["constructor", "toString"] }],
      dropped: [],
    };
    expect(validateGraphProvenance(value, cite(), SOURCES)).toHaveLength(2);
  });

  test("source classes, minimum citations and derived fields are per field", () => {
    const plan: GraphProvenancePlan = {
      mode: "cite",
      fields: [
        {
          segments: ["options", "[]", "sources"],
          sourceClass: "option@1",
          minCitations: 2,
          derivedFields: ["models"],
        },
      ],
    };
    const sources = { ...SOURCES, "ticket/criterion-1": "criterion@1" };
    const value = {
      options: [
        { title: "A", sources: ["brief-1/option-1"], models: ["m"] },
        { title: "B", sources: ["brief-1/option-1", "ticket/criterion-1"] },
        { title: "C" },
      ],
    };
    expect(
      validateGraphProvenance(value, plan, sources, {
        item: "option",
        derived: { models: "Leave models to the backend." },
      }),
    ).toEqual([
      {
        path: "$.options[0].models",
        code: "invalid_value",
        message: "Leave models to the backend.",
      },
      {
        path: "$.options[0].sources",
        code: "missing_field",
        message: "Every option must cite at least 2 source IDs.",
      },
      {
        path: "$.options[1].sources[1]",
        code: "invalid_value",
        message: "The source does not identify a option@1 in the node's inputs.",
      },
      {
        path: "$.options[2].sources",
        code: "missing_field",
        message: "Every option must cite at least 2 source IDs.",
      },
    ]);
  });

  test("nested fields and nullable fields walk only what is there", () => {
    const plan: GraphProvenancePlan = {
      mode: "cite",
      fields: [{ segments: ["groups", "[]", "items", "[]", "ids"] }, { segments: ["evidence"] }],
    };
    const value = {
      groups: [
        { items: [{ ids: ["brief-1/option-1"] }, { ids: null }, "x"] },
        null,
        { items: "x" },
      ],
      evidence: ["brief-9/option-1"],
    };
    expect(validateGraphProvenance(value, plan, SOURCES)).toEqual([
      {
        path: "$.evidence[0]",
        code: "invalid_value",
        message: "The source does not identify an item in the node's inputs.",
      },
    ]);
  });

  test("non-objects yield nothing and issues stop at the cap", () => {
    expect(validateGraphProvenance([1, 2], cite(), SOURCES)).toEqual([]);
    const value = {
      options: Array.from({ length: 50 }, () => ({ title: "A", sources: ["unknown"] })),
    };
    expect(validateGraphProvenance(value, cite(), SOURCES)).toHaveLength(
      GRAPH_PROVENANCE_BOUNDS.maxIssues,
    );
  });
});

describe("accountForAll", () => {
  const plan = () => graphProvenancePlanForSchema("accountForAll", BRIEF_SCHEMA)!;

  test("every source is cited or dropped with a reason", () => {
    const value = {
      summary: "S",
      options: [{ title: "A", sources: ["brief-1/option-1", "brief-2/option-1"] }],
      dropped: [{ id: "brief-1/option-2", reason: "Superseded by option A." }],
    };
    expect(validateGraphProvenance(value, plan(), SOURCES)).toEqual([]);
  });

  test("unaccounted, invented, repeated, contradicting and unexplained drops are reported", () => {
    const value = {
      summary: "S",
      options: [{ title: "A", sources: ["brief-1/option-1"] }],
      dropped: [
        { id: "brief-7/option-1", reason: "Invented." },
        { id: "brief-1/option-1", reason: "Also cited." },
        { id: "brief-1/option-2", reason: " " },
        { id: "brief-1/option-2", reason: "Twice." },
      ],
    };
    expect(
      validateGraphProvenance(value, plan(), SOURCES).map((issue) => [issue.path, issue.code]),
    ).toEqual([
      ["$.dropped[0].id", "invalid_value"],
      ["$.dropped[1].id", "conflict"],
      ["$.dropped[2].reason", "missing_field"],
      ["$.dropped[3].id", "duplicate"],
      ["$.dropped", "unaccounted_source"],
    ]);
    const unaccounted = validateGraphProvenance(value, plan(), SOURCES).at(-1)!;
    expect(unaccounted.message).toBe(
      "Cite source brief-2/option-1, or list it in dropped with a reason.",
    );
  });
});
