/**
 * One agent's hung plugin listing costs the inventory at most the per-agent
 * limit: it is reported by name, the other agents' plugins are still listed,
 * and the timeout is logged once, without any command output.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";

import { CommandFailedError } from "../command-capture.js";
import type { AgentPluginCatalog, ExtensionCommandRunner } from "../extension-discovery.js";
import { inventoryPluginLister, inventoryPluginTimeoutMessage } from "./inventory-plugins.js";

let logs: LogCapture;

beforeEach(() => {
  logs = captureLogs();
});

afterEach(() => {
  logs.restore();
});

const timeoutRecords = () =>
  logs.records().filter((record) => record.event === "inventory.plugin-list-timed-out");

/** Every agent answers with one plugin named after it, except the ones that hang. */
function fakeDiscover(hanging: ReadonlySet<string>) {
  const calls: string[] = [];
  const discover = async (
    agent: Parameters<typeof import("../extension-discovery.js").discoverAgentPlugins>[0],
  ): Promise<AgentPluginCatalog> => {
    calls.push(agent);
    if (hanging.has(agent)) return new Promise<never>(() => undefined);
    return { agent, plugins: [{ name: `${agent}-plugin`, status: "configured" }] };
  };
  return { calls, discover };
}

const unusedRunner: ExtensionCommandRunner = async () => "";

describe("inventoryPluginLister", () => {
  test("a hung agent is reported by name within the limit; the others are listed", async () => {
    const { discover } = fakeDiscover(new Set(["codex"]));
    const list = inventoryPluginLister({ run: unusedRunner, timeoutMs: 50, discover });
    const started = performance.now();
    const listing = await list();
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(listing.plugins.map((plugin) => plugin.name).sort()).toEqual([
      "claude-plugin",
      "grok-plugin",
      "opencode-plugin",
      "pi-plugin",
    ]);
    expect(listing.errors).toEqual([{ message: inventoryPluginTimeoutMessage("codex", 50) }]);
    expect(listing.errors![0]!.message).toContain("Codex");
    const records = timeoutRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.level).toBe("warn");
    expect(records[0]!.fields).toEqual({ provider: "codex", timeoutMs: 50 });
  });

  test("the timeout is logged once until the agent answers again", async () => {
    const hanging = new Set(["codex"]);
    const { discover } = fakeDiscover(hanging);
    const list = inventoryPluginLister({ run: unusedRunner, timeoutMs: 20, discover });
    await list();
    await list();
    expect(timeoutRecords()).toHaveLength(1);
    hanging.delete("codex");
    expect((await list()).errors).toEqual([]);
    hanging.add("codex");
    await list();
    expect(timeoutRecords()).toHaveLength(2);
  });

  test("a CLI the runner killed for its timeout is reported as timed out", async () => {
    const run: ExtensionCommandRunner = async (agent) => {
      if (agent === "codex") {
        throw new CommandFailedError("", { timedOut: true, stderr: "secret output" });
      }
      throw new CommandFailedError("not installed", { executableMissing: true });
    };
    const list = inventoryPluginLister({ run, timeoutMs: 1_000, providers: ["codex", "grok"] });
    const listing = await list();
    // A missing CLI is not an inventory error: most machines lack some agents.
    expect(listing.errors).toEqual([{ message: inventoryPluginTimeoutMessage("codex", 1_000) }]);
    expect(listing.plugins).toEqual([]);
    expect(logs.lines.join("\n")).not.toContain("secret output");
  });

  test("the real discovery over a runner that never answers stops at the limit", async () => {
    const run: ExtensionCommandRunner = () => new Promise<string>(() => undefined);
    const list = inventoryPluginLister({ run, timeoutMs: 30, providers: ["codex"] });
    const listing = await list();
    expect(listing.errors).toEqual([{ message: inventoryPluginTimeoutMessage("codex", 30) }]);
  });
});
