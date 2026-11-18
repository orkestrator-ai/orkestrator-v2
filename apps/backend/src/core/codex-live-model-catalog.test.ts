import { afterEach, describe, expect, test } from "bun:test";
import { fetchCodexBridgeModelsAt } from "./codex-live-model-catalog.js";

const TOKEN = "test-bridge-token";
const liveModel = {
  id: "gpt-6.2-sol",
  name: "GPT-6.2-Sol",
  description: "Fast, go-to model for coding and everyday work.",
  reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  defaultReasoningEffort: "high",
};

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(async () => {
  await server?.stop(true);
  server = undefined;
});

/** A stand-in Codex bridge answering `/global/models` with `body`. */
function serveModels(body: unknown, status = 200): number {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
        return new Response("unauthorized", { status: 401 });
      }
      if (new URL(request.url).pathname !== "/global/models") {
        return new Response("not found", { status: 404 });
      }
      return Response.json(body, { status });
    },
  });
  return server.port!;
}

describe("fetchCodexBridgeModelsAt", () => {
  test("returns a live app-server catalogue in the cached shape", async () => {
    const port = serveModels({ models: [liveModel], source: "app-server" });
    const result = await fetchCodexBridgeModelsAt(port, TOKEN);
    expect(result.status).toBe("ok");
    expect(result.models.map((model) => model.id)).toEqual(["gpt-6.2-sol"]);
    expect(result.models[0]?.reasoningEfforts).toContain("ultra");
  });

  test("never treats the bridge's own cached or bundled list as live", async () => {
    for (const source of ["cache", "fallback"]) {
      const port = serveModels({ models: [liveModel], source });
      expect(await fetchCodexBridgeModelsAt(port, TOKEN)).toEqual({ status: "failed", models: [] });
      await server?.stop(true);
    }
  });

  test("reports an empty, malformed or refused answer as failed", async () => {
    let port = serveModels({ models: [], source: "app-server" });
    expect((await fetchCodexBridgeModelsAt(port, TOKEN)).status).toBe("failed");
    await server?.stop(true);
    port = serveModels({
      models: [{ id: "x", name: "X", unexpected: true }],
      source: "app-server",
    });
    expect((await fetchCodexBridgeModelsAt(port, TOKEN)).status).toBe("failed");
    await server?.stop(true);
    port = serveModels({ error: "boom" }, 500);
    expect((await fetchCodexBridgeModelsAt(port, TOKEN)).status).toBe("failed");
    expect((await fetchCodexBridgeModelsAt(port, "wrong-token")).status).toBe("failed");
  });
});
