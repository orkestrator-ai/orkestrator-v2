import { afterEach, describe, expect, test } from "bun:test";

import {
  BACKEND_PROFILE_CHANGED_EVENT,
  type BackendProfile,
} from "@orkestrator/protocol/backend-profile";
import type { RouteId } from "@orkestrator/protocol/federation";
import {
  NODE_SUMMARY_CHANGED_EVENT,
  type NodeSummariesResult,
} from "@orkestrator/protocol/node-summaries";

import { TestNodeNetwork, type TestNode } from "./node-network-test-support.js";
import { NodePortal } from "./node-portal.js";

const updatedProfile: BackendProfile = {
  revision: 3,
  displayName: "Build machine",
  colorToken: "rose",
  updatedAt: "2026-10-21T01:00:00.000Z",
};

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for node profile sync.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function setup() {
  const network = new TestNodeNetwork();
  cleanups.push(async () => {
    for (const node of network.nodes.values()) {
      node.portal.stop();
      await node.service.stop();
    }
  });
  const command = await network.add("command", { forceRegistration: true });
  const leaf = await network.add("leaf");
  leaf.commands.set("get_projects", () => []);
  // Capture the actual first read a summary-only client makes on notification.
  command.portal.stop();
  const reads: Array<Promise<NodeSummariesResult>> = [];
  const portal = new NodePortal({
    nodes: command.service,
    fetchImpl: network.fetch,
    emit(event, payload) {
      command.events.push({ event, payload });
      if (event === NODE_SUMMARY_CHANGED_EVENT) reads.push(portal.summaries());
    },
  });
  cleanups.push(() => portal.stop());
  await portal.start();
  await command.service.addNode({
    routes: [{ id: "primary" as RouteId, kind: "https", enabled: true, origin: leaf.origin }],
    token: leaf.token,
  });
  await waitFor(() => leaf.streams.size === 1 && reads.length > 0);
  await Promise.all(reads);
  reads.length = 0;
  command.events.length = 0;
  return { command, leaf, portal, reads };
}

/** Hold the asynchronous store boundary, where the service's view is still old. */
function holdRegistryWrite(node: TestNode) {
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = node.storage.mutateNodeRegistry.bind(node.storage);
  node.storage.mutateNodeRegistry = async (mutate) => {
    entered();
    await held;
    return original(mutate);
  };
  cleanups.push(() => {
    release();
    node.storage.mutateNodeRegistry = original;
  });
  return { started, release };
}

