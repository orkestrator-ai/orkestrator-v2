import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";

import { fixturePreviewDefinition } from "@orkestrator/protocol/preview-contract-fixtures";

import { resolvePreviewTargetIntent } from "./preview-intent.js";
import { PreviewReadinessProber } from "./preview-readiness.js";
import type { ResolvedPreviewTarget } from "./preview-service-registry.js";
import { parseContainerInspection, selectLoopbackBinding } from "./preview-target-resolver.js";
import { createPreviewHarness, type PreviewHarness } from "./preview-test-support.js";

describe("docker binding selection", () => {
  test("parses inspect output including missing labels", () => {
    const parsed = parseContainerInspection(
      `abc\trunning\t<no value>\tenv\t{"3000/tcp":[{"HostIp":"127.0.0.1","HostPort":"49152"}],"53/udp":null}\n`,
    );
    expect(parsed).toEqual({
      id: "abc",
      status: "running",
      owner: "",
      environmentId: "env",
      ports: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }], "53/udp": null },
    });
    expect(parseContainerInspection("garbage")).toBeNull();
  });

  test("prefers an explicit IPv4 loopback binding and carries IPv6-only bindings", () => {
    expect(
      selectLoopbackBinding([
        { HostIp: "::", HostPort: "49153" },
        { HostIp: "0.0.0.0", HostPort: "49154" },
        { HostIp: "127.0.0.1", HostPort: "49155" },
      ]),
    ).toEqual({ host: "127.0.0.1", family: "ipv4", port: 49155 });
    expect(selectLoopbackBinding([{ HostIp: "::1", HostPort: "49156" }])).toEqual({
      host: "::1",
      family: "ipv6",
      port: 49156,
    });
    expect(selectLoopbackBinding([{ HostIp: "192.168.1.5", HostPort: "80" }])).toBeNull();
    expect(selectLoopbackBinding([{ HostIp: "127.0.0.1", HostPort: "049152" }])).toBeNull();
  });
});

