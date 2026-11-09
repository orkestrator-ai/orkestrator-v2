import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AGENT_USAGE_READINGS_CHANGED_EVENT,
  normalizeUsageIdentity,
  type UsageIdentity,
} from "@orkestrator/protocol/agent-account-shared-usage";
import { unknownCommand } from "@orkestrator/protocol/contract/errors";
import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";

import { AgentAccountSharedUsage } from "../agent-accounts-shared-usage.js";
import {
  applySharedUsageReadings,
  centralUsageReadings,
  collectSharedUsageReadings,
  recordCentralUsageReadings,
  shareAndMergeUsage,
} from "../agent-accounts-usage-sharing.js";
import { eventSink } from "../backend-emit.js";
import type { CommandContext } from "../commands-context.js";
import type { ContractEnvelope } from "./node-link.js";
import { NodeUsageSync, type UsageSyncLink } from "./node-usage-sync.js";

/**
 * Shared usage readings between a command node and fake leaves. Each node has
 * its own data directory and the real store and leaf-side functions; the link
 * runs `collect_shared_usage_readings` and `apply_shared_usage_readings` in
 * process. Nothing reads a real account or a provider.
 */

const COMMAND_ID = "bk_mini";
const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const MINUTE = 60_000;

const TRADING = normalizeUsageIdentity("claude", "618BTrading@gmail.com", "org-1")!;
const TRADING_OTHER_ORG = normalizeUsageIdentity("claude", "618BTrading@gmail.com", "org-2")!;
const DEV = normalizeUsageIdentity("claude", "arktechdev@example.com", "org-9")!;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface FakeNode {
  nodeId: string;
  name: string;
  context: CommandContext;
  identities: UsageIdentity[];
  events: Array<{ event: string; payload: unknown }>;
  link: UsageSyncLink & { connected: boolean };
  /** Arguments of every `apply_shared_usage_readings` it was sent. */
  applied: unknown[];
  /** Answer every call as a node that predates the commands. */
  older: boolean;
  /** This node read `identity` itself. */
  read(identity: UsageIdentity, usedPercent: number, minutesAgo: number): Promise<void>;
  /** What this node shows for `identity`, given its own answer `local`. */
  show(identity: UsageIdentity, local?: PlanUsageSnapshot): Promise<PlanUsageSnapshot>;
}

function snapshot(usedPercent: number, minutesAgo: number, extra: Partial<PlanUsageSnapshot> = {}) {
  return {
    platform: "claude",
    status: "ok",
    plan: "max",
    windows: [
      {
        window: "five_hour",
        label: "5-hour limit",
        usedPercent,
        resetsAt: new Date(NOW + 3 * 60 * MINUTE).toISOString(),
        windowMinutes: 300,
      },
    ],
    fetchedAt: new Date(NOW - minutesAgo * MINUTE).toISOString(),
    ...extra,
  } satisfies PlanUsageSnapshot;
}

const NEVER_READ: PlanUsageSnapshot = {
  platform: "claude",
  status: "unavailable",
  windows: [],
  message: "This account's sign-in is refreshed while it is in use.",
  fetchedAt: new Date(NOW).toISOString(),
};

