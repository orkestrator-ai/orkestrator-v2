import { describe, expect, test } from "bun:test";
import { graphBuiltInTypes } from "@orkestrator/protocol/graphs/types";
import { GRAPH_ADDRESS_FINDINGS_RESULT_V2_SCHEMA } from "@orkestrator/protocol/review-results";
import { validateWorkflowResult, workflowResultJsonSchema } from "./workflows/result-contracts.js";

/**
 * Built-in graph types that map a workflow result kind must stay that kind's
 * contract and supply an example the backend accepts in full, including domain
 * parsers and placeholder checks.
 */
describe("graph built-in types and workflow result kinds", () => {
  const mapped = graphBuiltInTypes().filter((definition) => definition.resultKind);

  test("cover the result kinds a graph port can carry", () => {
    expect(mapped.map((definition) => [definition.ref, definition.resultKind])).toEqual([
      ["validation-plan@2", "validation-plan"],
      ["review-report@1", "review-report"],
      ["verification-verdict@1", "verification-result"],
      ["address-findings-result@1", "address-findings-result"],
      ["address-findings-result@2", "address-findings-result"],
      ["pr-result@1", "pr-result"],
    ]);
  });

  for (const definition of mapped) {
    test(`${definition.ref} is the ${definition.resultKind} contract`, () => {
      const multiReview = definition.ref === "address-findings-result@2";
      expect(definition.schema).toEqual(
        multiReview
          ? GRAPH_ADDRESS_FINDINGS_RESULT_V2_SCHEMA
          : workflowResultJsonSchema(definition.resultKind!),
      );
      expect(
        validateWorkflowResult(
          definition.resultKind!,
          definition.example,
          undefined,
          multiReview ? { type: "multi-review-address-findings" } : undefined,
        ),
      ).toEqual([]);
    });
  }
});
