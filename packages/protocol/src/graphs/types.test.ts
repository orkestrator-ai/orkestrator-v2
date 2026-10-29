import { describe, expect, test } from "bun:test";
import { VERIFICATION_VERDICT_SCHEMA, type TaskSnapshot } from "../build-pipeline";
import { REVIEW_FIX_RESULT_JSON_SCHEMA, REVIEW_PR_RESULT_JSON_SCHEMA } from "../review-results";
import { REVIEW_VALIDATION_PLAN_SCHEMA } from "../review-workflow";
import { STRUCTURED_REVIEW_REPORT_JSON_SCHEMA } from "../structured-review";
import { graphTemplateExamples } from "./examples";
import { graphSchemaAtPath, validateGraphSchemaSubset } from "./schema-subset";
import {
  GRAPH_BUILT_IN_TYPE_NAMES,
  GRAPH_BUILT_IN_VALIDATOR_IDS,
  GRAPH_TYPE_FAMILIES,
  GraphTypeLibrary,
  graphBudgetIssues,
  graphBuiltInType,
  graphBuiltInTypes,
  graphBuiltInValidator,
  graphBuiltInValidators,
  graphCheckSummaryState,
  graphDecisionSchema,
  graphTicketFromTaskSnapshot,
  graphTypeFamily,
  graphValueTypeLabel,
  validateGraphArtifactValue,
  type GraphTypeDefinition,
} from "./types";

// Tests edit payloads freely, including into shapes the types forbid.
// oxlint-disable-next-line typescript/no-explicit-any
type Draft = any;

function builtIn(ref: string): GraphTypeDefinition {
  const definition = graphBuiltInType(ref);
  if (!definition) throw new Error(`no built-in ${ref}`);
  return definition;
}

function example(ref: string): Draft {
  return structuredClone(builtIn(ref).example);
}

function codes(ref: string, value: unknown, context = {}): string[] {
  return validateGraphArtifactValue(builtIn(ref), value, context).map((issue) => issue.code);
}

describe("built-in type library", () => {
  test("has exactly the plan's types, each once", () => {
    const names = graphBuiltInTypes().map((definition) => definition.name);
    expect(names).toEqual([...GRAPH_BUILT_IN_TYPE_NAMES]);
    expect(new Set(graphBuiltInTypes().map((definition) => definition.ref)).size).toBe(
      names.length,
    );
  });

  for (const definition of graphBuiltInTypes()) {
    describe(definition.ref, () => {
      test("its schema is inside the portable subset", () => {
        const result = validateGraphSchemaSubset(definition.schema);
        expect(result.ok ? [] : result.errors).toEqual([]);
      });

      test("its example validates, domain checks included", () => {
        expect(validateGraphArtifactValue(definition, definition.example)).toEqual([]);
      });

      test("its declarations name fields the schema has", () => {
        if (definition.items) {
          const list = graphSchemaAtPath(definition.schema, definition.items.path);
          expect(list?.schema.type).toBe("array");
        }
        for (const path of [
          ...(definition.sharedFields ?? []),
          ...(definition.render?.summary ?? []),
        ]) {
          expect(graphSchemaAtPath(definition.schema, path)).not.toBeNull();
        }
        for (const source of definition.sources) {
          // `issues[].reviewSourceIds` → the array element's property.
          const [list, property] = source.path.split("[].");
          const field = property
            ? graphSchemaAtPath(
                graphSchemaAtPath(definition.schema, list!)!.schema.items as Draft,
                property,
              )
            : graphSchemaAtPath(definition.schema, source.path);
          expect(field?.schema.type).toBe("array");
        }
        expect(GRAPH_TYPE_FAMILIES).toContain(definition.family);
        expect(Object.isFrozen(definition.schema)).toBe(true);
      });

      test("its budgets admit its example and stay within the storage cap", () => {
        expect(
          graphBudgetIssues(definition.budgets, definition.example, definition.storage),
        ).toEqual([]);
        if (definition.budgets.maxStringBytes !== undefined) {
          expect(definition.budgets.maxStringBytes).toBeLessThanOrEqual(
            definition.budgets.maxBytes,
          );
        }
      });
    });
  }

  test("built-in schemas are today's contracts", () => {
    expect(builtIn("review-report@1").schema).toEqual(
      STRUCTURED_REVIEW_REPORT_JSON_SCHEMA as unknown as Record<string, unknown>,
    );
    expect(builtIn("finding@1").schema).toEqual(
      (STRUCTURED_REVIEW_REPORT_JSON_SCHEMA.properties.issues as Draft).items,
    );
    expect(builtIn("verification-verdict@1").schema).toEqual(VERIFICATION_VERDICT_SCHEMA);
    expect(builtIn("validation-plan@1").schema).toEqual(REVIEW_VALIDATION_PLAN_SCHEMA);
    expect(builtIn("fix-result@1").schema).toEqual(REVIEW_FIX_RESULT_JSON_SCHEMA);
    expect(builtIn("pr-result@1").schema).toEqual(REVIEW_PR_RESULT_JSON_SCHEMA);
  });

  test("freezing the library does not freeze the shared schemas", () => {
    expect(Object.isFrozen(STRUCTURED_REVIEW_REPORT_JSON_SCHEMA)).toBe(false);
    expect(Object.isFrozen(REVIEW_FIX_RESULT_JSON_SCHEMA)).toBe(false);
  });

  test("every validator id is used and every type names a known validator", () => {
    const used = graphBuiltInTypes().flatMap((definition) =>
      definition.validator ? [definition.validator] : [],
    );
    expect(new Set(used)).toEqual(new Set(GRAPH_BUILT_IN_VALIDATOR_IDS));
    expect(graphBuiltInValidators().map((validator) => validator.id)).toEqual([
      ...GRAPH_BUILT_IN_VALIDATOR_IDS,
    ]);
    // Text, Markdown and routed errors have budgets and a schema only.
    for (const ref of ["text@1", "markdown@1", "error@1"]) {
      expect(builtIn(ref).validator).toBeUndefined();
    }
  });

  test("items, item types and provenance match the review contracts", () => {
    const report = builtIn("review-report@1");
    expect(report.items).toEqual({ path: "issues", idPrefix: "issue" });
    expect(report.itemType).toBe("finding@1");
    expect(report.sources.map((field) => field.path)).toEqual([
      "issues[].reviewSourceIds",
      "testCoverageGaps[].reviewSourceIds",
    ]);
    expect(report.sources[0]!.segments).toEqual(["issues", "[]", "reviewSourceIds"]);
    expect(report.resultKind).toBe("review-report");
    expect(report.formatter).toBe("structured-review-report");
    expect(builtIn("verification-verdict@1").resultKind).toBe("verification-result");
    expect(builtIn("review-package@2").storage).toBe("reference");
  });
});

