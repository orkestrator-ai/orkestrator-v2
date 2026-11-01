import { afterEach, describe, expect, test } from "bun:test";

import {
  SYNC_CONTROLLER_SETTINGS_COMMAND,
  type InheritedGlobalSettings,
} from "@orkestrator/protocol/controller-settings";
import type { BackendId, RouteId } from "@orkestrator/protocol/federation";
import { unknownBackendCommandMessage } from "@orkestrator/protocol/unknown-command";

import { LeafControllerSettings } from "./node-controller-settings.js";
import { MemoryNodeStorage, TestNodeNetwork } from "./node-network-test-support.js";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for controller settings.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function setup(initial: InheritedGlobalSettings) {
  const network = new TestNodeNetwork();
  cleanups.push(async () => {
    for (const node of network.nodes.values()) {
      node.portal.stop();
      await node.service.stop();
    }
  });
  let settings = initial;
  const command = await network.add("command", {
    forceRegistration: true,
    extra: { inheritableSettings: async () => settings },
  });
  let leafChanges = 0;
  const leaf = await network.add("leaf", {
    extra: { onInheritedSettingsChanged: () => (leafChanges += 1) },
  });
  leaf.commands.set("get_projects", () => []);
  return {
    command,
    leaf,
    setSettings: (next: InheritedGlobalSettings) => (settings = next),
    leafChanges: () => leafChanges,
    sends: () =>
      leaf.received.filter((entry) => entry.command === SYNC_CONTROLLER_SETTINGS_COMMAND).length,
  };
}

describe("settings a command node hands down", () => {
  test("reach a leaf when it attaches and when they change, and leave with the command node", async () => {
    const { command, leaf, setSettings, leafChanges, sends } = await setup({
      agentSettings: { defaultAgent: "codex" },
    });
    const view = await command.service.addNode({
      routes: [{ id: "primary" as RouteId, kind: "https", enabled: true, origin: leaf.origin }],
      token: leaf.token,
    });

    await waitFor(() => leaf.service.inheritedSettings.current() !== null);
    expect(leaf.service.inheritedSettings.current()).toEqual({
      agentSettings: { defaultAgent: "codex" },
    });
    expect(leafChanges()).toBe(1);
    const status = await leaf.service.status();
    expect(status.inheritedSettingsFrom?.controllerId).toBe(await command.service.selfIdentity());
    expect(status.inheritedSettingsFrom?.displayName).toBe("command machine");

    // Unchanged settings are not sent again on the same connection.
    const sent = sends();
    command.service.syncSettingsToLeaves();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sends()).toBe(sent);

    setSettings({
      agentSettings: { defaultAgent: "claude" },
      terminalScrollback: 9_000,
    });
    command.service.syncSettingsToLeaves();
    await waitFor(() => leaf.service.inheritedSettings.current()?.terminalScrollback === 9_000);
    expect(leafChanges()).toBe(2);

    await command.service.forgetNode({ nodeId: view.nodeId });
    await waitFor(() => leaf.service.inheritedSettings.current() === null);
    expect((await leaf.service.status()).inheritedSettingsFrom).toBeUndefined();
    expect(leafChanges()).toBe(3);
  });

  test("a leaf refuses settings from a command node that is not attached to it", async () => {
    const { leaf } = await setup({});
    await expect(
      leaf.service.inheritedSettings.receive({
        controllerId: "bk_stranger" as BackendId,
        settings: { terminalScrollback: 1 },
      }),
    ).rejects.toThrow("not attached");
    expect(leaf.service.inheritedSettings.current()).toBeNull();
  });

  test("only inherited keys are kept", async () => {
    const { command, leaf } = await setup({
      agentSettings: { defaultAgent: "codex" },
    });
    await command.service.addNode({
      routes: [{ id: "primary" as RouteId, kind: "https", enabled: true, origin: leaf.origin }],
      token: leaf.token,
    });
    await waitFor(() => leaf.service.inheritedSettings.current() !== null);
    await leaf.service.inheritedSettings.receive({
      controllerId: await command.service.selfIdentity(),
      settings: { githubToken: "secret", terminalScrollback: 4_000 },
    });
    expect(leaf.service.inheritedSettings.current()).toEqual({ terminalScrollback: 4_000 });
  });
  test("a replacement link resends unchanged settings after forgetting and re-adding a leaf", async () => {
    const { command, leaf, sends } = await setup({ terminalScrollback: 7000 });
    const args = {
      routes: [{ id: "primary" as RouteId, kind: "https", enabled: true, origin: leaf.origin }],
      token: leaf.token,
    };
    const original = await command.service.addNode(args);
    await waitFor(() => leaf.service.inheritedSettings.current()?.terminalScrollback === 7000);
    const sent = sends();
    await command.service.forgetNode({ nodeId: original.nodeId });
    expect(leaf.service.inheritedSettings.current()).toBeNull();
    await command.service.addNode(args);
    await waitFor(() => leaf.service.inheritedSettings.current()?.terminalScrollback === 7000);
    expect(sends()).toBeGreaterThan(sent);
  });

  test("transient failures retry unchanged snapshots on a healthy link", async () => {
    const { command, leaf, sends } = await setup({ terminalScrollback: 7000 });
    leaf.commands.set(SYNC_CONTROLLER_SETTINGS_COMMAND, () => {
      throw new Error("Temporary write failure");
    });
    const view = await command.service.addNode({
      routes: [{ id: "primary" as RouteId, kind: "https", enabled: true, origin: leaf.origin }],
      token: leaf.token,
    });
    await waitFor(() => sends() > 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(command.service.link(view.nodeId)?.connected).toBe(true);
    const sent = sends();
    leaf.commands.delete(SYNC_CONTROLLER_SETTINGS_COMMAND);
    command.service.syncSettingsToLeaves();
    await waitFor(() => leaf.service.inheritedSettings.current()?.terminalScrollback === 7000);
    expect(sends()).toBeGreaterThan(sent);
  });

  test("unsupported settings commands are remembered separately for the connection", async () => {
    const { command, leaf, sends, setSettings } = await setup({ terminalScrollback: 7000 });
    leaf.commands.set(SYNC_CONTROLLER_SETTINGS_COMMAND, () => {
      throw new Error(unknownBackendCommandMessage(SYNC_CONTROLLER_SETTINGS_COMMAND));
    });
    await command.service.addNode({
      routes: [{ id: "primary" as RouteId, kind: "https", enabled: true, origin: leaf.origin }],
      token: leaf.token,
    });
    await waitFor(() => sends() > 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const sent = sends();
    setSettings({ terminalScrollback: 8000 });
    command.service.syncSettingsToLeaves();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sends()).toBe(sent);
    expect(leaf.service.inheritedSettings.current()).toBeNull();
  });

  test("detach reports cleanup failure, announces the change, and clears stale copies before reattach", async () => {
    const { command, leaf, leafChanges } = await setup({ terminalScrollback: 7000 });
    await command.service.addNode({
      routes: [{ id: "primary" as RouteId, kind: "https", enabled: true, origin: leaf.origin }],
      token: leaf.token,
    });
    await waitFor(() => leaf.service.inheritedSettings.current() !== null);
    const controllerId = await command.service.selfIdentity();
    const original = leaf.storage.mutateControllerSettings.bind(leaf.storage);
    leaf.storage.mutateControllerSettings = async () => {
      throw new Error("Disk failure");
    };
    const changes = leafChanges();
    await expect(leaf.service.detachController(controllerId)).rejects.toThrow("Disk failure");
    expect(leafChanges()).toBe(changes + 1);
    expect(leaf.service.inheritedSettings.current()).toBeNull();
    await expect(
      leaf.service.attachController({ controllerId, displayName: "command", portalOrigins: [] }),
    ).rejects.toThrow("Disk failure");
    leaf.storage.mutateControllerSettings = original;
    await leaf.service.attachController({
      controllerId,
      displayName: "command",
      portalOrigins: [],
    });
    expect(leaf.service.inheritedSettings.current()).toBeNull();
    expect(leaf.storage.controllerSettings.entries).toEqual([]);
  });
});

