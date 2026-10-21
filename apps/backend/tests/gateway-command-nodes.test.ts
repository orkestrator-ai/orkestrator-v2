import { describe, expect, mock, test } from "bun:test";
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
