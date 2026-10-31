import { describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createEnvironment, defaultConfig, StorageService } from "./storage.js";
import type { AppConfig } from "./models.js";
import { openBackendDatabase } from "./storage-stores.js";
import {
  readStoredValue,
  seedStore,
  storageDatabase,
  withTemporaryStorage,
} from "./storage-test-support.js";

describe("PR base metadata", () => {
  test("persists the actual base across reload and clears it when the PR changes", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const environment = { ...createEnvironment("project-1"), id: "env-pr-base" };
      await storage.addEnvironment(environment);
      const url = "https://github.com/acme/repo/pull/7";
      await storage.updateEnvironment(environment.id, { prUrl: url, prBaseBranch: "release/2.0" });
      const restarted = new StorageService(dataDir);
      await restarted.init();
      expect((await restarted.getEnvironment(environment.id))?.prBaseBranch).toBe("release/2.0");
      await restarted.updateEnvironment(environment.id, { prUrl: url });
      expect((await restarted.getEnvironment(environment.id))?.prBaseBranch).toBe("release/2.0");
      await restarted.updateEnvironment(environment.id, {
        prUrl: "https://github.com/acme/repo/pull/8",
      });
      expect((await restarted.getEnvironment(environment.id))?.prBaseBranch).toBeNull();
      await restarted.updateEnvironment(environment.id, { prBaseBranch: "develop" });
      await restarted.updateEnvironment(environment.id, { prUrl: null });
      expect((await restarted.getEnvironment(environment.id))?.prBaseBranch).toBeNull();
    });
  });
});

