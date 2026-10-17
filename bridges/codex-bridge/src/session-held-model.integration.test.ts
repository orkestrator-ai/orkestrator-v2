import { describe, expect, test } from "bun:test";
import { harness } from "./app-server-runtime-test-harness.js";
import { createBuildPipelineProvider } from "../../../apps/backend/src/core/build-pipeline-provider.js";

// Real bridge runtime + JSON-RPC child + backend resolution/session creation.
// The fake HTTP boundary preserves the production /global/models wire shape.
describe("Codex default availability across account changes", () => {
  test.each([false, true])(
    "retains account B's default after an account switch (hidden=%s)",
    async (hidden) => {
      let account: "a" | "b" | null = "a";
      let reads = 0;
      const h = await harness({
        "account/logout": () => {
          account = null;
          return {};
        },
        "account/login/start": () => {
          account = "b";
          return {};
        },
        "model/list": () => {
          reads += 1;
          return {
            data: [
              {
                id: `model-${account}`,
                displayName: `Model ${account}`,
                hidden: account === "b" && hidden,
              },
              ...(account === "b" ? [{ id: "visible-b", displayName: "Visible B" }] : []),
            ],
            nextCursor: null,
          };
        },
      });
      expect((await h.runtime.listModels()).supportedModelIds).toEqual(["model-a"]);
      await h.runtime.logoutAuth();
      await h.runtime.beginAuthLogin();

      const provider = createBuildPipelineProvider(
        { agent: "codex", baseUrl: "http://codex.test", authToken: "test-token" },
        {
          fetch: (async (input, init) => {
            if (String(input).endsWith("/global/models")) {
              return Response.json(await h.runtime.listModels());
            }
            if (String(input).endsWith("/session/create")) {
              return Response.json(h.runtime.createSession(JSON.parse(String(init?.body))));
            }
            throw new Error("Unexpected bridge request");
          }) as typeof fetch,
        },
      );
      try {
        const resolved = await provider.resolveDefaultModel?.("model-b");
        expect(resolved).toEqual({ modelId: "model-b" });
        const sessionId = await provider.createSession("build", "Account B", {
          model: resolved?.modelId,
        });
        expect((await h.runtime.getConfig(sessionId))?.model).toBe("model-b");
        expect(reads).toBe(2);
      } finally {
        await provider.dispose?.();
      }
    },
  );
});
