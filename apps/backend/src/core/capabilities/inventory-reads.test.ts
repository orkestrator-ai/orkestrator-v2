/**
 * Unmanaged plugin listings stay off the launch path on the command node and
 * leaf. Launch checks read files live and only request a bounded Claude list
 * when an applicable managed plugin needs verification. Readers share one
 * listing in its window, and a change this machine applies lists again.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";

import { MY_SETUP_ID } from "@orkestrator/protocol/capability-resources";
import type { NodeRoute } from "@orkestrator/protocol/command-nodes";
import type { RouteId } from "@orkestrator/protocol/federation";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";

import type { AgentPluginCatalog, ExtensionCommandRunner } from "../extension-discovery.js";
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
import {
  createClaudeInventoryPluginSource,
  inventoryPluginLister,
  inventoryPluginTimeoutMessage,
} from "./inventory-plugins.js";

import type { CapabilityHomes } from "./native-ownership.js";
import { ClaudePluginAdapter } from "./provider-adapters/claude-plugins.js";
import { FakeClaudeCli } from "./provider-adapters/fake-claude-cli.test-support.js";

let logs: LogCapture;

beforeEach(() => {
  logs = captureLogs();
});

afterEach(async () => {
  logs.restore();
  await stopTestNodeNetworks();
  await disposeCapabilityNodes();
});

const LIST_TIMEOUT_MS = 100;

/** Provider plugin listings where Codex never answers, counting each agent's runs. */
function hungCodexListings() {
  const runs = new Map<string, number>();
  const extra: string[] = [];
  const discover = async (
    agent: Parameters<typeof import("../extension-discovery.js").discoverAgentPlugins>[0],
  ): Promise<AgentPluginCatalog> => {
    runs.set(agent, (runs.get(agent) ?? 0) + 1);
    if (agent === "codex") return new Promise<never>(() => undefined);
    return {
      agent,
      plugins: [
        { name: `${agent}-plugin`, status: "configured" },
        ...(agent === "claude"
          ? extra.map((name) => ({ name, status: "configured" as const }))
          : []),
      ],
    };
  };
  const run: ExtensionCommandRunner = async () => "";
  return {
    runs,
    /** Plugins Claude lists from now on. */
    extra,
    total: () => [...runs.values()].reduce((sum, count) => sum + count, 0),
    plugins: inventoryPluginLister({ run, timeoutMs: LIST_TIMEOUT_MS, discover }),
  };
}

const launch = (sessionKey: string, environmentId = "env-1") => ({
  environmentId,
  provider: "claude" as const,
  sessionKey,
});

function route(node: CapabilityNode): NodeRoute {
  return { id: "primary" as RouteId, kind: "https", enabled: true, origin: node.node.origin };
}

