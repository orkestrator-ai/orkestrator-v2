import { describe, expect, test } from "bun:test";
import type { ArtifactTypeDef } from "@orkestrator/protocol/graphs/artifact-type-def";
import { graphArtifactItemIds } from "@orkestrator/protocol/graphs/run";
import type { GraphMergeStrategy } from "@orkestrator/protocol/graphs/template";
import {
  GraphTypeLibrary,
  graphBuiltInType,
  validateGraphArtifactValue,
  type GraphTypeDefinition,
} from "@orkestrator/protocol/graphs/types";
import {
  mergeGraphValues,
  type GraphMergeResult,
  type GraphMergeSource,
} from "./graph-node-merge.js";

const REPORT_TYPE = graphBuiltInType("review-report@1")!;
const DECISION_TYPE = graphBuiltInType("decision@1")!;
const ERROR_TYPE = graphBuiltInType("error@1")!;
type Issue = Record<string, unknown> & { title: string; file: string };
const REPORT = REPORT_TYPE.example as { issues: Issue[] } & Record<string, unknown>;
const ISSUE = REPORT.issues[0]!;

const SCORED: ArtifactTypeDef = {
  name: "scored",
  version: 1,
  schema: {
    type: "object",
    properties: { name: { type: "string" }, score: { type: "number" } },
    required: ["name", "score"],
    additionalProperties: false,
  },
  storage: "value",
  budgets: { maxBytes: 4_096 },
};
const DIAGNOSIS: ArtifactTypeDef = {
  name: "diagnosis",
  version: 1,
  schema: {
    type: "object",
    properties: {
      diagnoses: {
        type: "array",
        items: {
          type: "object",
          properties: { rootCause: { type: "string" }, explanation: { type: "string" } },
          required: ["rootCause", "explanation"],
          additionalProperties: false,
        },
      },
    },
    required: ["diagnoses"],
    additionalProperties: false,
  },
  storage: "value",
  budgets: { maxBytes: 65_536, maxItems: 32 },
  items: { path: "diagnoses", idPrefix: "diagnosis" },
};
const library = new GraphTypeLibrary([SCORED, DIAGNOSIS]);
function custom(ref: string): GraphTypeDefinition {
  const resolved = library.resolve(ref);
  if (!resolved.ok || resolved.type.kind !== "named") throw new Error(ref);
  return resolved.type.definition;
}

function source(
  id: string,
  type: string,
  value: unknown,
  activation: string,
  itemIds?: string[],
): GraphMergeSource {
  const nodeId = activation.split("#")[0]!;
  return {
    id,
    type,
    value,
    producer: { nodeId, activation, port: "out" },
    ...(itemIds ? { itemIds } : {}),
  };
}

function report(issues: Issue[]): Record<string, unknown> {
  return { ...structuredClone(REPORT), issues };
}

function issue(title: string, file: string, extra: Partial<Issue> = {}): Issue {
  return { ...structuredClone(ISSUE), title, file, ...extra };
}

function merge(
  strategy: GraphMergeStrategy,
  element: GraphTypeDefinition,
  sources: GraphMergeSource[],
  output: GraphTypeDefinition = element,
): GraphMergeResult {
  return mergeGraphValues({ strategy, element, output, sources });
}

function value(result: GraphMergeResult): Record<string, unknown> {
  if (result.kind !== "value") throw new Error(`expected a value, got ${result.kind}`);
  return result.value as Record<string, unknown>;
}

const REVIEW_1 = "review#iter=1#branch=panel.1#attempt=1";
const REVIEW_2 = "review#iter=1#branch=panel.2#attempt=1";

describe("item ids", () => {
  test("merges use the protocol derivation: recorded ids win, else the producing activation", () => {
    const items = REPORT_TYPE.items;
    const recorded = source("a", "review-report@1", REPORT, REVIEW_1, ["r1/issue-9"]);
    expect(graphArtifactItemIds(recorded, items, { count: 1 })).toEqual(["r1/issue-9"]);
    expect(graphArtifactItemIds(recorded, items, { count: 2 })).toEqual([
      "review/panel.1/issue-1",
      "review/panel.1/issue-2",
    ]);
    const later = source("b", "review-report@1", REPORT, "fix#iter=2#attempt=1");
    expect(graphArtifactItemIds(later, items, { count: 1 })).toEqual(["fix/iter-2/issue-1"]);
    // A concat of unrecorded sources carries exactly the derived ids.
    const result = merge({ kind: "concat" }, REPORT_TYPE, [
      source("c", "review-report@1", report([issue("A", "a.ts")]), REVIEW_2),
    ]);
    expect(result.kind === "value" && result.itemIds).toEqual(["review/panel.2/issue-1"]);
  });
});