describe("PreviewTargetResolver", () => {
  let harness: PreviewHarness;
  beforeEach(async () => {
    harness = await createPreviewHarness();
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  async function serviceFor(environmentId: string) {
    await harness.runtime.init();
    await harness.runtime.registry.settle();
    return harness.runtime.registry.snapshot({ environmentId }).services[0]!;
  }

  test("refuses a container that belongs to another environment or owner", async () => {
    await harness.addContainerEnvironment("a", { entryPort: 3000 });
    harness.docker.containers.set("container-a", {
      id: "container-a",
      environmentId: "someone-else",
      owner: harness.owner,
      ports: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }] },
    });
    expect((await serviceFor("a")).endpoint.failure?.category).toBe("target-unverified");

    harness.docker.containers.set("container-a", {
      id: "container-a",
      environmentId: "a",
      owner: "other-profile",
      ports: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }] },
    });
    const service = await harness.runtime.registry.refresh(
      (await serviceFor("a")).definition.serviceId,
    );
    expect(service.endpoint.failure?.category).toBe("target-unverified");
  });

  test("a missing container reports a stopped environment, not a port", async () => {
    await harness.addContainerEnvironment("a", { entryPort: 3000 });
    const service = await serviceFor("a");
    expect(service.endpoint.failure?.category).toBe("environment-stopped");
    expect(service.endpoint.readiness.environment.lifecycle).toBe("missing");
  });

  test("docker failures are bounded and not cached", async () => {
    await harness.addContainerEnvironment("a", { entryPort: 3000 });
    harness.docker.failure = new Error("Cannot connect to the Docker daemon");
    const service = await serviceFor("a");
    expect(service.endpoint.failure?.category).toBe("backend-unavailable");
    harness.docker.failure = null;
    harness.docker.containers.set("container-a", {
      id: "container-a",
      environmentId: "a",
      owner: harness.owner,
      ports: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }] },
    });
    const retried = await harness.runtime.registry.refresh(service.definition.serviceId);
    expect(retried.endpoint.state).toBe("available");
  });

  test("coalesces inspection across services in one container", async () => {
    await harness.addContainerEnvironment("a", {
      entryPort: 3000,
      portMappings: [{ containerPort: 8080, hostPort: 18080, protocol: "tcp" }],
    });
    harness.docker.containers.set("container-a", {
      id: "container-a",
      environmentId: "a",
      owner: harness.owner,
      ports: {
        "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }],
        "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "18080" }],
      },
    });
    await serviceFor("a");
    expect(harness.docker.inspectCount()).toBe(1);
  });

  test("refuses reserved Orkestrator ports for backend-host targets", async () => {
    await harness.addLocalEnvironment("local");
    await harness.runtime.init();
    harness.runtime.reservePorts("gateway", [34121]);
    const created = await harness.runtime.registry.register({
      environmentId: "local",
      label: "gateway",
      targetKind: "backend-host",
      applicationPort: 34121,
    });
    if (created.kind !== "definition") throw new Error("expected definition");
    const service = await harness.runtime.registry.refresh(created.definition.serviceId);
    expect(service.endpoint.failure?.category).toBe("forbidden");
    for (const port of [2375, 2376]) {
      const docker = await harness.runtime.registry.register({
        environmentId: "local",
        label: `docker ${port}`,
        targetKind: "backend-host",
        applicationPort: port,
      });
      if (docker.kind !== "definition") throw new Error("expected definition");
      expect(
        (await harness.runtime.registry.refresh(docker.definition.serviceId)).endpoint.failure
          ?.category,
      ).toBe("forbidden");
    }
  });

  test("container agent servers are never preview targets, published or relayed", async () => {
    await harness.addContainerEnvironment("a");
    harness.docker.containers.set("container-a", {
      id: "container-a",
      environmentId: "a",
      owner: harness.owner,
      ports: { "4097/tcp": [{ HostIp: "127.0.0.1", HostPort: "51000" }] },
    });
    await harness.runtime.init();
    await harness.runtime.updateSettings((current) => ({ ...current, relay: true }));
    for (const port of [4096, 4097, 4101]) {
      const created = await harness.runtime.registry.register({
        environmentId: "a",
        label: `agent ${port}`,
        targetKind: "container",
        applicationPort: port,
      });
      if (created.kind !== "definition") throw new Error("expected definition");
      const service = await harness.runtime.registry.refresh(created.definition.serviceId);
      expect(service.endpoint.failure?.category).toBe("forbidden");
      expect(service.endpoint.hostPort).toBeNull();
    }
  });

  test("worktree services require a running local environment and carry their family", async () => {
    await harness.addLocalEnvironment("local");
    await harness.runtime.init();
    const created = await harness.runtime.registry.register({
      environmentId: "local",
      label: "web",
      targetKind: "worktree",
      applicationPort: 5173,
      addressFamily: "ipv6",
    });
    if (created.kind !== "definition") throw new Error("expected definition");
    const available = await harness.runtime.registry.refresh(created.definition.serviceId);
    expect(available.endpoint).toMatchObject({
      state: "available",
      addressFamily: "ipv6",
      ownership: "user-registered",
    });
    await harness.storage.updateEnvironment("local", { status: "stopped" });
    await harness.runtime.registry.settle();
    const stopped = harness.runtime.registry.serviceSnapshot(created.definition.serviceId)!;
    expect(stopped.endpoint.failure?.category).toBe("environment-stopped");
  });
});

