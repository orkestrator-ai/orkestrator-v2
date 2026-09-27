import { describe, expect, test } from "bun:test";
import { isBuildPipeline, isPipelineTranscriptReference } from "./build-pipeline.js";

const createdAt = "2026-07-29T00:00:00.000Z";

function withTranscript(transcript: unknown, extra: Record<string, unknown> = {}) {
  return {
    id: "pipeline-1",
    taskId: "task-1",
    projectId: "project-1",
    environmentId: "environment-1",
    environmentType: "local",
    agentType: "codex",
    phase: "verifying",
    sessions: [
      {
        phase: "verify",
        iteration: 0,
        sessionKey: "verify-key",
        sdkSessionId: "review-session",
        status: "idle",
        startedAt: createdAt,
        label: "Verification Session",
        messageRevision: 5,
        ...(transcript === undefined ? {} : { transcript }),
        ...extra,
      },
    ],
    currentSessionIndex: 0,
    iteration: 0,
    maxIterations: 3,
    createdAt,
    taskTitle: "Task",
    taskSnapshot: {
      title: "Task",
      description: "",
      acceptanceCriteria: "",
      comments: [],
      images: [],
    },
    backendRevision: 1,
    controller: "backend",
  };
}

describe("pipeline transcript reference", () => {
  const reference = {
    version: 1,
    sdkSessionId: "review-session",
    manifestRevision: 2,
    revision: 5,
    messageCount: 40,
    bytes: 12_345,
    complete: false,
    omittedMessages: 3,
    committedAt: createdAt,
  };

  test("accepts a versioned reference in place of an inline body", () => {
    expect(isPipelineTranscriptReference(reference)).toBe(true);
    expect(isBuildPipeline(withTranscript(reference))).toBe(true);
    expect(
      isBuildPipeline(withTranscript(reference, { legacyStructuredRequestId: "legacy-request" })),
    ).toBe(true);
    // Unmigrated legacy records still validate with their inline array.
    expect(isBuildPipeline(withTranscript(undefined, { messages: [{ id: "m" }] }))).toBe(true);
  });

  test("rejects malformed references and recovered request identities", () => {
    expect(isBuildPipeline(withTranscript(undefined, { legacyStructuredRequestId: "" }))).toBe(
      false,
    );
    for (const malformed of [
      { ...reference, version: 2 },
      { ...reference, sdkSessionId: "" },
      { ...reference, manifestRevision: 0 },
      { ...reference, revision: -1 },
      { ...reference, messageCount: 1.5 },
      { ...reference, bytes: "12" },
      { ...reference, complete: "yes" },
      { ...reference, omittedMessages: -1 },
      { ...reference, committedAt: "yesterday" },
      null,
      [],
    ]) {
      expect(isPipelineTranscriptReference(malformed)).toBe(false);
      expect(isBuildPipeline(withTranscript(malformed))).toBe(false);
    }
  });
});
