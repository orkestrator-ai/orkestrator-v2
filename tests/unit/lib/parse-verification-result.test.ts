import { describe, expect, test } from "bun:test";
import { verificationPrompt } from "../../../apps/backend/src/core/build-pipeline-prompts";
import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";

function pipeline(): BuildPipeline {
  return {
    id: "pipeline-1",
    taskId: "task-1",
    projectId: "project-1",
    environmentId: "env-1",
    environmentType: "local",
    agentType: "codex",
    phase: "verifying",
    sessions: [],
    currentSessionIndex: -1,
    iteration: 0,
    maxIterations: 3,
    createdAt: "2026-07-29T08:00:00.000Z",
    taskTitle: "Upload retry",
    taskSnapshot: {
      title: "Upload retry",
      description: "Keep failed uploads in the queue.",
      acceptanceCriteria: "A failed upload can be retried.",
      comments: [{ text: "Do not lose the selected file." }],
      images: [{ filename: "failure.png", data: "redacted-test-data" }],
    },
    source: { type: "kanban", taskId: "task-1" },
    backendRevision: 2,
    controller: "backend",
  };
}

describe("structured verification prompt", () => {
  test("requests the provider-enforced complete/rationale payload", () => {
    const prompt = verificationPrompt(pipeline(), "", "main");

    expect(prompt).toContain("Use ordinary prose for interim progress updates");
    expect(prompt).toContain("Never emit a partial or provisional verification verdict");
    expect(prompt).toContain(
      'make the final assistant message the only JSON object, matching the provider-enforced schema: {"complete":true,"rationale":"..."}',
    );
    expect(prompt).toContain("Compare against origin/main");
  });

  test("includes ticket acceptance context and project notes", () => {
    const prompt = verificationPrompt(
      pipeline(),
      "Run the gateway integration suite.",
      "release",
    );

    expect(prompt).toContain("**Title**: Upload retry");
    expect(prompt).toContain("A failed upload can be retried.");
    expect(prompt).toContain("Do not lose the selected file.");
    expect(prompt).toContain("failure.png");
    expect(prompt).toContain("Run the gateway integration suite.");
    expect(prompt).toContain("origin/release");
  });

  test("allows verification outputs but forbids source edits", () => {
    expect(verificationPrompt(pipeline(), "", "main")).toContain(
      "may write generated artifacts and tool caches",
    );
    expect(verificationPrompt(pipeline(), "", "main")).toContain(
      "Do not edit source files or create commits",
    );
  });
});
