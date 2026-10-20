import { describe, expect, test } from "bun:test";
import { PUBLIC_ACTION_NAMES, PUBLIC_ACTIONS, type PublicActionName } from "./public-api.js";
import {
  PUBLIC_ACTION_INPUTS,
  PUBLIC_CAPABILITIES,
  publicActionInputKeys,
  publicActionsForCapability,
  type PublicJsonSchema,
} from "./public-api-inputs.js";

const PORTABLE_KEYWORDS = new Set([
  "type",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
]);

/** Keywords outside the portable subset, by path. */
function nonPortable(schema: PublicJsonSchema, path: string): string[] {
  const issues: string[] = [];
  for (const key of Object.keys(schema)) {
    if (!PORTABLE_KEYWORDS.has(key)) issues.push(`${path}.${key}`);
  }
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    issues.push(...nonPortable(child, `${path}.properties.${name}`));
  }
  if (schema.items) issues.push(...nonPortable(schema.items, `${path}.items`));
  if (typeof schema.additionalProperties === "object") {
    issues.push(...nonPortable(schema.additionalProperties, `${path}.additionalProperties`));
  }
  return issues;
}

/** A minimal validator for the portable subset, enough to check the examples. */
function violations(schema: PublicJsonSchema, value: unknown, path: string): string[] {
  const issues: string[] = [];
  const kind = Array.isArray(value)
    ? "array"
    : Number.isInteger(value)
      ? "integer"
      : value === null
        ? "null"
        : typeof value;
  if (schema.type && schema.type !== kind && !(schema.type === "number" && kind === "integer")) {
    return [`${path}: expected ${schema.type}, got ${kind}`];
  }
  if (schema.enum && !schema.enum.includes(value as string)) issues.push(`${path}: not in enum`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      issues.push(`${path}: short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      issues.push(`${path}: long`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      issues.push(`${path}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum)
      issues.push(`${path}: above maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      issues.push(`${path}: few`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      issues.push(`${path}: many`);
    value.forEach((entry, index) => {
      if (schema.items) issues.push(...violations(schema.items, entry, `${path}[${index}]`));
    });
  }
  if (kind === "object") {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(record, key)) issues.push(`${path}.${key}: required`);
    }
    for (const [key, entry] of Object.entries(record)) {
      const child = schema.properties?.[key];
      if (child) issues.push(...violations(child, entry, `${path}.${key}`));
      else if (schema.additionalProperties === false) issues.push(`${path}.${key}: not allowed`);
      else if (typeof schema.additionalProperties === "object") {
        issues.push(...violations(schema.additionalProperties, entry, `${path}.${key}`));
      }
    }
  }
  return issues;
}

const entries = Object.entries(PUBLIC_ACTION_INPUTS) as [
  PublicActionName,
  (typeof PUBLIC_ACTION_INPUTS)[PublicActionName],
][];

describe("public action input contract", () => {
  test("covers exactly the public action catalogue", () => {
    expect(Object.keys(PUBLIC_ACTION_INPUTS).sort()).toEqual([...PUBLIC_ACTION_NAMES].sort());
  });

  test("every schema is a closed object whose required fields exist", () => {
    for (const [action, contract] of entries) {
      expect({ action, type: contract.input.type }).toEqual({
        action,
        type: "object",
      });
      expect({ action, closed: contract.input.additionalProperties }).toEqual({
        action,
        closed: false,
      });
      for (const key of contract.input.required) {
        expect({
          action,
          key,
          declared: key in contract.input.properties,
        }).toEqual({
          action,
          key,
          declared: true,
        });
      }
    }
  });

  test("schemas use only the portable JSON Schema subset", () => {
    expect(entries.flatMap(([action, contract]) => nonPortable(contract.input, action))).toEqual(
      [],
    );
  });

  test("request keys travel beside the input, never inside it", () => {
    for (const [action] of entries) {
      expect({
        action,
        keys: publicActionInputKeys(action).includes("requestId"),
      }).toEqual({
        action,
        // run.get looks an operation up by its requestId; it is a read.
        keys: action === "run.get",
      });
    }
  });

  test("every example satisfies its schema", () => {
    for (const [action, contract] of entries) {
      expect(contract.examples.length).toBeGreaterThan(0);
      for (const example of contract.examples) {
        expect({
          action,
          issues: violations(contract.input, example, "input"),
        }).toEqual({
          action,
          issues: [],
        });
      }
    }
  });

  test("every capability with actions groups reads and mutations deliberately", () => {
    for (const capability of PUBLIC_CAPABILITIES) {
      const actions = publicActionsForCapability(capability);
      if (capability === "tickets" || capability === "mail") expect(actions).toEqual([]);
      else
        expect({ capability, count: actions.length > 0 }).toEqual({
          capability,
          count: true,
        });
    }
    // Destructive and exec capabilities grant no reads a read-only credential needs.
    for (const capability of ["environments.destructive", "exec"] as const) {
      for (const action of publicActionsForCapability(capability)) {
        expect({ action, mutation: PUBLIC_ACTIONS[action].mutation }).toEqual({
          action,
          mutation: true,
        });
      }
    }
  });

  test("change-tracking actions are immediate reads granted by read capabilities", () => {
    expect(PUBLIC_ACTIONS["changes.view"]).toMatchObject({
      version: 1,
      mutation: false,
      effects: [],
      observation: "immediate",
    });
    expect(PUBLIC_ACTIONS["changes.history"]).toMatchObject({
      version: 1,
      mutation: false,
      effects: [],
      observation: "immediate",
    });
    expect(PUBLIC_ACTION_INPUTS["changes.view"].capability).toBe("discovery");
    expect(PUBLIC_ACTION_INPUTS["changes.view"].input.required).toEqual(["environmentId"]);
    expect(PUBLIC_ACTION_INPUTS["changes.view"].input.properties.scope?.enum).toEqual([
      "environment",
    ]);
    expect(PUBLIC_ACTION_INPUTS["changes.history"].capability).toBe("sessions.read");
    expect(PUBLIC_ACTION_INPUTS["changes.history"].input.required).toEqual(["sessionId"]);
  });

  test("confirmation classes match the agreed risk table", () => {
    const confirmed = Object.fromEntries(
      entries
        .filter(([, contract]) => contract.confirmation !== "never")
        .map(([action, contract]) => [
          action,
          `${contract.confirmation}${contract.confirmWhen ? `:${contract.confirmWhen}` : ""}`,
        ]),
    );
    expect(confirmed).toEqual({
      "project.create": "always",
      "project.remove": "always",
      "environment.stop": "voice",
      "environment.recreate": "always:discard",
      "environment.delete": "always",
      "environment.exec": "voice",
      "session.interaction.resolve": "voice:approval",
      "run.discard": "always",
      "host.update.apply": "always",
      "host.gh.update": "always",
    });
    // Reads never need confirmation.
    for (const [action, contract] of entries) {
      if (!PUBLIC_ACTIONS[action].mutation) expect(contract.confirmation).toBe("never");
    }
  });
});
