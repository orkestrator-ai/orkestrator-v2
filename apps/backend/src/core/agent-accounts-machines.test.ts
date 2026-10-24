import { afterEach, beforeEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CommandContext } from "./commands-context.js";
import { listMachineAgentAccounts } from "./agent-accounts-machines.js";
import { NodeUnavailableError } from "./nodes/node-link.js";
import { StorageService } from "./storage.js";

let root: string;
let storage: StorageService;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "ork-machine-accounts-")));
  storage = new StorageService(path.join(root, "data"));
  await storage.init();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function context(overrides: Partial<CommandContext>): CommandContext {
  return {
    storage,
    // Nothing here may read the real host login.
    runtimeFlavor: "agent-test",
    credentialSources: new Set(),
    ...overrides,
  } as unknown as CommandContext;
}

const LEAF_SNAPSHOT = {
  accounts: [],
  active: { claude: "default", codex: "default" },
};

test("lists only this machine without command nodes", async () => {
  const result = await listMachineAgentAccounts(context({}));
  expect(result.machines).toHaveLength(1);
  expect(result.machines[0]).toMatchObject({ self: true, state: "ok", nodeId: "self" });
});

test("asks each enabled machine and keeps going when one cannot answer", async () => {
  const view = (nodeId: string, displayName: string) => ({
    nodeId,
    displayName,
    enabled: true,
  });
  const asked: string[] = [];
  const result = await listMachineAgentAccounts(
    context({
      nodes: {
        selfIdentity: async () => "node-self",
        isLeaf: () => false,
        listNodes: async () => ({
          nodes: [
            view("node-a", "MBP3"),
            view("node-b", "VPS"),
            view("node-slow", "Slow"),
            { ...view("node-off", "Off"), enabled: false },
          ],
        }),
      } as never,
      nodePortal: {
        invokeOnNode: async (args: { nodeId: string; command: string }) => {
          asked.push(`${args.nodeId}:${args.command}`);
          if (args.nodeId === "node-b") throw new NodeUnavailableError("offline");
          if (args.nodeId === "node-slow") return new Promise(() => undefined);
          return { outcome: "ok", result: LEAF_SNAPSHOT };
        },
      } as never,
    }),
    { timeoutMs: 20 },
  );
  expect(asked.sort()).toEqual([
    "node-a:list_agent_accounts",
    "node-b:list_agent_accounts",
    "node-slow:list_agent_accounts",
  ]);
  expect(result.machines.map((machine) => [machine.name, machine.state])).toEqual([
    [(await storage.getBackendProfile()).displayName, "ok"],
    ["MBP3", "ok"],
    ["VPS", "unavailable"],
    ["Slow", "unavailable"],
  ]);
  expect(result.machines[0]?.nodeId).toBe("node-self");
  expect(result.machines[1]?.snapshot).toEqual(LEAF_SNAPSHOT);
});
