import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { fakePid } from "@orkestrator/protocol/testing/fake-pids";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { agentAccountLoginKey } from "./agent-accounts/store.js";
import { LocalServerRuntime } from "./local-server-runtime.js";
import type { CommandContext } from "./commands-context.js";
import * as containerExec from "./commands-container-exec.js";
import * as containerCredentials from "./containers/bridge-credential.js";
import type { CodexModelCatalogEntry, Environment } from "./models.js";
import { fetchCodexBridgeModels, fetchCodexBridgeModelsAt } from "./codex-live-model-catalog.js";

const TOKEN = "test-bridge-token";
const liveModel: CodexModelCatalogEntry = {
  id: "gpt-6.2-sol",
  name: "GPT-6.2-Sol",
  description: "Fast, go-to model for coding and everyday work.",
  reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  defaultReasoningEffort: "high",
};

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(async () => {
  mock.restore();
  await server?.stop(true);
  server = undefined;
});

/** A stand-in Codex bridge answering `/global/models` with `body`. */
function serveModels(body: unknown, status = 200): number {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      if (new URL(request.url).pathname === "/global/health") return new Response(null);
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

describe("fetchCodexBridgeModels", () => {
  const environment = { id: "e1", environmentType: "containerized" } as Environment;
  const context = {} as CommandContext;

  test("looks up a local bridge without starting it and returns its launch login", async () => {
    const port = serveModels({ models: [liveModel], source: "app-server" });
    const local = { id: "e1", environmentType: "local", localCodexPort: port } as Environment;
    const localServers = new LocalServerRuntime();
    const child = { pid: fakePid(0), killed: false } as ChildProcessWithoutNullStreams;
    const key = "codex:e1";
    const accountLoginKey = agentAccountLoginKey();
    localServers.adoptProcess(key, child, { workingDirectory: "/fixture", accountLoginKey });
    localServers.recordBridgeToken("codex", local.id, TOKEN);
    const localContext = {
      runtime: { localServers },
      storage: { getEnvironment: async () => local },
    } as unknown as CommandContext;
    try {
      expect(await fetchCodexBridgeModels(local, localContext)).toEqual({
        status: "ok",
        models: [liveModel],
        accountLoginKey,
      });
      localServers.markLoginStale("codex");
      expect(await fetchCodexBridgeModels(local, localContext)).toEqual({
        status: "ok",
        models: [liveModel],
      });
    } finally {
      localServers.releaseOwnership(key, child);
    }
  });

  test("uses the running container's mapped port and token for an environment-only list", async () => {
    const port = serveModels({ models: [liveModel], source: "app-server" });
    const lookup = spyOn(containerExec, "getHostPort").mockResolvedValue(port);
    const credential = spyOn(containerCredentials, "readContainerBridgeToken").mockResolvedValue(
      TOKEN,
    );
    const response = await fetchCodexBridgeModels(
      { ...environment, containerId: "container-1" },
      context,
    );
    expect(response).toEqual({ status: "ok", models: [liveModel] });
    expect(lookup).toHaveBeenCalledWith("container-1", expect.any(Number));
    expect(credential).toHaveBeenCalledWith("container-1", "codex");
  });

  test("a containerized environment with no container ID is unavailable", async () => {
    const lookup = spyOn(containerExec, "getHostPort");
    expect(await fetchCodexBridgeModels(environment, context)).toEqual({
      status: "unavailable",
      models: [],
    });
    expect(lookup).not.toHaveBeenCalled();
  });
});
