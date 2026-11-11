import { describe, expect, test } from "bun:test";
import { createBuildPipelineProvider } from "./build-pipeline-provider.js";
import { FakeOpenCode2Server, fakeOpenCode2Model } from "./opencode2/fake-server.test-support.js";
import { OpenCode2Provider } from "./opencode2/provider.js";

/**
 * An OpenCode workflow provider on the environment's server, whose login
 * serves `opencode-go` only and whose own default is `opencode-go/gpt-5.6-luna`.
 */
function openCodeProvider(model?: string) {
  const server = new FakeOpenCode2Server();
  server.models = [
    fakeOpenCode2Model("opencode-go", "deepseek-v4.1-flash"),
    fakeOpenCode2Model("opencode-go", "gpt-5.6-luna"),
  ];
  server.defaultModel = server.models[1]!;
  const provider = createBuildPipelineProvider(
    {
      agent: "opencode",
      baseUrl: "http://opencode.test",
      authToken: "test-token",
      directory: "/workspace",
      ...(model ? { model } : {}),
    },
    {
      bridgeEnvironmentId: "env-1",
      openCodeWorkflow: (environmentId) => ({
        connection: async () => ({
          baseUrl: "http://127.0.0.1:1",
          password: "pw",
          directory: "/work",
          generation: environmentId,
        }),
        createProvider: () =>
          new OpenCode2Provider(server.client(), {
            monitorEvents: false,
            allowedModelProviders: async () => [],
          }),
      }),
    },
  );
  return { server, provider };
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

  // Multi Review passes a launcher's "Default" through as no model. OpenCode's
  // own server default ignores the provider allowlist, so the session starts on
  // the effective default instead.
  test("starts an unpinned OpenCode session on the effective default", async () => {
    const { server, provider } = openCodeProvider();
    try {
      const sessionId = await provider.createSession("review", "Multi Review · Reviewer");
      expect(server.sessions.get(sessionId)?.model).toMatchObject({
        providerID: "opencode-go",
        id: "gpt-5.6-luna",
      });
    } finally {
      await provider.dispose?.();
      server.stop();
    }
  });

  test("leaves a pinned OpenCode session alone", async () => {
    const { server, provider } = openCodeProvider();
    try {
      const pinned = await provider.createSession("review", "Pinned", {
        model: "opencode-go/deepseek-v4.1-flash",
      });
      expect(server.sessions.get(pinned)?.model).toMatchObject({
        providerID: "opencode-go",
        id: "deepseek-v4.1-flash",
      });
    } finally {
      await provider.dispose?.();
      server.stop();
    }
  });

  test("defers to a connection that names its own model", async () => {
    const { server, provider } = openCodeProvider("opencode-go/deepseek-v4.1-flash");
    try {
      const sessionId = await provider.createSession("review", "Connection default");
      // The connection's model is the session's; no default is resolved over it.
      expect(server.sessions.get(sessionId)?.model).toMatchObject({
        providerID: "opencode-go",
        id: "deepseek-v4.1-flash",
      });
    } finally {
      await provider.dispose?.();
      server.stop();
    }
  });
});
