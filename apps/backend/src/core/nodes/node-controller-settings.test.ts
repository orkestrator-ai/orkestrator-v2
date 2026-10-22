import { afterEach, describe, expect, test } from "bun:test";

import {
  SYNC_CONTROLLER_SETTINGS_COMMAND,
  type InheritedGlobalSettings,
} from "@orkestrator/protocol/controller-settings";
import type { BackendId, RouteId } from "@orkestrator/protocol/federation";

import { TestNodeNetwork } from "./node-network-test-support.js";

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
});
