import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { Readable, type Duplex } from "node:stream";

import { http1Request } from "@orkestrator/protocol/preview-http1";
import { previewErrorFromUnknown } from "@orkestrator/protocol/preview-services";

import {
  startPreviewFixture,
  type PreviewFixture,
} from "../../../test-fixtures/preview-app/server.ts";
import { createPreviewHarness, type PreviewHarness } from "./core/preview-test-support.js";
import { PREVIEW_RELAY_SCRIPT } from "./preview-relay-script.js";
import { PreviewRelaySupervisor, type RelayProcess } from "./preview-relay-supervisor.js";

/** Run the relay as a local process: same script, same stdio protocol, no Docker. */
function localSpawn(spawned: RelayProcess[]) {
  return (_containerId: string): RelayProcess => {
    const child = spawn(process.execPath, ["-e", PREVIEW_RELAY_SCRIPT], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    spawned.push(child);
    return child;
  };
}

async function readAll(body: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function get(channel: Duplex, path: string) {
  return http1Request(channel, {
    method: "GET",
    path,
    headers: [["host", "127.0.0.1"]],
    headersTimeoutMs: 5_000,
    maxHeaderBytes: 64 * 1024,
    maxHeaderFields: 100,
  });
}

function category(error: unknown): string | undefined {
  return previewErrorFromUnknown(error)?.category;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("PreviewRelaySupervisor (local relay process)", () => {
  let fixture: PreviewFixture;
  let allowed: number[];
  let spawned: RelayProcess[];
  let supervisor: PreviewRelaySupervisor;
  let now: number;
  const signal = new AbortController().signal;

  beforeEach(async () => {
    fixture = await startPreviewFixture({ marker: "relay" });
    allowed = [fixture.port];
    spawned = [];
    now = 1_000;
    supervisor = new PreviewRelaySupervisor({
      spawn: localSpawn(spawned),
      allowedPorts: () => allowed,
      window: 64 * 1024,
      now: () => now,
    });
  });

  afterEach(async () => {
    supervisor.dispose();
    await fixture.close();
  });

  const target = (port = fixture.port, containerId = "container-a") => ({
    environmentId: "env-a",
    containerId,
    port,
  });

  test("carries HTTP byte-exactly and reuses one relay per environment", async () => {
    const first = await supervisor.connect(target(), signal);
    const response = await get(first, "/binary");
    const body = await readAll(response.body);
    const expected = response.headers.find(([name]) => name === "x-sha256")?.[1];
    expect(createHash("sha256").update(body).digest("hex")).toBe(expected!);

    const second = await supervisor.connect(target(), signal);
    const health = await get(second, "/health");
    expect(health.statusCode).toBe(200);
    await readAll(health.body);
    expect(spawned).toHaveLength(1);
    expect(fixture.requests.map((request) => request.path)).toEqual(["/binary", "/health"]);
  });

  test("uploads are delivered in order under credit flow control", async () => {
    const channel = await supervisor.connect(target(), signal);
    const payload = randomBytes(512 * 1024);
    const response = await http1Request(channel, {
      method: "POST",
      path: "/echo",
      headers: [["host", "127.0.0.1"]],
      body: Readable.from([payload]),
      bodyLength: payload.length,
      headersTimeoutMs: 5_000,
      maxHeaderBytes: 64 * 1024,
      maxHeaderFields: 100,
    });
    expect(response.statusCode).toBe(200);
    const echoed = JSON.parse((await readAll(response.body)).toString("utf8")) as {
      bytes: number;
      sha256: string;
    };
    expect(echoed.bytes).toBe(payload.length);
    expect(echoed.sha256).toBe(createHash("sha256").update(payload).digest("hex"));
  });

  test("the relay opens only ports the backend allows", async () => {
    allowed = [];
    const error = await rejection(supervisor.connect(target(), signal));
    expect(category(error)).toBe("forbidden");
    // Allowing the port later is pushed to the running relay.
    allowed = [fixture.port];
    const channel = await supervisor.connect(target(), signal);
    channel.destroy();
  });

  test("a closed port is connection-refused, not a stopped application", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const closedPort = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    allowed = [fixture.port, closedPort];
    const error = await rejection(supervisor.connect(target(closedPort), signal));
    expect(category(error)).toBe("connection-refused");
  });

  test("a stalled reader stops only its own channel", async () => {
    const stalled = await supervisor.connect(target(), signal);
    const endless = await get(stalled, "/endless");
    expect(endless.statusCode).toBe(200);
    // Never read the endless body: the relay may send at most one window.
    await Bun.sleep(100);
    const other = await supervisor.connect(target(), signal);
    const health = await get(other, "/health");
    expect(health.statusCode).toBe(200);
    await readAll(health.body);
    endless.body.destroy();
    stalled.destroy();
  });

  test("a crash fails open channels, backs off, and never replays", async () => {
    const channel = await supervisor.connect(target(), signal);
    const closed = new Promise<void>((resolve) => channel.once("close", () => resolve()));
    spawned[0]!.kill("SIGKILL");
    await closed;
    await Bun.sleep(20);
    expect(supervisor.healthy("env-a")).toBe(false);
    expect(category(await rejection(supervisor.connect(target(), signal)))).toBe(
      "backend-unavailable",
    );
    now += 1_001;
    expect(supervisor.healthy("env-a")).toBe(true);
    const again = await supervisor.connect(target(), signal);
    expect(spawned).toHaveLength(2);
    again.destroy();
  });

  test("stopping an environment or replacing its container is not a crash", async () => {
    const channel = await supervisor.connect(target(), signal);
    const closed = new Promise<void>((resolve) => channel.once("close", () => resolve()));
    supervisor.stopEnvironment("env-a");
    await closed;
    expect(supervisor.healthy("env-a")).toBe(true);

    await supervisor.connect(target(), signal);
    const replaced = await supervisor.connect(target(fixture.port, "container-b"), signal);
    expect(spawned).toHaveLength(3);
    expect(supervisor.healthy("env-a")).toBe(true);
    replaced.destroy();
    expect(supervisor.stats().relays).toBe(1);
  });

  test("channels per environment are bounded", async () => {
    const bounded = new PreviewRelaySupervisor({
      spawn: localSpawn(spawned),
      allowedPorts: () => allowed,
      maxChannelsPerEnvironment: 2,
    });
    try {
      await bounded.connect(target(), signal);
      await bounded.connect(target(), signal);
      expect(category(await rejection(bounded.connect(target(), signal)))).toBe(
        "capacity-exceeded",
      );
    } finally {
      bounded.dispose();
    }
  });
});

describe("relay-backed preview services", () => {
  let harness: PreviewHarness;
  let fixture: PreviewFixture;
  const spawned: RelayProcess[] = [];

  beforeEach(async () => {
    fixture = await startPreviewFixture({ marker: "relay-service" });
    harness = await createPreviewHarness({ relaySpawn: localSpawn(spawned) });
  });

  afterEach(async () => {
    await harness.cleanup();
    await fixture.close();
  });

  async function registerUnpublished(): Promise<string> {
    await harness.addContainerEnvironment("a");
    harness.docker.containers.set("container-a", {
      id: "container-a",
      environmentId: "a",
      owner: harness.owner,
      ports: {},
    });
    await harness.runtime.init();
    const result = await harness.runtime.registry.register({
      environmentId: "a",
      label: "api",
      targetKind: "container",
      applicationPort: fixture.port,
      scheme: "http",
    });
    if (result.kind !== "definition") throw new Error("expected a definition");
    return result.definition.serviceId;
  }

  test("an unpublished port stays unmapped while the relay is disabled", async () => {
    const serviceId = await registerUnpublished();
    const snapshot = await harness.runtime.registry.refresh(serviceId);
    expect(snapshot.endpoint.failure?.category).toBe("target-unmapped");
    expect(harness.runtime.capabilities().relay.available).toBe(false);
  });

  test("enabling the relay resolves the port through it; disabling stops it", async () => {
    const serviceId = await registerUnpublished();
    await harness.runtime.updateSettings((current) => ({
      ...current,
      relay: true,
    }));
    const snapshot = await harness.runtime.registry.refresh(serviceId, {
      probe: true,
    });
    expect(snapshot.endpoint.transportKind).toBe("container-relay");
    expect(snapshot.endpoint.readiness.tcp?.state).toBe("ok");

    const target = await harness.runtime.registry.acquireTarget(
      serviceId,
      snapshot.endpoint.endpointGeneration,
    );
    const channel = await harness.runtime.relayConnect(target, new AbortController().signal);
    const response = await get(channel, "/health");
    expect(response.statusCode).toBe(200);
    await readAll(response.body);
    expect(harness.runtime.diagnostics().relay).toMatchObject({
      available: true,
      relays: 1,
    });

    await harness.runtime.updateSettings((current) => ({
      ...current,
      relay: false,
    }));
    expect(harness.runtime.relay.stats().relays).toBe(0);
    expect(harness.runtime.registry.serviceSnapshot(serviceId)!.endpoint.failure?.category).toBe(
      "target-unmapped",
    );
  });

  test("environment lifecycle stops the environment's relay", async () => {
    const serviceId = await registerUnpublished();
    await harness.runtime.updateSettings((current) => ({
      ...current,
      relay: true,
    }));
    const snapshot = await harness.runtime.registry.refresh(serviceId);
    const target = await harness.runtime.registry.acquireTarget(
      serviceId,
      snapshot.endpoint.endpointGeneration,
    );
    const channel = await harness.runtime.relayConnect(target, new AbortController().signal);
    const closed = new Promise<void>((resolve) => channel.once("close", () => resolve()));
    harness.runtime.registry.beforeEnvironmentTargetChange("a");
    await closed;
    expect(harness.runtime.relay.stats().relays).toBe(0);
  });
});

const dockerImage = process.env.ORKESTRATOR_TEST_DOCKER_RELAY_IMAGE;
const dockerAvailable =
  Boolean(dockerImage) && spawnSync("docker", ["version"], { stdio: "ignore" }).status === 0;

/**
 * Opt-in: `ORKESTRATOR_TEST_DOCKER_RELAY_IMAGE=orkestrator-v2:latest`. Proves
 * the real `docker exec -i` path reaches an app listening only on container
 * loopback, with no published port.
 */
describe.skipIf(!dockerAvailable)("container relay through docker exec", () => {
  let containerId = "";

  beforeEach(() => {
    const run = spawnSync(
      "docker",
      [
        "run",
        "-d",
        "--rm",
        "--entrypoint",
        "sh",
        dockerImage!,
        "-c",
        `node -e 'require("node:http").createServer((q,s)=>s.end("in-container")).listen(4173,"127.0.0.1")' & sleep 120`,
      ],
      { encoding: "utf8" },
    );
    containerId = run.stdout.trim();
    expect(run.status).toBe(0);
  });

  afterEach(() => {
    if (containerId) spawnSync("docker", ["rm", "-f", containerId], { stdio: "ignore" });
  });

  test("reaches a loopback-only app inside the container", async () => {
    const supervisor = new PreviewRelaySupervisor({
      allowedPorts: () => [4173],
    });
    try {
      let channel: Duplex | null = null;
      for (let attempt = 0; attempt < 20 && !channel; attempt += 1) {
        try {
          channel = await supervisor.connect(
            { environmentId: "docker", containerId, port: 4173 },
            new AbortController().signal,
          );
        } catch (error) {
          if (category(error) !== "connection-refused") throw error;
          await Bun.sleep(250);
        }
      }
      const response = await get(channel!, "/");
      expect((await readAll(response.body)).toString("utf8")).toBe("in-container");
    } finally {
      supervisor.dispose();
    }
  }, 30_000);
});
