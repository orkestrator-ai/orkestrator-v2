import { describe, expect, test } from "bun:test";
import {
  isValidationFailureSummary,
  isValidationFailureTriage,
  normalizeValidationTestName,
  summarizeValidationFailureTriage,
  validationFailureId,
  validationFailureKey,
  type TriagedValidationFailure,
  type ValidationFailureTriage,
} from "./validation-failure-triage.js";

function failure(
  name: string,
  verdict: TriagedValidationFailure["verdict"],
): TriagedValidationFailure {
  return {
    key: validationFailureKey("bun", "src/a.test.ts", name),
    runner: "bun",
    file: "src/a.test.ts",
    name,
    outcome: "failed",
    verdict,
    reasons: verdict === "related" ? ["imports-changed-file"] : ["no-changed-dependency"],
  };
}

const triage: ValidationFailureTriage = {
  version: 1,
  mergeBase: "a".repeat(40),
  commands: [
    {
      command: "mise run test",
      failures: [failure("adds", "related"), failure("subtracts", "unrelated")],
      omittedFailures: 0,
      unattributed: false,
    },
    { command: "mise run typecheck", failures: [], omittedFailures: 0, unattributed: true },
  ],
  limitations: [],
};

describe("validation failure triage", () => {
  test("a key ignores runner timings and whitespace", () => {
    expect(normalizeValidationTestName("Pool >  idle  expire [706.63ms]")).toBe(
      "Pool > idle expire",
    );
    expect(validationFailureKey("bun", null, "x [1ms]")).toBe("bun:?::x");
  });

  test("an id is a stable 16-hex digest of the key", () => {
    const id = validationFailureId("bun:src/a.test.ts::adds");
    expect(id).toMatch(/^[a-f0-9]{16}$/);
    expect(validationFailureId("bun:src/a.test.ts::adds")).toBe(id);
    expect(validationFailureId("bun:src/a.test.ts::subtracts")).not.toBe(id);
  });

  test("the guard accepts a well-formed triage and rejects unknown verdicts", () => {
    expect(isValidationFailureTriage(triage)).toBe(true);
    const bad = structuredClone(triage);
    (bad.commands[0]!.failures[0] as { verdict: string }).verdict = "maybe";
    expect(isValidationFailureTriage(bad)).toBe(false);
  });

  test("the guard accepts an import's hop count and a distant import, and rejects a zero hop count", () => {
    const withHops = structuredClone(triage);
    withHops.commands[0]!.failures[0] = {
      ...withHops.commands[0]!.failures[0]!,
      verdict: "undetermined",
      reasons: ["reaches-changed-file-indirectly"],
      changedPath: "packages/protocol/src/web-annotations.ts",
      changedPathHops: 4,
    };
    expect(isValidationFailureTriage(withHops)).toBe(true);
    for (const hops of [0, 1.5, "2"]) {
      const bad = structuredClone(withHops);
      (bad.commands[0]!.failures[0] as { changedPathHops: unknown }).changedPathHops = hops;
      expect(isValidationFailureTriage(bad)).toBe(false);
    }
  });

  test("the summary counts verdicts and unattributed commands", () => {
    const summary = summarizeValidationFailureTriage(triage);
    expect(isValidationFailureSummary(summary)).toBe(true);
    expect(summary).toMatchObject({
      related: 1,
      unrelated: 1,
      undetermined: 0,
      unattributedCommands: 1,
    });
    expect(summary.ids).toHaveLength(2);
    expect(summary.relatedIds).toEqual([validationFailureId(failure("adds", "related").key)]);
    expect(summary.truncated).toBeUndefined();
  });

  test("omitted failures mark the summary truncated and the command unattributed", () => {
    const omitted = structuredClone(triage);
    omitted.commands[0]!.omittedFailures = 3;
    expect(summarizeValidationFailureTriage(omitted)).toMatchObject({
      truncated: true,
      unattributedCommands: 2,
    });
  });
});

test("summary provenance excludes shared, uncertain, and conflicting failures", () => {
  const source = structuredClone(triage);
  const shared = { ...failure("shared", "unrelated"), reasons: ["failed-on-same-base" as const] };
  source.commands[0]!.failures.push(
    shared,
    failure("uncertain", "undetermined"),
    failure("adds", "unrelated"),
  );
  const summary = summarizeValidationFailureTriage(source);
  expect(summary.baseIds).toEqual([validationFailureId(failure("subtracts", "unrelated").key)]);
  expect(isValidationFailureSummary(summary)).toBe(true);
  expect(
    isValidationFailureSummary({ ...summary, baseIds: [validationFailureId(shared.key)] }),
  ).toBe(true);
  expect(isValidationFailureSummary({ ...summary, baseIds: summary.relatedIds })).toBe(false);
  expect(isValidationFailureSummary({ ...summary, baseIds: ["f".repeat(16)] })).toBe(false);
});