describe("domain validators", () => {
  test("ticket ids are unique and bounded", () => {
    const ticket = example("ticket@1");
    ticket.criteria[1].id = ticket.criteria[0].id;
    expect(codes("ticket@1", ticket)).toEqual(["duplicate"]);
    ticket.criteria[1].id = "x".repeat(65);
    expect(codes("ticket@1", ticket)).toEqual(["invalid_value"]);
    ticket.criteria = [];
    ticket.title = " ";
    expect(codes("ticket@1", ticket)).toEqual(["empty"]);
  });

  test("workspaces carry full SHAs and a valid branch", () => {
    expect(codes("workspace@1", { ...example("workspace@1"), headRef: "abc123" })).toEqual([
      "invalid_value",
    ]);
    expect(codes("workspace@1", { ...example("workspace@1"), branch: "-x" })).toEqual([
      "invalid_value",
    ]);
    expect(codes("workspace@1", { ...example("workspace@1"), baseRef: null })).toEqual([]);
  });

  test("validation plans use parseReviewValidationPlan", () => {
    const plan = example("validation-plan@1");
    plan.commands[1].dependsOn = ["missing"];
    expect(codes("validation-plan@1", plan)).toEqual(["invalid_value"]);
  });

  test("review package references must point at their sealed file", () => {
    expect(
      codes("review-package@2", { ...example("review-package@2"), filePath: "elsewhere.json" }),
    ).toEqual(["invalid_value"]);
  });

  test("review reports use the structured review contract and budgets", () => {
    const report = example("review-report@1");
    report.testResults.total = 99;
    expect(codes("review-report@1", report).length).toBeGreaterThan(0);
    const long = example("review-report@1");
    long.issues[0].title = "x".repeat(2000);
    expect(codes("review-report@1", long)).not.toEqual([]);
  });

  test("findings use the report contract, with paths from the finding", () => {
    const issues = validateGraphArtifactValue(builtIn("finding@1"), {
      ...example("finding@1"),
      reviewSourceIds: [""],
    });
    expect(issues.map((issue) => issue.path)).toEqual(["$.reviewSourceIds[0]"]);
    const long = { ...example("finding@1"), description: "x".repeat(20_000) };
    expect(codes("finding@1", long)).toEqual(["too_large"]);
  });

  test("verdicts report known criteria once", () => {
    const verdict = example("verification-verdict@1");
    expect(codes("verification-verdict@1", verdict, { criterionIds: ["ac-1", "ac-2"] })).toEqual(
      [],
    );
    expect(codes("verification-verdict@1", verdict, { criterionIds: ["ac-1"] })).toEqual([
      "invalid_value",
    ]);
    verdict.acceptanceCriteria[1].id = "ac-1";
    expect(codes("verification-verdict@1", verdict)).toEqual(["duplicate"]);
    // The old two-field shape is readable history, not a new artifact.
    expect(codes("verification-verdict@1", { complete: true, rationale: "ok" })).toEqual([
      "missing_field",
    ]);
  });

  test("fix results are consistent", () => {
    expect(codes("fix-result@1", { ...example("fix-result@1"), limitations: ["CI down"] })).toEqual(
      ["invalid_value"],
    );
  });

  test("PR results are github.com pull requests", () => {
    expect(
      codes("pr-result@1", { ...example("pr-result@1"), url: "https://example.com/pull/1" }),
    ).toEqual(["invalid_value"]);
  });

  test("PR descriptions have a one-line title and a body", () => {
    expect(codes("pr-description@1", { title: "a\nb", body: "x" })).toEqual(["invalid_value"]);
    expect(codes("pr-description@1", { title: "x".repeat(257), body: "x" })).toEqual(["too_long"]);
    expect(codes("pr-description@1", { title: "t", body: " " })).toEqual(["empty"]);
  });

  test("check summaries agree with their counts", () => {
    const summary = example("check-summary@1");
    expect(codes("check-summary@1", { ...summary, state: "passed" })).toEqual(["invalid_value"]);
    expect(codes("check-summary@1", { ...summary, failing: [], state: "passed" })).toEqual([]);
    expect(codes("check-summary@1", { ...summary, failing: [], state: "none" })).toEqual([
      "invalid_value",
    ]);
    expect(codes("check-summary@1", { ...summary, failing: [], state: "none", total: 0 })).toEqual(
      [],
    );
    expect(codes("check-summary@1", { ...summary, total: 0 })).toEqual(["invalid_value"]);
  });

  test("decisions choose one of the port's choices", () => {
    const decision = example("decision@1");
    const choices = ["simplicity", "performance"];
    expect(codes("decision@1", decision, { choices })).toEqual([]);
    expect(codes("decision@1", { ...decision, choice: "speed" }, { choices })).toEqual([
      "invalid_enum",
    ]);
    // Without choices the node supplies none; any non-empty choice passes.
    expect(codes("decision@1", { ...decision, choice: "speed" })).toEqual([]);
    expect(graphDecisionSchema(choices).properties).toMatchObject({
      choice: { type: "string", enum: choices },
    });
  });

  test("file lists hold unique relative paths", () => {
    for (const path of ["/etc/passwd", "../x", "a/./b", "a\\b", "a//b", ""]) {
      expect(codes("file-list@1", { files: [{ path, reason: "r" }] })).toEqual(["invalid_value"]);
    }
    expect(
      codes("file-list@1", {
        files: [
          { path: "a", reason: "r" },
          { path: "a", reason: "r" },
        ],
      }),
    ).toEqual(["duplicate"]);
  });

  test("validators name what they wrap and what the backend adds", () => {
    expect(graphBuiltInValidator("review-package-reference").backend?.existing).toContain(
      "verifyEnvironmentReviewPackage",
    );
    expect(graphBuiltInValidator("fix-result").wraps).toBe("review-results.ts#parseFixResult");
    expect(graphBuiltInValidator("workspace-commit").backend?.existing).toBeUndefined();
  });
});

