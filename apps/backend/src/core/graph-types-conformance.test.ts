import { describe, expect, test } from "bun:test";
import { graphBuiltInTypes } from "@orkestrator/protocol/graphs/types";
import { validateWorkflowResult, workflowResultJsonSchema } from "./workflow-result-contracts.js";

/**
 * Built-in graph types that map a workflow result kind must stay that kind's
 * contract: the same schema, and an example the backend accepts in full
 * (domain parsers and placeholder checks included). A change to either side
 * fails here until the other matches.
 */
describe("graph built-in types and workflow result kinds", () => {
  const mapped = graphBuiltInTypes().filter((definition) => definition.resultKind);

  test("cover the result kinds a graph port can carry", () => {
    expect(mapped.map((definition) => [definition.ref, definition.resultKind])).toEqual([
      ["validation-plan@1", "validation-plan"],
      ["review-report@1", "review-report"],
      ["verification-verdict@1", "verification-result"],
      ["fix-result@1", "fix-result"],
      ["pr-result@1", "pr-result"],
    ]);
  });

  for (const definition of mapped) {
    test(`${definition.ref} is the ${definition.resultKind} contract`, () => {
      expect(definition.schema).toEqual(workflowResultJsonSchema(definition.resultKind!));
      expect(validateWorkflowResult(definition.resultKind!, definition.example)).toEqual([]);
    });
  }
});
