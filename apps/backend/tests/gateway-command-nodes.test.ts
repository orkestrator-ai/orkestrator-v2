import { describe, expect, mock, test } from "bun:test";
import { createServer } from "node:http";
import {
  BACKEND_CAPABILITIES,
  BACKEND_HELLO_PATH,
  parseBackendHello,
} from "@orkestrator/protocol/backend-profile";
import { CONTROLLER_HEADER } from "@orkestrator/protocol/command-nodes";
import type { BackendHelloIdentity } from "../src/gateway";
import { requestUrl, startGateway } from "./gateway-test-harness.js";

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

function hooks(allowed: string[]) {
  return {
    isPortalOriginAllowed: mock((origin: string) => allowed.includes(origin)),
    noteControllerContact: mock((_id: string) => undefined),
  };
}

describe("AT-05 hello for command nodes", () => {
  test("advertises node attachment and the node's mode", async () => {
    const { info } = await startGateway({ backendHello: async () => identity });
    const response = await requestUrl(new URL(BACKEND_HELLO_PATH, info.url).toString(), {
      headers: { authorization: `Bearer ${info.token}` },
    });
    const hello = parseBackendHello(response.json());
    expect(hello.capabilities[BACKEND_CAPABILITIES.nodeAttachment]).toBe(1);
    expect(hello.nodeMode).toBe("leaf");
  });

  test("an identity without a node mode does not claim the capability", async () => {
    const { nodeMode: _omit, ...older } = identity;
    const { info } = await startGateway({ backendHello: async () => older });
    const response = await requestUrl(new URL(BACKEND_HELLO_PATH, info.url).toString(), {
      headers: { authorization: `Bearer ${info.token}` },
    });
    const hello = parseBackendHello(response.json());
    expect(hello.capabilities[BACKEND_CAPABILITIES.nodeAttachment]).toBeUndefined();
    expect(hello.nodeMode).toBeUndefined();
  });
});

