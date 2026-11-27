/**
 * Unmanaged plugin listings stay off the launch path on the command node and
 * leaf. Launch checks read files live and only request a bounded Claude list
 * when an applicable managed plugin needs verification. Readers share one
 * listing in its window, and a change this machine applies lists again.
 */
import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";

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
import { INVENTORY_PLUGIN_TTL_MS } from "./inventory-cache.js";
import {
  createClaudeInventoryPluginSource,
  inventoryPluginLister,
  inventoryPluginTimeoutMessage,
} from "./inventory-plugins.js";

import type { CapabilityHomes } from "./native-ownership.js";
import {
  ClaudePluginAdapter,
  ORKESTRATOR_CLAUDE_MARKETPLACE,
} from "./provider-adapters/claude-plugins.js";
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
function hungCodexListings(providers?: Parameters<typeof inventoryPluginLister>[0]["providers"]) {
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
    plugins: inventoryPluginLister({ run, timeoutMs: LIST_TIMEOUT_MS, discover, providers }),
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

function managedClaude(formatOutput = (stdout: string) => stdout) {
  let hangs = false;
  let listings = 0;
  let clock = 1_000_000;
  let fake: FakeClaudeCli;
  let beforeListing: (() => Promise<void>) | undefined;
  return {
    deps(homes: CapabilityHomes) {
      fake = new FakeClaudeCli(homes.claudeConfigDir);
      const adapter = new ClaudePluginAdapter({ homes: () => homes, cli: fake.cli });
      return {
        claudePlugins: adapter,
        claudeInventory: createClaudeInventoryPluginSource({
          adapter,
          cli: async (args) => {
            listings += 1;
            if (hangs) return new Promise<never>(() => undefined);
            await beforeListing?.();
            const result = await fake.cli(args);
            return { ...result, stdout: formatOutput(result.stdout) };
          },
          includeUnmanaged: true,
          timeoutMs: LIST_TIMEOUT_MS,
          now: () => clock,
        }),
      };
    },
    hang() {
      hangs = true;
    },
    pauseListing(until: Promise<void>) {
      const started = Promise.withResolvers<void>();
      beforeListing = () => {
        beforeListing = undefined;
        started.resolve();
        return until;
      };
      return started.promise;
    },
    async setEnabled(id: string, enabled: boolean) {
      const installed = fake.installed.get(id)!;
      const before = await fs.stat(installed.installPath);
      expect((await fake.cli(["plugin", enabled ? "enable" : "disable", id])).exitCode).toBe(0);
      expect((await fs.stat(installed.installPath)).mtimeMs).toBe(before.mtimeMs);
    },
    /** Moves the listing cache's clock on. */
    advance(ms: number) {
      clock += ms;
    },
    listings: () => listings,
  };
}

test("malformed Claude output leaves healthy plugins and the Codex timeout visible", async () => {
  const network = new TestNodeNetwork();
  const claude = managedClaude(() => "invalid JSON");
  const desktop = await addCapabilityNode(network, "desktop", {
    forceRegistration: true,
    claudePlugins: claude.deps,
    inventoryPlugins: hungCodexListings(["codex", "grok"]).plugins,
  });
  const inventory = await desktop.cap.getInventory({ refresh: true });
  expect(inventory.items).toContainEqual(
    expect.objectContaining({ provider: "grok", name: "grok-plugin" }),
  );
  expect(inventory.errors).toContainEqual({
    source: "plugin-discovery",
    message: "Claude's plugin list could not be read.",
  });
  expect(inventory.errors).toContainEqual({
    source: "plugin-discovery",
    message: inventoryPluginTimeoutMessage("codex", LIST_TIMEOUT_MS),
  });
});

async function fleetWithManagedClaude() {
  const network = new TestNodeNetwork();
  const banner = (stdout: string) => `Loading plugins...\n${stdout}\n`;
  const localClaude = managedClaude(banner);
  const leafClaude = managedClaude(banner);
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
  return { desktop, leaf, localClaude, leafClaude, inspected, plugin };
}

test("managed Claude accepts a banner and shares discovery while each launch checks enablement", async () => {
  const { desktop, leaf, localClaude, leafClaude, inspected, plugin } =
    await fleetWithManagedClaude();
  const qualifiedId = `review-plugin@${ORKESTRATOR_CLAUDE_MARKETPLACE}`;
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
    // Later full reads within the cache window share that listing, managed plugin included.
    cli.advance(INVENTORY_PLUGIN_TTL_MS - 1_000);
    const again = await node.cap.getInventory({});
    expect(again.items.filter((item) => item.qualifiedId?.startsWith("review-plugin@"))).toEqual([
      expect.objectContaining({ ownership: "managed", componentId: plugin.id }),
    ]);
    expect(cli.listings() - before).toBe(1);
    // A launch lists once even on a leaf, whose two checks share its fresh list.
    const beforeLaunch = cli.listings();
    expect((await node.cap.preflightSession(launch("verified")))?.resolvedPackages).toContainEqual(
      expect.objectContaining({ id: inspected.packageId }),
    );
    expect(cli.listings() - beforeLaunch).toBe(1);
    await node.cap.getInventory({});
    expect(cli.listings() - beforeLaunch).toBe(1);
    await cli.setEnabled(qualifiedId, false);
    // Keep the discovery cache warm and the installation files untouched.
    const afterDisable = await node.cap.getInventory({});
    expect(afterDisable.items).toContainEqual(
      expect.objectContaining({ qualifiedId, enabled: true, componentId: plugin.id }),
    );
    expect(cli.listings() - beforeLaunch).toBe(1);
    await expect(node.cap.preflightSession(launch("required-disabled"))).rejects.toThrow(
      "not verified",
    );
    expect(cli.listings() - beforeLaunch).toBe(2);
    await cli.setEnabled(qualifiedId, true);
  }
});

