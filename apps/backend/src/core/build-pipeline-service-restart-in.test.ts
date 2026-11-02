import { describe, expect, test } from "bun:test";
import { newReviewValidationRun } from "@orkestrator/protocol/review-workflow";
import {
  mutateStored,
  pipeline,
  startBuilding,
  withService,
} from "./build-pipeline-service-test-support.js";

describe("restarting a step in another agent or model", () => {
  test("reruns the step on the chosen agent and keeps it for later runs", async () => {
    await withService(async (service, storage, provider) => {
      const { started, session } = await startBuilding(service, storage, {
        steps: { build: { agent: "claude", model: "opus", instructions: "Keep it small." } },
      });
      await mutateStored(storage, started.id, (snapshot) => {
        snapshot.phase = "failed";
        snapshot.error = "The build session failed";
        snapshot.sessions[0]!.status = "error";
      });

      const restarted = await service.restartStep(started.id, session.sdkSessionId, {
        agent: "codex",
        model: "gpt-6.1-sol",
        reasoningEffort: "high",
        fastMode: true,
      });

      // The step's own instructions survive the change of model.
      expect(restarted.steps?.build).toEqual({
        agent: "codex",
        model: "gpt-6.1-sol",
        reasoningEffort: "high",
        fastMode: true,
        instructions: "Keep it small.",
      });
      expect(restarted.agentType).toBe("claude");
      expect(restarted.phase).toBe("building");
      expect(restarted.sessions[0]!.supersededBy).toBeDefined();
      expect(restarted.sessions.at(-1)).toMatchObject({
        phase: "build",
        agent: "codex",
        model: "gpt-6.1-sol",
        reasoningEffort: "high",
        status: "running",
      });
      expect(provider.created.at(-1)?.options).toMatchObject({
        model: "gpt-6.1-sol",
        effort: "high",
      });
    });
  });

  test("refuses a selection for a step that runs no agent and leaves the pipeline alone", async () => {
    await withService(async (service, storage) => {
      const { started } = await startBuilding(service, storage);
      const run = newReviewValidationRun("validation-restart-in", {
        headRef: "a".repeat(40),
        commands: [],
        limitations: ["No commands available"],
      });
      const before = await mutateStored(storage, started.id, (snapshot) => {
        snapshot.phase = "failed";
        snapshot.validationRun = run;
      });

      await expect(
        service.restartStep(started.id, `validation:${run.id}`, {
          agent: "codex",
          model: "gpt-6.1-sol",
        }),
      ).rejects.toThrow("This pipeline stage is no longer available");

      const after = await pipeline(storage, started.id);
      expect(after.steps).toEqual(before.steps);
      expect(after.phase).toBe("failed");
      expect(after.rewinds).toBeUndefined();
    });
  });
});
