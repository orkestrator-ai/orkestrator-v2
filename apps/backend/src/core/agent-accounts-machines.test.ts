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

/** Never the real machine's: a test must not read the host's Grok or Pi login. */
const readSignIns = async () => ({ grok: { state: "signed-out" as const } });

const LEAF_SNAPSHOT = {
  accounts: [],
  active: { claude: "default", codex: "default" },
};

test("lists only this machine without command nodes", async () => {
  const result = await listMachineAgentAccounts(context({}), { readSignIns });
  expect(result.machines).toHaveLength(1);
  expect(result.machines[0]?.signIns).toEqual({ grok: { state: "signed-out" } });
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
          if (args.command === "read_host_agent_sign_ins") {
            return {
              outcome: "ok",
              result: {
                grok: { state: "signed-in", source: "x".repeat(300), token: "leaked" },
                pi: { state: "bogus" },
              },
            };
          }
          return { outcome: "ok", result: LEAF_SNAPSHOT };
        },
      } as never,
    }),
    { timeoutMs: 20, readSignIns },
  );
  expect(asked.sort()).toEqual([
    "node-a:list_agent_accounts",
    "node-a:read_host_agent_sign_ins",
    "node-b:list_agent_accounts",
    "node-b:read_host_agent_sign_ins",
    "node-slow:list_agent_accounts",
    "node-slow:read_host_agent_sign_ins",
  ]);
  // Rebuilt field by field: nothing else another machine sends passes through.
  expect(result.machines[1]?.signIns).toEqual({
    grok: { state: "signed-in", source: "x".repeat(120) },
  });
  expect(result.machines.map((machine) => [machine.name, machine.state])).toEqual([
    [(await storage.getBackendProfile()).displayName, "ok"],
    ["MBP3", "ok"],
    ["VPS", "unavailable"],
    ["Slow", "unavailable"],
  ]);
  expect(result.machines[0]?.nodeId).toBe("node-self");
  expect(result.machines[1]?.snapshot).toEqual(LEAF_SNAPSHOT);
});

test("a malformed peer row becomes an error cell instead of reaching Settings", async () => {
  const result = await listMachineAgentAccounts(
    context({
      nodes: {
        selfIdentity: async () => "self",
        isLeaf: () => false,
        listNodes: async () => ({
          nodes: [{ nodeId: "bad", displayName: "Bad peer", enabled: true }],
        }),
      } as never,
      nodePortal: {
        invokeOnNode: async ({ command }: { command: string }) => ({
          outcome: "ok",
          result:
            command === "list_agent_accounts"
              ? {
                  ...LEAF_SNAPSHOT,
                  accounts: [
                    {
                      id: "default",
                      platform: "claude",
                      label: "Bad",
                      signedIn: true,
                      isDefault: true,
                      isActive: true,
                    },
                  ],
                }
              : { grok: { state: "signed-in", token: "secret", source: "s".repeat(500) } },
        }),
      } as never,
    }),
    { readSignIns },
  );
  expect(result.machines[1]).toMatchObject({ state: "error", error: "Invalid account snapshot" });
  expect(result.machines[1]?.snapshot).toBeUndefined();
});