describe("AT-03 attached command nodes' portal origins", () => {
  test("are allowed by CORS; other origins are not", async () => {
    const nodeHooks = hooks(["https://command.example.ts.net"]);
    const { info } = await startGateway({ backendHello: async () => identity, nodeHooks });
    const url = new URL(BACKEND_HELLO_PATH, info.url).toString();
    const allowed = await requestUrl(url, {
      method: "OPTIONS",
      headers: {
        origin: "https://command.example.ts.net",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://command.example.ts.net");

    const refused = await requestUrl(url, {
      method: "OPTIONS",
      headers: { origin: "https://elsewhere.example", "access-control-request-method": "GET" },
    });
    expect(refused.status).toBe(403);
  });
});

describe("AT-04 controller contact", () => {
  test("is recorded only for authenticated requests", async () => {
    const nodeHooks = hooks([]);
    const { info } = await startGateway({ backendHello: async () => identity, nodeHooks });
    const url = new URL(BACKEND_HELLO_PATH, info.url).toString();
    await requestUrl(url, { headers: { [CONTROLLER_HEADER]: "bk_command" } });
    expect(nodeHooks.noteControllerContact).not.toHaveBeenCalled();

    await requestUrl(url, {
      headers: { authorization: `Bearer ${info.token}`, [CONTROLLER_HEADER]: "bk_command" },
    });
    expect(nodeHooks.noteControllerContact).toHaveBeenCalledWith("bk_command");
  });
});

describe("DP-02 client grants at the leaf's gateway", () => {
  function grantHooks(grant: string) {
    return {
      ...hooks([]),
      authenticateGrant: (token: string) => (token === grant ? Date.now() + 60_000 : null),
    };
  }

  test("a grant runs ordinary commands but never administrative ones or other routes", async () => {
    const grant = "okg_abc.secret";
    const invoke = mock(async () => ({ ok: true }));
    const { info } = await startGateway({
      backend: { invoke },
      backendHello: async () => identity,
      nodeHooks: grantHooks(grant),
    });
    const headers = { authorization: `Bearer ${grant}`, "content-type": "application/json" };
    const ordinary = await requestUrl(new URL("/__orkestrator/invoke", info.url).toString(), {
      method: "POST",
      headers,
      body: JSON.stringify({ command: "get_projects", args: {} }),
    });
    expect(ordinary.status).toBe(200);
    for (const command of [
      "create_client_grant",
      "attach_controller",
      "add_node",
      "preview_command_handover",
      "hand_over_command",
      "accept_command_handover",
      "list_nodes",
      "deliver_node_mail",
      "record_node_environment_origin",
      "read_node_file",
      "begin_node_file_write",
    ]) {
      const refused = await requestUrl(new URL("/__orkestrator/invoke", info.url).toString(), {
        method: "POST",
        headers,
        body: JSON.stringify({
          command,
          args: {
            controllerId: "bk_attached",
            scope: { seedEnvironmentId: ".." },
            path: "gateway-auth.json",
          },
        }),
      });
      expect(refused.status).toBe(403);
    }
    expect(invoke).toHaveBeenCalledTimes(1);
    for (const route of [
      "/__orkestrator/gateway-settings",
      "/__orkestrator/metrics",
      "/__orkestrator/nodes/bk_x/__orkestrator/hello",
    ]) {
      expect((await requestUrl(new URL(route, info.url).toString(), { headers })).status).toBe(403);
    }
    const hello = await requestUrl(new URL(BACKEND_HELLO_PATH, info.url).toString(), { headers });
    expect(hello.status).toBe(200);
    // An unknown grant-looking token is just unauthenticated.
    expect(
      (
        await requestUrl(new URL(BACKEND_HELLO_PATH, info.url).toString(), {
          headers: { authorization: "Bearer okg_other.x" },
        })
      ).status,
    ).toBe(401);
  });
});

describe("DP-03 relay through the command node", () => {
  test("forwards client API traffic with the leaf's credential, never the client's", async () => {
    const seen: Array<{
      url: string;
      authorization?: string;
      controller?: string;
      cookie?: string;
    }> = [];
    const leaf = createServer((request, response) => {
      seen.push({
        url: request.url ?? "",
        authorization: request.headers.authorization,
        controller: request.headers[CONTROLLER_HEADER] as string | undefined,
        cookie: request.headers.cookie,
      });
      response.writeHead(200, { "content-type": "application/json", "set-cookie": "leaf=1" });
      response.end(JSON.stringify({ result: { relayed: true } }));
    });
    await new Promise<void>((resolve) => leaf.listen(0, "127.0.0.1", resolve));
    const port = (leaf.address() as { port: number }).port;
    try {
      const nodeHooks = {
        ...hooks([]),
        relayTarget: (nodeId: string) =>
          nodeId === "bk_leaf"
            ? {
                baseUrl: `http://127.0.0.1:${port}`,
                headers: { authorization: "Bearer leaf-token", [CONTROLLER_HEADER]: "bk_command" },
              }
            : null,
      };
      const { info } = await startGateway({ backendHello: async () => identity, nodeHooks });
      const relayed = await requestUrl(
        new URL("/__orkestrator/nodes/bk_leaf/__orkestrator/invoke", info.url).toString(),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${info.token}`,
            cookie: "orkestrator_gateway_auth=client",
            "content-type": "application/json",
          },
          body: JSON.stringify({ command: "get_projects", args: {} }),
        },
      );
      expect(relayed.status).toBe(200);
      expect(relayed.json()).toEqual({ result: { relayed: true } });
      expect(relayed.headers["set-cookie"]).toBeUndefined();
      expect(seen[0]).toEqual({
        url: "/__orkestrator/invoke",
        authorization: "Bearer leaf-token",
        controller: "bk_command",
        cookie: undefined,
      });
      // Administrative commands and unknown paths are not relayed.
      const refused = await requestUrl(
        new URL("/__orkestrator/nodes/bk_leaf/__orkestrator/invoke", info.url).toString(),
        {
          method: "POST",
          headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
          body: JSON.stringify({ command: "create_client_grant", args: {} }),
        },
      );
      expect(refused.status).toBe(403);
      for (const command of [
        "deliver_node_mail",
        "record_node_environment_origin",
        "read_node_file",
        "begin_node_file_write",
      ]) {
        const blocked = await requestUrl(
          new URL("/__orkestrator/nodes/bk_leaf/__orkestrator/invoke", info.url).toString(),
          {
            method: "POST",
            headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
            body: JSON.stringify({
              command,
              args: { controllerId: "bk_command", scope: { seedEnvironmentId: ".." } },
            }),
          },
        );
        expect(blocked.status).toBe(403);
      }
      expect(seen).toHaveLength(1);
      expect(
        (
          await requestUrl(
            new URL(
              "/__orkestrator/nodes/bk_leaf/__orkestrator/gateway-settings",
              info.url,
            ).toString(),
            {
              headers: { authorization: `Bearer ${info.token}` },
            },
          )
        ).status,
      ).toBe(404);
      // An unconnected node answers 503; an unauthenticated caller gets nothing.
      expect(
        (
          await requestUrl(
            new URL("/__orkestrator/nodes/bk_other/__orkestrator/hello", info.url).toString(),
            {
              headers: { authorization: `Bearer ${info.token}` },
            },
          )
        ).status,
      ).toBe(503);
      expect(
        (
          await requestUrl(
            new URL("/__orkestrator/nodes/bk_leaf/__orkestrator/hello", info.url).toString(),
          )
        ).status,
      ).toBe(401);
      expect(seen).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => leaf.close(() => resolve()));
    }
  });

  test("relays a terminal WebSocket to the leaf's terminal endpoint", async () => {
    const { info: leafInfo } = await startGateway({ backendHello: async () => identity });
    const nodeHooks = {
      ...hooks([]),
      relayTarget: () => ({
        baseUrl: leafInfo.url,
        headers: { authorization: `Bearer ${leafInfo.token}`, [CONTROLLER_HEADER]: "bk_command" },
      }),
    };
    const { info } = await startGateway({ backendHello: async () => identity, nodeHooks });
    const { WebSocket } = await import("ws");
    const { TERMINAL_WEBSOCKET_SUBPROTOCOL } =
      await import("@orkestrator/protocol/terminal-websocket");
    const socket = new WebSocket(
      `${info.url.replace(/^http/, "ws")}__orkestrator/nodes/bk_leaf/__orkestrator/terminal`,
      TERMINAL_WEBSOCKET_SUBPROTOCOL,
      {
        headers: {
          cookie: `orkestrator_gateway_auth=${info.token}`,
          origin: new URL(info.url).origin,
        },
      },
    );
    const firstText = await new Promise<string>((resolve, reject) => {
      socket.once("message", (data) => resolve(data.toString()));
      socket.once("error", reject);
      socket.once("unexpected-response", (_request, response) =>
        reject(new Error(`upgrade refused: ${response.statusCode}`)),
      );
    });
    expect(JSON.parse(firstText)).toMatchObject({ type: "ready" });
    socket.close();
  });
});