async function fakeNode(nodeId: string, name: string, identities: UsageIdentity[]) {
  const dir = await mkdtemp(path.join(tmpdir(), `ork-usage-sync-${name}-`));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const events: FakeNode["events"] = [];
  const context = {
    storage: { agentAccounts: { agentAccountsDirectory: () => dir } },
    runtime: { accounts: { sharedUsage: new AgentAccountSharedUsage() } },
    emit: eventSink((event, payload) => events.push({ event, payload })),
    nodes: {
      selfIdentity: async () => nodeId,
      selfProfile: async () => ({ displayName: name }),
      listControllers: () => [{ controllerId: COMMAND_ID, displayName: "mini" }],
    },
  } as unknown as CommandContext;
  const node: FakeNode = {
    nodeId,
    name,
    context,
    identities,
    events,
    applied: [],
    older: false,
    link: undefined as unknown as FakeNode["link"],
    read: async (identity, usedPercent, minutesAgo) => {
      await shareAndMergeUsage(context, identity, snapshot(usedPercent, minutesAgo), NOW);
    },
    show: (identity, local = NEVER_READ) => shareAndMergeUsage(context, identity, local, NOW),
  };
  node.link = {
    connected: true,
    hello: { domains: { accounts: { min: 1, max: 1 } } },
    async invoke<T>(
      command: string,
      args: Record<string, unknown> = {},
      _options?: { envelope?: ContractEnvelope },
    ): Promise<T> {
      if (!node.link.connected) throw new Error("fetch failed");
      if (node.older) throw unknownCommand(command, "accounts");
      expect(args.controllerId).toBe(COMMAND_ID);
      const wire = structuredClone(args);
      if (command === "collect_shared_usage_readings") {
        return structuredClone(await collectSharedUsageReadings(context, node.identities)) as T;
      }
      if (command === "apply_shared_usage_readings") {
        node.applied.push(wire);
        return (await applySharedUsageReadings(context, node.identities, wire.readings, NOW)) as T;
      }
      throw unknownCommand(command, "accounts");
    },
  };
  return node;
}

async function fleet(leaves: Array<[string, string, UsageIdentity[]]>, own: UsageIdentity[] = []) {
  const command = await fakeNode(COMMAND_ID, "mini", own);
  const nodes = await Promise.all(leaves.map(([id, name, ids]) => fakeNode(id, name, ids)));
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const sync = new NodeUsageSync({
    selfId: async () => COMMAND_ID,
    isCommandNode: () => true,
    link: (nodeId) => byId.get(nodeId)?.link ?? null,
    connectedNodeIds: async () =>
      nodes.filter((node) => node.link.connected).map((node) => node.nodeId),
    ownIdentities: async () => command.identities,
    central: () => centralUsageReadings(command.context),
    storeCentral: (readings, ownIdentities) =>
      recordCentralUsageReadings(command.context, readings, ownIdentities, NOW),
    now: () => NOW,
    debounceMs: 1,
  });
  cleanups.push(async () => sync.dispose());
  return { command, nodes, sync, node: (id: string) => byId.get(id)! };
}

