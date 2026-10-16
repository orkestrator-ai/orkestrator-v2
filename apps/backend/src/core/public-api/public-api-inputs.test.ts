import { describe, expect, test } from "bun:test";
import { PUBLIC_ACTION_NAMES, type PublicActionName } from "@orkestrator/protocol/public-api";
import {
  PUBLIC_ACTION_INPUTS,
  type PublicJsonSchema,
} from "@orkestrator/protocol/public-api-inputs";
import type { PublicSettingsSnapshot } from "@orkestrator/protocol/public-api-resources";
import { createProject } from "../storage.js";
import { createPublicApiHarness } from "./test-support.js";
import { PublicActionError } from "./errors.js";
import { buildPublicHandlerTable } from "./registry.js";

/**
 * Conformance between the protocol's input schemas (`PUBLIC_ACTION_INPUTS`)
 * and the handlers' own validation: both describe the same keys, required
 * fields, nested value constraints and collection bounds. Every published
 * example parses, and stored settings round-trip through the patch schemas.
 */

/** A minimal validator for the portable subset, including nested constraints. */
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

const handlers = buildPublicHandlerTable();

function parse(action: PublicActionName, input: Record<string, unknown>): unknown {
  return handlers.get(action)!.parse(input);
}

function parseError(action: PublicActionName, input: Record<string, unknown>): Error | null {
  try {
    parse(action, input);
    return null;
  } catch (error) {
    return error as Error;
  }
}

const UNKNOWN_FIELD = /^Unknown input field/;
const OUT_OF_ENUM = /must be one of|is not a public action/;

/** The first example that sets `key`, or the first example. */
function exampleWith(action: PublicActionName, key: string): Record<string, unknown> {
  const examples = PUBLIC_ACTION_INPUTS[action].examples;
  return { ...(examples.find((example) => key in example) ?? examples[0]) };
}

describe("public action handlers conform to their input schemas", () => {
  test("every catalogue action has a handler", () => {
    expect([...handlers.keys()].sort()).toEqual([...PUBLIC_ACTION_NAMES].sort());
  });

  test.each([...PUBLIC_ACTION_NAMES])("%s: examples parse", (action) => {
    for (const example of PUBLIC_ACTION_INPUTS[action].examples) {
      expect({
        example,
        error: parseError(action, { ...example })?.message ?? null,
      }).toEqual({
        example,
        error: null,
      });
    }
  });

  test.each([...PUBLIC_ACTION_NAMES])("%s: accepts exactly the schema's keys", (action) => {
    const error = parseError(action, {
      ...exampleWith(action, ""),
      unexpectedField: 1,
    });
    expect(error).toBeInstanceOf(PublicActionError);
    expect((error as PublicActionError).code).toBe("invalid-input");
    expect(error!.message).toMatch(UNKNOWN_FIELD);
    for (const key of Object.keys(PUBLIC_ACTION_INPUTS[action].input.properties)) {
      const input = exampleWith(action, key);
      if (!(key in input)) input[key] = "x";
      expect({
        key,
        message: parseError(action, input)?.message ?? "",
      }).not.toEqual({
        key,
        message: expect.stringMatching(UNKNOWN_FIELD),
      });
    }
  });

  test.each([...PUBLIC_ACTION_NAMES])("%s: refuses a missing required field", (action) => {
    for (const key of PUBLIC_ACTION_INPUTS[action].input.required) {
      const input = exampleWith(action, key);
      delete input[key];
      const error = parseError(action, input);
      expect({ key, refused: error instanceof PublicActionError }).toEqual({
        key,
        refused: true,
      });
    }
  });

  test.each([...PUBLIC_ACTION_NAMES])("%s: enumerations match the handler", (action) => {
    for (const [key, property] of Object.entries(PUBLIC_ACTION_INPUTS[action].input.properties)) {
      if (!property.enum) continue;
      const outside = exampleWith(action, key);
      outside[key] = "not-a-listed-value";
      expect({
        key,
        refused: parseError(action, outside) instanceof PublicActionError,
      }).toEqual({
        key,
        refused: true,
      });
      for (const value of property.enum) {
        const input = { ...exampleWith(action, key), [key]: value };
        expect({
          key,
          value,
          message: parseError(action, input)?.message ?? "",
        }).not.toEqual({
          key,
          value,
          message: expect.stringMatching(OUT_OF_ENUM),
        });
      }
    }
  });

  test("nested objects accept exactly their schema's keys", () => {
    expect(
      parseError("project.update", {
        projectId: "project-1",
        set: { colour: "red" },
      })?.message,
    ).toMatch(UNKNOWN_FIELD);
    expect(
      parseError("session.interaction.resolve", {
        ...PUBLIC_ACTION_INPUTS["session.interaction.resolve"].examples[0],
        action: "answer",
        answers: [{ questionId: "q", extra: true }],
      })?.message,
    ).toMatch(UNKNOWN_FIELD);
    expect(
      parseError("project.config.set", {
        projectId: "project-1",
        set: { colour: "red" },
      })?.message,
    ).toMatch(/Unknown project setting/);
  });
});

