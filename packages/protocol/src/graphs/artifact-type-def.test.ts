import { describe, expect, test } from "bun:test";
import { graphTemplateExample } from "./examples";
import { GRAPH_SCHEMA_SOURCES_KEYWORD } from "./schema-subset";
import { validateGraphTemplate } from "./template";

// Tests edit templates freely, including into shapes the types forbid.
// oxlint-disable-next-line typescript/no-explicit-any
type Draft = any;

function errorsOf(template: unknown): Array<[string, string]> {
  const result = validateGraphTemplate(template);
  return result.ok ? [] : result.errors.map((error) => [error.path, error.code]);
}

/** The §9.4 template with its `diagnosis@1` type (index 2) edited. */
function withDiagnosis(edit: (type: Draft) => void): Draft {
  const template: Draft = graphTemplateExample("failure-diagnosis");
  edit(template.types[2]);
  return template;
}

const DIAGNOSIS_EXAMPLE = {
  diagnoses: [
    {
      rootCause: "Stale fixture",
      explanation: "The snapshot predates the change.",
      files: ["a.ts"],
    },
  ],
};

describe("custom artifact types", () => {
  test("the example templates' custom types pass", () => {
    for (const key of ["design-bake-off", "failure-diagnosis"] as const) {
      expect(errorsOf(graphTemplateExample(key))).toEqual([]);
    }
    expect(errorsOf(withDiagnosis((type) => (type.example = DIAGNOSIS_EXAMPLE)))).toEqual([]);
  });

  test("a custom type cannot take a built-in name", () => {
    expect(errorsOf(withDiagnosis((type) => (type.name = "review-report")))).toEqual([
      ["types[2].name", "built_in_type"],
    ]);
  });

  test("schema constructs outside the subset are errors at their path", () => {
    const cases: Array<[(schema: Draft) => void, Array<[string, string]>]> = [
      [
        (schema) => (schema.properties.diagnoses.items.properties.rootCause.pattern = "^[A-Z]"),
        [
          [
            "types[2].schema.properties.diagnoses.items.properties.rootCause.pattern",
            "unsupported_keyword",
          ],
        ],
      ],
      [
        (schema) => (schema.properties.diagnoses.items = { $ref: "#/definitions/diagnosis" }),
        [
          ["types[2].schema.properties.diagnoses.items.$ref", "unsupported_keyword"],
          ["types[2].schema.properties.diagnoses.items.type", "required"],
        ],
      ],
      [
        (schema) =>
          (schema.properties.diagnoses.items.properties.files = {
            oneOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
          }),
        [
          [
            "types[2].schema.properties.diagnoses.items.properties.files.oneOf",
            "unsupported_keyword",
          ],
          ["types[2].schema.properties.diagnoses.items.properties.files.type", "required"],
        ],
      ],
      [
        (schema) => (schema.properties.diagnoses.items.required = ["rootCause", "explanation"]),
        [["types[2].schema.properties.diagnoses.items.properties.files", "not_required"]],
      ],
      [
        (schema) => delete schema.additionalProperties,
        [["types[2].schema.additionalProperties", "required"]],
      ],
      [
        (schema) => (schema.properties.diagnoses.maxItems = 32),
        [["types[2].schema.properties.diagnoses.maxItems", "unsupported_keyword"]],
      ],
    ];
    for (const [edit, expected] of cases) {
      expect(errorsOf(withDiagnosis((type) => edit(type.schema)))).toEqual(expected);
    }
  });

  test("items must name a non-null list field", () => {
    expect(errorsOf(withDiagnosis((type) => (type.items.path = "missing")))).toEqual([
      ["types[2].items.path", "unknown_path"],
    ]);
    expect(
      errorsOf(
        withDiagnosis((type) => {
          type.schema.properties.note = { type: "string" };
          type.schema.required.push("note");
          type.items.path = "note";
        }),
      ),
    ).toEqual([["types[2].items.path", "not_a_list"]]);
    expect(
      errorsOf(
        withDiagnosis((type) => {
          type.schema.properties.diagnoses = {
            anyOf: [type.schema.properties.diagnoses, { type: "null" }],
          };
        }),
      ),
    ).toEqual([["types[2].items.path", "not_a_list"]]);
  });

  test("shared and summary fields must exist", () => {
    expect(
      errorsOf(
        withDiagnosis((type) => {
          type.sharedFields = ["diagnoses", "nope"];
          type.render = { summary: ["also.nope"] };
        }),
      ),
    ).toEqual([
      ["types[2].sharedFields[1]", "unknown_path"],
      ["types[2].render.summary[0]", "unknown_path"],
    ]);
  });

  test("the example must satisfy the schema and the budgets", () => {
    expect(
      errorsOf(withDiagnosis((type) => (type.example = { diagnoses: [{ rootCause: "x" }] }))),
    ).toEqual([
      ["types[2].example.diagnoses[0].explanation", "missing_field"],
      ["types[2].example.diagnoses[0].files", "missing_field"],
    ]);
    expect(
      errorsOf(
        withDiagnosis((type) => {
          type.budgets = { maxBytes: 65_536, maxStringBytes: 4, maxItems: 32 };
          type.example = DIAGNOSIS_EXAMPLE;
        }),
      ).map(([path, code]) => [path, code]),
    ).toContainEqual(["types[2].example.diagnoses[0].rootCause", "too_large"]);
    // Field references and the example are not judged against an invalid schema.
    expect(
      errorsOf(
        withDiagnosis((type) => {
          type.schema.pattern = "x";
          type.example = { wrong: true };
        }),
      ),
    ).toEqual([["types[2].schema.pattern", "unsupported_keyword"]]);
  });

  test("provenance fields are recognised in custom schemas", () => {
    expect(
      errorsOf(
        withDiagnosis((type) => {
          type.schema.properties.sources = {
            type: "array",
            items: { type: "string" },
            [GRAPH_SCHEMA_SOURCES_KEYWORD]: true,
          };
          type.schema.required.push("sources");
        }),
      ),
    ).toEqual([]);
    expect(
      errorsOf(
        withDiagnosis((type) => {
          type.schema.properties.sources = { type: "string", [GRAPH_SCHEMA_SOURCES_KEYWORD]: true };
          type.schema.required.push("sources");
        }),
      ),
    ).toEqual([
      [`types[2].schema.properties.sources.${GRAPH_SCHEMA_SOURCES_KEYWORD}`, "not_applicable"],
    ]);
  });
});

describe("decision choices on output ports", () => {
  function judge(template: Draft): Draft {
    return template.nodes.find((node: Draft) => node.id === "judge");
  }

  test("are accepted on decision outputs", () => {
    const template: Draft = graphTemplateExample("design-bake-off");
    expect(judge(template).outputs[0].choices).toEqual(["simplicity", "performance", "security"]);
    expect(errorsOf(template)).toEqual([]);
  });

  test("are rejected elsewhere, when repeated, malformed or too few", () => {
    const template: Draft = graphTemplateExample("design-bake-off");
    judge(template).outputs[1].choices = ["a", "b"];
    judge(template).outputs[0].choices = ["a", "a", "b c"];
    expect(errorsOf(template)).toEqual([
      ["nodes[1].outputs[0].choices[1]", "duplicate"],
      ["nodes[1].outputs[0].choices[2]", "pattern"],
      ["nodes[1].outputs[1].choices", "not_applicable"],
    ]);
    judge(template).outputs[1].choices = undefined;
    judge(template).outputs[0].choices = ["only"];
    expect(errorsOf(template)).toEqual([["nodes[1].outputs[0].choices", "too_few"]]);
  });
});
