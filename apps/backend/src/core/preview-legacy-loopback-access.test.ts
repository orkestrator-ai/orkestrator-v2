import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { createPreviewHarness, type PreviewHarness } from "./preview-test-support.js";

/**
 * Which backend-host ports the legacy `browser/loopback/<port>/` route may
 * open (security report M2): only the verified binding of an enabled service,
 * never a reserved port.
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

  test("admits a container's verified published host port and nothing else", async () => {
    await harness.addContainerEnvironment("a", {
      entryPort: 3000,
      portMappings: [{ containerPort: 8080, hostPort: 18080, protocol: "tcp" }],
    });
    publish("a", "container-a", { 3000: 49152, 8080: 18080 });
    const runtime = await settled();

    expect(await runtime.legacyLoopbackPortAccess(49152)).toBe("allowed");
    expect(await runtime.legacyLoopbackPortAccess(18080)).toBe("allowed");
    // The application port inside the container is not a host port.
    expect(await runtime.legacyLoopbackPortAccess(3000)).toBe("unknown");
    // Any other host port, listening or not.
    expect(await runtime.legacyLoopbackPortAccess(49153)).toBe("unknown");
  });

  test("forgets a binding once the service loses it", async () => {
    await harness.addContainerEnvironment("a", { entryPort: 3000 });
    publish("a", "container-a", { 3000: 49152 });
    const runtime = await settled();
    expect(await runtime.legacyLoopbackPortAccess(49152)).toBe("allowed");

    await harness.storage.updateEnvironment("a", { status: "stopped" });
    await runtime.registry.settle();
    expect(await runtime.legacyLoopbackPortAccess(49152)).toBe("unknown");
  });

  test("an unpublished container port is never admitted", async () => {
    await harness.addContainerEnvironment("a", { entryPort: 3000 });
    publish("a", "container-a", {});
    const runtime = await settled();
    expect(await runtime.legacyLoopbackPortAccess(3000)).toBe("unknown");
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
      expect(await runtime.legacyLoopbackPortAccess(3000)).toBe("unknown");
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
      const access = runtime.legacyLoopbackPortAccess(49152);
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
    expect(await runtime.legacyLoopbackPortAccess(49152)).toBe("reserved");
    // Docker's daemon ports are always reserved.
    expect(await runtime.legacyLoopbackPortAccess(2375)).toBe("reserved");
    expect(await runtime.legacyLoopbackPortAccess(2376)).toBe("reserved");
  });
});