describe("shared usage readings", () => {
  test("the newest reading of a login reaches every machine with it, whatever its local id", async () => {
    const { sync, node, command } = await fleet([
      ["bk_beelink", "beelink", [TRADING]],
      ["bk_omarchy", "omarchy-hp", [TRADING, DEV]],
      ["bk_rkmbp", "rkmbp", [TRADING]],
    ]);
    // omarchy-hp's own reading is two and a half days old.
    await node("bk_omarchy").read(TRADING, 31, 2.5 * 24 * 60);
    await node("bk_rkmbp").read(TRADING, 70, 10);
    await node("bk_beelink").read(TRADING, 100, 1);

    const pass = await sync.syncAll();
    expect(pass.nodes.map((entry) => entry.state)).toEqual(["synced", "synced", "synced"]);

    const lastKnown = { ...snapshot(31, 2.5 * 24 * 60), stale: true };
    const shown = await node("bk_omarchy").show(TRADING, lastKnown);
    expect(shown.windows[0]?.usedPercent).toBe(100);
    expect(shown.fetchedAt).toBe(new Date(NOW - MINUTE).toISOString());
    expect(shown.readOn).toEqual({ nodeId: "bk_beelink", nodeName: "beelink" });
    expect((await node("bk_rkmbp").show(TRADING)).windows[0]?.usedPercent).toBe(100);
    // The machine that took it shows it as its own.
    expect((await node("bk_beelink").show(TRADING)).readOn).toBeUndefined();
    // The command node keeps it centrally even without the login.
    expect((await centralUsageReadings(command.context)).map((r) => r.source.nodeName)).toEqual([
      "beelink",
    ]);
    // Nothing older replaces it, and a second pass sends nothing.
    await node("bk_rkmbp").read(TRADING, 10, 5);
    const again = await sync.syncAll();
    expect(again.nodes.every((entry) => entry.sent === 0)).toBe(true);
    expect((await node("bk_omarchy").show(TRADING)).windows[0]?.usedPercent).toBe(100);
  });

  test("a different email or organisation is a different login", async () => {
    const { sync, node } = await fleet([
      ["bk_beelink", "beelink", [TRADING]],
      ["bk_other_org", "beelink2", [TRADING_OTHER_ORG]],
      ["bk_dev", "rkmbp", [DEV]],
    ]);
    await node("bk_beelink").read(TRADING, 100, 1);
    await sync.syncAll();
    expect(node("bk_other_org").applied).toEqual([]);
    expect(node("bk_dev").applied).toEqual([]);
    expect((await node("bk_other_org").show(TRADING_OTHER_ORG)).status).toBe("unavailable");
    expect((await node("bk_dev").show(DEV)).status).toBe("unavailable");
  });

  test("a node speaks only for its own logins", async () => {
    const { sync, node, command } = await fleet([
      ["bk_beelink", "beelink", [TRADING]],
      ["bk_omarchy", "omarchy-hp", [DEV]],
    ]);
    // omarchy-hp's store holds a reading of a login it does not report.
    await node("bk_omarchy").read(TRADING, 5, 0);
    await node("bk_beelink").read(TRADING, 90, 3);
    await sync.syncAll();
    const central = await centralUsageReadings(command.context);
    expect(central.map((reading) => reading.windows[0]?.usedPercent)).toEqual([90]);
  });

  test("a reading dated far in the future is refused; one a little ahead is dated now", async () => {
    const { sync, node, command } = await fleet([
      ["bk_beelink", "beelink", [TRADING]],
      ["bk_omarchy", "omarchy-hp", [TRADING]],
    ]);
    // beelink's clock runs a day ahead: its store says the reading is from tomorrow.
    const ahead = { ...snapshot(100, -24 * 60) };
    const beelink = node("bk_beelink");
    await beelink.context.runtime.accounts.sharedUsage.record(
      beelink.context.storage.agentAccounts.agentAccountsDirectory(),
      [
        {
          identity: TRADING,
          windows: ahead.windows,
          fetchedAt: ahead.fetchedAt,
          source: { nodeId: "bk_beelink", nodeName: "beelink" },
        },
      ],
      NOW + 24 * 60 * MINUTE,
    );
    await node("bk_omarchy").read(TRADING, 40, 20);
    await sync.syncAll();
    expect(
      (await centralUsageReadings(command.context)).map((r) => r.windows[0]?.usedPercent),
    ).toEqual([40]);
    expect((await node("bk_omarchy").show(TRADING)).windows[0]?.usedPercent).toBe(40);

    // A minute ahead is within the allowance, and dated now.
    await node("bk_omarchy").read(TRADING, 55, -1);
    await sync.syncAll();
    const central = await centralUsageReadings(command.context);
    expect(central[0]?.fetchedAt).toBe(new Date(NOW).toISOString());
    expect(central[0]?.windows[0]?.usedPercent).toBe(55);
  });

  test("a node that reconnects catches up from the central copy", async () => {
    const { sync, node } = await fleet([
      ["bk_beelink", "beelink", [TRADING]],
      ["bk_omarchy", "omarchy-hp", [TRADING]],
    ]);
    const omarchy = node("bk_omarchy");
    omarchy.link.connected = false;
    await node("bk_beelink").read(TRADING, 100, 1);
    await sync.syncAll();
    // beelink goes away before omarchy-hp is back.
    node("bk_beelink").link.connected = false;
    omarchy.link.connected = true;
    sync.handleNodeEvent("native-event-stream-connected", {});
    for (let attempt = 0; attempt < 100 && omarchy.applied.length === 0; attempt += 1) {
      await Bun.sleep(5);
    }
    const shown = await omarchy.show(TRADING);
    expect(shown.windows[0]?.usedPercent).toBe(100);
    expect(shown.readOn?.nodeName).toBe("beelink");
    // Told Settings to read again, without asking the command node to sync once more.
    expect(omarchy.events).toContainEqual({
      event: AGENT_USAGE_READINGS_CHANGED_EVENT,
      payload: { platform: "claude", origin: "shared" },
    });
  });

  test("a node's own reading schedules a pass; a reading it was sent does not", async () => {
    const { sync, node } = await fleet([
      ["bk_beelink", "beelink", [TRADING]],
      ["bk_omarchy", "omarchy-hp", [TRADING]],
    ]);
    sync.handleNodeEvent(AGENT_USAGE_READINGS_CHANGED_EVENT, {
      platform: "claude",
      origin: "shared",
    });
    await node("bk_beelink").read(TRADING, 77, 0);
    await Bun.sleep(20);
    expect(node("bk_omarchy").applied).toEqual([]);
    expect(node("bk_beelink").events).toContainEqual({
      event: AGENT_USAGE_READINGS_CHANGED_EVENT,
      payload: { platform: "claude", origin: "local" },
    });
    sync.handleNodeEvent(AGENT_USAGE_READINGS_CHANGED_EVENT, {
      platform: "claude",
      origin: "local",
    });
    for (let attempt = 0; attempt < 100 && node("bk_omarchy").applied.length === 0; attempt += 1) {
      await Bun.sleep(5);
    }
    expect((await node("bk_omarchy").show(TRADING)).windows[0]?.usedPercent).toBe(77);
  });

  test("a node that predates the commands takes no part and the rest still sync", async () => {
    const { sync, node } = await fleet([
      ["bk_old", "omarchy-gram", [TRADING]],
      ["bk_beelink", "beelink", [TRADING]],
      ["bk_omarchy", "omarchy-hp", [TRADING]],
    ]);
    node("bk_old").older = true;
    await node("bk_beelink").read(TRADING, 64, 2);
    const pass = await sync.syncAll();
    expect(pass.nodes.find((entry) => entry.nodeId === "bk_old")?.state).toBe("unsupported");
    expect((await node("bk_omarchy").show(TRADING)).windows[0]?.usedPercent).toBe(64);
  });

  test("only usage, reset times, plan, fetch time and the machine travel", async () => {
    const { sync, node } = await fleet([
      ["bk_beelink", "beelink", [TRADING]],
      ["bk_omarchy", "omarchy-hp", [TRADING]],
    ]);
    // A reading carrying things that must never leave the machine.
    await shareAndMergeUsage(
      node("bk_beelink").context,
      TRADING,
      {
        ...snapshot(88, 1, {
          message: "token sk-ant-secret expired",
          paidOverage: { enabled: true, inUse: false },
        }),
        accessToken: "sk-ant-secret",
        cookie: "sessionKey=secret",
      } as PlanUsageSnapshot,
      NOW,
    );
    await sync.syncAll();
    const sent = node("bk_omarchy").applied[0] as { readings: Array<Record<string, unknown>> };
    expect(sent.readings).toHaveLength(1);
    const [reading] = sent.readings;
    expect(Object.keys(reading!).sort()).toEqual(
      ["fetchedAt", "identity", "paidOverage", "plan", "source", "windows"].sort(),
    );
    expect(Object.keys(reading!.identity as object).sort()).toEqual(
      ["email", "organizationId", "platform"].sort(),
    );
    expect(Object.keys(reading!.source as object).sort()).toEqual(["nodeId", "nodeName"]);
    expect(reading!.windows).toEqual(snapshot(88, 1).windows);
    expect(JSON.stringify(sent)).not.toMatch(/secret|token|cookie|message/i);
  });

  test("a leaf refuses a command node that is not attached to it", async () => {
    const { registerAgentAccountCommands } = await import("../commands-registry-accounts.js");
    const { registrarFrom } = await import("../commands-registry-contracts.js");
    const handlers = new Map<string, (args: unknown, context: CommandContext) => unknown>();
    registerAgentAccountCommands(
      registrarFrom((name, handler) =>
        handlers.set(name, handler as (args: unknown, context: CommandContext) => unknown),
      ),
      {} as never,
    );
    const leaf = await fakeNode("bk_leaf", "beelink", []);
    await expect(
      Promise.resolve(
        handlers.get("collect_shared_usage_readings")!(
          { controllerId: "bk_stranger" },
          leaf.context,
        ),
      ),
    ).rejects.toThrow("not attached");
    await expect(
      Promise.resolve(
        handlers.get("apply_shared_usage_readings")!(
          { controllerId: "bk_stranger", readings: [] },
          leaf.context,
        ),
      ),
    ).rejects.toThrow("not attached");
  });
});
