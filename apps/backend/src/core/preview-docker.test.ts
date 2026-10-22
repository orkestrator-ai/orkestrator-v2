import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createServer, type AddressInfo, type Server } from "node:net";

import { http1Request } from "@orkestrator/protocol/node/preview-http1";

import { connectPreviewUpstream } from "../preview-upstream.js";
import { publishedPortArguments } from "./commands-containers.js";
import { runCommand } from "./shell.js";
import { createPreviewHarness, type PreviewHarness } from "./preview-test-support.js";

/**
 * Opt-in owned-Docker journeys (same-port containers with a host decoy, then
 * recreation onto a reused port; an automatic `hostPort: 0` mapping published
 * by the backend's own arguments):
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

  function startContainer(
    environmentId: string,
    marker: string,
    publish = ["-p", `127.0.0.1::${internalPort}/tcp`],
  ): string {
    const id = docker([
      "run",
      "-d",
      "--rm",
      "--label",
      `orkestrator-owner=${harness.owner}`,
      "--label",
      `environment-id=${environmentId}`,
      ...publish,
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

    // Recreation: recreate A with a new host binding and put another fixture on
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

  test("an automatic mapping is published, seeded and followed through recreation", async () => {
    const portMappings = [
      {
        containerPort: internalPort,
        hostPort: 0,
        protocol: "tcp" as const,
        hostPortMode: "auto" as const,
      },
    ];
    // The arguments container creation uses, so Docker picks the host port.
    const publish = publishedPortArguments(portMappings, undefined);
    expect(publish).toEqual(["-p", `127.0.0.1::${internalPort}/tcp`]);
    const first = startContainer("auto", "container-auto", publish);
    await harness.addContainerEnvironment("auto", { containerId: first, portMappings });
    await harness.runtime.init();
    await harness.runtime.registry.settle();
    const seeded = harness.runtime.registry.snapshot({ environmentId: "auto" }).services;
    expect(seeded.map((service) => service.definition.applicationPort)).toEqual([internalPort]);
    const serviceId = seeded[0]!.definition.serviceId;

    const before = await body(serviceId);
    expect(before.marker).toBe("container-auto");
    // Docker's binding, never the container port (where the host decoy listens).
    expect(before.hostPort).not.toBe(internalPort);
    expect(before.hostPort).toBe(
      Number(
        docker(["port", first, `${internalPort}/tcp`])
          .split("\n")[0]!
          .split(":")
          .at(-1),
      ),
    );

    harness.runtime.registry.beforeEnvironmentTargetChange("auto");
    docker(["rm", "-f", first]);
    servers.push(await listen(before.hostPort, "impostor-on-old-auto-port"));
    const recreated = startContainer("auto", "container-auto-recreated", publish);
    await harness.storage.updateEnvironment("auto", { containerId: recreated });
    const after = await body(serviceId);
    expect(after.marker).toBe("container-auto-recreated");
    expect(after.hostPort).not.toBe(before.hostPort);
  }, 60_000);
});