describe("merge strategies (§5.9)", () => {
  test("concat: one value with every item, the first input's other fields, ids kept", () => {
    const result = merge({ kind: "concat" }, REPORT_TYPE, [
      source("a", "review-report@1", report([issue("A", "a.ts")]), REVIEW_1),
      source("b", "review-report@1", report([issue("B", "b.ts"), issue("C", "c.ts")]), REVIEW_2, [
        "x/issue-1",
        "x/issue-2",
      ]),
    ]);
    const merged = value(result);
    expect((merged.issues as Issue[]).map((entry) => entry.title)).toEqual(["A", "B", "C"]);
    expect(merged.reviewScope).toEqual(REPORT.reviewScope);
    expect(result.kind === "value" && result.itemIds).toEqual([
      "review/panel.1/issue-1",
      "x/issue-1",
      "x/issue-2",
    ]);
    expect(validateGraphArtifactValue(REPORT_TYPE, merged)).toEqual([]);
  });

  test("dedupe folds items with the same key and keeps every source id", () => {
    const result = merge({ kind: "dedupe", key: ["file", "title"] }, REPORT_TYPE, [
      source("a", "review-report@1", report([issue("A", "a.ts"), issue("B", "b.ts")]), REVIEW_1),
      source(
        "b",
        "review-report@1",
        report([issue("B", "b.ts"), issue("A", "other.ts"), issue("A", "a.ts")]),
        REVIEW_2,
      ),
    ]);
    const merged = value(result) as { issues: Issue[] };
    expect(merged.issues.map((entry) => `${entry.title}@${entry.file}`)).toEqual([
      "A@a.ts",
      "B@b.ts",
      "A@other.ts",
    ]);
    // The type's source-id field carries the folded ids; the envelope records them too.
    expect(merged.issues.map((entry) => entry.reviewSourceIds)).toEqual([
      ["review/panel.1/issue-1", "review/panel.2/issue-3"],
      ["review/panel.1/issue-2", "review/panel.2/issue-1"],
      ["review/panel.2/issue-2"],
    ]);
    expect(result.kind === "value" && result.itemIds).toEqual([
      "review/panel.1/issue-1",
      "review/panel.1/issue-2",
      "review/panel.2/issue-2",
    ]);
    expect(result.kind === "value" && result.itemSources).toEqual([
      ["review/panel.1/issue-1", "review/panel.2/issue-3"],
      ["review/panel.1/issue-2", "review/panel.2/issue-1"],
      ["review/panel.2/issue-2"],
    ]);
    expect(validateGraphArtifactValue(REPORT_TYPE, merged)).toEqual([]);
  });

  test("dedupe without a source field records the folds in itemSources; unkeyed items stay apart", () => {
    const diagnosis = custom("diagnosis@1");
    const result = merge({ kind: "dedupe", key: ["rootCause"] }, diagnosis, [
      source(
        "a",
        "diagnosis@1",
        {
          diagnoses: [{ rootCause: "race", explanation: "one" }, { explanation: "no key" }],
        },
        "diagnose#iter=1#branch=panel.1#attempt=1",
      ),
      source(
        "b",
        "diagnosis@1",
        {
          diagnoses: [{ rootCause: "race", explanation: "two" }, { explanation: "no key" }],
        },
        "diagnose#iter=1#branch=panel.2#attempt=1",
      ),
    ]);
    expect(value(result)).toEqual({
      diagnoses: [
        { rootCause: "race", explanation: "one" },
        { explanation: "no key" },
        { explanation: "no key" },
      ],
    });
    expect(result.kind === "value" && result.itemSources).toEqual([
      ["diagnose/panel.1/diagnosis-1", "diagnose/panel.2/diagnosis-1"],
      ["diagnose/panel.1/diagnosis-2"],
      ["diagnose/panel.2/diagnosis-2"],
    ]);
  });

  test("vote: the most chosen option with its counts; ties follow the tie policy", () => {
    const decision = (choice: string, id: string) =>
      source(
        id,
        "decision@1",
        { choice, rationale: `because ${id}` },
        `judge#iter=1#branch=sample.${id}#attempt=1`,
      );
    const majority = merge({ kind: "vote", tie: "fail" }, DECISION_TYPE, [
      decision("rework", "1"),
      decision("ship", "2"),
      decision("ship", "3"),
    ]);
    expect(value(majority)).toEqual({
      choice: "ship",
      rationale: "Vote: rework 1, ship 2 (3 votes). because 2",
    });
    expect(validateGraphArtifactValue(DECISION_TYPE, value(majority))).toEqual([]);

    const tied = [decision("rework", "1"), decision("ship", "2")];
    expect(merge({ kind: "vote", tie: "fail" }, DECISION_TYPE, tied)).toMatchObject({
      kind: "failed",
      cause: "invalid-result",
    });
    expect(value(merge({ kind: "vote", tie: "first" }, DECISION_TYPE, tied))).toEqual({
      choice: "rework",
      rationale: "Vote: rework 1, ship 1 (2 votes; tie broken by input order). because 1",
    });
    // A custom path; inputs without a text choice abstain.
    const scored = custom("scored@1");
    expect(
      value(
        merge({ kind: "vote", tie: "fail", path: "name" }, scored, [
          source("a", "scored@1", { name: "x", score: 1 }, "s#iter=1#attempt=1"),
          source("b", "scored@1", { name: 3, score: 1 }, "s#iter=1#attempt=1"),
        ]),
      ),
    ).toEqual({ name: "x", score: 1 });
    expect(
      merge({ kind: "vote", tie: "first", path: "missing" }, scored, [
        source("a", "scored@1", { name: "x", score: 1 }, "s#iter=1#attempt=1"),
      ]),
    ).toMatchObject({ kind: "failed", cause: "invalid-result" });
  });

  test("best: the highest (or lowest) score; the earliest input wins a tie", () => {
    const scored = custom("scored@1");
    const sources = [
      source("a", "scored@1", { name: "a", score: 2 }, "s#iter=1#branch=sample.1#attempt=1"),
      source("b", "scored@1", { name: "b", score: 5 }, "s#iter=1#branch=sample.2#attempt=1"),
      source("c", "scored@1", { name: "c", score: 5 }, "s#iter=1#branch=sample.3#attempt=1"),
      source("d", "scored@1", { name: "d", score: 1 }, "s#iter=1#branch=sample.4#attempt=1"),
    ];
    expect(value(merge({ kind: "best", score: "score" }, scored, sources))).toEqual({
      name: "b",
      score: 5,
    });
    expect(
      value(merge({ kind: "best", score: "score", prefer: "lowest" }, scored, sources)),
    ).toEqual({ name: "d", score: 1 });
    expect(merge({ kind: "best", score: "missing" }, scored, sources)).toMatchObject({
      kind: "failed",
      cause: "invalid-result",
    });
  });

  test("collect forwards the list unchanged, failure markers included", () => {
    const marker = source("m", "error@1", ERROR_TYPE.example, "s#iter=1#branch=sample.2#attempt=1");
    expect(
      merge({ kind: "collect" }, REPORT_TYPE, [
        source("a", "review-report@1", REPORT, REVIEW_1),
        marker,
        source("a", "review-report@1", REPORT, REVIEW_1),
      ]),
    ).toEqual({ kind: "forward", ids: ["a", "m"] });
  });

  test("empty inputs and inputs of failure markers only merge to nothing", () => {
    const marker = source("m", "error@1", ERROR_TYPE.example, "s#iter=1#attempt=1");
    for (const strategy of [
      { kind: "concat" },
      { kind: "dedupe", key: ["title"] },
      { kind: "vote", tie: "fail" },
      { kind: "best", score: "score" },
    ] satisfies GraphMergeStrategy[]) {
      expect(merge(strategy, REPORT_TYPE, [])).toEqual({ kind: "none" });
      expect(merge(strategy, REPORT_TYPE, [marker])).toEqual({ kind: "none" });
    }
    expect(merge({ kind: "collect" }, REPORT_TYPE, [])).toEqual({ kind: "forward", ids: [] });
    // Markers do not vote.
    expect(
      value(
        merge({ kind: "vote", tie: "fail" }, DECISION_TYPE, [
          marker,
          source("d", "decision@1", { choice: "ship", rationale: "r" }, "j#iter=1#attempt=1"),
        ]),
      ).choice,
    ).toBe("ship");
  });

  test("concat of items with clashing recorded ids keeps them unique", () => {
    const result = merge({ kind: "concat" }, REPORT_TYPE, [
      source("a", "review-report@1", report([issue("A", "a.ts")]), REVIEW_1, ["same"]),
      source("b", "review-report@1", report([issue("B", "b.ts")]), REVIEW_2, ["same"]),
    ]);
    expect(result.kind === "value" && result.itemIds).toEqual(["same", "same~2"]);
  });
});
