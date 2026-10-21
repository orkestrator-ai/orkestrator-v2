/**
 * RG-04 with real OpenSSH: a command node's backend reaches a leaf only
 * through an SSH forward to a disposable sshd, verifies its identity with
 * the hello over the tunnel and attaches it. First-use host-key trust goes
 * through the command node, as the portal does it. Opt in with
 * ORKESTRATOR_SSH_INTEGRATION=1.
 */
import { afterAll, beforeAll, describe, expect } from "bun:test";
import { createServer, type Server } from "node:http";

import { BACKEND_HELLO_PATH, CLIENT_API_VERSION } from "@orkestrator/protocol/backend-profile";
import { CONTROLLER_HEADER } from "@orkestrator/protocol/command-nodes";

import type { CommandContext, CommandHandler } from "../src/core/commands-context.js";
import { registerNodeCommands } from "../src/core/commands-registry-nodes.js";
import { MemoryNodeStorage } from "../src/core/nodes/node-network-test-support.js";
import { NodeService } from "../src/core/nodes/node-service.js";
import {
  INTEGRATION_TIMEOUT_MS,
  SSH_INTEGRATION_ENABLED,
  SshFixture,
  realSshTest,
  type RunningSshd,
} from "../../desktop/tests/ssh/sshd-harness.js";

const LEAF_TOKEN = "leaf-gateway-token-0123456789";

let fx: SshFixture;
let sshd: RunningSshd;
let leafServer: Server;
let leafPort = 0;
let leaf: NodeService;
let command: NodeService;
const seenControllers: string[] = [];

function profile(name: string) {
  return {
    revision: 1,
    displayName: name,
    colorToken: "teal",
    updatedAt: "2026-10-21T00:00:00.000Z",
  };
}

describe("RG-04 SSH routes from the command node's backend", () => {
  beforeAll(async () => {
    if (!SSH_INTEGRATION_ENABLED) return;
    fx = new SshFixture("ork-node-ssh-");
    const hostKey = fx.keygen("host_key");
    const clientKey = fx.clientKey("client_key");
    sshd = await fx.startSshd("leaf", hostKey);
    fx.writeClientConfig({ "leaf-host": fx.hostBlock(sshd.port, clientKey) });

    // The leaf: its node commands behind a loopback gateway reachable only through sshd.
    leaf = new NodeService({
      storage: new MemoryNodeStorage("bk_ssh_leaf", profile("Leaf")),
      emit: () => undefined,
    });
    await leaf.start();
    const commands = new Map<string, CommandHandler>();
    registerNodeCommands((name, handler) => commands.set(name, handler));
    leafServer = createServer(async (request, response) => {
      if (request.headers.authorization !== `Bearer ${LEAF_TOKEN}`) {
        response.writeHead(401).end();
        return;
      }
      const controller = request.headers[CONTROLLER_HEADER];
      if (typeof controller === "string") {
        seenControllers.push(controller);
        leaf.noteControllerContact(controller);
      }
      if (request.url === BACKEND_HELLO_PATH) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            schemaVersion: 1,
            installationId: "bk_ssh_leaf",
            generation: "g1",
            appVersion: "9.9.9-test",
            clientApi: { minVersion: 1, maxVersion: CLIENT_API_VERSION },
            capabilities: { "node-attachment": 1, "backend-profile": 1 },
            profile: profile("Leaf"),
            endpointRole: "client",
            nodeMode: leaf.mode(),
          }),
        );
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      const { command: name, args } = JSON.parse(body) as {
        command: string;
        args: Record<string, unknown>;
      };
      try {
        const result = await commands.get(name)!(args ?? {}, {
          nodes: leaf,
        } as unknown as CommandContext);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ result }));
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        );
      }
    });
    await new Promise<void>((resolve) => leafServer.listen(0, "127.0.0.1", resolve));
    const address = leafServer.address();
    leafPort = typeof address === "object" && address ? address.port : 0;

    const supervisor = fx.supervisor();
    command = new NodeService({
      storage: new MemoryNodeStorage("bk_ssh_command", profile("Desk")),
      emit: () => undefined,
      forceRegistration: true,
      createSsh: () => supervisor,
    });
    await command.start();
  }, INTEGRATION_TIMEOUT_MS);

  afterAll(async () => {
    if (!SSH_INTEGRATION_ENABLED) return;
    await command?.stop();
    await leaf?.stop();
    await new Promise<void>((resolve) => leafServer?.close(() => resolve()));
    await fx.cleanup();
  }, INTEGRATION_TIMEOUT_MS);

  realSshTest(
    "an unknown host key is refused until trusted through the command node, then the leaf attaches over SSH",
    async () => {
      const route = {
        id: "ssh",
        kind: "ssh",
        enabled: true,
        destination: "leaf-host",
        remoteGatewayPort: leafPort,
      };
      await expect(command.addNode({ routes: [route], token: LEAF_TOKEN })).rejects.toThrow();

      const probe = await command.probeHostKey({ destination: "leaf-host" });
      expect(probe.fingerprints.length).toBeGreaterThan(0);
      await command.trustHostKey(probe.probeId);

      const view = await command.addNode({ routes: [route], token: LEAF_TOKEN });
      expect(view.connection.state).toBe("connected");
      expect(view.connection.activeRouteKind).toBe("ssh");
      expect(leaf.listControllers().map((entry) => entry.controllerId)).toEqual([
        "bk_ssh_command" as never,
      ]);
      expect(seenControllers).toContain("bk_ssh_command");
      expect(JSON.stringify(await command.listNodes())).not.toContain(LEAF_TOKEN);
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