describe("PR completion refresh intent", () => {
  test("rejects missing environments and ignores every ineligible PR state", async () => {
    await withTemporaryStorage(async (storage) => {
      await expect(storage.armPrRecheckAfterAgentCompletion("missing")).rejects.toThrow(
        "Environment not found: missing",
      );

      for (const [index, metadata] of (
        [
          { prUrl: null, prState: null, hasMergeConflicts: null },
          {
            prUrl: "https://github.com/acme/repo/pull/1",
            prState: "closed",
            hasMergeConflicts: true,
          },
          {
            prUrl: "https://github.com/acme/repo/pull/1",
            prState: "open",
            hasMergeConflicts: false,
          },
          {
            prUrl: "https://github.com/acme/repo/pull/1",
            prState: "merged",
            hasMergeConflicts: null,
          },
        ] as const
      ).entries()) {
        const environment = { ...createEnvironment("project-1"), id: `env-${index}`, ...metadata };
        await storage.addEnvironment(environment);
        expect((await storage.armPrRecheckAfterAgentCompletion(environment.id)).armedAt).toBeNull();
      }
    });
  });

  test.each([true, null])(
    "survives restart and token-safe rollback with merge conflicts %s",
    async (hasMergeConflicts) => {
      await withTemporaryStorage(async (storage, dataDir) => {
        const environment = {
          ...createEnvironment("project-1"),
          id: "env-pr-arm",
          prUrl: "https://github.com/acme/repo/pull/1",
          prState: "open" as const,
          hasMergeConflicts,
        };
        await storage.addEnvironment(environment);
        const first = (await storage.armPrRecheckAfterAgentCompletion(environment.id)).armedAt!;
        expect(first).toEqual(expect.any(String));

        const restarted = new StorageService(dataDir);
        await restarted.init();
        expect(
          (await restarted.getEnvironment(environment.id))?.prRecheckAfterAgentCompletionArmedAt,
        ).toBe(first);

        const second = (await restarted.armPrRecheckAfterAgentCompletion(environment.id)).armedAt!;
        expect(second).not.toBe(first);
        expect(
          (await restarted.disarmPrRecheckAfterAgentCompletion(environment.id, first))
            .prRecheckAfterAgentCompletionArmedAt,
        ).toBe(second);
        expect(
          (await restarted.disarmPrRecheckAfterAgentCompletion(environment.id, second))
            .prRecheckAfterAgentCompletionArmedAt,
        ).toBeUndefined();
        await expect(
          restarted.disarmPrRecheckAfterAgentCompletion("missing", second),
        ).rejects.toThrow("Environment not found: missing");
      });
    },
  );

  test("returns no token when a later arm is refused without exposing the existing token", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = {
        ...createEnvironment("project-1"),
        id: "env-pr-refused-rearm",
        prUrl: "https://github.com/acme/repo/pull/1",
        prState: "open" as const,
        hasMergeConflicts: true,
      };
      await storage.addEnvironment(environment);
      const first = await storage.armPrRecheckAfterAgentCompletion(environment.id);
      await storage.updateEnvironment(environment.id, { hasMergeConflicts: false });

      const refused = await storage.armPrRecheckAfterAgentCompletion(environment.id);

      expect(first.armedAt).toEqual(expect.any(String));
      expect(refused.armedAt).toBeNull();
      expect(refused.environment.prRecheckAfterAgentCompletionArmedAt).toBe(first.armedAt!);
    });
  });

  test("generates strictly increasing arm tokens in the same millisecond and after clock rollback", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = {
        ...createEnvironment("project-1"),
        id: "env-pr-monotonic-arm",
        prUrl: "https://github.com/acme/repo/pull/1",
        prState: "open" as const,
        hasMergeConflicts: true,
      };
      await storage.addEnvironment(environment);
      const now = spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      try {
        const first = (await storage.armPrRecheckAfterAgentCompletion(environment.id)).armedAt!;
        const second = (await storage.armPrRecheckAfterAgentCompletion(environment.id)).armedAt!;
        now.mockReturnValue(1_700_000_000_000);
        const third = (await storage.armPrRecheckAfterAgentCompletion(environment.id)).armedAt!;

        expect(Date.parse(second)).toBe(Date.parse(first) + 1);
        expect(Date.parse(third)).toBe(Date.parse(second) + 1);
      } finally {
        now.mockRestore();
      }
    });
  });

  test("replaces an unparseable stored arm token", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = {
        ...createEnvironment("project-1"),
        id: "env-pr-invalid-arm",
        prUrl: "https://github.com/acme/repo/pull/1",
        prState: "open" as const,
        hasMergeConflicts: true,
        prRecheckAfterAgentCompletionArmedAt: "not-a-date",
      };
      await storage.addEnvironment(environment);

      const armedAt = (await storage.armPrRecheckAfterAgentCompletion(environment.id)).armedAt;

      expect(armedAt).toEqual(expect.any(String));
      expect(Number.isFinite(Date.parse(armedAt!))).toBe(true);
    });
  });

  test("serializes monitor state ahead of a concurrent stale arm", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = {
        ...createEnvironment("project-1"),
        id: "env-pr-race",
        prUrl: "https://github.com/acme/repo/pull/1",
        prState: "open" as const,
        hasMergeConflicts: true,
      };
      await storage.addEnvironment(environment);

      const stateUpdate = storage.updateEnvironment(environment.id, {
        hasMergeConflicts: false,
        prRecheckAfterAgentCompletionArmedAt: undefined,
      });
      const staleArm = storage.armPrRecheckAfterAgentCompletion(environment.id);
      await Promise.all([stateUpdate, staleArm]);

      expect(await storage.getEnvironment(environment.id)).toMatchObject({
        hasMergeConflicts: false,
      });
      expect(
        (await storage.getEnvironment(environment.id))?.prRecheckAfterAgentCompletionArmedAt,
      ).toBeUndefined();
    });
  });
});