describe("URL intent resolution", () => {
  let harness: PreviewHarness;
  beforeEach(async () => {
    harness = await createPreviewHarness();
    await harness.addContainerEnvironment("a", { entryPort: 3000 });
    await harness.addContainerEnvironment("b", { entryPort: 3000 });
    await harness.addLocalEnvironment("local");
    await harness.runtime.init();
    await harness.runtime.registry.settle();
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  const resolve = (args: Record<string, unknown>) =>
    resolvePreviewTargetIntent(harness.runtime.registry, args, (id) =>
      harness.storage.getEnvironment(id),
    );

  test("a container terminal link resolves in its own environment", async () => {
    const fromA = await resolve({
      intent: {
        url: "http://localhost:3000/app?q=1",
        source: "container-terminal",
        environmentId: "a",
      },
    });
    const fromB = await resolve({
      intent: { url: "http://0.0.0.0:3000/", source: "container-terminal", environmentId: "b" },
    });
    expect(fromA.kind).toBe("service");
    expect(fromB.kind).toBe("service");
    if (fromA.kind !== "service" || fromB.kind !== "service") return;
    expect(fromA.service.definition.environmentId).toBe("a");
    expect(fromA.path).toBe("/app?q=1");
    expect(fromB.service.definition.environmentId).toBe("b");
    expect(fromA.service.definition.serviceId).not.toBe(fromB.service.definition.serviceId);
  });

  test("an unregistered port suggests registration instead of guessing", async () => {
    const result = await resolve({
      intent: { url: "http://0.0.0.0:4000/", source: "container-terminal", environmentId: "a" },
    });
    expect(result).toMatchObject({
      kind: "unregistered",
      bindHint: true,
      suggestion: { targetKind: "container", applicationPort: 4000, scheme: "http" },
    });
  });

  test("manual backend-port mode is explicit", async () => {
    expect(
      await resolve({
        intent: {
          url: "http://localhost:3000/x",
          source: "address-bar",
          environmentId: "local",
          mode: "manual",
        },
      }),
    ).toEqual({
      kind: "manual",
      path: "/x",
      scheme: "http",
      hostPort: 3000,
    });
  });

  test("ambiguity produces a choice", async () => {
    await harness.runtime.registry.register({
      environmentId: "local",
      label: "one",
      targetKind: "worktree",
      applicationPort: 8000,
    });
    await harness.runtime.registry.register({
      environmentId: "local",
      label: "two",
      targetKind: "backend-host",
      applicationPort: 8000,
    });
    const result = await resolve({
      intent: {
        url: "http://localhost:8000/",
        source: "worktree-terminal",
        environmentId: "local",
      },
    });
    expect(result.kind).toBe("choose");
    if (result.kind === "choose") expect(result.candidates).toHaveLength(2);
  });

  test("service references are bound to their backend and environment", async () => {
    const service = harness.runtime.registry.snapshot({ environmentId: "a" }).services[0]!;
    const ref = {
      backendInstanceId: harness.runtime.registry.backendInstanceId,
      environmentId: "a",
      serviceId: service.definition.serviceId,
      path: "/",
    };
    expect((await resolve({ serviceRef: ref })).kind).toBe("service");
    await expect(resolve({ serviceRef: { ...ref, environmentId: "b" } })).rejects.toThrow(
      "not-found",
    );
    await expect(
      resolve({ serviceRef: { ...ref, backendInstanceId: "bk_another_backend_1" } }),
    ).rejects.toThrow("not-found");
  });
});

describe("PreviewReadinessProber", () => {
  const servers: Array<{ close(callback?: () => void): unknown }> = [];
  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  function target(port: number): ResolvedPreviewTarget {
    return {
      transportKind: "backend-loopback",
      host: "127.0.0.1",
      port,
      addressFamily: "ipv4",
      containerId: null,
      ownership: "user-registered",
      bindingKey: `loopback:ipv4:${port}`,
      tls: null,
    };
  }

  async function listen(server: Server): Promise<number> {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  }

  test("reports a refused TCP connection without probing HTTP", async () => {
    const closed = createNetServer();
    const port = await new Promise<number>((resolve) =>
      closed.listen(0, "127.0.0.1", () => resolve((closed.address() as AddressInfo).port)),
    );
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const layers = await new PreviewReadinessProber().probe(
      fixturePreviewDefinition({ readinessPath: "/health" }),
      target(port),
      new AbortController().signal,
    );
    expect(layers).toEqual({
      tcp: { state: "failed", failure: "connection-refused" },
      tls: { state: "skipped" },
      http: { state: "skipped" },
    });
  });

  test("401/404 are reachable responses, and HEAD 405 falls back to a bounded GET", async () => {
    const methods: string[] = [];
    const port = await listen(
      createHttpServer((request, response) => {
        methods.push(request.method ?? "");
        response.statusCode = request.method === "HEAD" ? 405 : 401;
        response.end("x".repeat(200_000));
      }),
    );
    const layers = await new PreviewReadinessProber().probe(
      fixturePreviewDefinition({ readinessPath: "/health" }),
      target(port),
      new AbortController().signal,
    );
    expect(layers.http).toEqual({ state: "ok", statusClass: "4xx" });
    expect(methods).toEqual(["HEAD", "GET"]);
  });

  test("a header stall becomes headers-timeout", async () => {
    const port = await listen(createHttpServer(() => undefined));
    const layers = await new PreviewReadinessProber({ headersTimeoutMs: 50 }).probe(
      fixturePreviewDefinition({ readinessPath: "/health" }),
      target(port),
      new AbortController().signal,
    );
    expect(layers.http).toEqual({ state: "failed", failure: "headers-timeout" });
  });

  test("probe concurrency and queue are bounded", async () => {
    const prober = new PreviewReadinessProber({
      concurrency: 1,
      queueMax: 1,
      connectTimeoutMs: 200,
    });
    const hold = createNetServer(() => undefined);
    const port = await new Promise<number>((resolve) =>
      hold.listen(0, "127.0.0.1", () => resolve((hold.address() as AddressInfo).port)),
    );
    servers.push(hold);
    const definition = fixturePreviewDefinition();
    const first = prober.probe(definition, target(port), new AbortController().signal);
    const second = prober.probe(definition, target(port), new AbortController().signal);
    await expect(
      prober.probe(definition, target(port), new AbortController().signal),
    ).rejects.toThrow("queue full");
    await Promise.all([first, second]);
    expect(prober.stats()).toEqual({ active: 0, queued: 0 });
  });
});
