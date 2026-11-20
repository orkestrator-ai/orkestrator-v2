/**
 * Agent Capabilities across two real backends: each is a whole
 * `OrkestratorBackend` with its own SQLite store, behind a real gateway on
 * loopback, linked by the real `NodeService`/`NodeLink` (`add_node`). Both run
 * the isolated `agent-test` flavor, so capability files go into each data
 * directory's `capability-test-home`, never the host's provider homes.
 *
 * Covered: enrolling the leaf and applying a skill; the leaf going offline,
 * a setup change, and the reconnect delivering only the latest revision; a
 * leaf launch resolved and recorded by the command node over the leaf's real
 * event stream and an internal answer; the command handover moving the
 * capability state and epoch to the leaf, after which the old controller is
 * refused over HTTP.
 *
 * Not covered here: a third machine moving with the handover (the handover
 * moves machines only by remote HTTPS or SSH routes; loopback routes stay),
 * and separate OS processes (`scripts/two-node/harness.ts`).
 */
import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { NodeView } from "@orkestrator/protocol/command-nodes";
import type {
  CapabilityChangeResult,
  CapabilitySourceInspection,
} from "@orkestrator/protocol/capability-resources-api";

import { requestUrl, startGateway } from "./gateway-test-harness.js";
import { OrkestratorBackend } from "../src/core/index.js";
import { capabilityLaunchKey } from "../src/core/capabilities/launch-records.js";
import type { CapabilityService } from "../src/core/capabilities/service.js";

/** Events go to the gateway in front of the backend, as `main.ts` wires them. */
function backend(
  dataDir: string,
  emit: (event: string, payload: unknown) => void = () => undefined,
) {
  return new OrkestratorBackend({
    dataDir,
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    runtimeFlavor: "agent-test",
    emit,
    agentTools: {
      start: async () => undefined,
      stop: async () => undefined,
      connection: () => ({ url: "http://127.0.0.1:43210/mcp", token: "test-token" }),
      revokeEnvironment: () => undefined,
    },
    startupReapers: { localServers: async () => [], claudeTmuxRuntimes: async () => [] },
  });
}

function capabilities(instance: OrkestratorBackend): CapabilityService {
  const service = (instance as unknown as { context: { capabilities?: CapabilityService } }).context
    .capabilities;
  if (!service) throw new Error("No capability service.");
  return service;
}

async function poll(
  label: string,
  check: () => Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check().catch(() => false))) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Every SKILL.md for `name` under a test home, as text. */
async function skillCopies(home: string, name: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.name === "SKILL.md" && path.basename(path.dirname(full)) === name)
        found.push(await fs.readFile(full, "utf8"));
    }
  };
  await walk(home, 0);
  return found;
}

async function addSkill(
  command: OrkestratorBackend,
  name: string,
  content: string,
  managedId?: string,
): Promise<{ inspection: CapabilitySourceInspection; operationId: string }> {
  const inspection = await command.invoke<CapabilitySourceInspection>("author_capability_package", {
    kind: "skill",
    name,
    description: `${name} skill`,
    content,
    ...(managedId ? { managedId } : {}),
  });
  const preview = await command.invoke<CapabilityChangeResult>("preview_capability_change", {
    change: { kind: "add-to-setup", inspectionId: inspection.inspectionId, required: true },
  });
  await command.invoke("apply_capability_change", {
    operationId: preview.operation.id,
    approvedDigest: preview.operation.planDigest,
  });
  return { inspection, operationId: preview.operation.id };
}

