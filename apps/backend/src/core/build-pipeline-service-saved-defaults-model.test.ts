/**
 * To-do 7546: a Build started from saved defaults ran its build stage on a
 * ChatGPT Codex login and then failed review with "The 'gpt-5.4' model is not
 * supported when using Codex with a ChatGPT account". The review row pinned the
 * inherited platform model, so the stage treated it as an explicit choice and
 * skipped the swap a new session gets. These tests run the whole launch path a
 * coordinator, the CLI and the Build button share (`buildPipelineInputWithDefaults`)
 * through the pipeline service.
 */
import { describe, expect, test } from "bun:test";
import type { AgentSettingsTier } from "@orkestrator/protocol/agent-settings";
import type { BuildPipeline, StartBuildPipelineInput } from "@orkestrator/protocol/build-pipeline";
import {
  buildPipelineInputWithDefaults,
  savedLaunchSettings,
} from "./coordinator-launch-defaults.js";
import { resolveCodexDefaultModel } from "./session-held-model.js";
import type { StorageService } from "./storage.js";
import type { BuildPipelineService } from "./build-pipeline-service.js";
import { pipeline, startInput, withService } from "./build-pipeline-service-test-support.js";

/** A ChatGPT login: its live list lacks the stored default. */
const answerFromChatGptLogin = async (modelId: string | undefined) =>
  resolveCodexDefaultModel(modelId, {
    source: "app-server",
    supportedModelIds: ["gpt-6.1-sol", "gpt-6-luna"],
    models: [{ id: "gpt-6.1-sol", name: "GPT-6.1-Sol" }],
  });

/** The 2026-11-08 profile's saved defaults: Codex, one reviewer, no model chosen per action. */
async function saveCodexDefaults(
  storage: StorageService,
  extra: Partial<AgentSettingsTier> = {},
): Promise<void> {
  const config = await storage.loadConfig();
  config.global.enabledAgentPlatforms = ["codex"];
  config.global.agentSettings = {
    defaultAgent: "codex",
    platforms: { codex: { mode: "native", model: "gpt-5.4", reasoningEffort: "high" } },
    multiReview: { reviewerCount: 1 },
    ...extra,
  };
  await storage.saveConfig(config);
}

/** Launches with every choice left out, as `start_build_pipeline` with no rows does. */
async function launchFromSavedDefaults(
  service: BuildPipelineService,
  storage: StorageService,
): Promise<BuildPipeline> {
  const { agentType: _omitted, ...request } = startInput();
  const config = await storage.loadConfig();
  const input = buildPipelineInputWithDefaults(
    request,
    savedLaunchSettings(config, request.projectId),
  ) as unknown as StartBuildPipelineInput;
  const started = await service.start(input);
  let current = await pipeline(storage, started.id);
  for (let pass = 0; pass < 12 && current.phase !== "complete"; pass++) {
    await service.advanceNow(started.id);
    current = await pipeline(storage, started.id);
  }
  return current;
}

describe("a Build started from saved Codex defaults on a login that does not offer them", () => {
  test("runs its review stage on an offered model, as its build stage does", async () => {
    await withService(async (service, storage, provider) => {
      provider.resolveDefaultModel = answerFromChatGptLogin;
      await saveCodexDefaults(storage);
      const saved = (await storage.loadConfig()).global.agentSettings;

      const current = await launchFromSavedDefaults(service, storage);

      expect(current.phase).toBe("complete");
      const byPhase = (phase: string) =>
        current.sessions.find((session) => session.phase === phase);
      for (const phase of ["build", "review", "verify", "pr"]) {
        expect(byPhase(phase)?.model).toBe("gpt-6.1-sol");
        expect(byPhase(phase)?.modelSubstitution).toEqual({
          requestedModelId: "gpt-5.4",
          modelId: "gpt-6.1-sol",
          message: "gpt-5.4 isn't available with your Codex login; using GPT-6.1-Sol.",
        });
      }
      // The saved review row is not a pin.
      expect(current.steps?.review).toEqual({ agent: "codex", reasoningEffort: "high" });
      const review = provider.created.find((created) => created.phase === "review");
      expect(review?.options?.model).toBe("gpt-6.1-sol");
      // Substituted for this pipeline only; the settings keep the user's choice.
      expect((await storage.loadConfig()).global.agentSettings).toEqual(saved);
    });
  });

  test("keeps a model the review action names itself", async () => {
    await withService(async (service, storage, provider) => {
      provider.resolveDefaultModel = answerFromChatGptLogin;
      await saveCodexDefaults(storage, {
        actionDefaults: { review: { platform: "codex", model: "gpt-5.4" } },
      });

      const current = await launchFromSavedDefaults(service, storage);

      expect(current.steps?.review).toEqual({
        agent: "codex",
        model: "gpt-5.4",
        reasoningEffort: "high",
      });
      const review = current.sessions.find((session) => session.phase === "review");
      // An explicit choice is never swapped, so a wrong one fails loudly.
      expect(review?.model).toBe("gpt-5.4");
      expect(review?.modelSubstitution).toBeUndefined();
      // The build step still had no model of its own.
      const build = current.sessions.find((session) => session.phase === "build");
      expect(build?.model).toBe("gpt-6.1-sol");
    });
  });
});
