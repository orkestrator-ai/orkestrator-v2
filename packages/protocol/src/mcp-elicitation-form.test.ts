import { expect, test } from "bun:test";
import { isSupportedMcpForm, isValidMcpFormContent } from "./mcp-elicitation-form";

test("accepted form schemas enforce required fields, scalar types, enum and bounds", () => {
  const schema = {
    type: "object",
    properties: {
      team: { type: "string", enum: ["core", "web"] },
      count: { type: "integer", minimum: 1, maximum: 5 },
      label: { type: "string", minLength: 1, maxLength: 2 },
      enabled: { type: "boolean" },
    },
    required: ["team", "count"],
  };
  expect(isSupportedMcpForm(schema)).toBe(true);
  expect(
    isValidMcpFormContent(schema, { team: "core", count: 2, enabled: false, label: "界" }),
  ).toBe(true);
  for (const content of [
    { team: "core" },
    { team: "other", count: 2 },
    { team: "core", count: 1.5 },
    { team: "core", count: "2" },
    { team: "core", count: 6 },
    { team: "core", count: 2, label: "long" },
    { team: "core", count: 2, enabled: "false" },
    { team: "core", count: 2, extra: true },
  ]) {
    expect(isValidMcpFormContent(schema, content)).toBe(false);
  }
});

test("unsupported arrays, objects, unions and unknown constraints are refused", () => {
  for (const field of [
    { type: "array", items: { type: "string" } },
    { type: "object" },
    { anyOf: [{ type: "string" }, { type: "number" }] },
    { type: "string", pattern: "a+" },
    { type: "number", enum: [1, 2] },
  ]) {
    expect(isSupportedMcpForm({ type: "object", properties: { value: field } })).toBe(false);
  }
});