test("capabilities across two real backends: delivery, offline catch-up, leaf launch, handover", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ork-capabilities-two-node-"));
  const command = backend(path.join(dataDir, "command"));
  let leafGateway: { emit(event: string, payload: unknown): void } | undefined;
  const leaf = backend(path.join(dataDir, "leaf"), (event, payload) =>
    leafGateway?.emit(event, payload),
  );
  const leafHome = path.join(dataDir, "leaf", "capability-test-home");
  try {
    await command.init();
    await leaf.init();
    const gatewayFor = () =>
      startGateway({
        backend: leaf,
        backendHello: () => leaf.backendHelloIdentity(),
        nodeHooks: leaf.nodeGateway(),
      });
    let remote = await gatewayFor();
    leafGateway = remote.gateway;
    const routeOf = (info: { url: string }) => ({
      id: "primary",
      kind: "https",
      enabled: true,
      origin: new URL(info.url).origin,
    });
    await command.invoke("set_command_node_enabled", { enabled: true });
    const attached = await command.invoke<NodeView>("add_node", {
      routes: [routeOf(remote.info)],
      token: remote.info.token,
    });
    expect(attached.connection.state).toBe("connected");
    const leafId = attached.nodeId;

    // Enrolled by default: a skill added on the command node reaches the leaf.
    const first = await addSkill(command, "review", "Version one.");
    await poll("the leaf to receive version one", async () =>
      (await skillCopies(leafHome, "review")).some((text) => text.includes("Version one.")),
    );
    expect(
      (await leaf.invoke<Record<string, unknown>>("list_capability_packages", {})) as unknown,
    ).toBeDefined();

    // A leaf launch is resolved and recorded by the command node.
    const launched = await capabilities(leaf).preflightSession({
      environmentId: "env-1",
      provider: "cursor",
      sessionKey: "leaf-session-1",
    });
    expect(launched?.resolvedPackages.map((entry) => entry.id)).toEqual([
      first.inspection.packageId,
    ]);
    const commandState = await (
      command as unknown as {
        context: {
          storage: {
            capabilities: {
              loadCapabilityState(): Promise<{
                launches: Record<string, { resolvedBy?: string; deliveries?: unknown[] }>;
              }>;
            };
          };
        };
      }
    ).context.storage.capabilities.loadCapabilityState();
    const launchKey = capabilityLaunchKey(
      { nodeId: leafId, environmentId: "env-1", provider: "cursor" },
      "leaf-session-1",
    );
    expect(commandState.launches[launchKey]).toMatchObject({
      resolvedBy: (await command.invoke<{ nodeId: string }>("get_node_status")).nodeId,
    });

    // The leaf goes offline; the setup changes; the reconnect applies only the latest.
    await remote.gateway.stop();
    const source = first.inspection.source;
    if (source.kind !== "managed") throw new Error("Expected an authored package.");
    const second = await addSkill(command, "review", "Version two.", source.managedId);
    await capabilities(command).reconciler.idle();
    expect(
      (await skillCopies(leafHome, "review")).every((text) => text.includes("Version one.")),
    ).toBe(true);
    remote = await gatewayFor();
    leafGateway = remote.gateway;
    await command.invoke("update_node", {
      nodeId: leafId,
      routes: [routeOf(remote.info)],
      token: remote.info.token,
    });
    await poll("the leaf to receive version two", async () => {
      const copies = await skillCopies(leafHome, "review");
      return copies.length > 0 && copies.every((text) => text.includes("Version two."));
    });
    expect(second.inspection.artifactDigest).not.toBe(first.inspection.artifactDigest);

    // Hand command to the leaf: the capability state and a higher epoch move with it.
    const commandId = (await command.invoke<{ nodeId: string }>("get_node_status")).nodeId;
    await command.invoke("hand_over_command", { nodeId: leafId, includeSelf: false, entries: [] });
    await poll("the leaf to hold the capability authority", async () =>
      (
        await leaf.invoke<{ packages: Array<{ id: string }> }>("list_capability_packages", {})
      ).packages.some((pkg) => pkg.id === first.inspection.packageId),
    );
    const library = await leaf.invoke<{ epoch: number }>("list_capability_packages", {});
    expect(library.epoch).toBe(2);
    // The old command node refuses fleet changes now.
    await expect(
      command.invoke("author_capability_package", { kind: "skill", name: "late", content: "x" }),
    ).rejects.toThrow("command node");
    // And the leaf refuses the old controller over HTTP.
    const refused = await requestUrl(new URL("/__orkestrator/invoke", remote.info.url).toString(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${remote.info.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command: "get_capability_node_observation",
        args: { controllerId: commandId, epoch: 1 },
      }),
    });
    expect(refused.status).not.toBe(200);
    expect(String((refused.json() as { error?: string }).error)).toContain("newer command node");
  } finally {
    await command.shutdown();
    await leaf.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
}, 60_000);
