import { describe, expect, test } from "bun:test";
import {
  summarizeValidationFailureTriage,
  validationFailureId,
  validationFailureKey,
  type ValidationFailureTriage,
} from "@orkestrator/protocol/validation-failure-triage";
import {
  applySharedBaseEvidence,
  classifierPayload,
  MAX_TRIAGE_PAYLOAD_BASE64_BYTES,
  sharedFailureSummaries,
} from "./validation-failure-triage-service.js";
import type { ValidationFailureClassifierInput } from "./validation-failure-classifier.js";

const BASE = "c".repeat(40);
const e2eKey = validationFailureKey("playwright", "e2e/a.spec.ts", "opens the pane");

function triage(verdict: "related" | "undetermined" = "undetermined"): ValidationFailureTriage {
  return {
    version: 1,
    mergeBase: BASE,
    commands: [
      {
        command: "mise run test:browser",
        failures: [
          {
            key: e2eKey,
            runner: "playwright",
            file: "e2e/a.spec.ts",
            name: "opens the pane",
            outcome: "failed",
            verdict,
            reasons: ["not-import-traceable"],
          },
        ],
        omittedFailures: 0,
        unattributed: false,
      },
    ],
    limitations: [],
  };
}

describe("classifierPayload", () => {
  const input: ValidationFailureClassifierInput = {
    root: "/workspace",
    commands: [],
    changedFiles: ["src/a.ts"],
    mergeBase: null,
    ci: null,
  };

  test("passes a small input through unchanged", () => {
    const decoded = JSON.parse(Buffer.from(classifierPayload(input), "base64").toString());
    expect(decoded).toEqual(input);
  });

  test("cuts a changed-file list that would not fit and says so", () => {
    const changedFiles = Array.from({ length: 5_000 }, (_, i) => `src/module-${i}/file.ts`);
    const payload = classifierPayload({ ...input, changedFiles });
    expect(payload.length).toBeLessThanOrEqual(MAX_TRIAGE_PAYLOAD_BASE64_BYTES);
    const decoded = JSON.parse(Buffer.from(payload, "base64").toString());
    expect(decoded.changedFilesTruncated).toBe(true);
    expect(decoded.changedFiles.length).toBeGreaterThan(0);
    expect(decoded.changedFiles.length).toBeLessThan(changedFiles.length);
  });
});

describe("failures shared on the same merge-base", () => {
  const otherSummary = summarizeValidationFailureTriage(triage());

  test("another pipeline's unrelated or undetermined failure makes it unrelated here", () => {
    const result = applySharedBaseEvidence(triage(), [otherSummary]);
    expect(result.commands[0]!.failures[0]).toMatchObject({
      verdict: "unrelated",
      reasons: ["not-import-traceable", "failed-on-same-base"],
    });
  });

  test("a failure the other branch caused, or one on another base, is not evidence", () => {
    const caused = summarizeValidationFailureTriage(triage("related"));
    expect(applySharedBaseEvidence(triage(), [caused]).commands[0]!.failures[0]!.verdict).toBe(
      "undetermined",
    );
    const elsewhere = { ...otherSummary, mergeBase: "d".repeat(40) };
    expect(applySharedBaseEvidence(triage(), [elsewhere]).commands[0]!.failures[0]!.verdict).toBe(
      "undetermined",
    );
  });

  test("summaries come from other environments in the project only", async () => {
    const record = (environmentId: string, projectId: string) => ({
      environmentId,
      projectId,
      snapshot: { validationHistory: [{ failures: otherSummary }, { failures: "bad" }] },
    });
    const storage = {
      listAllBuildPipelines: async () => [
        record("env-self", "project-1"),
        record("env-other", "project-1"),
        record("env-foreign", "project-2"),
      ],
    };
    const summaries = await sharedFailureSummaries({ storage } as never, {
      id: "env-self",
      projectId: "project-1",
    });
    expect(summaries).toEqual([otherSummary]);
    expect(summaries[0]!.ids).toEqual([validationFailureId(e2eKey)]);
  });
});