describe("hot store read caching", () => {
  test("serves environment reads as fresh clones and observes foreign writes", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));

      await storage.loadEnvironments();
      await storage.getEnvironment(environment.id);
      await storage.getEnvironmentsByProject("project-1");

      // Mutating a returned value must not poison the cache: reads hand out
      // clones precisely because every mutation path edits in place.
      (await storage.loadEnvironments())[0]!.name = "mutated-by-caller";
      expect((await storage.getEnvironment(environment.id))!.name).toBe(environment.name);

      // A save through this process is visible to its next read.
      await storage.updateEnvironment(environment.id, { name: "renamed" });
      expect((await storage.getEnvironment(environment.id))!.name).toBe("renamed");

      // A write by another backend process is observed through the store's
      // committed revision even though this process never wrote.
      const foreign = readStoredValue<Array<Record<string, unknown>>>(
        dataDir,
        "environments.json",
      )!;
      foreign[0]!.name = "foreign-writer";
      seedStore(dataDir, "environments.json", foreign);
      expect((await storage.getEnvironment(environment.id))!.name).toBe("foreign-writer");
    });
  });

  test("keeps volatile and structural environment writes out of JSON files", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      await storage.setEnvironmentAgentActivity(
        environment.id,
        "working",
        new Date(Date.now() + 1_000).toISOString(),
        "frontend",
        "renderer-token",
      );
      await storage.recordEnvironmentActivity(
        environment.id,
        new Date(Date.now() + 2_000).toISOString(),
      );
      await storage.updateEnvironment(environment.id, { name: "renamed" });

      // No primary, backup ladder, lock or temp file: every commit is atomic.
      const entries = await fs.readdir(dataDir);
      expect(entries.filter((entry) => entry.includes("environments.json"))).toEqual([]);
      expect(readStoredValue<Array<{ name: string }>>(dataDir, "environments.json")).toEqual([
        expect.objectContaining({ id: environment.id, name: "renamed" }),
      ]);
    });
  });

  test("persists the latest structural state after later activity-only writes", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      await storage.updateEnvironment(environment.id, { name: "structurally-renamed" });
      const occurredAt = new Date(Date.now() + 1_000).toISOString();
      await storage.recordEnvironmentActivity(environment.id, occurredAt);

      // Activity-only writes are as durable as structural ones: a restarted
      // backend sees both, with no backup ladder to fall back on.
      const restarted = new StorageService(dataDir);
      await restarted.init();
      expect(await restarted.getEnvironment(environment.id)).toMatchObject({
        id: environment.id,
        name: "structurally-renamed",
        lastActivityAt: occurredAt,
      });
    });
  });

  test("refuses to rotate an empty config primary over a valid backup", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const config = defaultConfig();
      await storage.saveConfig(config);
      const renamed = structuredClone(config);
      renamed.global.webClientEnabled = false;
      await storage.saveConfig(renamed);

      const primary = path.join(dataDir, "config.json");
      const backup = `${primary}.bak.1`;
      const retained = JSON.parse(await fs.readFile(backup, "utf8")) as AppConfig;
      await fs.writeFile(primary, "  \n", "utf8");

      const next = structuredClone(renamed);
      next.global.webClientEnabled = true;
      await storage.saveConfig(next);

      expect(JSON.parse(await fs.readFile(backup, "utf8"))).toEqual(retained);
      expect((await storage.loadConfig()).global.webClientEnabled).toBe(true);
    });
  });

  test("recovers an empty config primary from backup without promoting the empty file", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      // The configuration stays a JSON file and keeps its backup ladder.
      const config = defaultConfig();
      config.global.webClientEnabled = false;
      await storage.saveConfig(config);
      // Rotate the recoverable snapshot into .bak.1 before a torn write.
      const later = structuredClone(config);
      later.global.codexMaxConcurrentThreads = 2;
      await storage.saveConfig(later);
      const primary = path.join(dataDir, "config.json");
      const backup = `${primary}.bak.1`;
      await fs.writeFile(primary, "  \n", "utf8");

      const recovered = new StorageService(dataDir);
      expect((await recovered.loadConfig()).global.webClientEnabled).toBe(false);
      const next = structuredClone(later);
      next.global.webClientEnabled = true;
      await recovered.saveConfig(next);

      expect((await fs.readFile(backup, "utf8")).trim()).not.toBe("");
      expect(
        (JSON.parse(await fs.readFile(backup, "utf8")) as AppConfig).global.webClientEnabled,
      ).toBe(false);
    });
  });

  test("invalidates project and config caches after external writes", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      await storage.addProject({
        id: "project-cache",
        name: "Before",
        gitUrl: "https://example.invalid/cache.git",
        localPath: null,
        addedAt: new Date(0).toISOString(),
        order: 0,
      });
      const config = defaultConfig();
      await storage.saveConfig(config);
      await storage.loadProjects();
      await storage.loadConfig();

      const projects = readStoredValue<Array<{ name: string }>>(dataDir, "projects.json")!;
      projects[0]!.name = "After!";
      seedStore(dataDir, "projects.json", projects);

      // The desktop process writes the configuration file directly.
      const configPath = path.join(dataDir, "config.json");
      const foreignConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as AppConfig;
      foreignConfig.global.webClientEnabled = false;
      await fs.writeFile(configPath, `${JSON.stringify(foreignConfig)}\n`, "utf8");

      expect((await storage.loadProjects())[0]!.name).toBe("After!");
      expect((await storage.loadConfig()).global.webClientEnabled).toBe(false);
    });
  });

  test("recovers the config from backup when its file cannot be stat'd", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const config = defaultConfig();
      config.global.webClientEnabled = false;
      await storage.saveConfig(config);
      // The second write is what puts a full config into the rotated backup.
      const later = structuredClone(config);
      later.global.webClientEnabled = true;
      await storage.saveConfig(later);

      const configPath = path.join(dataDir, "config.json");
      const realStat = fs.stat.bind(fs);
      const statSpy = spyOn(fs, "stat").mockImplementation((async (
        target: Parameters<typeof fs.stat>[0],
      ) => {
        if (String(target) === configPath) {
          throw Object.assign(new Error("EACCES: permission denied, stat"), { code: "EACCES" });
        }
        return realStat(target);
      }) as typeof fs.stat);
      try {
        expect((await new StorageService(dataDir).loadConfig()).global.webClientEnabled).toBe(
          false,
        );
      } finally {
        statSpy.mockRestore();
      }
    });
  });

  test("surfaces an unreadable store instead of presenting it as empty", async () => {
    await withTemporaryStorage(async (storage) => {
      const stored = await storage.addEnvironment(createEnvironment("project-1"));

      const database = storageDatabase(storage);
      const readStore = database.readStore.bind(database);
      const readSpy = spyOn(database, "readStore").mockImplementation((store) => {
        if (store === "environments") throw new Error("SQLITE_IOERR: disk I/O error");
        return readStore(store);
      });
      try {
        await expect(storage.loadEnvironments()).rejects.toThrow("SQLITE_IOERR");
        // The empty view was never the real damage: the next mutation would
        // have appended to that empty list and written it back over the
        // user's intact data.
        await expect(storage.addEnvironment(createEnvironment("project-1"))).rejects.toThrow(
          "SQLITE_IOERR",
        );
      } finally {
        readSpy.mockRestore();
      }

      expect((await storage.loadEnvironments()).map((item) => item.id)).toEqual([stored.id]);
    });
  });

  test("skips the lease sweep without the cross-process lock when no leases exist", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      await storage.addEnvironment(createEnvironment("project-1"));
      // A live foreign lease blocks the mutation path for its full 20s
      // timeout; the sweep must not need it when nothing can expire.
      const holder = openBackendDatabase(dataDir);
      const release = await holder.acquireLease("environments.json", "test");
      try {
        await expect(storage.expireFrontendAgentActivityLeases()).resolves.toEqual([]);
      } finally {
        await release();
        holder.close();
      }
    });
  });
});

