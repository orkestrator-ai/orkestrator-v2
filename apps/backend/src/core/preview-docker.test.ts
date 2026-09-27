import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createServer, type AddressInfo, type Server } from "node:net";

import { http1Request } from "@orkestrator/protocol/preview-http1";

import { connectPreviewUpstream } from "../preview-upstream.js";
import { runCommand } from "./commands-dependencies.js";
import { createPreviewHarness, type PreviewHarness } from "./preview-test-support.js";

/**
 * Opt-in owned-Docker journeys (plan step 14, journeys 2 and 4):
 * `ORKESTRATOR_TEST_DOCKER_PREVIEW_IMAGE=orkestrator-v2:latest`. Containers are
 * labelled with a throwaway owner namespace and removed afterwards; nothing
 * touches the user's environments.
 */
const image = process.env.ORKESTRATOR_TEST_DOCKER_PREVIEW_IMAGE;
const enabled =
  Boolean(image) && spawnSync("docker", ["version"], { stdio: "ignore" }).status === 0;

function docker(args: string[]): string {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function listen(port: number, marker: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      socket.once("data", () =>
        socket.end(
          `HTTP/1.1 200 OK\r\ncontent-length: ${marker.length}\r\nconnection: close\r\n\r\n${marker}`,
        ),
      );
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

describe.skipIf(!enabled)("preview services against owned Docker containers", () => {
  let harness: PreviewHarness;
  let internalPort: number;
  let decoy: Server;
  const containers: string[] = [];
  const servers: Server[] = [];

  function startContainer(environmentId: string, marker: string): string {
    const id = docker([
      "run",
      "-d",
      "--rm",
      "--label",
      `orkestrator-owner=${harness.owner}`,
      "--label",
      `environment-id=${environmentId}`,
      "-p",
      `127.0.0.1::${internalPort}/tcp`,
      "--entrypoint",
      "node",
      image!,
      "-e",
      `require("node:http").createServer((q,s)=>s.end(${JSON.stringify(marker)})).listen(${internalPort},"0.0.0.0");setTimeout(()=>{},3e5)`,
    ]);
    containers.push(id);
    return id;
  }

  async function body(serviceId: string): Promise<{ marker: string; hostPort: number }> {
    const snapshot = await harness.runtime.registry.refresh(serviceId);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const target = await harness.runtime.registry.acquireTarget(
          serviceId,
          snapshot.endpoint.endpointGeneration,
        );
        const socket = await connectPreviewUpstream(
          target,
          { connectTimeoutMs: 2_000 },
          new AbortController().signal,
        );
        const response = await http1Request(socket, {
          method: "GET",
          path: "/",
          headers: [["host", "localhost"]],
          headersTimeoutMs: 2_000,
          maxHeaderBytes: 16 * 1024,
          maxHeaderFields: 50,
        });
        const chunks: Buffer[] = [];
        for await (const chunk of response.body) chunks.push(chunk as Buffer);
        return { marker: Buffer.concat(chunks).toString("utf8"), hostPort: target.port };
      } catch {
        await Bun.sleep(250);
      }
    }
    throw new Error("service never answered");
  }

  async function register(environmentId: string): Promise<string> {
    const result = await harness.runtime.registry.register({
      environmentId,
      label: `app-${environmentId}`,
      targetKind: "container",
      applicationPort: internalPort,
      scheme: "http",
    });
    if (result.kind !== "definition") throw new Error("expected a definition");
    return result.definition.serviceId;
  }

  beforeAll(async () => {
    harness = await createPreviewHarness({
      runDocker: (args, { timeoutMs }) => runCommand("docker", args, { timeoutMs }),
    });
    internalPort = await freePort();
    // A decoy on the backend host at the same number as the container port.
    decoy = await listen(internalPort, "decoy-on-host");
    servers.push(decoy);
  });

  afterAll(async () => {
    for (const id of containers) spawnSync("docker", ["rm", "-f", id], { stdio: "ignore" });
    for (const server of servers) server.close();
    await harness?.cleanup();
  });

  test("two containers on the same internal port route by service, never to the host decoy", async () => {
    const a = startContainer("a", "container-a");
    const b = startContainer("b", "container-b");
    await harness.addContainerEnvironment("a", { containerId: a });
    await harness.addContainerEnvironment("b", { containerId: b });
    await harness.runtime.init();
    const serviceA = await register("a");
    const serviceB = await register("b");

    const first = await body(serviceA);
    const second = await body(serviceB);
    expect(first.marker).toBe("container-a");
    expect(second.marker).toBe("container-b");
    expect(first.hostPort).not.toBe(internalPort);
    expect(second.hostPort).not.toBe(first.hostPort);

    // Journey 4: recreate A with a new host binding and put another fixture on
    // A's old host port. The service follows A, not the reused port.
    const oldGeneration = harness.runtime.registry.currentGeneration(serviceA);
    harness.runtime.registry.beforeEnvironmentTargetChange("a");
    docker(["rm", "-f", a]);
    servers.push(await listen(first.hostPort, "impostor-on-old-port"));
    const recreated = startContainer("a", "container-a-recreated");
    await harness.storage.updateEnvironment("a", { containerId: recreated });
    const after = await body(serviceA);
    expect(after.marker).toBe("container-a-recreated");
    expect(after.hostPort).not.toBe(first.hostPort);
    expect(harness.runtime.registry.currentGeneration(serviceA)).not.toBe(oldGeneration);
    // B is untouched by A's lifecycle.
    expect((await body(serviceB)).marker).toBe("container-b");
  }, 60_000);
});
