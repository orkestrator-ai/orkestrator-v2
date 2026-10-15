import { describe, expect, mock, test } from "bun:test";
import { OpenCodeMessageIdCoordinator } from "@orkestrator/protocol/opencode-message-id";
import { openCodeFake } from "./agent-provider-test-support.js";
import { createBuildPipelineProvider } from "./build-pipeline-provider.js";
import { OPENCODE_GO_ONLY_PROVIDER_LIST_RESPONSE } from "./opencode-provider-list-test-fixtures.js";

/** An OpenCode workflow provider on a login with only `opencode-go` connected. */
function goOnlyProvider(model?: string) {
  const fake = openCodeFake();
  Object.assign(fake.client as object, {
    provider: { list: mock(async () => ({ data: OPENCODE_GO_ONLY_PROVIDER_LIST_RESPONSE })) },
  });
  const provider = createBuildPipelineProvider(
    {
      agent: "opencode",
      baseUrl: "http://opencode.test",
      authToken: "test-token",
      directory: "/workspace",
      ...(model ? { model } : {}),
    },
    {
      openCodeClient: fake.client,
      openCodeMessageIdCoordinator: new OpenCodeMessageIdCoordinator(),
      autoAnswerRequests: false,
    },
  );
  return { fake, provider };
}

describe("createBuildPipelineProvider", () => {
  // Multi Review and looped review pass a launcher's "Default" through as no
  // model. OpenCode's own server default ignores the provider allowlist, so the
  // session starts on the effective default instead, and its turns name it.
  test("starts an unpinned session on the effective default and sends it", async () => {
    const { fake, provider } = goOnlyProvider();
    try {
      const sessionId = await provider.createSession("review", "Multi Review · Reviewer");
      expect(fake.createCalls[0]?.model).toEqual({ providerID: "opencode-go", id: "gpt-5.6-luna" });

      await provider.send(sessionId, "Review the change", { requestId: "request-1" });
      expect(fake.promptCalls[0]?.model).toMatchObject({
        providerID: "opencode-go",
        modelID: "gpt-5.6-luna",
      });
    } finally {
      await provider.dispose?.();
    }
  });

  test("leaves a pinned session and a turn's own model alone", async () => {
    const { fake, provider } = goOnlyProvider();
    try {
      const pinned = await provider.createSession("review", "Pinned", {
        model: "opencode-go/deepseek-v4.1-flash",
      });
      expect(fake.createCalls[0]?.model).toEqual({
        providerID: "opencode-go",
        id: "deepseek-v4.1-flash",
      });
      await provider.send(pinned, "Go", { requestId: "request-1" });
      expect(fake.promptCalls[0]?.model).toBeUndefined();

      const unpinned = await provider.createSession("review", "Unpinned");
      await provider.send(unpinned, "Go", {
        requestId: "request-2",
        model: "opencode-go/mimo-v2.6-pro",
      });
      expect(fake.promptCalls[1]?.model).toMatchObject({ modelID: "mimo-v2.6-pro" });
    } finally {
      await provider.dispose?.();
    }
  });

  test("defers to a connection that names its own model", async () => {
    const { fake, provider } = goOnlyProvider("opencode-go/deepseek-v4.1-flash");
    try {
      await provider.createSession("review", "Connection default");
      expect(fake.createCalls[0]?.model).toBeUndefined();
    } finally {
      await provider.dispose?.();
    }
  });
});
