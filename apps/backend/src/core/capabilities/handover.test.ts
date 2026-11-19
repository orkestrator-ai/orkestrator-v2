/**
 * Command-node handover of capability authority over real node links
 * (in-memory network, real `NodeService` handover and real capability
 * services): the state, its artifacts and the single-writer epoch move to
 * the new command node; the old one stops acting and is refused everywhere.
 */
import { CAPABILITY_LIMITS, MY_SETUP_ID } from "@orkestrator/protocol/capability-resources";
import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { NodeRoute } from "@orkestrator/protocol/command-nodes";
import type { BackendId, RouteId } from "@orkestrator/protocol/federation";

import {
  settle,
  stopTestNodeNetworks,
  TestNodeNetwork,
} from "../nodes/node-network-test-support.js";
import { CapabilityArtifactStore } from "./artifact-store.js";
import {
  addCapabilityNode,
  addSkill,
  disposeCapabilityNodes,
  skillFile,
  type CapabilityNode,
} from "./capability-network-test-support.js";
import { buildHandoverBundle } from "./handover.js";
import { validatePackageFiles, treeDigest } from "./security.js";

afterEach(async () => {
  await stopTestNodeNetworks();
  await disposeCapabilityNodes();
});

function route(node: CapabilityNode): NodeRoute {
  return { id: "primary" as RouteId, kind: "https", enabled: true, origin: node.node.origin };
}

async function attach(command: CapabilityNode, leaf: CapabilityNode) {
  await command.node.service.addNode({ routes: [route(leaf)], token: leaf.node.token });
}

async function fleet() {
  const network = new TestNodeNetwork();
  const desktop = await addCapabilityNode(network, "desktop", {
    forceRegistration: true,
    commandable: true,
  });
  const mini = await addCapabilityNode(network, "mini", { commandable: true });
  const gram = await addCapabilityNode(network, "gram");
  await attach(desktop, mini);
  await attach(desktop, gram);
  return { network, desktop, mini, gram };
}

async function handOver(from: CapabilityNode, to: CapabilityNode) {
  const result = await from.node.service.handOverCommand({
    nodeId: to.id as BackendId,
    includeSelf: true,
    entries: [],
  });
  await settle(60);
  return result;
}