describe("multi-controller arbitration", () => {
  test("serializes persistence and cache updates, breaks timestamp ties by receipt order, and survives restart", async () => {
    const storage = new MemoryNodeStorage("bk_leaf", {} as never);
    const attached = new Set(["bk_first", "bk_second"]);
    const options = {
      storage,
      attachedName: (id: BackendId) => (attached.has(id) ? id : null),
      onChange: () => undefined,
      now: () => 1000,
    };
    const leaf = new LeafControllerSettings(options);
    await leaf.start();
    const original = storage.mutateControllerSettings.bind(storage);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let mutations = 0;
    storage.mutateControllerSettings = async (mutate) => {
      const result = await original(mutate);
      if (++mutations === 1) await blocked;
      return result;
    };
    const first = leaf.receive({
      controllerId: "bk_first",
      settings: { terminalScrollback: 1000 },
    });
    const second = leaf.receive({
      controllerId: "bk_second",
      settings: { terminalScrollback: 2000 },
    });
    await waitFor(() => mutations === 1);
    release();
    await Promise.all([first, second]);
    expect(leaf.current()).toEqual({ terminalScrollback: 2000 });
    expect(leaf.source()?.controllerId).toBe("bk_second" as BackendId);
    const restarted = new LeafControllerSettings(options);
    await restarted.start();
    expect(restarted.source()).toEqual(leaf.source());
    // An unchanged resend from the non-winning controller does not steal precedence.
    await leaf.receive({ controllerId: "bk_first", settings: { terminalScrollback: 1000 } });
    expect(leaf.source()?.controllerId).toBe("bk_second" as BackendId);
    await leaf.receive({ controllerId: "bk_first", settings: { terminalScrollback: 3000 } });
    expect(leaf.source()?.controllerId).toBe("bk_first" as BackendId);
    attached.delete("bk_first");
    await leaf.forget("bk_first" as BackendId);
    expect(leaf.source()?.controllerId).toBe("bk_second" as BackendId);
    attached.delete("bk_second");
    expect(leaf.current()).toBeNull();
  });
});
