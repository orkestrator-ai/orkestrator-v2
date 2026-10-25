import { describe, expect, mock, test } from "bun:test";

import type { BuildPipelineAgent } from "@orkestrator/protocol/build-pipeline";
import type { NativeAgentControlUpdate } from "@orkestrator/protocol/native-agent";

import { PromptRejectedError } from "./native-agent-provider.js";
import { sessionHeldDispatchModelUpdate } from "./native-agent-dispatch-model.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service.js";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";

describe("sessionHeldDispatchModelUpdate", () => {
  const codex = { agent: "codex" as const, controls: { modelId: "gpt-held" } };

  test("applies only an explicit, different model on a session-held runtime", () => {
    expect(sessionHeldDispatchModelUpdate({ model: "gpt-new" }, codex)).toEqual({
      modelId: "gpt-new",
    });
    expect(
      sessionHeldDispatchModelUpdate({ model: "gpt-new", reasoningEffort: "low" }, codex),
    ).toEqual({ modelId: "gpt-new", reasoningId: "low" });
    expect(
      sessionHeldDispatchModelUpdate({ model: "gpt-new", modelSource: "explicit" }, codex),
    ).toEqual({ modelId: "gpt-new" });
  });

  test("leaves the session alone otherwise", () => {
    expect(sessionHeldDispatchModelUpdate({ model: "gpt-held" }, codex)).toBeUndefined();
    expect(
      sessionHeldDispatchModelUpdate({ model: "gpt-new", modelSource: "default" }, codex),
    ).toBeUndefined();
    expect(sessionHeldDispatchModelUpdate({ model: "default" }, codex)).toBeUndefined();
    expect(sessionHeldDispatchModelUpdate({ model: "  " }, codex)).toBeUndefined();
    expect(sessionHeldDispatchModelUpdate({}, codex)).toBeUndefined();
    // Prompts carry the model on these platforms, so there is nothing to apply.
    for (const agent of ["claude", "cursor", "grok", "pi", "opencode"] as const) {
      expect(
        sessionHeldDispatchModelUpdate({ model: "other" }, { agent, controls: { modelId: "m" } }),
      ).toBeUndefined();
    }
  });
});

describe("a dispatch naming a model", () => {
  function stubFor(
    agent: BuildPipelineAgent,
    order: string[],
    options: { offered?: (modelId: string | undefined) => boolean } = {},
  ) {
    const stub = createProviderStub(agent, {
      send: async () => {
        order.push("send");
      },
      updateInteractiveControls: async (_sessionId: string, update: NativeAgentControlUpdate) => {
        order.push(`config:${update.modelId}`);
        return undefined;
      },
    });
    if (options.offered) {
      const offered = options.offered;
      stub.provider.resolveDefaultModel = mock(async (modelId: string | undefined) =>
        offered(modelId)
          ? { modelId }
          : {
              modelId: "gpt-offered",
              substitution: {
                requestedModelId: modelId!,
                modelId: "gpt-offered",
                message: `${modelId} isn't available with your Codex login; using GPT Offered.`,
              },
            },
      );
    }
    return stub;
  }

  const identity = (agent: BuildPipelineAgent) => ({
    environmentId: "env-1",
    agent,
    logicalSessionKey: `env-env-1:tab-${agent}-dispatch-model`,
  });
  const keyOf = (input: ReturnType<typeof identity>) =>
    nativeAgentSessionStorageKey(input.environmentId, input.agent, input.logicalSessionKey);

  test("is applied to an existing Codex session before the turn, as a model pick is", async () => {
    const order: string[] = [];
    const stub = stubFor("codex", order, { offered: () => true });
    await withService(
      { prefix: "orkestrator-native-codex-dispatch-model-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        const input = identity("codex");
        await service.ensureSession({ ...input, model: "gpt-held" });
        await service.dispatchPrompt({
          ...input,
          prompt: "Run on the other model",
          requestId: "request-model",
          model: "gpt-new",
          reasoningEffort: "low",
        });
        expect(order).toEqual(["config:gpt-new", "send"]);
        expect(stub.updateInteractiveControls!.mock.calls[0]?.[1]).toEqual({
          modelId: "gpt-new",
          reasoningId: "low",
        });
        const stored = await storage.getNativeAgentSession(keyOf(input));
        expect(stored?.controls).toMatchObject({ modelId: "gpt-new", reasoningId: "low" });
        expect(stub.send.mock.calls[0]?.[2]).toMatchObject({ model: "gpt-new" });

        // The session now holds it, so the next prompt on it changes nothing.
        await service.dispatchPrompt({
          ...input,
          prompt: "Again",
          requestId: "request-model-again",
          model: "gpt-new",
        });
        expect(order).toEqual(["config:gpt-new", "send", "send"]);
      },
    );
  });

  test("leaves an inherited default to the session's own model", async () => {
    const order: string[] = [];
    const stub = stubFor("codex", order, { offered: () => true });
    await withService(
      { prefix: "orkestrator-native-codex-dispatch-default-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        const input = identity("codex");
        await service.ensureSession({ ...input, model: "gpt-held" });
        await service.dispatchPrompt({
          ...input,
          prompt: "Use whatever the session runs",
          requestId: "request-default",
          model: "gpt-configured-default",
          modelSource: "default",
        });
        expect(order).toEqual(["send"]);
        expect((await storage.getNativeAgentSession(keyOf(input)))?.controls?.modelId).toBe(
          "gpt-held",
        );
      },
    );
  });

  test("refuses a Codex model the login does not offer, keeping the session's model", async () => {
    const order: string[] = [];
    const stub = stubFor("codex", order, { offered: (modelId) => modelId !== "gpt-unoffered" });
    await withService(
      {
        prefix: "orkestrator-native-codex-dispatch-unoffered-",
        provider: async () => stub.provider,
      },
      async ({ service, storage }) => {
        const input = identity("codex");
        await service.ensureSession({ ...input, model: "gpt-held" });
        const dispatch = service.dispatchPrompt({
          ...input,
          prompt: "Run on a model this login lacks",
          requestId: "request-unoffered",
          model: "gpt-unoffered",
        });
        await expect(dispatch).rejects.toBeInstanceOf(PromptRejectedError);
        await expect(dispatch).rejects.toThrow(
          "gpt-unoffered isn't available with your Codex login, so this prompt was not sent. Pick another model, such as gpt-offered, and send it again.",
        );
        expect(order).toEqual([]);
        const stored = await storage.getNativeAgentSession(keyOf(input));
        expect(stored?.controls?.modelId).toBe("gpt-held");
        // Nothing was journaled, so the same request id is free to retry.
        expect(stored?.pendingDispatch).toBeUndefined();
      },
    );
  });

  test("is carried on the prompt for a platform whose prompts name the model", async () => {
    const order: string[] = [];
    const stub = stubFor("claude", order);
    await withService(
      { prefix: "orkestrator-native-claude-dispatch-model-", provider: async () => stub.provider },
      async ({ service }) => {
        const input = identity("claude");
        await service.ensureSession({ ...input, model: "claude-held" });
        await service.dispatchPrompt({
          ...input,
          prompt: "Run on the other model",
          requestId: "request-claude-model",
          model: "claude-other",
        });
        expect(order).toEqual(["send"]);
        expect(stub.send.mock.calls[0]?.[2]).toMatchObject({ model: "claude-other" });
      },
    );
  });
});
