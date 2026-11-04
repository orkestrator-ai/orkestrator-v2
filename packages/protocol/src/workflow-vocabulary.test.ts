import { describe, expect, test } from "bun:test";
import {
  BUILD_PIPELINE_RENAMES,
  MULTI_REVIEW_RENAMES,
  canonicalBuildPipeline,
  canonicalMultiReview,
} from "./workflow-vocabulary.js";

const pipeline = {
  phase: "paused",
  pausedFromPhase: "fixing",
  steps: { address: { agent: "codex", model: "gpt-6.1-sol" } },
  restartRequest: { kind: "review-package", implementationPhase: "fix" },
  skipRequest: { phase: "address" },
  taskSnapshot: { title: "rework", phase: "rework" },
  sessions: [
    { phase: "fix", label: "Fix Session", fixWorktreeFingerprintAtStart: "abc" },
    {
      phase: "address",
      addressReportKind: "fix-result",
      fixResult: { complete: true, notes: ["rework"] },
    },
  ],
};

const futurePipeline = {
  phase: "paused",
  pausedFromPhase: "reworking",
  steps: { "address-findings": { agent: "codex", model: "gpt-6.1-sol" } },
  restartRequest: { kind: "review-package", implementationPhase: "rework" },
  skipRequest: { phase: "address-findings" },
  taskSnapshot: { title: "rework", phase: "rework" },
  sessions: [
    { phase: "rework", label: "Fix Session", reworkWorktreeFingerprintAtStart: "abc" },
    {
      phase: "address-findings",
      addressFindingsReportKind: "address-findings-result",
      addressFindingsResult: { complete: true, notes: ["rework"] },
    },
  ],
};

const review = {
  phase: "paused",
  pausedFromPhase: "fixing",
  pausedStep: "fix",
  fixModel: { agent: "codex", model: "gpt-6.1-sol" },
  autoFix: true,
  fixSession: { openedFor: "fix", sessionKey: "key" },
  stepRuntimes: { fix: { completedAt: "2026-11-04T00:00:00.000Z" } },
  activeRequest: { kind: "fix", requestId: "request" },
  customFixInstruction: "address-findings",
  customFixModel: { agent: "codex" },
  addressPromptPending: true,
};

const futureReview = {
  phase: "paused",
  pausedFromPhase: "addressing-findings",
  pausedStep: "address-findings",
  addressFindingsModel: { agent: "codex", model: "gpt-6.1-sol" },
  autoAddressFindings: true,
  addressFindingsSession: { openedFor: "address-findings", sessionKey: "key" },
  stepRuntimes: { "address-findings": { completedAt: "2026-11-04T00:00:00.000Z" } },
  activeRequest: { kind: "address-findings", requestId: "request" },
  customAddressFindingsInstruction: "address-findings",
  customAddressFindingsModel: { agent: "codex" },
  addressPromptPending: true,
};

describe("workflow vocabulary", () => {
  test("reads a build pipeline written in the new names", () => {
    expect<unknown>(canonicalBuildPipeline(futurePipeline)).toEqual(pipeline);
  });

  test("reads a Multi Review written in the new names", () => {
    expect<unknown>(canonicalMultiReview(futureReview)).toEqual(review);
  });

  test("gives Fix its own meaning in each workflow", () => {
    expect(canonicalBuildPipeline({ phase: "addressing-findings" }).phase).toBe("addressing");
    expect(canonicalMultiReview({ phase: "addressing-findings" }).phase).toBe("fixing");
    expect(canonicalBuildPipeline({ phase: "address-findings" }).phase).toBe("address");
    expect(canonicalMultiReview({ pausedStep: "address-findings" }).pausedStep).toBe("fix");
  });

  test("keeps the package preparation session out of Rework's new names", () => {
    expect(canonicalBuildPipeline({ phase: "preparing-package" }).phase).toBe("fixing");
    expect(canonicalBuildPipeline({ phase: "package-preparation" }).phase).toBe("fix");
  });

  test("returns a current snapshot untouched, without copying", () => {
    expect(canonicalBuildPipeline(pipeline)).toBe(pipeline);
    expect(canonicalMultiReview(review)).toBe(review);
  });

  test("does not rewrite free text that happens to match a new name", () => {
    const value = { label: "rework", notes: ["reworking"], taskSnapshot: { phase: "rework" } };
    expect(canonicalBuildPipeline(value)).toBe(value);
  });

  test("does not treat inherited object properties as renames", () => {
    const value = { kind: "constructor", toString: "x" };
    expect(canonicalBuildPipeline(value)).toBe(value);
    expect(canonicalMultiReview(value)).toBe(value);
  });

  test("every new name differs from the name it replaces", () => {
    for (const renames of [BUILD_PIPELINE_RENAMES, MULTI_REVIEW_RENAMES]) {
      for (const [next, current] of Object.entries({ ...renames.keys, ...renames.values })) {
        expect(next).not.toBe(current);
      }
    }
  });
});