test("a hung Claude listing delays only launches that select the managed plugin", async () => {
  const { desktop, leaf, localClaude, leafClaude } = await fleetWithManagedClaude();
  for (const cli of [localClaude, leafClaude]) {
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

test("a legacy command node gets a retry only for selected managed Claude plugins", async () => {
  const { desktop, leaf, leafClaude, inspected, plugin } = await fleetWithManagedClaude();
  const answer = desktop.cap.answerLeafLaunch.bind(desktop.cap);
  const requests: Array<{ scopedManagedPlugins?: boolean; inventory?: { items?: unknown[] } }> = [];
  const legacy = spyOn(desktop.cap, "answerLeafLaunch").mockImplementation((nodeId, payload) => {
    const { requestId, request } = payload as {
      requestId: string;
      request: (typeof requests)[number];
    };
    requests.push(request);
    const { scopedManagedPlugins: _ignored, ...legacyRequest } = request;
    return answer(nodeId, { requestId, request: legacyRequest });
  });
  try {
    const before = leafClaude.listings();
    expect(
      (await leaf.cap.preflightSession(launch("legacy-required")))?.resolvedPackages,
    ).toContainEqual(expect.objectContaining({ id: inspected.packageId }));
    expect(requests.map((request) => request.scopedManagedPlugins)).toEqual([true, undefined]);
    expect(requests[1]?.inventory?.items).toContainEqual(
      expect.objectContaining({ locationId: "plugin:claude", componentId: plugin.id }),
    );
    expect(leafClaude.listings() - before).toBe(1);

    desktop.storage.capabilities.mutateCapabilityState((state) => {
      state.setups[MY_SETUP_ID]!.packageSelections = [];
      return { result: undefined, changed: true };
    });
    leafClaude.hang();
    requests.length = 0;
    const beforeEmpty = leafClaude.listings();
    const empty = await leaf.cap.preflightSession(launch("legacy-empty"));
    expect(empty?.resolvedPackages).toEqual([]);
    expect(empty?.launchBlockers).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(leafClaude.listings()).toBe(beforeEmpty);
  } finally {
    legacy.mockRestore();
  }
});

test("a fenced Claude listing can finish after the leaf's ordinary answer deadline", async () => {
  const { leaf, leafClaude, inspected } = await fleetWithManagedClaude();
  const release = Promise.withResolvers<void>();
  leaf.cap.leafLaunch.answerTimeoutMs = 20;
  const before = leafClaude.listings();
  jest.useFakeTimers();
  try {
    const started = leafClaude.pauseListing(release.promise);
    const preflight = leaf.cap.preflightSession(launch("slow-fenced-listing"));
    await Promise.race([started, preflight]);
    jest.advanceTimersByTime(50);
    release.resolve();
    await expect(preflight).resolves.toMatchObject({
      resolvedPackages: [expect.objectContaining({ id: inspected.packageId })],
      launchBlockers: [],
    });
    expect(leafClaude.listings() - before).toBe(1);
  } finally {
    release.resolve();
    jest.useRealTimers();
  }
});

test("a leaf rereads Claude's list if plugin configuration changed after fenced observation", async () => {
  const { leaf, leafClaude } = await fleetWithManagedClaude();
  const answer = leaf.cap.executorLaunchAnswer.bind(leaf.cap);
  const editBeforeAnswer = spyOn(leaf.cap, "executorLaunchAnswer").mockImplementationOnce(
    async (args) => {
      const id = `review-plugin@${ORKESTRATOR_CLAUDE_MARKETPLACE}`;
      await leafClaude.setEnabled(id, false);
      await fs.writeFile(
        path.join(leaf.home, ".claude", "settings.json"),
        JSON.stringify({ enabledPlugins: { [id]: false } }),
      );
      return answer(args);
    },
  );
  const before = leafClaude.listings();
  try {
    await expect(leaf.cap.preflightSession(launch("changed-after-observation"))).rejects.toThrow(
      "changed on this machine",
    );
    expect(leafClaude.listings() - before).toBe(2);
  } finally {
    editBeforeAnswer.mockRestore();
  }
});