describe("inventory reads", () => {
  test("concurrent and repeated readers run each agent's listing once", async () => {
    const network = new TestNodeNetwork();
    const listings = hungCodexListings();
    const desktop = await addCapabilityNode(network, "desktop", {
      forceRegistration: true,
      inventoryPlugins: listings.plugins,
    });
    await desktop.cap.reconciler.idle();
    const before = new Map(listings.runs);
    const inventories = await Promise.all([
      desktop.cap.observeSelf(),
      desktop.cap.observeSelf(),
      desktop.cap.getInventory({}),
    ]);
    await desktop.cap.observeSelf();
    for (const agent of ["claude", "codex", "grok", "opencode", "pi"]) {
      expect((listings.runs.get(agent) ?? 0) - (before.get(agent) ?? 0)).toBeLessThanOrEqual(1);
    }
    expect(listings.runs.get("codex")).toBe(1);
    // The hung agent is named; the others are listed.
    for (const inventory of inventories) {
      expect(inventory.errors).toContainEqual({
        source: "plugin-discovery",
        message: inventoryPluginTimeoutMessage("codex", LIST_TIMEOUT_MS),
      });
      expect(
        inventory.items
          .filter((item) => item.kind === "native-plugin")
          .map((item) => item.name)
          .sort(),
      ).toEqual(["claude-plugin", "grok-plugin", "opencode-plugin", "pi-plugin"]);
    }
  });

  test("the Capabilities view's observation returns within the per-agent limit", async () => {
    const network = new TestNodeNetwork();
    const listings = hungCodexListings();
    const desktop = await addCapabilityNode(network, "desktop", {
      forceRegistration: true,
      inventoryPlugins: listings.plugins,
    });
    const started = performance.now();
    const inventory = await desktop.cap.getInventory({ refresh: true });
    // Bounded by the 100 ms limit, with ample room for a slow host; far below 20 s.
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(inventory.errors.map((error) => error.message).join(" ")).toContain("Codex");
  });

  test("a capability write on this machine lists the plugins again", async () => {
    const network = new TestNodeNetwork();
    const listings = hungCodexListings();
    const desktop = await addCapabilityNode(network, "desktop", {
      forceRegistration: true,
      inventoryPlugins: listings.plugins,
    });
    const names = async () =>
      (await desktop.cap.observeSelf()).items
        .filter((item) => item.kind === "native-plugin")
        .map((item) => item.name);
    expect(await names()).not.toContain("installed-by-hand");
    listings.extra.push("installed-by-hand");
    // Within the window, without a change, the earlier listing still serves.
    expect(await names()).not.toContain("installed-by-hand");
    await addSkill(desktop, "docs", "Write docs.");
    expect(await names()).toContain("installed-by-hand");

    listings.extra.push("second");
    desktop.cap.invalidateInventory();
    expect(await names()).toContain("second");
  });

  test("a command node's launch never runs a plugin listing; required checks still read the files", async () => {
    const network = new TestNodeNetwork();
    const listings = hungCodexListings();
    const desktop = await addCapabilityNode(network, "desktop", {
      forceRegistration: true,
      inventoryPlugins: listings.plugins,
    });
    // An empty library: the launch observes nothing at all.
    const observe = spyOn(desktop.cap, "observeSelf");
    await expect(desktop.cap.preflightSession(launch("s0"))).resolves.toBeTruthy();
    expect(observe).not.toHaveBeenCalled();
    observe.mockRestore();

    await addSkill(desktop, "docs", "Write docs.", { required: true });
    desktop.cap.invalidateInventory();
    const runs = listings.total();
    const effective = await desktop.cap.preflightSession(launch("s1"));
    expect(effective?.launchBlockers).toEqual([]);
    expect(effective?.resolvedPackages).toHaveLength(1);
    expect(listings.total()).toBe(runs);

    // A required copy changed by hand still blocks the launch.
    await fs.writeFile(skillFile(desktop, ".claude", "docs"), "Local edit.");
    await expect(desktop.cap.preflightSession(launch("s2"))).rejects.toThrow("cannot have");
    expect(listings.total()).toBe(runs);
  });

  test("a leaf's launch runs no plugin listing and reads its inventory once when nothing is required", async () => {
    const network = new TestNodeNetwork();
    const desktop = await addCapabilityNode(network, "desktop", { forceRegistration: true });
    const listings = hungCodexListings();
    const gram = await addCapabilityNode(network, "gram", {
      launchAnswerTimeoutMs: 2_000,
      inventoryPlugins: listings.plugins,
    });
    await desktop.node.service.addNode({ routes: [route(gram)], token: gram.node.token });
    await settle(40);
    await addSkill(desktop, "docs", "Write docs.");
    await desktop.cap.reconciler.idle();

    gram.cap.invalidateInventory();
    const runs = listings.total();
    const observe = spyOn(gram.cap, "observeSelf");
    try {
      const effective = await gram.cap.preflightSession(launch("s1"));
      expect(effective?.resolvedPackages).toHaveLength(1);
      expect(effective?.launchBlockers).toEqual([]);
      expect(observe).toHaveBeenCalledTimes(1);
      expect(observe.mock.calls[0]?.[0]).toMatchObject({ launch: true });
    } finally {
      observe.mockRestore();
    }
    expect(listings.total()).toBe(runs);
  });
});

test("an explicit remote refresh bypasses a settled leaf plugin listing", async () => {
  const network = new TestNodeNetwork();
  const desktop = await addCapabilityNode(network, "desktop", { forceRegistration: true });
  let name = "original-plugin";
  const leaf = await addCapabilityNode(network, "leaf", {
    inventoryPlugins: async () => ({
      plugins: [{ provider: "codex", qualifiedId: name, name, enabled: true }],
    }),
  });
  await desktop.node.service.addNode({ routes: [route(leaf)], token: leaf.node.token });
  await settle(40);
  const read = () => desktop.cap.getInventory({ nodeId: leaf.id, refresh: true });
  expect((await read()).items.map((item) => item.name)).toContain(name);
  name = "externally-installed-plugin";
  expect((await leaf.cap.observeSelf()).items.map((item) => item.name)).not.toContain(name);
  expect((await read()).items.map((item) => item.name)).toContain(name);
});

test("remote Test verifies the managed file without starting cold plugin discovery", async () => {
  const network = new TestNodeNetwork();
  const desktop = await addCapabilityNode(network, "desktop", { forceRegistration: true });
  const listings = hungCodexListings();
  const leaf = await addCapabilityNode(network, "leaf", { inventoryPlugins: listings.plugins });
  await desktop.node.service.addNode({ routes: [route(leaf)], token: leaf.node.token });
  await settle(40);
  const { inspection } = await addSkill(desktop, "remote-docs", "Write docs.");
  await desktop.cap.reconciler.idle();

  leaf.cap.invalidateInventory();
  const runs = listings.total();
  const verification = await desktop.cap.verify({
    consent: true,
    target: { nodeId: leaf.id, provider: "claude" },
    componentIds: [inspection.components[0]!.id],
  });
  expect(verification.checks).toContainEqual(
    expect.objectContaining({ level: "present", status: "installed-next-session" }),
  );
  expect(listings.total()).toBe(runs);
});

