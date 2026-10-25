import { describe, expect, mock, spyOn, test } from "bun:test";

import type { BuildPipelineAgent } from "@orkestrator/protocol/build-pipeline";
import type { NativeAgentControlUpdate } from "@orkestrator/protocol/native-agent";

import { createHash } from "node:crypto";
import { codexConnection, httpProvider } from "./agent-provider-test-support.js";
import { PromptRejectedError, ProviderUnavailableError } from "./native-agent-provider.js";
import { sessionHeldDispatchModelUpdate } from "./native-agent-dispatch-model.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service.js";
import {
  type Invoke,
  createProviderStub,
  waitForCondition,
  withService,
} from "./native-agent-service-projection-test-support.js";

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

  const models = ["gpt-held", "gpt-new", "gpt-picker"].map((id) => ({
    platform: "codex" as const,
    id,
    label: id,
    reasoning: [
      { id: "medium", label: "Medium" },
      { id: "xhigh", label: "Extra high" },
    ],
    defaultReasoningId: "medium",
  }));

  const invokeModels: Invoke = async <T>() => models as T;

  test("holds picker updates behind reconciliation and delivery", async () => {
    const applied = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const order: string[] = [];
    let runtimeModel = "gpt-held";
    const stub = createProviderStub("codex", {
      modelCatalog: async () => models,
      updateInteractiveControls: async (_id, update) => {
        order.push(`config:${update.modelId}`);
        runtimeModel = update.modelId!;
        if (runtimeModel === "gpt-new") {
          applied.resolve();
          await release.promise;
        }
      },
      send: async () => {
        order.push(`send:${runtimeModel}`);
      },
    });
    await withService(
      {
        invoke: invokeModels,
        prefix: "dispatch-model-fence-",
        provider: async () => stub.provider,
      },
      async ({ service, storage }) => {
        const input = identity("codex");
        await service.ensureSession({ ...input, model: "gpt-held" });
        const dispatch = service.dispatchPrompt({
          ...input,
          prompt: "Run",
          requestId: "r1",
          model: "gpt-new",
        });
        const admission = spyOn(storage, "updateNativeAgentSessionControls");
        let picker: ReturnType<typeof service.updateProjectionControls> | undefined;
        try {
          await applied.promise;
          picker = service.updateProjectionControls({
            ...input,
            update: { modelId: "gpt-picker" },
          });
          await waitForCondition(() => admission.mock.calls.length > 0);
          expect(runtimeModel).toBe("gpt-new");
          expect(order).toEqual(["config:gpt-new"]);
        } finally {
          release.resolve();
        }
        await dispatch;
        await picker;
        expect(order).toEqual(["config:gpt-new", "send:gpt-new", "config:gpt-picker"]);
        expect((await storage.getNativeAgentSession(keyOf(input)))?.controls?.modelId).toBe(
          "gpt-picker",
        );
      },
    );
  });

  test.each([false, true])(
    "replaying a completed request leaves picker controls unchanged (busy=%s)",
    async (busy) => {
      const order: string[] = [];
      const stub = stubFor("codex", order);
      stub.provider.modelCatalog = async () => models;
      await withService(
        {
          invoke: invokeModels,
          prefix: "dispatch-model-replay-",
          provider: async () => stub.provider,
        },
        async ({ service, storage }) => {
          const input = identity("codex");
          await service.ensureSession({ ...input, model: "gpt-held" });
          const request = { ...input, prompt: "Run", requestId: "r1", model: "gpt-new" };
          await service.dispatchPrompt(request);
          await service.updateProjectionControls({ ...input, update: { modelId: "gpt-picker" } });
          order.length = 0;
          if (busy)
            stub.updateInteractiveControls!.mockImplementation(async () => {
              throw new ProviderUnavailableError("running");
            });
          await service.dispatchPrompt(request);
          expect(order).toEqual([]);
          expect(stub.send).toHaveBeenCalledTimes(1);
          expect((await storage.getNativeAgentSession(keyOf(input)))?.controls?.modelId).toBe(
            "gpt-picker",
          );
        },
      );
    },
  );

  test.each(["dispatch", "steer"] as const)(
    "a conflicting pending %s refuses without changing the model",
    async (pending) => {
      const order: string[] = [];
      const stub = stubFor("codex", order);
      await withService(
        {
          invoke: invokeModels,
          prefix: "dispatch-model-conflict-",
          provider: async () => stub.provider,
        },
        async ({ service, storage }) => {
          const input = identity("codex");
          await service.ensureSession({ ...input, model: "gpt-held" });
          if (pending === "dispatch") {
            await expect(
              storage.dispatchNativeAgentPromptOnce(
                keyOf(input),
                "parked",
                async () => {
                  throw new Error("unknown outcome");
                },
                {
                  requestId: "parked",
                  prompt: "Earlier",
                  createdAt: new Date().toISOString(),
                },
              ),
            ).rejects.toThrow("unknown outcome");
          } else {
            await storage.dispatchNativeAgentSteerOnce(
              keyOf(input),
              {
                requestId: "parked",
                text: "Earlier",
                inputDigest: createHash("sha256").update("Earlier").digest("hex"),
                expectedRunId: "run-1",
                state: "prepared",
                createdAt: new Date().toISOString(),
              },
              async () => ({ outcome: "unknown", requestId: "parked" }),
            );
          }
          await expect(
            service.dispatchPrompt({ ...input, prompt: "Run", requestId: "r1", model: "gpt-new" }),
          ).rejects.toThrow();
          expect(order).toEqual([]);
          expect((await storage.getNativeAgentSession(keyOf(input)))?.controls?.modelId).toBe(
            "gpt-held",
          );
        },
      );
    },
  );

  test.each(["mode", "busy-mail"] as const)(
    "a preparation refusal (%s) leaves the model unchanged",
    async (refusal) => {
      const order: string[] = [];
      const stub = stubFor("codex", order);
      stub.provider.status = async () => "running";
      await withService(
        {
          invoke: invokeModels,
          prefix: "dispatch-model-refused-",
          provider: async () => stub.provider,
        },
        async ({ service, storage }) => {
          const input = identity("codex");
          const session = await service.ensureSession({ ...input, model: "gpt-held" });
          await storage.updateNativeAgentSessionControls(session.key, session.providerSessionId, {
            mode: "build",
          });
          const request = { ...input, prompt: "Run", requestId: "r1", model: "gpt-new" };
          if (refusal === "mode") {
            await expect(
              service.dispatchPrompt({ ...request, requireSessionMode: "plan" }),
            ).rejects.toThrow("no longer in Plan mode");
          } else {
            expect(await service.dispatchMailInject(request)).toEqual({
              outcome: "held",
              reason: "busy",
            });
          }
          expect(order).toEqual([]);
          const stored = await storage.getNativeAgentSession(keyOf(input));
          expect(stored?.controls?.modelId).toBe("gpt-held");
          expect(stored?.pendingDispatch).toBeUndefined();
        },
      );
    },
  );

  test("a model-only dispatch clears stale effort in storage and projection", async () => {
    const stub = createProviderStub("codex", {
      modelCatalog: async () => models,
      updateInteractiveControls: async () => undefined,
    });
    await withService(
      {
        invoke: invokeModels,
        prefix: "dispatch-model-effort-",
        provider: async () => stub.provider,
      },
      async ({ service, storage }) => {
        const input = identity("codex");
        await service.ensureSession({ ...input, model: "gpt-held", reasoningEffort: "xhigh" });
        expect((await storage.getNativeAgentSession(keyOf(input)))?.controls?.reasoningId).toBe(
          "xhigh",
        );
        await service.dispatchPrompt({
          ...input,
          prompt: "Run",
          requestId: "r1",
          model: "gpt-new",
        });
        expect(
          (await storage.getNativeAgentSession(keyOf(input)))?.controls?.reasoningId,
        ).toBeUndefined();
        const projection = await service.getProjection(input);
        expect(projection?.composer?.selectedModelId).toBe("gpt-new");
        expect(projection?.composer?.selectedReasoningId).not.toBe("xhigh");
        expect(
          projection?.composerControls.find((control) => control.id === "reasoning")?.value,
        ).toBe("medium");
      },
    );
  });

  test("a failed catalogue read remains advisory and the runtime applies the explicit model", async () => {
    const order: string[] = [];
    const stub = stubFor("codex", order);
    stub.provider.resolveDefaultModel = mock(async () => {
      throw new Error("catalogue offline");
    });
    await withService(
      {
        invoke: invokeModels,
        prefix: "dispatch-model-catalogue-",
        provider: async () => stub.provider,
      },
      async ({ service, storage }) => {
        const input = identity("codex");
        await service.ensureSession({ ...input, model: "gpt-held" });
        await service.dispatchPrompt({
          ...input,
          prompt: "Run",
          requestId: "r1",
          model: "gpt-new",
        });
        expect(order).toEqual(["config:gpt-new", "send"]);
        expect((await storage.getNativeAgentSession(keyOf(input)))?.controls?.modelId).toBe(
          "gpt-new",
        );
      },
    );
  });

  test("a non-durable update is not committed or sent, and retry after restart durably restores the model", async () => {
    let durable = false;
    let runtimeModel = "gpt-held";
    const delivered: string[] = [];
    const bridge = httpProvider((url, init) => {
      if (url.endsWith("/config")) {
        if (init.method === "POST") {
          runtimeModel = JSON.parse(String(init.body)).model;
          return Response.json({ durable });
        }
        return Response.json({
          model: runtimeModel,
          mode: "build",
          fastMode: false,
          durable: true,
        });
      }
      if (url.endsWith("/prompt")) delivered.push(runtimeModel);
      if (url.endsWith("/attach")) return Response.json({ attached: true });
      return Response.json({ status: "processing" });
    }, codexConnection);
    const stub = createProviderStub("codex", {
      send: bridge.provider.send.bind(bridge.provider),
      updateInteractiveControls: bridge.provider.updateInteractiveControls!.bind(bridge.provider),
    });
    await withService(
      {
        invoke: invokeModels,
        prefix: "dispatch-model-durable-",
        provider: async () => stub.provider,
      },
      async ({ service, storage }) => {
        const input = identity("codex");
        await service.ensureSession({ ...input, model: "gpt-held" });
        const request = { ...input, prompt: "Run", requestId: "r1", model: "gpt-new" };
        await expect(service.dispatchPrompt(request)).rejects.toBeInstanceOf(
          ProviderUnavailableError,
        );
        expect(delivered).toEqual([]);
        expect((await storage.getNativeAgentSession(keyOf(input)))?.controls?.modelId).toBe(
          "gpt-held",
        );
        runtimeModel = "gpt-held"; // Restart restores the previously durable configuration.
        durable = true;
        await service.dispatchPrompt(request);
        expect(delivered).toEqual(["gpt-new"]);
        expect(
          bridge.requests.filter(
            ({ init }) => init.method === "POST" && String(init.body).includes('"model":"gpt-new"'),
          ),
        ).toHaveLength(2);
        expect((await storage.getNativeAgentSession(keyOf(input)))?.controls?.modelId).toBe(
          "gpt-new",
        );
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
