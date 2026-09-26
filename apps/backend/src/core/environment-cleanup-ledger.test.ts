import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ENVIRONMENT_CLEANUP_LEDGER_FILE,
  EnvironmentCleanupLedger,
  type EnvironmentCleanupEntry,
} from "./environment-cleanup-ledger.js";

const tempDirectories: string[] = [];

afterEach(async () => {
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
    stateDirectories: ["/data/cursor-bridge-state/abc"],
    pending: ["worktree", "branch", "state-dirs"],
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    ...overrides,
  };
}

describe("environment cleanup ledger", () => {
  test("drops an entry, and then the file, once every step completes", async () => {
    const { ledger, dataDir } = await ledgerInTempDir();
    await ledger.record(entry());
    await ledger.complete("e1", "worktree");
    await ledger.complete("e1", "branch");
    expect((await ledger.get("e1"))?.pending).toEqual(["state-dirs"]);

    await ledger.complete("e1", "state-dirs");
    expect(await ledger.get("e1")).toBeNull();
    await expect(fs.stat(path.join(dataDir, ENVIRONMENT_CLEANUP_LEDGER_FILE))).rejects.toThrow();
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

  test("tolerates a torn ledger file instead of blocking new records", async () => {
    const { ledger, dataDir } = await ledgerInTempDir();
    await fs.writeFile(path.join(dataDir, ENVIRONMENT_CLEANUP_LEDGER_FILE), "{ torn");
    expect(await ledger.list()).toEqual([]);
    await ledger.record(entry());
    expect((await ledger.list()).map((item) => item.environmentId)).toEqual(["e1"]);
  });

  test("ignores malformed entries and unknown steps", async () => {
    const { ledger, dataDir } = await ledgerInTempDir();
    await fs.writeFile(
      path.join(dataDir, ENVIRONMENT_CLEANUP_LEDGER_FILE),
      JSON.stringify({
        version: 1,
        entries: {
          bad: { version: 2, environmentId: "bad" },
          e1: { ...entry(), pending: ["worktree", "format-disk"] },
        },
      }),
    );
    const entries = await ledger.list();
    expect(entries.map((item) => item.environmentId)).toEqual(["e1"]);
    expect(entries[0]?.pending).toEqual(["worktree"]);
  });
});
