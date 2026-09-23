import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { PREVIEW_SERVICES_CHANGED_EVENT } from "@orkestrator/protocol/preview-services";

import { createPreviewHarness, type PreviewHarness } from "./preview-test-support.js";

describe("PreviewServiceRegistry", () => {
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

  async function started(runtime = harness.runtime) {
    await runtime.init();
    await runtime.registry.settle();
    return runtime.registry;
  }

  test("seeds one stable definition per configured TCP source across restarts", async () => {
    await harness.addContainerEnvironment("a", {
      entryPort: 3000,
      portMappings: [
        { containerPort: 8080, hostPort: 18080, protocol: "tcp" },
        { containerPort: 3000, hostPort: 13000, protocol: "tcp" },
        { containerPort: 5353, hostPort: 15353, protocol: "udp" },
      ],
    });
    publish("a", "container-a", { 3000: 49152, 8080: 18080 });
    const registry = await started();
    const first = registry
      .snapshot({ environmentId: "a" })
      .services.map((service) => service.definition);
    expect(
      first.map((definition) => [
        definition.provenanceKey,
        definition.applicationPort,
        definition.entry,
      ]),
    ).toEqual([
      ["entry:3000", 3000, true],
      ["mapping:8080", 8080, false],
    ]);

    const restarted = await started(harness.newRuntime());
    const second = restarted
      .snapshot({ environmentId: "a" })
      .services.map((service) => service.definition);
    expect(second.map((definition) => definition.serviceId)).toEqual(
      first.map((definition) => definition.serviceId),
    );
    expect(restarted.backendEpoch).not.toBe(registry.backendEpoch);
    expect(restarted.backendInstanceId).toBe(registry.backendInstanceId);
  });

  test("never marks persisted services ready before re-validating after restart", async () => {
    await harness.addContainerEnvironment("a", { entryPort: 3000 });
    publish("a", "container-a", { 3000: 49152 });
    const registry = await started();
    expect(registry.snapshot({ environmentId: "a" }).services[0]!.endpoint.state).toBe("available");

    harness.docker.gate = new Promise(() => undefined);
    const restarted = harness.newRuntime();
    await restarted.init();
    const endpoint = restarted.registry.snapshot({ environmentId: "a" }).services[0]!.endpoint;
    expect(["unresolved", "resolving"]).toContain(endpoint.state);
    expect(endpoint.hostPort).toBeNull();
  });

  test("resolves two containers on the same application port independently", async () => {
    await harness.addContainerEnvironment("a", { entryPort: 3000 });
    await harness.addContainerEnvironment("b", { entryPort: 3000 });
    publish("a", "container-a", { 3000: 49152 });
    publish("b", "container-b", { 3000: 49201 });
    const registry = await started();
    const a = registry.snapshot({ environmentId: "a" }).services[0]!;
    const b = registry.snapshot({ environmentId: "b" }).services[0]!;
    expect(a.endpoint.hostPort).toBe(49152);
    expect(b.endpoint.hostPort).toBe(49201);
    expect(
      (await registry.acquireTarget(a.definition.serviceId, a.endpoint.endpointGeneration)).port,
    ).toBe(49152);
  });

  test("container recreation with a reused host port advances the generation", async () => {
    await harness.addContainerEnvironment("a", { entryPort: 3000 });
    publish("a", "container-a", { 3000: 49152 });
    const registry = await started();
    const before = registry.snapshot({ environmentId: "a" }).services[0]!;
    const revoked: string[][] = [];
    registry.onRevoked((ids) => revoked.push(ids));

    publish("a", "container-a2", { 3000: 49152 });
    await harness.storage.updateEnvironment("a", { containerId: "container-a2" });
    await registry.settle();
    const after = registry.snapshot({ environmentId: "a" }).services[0]!;
    expect(after.endpoint.hostPort).toBe(49152);
    expect(after.endpoint.endpointGeneration).toBeGreaterThan(before.endpoint.endpointGeneration);
    expect(revoked.flat()).toContain(before.definition.serviceId);
    await expect(
      registry.acquireTarget(before.definition.serviceId, before.endpoint.endpointGeneration),
    ).rejects.toThrow("generation-changed");
  });

  test("a resolution finishing after stop cannot revive the old endpoint", async () => {
    await harness.addContainerEnvironment("a", { entryPort: 3000 });
    publish("a", "container-a", { 3000: 49152 });
    const registry = await started();
    const service = registry.snapshot({ environmentId: "a" }).services[0]!;

    let release!: () => void;
    harness.docker.gate = new Promise<void>((resolve) => (release = resolve));
    const late = registry.refresh(service.definition.serviceId);
    await Bun.sleep(5);
    registry.beforeEnvironmentTargetChange("a");
    await harness.storage.updateEnvironment("a", { status: "stopped" });
    harness.docker.gate = null;
    release();
    await late.catch(() => undefined);
    await registry.settle();
    const endpoint = registry.snapshot({ environmentId: "a" }).services[0]!.endpoint;
    expect(endpoint.state).toBe("unavailable");
    expect(endpoint.failure?.category).toBe("environment-stopped");
    expect(endpoint.hostPort).toBeNull();
  });

  test("reports unmapped ports and does not fall back to the application port number", async () => {
    await harness.addContainerEnvironment("a", { entryPort: 3000 });
    publish("a", "container-a", {});
    const registry = await started();
    const endpoint = registry.snapshot({ environmentId: "a" }).services[0]!.endpoint;
    expect(endpoint.state).toBe("unavailable");
    expect(endpoint.failure?.category).toBe("target-unmapped");
    expect(endpoint.hostPort).toBeNull();
  });

  test("compare-and-set updates reject stale writers and replay operation ids", async () => {
    await harness.addContainerEnvironment("a");
    const registry = await started();
    const created = await registry.register(
      { environmentId: "a", label: "api", targetKind: "container", applicationPort: 8000 },
      { operationId: "op-register-1" },
    );
    if (created.kind !== "definition") throw new Error("expected definition");
    const replay = await registry.register(
      { environmentId: "a", label: "api", targetKind: "container", applicationPort: 8000 },
      { operationId: "op-register-1" },
    );
    expect(replay).toMatchObject({
      kind: "definition",
      replayed: true,
      definition: { serviceId: created.definition.serviceId },
    });

    const serviceId = created.definition.serviceId;
    const [first, second] = await Promise.allSettled([
      registry.update(serviceId, 1, { label: "api-a" }),
      registry.update(serviceId, 1, { label: "api-b" }),
    ]);
    expect([first.status, second.status].sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = [first, second].find(
      (result) => result.status === "rejected",
    ) as PromiseRejectedResult;
    expect(String(rejected.reason)).toContain("configuration-conflict");
    expect(registry.getDefinition(serviceId)!.definitionRevision).toBe(2);
  });

  test("rejects duplicates, wrong target kinds, and growth past the limit", async () => {
    await harness.addContainerEnvironment("a");
    await harness.addLocalEnvironment("local");
    const registry = await started(
      harness.newRuntime({ limits: { ...harness.runtime.limits, definitionsPerEnvironment: 2 } }),
    );
    await registry.register({
      environmentId: "a",
      label: "one",
      targetKind: "container",
      applicationPort: 1000,
    });
    await expect(
      registry.register({
        environmentId: "a",
        label: "dup",
        targetKind: "container",
        applicationPort: 1000,
      }),
    ).rejects.toThrow("configuration-conflict");
    await expect(
      registry.register({
        environmentId: "a",
        label: "wt",
        targetKind: "worktree",
        applicationPort: 1001,
      }),
    ).rejects.toThrow("invalid-request");
    await registry.register({
      environmentId: "a",
      label: "two",
      targetKind: "container",
      applicationPort: 1002,
    });
    await expect(
      registry.register({
        environmentId: "a",
        label: "three",
        targetKind: "container",
        applicationPort: 1003,
      }),
    ).rejects.toThrow("capacity-exceeded");
    expect(registry.listDefinitions("a")).toHaveLength(2);
  });

  test("a failed storage write emits no committed-success event", async () => {
    await harness.addContainerEnvironment("a");
    const registry = await started();
    registry.flushEvent();
    const before = harness.events.length;
    const original = harness.storage.mutatePreviewServiceStore.bind(harness.storage);
    harness.storage.mutatePreviewServiceStore = (async () => {
      throw new Error("disk full");
    }) as typeof harness.storage.mutatePreviewServiceStore;
    await expect(
      registry.register({
        environmentId: "a",
        label: "api",
        targetKind: "container",
        applicationPort: 8000,
      }),
    ).rejects.toThrow("disk full");
    harness.storage.mutatePreviewServiceStore = original;
    registry.flushEvent();
    expect(harness.events.slice(before)).toEqual([]);
    expect(registry.listDefinitions("a")).toEqual([]);
  });

  test("conditional snapshots, invalidation events, and tombstones", async () => {
    await harness.addContainerEnvironment("a");
    const registry = await started();
    const snapshot = registry.snapshot({ environmentId: "a" });
    expect(
      registry.snapshot({
        environmentId: "a",
        knownEpoch: snapshot.backendEpoch,
        knownRevision: snapshot.registryRevision,
      }),
    ).toMatchObject({ notModified: true, services: [] });

    const created = await registry.register({
      environmentId: "a",
      label: "api",
      targetKind: "container",
      applicationPort: 8000,
    });
    if (created.kind !== "definition") throw new Error("expected definition");
    await registry.remove(created.definition.serviceId, undefined);
    registry.flushEvent();
    const after = registry.snapshot({ environmentId: "a" });
    expect(after.services).toEqual([]);
    expect(after.tombstones.map((tombstone) => tombstone.serviceId)).toEqual([
      created.definition.serviceId,
    ]);
    const event = harness.events
      .filter((entry) => entry.event === PREVIEW_SERVICES_CHANGED_EVENT)
      .at(-1)!;
    expect(event.payload).toMatchObject({
      backendEpoch: registry.backendEpoch,
      environmentIds: ["a"],
      revokedServiceIds: [created.definition.serviceId],
    });
    expect(JSON.stringify(event.payload)).not.toMatch(/"(credential|grant|token)"/);
  });

  test("deleting an environment removes its definitions and revokes access", async () => {
    await harness.addContainerEnvironment("a", { entryPort: 3000 });
    publish("a", "container-a", { 3000: 49152 });
    const registry = await started();
    const serviceId = registry.snapshot({ environmentId: "a" }).services[0]!.definition.serviceId;
    const revoked: string[] = [];
    registry.onRevoked((ids) => revoked.push(...ids));
    await harness.storage.removeEnvironment("a");
    await registry.settle();
    expect(registry.listDefinitions("a")).toEqual([]);
    expect(revoked).toContain(serviceId);
    const stored = await harness.storage.loadPreviewServiceStore();
    expect(Object.keys(stored.store.definitions)).toEqual([]);
  });

  test("user overrides survive removal of the generated source", async () => {
    await harness.addContainerEnvironment("a", {
      portMappings: [{ containerPort: 8080, hostPort: 18080, protocol: "tcp" }],
    });
    const registry = await started();
    const generated = registry.listDefinitions("a")[0]!;
    await registry.update(generated.serviceId, generated.definitionRevision, { label: "admin" });
    await harness.storage.updateEnvironment("a", { portMappings: [] });
    await registry.settle();
    expect(registry.listDefinitions("a").map((definition) => definition.label)).toEqual(["admin"]);
  });

  test("malformed stored records do not crash startup and are never served", async () => {
    await harness.storage.mutatePreviewServiceStore((store) => {
      (store.definitions as Record<string, unknown>)["svc_broken_record1"] = {
        serviceId: "svc_broken_record1",
      };
      return { changed: true, result: null };
    });
    const registry = await started(harness.newRuntime());
    expect(registry.snapshot().services).toEqual([]);
    expect(registry.diagnostics().invalidDefinitions).toBe(1);
  });

  test("works without any mounted client and disposes cleanly", async () => {
    await harness.addContainerEnvironment("a", { entryPort: 3000 });
    publish("a", "container-a", { 3000: 49152 });
    const runtime = harness.newRuntime();
    const registry = await started(runtime);
    expect(registry.snapshot({ environmentId: "a" }).services[0]!.endpoint.state).toBe("available");
    runtime.dispose();
    const eventsBefore = harness.events.length;
    await harness.storage.updateEnvironment("a", { status: "stopped" });
    await Bun.sleep(10);
    expect(harness.events.length).toBe(eventsBefore);
  });
});
