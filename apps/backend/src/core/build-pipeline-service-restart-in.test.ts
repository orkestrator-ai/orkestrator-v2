import { describe, expect, test } from "bun:test";
import { REVIEW_PACKAGE_SESSION_LABEL } from "@orkestrator/protocol/build-pipeline";
import { createCommandRegistry, type CommandContext } from "./commands.js";
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

  test.each([true, false])(
    "preparation restart forwards explicit speed %s over defaults",
    async (fastMode) => {
      await withService(async (service, storage, provider) => {
        const config = await storage.loadConfig();
        config.global.agentSettings = { platforms: { claude: { fastMode: !fastMode } } };
        await storage.saveConfig(config);
        const { started } = await startBuilding(service, storage, {
          reviewPreparation: { agent: "claude" },
        });
        provider.runningPhases.add("fix");
        await service.advanceNow(started.id);
        const preparation = (await pipeline(storage, started.id)).sessions.at(-1)!;
        expect(preparation.label).toBe(REVIEW_PACKAGE_SESSION_LABEL);
        await service.restartStep(started.id, preparation.sdkSessionId, {
          agent: "claude",
          model: "opus",
          fastMode,
        });
        expect(provider.created.at(-1)?.options).toMatchObject({ model: "opus", fastMode });
      });
    },
  );

  test("superseded selection is refused without changing the saved configuration", async () => {
    await withService(async (service, storage) => {
      const { started, session } = await startBuilding(service, storage);
      await service.restartStep(started.id, session.sdkSessionId);
      const before = await pipeline(storage, started.id);
      await expect(
        service.restartStep(started.id, session.sdkSessionId, {
          agent: "codex",
          model: "new-model",
        }),
      ).rejects.toThrow("previous attempt");
      expect((await pipeline(storage, started.id)).steps).toEqual(before.steps);
      expect((await pipeline(storage, started.id)).rewinds).toEqual(before.rewinds);
    });
  });

  test.each(["merged", "missing reviewer"])(
    "%s refusal leaves configuration unchanged",
    async (reason) => {
      await withService(async (service, storage) => {
        const { started, session } = await startBuilding(service, storage);
        if (reason === "merged") await storage.updateEnvironment("env-1", { prState: "merged" });
        const before = await mutateStored(storage, started.id, (snapshot) => {
          if (reason === "merged")
            snapshot.sessions.push({
              ...session,
              sessionKey: "pr-key",
              sdkSessionId: "pr-session",
              phase: "pr",
            });
          if (reason === "missing reviewer") {
            snapshot.sessions[0]!.phase = "review";
            snapshot.sessions[0]!.label = "Review 2";
          }
        });
        await expect(
          service.restartStep(started.id, session.sdkSessionId, {
            agent: "codex",
            model: "new-model",
          }),
        ).rejects.toThrow(reason === "merged" ? "merged" : "cannot be restarted");
        const after = await pipeline(storage, started.id);
        expect(after.steps).toEqual(before.steps);
        expect(after.reviewers).toEqual(before.reviewers);
        expect(after.rewinds).toEqual(before.rewinds);
      });
    },
  );

  test("command boundary rejects malformed selections before calling the service", async () => {
    const command = createCommandRegistry().get("restart_build_pipeline_step")!;
    let called = false;
    const context = {
      buildPipelines: {
        restartStep: () => {
          called = true;
        },
      },
    } as unknown as CommandContext;
    for (const selection of [
      null,
      [],
      { agent: "unknown", model: "x" },
      { agent: "codex", model: "" },
      { agent: "codex", model: "x", fastMode: "true" },
      { agent: "codex", model: "x", extra: true },
    ]) {
      expect(() => command({ pipelineId: "p", stageId: "s", selection }, context)).toThrow(
        "Invalid build pipeline restart selection",
      );
    }
    expect(called).toBe(false);
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
