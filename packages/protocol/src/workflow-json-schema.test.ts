import { describe, expect, test } from "bun:test";
import { validateWorkflowJsonSchema } from "./workflow-json-schema.js";

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["scope", "count"],
  properties: {
    scope: {
      type: "object",
      additionalProperties: false,
      required: ["branch"],
      properties: { branch: { type: "string" }, outcome: { type: "string" } },
    },
    count: { type: "integer" },
    sealed: { type: "object", additionalProperties: false, properties: {} },
  },
} as const;

describe("validateWorkflowJsonSchema refusals", () => {
  test("an unknown field names itself and the fields allowed beside it", () => {
    expect(
      validateWorkflowJsonSchema(schema, { scope: { branch: "main", extra: 1 }, count: 1 }),
    ).toEqual([
      {
        path: "$.scope.extra",
        code: "unknown_field",
        message: "Field is not allowed. Allowed fields here: branch, outcome.",
      },
    ]);
    expect(
      validateWorkflowJsonSchema(schema, { scope: { branch: "main" }, count: 1, sealed: { a: 1 } }),
    ).toEqual([
      {
        path: "$.sealed.a",
        code: "unknown_field",
        message: "Field is not allowed. No fields are allowed here.",
      },
    ]);
  });

  test("a wrong type says what was received", () => {
    expect(validateWorkflowJsonSchema(schema, { scope: { branch: null }, count: "1" })).toEqual([
      { path: "$.scope.branch", code: "invalid_type", message: "Expected string, received null" },
      { path: "$.count", code: "invalid_type", message: "Expected integer, received string" },
    ]);
    expect(validateWorkflowJsonSchema(schema, [])).toEqual([
      { path: "$", code: "invalid_type", message: "Expected object, received array" },
    ]);
  });

  test("a missing field is named by its path", () => {
    expect(validateWorkflowJsonSchema(schema, { scope: {} })).toEqual([
      { path: "$.count", code: "missing_field", message: "Required field is missing" },
      { path: "$.scope.branch", code: "missing_field", message: "Required field is missing" },
    ]);
  });

  test("a long list of allowed fields is cut, and the message stays bounded", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`field${index}`, { type: "string" }]),
    );
    const [issue] = validateWorkflowJsonSchema(
      { type: "object", additionalProperties: false, properties },
      { unknown: 1 },
    );
    expect(issue?.message).toContain("field23, …");
    expect(issue?.message).not.toContain("field24");
    expect(issue!.message.length).toBeLessThanOrEqual(512);
  });
});