function managedClaude() {
  let hangs = false;
  let listings = 0;
  return {
    deps(homes: CapabilityHomes) {
      const fake = new FakeClaudeCli(homes.claudeConfigDir);
      const adapter = new ClaudePluginAdapter({ homes: () => homes, cli: fake.cli });
      return {
        claudePlugins: adapter,
        claudeInventory: createClaudeInventoryPluginSource({
          adapter,
          cli: (args) => {
            listings += 1;
            return hangs ? new Promise<never>(() => undefined) : fake.cli(args);
          },
          includeUnmanaged: true,
          timeoutMs: LIST_TIMEOUT_MS,
        }),
      };
    },
    hang() {
      hangs = true;
    },
    listings: () => listings,
  };
}

test("managed Claude uses one bounded listing and launches read it only for a selected plugin", async () => {
  const network = new TestNodeNetwork();
  const localClaude = managedClaude();
  const leafClaude = managedClaude();
  const desktop = await addCapabilityNode(network, "desktop", {
    forceRegistration: true,
    claudePlugins: localClaude.deps,
  });
  const leaf = await addCapabilityNode(network, "leaf", { claudePlugins: leafClaude.deps });
  await desktop.node.service.addNode({ routes: [route(leaf)], token: leaf.node.token });
  await settle(40);
  const inspected = await desktop.cap.authorPackage({
    kind: "upload",
    name: "review-plugin",
    files: [
      {
        path: "review-plugin/.claude-plugin/plugin.json",
        content: JSON.stringify({
          name: "review-plugin",
          version: "1.0.0",
          description: "Review tools",
        }),
      },
    ],
  });
  const plugin = inspected.components.find((component) => component.kind === "native-plugin")!;
  const preview = await desktop.cap.previewChange({
    change: {
      kind: "add-to-setup",
      inspectionId: inspected.inspectionId,
      setupId: MY_SETUP_ID,
      required: true,
    },
  });
  await desktop.cap.applyChange({
    operationId: preview.operation.id,
    approvedDigest: preview.operation.planDigest,
  });
  await desktop.cap.reconciler.idle();

  for (const [node, cli] of [
    [desktop, localClaude],
    [leaf, leafClaude],
  ] as const) {
    const before = cli.listings();
    const inventory = await node.cap.getInventory({ refresh: true });
    const copies = inventory.items.filter((item) => item.qualifiedId?.startsWith("review-plugin@"));
    expect(copies).toEqual([
      expect.objectContaining({ ownership: "managed", componentId: plugin.id }),
    ]);
    expect(cli.listings() - before).toBe(1);
    const beforeLaunch = cli.listings();
    expect((await node.cap.preflightSession(launch("verified")))?.resolvedPackages).toContainEqual(
      expect.objectContaining({ id: inspected.packageId }),
    );
    // The leaf rechecks the required plugin after receiving its command node's answer.
    expect(cli.listings() - beforeLaunch).toBe(node === leaf ? 2 : 1);
    cli.hang();
  }

  const selections = desktop.storage.capabilities.mutateCapabilityState((state) => {
    const setup = state.setups[MY_SETUP_ID]!;
    const selections = setup.packageSelections;
    setup.packageSelections = [];
    return { result: selections, changed: true };
  });
  const localBefore = localClaude.listings();
  const leafBefore = leafClaude.listings();
  await expect(desktop.cap.preflightSession(launch("unrelated-desktop"))).resolves.toBeTruthy();
  await expect(leaf.cap.preflightSession(launch("unrelated-leaf"))).resolves.toBeTruthy();
  expect(localClaude.listings()).toBe(localBefore);
  expect(leafClaude.listings()).toBe(leafBefore);

  desktop.storage.capabilities.mutateCapabilityState((state) => {
    state.setups[MY_SETUP_ID]!.packageSelections = selections;
    return { result: undefined, changed: true };
  });
  for (const [node, cli] of [
    [desktop, localClaude],
    [leaf, leafClaude],
  ] as const) {
    const before = cli.listings();
    const started = performance.now();
    await expect(node.cap.preflightSession(launch("required-hung"))).rejects.toThrow(
      "not verified",
    );
    expect(cli.listings() - before).toBe(1);
    expect(performance.now() - started).toBeLessThan(5_000);
    const beforeInventory = cli.listings();
    const inventory = await node.cap.getInventory({ refresh: true });
    expect(cli.listings() - beforeInventory).toBe(1);
    expect(inventory.errors).toContainEqual(expect.objectContaining({ provider: "claude" }));
    expect(inventory.errors).toContainEqual(
      expect.objectContaining({
        source: "plugin-discovery",
        message: inventoryPluginTimeoutMessage("claude", LIST_TIMEOUT_MS),
      }),
    );
  }
});
