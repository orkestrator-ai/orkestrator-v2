import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CommandContext } from "./commands-context.js";
import { localAgentAccountIds } from "./agent-account-bridge-state.js";
import { readSessionAgentAccount } from "./agent-accounts-session.js";
import { localServerProcesses } from "./commands-runtime-state.js";
import type { Environment } from "./models.js";
import { StorageService } from "./storage.js";

const SECOND = "11111111-2222-4333-8444-555555555555";

let root: string;
let storage: StorageService;
let context: CommandContext;
let environment: Environment | null;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "ork-session-account-")));
  storage = new StorageService(path.join(root, "data"));
  await storage.init();
  await storage.mutateAgentAccounts((store) => ({
    store: {
      ...store,
      accounts: [
        { id: SECOND, platform: "claude", label: "Work", createdAt: "2026-10-24T00:00:00Z" },
      ],
      active: { claude: SECOND },
    },
    result: undefined,
  }));
  environment = null;
  context = {
    storage: Object.assign(Object.create(storage) as StorageService, {
      getEnvironment: async () => environment,
    }),
    // Nothing here may read the real host login.
    runtimeFlavor: "agent-test",
    credentialSources: new Set(),
  } as unknown as CommandContext;
});

afterEach(async () => {
  localAgentAccountIds.clear();
  localServerProcesses.delete("claude:env-1");
  await fs.rm(root, { recursive: true, force: true });
});

describe("readSessionAgentAccount", () => {
  test("is null for platforms without accounts", async () => {
    expect(await readSessionAgentAccount(context, "env-1", "pi")).toBeNull();
  });

  test("a bridge that is not running reports the account its next start uses", async () => {
    const result = await readSessionAgentAccount(context, "env-1", "claude");
    expect(result).toMatchObject({ source: "account", running: false, account: { id: SECOND } });
    expect(result?.pendingActive).toBeUndefined();
  });

  test("a running bridge on the previous account names the one it moves to", async () => {
    localServerProcesses.set("claude:env-1", { exitCode: null, signalCode: null } as never);
    localAgentAccountIds.set("claude:env-1", "default");
    const result = await readSessionAgentAccount(context, "env-1", "claude");
    expect(result).toMatchObject({
      source: "account",
      running: true,
      account: { id: "default", isDefault: true },
      pendingActive: { id: SECOND, label: "Work" },
    });
  });

  test("a container reports the login its marker records", async () => {
    environment = {
      id: "env-1",
      containerId: "container-1",
      environmentType: "containerized",
      status: "running",
    } as Environment;
    const result = await readSessionAgentAccount(context, "env-1", "claude", async () => SECOND);
    expect(result).toMatchObject({ source: "account", running: true, account: { id: SECOND } });

    const unreadable = await readSessionAgentAccount(context, "env-1", "claude", async () => {
      throw new Error("exec failed");
    });
    expect(unreadable).toEqual({ platform: "claude", source: "unknown", running: true });
  });
});

test("an isolated Claude container reports its own login without reading the marker", async () => {
  const config = await storage.loadConfig();
  await storage.saveConfig({
    ...config,
    global: { ...config.global, useHostClaudeCredentials: false },
  });
  environment = {
    id: "env-1",
    containerId: "container-1",
    environmentType: "containerized",
    status: "running",
  } as Environment;
  const read = async (): Promise<string> => {
    throw new Error("must not read marker");
  };
  expect(await readSessionAgentAccount(context, "env-1", "claude", read)).toEqual({
    platform: "claude",
    source: "container",
    running: true,
  });
});

test("a stopped container uses the active account on its next start without reading the container", async () => {
  environment = {
    id: "env-1",
    containerId: "container-1",
    environmentType: "containerized",
    status: "stopped",
  } as Environment;
  let reads = 0;
  const result = await readSessionAgentAccount(context, "env-1", "claude", async () => {
    reads++;
    return "default";
  });
  expect(result).toMatchObject({ source: "account", running: false, account: { id: SECOND } });
  expect(result?.pendingActive).toBeUndefined();
  expect(reads).toBe(0);
});
