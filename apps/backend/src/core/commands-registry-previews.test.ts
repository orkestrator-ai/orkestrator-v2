import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { previewErrorFromUnknown } from "@orkestrator/protocol/preview-services";

import { createCommandRegistry } from "./commands.js";
import type { CommandContext } from "./commands-context.js";
import { createPreviewHarness, type PreviewHarness } from "./preview-test-support.js";

describe("preview commands", () => {
  let harness: PreviewHarness;
  let context: CommandContext;
  const commands = createCommandRegistry();
  const invoke = (name: string, args: Record<string, unknown> = {}) =>
    Promise.resolve(commands.get(name)!(args, context));

  beforeEach(async () => {
    harness = await createPreviewHarness();
    await harness.addContainerEnvironment("a", { entryPort: 3000 });
    context = {
      storage: harness.storage,
      previews: harness.runtime,
      emit: () => undefined,
    } as unknown as CommandContext;
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  test("capabilities advertise the registry but not disabled transports", async () => {
    const capabilities = (await invoke("get_preview_capabilities")) as {
      registry: { available: boolean };
      surfaces: {
        desktopTunnel: { available: boolean; reason?: string };
        browserEmbedded: { available: boolean };
      };
      backendInstanceId: string;
    };
    expect(capabilities.registry.available).toBe(true);
    expect(capabilities.surfaces.desktopTunnel).toMatchObject({
      available: false,
      reason: expect.stringContaining("disabled"),
    });
    expect(capabilities.surfaces.browserEmbedded.available).toBe(false);
    expect(capabilities.backendInstanceId).toMatch(/^bk_/);
  });

  test("register, snapshot, and conflicting update round-trip through commands", async () => {
    const created = (await invoke("register_preview_service", {
      service: { environmentId: "a", label: "api", targetKind: "container", applicationPort: 8000 },
      operationId: "op-command-1",
    })) as { definition: { serviceId: string; definitionRevision: number } };
    const snapshot = (await invoke("get_preview_services", { environmentId: "a" })) as {
      services: Array<{ definition: { label: string } }>;
    };
    expect(snapshot.services.map((service) => service.definition.label).sort()).toEqual([
      "api",
      "app",
    ]);

    await invoke("update_preview_service", {
      serviceId: created.definition.serviceId,
      expectedRevision: 1,
      patch: { label: "api2" },
    });
    const conflict = await invoke("update_preview_service", {
      serviceId: created.definition.serviceId,
      expectedRevision: 1,
      patch: { label: "api3" },
    }).catch((error: unknown) => error);
    expect(previewErrorFromUnknown(conflict)?.category).toBe("configuration-conflict");
  });

  test("invalid input is rejected with a stable category", async () => {
    const error = await invoke("register_preview_service", {
      service: { environmentId: "a", label: "x", targetKind: "remote", applicationPort: 1 },
    }).catch((failure: unknown) => failure);
    expect(previewErrorFromUnknown(error)?.category).toBe("invalid-request");
  });

  test("settings commands toggle the transport kill switch", async () => {
    const updated = (await invoke("update_preview_settings", {
      settings: { transport: true },
    })) as {
      effective: { transport: boolean };
    };
    expect(updated.effective.transport).toBe(true);
    expect((await harness.storage.loadPreviewSettings()).transport).toBe(true);
  });

  test("backends without the runtime report unsupported", async () => {
    context = { storage: harness.storage } as unknown as CommandContext;
    const error = await invoke("get_preview_capabilities").catch((failure: unknown) => failure);
    expect(previewErrorFromUnknown(error)?.category).toBe("unsupported");
  });

  test("the iOS handoff URL carries only a one-use session code, never the grant", async () => {
    harness.runtime.publication = {
      bootstrapAction: () => "https://bootstrap.preview.test/bootstrap",
      originFor: () => "https://s-0123.preview.test",
    };
    await invoke("update_preview_settings", { settings: { transport: true } });
    harness.docker.containers.set("container-a", {
      id: "container-a",
      environmentId: "a",
      owner: harness.owner,
      ports: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }] },
    });
    await harness.runtime.registry.settle();
    const serviceId = harness.runtime.registry.snapshot({ environmentId: "a" }).services[0]!
      .definition.serviceId;
    const handoff = (await invoke("create_preview_handoff_url", { serviceId, path: "/x" })) as {
      url: string;
    };
    const url = new URL(handoff.url);
    expect(url.origin).toBe("https://s-0123.preview.test");
    expect(url.pathname).toBe("/__orkestrator_preview/session");
    const code = url.searchParams.get("code")!;
    // The code yields exactly one host-bound session for this service.
    expect(harness.runtime.access.consumeSessionCode(code, serviceId).path).toBe("/x");
    expect(() => harness.runtime.access.consumeSessionCode(code, serviceId)).toThrow("forbidden");
  });
});
