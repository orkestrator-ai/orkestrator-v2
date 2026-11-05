import { describe, expect, mock, test } from "bun:test";
import { createServer } from "node:http";
import { redactGlobalConfig, stripRendererCredentials } from "../src/core/commands-validation.js";
import type { BackendHelloIdentity } from "../src/gateway";
import { requestUrl, startGateway } from "./gateway-test-harness.js";

/**
 * Security report I1: a workspace grant, and the relay that carries the same
 * client API, refuse the machine's global settings and host updates while a
 * workspace keeps its terminals.
 */

const identity: BackendHelloIdentity = {
  installationId: "bk_leaf-node",
  generation: "generation-1",
  appVersion: "9.9.9-test",
  profile: {
    revision: 1,
    displayName: "Leaf",
    colorToken: "teal",
    updatedAt: "2026-10-21T00:00:00.000Z",
  },
  nodeMode: "leaf",
};

const leafConfig = {
  global: redactGlobalConfig({
    terminalHistoryEnabled: true,
    allowedDomains: ["github.com"],
    favoriteModels: [{ platform: "claude", modelId: "leaf-model" }],
    githubToken: "",
  } as Parameters<typeof redactGlobalConfig>[0]),
  repositories: {},
};

/** What a realm from before `patch_global_config` sends when a model is favourited. */
const olderRealmFavouriteEcho = {
  global: {
    ...leafConfig.global,
    favoriteModels: [{ platform: "claude", modelId: "command-node-model" }],
  },
  preserveInheritedSettings: true,
};

const patchEcho = {
  patch: stripRendererCredentials(leafConfig.global),
  unset: ["absentSetting"],
};

const changingWrites: Array<[string, Record<string, unknown>]> = [
  [
    "update_global_config",
    {
      global: { ...leafConfig.global, allowedDomains: ["github.com", "example.com"] },
      preserveInheritedSettings: true,
    },
  ],
  ["patch_global_config", { patch: { defaultNetworkMode: "full" } }],
  ["save_config", { config: leafConfig }],
  ["set_workflow_result_tools_rollout", { mode: "enabled" }],
  ["web_annotations_rollout_set", { mode: "enabled" }],
  ["set_container_resource_limits", { memoryMb: 1024 }],
  ["docker_cleanup_preview", {}],
  ["docker_cleanup_execute", { token: "cleanup-token" }],
  ["save_desktop_connections", { desktopConnections: [] }],
  ...[
    "host.update.apply",
    "host.update.channel",
    "host.update.cancel",
    "host.toolchain.repair",
    "host.image.update",
    "host.gh.update",
    "run.retry",
  ].map((action): [string, Record<string, unknown>] => [
    "public_action",
    {
      schemaVersion: 1,
      actionVersion: 1,
      action,
      input: { confirm: true },
      request: { namespace: "test", requestId: "update-1" },
    },
  ]),
  ["request_host_update", {}],
  ["request_host_update_check", {}],
  ["set_host_update_channel", { channel: "unstable" }],
  ["set_github_token", { token: "ghp_example" }],
];

const terminalCommands: Array<[string, Record<string, unknown>]> = [
  ["start_local_terminal_session", { environmentId: "env-1" }],
  ["local_terminal_write", { sessionId: "term-1", data: "ls\n" }],
  ["start_terminal_session", { containerId: "c-1" }],
  ["terminal_write", { sessionId: "term-1", data: "ls\n" }],
];

describe("a client grant at the leaf's gateway", () => {
  const grant = "okg_scope.secret";
  const nodeHooks = {
    isPortalOriginAllowed: mock(() => false),
    noteControllerContact: mock(() => undefined),
    authenticateGrant: (token: string) => (token === grant ? Date.now() + 60_000 : null),
  };
  const headers = { authorization: `Bearer ${grant}`, "content-type": "application/json" };

  async function gatewayWithBackend() {
    const invoke = mock(async (command: string) => (command === "get_config" ? leafConfig : null));
    const { info } = await startGateway({
      backend: { invoke },
      backendHello: async () => identity,
      nodeHooks,
    });
    const call = (command: string, args: Record<string, unknown>) =>
      requestUrl(new URL("/__orkestrator/invoke", info.url).toString(), {
        method: "POST",
        headers,
        body: JSON.stringify({ command, args }),
      });
    return { invoke, call };
  }

  test("refuses global settings, credentials and host updates", async () => {
    const { invoke, call } = await gatewayWithBackend();
    for (const [command, args] of changingWrites) {
      const refused = await call(command, args);
      expect({ command, status: refused.status }).toEqual({ command, status: 403 });
    }
    // Only the reads that checked the two settings writes reached the backend.
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["get_config", "get_config"]);
  });

  test("still runs terminals", async () => {
    const { invoke, call } = await gatewayWithBackend();
    for (const [command, args] of terminalCommands) {
      expect((await call(command, args)).status).toBe(200);
    }
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(
      terminalCommands.map(([command]) => command),
    );
  });

  test("answers an older realm's unchanged settings echo without writing", async () => {
    const { invoke, call } = await gatewayWithBackend();
    const answered = await call("update_global_config", olderRealmFavouriteEcho);
    expect(answered.status).toBe(200);
    expect(answered.json()).toEqual({ result: leafConfig });
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["get_config"]);
  });

  test("answers a no-op patch with realistic redacted settings without writing", async () => {
    const { invoke, call } = await gatewayWithBackend();
    const answered = await call("patch_global_config", patchEcho);
    expect(answered.status).toBe(200);
    expect(answered.json()).toEqual({ result: leafConfig });
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["get_config"]);
  });

  test("refuses a settings write when the settings cannot be read", async () => {
    const invoke = mock(async () => {
      throw new Error("storage unavailable");
    });
    const { info } = await startGateway({
      backend: { invoke },
      backendHello: async () => identity,
      nodeHooks,
    });
    const refused = await requestUrl(new URL("/__orkestrator/invoke", info.url).toString(), {
      method: "POST",
      headers,
      body: JSON.stringify({ command: "update_global_config", args: olderRealmFavouriteEcho }),
    });
    expect(refused.status).toBe(403);
  });
});

