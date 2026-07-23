import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createEnvironment,
  defaultConfig,
  StorageService,
} from "../../../apps/backend/src/core/storage";

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function configLockFor(storage: StorageService): Promise<() => Promise<void>> {
  return (
    storage as unknown as {
      acquireConfigMutationLock(): Promise<() => Promise<void>>;
    }
  ).acquireConfigMutationLock();
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("StorageService core coverage", () => {
  test("exposes its configured data and log directories", async () => {
    const dataDir = await createTempDir("ork-storage-paths-");
    const storage = new StorageService(dataDir);

    expect(storage.getDataDir()).toBe(dataDir);
    expect(storage.getLogDirectory()).toBe(path.join(dataDir, "logs"));
  });

  test("validates environment updates and resets optional values explicitly", async () => {
    const dataDir = await createTempDir("ork-storage-environment-fields-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const environment = await storage.addEnvironment(
      createEnvironment("project-1", { name: "fields" }),
    );
    const portMappings = [
      { containerPort: 3000, hostPort: 43000, protocol: "tcp" as const },
      { containerPort: 5353, hostPort: 45353, protocol: "udp" as const },
    ];

    const populated = await storage.updateEnvironment(environment.id, {
      name: "renamed",
      branch: "renamed-branch",
      status: "running",
      environmentType: "local",
      containerId: "container-1",
      prUrl: "https://example.test/pull/1",
      prState: "open",
      hasMergeConflicts: true,
      portMappings,
      opencodePid: 101,
      claudeBridgePid: 102,
      codexBridgePid: 103,
      localOpencodePort: 4101,
      localClaudePort: 4102,
      localCodexPort: 4103,
      entryPort: 3000,
      hostEntryPort: 43000,
      setupScriptsComplete: true,
      initialPrompt: "Start here",
      pendingRenamePrompt: "Rename me",
      createdFromCommit: "abc123",
      worktreePath: "/tmp/worktree",
      defaultAgent: "codex",
      claudeMode: "native",
      claudeNativeBackend: "sdk",
      opencodeMode: "native",
      codexMode: "native",
    });

    expect(populated).toMatchObject({
      name: "renamed",
      branch: "renamed-branch",
      status: "running",
      environmentType: "local",
      containerId: "container-1",
      prUrl: "https://example.test/pull/1",
      prState: "open",
      hasMergeConflicts: true,
      portMappings,
      opencodePid: 101,
      claudeBridgePid: 102,
      codexBridgePid: 103,
      localOpencodePort: 4101,
      localClaudePort: 4102,
      localCodexPort: 4103,
      entryPort: 3000,
      hostEntryPort: 43000,
      setupScriptsComplete: true,
      initialPrompt: "Start here",
      pendingRenamePrompt: "Rename me",
      createdFromCommit: "abc123",
      worktreePath: "/tmp/worktree",
      defaultAgent: "codex",
      claudeMode: "native",
      claudeNativeBackend: "sdk",
      opencodeMode: "native",
      codexMode: "native",
    });

    for (const invalidPortMappings of [
      {},
      [{ containerPort: Number.NaN, hostPort: 43000, protocol: "tcp" }],
      [{ containerPort: 3000, hostPort: 65_536, protocol: "tcp" }],
      [{ containerPort: 3000, hostPort: 43000, protocol: "http" }],
    ]) {
      const result = await storage.updateEnvironment(environment.id, {
        portMappings: invalidPortMappings,
      });
      expect(result.portMappings).toEqual(portMappings);
    }

    await storage.updateEnvironment(environment.id, { name: " ", branch: "" });
    expect(await storage.getEnvironment(environment.id)).toMatchObject({
      name: "renamed",
      branch: "renamed-branch",
    });

    const unchanged = await storage.updateEnvironment(environment.id, {
      name: 42,
      branch: null,
      status: "paused",
      environmentType: "remote",
      containerId: 42,
      prUrl: {},
      prState: "draft",
      hasMergeConflicts: "false",
      portMappings: [
        { containerPort: 0, hostPort: 43000, protocol: "tcp" },
        { containerPort: 3000, hostPort: 65_536, protocol: "http" },
      ],
      opencodePid: "101",
      claudeBridgePid: Number.NaN,
      codexBridgePid: Number.POSITIVE_INFINITY,
      localOpencodePort: 0,
      localClaudePort: "4102",
      localCodexPort: 65_536,
      entryPort: "3000",
      hostEntryPort: Number.NEGATIVE_INFINITY,
      setupScriptsComplete: "false",
      initialPrompt: 1,
      pendingRenamePrompt: 42,
      createdFromCommit: {},
      worktreePath: false,
      defaultAgent: "other",
      claudeMode: "other",
      claudeNativeBackend: "other",
      opencodeMode: "other",
      codexMode: "other",
    });

    expect(unchanged).toMatchObject(populated);

    const reset = await storage.updateEnvironment(environment.id, {
      containerId: null,
      prUrl: undefined,
      prState: null,
      hasMergeConflicts: undefined,
      portMappings: null,
      opencodePid: null,
      claudeBridgePid: undefined,
      codexBridgePid: null,
      localOpencodePort: null,
      localClaudePort: undefined,
      localCodexPort: null,
      entryPort: undefined,
      hostEntryPort: null,
      setupScriptsComplete: false,
      initialPrompt: null,
      pendingRenamePrompt: undefined,
      createdFromCommit: null,
      worktreePath: undefined,
      defaultAgent: null,
      claudeMode: undefined,
      claudeNativeBackend: null,
      opencodeMode: undefined,
      codexMode: null,
    });

    expect(reset.containerId).toBeNull();
    expect(reset.prUrl).toBeNull();
    expect(reset.prState).toBeNull();
    expect(reset.hasMergeConflicts).toBeNull();
    expect(reset.portMappings).toBeUndefined();
    expect(reset.opencodePid).toBeUndefined();
    expect(reset.claudeBridgePid).toBeUndefined();
    expect(reset.codexBridgePid).toBeUndefined();
    expect(reset.localOpencodePort).toBeUndefined();
    expect(reset.localClaudePort).toBeUndefined();
    expect(reset.localCodexPort).toBeUndefined();
    expect(reset.entryPort).toBeUndefined();
    expect(reset.hostEntryPort).toBeUndefined();
    expect(reset.setupScriptsComplete).toBe(false);
    expect(reset.initialPrompt).toBeUndefined();
    expect(reset.pendingRenamePrompt).toBeUndefined();
    expect(reset.createdFromCommit).toBeUndefined();
    expect(reset.worktreePath).toBeUndefined();
    expect(reset.defaultAgent).toBeUndefined();
    expect(reset.claudeMode).toBeUndefined();
    expect(reset.claudeNativeBackend).toBeUndefined();
    expect(reset.opencodeMode).toBeUndefined();
    expect(reset.codexMode).toBeUndefined();
    expect(reset.name).toBe("renamed");
    expect(reset.branch).toBe("renamed-branch");
    expect(reset.status).toBe("running");
    expect(reset.environmentType).toBe("local");
  });

  test("ignores invalid network modes and accepts both supported values", async () => {
    const dataDir = await createTempDir("ork-storage-network-mode-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const environment = await storage.addEnvironment(
      createEnvironment("project-1", {
        name: "network",
        networkAccessMode: "restricted",
      }),
    );

    await storage.updateEnvironment(environment.id, { networkAccessMode: "invalid" });
    expect((await storage.getEnvironment(environment.id))?.networkAccessMode).toBe(
      "restricted",
    );

    await storage.updateEnvironment(environment.id, { networkAccessMode: "full" });
    expect((await storage.getEnvironment(environment.id))?.networkAccessMode).toBe("full");

    await storage.updateEnvironment(environment.id, { networkAccessMode: "restricted" });
    expect((await storage.getEnvironment(environment.id))?.networkAccessMode).toBe(
      "restricted",
    );
  });

  test("updates every environment for a container and skips writes when none match", async () => {
    const dataDir = await createTempDir("ork-storage-container-statuses-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const first = createEnvironment("project-1", { name: "first" });
    first.containerId = "shared-container";
    const second = createEnvironment("project-2", { name: "second" });
    second.containerId = "shared-container";
    const unrelated = createEnvironment("project-1", { name: "unrelated" });
    unrelated.containerId = "other-container";
    await storage.addEnvironment(first);
    await storage.addEnvironment(second);
    await storage.addEnvironment(unrelated);

    await storage.setAllEnvironmentStatusesForContainer("shared-container", "error");

    expect(await storage.getEnvironment(first.id)).toMatchObject({ status: "error" });
    expect(await storage.getEnvironment(second.id)).toMatchObject({ status: "error" });
    expect(await storage.getEnvironment(unrelated.id)).toMatchObject({ status: "stopped" });

    const storageInternals = storage as unknown as {
      saveJson(filePath: string, value: unknown): Promise<void>;
    };
    const originalSaveJson = storageInternals.saveJson.bind(storage);
    let saveCalls = 0;
    storageInternals.saveJson = async (...args) => {
      saveCalls += 1;
      await originalSaveJson(...args);
    };
    try {
      await storage.setAllEnvironmentStatusesForContainer(
        "missing-container",
        "running",
      );
    } finally {
      storageInternals.saveJson = originalSaveJson;
    }

    expect(saveCalls).toBe(0);
  });

  test("recovers an abandoned configuration mutation lock", async () => {
    const dataDir = await createTempDir("ork-storage-stale-config-lock-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const lockPath = path.join(dataDir, "config.json.lock");
    await fs.writeFile(lockPath, "abandoned");
    const staleTime = new Date(Date.now() - 20_000);
    await fs.utimes(lockPath, staleTime, staleTime);

    await storage.updateGlobalConfig({
      ...defaultConfig().global,
      defaultAgent: "codex",
    });

    expect((await storage.loadConfig()).global.defaultAgent).toBe("codex");
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  test("times out when a configuration lock cannot be inspected", async () => {
    const dataDir = await createTempDir("ork-storage-config-lock-timeout-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const lockPath = path.join(dataDir, "config.json.lock");
    await fs.symlink(path.join(dataDir, "missing-lock-target"), lockPath);
    const originalNow = Date.now;
    const startedAt = originalNow();
    let calls = 0;
    Date.now = () => {
      calls += 1;
      return calls === 1 ? startedAt : startedAt + 20_001;
    };

    try {
      await expect(configLockFor(storage)).rejects.toThrow(
        "Timed out waiting for configuration storage lock",
      );
    } finally {
      Date.now = originalNow;
    }
  });

  test("propagates non-EEXIST configuration lock failures", async () => {
    const dataDir = await createTempDir("ork-storage-config-lock-error-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const originalOpen = fs.open;
    fs.open = (async () => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    }) as typeof fs.open;

    try {
      await expect(configLockFor(storage)).rejects.toMatchObject({
        message: "permission denied",
        code: "EACCES",
      });
    } finally {
      fs.open = originalOpen;
    }
  });

  test("continues queued configuration mutations after one rejects", async () => {
    const dataDir = await createTempDir("ork-storage-config-queue-recovery-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const configPath = path.join(dataDir, "config.json");
    await fs.writeFile(configPath, "null\n");

    await expect(
      storage.updateRepositoryConfig("project-1", {
        defaultBranch: "develop",
        prBaseBranch: "develop",
      }),
    ).rejects.toThrow();

    await fs.writeFile(configPath, `${JSON.stringify(defaultConfig())}\n`);
    await expect(
      storage.updateRepositoryConfig("project-1", {
        defaultBranch: "develop",
        prBaseBranch: "release",
      }),
    ).resolves.toMatchObject({
      repositories: {
        "project-1": {
          defaultBranch: "develop",
          prBaseBranch: "release",
        },
      },
    });
    await expect(fs.access(`${configPath}.lock`)).rejects.toThrow();
  });
});