describe("command-node handover of capability authority", () => {
  test("the receiver retains its private session plugin through handover", async () => {
    const { desktop, mini } = await fleet();
    const toolkit = await desktop.cap.setSetup({ setup: { name: "Private tools" } });
    await addSkill(desktop, "private", "Private instructions.", {
      setupId: toolkit.id,
      required: true,
    });
    await desktop.cap.assignSetup({
      scope: "session",
      scopeId: "private-session",
      setupIds: [toolkit.id],
    });
    await mini.cap.preflightSession({
      environmentId: "env-1",
      provider: "claude",
      sessionKey: "private-session",
    });
    const plugin = await mini.cap.sessionPlugins("private-session");
    expect(plugin).toHaveLength(1);
    await handOver(desktop, mini);
    expect(await mini.cap.sessionPlugins("private-session")).toEqual(plugin);
  });

  test("state and artifacts move with a higher epoch; the old controller is refused everywhere", async () => {
    const { desktop, mini, gram } = await fleet();
    const { inspection } = await addSkill(desktop, "review", "Review carefully.");
    expect(await fs.readFile(skillFile(gram, ".claude", "review"), "utf8")).toContain(
      "Review carefully.",
    );
    const before = await desktop.storage.capabilities.loadCapabilityState();
    expect(before.epoch).toBe(1);

    await handOver(desktop, mini);

    // The new command node holds the library, setups, receipts and the bytes.
    const moved = await mini.storage.capabilities.loadCapabilityState();
    expect(moved.epoch).toBe(2);
    expect(moved.controllerId).toBe(mini.id);
    expect(moved.handover).toMatchObject({ role: "received", peerId: desktop.id, epoch: 2 });
    expect(Object.keys(moved.packages)).toEqual([inspection.packageId]);
    expect(Object.keys(moved.receipts).sort()).toEqual(Object.keys(before.receipts).sort());
    expect(Object.keys(moved.operations).sort()).toEqual(Object.keys(before.operations).sort());
    // Digest-verified on arrival and on read.
    expect(treeDigest(await mini.cap.artifacts.get(inspection.artifactDigest))).toBe(
      inspection.artifactDigest,
    );
    expect(await mini.storage.capabilities.loadCapabilityExecutorState()).toMatchObject({
      epoch: 2,
      controllerId: mini.id,
    });

    // The old command node stops acting as the authority.
    const old = await desktop.storage.capabilities.loadCapabilityState();
    expect(old.handover).toMatchObject({ role: "sent", peerId: mini.id, epoch: 2 });
    await expect(
      desktop.cap.authorPackage({ kind: "skill", name: "late", content: "Too late." }),
    ).rejects.toThrow("command node");
    gram.applyCalls.length = 0;
    await desktop.cap.reconciler.reconcileAll("after-handover");
    expect(gram.applyCalls).toEqual([]);

    // The new authority reaches the leaf with the new epoch.
    expect((await mini.node.service.status()).mode).toBe("command");
    await mini.cap.reconciler.reconcileAll("test");
    await mini.cap.reconciler.idle();
    expect(await gram.storage.capabilities.loadCapabilityExecutorState()).toMatchObject({
      epoch: 2,
      controllerId: mini.id,
    });
    // Nothing was rewritten: the leaf already had the bytes.
    expect(gram.applyCalls).toEqual([]);

    // A leaf and the old node's own executor refuse the old controller.
    await expect(gram.cap.executorObserve({ controllerId: desktop.id, epoch: 1 })).rejects.toThrow(
      "newer command node",
    );
    await expect(
      gram.cap.executorApply({ controllerId: desktop.id, epoch: 1, targets: [] }),
    ).rejects.toThrow("newer command node");
    await expect(
      desktop.cap.executorObserve({ controllerId: desktop.id, epoch: 1 }),
    ).rejects.toThrow("newer command node");
    // Same epoch from another controller is refused too.
    await expect(gram.cap.executorObserve({ controllerId: desktop.id, epoch: 2 })).rejects.toThrow(
      "Another command node",
    );

    // The new authority manages the fleet, the old node included as its leaf.
    await addSkill(mini, "notes", "Take notes.");
    expect(await fs.readFile(skillFile(gram, ".claude", "notes"), "utf8")).toContain("Take notes.");
    expect(await fs.readFile(skillFile(desktop, ".claude", "notes"), "utf8")).toContain(
      "Take notes.",
    );
  });

  test("a pending operation resumes on the new authority with the latest revision only", async () => {
    const { network, desktop, mini, gram } = await fleet();
    gram.node.online = false;
    gram.node.dropStreams();
    await settle(20);
    const first = await addSkill(desktop, "docs", "Version one.");
    const source = first.inspection.source;
    if (source.kind !== "managed") throw new Error("Expected an authored package.");
    const second = await addSkill(desktop, "docs", "Version two.", {
      managedId: source.managedId,
    });
    const waiting = await desktop.cap.getOperation({
      operationId: second.applied.operation.id,
    });
    expect(waiting.targets.some((target) => target.status === "offline")).toBe(true);
    expect(gram.applyCalls).toEqual([]);

    await handOver(desktop, mini);
    const resumed = await mini.cap.getOperation({ operationId: second.applied.operation.id });
    expect(resumed.state).toBe(waiting.state);

    gram.node.online = true;
    network.timers.runAll();
    await settle(60);
    await mini.cap.reconciler.reconcileAll("connected");
    await mini.cap.reconciler.idle();
    expect(gram.applyCalls.length).toBeGreaterThan(0);
    expect(gram.applyCalls.every((call) => call.digest !== first.inspection.artifactDigest)).toBe(
      true,
    );
    expect(await fs.readFile(skillFile(gram, ".claude", "docs"), "utf8")).toContain("Version two.");
    expect(await gram.storage.capabilities.loadCapabilityExecutorState()).toMatchObject({
      controllerId: mini.id,
      epoch: 2,
    });
    const settled = await mini.cap.getOperation({ operationId: second.applied.operation.id });
    expect(settled.targets.filter((target) => target.target.nodeId === gram.id)).not.toContainEqual(
      expect.objectContaining({ status: "offline" }),
    );
  });

  test("an interrupted transfer abandons the handover; the old node stays the authority", async () => {
    const { desktop, mini } = await fleet();
    await addSkill(desktop, "lint", "Lint.");
    mini.failNextStage = "state";
    await expect(handOver(desktop, mini)).rejects.toThrow("interrupted");
    // Nothing was adopted: the target is registered here again and has no authority.
    expect((await desktop.node.service.listNodes()).nodes.map((node) => node.nodeId)).toContain(
      mini.id as BackendId,
    );
    const target = await mini.storage.capabilities.loadCapabilityState();
    expect(target.handover).toBeUndefined();
    expect(Object.keys(target.packages)).toEqual([]);
    const old = await desktop.storage.capabilities.loadCapabilityState();
    expect(old.handover).toBeUndefined();
    await expect(
      desktop.cap.authorPackage({ kind: "skill", name: "still", content: "Still here." }),
    ).resolves.toBeDefined();

    // Retrying hands over normally; the staged chunks are reused safely.
    await handOver(desktop, mini);
    expect((await mini.storage.capabilities.loadCapabilityState()).epoch).toBe(2);
  });

  test("a lost accept answer is recovered with the same handover id, without a second epoch", async () => {
    const { desktop, mini } = await fleet();
    await addSkill(desktop, "lint", "Lint.");
    const accept = mini.node.commands.get("accept_command_handover");
    let lose = 2;
    mini.node.commands.set("accept_command_handover", async (args) => {
      const answer = await mini.node.service.acceptHandover(
        args.controllerId,
        (args.entries ?? []) as never,
        args.handoverId,
      );
      if (lose-- > 0) throw new Error("socket hang up");
      return answer;
    });
    await expect(handOver(desktop, mini)).rejects.toThrow("pending");
    // Installed once on the target; the old node is no longer acting while it is pending.
    expect((await mini.storage.capabilities.loadCapabilityState()).epoch).toBe(2);
    expect((await desktop.storage.capabilities.loadCapabilityState()).handover?.role).toBe(
      "sending",
    );
    await expect(
      desktop.cap.authorPackage({ kind: "skill", name: "x", content: "y" }),
    ).rejects.toThrow("command node");

    if (accept) mini.node.commands.set("accept_command_handover", accept);
    else mini.node.commands.delete("accept_command_handover");
    // The journal's retry (as on restart) completes the same handover.
    await handOver(desktop, mini);
    const moved = await mini.storage.capabilities.loadCapabilityState();
    expect(moved.epoch).toBe(2);
    expect((await desktop.storage.capabilities.loadCapabilityState()).handover).toMatchObject({
      role: "sent",
      epoch: 2,
    });
  });

  test("a multi-chunk handover preserves non-BMP text at the chunk boundary", async () => {
    const { desktop, mini } = await fleet();
    await addSkill(desktop, "lint", "Lint.");
    const name = "a".repeat(CAPABILITY_LIMITS.artifactChunkBytes - 1_024) + "🐙".repeat(1024);
    desktop.storage.capabilities.mutateCapabilityState((state) => {
      state.setups[MY_SETUP_ID]!.description = name;
      return { result: undefined, changed: true };
    });
    await handOver(desktop, mini);
    const state = await mini.storage.capabilities.loadCapabilityState();
    expect(state.setups[MY_SETUP_ID]?.description).toBe(name);
  });

  test("the receiver verifies the state and artifact digests before installing", async () => {
    const { desktop, mini } = await fleet();
    await addSkill(desktop, "lint", "Lint.");
    const state = await desktop.storage.capabilities.loadCapabilityState();
    const bundle = buildHandoverBundle(state, {
      handoverId: "handover-1",
      fromControllerId: desktop.id,
      artifactDigests: [],
    });
    const base = { controllerId: desktop.id, epoch: 1, handoverId: "handover-1" };
    await expect(
      mini.cap.executorStageHandover({
        ...base,
        part: "state",
        digest: bundle.digest,
        index: 0,
        count: 1,
        data: bundle.text.replace("lint", "LINT"),
      }),
    ).rejects.toThrow("does not match");
    const files = validatePackageFiles([
      { path: "SKILL.md", content: Buffer.from("Real bytes."), executable: false },
    ]);
    const forged = validatePackageFiles([
      { path: "SKILL.md", content: Buffer.from("Other bytes."), executable: false },
    ]);
    const [chunk] = CapabilityArtifactStore.bundleChunks(forged);
    await expect(
      mini.cap.executorStageHandover({
        ...base,
        part: "artifact",
        digest: treeDigest(files),
        index: 0,
        count: 1,
        data: chunk!,
      }),
    ).rejects.toThrow("does not match");
    // An older controller cannot stage at all.
    await mini.cap.executorObserve({ controllerId: desktop.id, epoch: 3 });
    await expect(
      mini.cap.executorStageHandover({ ...base, part: "state", digest: bundle.digest }),
    ).rejects.toThrow("newer command node");
    // Nothing staged was installed.
    await expect(
      mini.cap.handoverReceiver.install({ controllerId: desktop.id, handoverId: "handover-1" }),
    ).resolves.toEqual({ installed: false });
    expect(
      await fs.readdir(path.join(mini.dir, "data", "capability-handover")).catch(() => []),
    ).not.toContain("handover-1.json");
  });
});
