import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CommandContext } from "./commands-context.js";
import { BackendRuntime } from "./backend-runtime.js";
import * as containerExec from "./commands-container-exec.js";
import * as serverHealth from "./commands-server-health.js";
import { CLAUDE_BRIDGE_PORT, CODEX_BRIDGE_PORT } from "./constants.js";
import { readSessionAgentAccount } from "./agent-accounts-session.js";
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
  await storage.agentAccounts.mutateAgentAccounts((store) => ({
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
    runtime: new BackendRuntime({ emit: () => undefined }),
    storage: Object.assign(Object.create(storage) as StorageService, {
      getEnvironment: async () => environment,
    }),
    // Nothing here may read the real host login.
    runtimeFlavor: "agent-test",
    credentialSources: new Set(),
  } as unknown as CommandContext;
});

afterEach(async () => {
  context.runtime.shutdown();
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
    context.runtime.localServers.adoptProcess(
      "claude:env-1",
      { exitCode: null, signalCode: null } as never,
      { workingDirectory: root, accountId: "default" },
    );
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
    const result = await readSessionAgentAccount(
      context,
      "env-1",
      "claude",
      async () => SECOND,
      async () => true,
    );
    expect(result).toMatchObject({ source: "account", running: true, account: { id: SECOND } });

    const unreadable = await readSessionAgentAccount(
      context,
      "env-1",
      "claude",
      async () => {
        throw new Error("exec failed");
      },
      async () => true,
    );
    expect(unreadable).toEqual({ platform: "claude", source: "unknown", running: true });
  });
});

for (const platform of ["claude", "codex"] as const) {
  test(`a running container with stopped ${platform} reports the next account without reading its marker`, async () => {
    environment = {
      containerId: "container-1",
      environmentType: "containerized",
      status: "running",
    } as Environment;
    let markerReads = 0;
    const result = await readSessionAgentAccount(
      context,
      "env-1",
      platform,
      async () => {
        markerReads++;
        return "default";
      },
      async (_id, provider) => {
        expect(provider).toBe(platform);
        return false;
      },
    );
    expect(result).toMatchObject({
      source: "account",
      running: false,
      account: { id: platform === "claude" ? SECOND : "default" },
    });
    expect(result?.pendingActive).toBeUndefined();
    expect(markerReads).toBe(0);
  });
}

test("a stopped container neither probes nor reads its marker", async () => {
  environment = {
    containerId: "container-1",
    environmentType: "containerized",
    status: "stopped",
  } as Environment;
  const unexpected = async (): Promise<never> => {
    throw new Error("must not inspect stopped container");
  };
  const result = await readSessionAgentAccount(context, "env-1", "claude", unexpected, unexpected);
  expect(result).toMatchObject({ source: "account", running: false, account: { id: SECOND } });
});

test("an account removed since container launch is unknown", async () => {
  environment = {
    containerId: "container-1",
    environmentType: "containerized",
    status: "running",
  } as Environment;
  expect(
    await readSessionAgentAccount(
      context,
      "env-1",
      "claude",
      async () => "removed",
      async () => true,
    ),
  ).toEqual({ platform: "claude", source: "unknown", running: true });
});

test("isolated container login reports provider status and never reads host markers", async () => {
  const config = await storage.loadConfig();
  await storage.saveConfig({
    ...config,
    global: { ...config.global, useHostClaudeCredentials: false },
  });
  environment = {
    containerId: "container-1",
    environmentType: "containerized",
    status: "running",
  } as Environment;
  for (const running of [true, false]) {
    const result = await readSessionAgentAccount(
      context,
      "env-1",
      "claude",
      async () => {
        throw new Error("must not read marker");
      },
      async () => running,
    );
    expect(result).toEqual({ platform: "claude", source: "container", running });
  }
});

for (const platform of ["claude", "codex"] as const) {
  test(`default ${platform} status probe checks that provider's health without starting it`, async () => {
    environment = {
      containerId: "container-1",
      environmentType: "containerized",
      status: "running",
    } as Environment;
    const port = spyOn(containerExec, "getHostPort").mockResolvedValue(12345);
    const health = spyOn(serverHealth, "checkHttpHealth").mockResolvedValue(false);
    let markers = 0;
    try {
      const result = await readSessionAgentAccount(context, "env-1", platform, async () => {
        markers++;
        return "default";
      });
      expect(port).toHaveBeenCalledWith(
        "container-1",
        platform === "claude" ? CLAUDE_BRIDGE_PORT : CODEX_BRIDGE_PORT,
      );
      expect(health).toHaveBeenCalledWith(12345);
      expect(result?.running).toBe(false);
      expect(markers).toBe(0);
      port.mockResolvedValue(null);
      health.mockClear();
      expect((await readSessionAgentAccount(context, "env-1", platform))?.running).toBe(false);
      expect(health).not.toHaveBeenCalled();
    } finally {
      health.mockRestore();
      port.mockRestore();
    }
  });
}
