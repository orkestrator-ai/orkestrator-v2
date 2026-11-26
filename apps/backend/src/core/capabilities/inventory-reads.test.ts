/**
 * The inventory's provider plugin listings stay off the launch path: a hung
 * listing never delays a native launch, on a command node or on a leaf, while
 * required-delivery checks still read this machine's files. Readers share one
 * listing in its window, and a change this machine applies lists again.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";

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
import { inventoryPluginLister, inventoryPluginTimeoutMessage } from "./inventory-plugins.js";

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
      expect(observe.mock.calls[0]).toEqual([{ launch: true }]);
    } finally {
      observe.mockRestore();
    }
    expect(listings.total()).toBe(runs);
  });
});
