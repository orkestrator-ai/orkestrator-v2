import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  closeEnvironmentCleanupStorage,
  EnvironmentCleanupLedger,
  environmentCleanupSweepState,
  isEnvironmentCleanupExhausted,
  isEnvironmentCleanupRetryableByVersion,
  MAX_ENVIRONMENT_CLEANUP_ATTEMPTS,
  parseEnvironmentCleanupLedger,
  type EnvironmentCleanupEntry,
} from "./environment-cleanup-ledger.js";
import { StorageDatabase } from "./storage-database.js";
import { openBackendDatabase } from "./storage-stores.js";
import { readStoredValue, seedStore, seedUnreadableStore } from "./storage-test-support.js";

const LEDGER = "environment-cleanup-ledger.json";
const tempDirectories: string[] = [];

afterEach(async () => {
  closeEnvironmentCleanupStorage();
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function ledgerInTempDir(): Promise<{ ledger: EnvironmentCleanupLedger; dataDir: string }> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-cleanup-ledger-"));
  tempDirectories.push(dataDir);
  return { ledger: new EnvironmentCleanupLedger(dataDir), dataDir };
}

function entry(overrides: Partial<EnvironmentCleanupEntry> = {}): EnvironmentCleanupEntry {
  return {
    version: 1,
    environmentId: "e1",
    recordedAt: "2026-09-26T00:00:00.000Z",
    projectPath: "/project",
    worktreePath: "/workspaces/project-e1",
    branch: "e1",
    prMerged: false,
    createdFromCommit: null,
    baseBranches: [],
    containerId: null,
    retainedContainers: [],
    volumes: [],
    stateDirectories: ["/data/cursor-bridge-state/abc"],
    pending: ["worktree", "branch", "state-dirs"],
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    ...overrides,
  };
}

describe("environment cleanup ledger", () => {
  test("drops an entry, leaving an empty ledger, once every step completes", async () => {
    const { ledger, dataDir } = await ledgerInTempDir();
    await ledger.record(entry());
    await ledger.complete("e1", "worktree");
    await ledger.complete("e1", "branch");
    expect((await ledger.get("e1"))?.pending).toEqual(["state-dirs"]);

    await ledger.complete("e1", "state-dirs");
    expect(await ledger.get("e1")).toBeNull();
    expect(await ledger.list()).toEqual([]);
    expect(readStoredValue(dataDir, LEDGER)).toEqual({ version: 1, entries: {} });
  });

  test("keeps a failed step pending with its redacted error", async () => {
    const { ledger } = await ledgerInTempDir();
    await ledger.record(entry());
    await ledger.fail("e1", "worktree", "EACCES");
    await ledger.noteAttempt("e1", new Date("2026-09-26T01:00:00.000Z"));
    expect(await ledger.get("e1")).toMatchObject({
      pending: ["worktree", "branch", "state-dirs"],
      lastError: "worktree: EACCES",
      attempts: 1,
      lastAttemptAt: "2026-09-26T01:00:00.000Z",
    });
  });

  test("a retried deletion keeps what the earlier attempt still owed", async () => {
    const { ledger } = await ledgerInTempDir();
    await ledger.record(entry({ containerId: "old-container", pending: ["container"] }));
    await ledger.noteAttempt("e1", new Date("2026-09-26T01:00:00.000Z"));
    await ledger.record(entry({ containerId: null, pending: ["state-dirs"] }));
    expect(await ledger.get("e1")).toMatchObject({
      containerId: "old-container",
      pending: ["state-dirs", "container"],
      attempts: 1,
      recordedAt: "2026-09-26T00:00:00.000Z",
    });
  });

  test("tolerates an unreadable ledger instead of blocking new records", async () => {
    const { ledger, dataDir } = await ledgerInTempDir();
    seedUnreadableStore(dataDir, LEDGER, "{ torn");
    expect(await ledger.list()).toEqual([]);
    expect(await ledger.get("e1")).toBeNull();
    await ledger.record(entry());
    expect((await ledger.list()).map((item) => item.environmentId)).toEqual(["e1"]);
  });

  test("an entry is exhausted once its passes reach the attempt cap", async () => {
    const { ledger } = await ledgerInTempDir();
    await ledger.record(entry());
    for (let pass = 1; pass < MAX_ENVIRONMENT_CLEANUP_ATTEMPTS; pass += 1) {
      await ledger.noteAttempt("e1", new Date("2026-09-26T01:00:00.000Z"));
    }
    expect(isEnvironmentCleanupExhausted((await ledger.get("e1"))!)).toBe(false);
    await ledger.noteAttempt("e1", new Date("2026-09-26T02:00:00.000Z"));
    const exhausted = (await ledger.get("e1"))!;
    expect(exhausted.attempts).toBe(MAX_ENVIRONMENT_CLEANUP_ATTEMPTS);
    expect(isEnvironmentCleanupExhausted(exhausted)).toBe(true);
  });

  test("parses a stored value the way the ledger reads it", () => {
    expect(parseEnvironmentCleanupLedger(undefined)).toEqual([]);
    expect(parseEnvironmentCleanupLedger({ version: 2, entries: { e1: entry() } })).toEqual([]);
    const parsed = parseEnvironmentCleanupLedger({
      version: 1,
      entries: {
        bad: { version: 2, environmentId: "bad" },
        e1: { ...entry(), attempts: -3, pending: ["worktree", "format-disk"] },
      },
    });
    expect(parsed).toEqual([
      entry({ attempts: 0, pending: ["worktree"], worktreeRoot: null, attemptedVersions: [] }),
    ]);
    const versions = parseEnvironmentCleanupLedger({
      version: 1,
      entries: { e1: { ...entry(), attemptedVersions: ["1.0.0", 7, "", "1.0.0", "1.1.0"] } },
    });
    expect(versions[0]?.attemptedVersions).toEqual(["1.0.0", "1.1.0"]);
  });

  test("records each backend version that counts an attempt, most recent last", async () => {
    const { ledger } = await ledgerInTempDir();
    await ledger.record(entry());
    const at = new Date("2026-09-26T01:00:00.000Z");
    await ledger.noteAttempt("e1", at, "1.0.0");
    await ledger.noteAttempt("e1", at, "1.1.0");
    await ledger.noteAttempt("e1", at, "1.0.0");
    await ledger.noteAttempt("e1", at);
    const current = (await ledger.get("e1"))!;
    expect(current.attempts).toBe(4);
    expect(current.attemptedVersions).toEqual(["1.1.0", "1.0.0"]);
    for (let version = 0; version < 40; version += 1) {
      await ledger.noteAttempt("e1", at, `2.${version}.0`);
    }
    const bounded = (await ledger.get("e1"))!.attemptedVersions!;
    expect(bounded).toHaveLength(16);
    expect(bounded.at(-1)).toBe("2.39.0");
    // A re-deletion keeps what earlier versions already tried.
    await ledger.record(entry({ attempts: 0 }));
    expect((await ledger.get("e1"))?.attemptedVersions).toEqual(bounded);
  });

  test("re-arms an exhausted entry once per backend version that never tried it", async () => {
    const { ledger } = await ledgerInTempDir();
    const lastAttemptAt = "2026-09-26T02:00:00.000Z";
    await ledger.record(entry());
    for (let pass = 0; pass < MAX_ENVIRONMENT_CLEANUP_ATTEMPTS; pass += 1) {
      await ledger.noteAttempt("e1", new Date(lastAttemptAt), "1.0.0");
    }
    // The version that exhausted it gets nothing more.
    expect(isEnvironmentCleanupRetryableByVersion((await ledger.get("e1"))!, "1.0.0")).toBe(false);
    expect(await ledger.rearmForVersion("e1", "1.0.0")).toBe(false);

    expect(await ledger.rearmForVersion("e1", "1.1.0")).toBe(true);
    const rearmed = (await ledger.get("e1"))!;
    expect(rearmed).toMatchObject({
      attempts: 0,
      attemptedVersions: ["1.0.0", "1.1.0"],
      lastAttemptAt,
      pending: ["worktree", "branch", "state-dirs"],
    });
    // Recorded at once, so the same version cannot re-arm it twice.
    for (let pass = 0; pass < MAX_ENVIRONMENT_CLEANUP_ATTEMPTS; pass += 1) {
      await ledger.noteAttempt("e1", new Date(lastAttemptAt), "1.1.0");
    }
    expect(await ledger.rearmForVersion("e1", "1.1.0")).toBe(false);
    // Going back to an older version that already tried it does not either.
    expect(await ledger.rearmForVersion("e1", "1.0.0")).toBe(false);
    expect((await ledger.get("e1"))!.attempts).toBe(MAX_ENVIRONMENT_CLEANUP_ATTEMPTS);
  });

  test("never re-arms an entry that is still retrying or is gone", async () => {
    const { ledger } = await ledgerInTempDir();
    await ledger.record(entry({ attempts: MAX_ENVIRONMENT_CLEANUP_ATTEMPTS - 1 }));
    expect(await ledger.rearmForVersion("e1", "9.9.9")).toBe(false);
    expect((await ledger.get("e1"))!.attempts).toBe(MAX_ENVIRONMENT_CLEANUP_ATTEMPTS - 1);
    expect(await ledger.rearmForVersion("missing", "9.9.9")).toBe(false);
  });

  test("an entry from before versions were recorded is re-armable by any version", async () => {
    const { ledger, dataDir } = await ledgerInTempDir();
    // `entry()` has no `attemptedVersions`, as entries written before it.
    const legacy = entry({ attempts: MAX_ENVIRONMENT_CLEANUP_ATTEMPTS });
    seedStore(dataDir, LEDGER, { version: 1, entries: { e1: legacy } });
    expect(await ledger.rearmForVersion("e1", "1.0.0")).toBe(true);
    expect((await ledger.get("e1"))?.attemptedVersions).toEqual(["1.0.0"]);
  });

  test("ignores malformed entries and unknown steps", async () => {
    const { ledger, dataDir } = await ledgerInTempDir();
    seedStore(dataDir, LEDGER, {
      version: 1,
      entries: {
        bad: { version: 2, environmentId: "bad" },
        e1: { ...entry(), pending: ["worktree", "format-disk"] },
      },
    });
    const entries = await ledger.list();
    expect(entries.map((item) => item.environmentId)).toEqual(["e1"]);
    expect(entries[0]?.pending).toEqual(["worktree"]);
    expect(await ledger.get("bad")).toBeNull();
    expect((await ledger.get("e1"))?.pending).toEqual(["worktree"]);
  });

  test("keeps a record another backend committed between two of its writes", async () => {
    const { ledger, dataDir } = await ledgerInTempDir();
    await ledger.record(entry());
    // A second backend sharing the data directory has its own connection.
    const other = openBackendDatabase(dataDir);
    try {
      other.updateStore(
        "environment-cleanup-ledger",
        () => ({ version: 1, entries: {} }),
        (ledger: { entries: Record<string, EnvironmentCleanupEntry> }) => {
          ledger.entries.e2 = entry({ environmentId: "e2" });
        },
      );
    } finally {
      other.close();
    }
    await ledger.complete("e1", "worktree");
    expect((await ledger.list()).map((item) => item.environmentId).sort()).toEqual(["e1", "e2"]);
    expect((await ledger.get("e1"))?.pending).toEqual(["branch", "state-dirs"]);
  });

  test("a failed write commits nothing and leaves the previous ledger", async () => {
    const { ledger } = await ledgerInTempDir();
    await ledger.record(entry());
    const write = spyOn(StorageDatabase.prototype, "writeStoreInTransaction").mockImplementation(
      () => {
        throw new Error("disk full");
      },
    );
    try {
      await expect(ledger.complete("e1", "worktree")).rejects.toThrow("disk full");
      await expect(ledger.record(entry({ environmentId: "e2" }))).rejects.toThrow("disk full");
    } finally {
      write.mockRestore();
    }
    expect((await ledger.list()).map((item) => item.pending)).toEqual([
      ["worktree", "branch", "state-dirs"],
    ]);
  });

  test("a storage failure other than an unreadable value is not read as an empty ledger", async () => {
    const { ledger } = await ledgerInTempDir();
    await ledger.record(entry());
    const read = spyOn(StorageDatabase.prototype, "readStore").mockImplementation(() => {
      throw new Error("database is locked");
    });
    try {
      await expect(ledger.list()).rejects.toThrow("database is locked");
    } finally {
      read.mockRestore();
    }
    expect(await ledger.list()).toHaveLength(1);
  });

  test("follows a data directory deleted and recreated at the same path", async () => {
    const { ledger, dataDir } = await ledgerInTempDir();
    await ledger.record(entry());
    await fs.rm(dataDir, { recursive: true, force: true });
    expect(await ledger.list()).toEqual([]);
    await fs.mkdir(dataDir, { recursive: true });
    await ledger.record(entry({ environmentId: "e2" }));
    expect(
      Object.keys(readStoredValue<{ entries: Record<string, unknown> }>(dataDir, LEDGER)!.entries),
    ).toEqual(["e2"]);
  });
});

describe("environment cleanup sweep state", () => {
  test("records sweeps and cursors, dropping unknown projects", async () => {
    const { dataDir } = await ledgerInTempDir();
    const state = environmentCleanupSweepState(dataDir);
    await state.recordBranchSweep("p1", new Date("2026-09-26T00:00:00.000Z"), ["p1"]);
    await state.recordBranchSweep(
      "p2",
      new Date("2026-09-26T01:00:00.000Z"),
      ["p2"],
      "refs/heads/feature",
    );
    expect(await state.branchSweeps()).toEqual({ p2: "2026-09-26T01:00:00.000Z" });
    expect(await state.branchCursors()).toEqual({ p2: "refs/heads/feature" });
  });

  test("an unreadable sweep state reads as empty and is replaced", async () => {
    const { dataDir } = await ledgerInTempDir();
    seedUnreadableStore(dataDir, "environment-cleanup-sweeps.json");
    const state = environmentCleanupSweepState(dataDir);
    expect(await state.branchSweeps()).toEqual({});
    await state.recordBranchSweep("p1", new Date("2026-09-26T00:00:00.000Z"), []);
    expect(await state.branchSweeps()).toEqual({ p1: "2026-09-26T00:00:00.000Z" });
  });
});