const settingsCases = [
  ["project.config.set", "projectId", "defaultPortMappings"],
  ["environment.config.set", "environmentId", "portMappings"],
] as const;

function expectConformance(
  action: PublicActionName,
  input: Record<string, unknown>,
  accepted: boolean,
): void {
  const issues = violations(PUBLIC_ACTION_INPUTS[action].input, input, "input");
  if (accepted) expect(issues).toEqual([]);
  else expect(issues.length).toBeGreaterThan(0);
  const error = parseError(action, input);
  if (accepted) expect(error).toBeNull();
  else expect(error).toBeInstanceOf(PublicActionError);
}

describe("nested setting schema and handler constraints", () => {
  for (const [action, targetKey, settingKey] of settingsCases) {
    test(`${action}: explicit and automatic port mappings`, () => {
      for (const protocol of ["tcp", "udp"]) {
        for (const ports of [
          { containerPort: 1, hostPort: 1 },
          { containerPort: 65_535, hostPort: 65_535 },
          { containerPort: 3000, hostPort: 0, hostPortMode: "auto" },
        ]) {
          expectConformance(
            action,
            {
              [targetKey]: "target-1",
              set: { [settingKey]: [{ ...ports, protocol }] },
            },
            true,
          );
        }
      }
      for (const mapping of [
        { containerPort: 3000, hostPort: 3000 },
        { containerPort: 3000, hostPort: 0, hostPortMode: "auto" },
        { hostPort: 3000, protocol: "tcp" },
        { containerPort: 3000, protocol: "tcp" },
        { containerPort: 3000, hostPort: 3000, protocol: "sctp" },
        { containerPort: 0, hostPort: 3000, protocol: "tcp" },
        { containerPort: 65_536, hostPort: 3000, protocol: "tcp" },
        { containerPort: 3000, hostPort: -1, protocol: "tcp" },
        { containerPort: 3000, hostPort: 65_536, protocol: "tcp" },
        { containerPort: 3000, hostPort: 1.5, protocol: "tcp" },
        { containerPort: 3000, hostPort: 0, hostPortMode: "manual", protocol: "tcp" },
      ]) {
        expectConformance(
          action,
          {
            [targetKey]: "target-1",
            set: { [settingKey]: [mapping] },
          },
          false,
        );
      }
    });

    test(`${action}: cross-field port rules remain handler-validated`, () => {
      const mappingSchema =
        PUBLIC_ACTION_INPUTS[action].input.properties.set!.properties![settingKey]!.items!;
      expect(mappingSchema.properties!.hostPort!.description).toContain(
        'only with hostPortMode "auto"',
      );
      expect(mappingSchema.properties!.hostPortMode!.description).toContain("requires hostPort 0");
      // The portable schema subset cannot express these cross-field rules.
      for (const ports of [{ hostPort: 0 }, { hostPort: 3000, hostPortMode: "auto" }]) {
        const input = {
          [targetKey]: "target-1",
          set: { [settingKey]: [{ containerPort: 3000, protocol: "tcp", ...ports }] },
        };
        expect(violations(PUBLIC_ACTION_INPUTS[action].input, input, "input")).toEqual([]);
        expect(parseError(action, input)).toBeInstanceOf(PublicActionError);
      }
    });

    test(`${action}: port mapping collection bounds`, () => {
      for (const count of [0, 64, 65]) {
        expectConformance(
          action,
          {
            [targetKey]: "target-1",
            set: {
              [settingKey]: Array.from({ length: count }, (_, index) => ({
                containerPort: 3000 + index,
                hostPort: 4000 + index,
                protocol: "tcp",
              })),
            },
          },
          count <= 64,
        );
      }
    });
  }

  test("domain lists allow 512 entries while string lists allow 256", () => {
    for (const count of [0, 256, 257, 512, 513]) {
      expectConformance(
        "environment.config.set",
        {
          environmentId: "env-1",
          set: {
            allowedDomains: Array.from({ length: count }, (_, index) => `host${index}.example.com`),
          },
        },
        count <= 512,
      );
      expectConformance(
        "project.config.set",
        {
          projectId: "project-1",
          set: { filesToCopy: Array.from({ length: count }, (_, index) => `file${index}.txt`) },
        },
        count <= 256,
      );
    }
  });

  test("environment.exec: empty stdinBase64 is rejected; omitted or encoded stdin parses", () => {
    for (const stdin of [{}, { stdinBase64: "" }, { stdinBase64: "YQ==" }]) {
      expectConformance(
        "environment.exec",
        {
          environmentId: "env-1",
          argv: ["cat"],
          ...stdin,
        },
        stdin.stdinBase64 !== "",
      );
    }
  });

  test("project and environment settings snapshots round-trip through patch schemas", async () => {
    const h = await createPublicApiHarness();
    try {
      const project = await h.storage.addProject(
        createProject("https://example.invalid/settings.git"),
      );
      const mappings = [
        {
          containerPort: 3000,
          hostPort: 0,
          hostPortMode: "auto" as const,
          protocol: "tcp" as const,
        },
        { containerPort: 5353, hostPort: 5353, protocol: "udp" as const },
      ];
      await h.storage.updateRepositorySettings(project.id, {
        ...(await h.storage.getRepositoryConfig(project.id)),
        defaultPortMappings: mappings,
      });
      await h.storage.addEnvironment({
        id: "env-settings",
        projectId: project.id,
        name: "settings",
        branch: "main",
        containerId: null,
        status: "stopped",
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: new Date(0).toISOString(),
        networkAccessMode: "restricted",
        order: 0,
        environmentType: "containerized",
        portMappings: mappings,
        allowedDomains: Array.from({ length: 512 }, (_, index) => `host${index}.example.com`),
      });
      for (const [action, targetKey, mappingKey] of settingsCases) {
        const readAction =
          action === "project.config.set" ? "project.config.get" : "environment.config.get";
        const target = { [targetKey]: targetKey === "projectId" ? project.id : "env-settings" };
        const before = await h.call<PublicSettingsSnapshot>(readAction, target);
        if (!before.ok) throw new Error(before.error.message);
        expect(before.result.settings.find((setting) => setting.key === mappingKey)?.value).toEqual(
          mappings,
        );
        const set = Object.fromEntries(
          before.result.settings
            .filter((setting) => setting.value !== null)
            .map((setting) => [setting.key, setting.value]),
        );
        const input = { ...target, set, expectedRevision: before.result.revision };
        expectConformance(action, input, true);
        const written = await h.call(action, input, {
          requestId: `roundtrip-${action}`,
        });
        if (!written.ok) throw new Error(written.error.message);
        const after = await h.call<PublicSettingsSnapshot>(readAction, target);
        if (!after.ok) throw new Error(after.error.message);
        expect(after.result.settings).toEqual(before.result.settings);
      }
    } finally {
      await h.cleanup();
    }
  });
});
