/**
 * Launch authority: a leaf's native launch is resolved by its command node
 * over the real node link (request on the leaf's event stream, answer by an
 * internal command), recorded there, and enforced on the leaf; without the
 * command node, only a recent cached answer whose installations are unchanged
 * stands in, and required components otherwise fail closed. At launch, the
 * recorded deliveries are exactly the observed bytes.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";

import type { NodeRoute } from "@orkestrator/protocol/command-nodes";
import type { RouteId } from "@orkestrator/protocol/federation";

import {
  settle,
  stopTestNodeNetworks,
  TestNodeNetwork,
} from "../nodes/node-network-test-support.js";
import {
  addCapabilityNode,
  addSkill,
  disposeCapabilityNodes,
  skillFile,
  type CapabilityNode,
} from "./capability-network-test-support.js";
import { COMMAND_NODE_UNREACHABLE_REASON } from "./launch-authority.js";

afterEach(async () => {
  await stopTestNodeNetworks();
  await disposeCapabilityNodes();
});

function route(node: CapabilityNode): NodeRoute {
  return { id: "primary" as RouteId, kind: "https", enabled: true, origin: node.node.origin };
}

async function fleet() {
  const network = new TestNodeNetwork();
  const desktop = await addCapabilityNode(network, "desktop", { forceRegistration: true });
  const gram = await addCapabilityNode(network, "gram", { launchAnswerTimeoutMs: 2_000 });
  await desktop.node.service.addNode({ routes: [route(gram)], token: gram.node.token });
  await settle(40);
  return { network, desktop, gram };
}

const launch = (sessionKey: string, environmentId = "env-1") => ({
  environmentId,
  provider: "claude" as const,
  sessionKey,
});

describe("leaf launch authority", () => {
  test.each([false, true])(
    "missing command-node private bytes are narrowed at the leaf (required: %s)",
    async (required) => {
      const { desktop, gram } = await fleet();
      const toolkit = await desktop.cap.setSetup({ setup: { name: "Private" } });
      const { inspection } = await addSkill(desktop, "private", "Private instructions.", {
        required,
        setupId: toolkit.id,
      });
      await desktop.cap.assignSetup({ scope: "session", scopeId: "s1", setupIds: [toolkit.id] });
      await desktop.cap.reconciler.idle();
      const get = desktop.cap.artifacts.get.bind(desktop.cap.artifacts);
      const artifact = spyOn(desktop.cap.artifacts, "get").mockImplementation((digest) =>
        digest === inspection.artifactDigest
          ? Promise.reject(new Error("Artifact unavailable"))
          : get(digest),
      );
      if (required) {
        await expect(gram.cap.preflightSession(launch("s1"))).rejects.toThrow("could not be sent");
      } else {
        const effective = await gram.cap.preflightSession(launch("s1"));
        expect(effective?.resolvedPackages).toEqual([]);
        expect(effective?.warnings.join(" ")).toContain("could not be sent");
      }
      expect(await gram.cap.sessionPlugins("s1")).toEqual([]);
      artifact.mockRestore();
    },
  );

  test("the command node resolves and records a leaf's launch; the leaf enforces the answer", async () => {
    const { desktop, gram } = await fleet();
    const { inspection } = await addSkill(desktop, "docs", "Write docs.", { required: true });
    expect(await fs.readFile(skillFile(gram, ".claude", "docs"), "utf8")).toContain("Write docs.");
    // The leaf's own store holds no setups; only the command node can resolve this.
    expect(Object.keys((await gram.storage.capabilities.loadCapabilityState()).packages)).toEqual(
      [],
    );

    const effective = await gram.cap.preflightSession(launch("s1"));
    expect(effective?.resolvedPackages.map((entry) => entry.id)).toEqual([inspection.packageId]);
    expect(effective?.launchBlockers).toEqual([]);

    // Recorded on the command node, with exactly the observed bytes.
    const recorded = (await desktop.storage.capabilities.loadCapabilityState()).launches[
      `${gram.id}|s1`
    ];
    expect(recorded?.resolvedBy).toBe(desktop.id);
    expect(recorded?.target.nodeId).toBe(gram.id);
    const inventory = await gram.cap.observeSelf();
    const claudeCopy = inventory.items.find(
      (item) =>
        item.ownership === "managed" && item.locationId === recorded?.deliveries?.[0]?.locationId,
    );
    expect(recorded?.deliveries).toEqual([
      expect.objectContaining({ packageId: inspection.packageId, digest: claudeCopy?.digest }),
    ]);
    // And on the leaf, naming who resolved it.
    expect((await gram.storage.capabilities.loadCapabilityState()).launches.s1?.resolvedBy).toBe(
      desktop.id,
    );

    // Changed bytes on the leaf block the next launch.
    await fs.writeFile(skillFile(gram, ".claude", "docs"), "Local edit.");
    await expect(gram.cap.preflightSession(launch("s2"))).rejects.toThrow("cannot have");
  });

  test("an unreachable command node: a recent matching cached answer stands in, otherwise required fails closed", async () => {
    const { desktop, gram } = await fleet();
    await addSkill(desktop, "docs", "Write docs.", { required: true });
    await expect(gram.cap.preflightSession(launch("s1"))).resolves.toBeTruthy();

    gram.reachable = false;
    // Same logical session: the cached answer is used, with a warning.
    const cached = await gram.cap.preflightSession(launch("s1"));
    expect(cached?.resolvedPackages).toHaveLength(1);
    expect(cached?.target.sessionId).toBe("s1");
    expect(cached?.warnings.join(" ")).toContain("last answer");

    // An unverified session on the same target cannot borrow this answer.
    await expect(gram.cap.preflightSession(launch("s2"))).rejects.toThrow("unreachable");

    // A target never answered for: required capabilities cannot be confirmed.
    await expect(gram.cap.preflightSession(launch("s3", "env-2"))).rejects.toThrow(
      COMMAND_NODE_UNREACHABLE_REASON.slice(0, 40),
    );

    // The cached answer is void once this machine's applied installations change.
    gram.storage.capabilities.mutateCapabilityExecutorState((state) => {
      state.applied["bk_gram|elsewhere|x"] = {
        digest: "sha256:0",
        at: "2026-11-19",
        action: "install",
      };
    });
    await expect(gram.cap.preflightSession(launch("s1"))).rejects.toThrow(
      COMMAND_NODE_UNREACHABLE_REASON.slice(0, 40),
    );

    // Or when it is too old.
    gram.storage.capabilities.mutateCapabilityExecutorState((state) => {
      delete state.applied["bk_gram|elsewhere|x"];
    });
    await expect(gram.cap.preflightSession(launch("s1"))).resolves.toBeTruthy();
    gram.cap.leafLaunch.cacheMaxAgeMs = -1;
    await expect(gram.cap.preflightSession(launch("s1"))).rejects.toThrow("cannot have");
  });

  test("optional capabilities only warn when the command node is unreachable", async () => {
    const { desktop, gram } = await fleet();
    await addSkill(desktop, "notes", "Take notes.");
    await expect(gram.cap.preflightSession(launch("s1"))).resolves.toBeTruthy();
    gram.reachable = false;
    const effective = await gram.cap.preflightSession(launch("s2", "env-new"));
    expect(effective?.launchBlockers).toEqual([]);
    expect(effective?.warnings.join(" ")).toContain("unreachable");
  });

  test("a stale controller's answer is refused by the leaf", async () => {
    const { gram } = await fleet();
    await gram.cap.executorObserve({ controllerId: "bk_newer", epoch: 7 });
    await expect(
      gram.cap.executorLaunchAnswer({
        controllerId: "bk_desktop",
        epoch: 1,
        requestId: "r1",
        answer: {},
      }),
    ).rejects.toThrow("newer command node");
  });
});

describe("launch deliveries on the authority", () => {
  test("every copy the provider reads must hold the recorded bytes; others do not matter", async () => {
    const network = new TestNodeNetwork();
    const desktop = await addCapabilityNode(network, "desktop", { forceRegistration: true });
    const { inspection } = await addSkill(desktop, "docs", "Write docs.", { required: true });
    const allowed = await desktop.cap.preflightSession(launch("s1"));
    expect(allowed?.launchBlockers).toEqual([]);
    const record = (await desktop.storage.capabilities.loadCapabilityState()).launches.s1;
    const observed = (await desktop.cap.observeSelf()).items.filter(
      (item) => item.ownership === "managed" && item.packageId === inspection.packageId,
    );
    // Exactly the observed copies Claude reads, with their observed digests.
    const claudeReads = observed.filter((item) => item.visibleTo.includes("claude"));
    expect(claudeReads.length).toBeGreaterThan(0);
    expect(
      record?.deliveries?.map((entry) => `${entry.locationId}=${entry.digest}`).sort(),
    ).toEqual(claudeReads.map((item) => `${item.locationId}=${item.digest}`).sort());

    // A copy only other providers read may change without blocking Claude.
    await fs.writeFile(skillFile(desktop, ".agents", "docs"), "Edited for Codex.");
    await expect(desktop.cap.preflightSession(launch("s2"))).resolves.toBeTruthy();
    // Claude's own copy may not.
    await fs.writeFile(skillFile(desktop, ".claude", "docs"), "Edited for Claude.");
    await expect(desktop.cap.preflightSession(launch("s3"))).rejects.toThrow("cannot have");
  });
});