describe("budgets", () => {
  test("bytes, strings and items are bounded, without quoting content", () => {
    const issues = graphBudgetIssues(
      { maxBytes: 64, maxStringBytes: 4, maxItems: 1 },
      {
        a: "secret",
        b: [1, 2],
      },
    );
    expect(issues.map((issue) => [issue.path, issue.code])).toEqual([
      ["$.a", "too_large"],
      ["$.b", "too_many_items"],
    ]);
    expect(JSON.stringify(issues)).not.toContain("secret");
    expect(graphBudgetIssues({ maxBytes: 4 }, { a: 1 })[0]!.code).toBe("too_large");
  });

  test("schema checks run only within budget", () => {
    const text = builtIn("text@1");
    const big = { text: "x".repeat(text.budgets.maxBytes) };
    expect(validateGraphArtifactValue(text, big).map((issue) => issue.code)).toEqual(["too_large"]);
    expect(validateGraphArtifactValue(text, { text: 1 })[0]!.code).toBe("invalid_type");
  });
});

describe("type library", () => {
  const brief = graphTemplateExamples().find((entry) => entry.key === "design-bake-off")!.template
    .types!;

  test("resolves built-in, custom and list references", () => {
    const library = new GraphTypeLibrary(brief);
    const report = library.resolve("review-report@1");
    expect(report.ok && graphValueTypeLabel(report.type)).toBe("review-report@1");
    const briefs = library.resolve("list<design-brief@1>");
    expect(briefs.ok && graphValueTypeLabel(briefs.type)).toBe("list<design-brief@1>");
    expect(briefs.ok && briefs.type.kind === "list" && briefs.type.element.kind).toBe("named");
    expect(library.definitions().length).toBe(GRAPH_BUILT_IN_TYPE_NAMES.length + 1);
  });

  test("reports unknown types, versions and malformed refs", () => {
    const library = new GraphTypeLibrary();
    expect(library.resolve("design-brief@1")).toMatchObject({ ok: false, code: "unknown_type" });
    expect(library.resolve("review-package@1")).toMatchObject({
      ok: false,
      code: "unknown_version",
    });
    expect(library.resolve("Review@1")).toMatchObject({ ok: false, code: "type_ref" });
  });

  test("custom types cannot shadow built-ins or repeat", () => {
    const shadow = { ...brief[0]!, name: "finding" };
    const library = new GraphTypeLibrary([shadow, brief[0]!, brief[0]!]);
    expect(library.conflicts).toEqual(["finding@1", "design-brief@1"]);
    expect(library.definition("finding", 1)?.builtIn).toBe(true);
  });

  test("custom types record their provenance fields", () => {
    const library = new GraphTypeLibrary([
      {
        name: "summary",
        version: 1,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["text", "sources"],
          properties: {
            text: { type: "string" },
            sources: { type: "array", items: { type: "string" }, "x-orkestrator-sources": true },
          },
        },
        storage: "value",
        budgets: { maxBytes: 1024 },
      },
    ]);
    expect(library.definition("summary", 1)?.sources.map((field) => field.path)).toEqual([
      "sources",
    ]);
  });

  test("type families colour ports", () => {
    const library = new GraphTypeLibrary(brief);
    expect(graphTypeFamily("text@1")).toBe("text");
    expect(graphTypeFamily("pr-description@1")).toBe("text");
    expect(graphTypeFamily("ticket@1")).toBe("ticket");
    expect(graphTypeFamily("review-report@1")).toBe("report");
    expect(graphTypeFamily("workspace@1")).toBe("workspace");
    expect(graphTypeFamily("decision@1")).toBe("decision");
    expect(graphTypeFamily("review-package@2")).toBe("package");
    expect(graphTypeFamily("error@1")).toBe("error");
    expect(graphTypeFamily("list<finding@1>")).toBe("list");
    expect(graphTypeFamily("design-brief@1")).toBe("unknown");
    expect(graphTypeFamily("design-brief@1", library)).toBe("report");
    expect(graphTypeFamily("not a ref")).toBe("unknown");
  });
});