describe("the relay through the command node", () => {
  async function relayToFakeLeaf(
    failure?: "disconnect" | "status" | "oversized" | "json" | "missing",
  ) {
    const seen: Array<{ command: string; authorization?: string }> = [];
    const leaf = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const { command } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          command: string;
        };
        seen.push({ command, authorization: request.headers.authorization });
        if (failure === "disconnect") {
          request.socket.destroy();
          return;
        }
        response.writeHead(failure === "status" ? 503 : 200, {
          "content-type": "application/json",
        });
        response.end(
          failure === "oversized"
            ? JSON.stringify({ result: leafConfig, padding: "x".repeat(4 * 1024 * 1024) })
            : failure === "json"
              ? "invalid JSON"
              : failure === "missing"
                ? "{}"
                : JSON.stringify({ result: command === "get_config" ? leafConfig : null }),
        );
      });
    });
    await new Promise<void>((resolve) => leaf.listen(0, "127.0.0.1", resolve));
    const port = (leaf.address() as { port: number }).port;
    const { info } = await startGateway({
      backendHello: async () => identity,
      nodeHooks: {
        isPortalOriginAllowed: mock(() => false),
        noteControllerContact: mock(() => undefined),
        relayTarget: (nodeId: string) =>
          nodeId === "bk_leaf"
            ? {
                baseUrl: `http://127.0.0.1:${port}`,
                headers: { authorization: "Bearer leaf-token" },
              }
            : null,
      },
    });
    const call = (command: string, args: Record<string, unknown>) =>
      requestUrl(
        new URL("/__orkestrator/nodes/bk_leaf/__orkestrator/invoke", info.url).toString(),
        {
          method: "POST",
          headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
          body: JSON.stringify({ command, args }),
        },
      );
    const close = () => new Promise<void>((resolve) => leaf.close(() => resolve()));
    return { seen, call, close };
  }

  test("refuses global settings, credentials and host updates; no write reaches the leaf", async () => {
    const { seen, call, close } = await relayToFakeLeaf();
    try {
      for (const [command, args] of changingWrites) {
        const refused = await call(command, args);
        expect({ command, status: refused.status }).toEqual({ command, status: 403 });
      }
      expect(seen).toEqual([
        { command: "get_config", authorization: "Bearer leaf-token" },
        { command: "get_config", authorization: "Bearer leaf-token" },
      ]);
    } finally {
      await close();
    }
  });

  test("still relays terminals", async () => {
    const { seen, call, close } = await relayToFakeLeaf();
    try {
      for (const [command, args] of terminalCommands) {
        expect((await call(command, args)).status).toBe(200);
      }
      expect(seen.map(({ command }) => command)).toEqual(
        terminalCommands.map(([command]) => command),
      );
    } finally {
      await close();
    }
  });

  test("answers an older realm's unchanged settings echo with the leaf's settings", async () => {
    const { seen, call, close } = await relayToFakeLeaf();
    try {
      const answered = await call("update_global_config", olderRealmFavouriteEcho);
      expect(answered.status).toBe(200);
      expect(answered.json()).toEqual({ result: leafConfig });
      expect(seen.map(({ command }) => command)).toEqual(["get_config"]);
    } finally {
      await close();
    }
  });
  test("answers a no-op patch with realistic redacted leaf settings without writing", async () => {
    const { seen, call, close } = await relayToFakeLeaf();
    try {
      const answered = await call("patch_global_config", patchEcho);
      expect(answered.status).toBe(200);
      expect(answered.json()).toEqual({ result: leafConfig });
      expect(seen.map(({ command }) => command)).toEqual(["get_config"]);
    } finally {
      await close();
    }
  });

  test.each(["disconnect", "status", "oversized", "json", "missing"] as const)(
    "fails closed on a %s config read without forwarding writes",
    async (failure) => {
      const { seen, call, close } = await relayToFakeLeaf(failure);
      try {
        for (const [command, args] of [
          ["update_global_config", olderRealmFavouriteEcho],
          ["patch_global_config", patchEcho],
        ] as const) {
          expect((await call(command, args)).status).toBe(403);
        }
        expect(seen.map(({ command }) => command)).toEqual(["get_config", "get_config"]);
      } finally {
        await close();
      }
    },
  );
});