describe("environment completion and unread state", () => {
  test("records async-question attention once and does not relight a cleared badge on replay", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      const first = await storage.recordEnvironmentAgentAttention(
        environment.id,
        ["codex:session-1:item-1", "codex:session-1:item-1"],
        new Date().toISOString(),
      );
      expect(first.recorded).toBe(true);
      expect(first.environment.hasUnreadWork).toBe(true);
      expect(first.environment.agentAttentionKeys).toEqual(["codex:session-1:item-1"]);

      await storage.setEnvironmentUnread(environment.id, false);
      const replay = await storage.recordEnvironmentAgentAttention(
        environment.id,
        ["codex:session-1:item-1"],
        new Date().toISOString(),
      );
      expect(replay.recorded).toBe(false);
      expect(replay.environment.hasUnreadWork).toBe(false);
    });
  });

  test("records a per-session completion even when its timestamp collides with aggregate activity", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      const collision = environment.lastActivityAt!;

      const completed = await storage.recordEnvironmentSessionCompletion(environment.id, collision);

      expect(completed.hasUnreadWork).toBe(true);
      expect(Date.parse(completed.lastActivityAt!)).toBe(Date.parse(collision) + 1);
      expect(completed.agentSessionCompletedAt).toBe(completed.lastActivityAt);
      const next = await storage.recordEnvironmentSessionCompletion(environment.id, collision);
      expect(Date.parse(next.agentSessionCompletedAt!)).toBe(
        Date.parse(completed.agentSessionCompletedAt!) + 1,
      );
      expect((await storage.getEnvironment(environment.id))?.agentSessionCompletedAt).toBe(
        next.agentSessionCompletedAt,
      );
      await expect(
        storage.recordEnvironmentSessionCompletion(environment.id, "not-an-iso-time"),
      ).rejects.toThrow("occurredAt must be a valid ISO timestamp");
      await expect(
        storage.recordEnvironmentSessionCompletion("missing", new Date().toISOString()),
      ).rejects.toThrow("Environment not found: missing");
    });
  });

  test("request completion dedupe survives acknowledgement and storage reload", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      const at = new Date().toISOString();
      const completed = await storage.recordEnvironmentSessionCompletion(
        environment.id,
        at,
        "agent_failed",
        "request-completion-1",
      );
      await storage.setEnvironmentUnread(environment.id, false);
      const reopened = new StorageService(storage.getDataDir());
      await reopened.init();
      const replay = await reopened.recordEnvironmentSessionCompletion(
        environment.id,
        at,
        "agent_failed",
        "request-completion-1",
      );
      expect(replay.hasUnreadWork).toBe(false);
      expect(replay.agentSessionCompletedAt).toBe(completed.agentSessionCompletedAt);
      const next = await reopened.recordEnvironmentSessionCompletion(
        environment.id,
        at,
        "agent_finished",
        "request-completion-2",
      );
      expect(next.hasUnreadWork).toBe(true);
      expect(next.agentSessionCompletedAt).not.toBe(completed.agentSessionCompletedAt);
    });
  });

  test("does not move the unread activity token backwards for a fresh observer", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      const completion = new Date(Date.now() + 60_000).toISOString();
      await storage.recordEnvironmentCompletion(environment.id, completion);
      const olderTransition = new Date(Date.now() + 1_000).toISOString();

      await storage.setEnvironmentAgentActivity(
        environment.id,
        "working",
        olderTransition,
        "frontend",
        "fresh-observer",
      );

      expect((await storage.getEnvironment(environment.id))?.lastActivityAt).toBe(completion);
    });
  });

  test("records a newer completion and ignores stale completion timestamps", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      const previousActivityAt = environment.lastActivityAt!;
      const newer = new Date(new Date(previousActivityAt).getTime() + 1).toISOString();
      const completed = await storage.recordEnvironmentCompletion(environment.id, newer);
      expect(completed).toMatchObject({
        lastActivityAt: newer,
        hasUnreadWork: true,
      });

      await storage.setEnvironmentUnread(environment.id, false, newer);
      const stale = await storage.recordEnvironmentCompletion(environment.id, previousActivityAt);
      expect(stale).toMatchObject({
        lastActivityAt: newer,
        hasUnreadWork: false,
      });
      await expect(storage.recordEnvironmentCompletion(environment.id, "invalid")).rejects.toThrow(
        "occurredAt must be a valid ISO timestamp",
      );
    });
  });

  test("clears unread only when the expected activity token still matches", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      const previousActivityAt = environment.lastActivityAt!;
      const activityAt = new Date(new Date(previousActivityAt).getTime() + 1).toISOString();
      await storage.recordEnvironmentCompletion(environment.id, activityAt);

      const staleClear = await storage.setEnvironmentUnread(
        environment.id,
        false,
        previousActivityAt,
      );
      expect(staleClear.hasUnreadWork).toBe(true);

      const cleared = await storage.setEnvironmentUnread(environment.id, false, activityAt);
      expect(cleared.hasUnreadWork).toBe(false);
      expect((await storage.getEnvironment(environment.id))!.hasUnreadWork).toBe(false);
      await expect(
        storage.setEnvironmentUnread(environment.id, true, 123 as never),
      ).rejects.toThrow("expectedLastActivityAt must be a string or null");
    });
  });

  test("generic environment updates clear the persisted unread reason with the badge", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      await storage.setEnvironmentUnread(environment.id, true);
      expect((await storage.getEnvironment(environment.id))?.unreadReason).toBe("marked_unread");

      const updated = await storage.updateEnvironment(environment.id, { hasUnreadWork: false });
      expect(updated.hasUnreadWork).toBe(false);
      expect(updated).not.toHaveProperty("unreadReason");
      const persisted = await storage.getEnvironment(environment.id);
      expect(persisted?.hasUnreadWork).toBe(false);
      expect(persisted).not.toHaveProperty("unreadReason");
    });
  });

  test("records what lit the badge and forgets it once the badge clears", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
      const reasonAfter = async (record: () => Promise<unknown>) => {
        await record();
        return (await storage.getEnvironment(environment.id))?.unreadReason;
      };
      const clear = () => storage.setEnvironmentUnread(environment.id, false);

      expect(
        await reasonAfter(() => storage.recordEnvironmentCompletion(environment.id, at(1_000))),
      ).toBe("terminal_finished");
      expect(await reasonAfter(clear)).toBeUndefined();

      expect(
        await reasonAfter(() =>
          storage.recordEnvironmentSessionCompletion(environment.id, at(2_000), "agent_waiting"),
        ),
      ).toBe("agent_waiting");
      expect(
        await reasonAfter(() =>
          storage.recordEnvironmentSessionCompletion(environment.id, at(3_000)),
        ),
      ).toBe("agent_finished");
      expect(
        await reasonAfter(() =>
          storage.recordEnvironmentAgentAttention(environment.id, ["codex:q"], at(4_000)),
        ),
      ).toBe("agent_question");
      await clear();

      await storage.setEnvironmentAgentActivity(
        environment.id,
        "working",
        at(5_000),
        "native-agent",
      );
      expect(
        await reasonAfter(() =>
          storage.setEnvironmentAgentActivity(environment.id, "waiting", at(6_000), "native-agent"),
        ),
      ).toBe("agent_waiting");
      await clear();
      await storage.setEnvironmentAgentActivity(
        environment.id,
        "working",
        at(7_000),
        "native-agent",
      );
      expect(
        await reasonAfter(() =>
          storage.setEnvironmentAgentActivity(environment.id, "idle", at(8_000), "native-agent"),
        ),
      ).toBe("agent_finished");
      await clear();

      expect(await reasonAfter(() => storage.setEnvironmentUnread(environment.id, true))).toBe(
        "marked_unread",
      );
    });
  });
});

