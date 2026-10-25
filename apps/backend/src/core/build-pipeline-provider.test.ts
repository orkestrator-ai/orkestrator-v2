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
    },
  );
  return { fake, provider };
}

describe("createBuildPipelineProvider", () => {
  test("leaves a model-less Codex session unset without requesting the catalogue", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = createBuildPipelineProvider(
      { agent: "codex", baseUrl: "http://codex.test", authToken: "test-token" },
      {
        fetch: (async (input, init) => {
          requests.push({
            url: String(input),
            body: init?.body ? JSON.parse(String(init.body)) : {},
          });
          return Response.json({ sessionId: "codex-unpinned" });
        }) as typeof fetch,
      },
    );
    try {
      expect(await provider.createSession("review", "Default")).toBe("codex-unpinned");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("http://codex.test/session/create");
      expect(requests[0]?.body.model).toBeUndefined();
    } finally {
      await provider.dispose?.();
    }
  });

  test("recovers the durable session model after provider recreation", async () => {
    const first = goOnlyProvider();
    const sessionId = await first.provider.createSession("review", "Recover");
    await first.provider.dispose?.();
    const recovered = goOnlyProvider();
    recovered.fake.setSessionGetResponse(sessionId, {
      data: { id: sessionId, model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" } },
    });
    try {
      await recovered.provider.send(sessionId, "Continue", { requestId: "recovery-1" });
      expect(recovered.fake.promptCalls[0]?.model).toMatchObject({
        modelID: "deepseek-v4.1-flash",
      });
    } finally {
      await recovered.provider.dispose?.();
    }
  });

  test("a model-less retry retains the session model when the effective default changes", async () => {
    const { fake, provider } = goOnlyProvider();
    let fail = true;
    fake.setMessagesHandler(async () => {
      if (fail) {
        fail = false;
        throw new Error("read interrupted");
      }
      return { data: [] };
    });
    try {
      const sessionId = await provider.createSession("review", "Retry");
      await expect(
        provider.send(sessionId, "Continue", { requestId: "retry-1" }),
      ).rejects.toThrow();
      // A fresh resolution would change model. The durable session remains the
      // authority for retrying the same request.
      provider.resolveDefaultModel = async () => ({ modelId: "opencode-go/deepseek-v4.1-flash" });
      await provider.send(sessionId, "Continue", { requestId: "retry-1" });
      expect(fake.promptCalls[0]?.model).toMatchObject({ modelID: "gpt-5.6-luna" });
    } finally {
      await provider.dispose?.();
    }
  });

  test("preserves a disconnected explicit connection model and rejects before dispatch", async () => {
    const { fake, provider } = goOnlyProvider("opencode/claude-sonnet-5");
    try {
      const sessionId = await provider.createSession("review", "Pinned connection");
      await expect(provider.send(sessionId, "Go", { requestId: "pinned-1" })).rejects.toThrow(
        "not connected",
      );
      expect(fake.promptCalls).toHaveLength(0);
    } finally {
      await provider.dispose?.();
    }
  });

  for (const unavailable of ["throw", "empty"] as const) {
    test(`keeps an unresolved default unpinned when catalogue is ${unavailable}`, async () => {
      const { fake, provider } = goOnlyProvider();
      Object.assign(fake.client as object, {
        provider: {
          list: async () => {
            if (unavailable === "throw") throw new Error("unavailable");
            return { data: { all: [], connected: [] } };
          },
        },
      });
      try {
        const sessionId = await provider.createSession("review", "No default");
        expect(fake.createCalls[0]?.model).toBeUndefined();
        await provider.send(sessionId, "Go", { requestId: "unresolved-1" });
        expect(fake.promptCalls[0]?.model).toBeUndefined();
      } finally {
        await provider.dispose?.();
      }
    });
  }

  test("prefers OpenCode's configured connected model over the provider default map", async () => {
    const { fake, provider } = goOnlyProvider();
    Object.assign(fake.client as object, {
      config: { get: async () => ({ data: { model: "opencode-go/deepseek-v4.1-flash" } }) },
    });
    try {
      const sessionId = await provider.createSession("review", "Configured");
      expect(fake.createCalls[0]?.model).toMatchObject({ id: "deepseek-v4.1-flash" });
      await provider.send(sessionId, "Go", { requestId: "configured-1" });
      expect(fake.promptCalls[0]?.model).toMatchObject({ modelID: "deepseek-v4.1-flash" });
    } finally {
      await provider.dispose?.();
    }
  });

  test("preflight retains a configured default beyond the catalogue cap", async () => {
    const { fake, provider } = goOnlyProvider();
    const models = Object.fromEntries(
      Array.from({ length: 600 }, (_, index) => [`model-${index}`, { id: `model-${index}` }]),
    );
    Object.assign(fake.client as object, {
      config: { get: async () => ({ data: { model: "opencode-go/model-599" } }) },
      provider: {
        list: async () => ({
          data: {
            all: [{ id: "opencode-go", models }],
            connected: ["opencode-go"],
            default: { "opencode-go": "model-0" },
          },
        }),
      },
    });
    try {
      const sessionId = await provider.createSession("review", "Configured past cap");
      await provider.send(sessionId, "Go", { requestId: "configured-cap-1" });
      expect(fake.promptCalls[0]?.model).toMatchObject({ modelID: "model-599" });
      await expect(provider.resolveDefaultModel?.(undefined)).resolves.toEqual({
        modelId: "opencode-go/model-599",
      });
    } finally {
      await provider.dispose?.();
    }
  });

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
      expect(fake.promptCalls[0]?.model).toMatchObject({
        providerID: "opencode-go",
        modelID: "deepseek-v4.1-flash",
      });

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