describe("node profile events through the connected stream", () => {
  test("the first summary notification reads the committed name and colour", async () => {
    const { command, leaf, portal, reads } = await setup();
    const write = holdRegistryWrite(command);
    leaf.emit(BACKEND_PROFILE_CHANGED_EVENT, updatedProfile);
    await write.started;
    // Longer than the notification debounce: a slow store must not publish early.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(reads).toHaveLength(0);
    expect((await portal.summaries()).nodes[0]!.view.displayName).toBe("leaf machine");

    write.release();
    await waitFor(() => reads.length > 0);
    expect((await reads[0]!).nodes[0]!.view).toMatchObject({
      displayName: updatedProfile.displayName,
      colorToken: updatedProfile.colorToken,
    });
    expect(command.storage.registry.nodes[0]!.profileCache).toEqual({
      revision: updatedProfile.revision,
      displayName: updatedProfile.displayName,
      colorToken: updatedProfile.colorToken,
    });
    // A client that missed the event can rehydrate from the same backend snapshot.
    expect((await portal.summaries()).nodes[0]!.view).toEqual((await reads[0]!).nodes[0]!.view);
  });

  test("malformed payloads leave the cache unchanged and the stream usable", async () => {
    const { command, leaf, portal, reads } = await setup();
    const before = structuredClone(command.storage.registry);
    const writes = command.storage.writes.registry;
    for (const payload of [
      null,
      {},
      { ...updatedProfile, revision: 0 },
      { ...updatedProfile, displayName: "" },
      { ...updatedProfile, colorToken: "invalid colour" },
    ]) {
      leaf.emit(BACKEND_PROFILE_CHANGED_EVENT, payload);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(command.storage.registry).toEqual(before);
    expect(command.storage.writes.registry).toBe(writes);
    expect(reads).toHaveLength(0);
    expect((await portal.summaries()).nodes[0]!.view.displayName).toBe("leaf machine");

    leaf.emit(BACKEND_PROFILE_CHANGED_EVENT, updatedProfile);
    await waitFor(() => reads.length > 0);
    expect((await reads[0]!).nodes[0]!.view.colorToken).toBe("rose");
  });

  test("an older profile after a newer one cannot revert any summary view", async () => {
    const { command, leaf, portal, reads } = await setup();
    leaf.emit(BACKEND_PROFILE_CHANGED_EVENT, updatedProfile);
    await waitFor(() => reads.length > 0);
    const writes = command.storage.writes.registry;
    reads.length = 0;
    leaf.emit(BACKEND_PROFILE_CHANGED_EVENT, {
      ...updatedProfile,
      revision: 2,
      displayName: "Old name",
      colorToken: "amber",
    });
    await waitFor(() => reads.length > 0);
    expect(command.storage.writes.registry).toBe(writes);
    for (const result of [...(await Promise.all(reads)), await portal.summaries()]) {
      expect(result.nodes[0]!.view).toMatchObject({
        displayName: updatedProfile.displayName,
        colorToken: updatedProfile.colorToken,
      });
    }
    expect(command.storage.registry.nodes[0]!.profileCache?.revision).toBe(3);
  });
});

describe("routed backend profile updates", () => {
  test("a successful response updates the cache before invokeOnNode returns", async () => {
    const { command, leaf, portal } = await setup();
    leaf.commands.set("update_backend_profile", () => updatedProfile);
    const write = holdRegistryWrite(command);
    let returned = false;
    const invoke = portal
      .invokeOnNode({
        nodeId: "bk_leaf",
        command: "update_backend_profile",
        args: { expectedRevision: 1, displayName: "Build machine", colorToken: "rose" },
      })
      .then((result) => {
        returned = true;
        return result;
      });
    await write.started;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(returned).toBe(false);
    expect((await portal.summaries()).nodes[0]!.view.displayName).toBe("leaf machine");
    write.release();
    expect(await invoke).toEqual({ outcome: "ok", result: updatedProfile });
    expect((await portal.summaries()).nodes[0]!.view).toMatchObject({
      displayName: updatedProfile.displayName,
      colorToken: updatedProfile.colorToken,
    });
    expect(command.storage.registry.nodes[0]!.profileCache?.revision).toBe(3);
    expect(leaf.received.filter((entry) => entry.command === "update_backend_profile")).toEqual([
      { command: "update_backend_profile", controller: "bk_command" },
    ]);
  });

  test("malformed successful results do not change the profile cache", async () => {
    const { command, leaf, portal } = await setup();
    const before = structuredClone(command.storage.registry);
    const view = (await portal.summaries()).nodes[0]!.view;
    for (const result of [null, {}, { ...updatedProfile, colorToken: "invalid colour" }]) {
      leaf.commands.set("update_backend_profile", () => result);
      expect(
        await portal.invokeOnNode({
          nodeId: "bk_leaf",
          command: "update_backend_profile",
          args: { expectedRevision: 1, displayName: "Build machine" },
        }),
      ).toEqual({ outcome: "ok", result });
      expect(command.storage.registry).toEqual(before);
      expect((await portal.summaries()).nodes[0]!.view).toEqual(view);
    }
  });

  test("a failed remote edit leaves the cache unchanged", async () => {
    const { command, leaf, portal } = await setup();
    const before = structuredClone(command.storage.registry);
    const view = (await portal.summaries()).nodes[0]!.view;
    leaf.commands.set("update_backend_profile", () => {
      throw new Error("Profile edit refused");
    });
    await expect(
      portal.invokeOnNode({
        nodeId: "bk_leaf",
        command: "update_backend_profile",
        args: { expectedRevision: 1, displayName: "Build machine" },
      }),
    ).rejects.toThrow("Profile edit refused");
    expect(command.storage.registry).toEqual(before);
    expect((await portal.summaries()).nodes[0]!.view).toEqual(view);
  });
});
