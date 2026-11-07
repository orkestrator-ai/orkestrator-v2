/**
 * Every `previews` command through the real registry (plan item 7004). Under
 * tests the registry validates each defined command's result against its
 * schema, so a call that answers proves the result schema describes what the
 * handler returns; a mismatch throws `InvalidCommandResultError`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PREVIEWS_COMMANDS } from "@orkestrator/protocol/contract/domains/previews";

import { createCommandRegistry } from "./commands.js";
import type { CommandContext } from "./commands-context.js";
import { createPreviewHarness, type PreviewHarness } from "./preview-test-support.js";

describe("previews contract", () => {
  let harness: PreviewHarness;
  let context: CommandContext;
  const commands = createCommandRegistry();
  const invoke = (name: string, args: Record<string, unknown> = {}) =>
    Promise.resolve(commands.get(name)!(args, context));

  beforeEach(async () => {
    harness = await createPreviewHarness();
    await harness.addContainerEnvironment("a", { entryPort: 3000 });
    harness.docker.containers.set("container-a", {
      id: "container-a",
      environmentId: "a",
      owner: harness.owner,
      ports: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }] },
    });
    harness.runtime.publication = {
      bootstrapAction: () => "https://bootstrap.preview.test/bootstrap",
      originFor: () => "https://s-0123.preview.test",
    };
    context = {
      storage: harness.storage,
      previews: harness.runtime,
      emit: () => undefined,
    } as unknown as CommandContext;
    await harness.runtime.init();
    await harness.runtime.registry.settle();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  test("every preview command is registered with its definition", () => {
    for (const def of PREVIEWS_COMMANDS) {
      expect(commands.contracts.get(def.name)).toBe(def);
    }
  });

  test("every command's result validates against its schema", async () => {
    const capabilities = (await invoke("get_preview_capabilities")) as {
      backendInstanceId: string;
    };
    const snapshot = (await invoke("get_preview_services", { environmentId: "a" })) as {
      backendEpoch: string;
      registryRevision: number;
      services: Array<{ definition: { serviceId: string; definitionRevision: number } }>;
    };
    expect(snapshot.services.length).toBeGreaterThan(0);
    const notModified = (await invoke("get_preview_services", {
      environmentId: "a",
      knownEpoch: snapshot.backendEpoch,
      knownRevision: snapshot.registryRevision,
    })) as { notModified: boolean };
    expect(notModified.notModified).toBe(true);
    const serviceId = snapshot.services[0]!.definition.serviceId;

    const created = (await invoke("register_preview_service", {
      service: { environmentId: "a", label: "api", targetKind: "container", applicationPort: 8000 },
      operationId: "op-contract-1",
    })) as { kind: string; definition: { serviceId: string; definitionRevision: number } };
    expect(created.kind).toBe("definition");
    const updated = (await invoke("update_preview_service", {
      serviceId: created.definition.serviceId,
      expectedRevision: created.definition.definitionRevision,
      patch: { label: "api 2" },
      operationId: "op-contract-2",
    })) as { definition: { definitionRevision: number } };
    expect(
      await invoke("remove_preview_service", {
        serviceId: created.definition.serviceId,
        expectedRevision: updated.definition.definitionRevision,
        operationId: "op-contract-3",
      }),
    ).toMatchObject({ kind: "removed", replayed: false });

    expect(
      await invoke("resolve_preview_target", {
        serviceRef: {
          backendInstanceId: capabilities.backendInstanceId,
          environmentId: "a",
          serviceId,
          path: "/",
        },
      }),
    ).toMatchObject({ kind: "service" });
    expect(
      await invoke("resolve_preview_target", {
        intent: {
          url: "http://localhost:4100/x",
          source: "container-terminal",
          environmentId: "a",
        },
      }),
    ).toMatchObject({ kind: "unregistered" });
    expect(await invoke("probe_preview_service", { serviceId })).toMatchObject({
      definition: { serviceId },
    });

    const attachment = (await invoke("create_preview_attachment", {
      serviceId,
      surface: "browser-top-level",
      path: "/",
    })) as { attachmentId: string };
    expect(
      await invoke("renew_preview_attachment", { attachmentId: attachment.attachmentId }),
    ).toHaveProperty("idleExpiresAt");
    expect(
      await invoke("release_preview_attachment", { attachmentId: attachment.attachmentId }),
    ).toEqual({ released: true });
    expect(await invoke("create_preview_handoff_url", { serviceId })).toHaveProperty("url");
    expect(await invoke("get_preview_public_origin", { serviceId })).toEqual({
      origin: "https://s-0123.preview.test",
    });
    expect(await invoke("revoke_preview_access", { serviceId })).toHaveProperty("revoked");
    expect(await invoke("revoke_preview_access")).toHaveProperty("revoked");
    expect(await invoke("get_preview_diagnostics")).toHaveProperty("registry");
    expect(
      await invoke("record_preview_client_metrics", {
        report: { counters: [], histograms: {} },
      }),
    ).toEqual({ recorded: true });
    expect(await invoke("get_preview_settings")).toHaveProperty("effective");
    expect(await invoke("update_preview_settings", { settings: { relay: false } })).toMatchObject({
      stored: { relay: false },
    });
  });

  test("an unknown argument is dropped, never refused (§11.4)", async () => {
    expect(
      await invoke("get_preview_public_origin", { serviceId: "svc_x", fromANewerClient: 1 }),
    ).toEqual({ origin: "https://s-0123.preview.test" });
  });

  test("a critical key the handler does not declare is refused; a declared one is accepted", async () => {
    await expect(
      (async () =>
        commands.get("revoke_preview_access")!({ newSafety: true }, context, {
          critical: ["newSafety"],
        }))(),
    ).rejects.toMatchObject({ code: "unsupported-field" });
    expect(
      await commands.get("revoke_preview_access")!({ serviceId: "svc_x" }, context, {
        critical: ["serviceId"],
      }),
    ).toEqual({ revoked: 0 });
  });
});
