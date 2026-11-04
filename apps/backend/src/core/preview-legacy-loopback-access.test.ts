import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { LoopbackListenerOwnership } from "./preview-listener-ownership.js";
import { createPreviewHarness, type PreviewHarness } from "./preview-test-support.js";

/**
 * Which backend-host ports the legacy `browser/loopback/<port>/` route may
 * open (security report M2): only the verified binding of an enabled service
 * of the requesting environment, never a reserved port.
 */
describe("PreviewRuntime.legacyLoopbackPortAccess", () => {
  let harness: PreviewHarness;

  beforeEach(async () => {
    harness = await createPreviewHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  function publish(environmentId: string, containerId: string, ports: Record<number, number>) {
    harness.docker.containers.set(containerId, {
      id: `${containerId}-full-id`,
      environmentId,
      owner: harness.owner,
      ports: Object.fromEntries(
        Object.entries(ports).map(([container, host]) => [
          `${container}/tcp`,
          [{ HostIp: "127.0.0.1", HostPort: String(host) }],
        ]),
      ),
    });
  }

  async function settled() {
    await harness.runtime.init();
    await harness.runtime.registry.settle();
    return harness.runtime;
  }

  test("managed-process requests look up each listener and refuse a takeover inside the TTL", async () => {
    await harness.addLocalEnvironment("a", { entryPort: 3000 });
    await harness.addLocalEnvironment("b");
    let pid = 300;
    let lookups = 0;
    let ancestryWalks = 0;
    const runtime = harness.newRuntime({
      registry: { now: () => 1000, probeBackoffMs: [] },
      listenerOwnership: new LoopbackListenerOwnership({
        platform: "darwin",
        processCacheMs: 0,
        roots: () => [
          { environmentId: "a", pid: 100 },
          { environmentId: "b", pid: 400 },
        ],
        runCommand: async (command) => {
          if (command === "ps") {
            ancestryWalks += 1;
            return {
              stdout: [
                "100 1 Sun Oct 25 09:00:00 2026",
                "300 100 Sun Oct 25 09:01:00 2026",
                "400 1 Sun Oct 25 09:02:00 2026",
                "500 400 Sun Oct 25 09:03:00 2026",
              ].join("\n"),
            };
          }
          lookups += 1;
          return { stdout: `p${pid}\nf12\ntIPv4\nn127.0.0.1:3000\n` };
        },
      }),
    });
    await runtime.init();
    await runtime.registry.settle();
    const service = runtime.registry.snapshot({ environmentId: "a" }).services[0]!;
    expect(service.endpoint.ownership).toBe("managed-process");
    lookups = 0;
    ancestryWalks = 0;
    expect(await runtime.legacyLoopbackPortAccess(3000, "a")).toBe("allowed");
    expect(await runtime.legacyLoopbackPortAccess(3000, "a")).toBe("allowed");
    expect(lookups).toBe(2);
    expect(ancestryWalks).toBe(0);

    pid = 500;
    expect(await runtime.legacyLoopbackPortAccess(3000, "a")).toBe("unknown");
    expect(lookups).toBe(4);
    expect(ancestryWalks).toBe(1);
    expect(runtime.registry.serviceSnapshot(service.definition.serviceId)!.endpoint).toMatchObject({
      state: "unavailable",
      listener: "other-environment",
      endpointGeneration: service.endpoint.endpointGeneration + 1,
    });
    expect(await runtime.legacyLoopbackPortAccess(3000, "a")).toBe("unknown");
  });

  test("admits a container's verified published host port and nothing else", async () => {
    await harness.addContainerEnvironment("a", {
      entryPort: 3000,
      portMappings: [{ containerPort: 8080, hostPort: 18080, protocol: "tcp" }],
    });
    publish("a", "container-a", { 3000: 49152, 8080: 18080 });
    const runtime = await settled();

    expect(await runtime.legacyLoopbackPortAccess(49152, "a")).toBe("allowed");
    expect(await runtime.legacyLoopbackPortAccess(18080, "a")).toBe("allowed");
    // The application port inside the container is not a host port.
    expect(await runtime.legacyLoopbackPortAccess(3000, "a")).toBe("unknown");
    // Any other host port, listening or not.
    expect(await runtime.legacyLoopbackPortAccess(49153, "a")).toBe("unknown");
  });

  test("admits a port only for the environment that owns it", async () => {
    await harness.addContainerEnvironment("a", { entryPort: 3000 });
    await harness.addContainerEnvironment("b", { entryPort: 3000 });
    publish("a", "container-a", { 3000: 49152 });
    publish("b", "container-b", { 3000: 49153 });
    const runtime = await settled();

    expect(await runtime.legacyLoopbackPortAccess(49152, "a")).toBe("allowed");
    expect(await runtime.legacyLoopbackPortAccess(49153, "b")).toBe("allowed");
    // Another environment's verified binding is not a target of this one.
    expect(await runtime.legacyLoopbackPortAccess(49153, "a")).toBe("unknown");
    expect(await runtime.legacyLoopbackPortAccess(49152, "b")).toBe("unknown");
    expect(await runtime.legacyLoopbackPortAccess(49152, "missing")).toBe("unknown");
    // A request naming no environment (an older desktop) opens nothing.
    expect(await runtime.legacyLoopbackPortAccess(49152, null)).toBe("unscoped");
  });

  test("forgets a binding once the service loses it", async () => {
    await harness.addContainerEnvironment("a", { entryPort: 3000 });
    publish("a", "container-a", { 3000: 49152 });
    const runtime = await settled();
    expect(await runtime.legacyLoopbackPortAccess(49152, "a")).toBe("allowed");

    await harness.storage.updateEnvironment("a", { status: "stopped" });
    await runtime.registry.settle();
    expect(await runtime.legacyLoopbackPortAccess(49152, "a")).toBe("unknown");
  });

  test("an unpublished container port is never admitted", async () => {
    await harness.addContainerEnvironment("a", { entryPort: 3000 });
    publish("a", "container-a", {});
    const runtime = await settled();
    expect(await runtime.legacyLoopbackPortAccess(3000, "a")).toBe("unknown");
  });

  test("a healthy relay target never admits its container application port", async () => {
    await harness.addContainerEnvironment("a", { entryPort: 3000 });
    publish("a", "container-a", {});
    const healthy = spyOn(harness.runtime.relay, "healthy").mockReturnValue(true);
    try {
      await harness.runtime.updateSettings((current) => ({ ...current, relay: true }));
      const runtime = await settled();
      const service = runtime.registry.snapshot({ environmentId: "a" }).services[0]!;
      expect(service.endpoint.state).toBe("available");
      expect(service.endpoint.transportKind).toBe("container-relay");
      expect(await runtime.legacyLoopbackPortAccess(3000, "a")).toBe("unknown");
    } finally {
      healthy.mockRestore();
    }
  });

  test("rechecks generation after asynchronous target acquisition", async () => {
    await harness.addContainerEnvironment("a", { entryPort: 3000 });
    publish("a", "container-a", { 3000: 49152 });
    const runtime = await settled();
    const service = runtime.registry.snapshot({ environmentId: "a" }).services[0]!;
    const target = await runtime.registry.acquireTarget(
      service.definition.serviceId,
      service.endpoint.endpointGeneration,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const acquire = spyOn(runtime.registry, "acquireTarget").mockImplementation(async () => {
      entered();
      await gate;
      return target;
    });
    try {
      const access = runtime.legacyLoopbackPortAccess(49152, "a");
      await started;
      await runtime.registry.update(
        service.definition.serviceId,
        service.definition.definitionRevision,
        { enabled: false },
      );
      release();
      expect(await access).toBe("unknown");
    } finally {
      release();
      acquire.mockRestore();
    }
  });

  test("reserved ports win over a verified binding", async () => {
    await harness.addContainerEnvironment("a", { entryPort: 3000 });
    publish("a", "container-a", { 3000: 49152 });
    const runtime = await settled();

    runtime.reservePorts("gateway", [49152]);
    expect(await runtime.legacyLoopbackPortAccess(49152, "a")).toBe("reserved");
    expect(await runtime.legacyLoopbackPortAccess(49152, null)).toBe("reserved");
    // Docker's daemon ports are always reserved.
    expect(await runtime.legacyLoopbackPortAccess(2375, "a")).toBe("reserved");
    expect(await runtime.legacyLoopbackPortAccess(2376, "a")).toBe("reserved");
  });
});