describe("Kanban point reads", () => {
  test("returns one task by id and null when it is absent", async () => {
    await withTemporaryStorage(async (storage) => {
      const task = await storage.kanban.addKanbanTask("project-1", "Build", "Details");
      await storage.kanban.addKanbanTask("project-2", "Other", "Other details");

      await expect(storage.kanban.getKanbanTask(task.id)).resolves.toEqual(task);
      await expect(storage.kanban.getKanbanTask("missing-task")).resolves.toBeNull();
    });
  });
});

describe("session buffer deletion", () => {
  test("removes an existing buffer and is idempotent when it is already absent", async () => {
    await withTemporaryStorage(async (storage) => {
      await storage.saveSessionBuffer("session-delete", "sensitive terminal output");
      expect(await storage.loadSessionBuffer("session-delete")).toBe("sensitive terminal output");

      await storage.deleteSessionBuffer("session-delete");
      await storage.deleteSessionBuffer("session-delete");

      expect(await storage.loadSessionBuffer("session-delete")).toBeNull();
    });
  });
});

describe("environment diff baseline persistence", () => {
  test("normalizes SHA pairs, persists across reload and explicitly clears null and undefined", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const environment = createEnvironment("project");
      await storage.addEnvironment(environment);
      for (const clear of [null, undefined]) {
        await storage.updateEnvironment(environment.id, {
          diffBaseline: { createdFromCommit: "A".repeat(40), commit: "B".repeat(40) },
        });
        const restarted = new StorageService(dataDir);
        await restarted.init();
        expect((await restarted.getEnvironment(environment.id))?.diffBaseline).toEqual({
          createdFromCommit: "a".repeat(40),
          commit: "b".repeat(40),
        });
        await storage.updateEnvironment(environment.id, { diffBaseline: clear });
        expect((await restarted.getEnvironment(environment.id))?.diffBaseline).toBeNull();
      }
    });
  });

  test("rejects malformed baselines without altering the saved pair", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project");
      const baseline = { createdFromCommit: "a".repeat(40), commit: "b".repeat(40) };
      await storage.addEnvironment({ ...environment, diffBaseline: baseline });
      for (const value of [
        {},
        [],
        "main",
        42,
        { commit: baseline.commit },
        { ...baseline, commit: "b".repeat(39) },
        { ...baseline, commit: "z".repeat(40) },
        { ...baseline, createdFromCommit: "origin/main" },
        { ...baseline, createdFromCommit: 42 },
      ]) {
        await expect(
          storage.updateEnvironment(environment.id, { diffBaseline: value }),
        ).rejects.toThrow("Invalid environment diff baseline");
        expect((await storage.getEnvironment(environment.id))?.diffBaseline).toEqual(baseline);
      }
    });
  });

  test("conditional updates observe preceding queued mutations under the storage lock", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project");
      await storage.addEnvironment({ ...environment, prState: "open" });
      const merged = storage.updateEnvironment(environment.id, { prState: "merged" });
      const baseline = storage.updateEnvironment(
        environment.id,
        {
          diffBaseline: { createdFromCommit: "a".repeat(40), commit: "b".repeat(40) },
        },
        (current) => current.prState !== "merged",
      );
      await Promise.all([merged, baseline]);
      expect((await storage.getEnvironment(environment.id))?.diffBaseline).toBeUndefined();
    });
  });
});
