import { describe, expect, test } from "bun:test";
import { PUBLIC_ACTION_NAMES, type PublicActionName } from "@orkestrator/protocol/public-api";
import { PUBLIC_ACTION_INPUTS } from "@orkestrator/protocol/public-api-inputs";
import { PublicActionError } from "./errors.js";
import { buildPublicHandlerTable } from "./registry.js";

/**
 * Conformance between the protocol's input schemas (`PUBLIC_ACTION_INPUTS`)
 * and the handlers' own validation: both describe the same keys, required
 * fields and enumerations, and every published example parses.
 */

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
