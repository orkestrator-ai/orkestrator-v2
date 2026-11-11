import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { LoopbackListenerOwnership } from "./preview-listener-ownership.js";
import { createPreviewHarness, type PreviewHarness } from "./preview-test-support.js";
import { CommandFailedError } from "./shell.js";

const PORT = 3000;

/**
 * A new upstream connection inside the registry's verification window
 * (docs/architecture/browser-previews.md, "Local environments"; the Linux `ss`
 * and `lsof` runs are in 0042's evidence log).
 * The clock never advances unless a test says so, so every acquisition below is
 * inside the window; the host's `lsof` and `ps` are scripted and counted.
 */
describe("a new connection inside the verification window", () => {
  let harness: PreviewHarness;
  let now: number;
  /** Listener pids per port. */
  let listeners: Record<number, number[]>;
  let lsofFailure: Error | null;
  let psGate: Promise<void> | null;
  let lsofCalls: number;
  let psCalls: number;

  // Terminals: 100 (environment a), 400 (environment b). 600 has no managed ancestor.
  const PS = [
    "  100     1 Sun Oct 25 09:00:00 2026",
    "  300   100 Sun Oct 25 09:01:00 2026",
    "  301   100 Sun Oct 25 09:02:00 2026",
    "  302   100 Sun Oct 25 09:03:00 2026",
    "  400     1 Sun Oct 25 09:04:00 2026",
    "  500   400 Sun Oct 25 09:05:00 2026",
    "  600     1 Sun Oct 25 09:06:00 2026",
  ].join("\n");

  function newChecker() {
    return new LoopbackListenerOwnership({
      roots: () => [
        { environmentId: "a", pid: 100 },
        { environmentId: "b", pid: 400 },
      ],
      platform: "darwin",
      processCacheMs: 0,
      runCommand: async (command, args) => {
        if (command === "ps") {
          psCalls += 1;
          const gate = psGate;
          if (gate) await gate;
          return { stdout: PS };
        }
        lsofCalls += 1;
        if (lsofFailure) throw lsofFailure;
        const port = Number(/TCP:(\d+)/.exec(args.join(" "))?.[1]);
        const pids = listeners[port] ?? [];
        if (pids.length === 0) throw new CommandFailedError("", { exitCode: 1 });
        return { stdout: pids.map((pid) => `p${pid}\nf12\ntIPv4\nn127.0.0.1:${port}\n`).join("") };
      },
    });
  }

  beforeEach(async () => {
    harness = await createPreviewHarness();
    now = 1_000;
    listeners = { [PORT]: [300] };
    lsofFailure = null;
    psGate = null;
    lsofCalls = 0;
    psCalls = 0;
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  /** A runtime with environment a's seeded service verified against pid 300. */
  async function verifiedService() {
    await harness.addLocalEnvironment("a", { entryPort: PORT });
    await harness.addLocalEnvironment("b");
    const runtime = harness.newRuntime({
      listenerOwnership: newChecker(),
      registry: { now: () => now, probeBackoffMs: [] },
    });
    await runtime.init();
    await runtime.registry.settle();
    const service = runtime.registry.snapshot({ environmentId: "a" }).services[0]!;
    expect(service.endpoint).toMatchObject({ state: "available", ownership: "managed-process" });
    lsofCalls = 0;
    psCalls = 0;
    return {
      runtime,
      registry: runtime.registry,
      serviceId: service.definition.serviceId,
      generation: service.endpoint.endpointGeneration,
    };
  }

  test("a restarted listener re-resolves, bumps the generation and revokes the old attachments", async () => {
    const { runtime, registry, serviceId, generation } = await verifiedService();
    const attachment = await runtime.access.createAttachment({
      serviceId,
      surface: "desktop-tunnel",
    });
    expect(attachment.endpointGeneration).toBe(generation);
    const reasons: string[] = [];
    registry.onRevoked((_, reason) => reasons.push(reason));

    listeners[PORT] = [301];
    await expect(registry.acquireTarget(serviceId, generation)).rejects.toThrow(
      "generation-changed",
    );

    expect(registry.serviceSnapshot(serviceId)!.endpoint).toMatchObject({
      state: "available",
      ownership: "managed-process",
      endpointGeneration: generation + 1,
    });
    expect(reasons).toEqual(["binding-changed"]);
    expect(() => runtime.access.renewAttachment(attachment.attachmentId)).toThrow("access-expired");
    // The new generation reaches the new process without another full check.
    psCalls = 0;
    expect((await registry.acquireTarget(serviceId, generation + 1)).port).toBe(PORT);
    expect(psCalls).toBe(0);
  });

  test("another environment's server on the freed port is refused and never reached", async () => {
    const { registry, serviceId, generation } = await verifiedService();

    listeners[PORT] = [500];
    await expect(registry.acquireTarget(serviceId, generation)).rejects.toThrow(
      "generation-changed",
    );

    expect(registry.serviceSnapshot(serviceId)!.endpoint).toMatchObject({
      state: "unavailable",
      listener: "other-environment",
      hostPort: null,
      endpointGeneration: generation + 1,
    });
    await expect(registry.acquireTarget(serviceId, generation + 1)).rejects.toThrow(
      "target-unverified",
    );
  });

  test("a stopped listener ends the binding instead of connecting to nothing", async () => {
    const { registry, serviceId, generation } = await verifiedService();

    listeners[PORT] = [];
    await expect(registry.acquireTarget(serviceId, generation)).rejects.toThrow(
      "generation-changed",
    );

    expect(registry.serviceSnapshot(serviceId)!.endpoint).toMatchObject({
      state: "unavailable",
      listener: "none",
    });
  });

  test("a port lookup that cannot answer re-resolves rather than trusting the cache", async () => {
    const { registry, serviceId, generation } = await verifiedService();

    lsofFailure = new CommandFailedError("slow", { timedOut: true });
    await expect(registry.acquireTarget(serviceId, generation)).rejects.toThrow(
      "generation-changed",
    );

    expect(registry.serviceSnapshot(serviceId)!.endpoint).toMatchObject({
      state: "unavailable",
      listener: "unchecked",
    });
  });

  test("a burst with the pid unchanged does one coalesced lookup and no ancestry walk", async () => {
    const { registry, serviceId, generation } = await verifiedService();

    const targets = await Promise.all(
      Array.from({ length: 12 }, () => registry.acquireTarget(serviceId, generation)),
    );

    expect(new Set(targets).size).toBe(1);
    expect(lsofCalls).toBe(1);
    expect(psCalls).toBe(0);
    expect(registry.serviceSnapshot(serviceId)!.endpoint.endpointGeneration).toBe(generation);

    // A later connection looks again: the answer is never reused between bursts.
    await registry.acquireTarget(serviceId, generation);
    expect(lsofCalls).toBe(2);
    expect(psCalls).toBe(0);
  });

  test("a burst after a restart re-resolves once", async () => {
    const { registry, serviceId, generation } = await verifiedService();

    listeners[PORT] = [301];
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => registry.acquireTarget(serviceId, generation)),
    );

    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(lsofCalls).toBe(2);
    expect(psCalls).toBe(1);
    expect(registry.serviceSnapshot(serviceId)!.endpoint.endpointGeneration).toBe(generation + 1);
  });

  test("passing the port lookup does not extend the window", async () => {
    const { registry, serviceId, generation } = await verifiedService();

    now += 3_000;
    await registry.acquireTarget(serviceId, generation);
    expect(psCalls).toBe(0);

    // Past five seconds since the last full check, not since the last lookup.
    now += 3_000;
    await registry.acquireTarget(serviceId, generation);
    expect(psCalls).toBe(1);
  });

  test("a worker joining the same server keeps the generation and the next lookup agrees", async () => {
    const { registry, serviceId, generation } = await verifiedService();

    listeners[PORT] = [300, 302];
    await registry.acquireTarget(serviceId, generation);
    expect(psCalls).toBe(1);
    expect(registry.serviceSnapshot(serviceId)!.endpoint.endpointGeneration).toBe(generation);

    await registry.acquireTarget(serviceId, generation);
    expect(psCalls).toBe(1);
  });

  test("a resolve already running from before the restart cannot vouch for the new process", async () => {
    const { registry, serviceId, generation } = await verifiedService();

    // A resolve that listed pid 300 and is still walking its ancestry.
    let release!: () => void;
    psGate = new Promise((resolve) => (release = resolve));
    const running = registry.refresh(serviceId);
    while (psCalls === 0) await Bun.sleep(1);
    listeners[PORT] = [301];

    const connection = registry.acquireTarget(serviceId, generation);
    while (lsofCalls < 2) await Bun.sleep(1);
    psGate = null;
    release();
    await running;

    await expect(connection).rejects.toThrow("generation-changed");
    expect(registry.serviceSnapshot(serviceId)!.endpoint.endpointGeneration).toBe(generation + 1);
  });

  for (const persistentFailure of [false, true]) {
    test(`an unknown lookup cannot trust a pre-takeover resolve (persistent failure: ${persistentFailure})`, async () => {
      const { registry, serviceId, generation } = await verifiedService();
      let release!: () => void;
      psGate = new Promise((resolve) => (release = resolve));
      const running = registry.refresh(serviceId);
      try {
        for (let attempts = 0; psCalls === 0 && attempts < 100; attempts++) await Bun.sleep(1);
        expect(psCalls).toBe(1);
        // The running resolve already saw a's pid 300. Now b owns the port,
        // but the connection's independent lookup cannot answer.
        listeners[PORT] = [500];
        lsofFailure = new CommandFailedError("slow", { timedOut: true });
        const connection = Promise.allSettled([registry.acquireTarget(serviceId, generation)]);
        for (let attempts = 0; lsofCalls < 2 && attempts < 100; attempts++) await Bun.sleep(1);
        expect(lsofCalls).toBe(2);
        if (!persistentFailure) lsofFailure = null;
        psGate = null;
        release();
        await running;
        const [result] = await connection;
        expect(result!.status).toBe("rejected");
        if (result!.status === "rejected")
          expect(result.reason.message).toContain("generation-changed");
        expect(lsofCalls).toBe(3);
        expect(registry.serviceSnapshot(serviceId)!.endpoint).toMatchObject({
          state: "unavailable",
          listener: persistentFailure ? "unchecked" : "other-environment",
          endpointGeneration: generation + 1,
        });
      } finally {
        psGate = null;
        release();
        await running;
      }
    });
  }

  test("taking a pooled connection opens nothing, so it looks nothing up", async () => {
    const { registry, serviceId, generation } = await verifiedService();

    listeners[PORT] = [301];
    await registry.acquireTarget(serviceId, generation, { reusingConnection: true });

    expect(lsofCalls).toBe(0);
    expect(registry.serviceSnapshot(serviceId)!.endpoint.endpointGeneration).toBe(generation);
  });

  test("a user-registered target is shown as before, with no lookup", async () => {
    await harness.addLocalEnvironment("a");
    listeners[PORT] = [600];
    const runtime = harness.newRuntime({
      listenerOwnership: newChecker(),
      registry: { now: () => now },
    });
    await runtime.init();
    await runtime.registry.settle();
    const created = await runtime.registry.register({
      environmentId: "a",
      label: "shared",
      targetKind: "backend-host",
      applicationPort: PORT,
    });
    if (created.kind !== "definition") throw new Error("expected definition");
    const service = await runtime.registry.refresh(created.definition.serviceId);
    expect(service.endpoint).toMatchObject({
      ownership: "user-registered",
      listener: "unattributed",
    });
    lsofCalls = 0;

    listeners[PORT] = [500];
    const { serviceId } = service.definition;
    const target = await runtime.registry.acquireTarget(
      serviceId,
      service.endpoint.endpointGeneration,
    );

    expect(target.port).toBe(PORT);
    expect(lsofCalls).toBe(0);
    expect(runtime.registry.serviceSnapshot(serviceId)!.endpoint.endpointGeneration).toBe(
      service.endpoint.endpointGeneration,
    );
  });

  test("a container target is reused as before, with no lookup or inspect", async () => {
    await harness.addContainerEnvironment("c", { entryPort: PORT });
    harness.docker.containers.set("container-c", {
      id: "container-c-full-id",
      environmentId: "c",
      owner: harness.owner,
      ports: { [`${PORT}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: "49152" }] },
    });
    const runtime = harness.newRuntime({
      listenerOwnership: newChecker(),
      registry: { now: () => now },
    });
    await runtime.init();
    await runtime.registry.settle();
    const service = runtime.registry.snapshot({ environmentId: "c" }).services[0]!;
    expect(service.endpoint).toMatchObject({ state: "available", ownership: "owned-container" });
    const inspects = harness.docker.inspectCount();

    const target = await runtime.registry.acquireTarget(
      service.definition.serviceId,
      service.endpoint.endpointGeneration,
    );

    expect(target.port).toBe(49152);
    expect(lsofCalls).toBe(0);
    expect(harness.docker.inspectCount()).toBe(inspects);
  });
});