describe("helpers", () => {
  test("a task snapshot becomes a ticket with the snapshot's criterion ids", () => {
    const snapshot: TaskSnapshot = {
      title: "Export",
      description: "Add CSV export.",
      acceptanceCriteria: "",
      comments: [{ text: "Soon" }],
      images: [{ filename: "a.png", data: "AAAA" }],
      kind: "feature",
      acceptanceCriteriaItems: [{ id: "ac-7", text: "Has a button" }],
    };
    const ticket = graphTicketFromTaskSnapshot(snapshot);
    expect(ticket).toEqual({
      title: "Export",
      kind: "feature",
      description: "Add CSV export.",
      criteria: [{ id: "ac-7", text: "Has a button" }],
      comments: [{ text: "Soon" }],
    });
    expect(validateGraphArtifactValue(builtIn("ticket@1"), ticket)).toEqual([]);
    expect(
      graphTicketFromTaskSnapshot({
        ...snapshot,
        kind: undefined,
        acceptanceCriteriaItems: undefined,
      }).kind,
    ).toBeNull();
  });

  test("the PR monitor's rolled-up state maps onto check summaries", () => {
    expect(graphCheckSummaryState("success")).toBe("passed");
    expect(graphCheckSummaryState("neutral")).toBe("passed");
    expect(graphCheckSummaryState("failure")).toBe("failed");
    expect(graphCheckSummaryState("pending")).toBe("pending");
    expect(graphCheckSummaryState("none")).toBe("none");
  });
});
