import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  claudeProjectDirectoryName,
  environmentCleanupLedgerRow,
  formatBytes,
  formatReport,
  legacyTurboArtifacts,
  previewPartitionRows,
  readEnvironments,
  temporaryBrowserRows,
} from "../../scripts/disk-report";
import {
  closeEnvironmentCleanupStorage,
  environmentCleanupLedger,
  MAX_ENVIRONMENT_CLEANUP_ATTEMPTS,
  type EnvironmentCleanupEntry,
} from "../../apps/backend/src/core/environment-cleanup-ledger";
import { openBackendDatabase } from "../../apps/backend/src/core/storage-stores";
import { defaultRuntimeProfileRoots } from "../../packages/protocol/src/node/runtime-profile-status";

let root: string;

beforeEach(async () => {
  root = realpathSync(await mkdtemp(path.join(os.tmpdir(), "orkestrator-disk-report-")));
});

afterEach(async () => {
  closeEnvironmentCleanupStorage();
  await rm(root, { recursive: true, force: true });
});

function ledgerEntry(
  environmentId: string,
  overrides: Partial<EnvironmentCleanupEntry> = {},
): EnvironmentCleanupEntry {
  return {
    version: 1,
    environmentId,
    recordedAt: "2026-10-01T00:00:00.000Z",
    projectPath: "/project",
    worktreePath: `/workspaces/project-${environmentId}`,
    branch: environmentId,
    prMerged: false,
    createdFromCommit: null,
    baseBranches: [],
    containerId: null,
    retainedContainers: [],
    volumes: [],
    stateDirectories: [],
    pending: ["worktree", "branch"],
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    ...overrides,
  };
}

/**
 * Records an entry through the real ledger and fails it `passes` times, the
 * way the reconciler does, so the report reads what the backend wrote.
 */
async function seedFailingCleanup(
  dataDir: string,
  entry: EnvironmentCleanupEntry,
  passes: number,
  error: { step: EnvironmentCleanupEntry["pending"][number]; code: string } | null,
): Promise<void> {
  const ledger = environmentCleanupLedger(dataDir);
  await ledger.record(entry);
  for (let pass = 0; pass < passes; pass += 1) {
    await ledger.noteAttempt(entry.environmentId, new Date("2026-10-01T01:00:00.000Z"));
    if (error) await ledger.fail(entry.environmentId, error.step, error.code);
  }
}

describe("disk report", () => {
  test("reports an isolated checkout and only fixes named legacy Turbo artifacts", async () => {
    const checkout = path.join(root, "checkout");
    const turbo = path.join(checkout, ".turbo");
    await mkdir(path.join(turbo, "cache"), { recursive: true });
    const legacy = path.join(turbo, "0123456789abcdef.tar.zst");
    const active = path.join(turbo, "cache", "active.tar.zst");
    await writeFile(legacy, "obsolete\n");
    await writeFile(active, "live\n");
    const initialized = spawnSync("git", ["init", "-q", "-b", "main", checkout], {
      encoding: "utf8",
    });
    expect(initialized.status).toBe(0);
    const script = path.resolve(import.meta.dir, "../../scripts/disk-report.ts");
    const invoke = (...args: string[]) =>
      spawnSync(process.execPath, [script, ...args], {
        cwd: checkout,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          XDG_CONFIG_HOME: path.join(root, ".config"),
          ORKESTRATOR_WORKTREE_DIR: path.join(root, "workspaces"),
        },
      });
    // The data directory the script resolves for this HOME, never the host's.
    const dataDir = defaultRuntimeProfileRoots(
      process.platform,
      { XDG_CONFIG_HOME: path.join(root, ".config") },
      root,
    ).productionDataDir;
    await mkdir(dataDir, { recursive: true });
    await seedFailingCleanup(dataDir, ledgerEntry("env-stuck"), MAX_ENVIRONMENT_CLEANUP_ATTEMPTS, {
      step: "worktree",
      code: "EACCES",
    });
    closeEnvironmentCleanupStorage();

    const report = invoke("--json");
    expect(report.status).toBe(0);
    const rows = JSON.parse(report.stdout) as Array<{ location: string; orphaned: string }>;
    expect(rows.find((row) => row.location === `${turbo} legacy artifacts`)?.orphaned).toBe(
      "1 files",
    );
    expect(rows.some((row) => row.location === `${checkout} environment branches`)).toBe(true);
    expect(
      rows.find((row) => row.location === `${dataDir} environment cleanup ledger`)?.orphaned,
    ).toBe(
      "1 stopped retrying, 0 retrying (pending: worktree 1, branch 1; last errors: worktree: EACCES)",
    );
    expect(existsSync(legacy)).toBe(true);

    const fixed = invoke("--fix", "legacy-turbo");
    expect(fixed.status).toBe(0);
    expect(fixed.stdout).toContain("Removed 1 legacy Turbo artifacts");
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(active)).toBe(true);
  });

  test("reports cleanup the reconciler stopped retrying, never a live environment's", async () => {
    const dataDir = path.join(root, "data");
    await mkdir(dataDir);
    // No database yet: nothing to report, and the report creates none.
    expect(environmentCleanupLedgerRow(dataDir, new Set()).orphaned).toBe(
      "0 stopped retrying, 0 retrying",
    );
    expect(existsSync(path.join(dataDir, "orkestrator.sqlite"))).toBe(false);

    const cap = MAX_ENVIRONMENT_CLEANUP_ATTEMPTS;
    await seedFailingCleanup(dataDir, ledgerEntry("env-stuck-a"), cap, {
      step: "worktree",
      code: "EACCES",
    });
    await seedFailingCleanup(
      dataDir,
      ledgerEntry("env-stuck-b", { pending: ["container", "volumes"] }),
      cap + 1,
      { step: "container", code: "exit 125" },
    );
    await seedFailingCleanup(dataDir, ledgerEntry("env-retrying"), cap - 1, {
      step: "worktree",
      code: "EBUSY",
    });
    // Its record still exists, so interrupted-deletion recovery owns it.
    await seedFailingCleanup(dataDir, ledgerEntry("env-live"), cap, {
      step: "branch",
      code: "exit 1",
    });
    closeEnvironmentCleanupStorage();

    const row = environmentCleanupLedgerRow(dataDir, new Set(["env-live"]));
    expect(row).toEqual({
      location: `${dataDir} environment cleanup ledger`,
      bytes: null,
      orphaned:
        "2 stopped retrying, 1 retrying (pending: container 1, volumes 1, worktree 1, branch 1; last errors: worktree: EACCES, container: exit 125)",
      owner: `Orkestrator (stops after ${cap} attempts)`,
      cleanup:
        "remove what the deletion of env-stuck-a, env-stuck-b left behind by hand; see docs/development/disk-usage.md",
    });
    expect(JSON.stringify(row)).not.toContain("/workspaces/");
  });

  test("names the first stuck deletions and counts the rest", async () => {
    const dataDir = path.join(root, "data");
    await mkdir(dataDir);
    for (let index = 0; index < 5; index += 1) {
      await seedFailingCleanup(
        dataDir,
        ledgerEntry(`env-${index}`, { recordedAt: `2026-10-0${index + 1}T00:00:00.000Z` }),
        MAX_ENVIRONMENT_CLEANUP_ATTEMPTS,
        index === 0 ? null : { step: "worktree", code: `E${index}` },
      );
    }
    closeEnvironmentCleanupStorage();
    const row = environmentCleanupLedgerRow(dataDir, new Set());
    expect(row.orphaned).toBe(
      "5 stopped retrying, 0 retrying (pending: worktree 5, branch 5; last errors: worktree: E1, worktree: E2, worktree: E3 +1 more)",
    );
    expect(row.cleanup).toStartWith(
      "remove what the deletion of env-0, env-1, env-2 (+2 more) left behind by hand",
    );
  });

  test("reads environments from the backend database without migrating a JSON data dir", async () => {
    const legacy = path.join(root, "legacy");
    await mkdir(legacy);
    await writeFile(path.join(legacy, "environments.json"), JSON.stringify([{ id: "json-env" }]));
    expect(readEnvironments(legacy)).toEqual([{ id: "json-env" }]);
    // A report must never create the database or move the JSON aside.
    expect(existsSync(path.join(legacy, "orkestrator.sqlite"))).toBe(false);
    expect(existsSync(path.join(legacy, "environments.json"))).toBe(true);

    const migrated = path.join(root, "migrated");
    await mkdir(migrated);
    const database = openBackendDatabase(migrated);
    database.writeStore("environments", [{ id: "db-env", worktreePath: "/w" }]);
    database.close();
    expect(readEnvironments(migrated)).toEqual([{ id: "db-env", worktreePath: "/w" }]);
  });

  test("names transcript directories the way Claude Code does", () => {
    expect(claudeProjectDirectoryName("/home/user/.config/orkestrator-v2-dev/profiles/qa")).toBe(
      "-home-user--config-orkestrator-v2-dev-profiles-qa",
    );
  });

  test("lists legacy Turbo artifacts and abandoned temp files, never live cache entries", async () => {
    const turbo = path.join(root, ".turbo");
    await mkdir(path.join(turbo, "cache"), { recursive: true });
    for (const name of [
      "f1b9cc0221797427.tar.zst",
      "f1b9cc0221797427-meta.json",
      "f1b9cc0221797427-manifest.json",
      "runs",
      "notes.txt",
    ]) {
      await writeFile(path.join(turbo, name), "");
    }
    for (const name of ["0123456789abcdef.tar.zst", "0123456789abcdef-manifest.json.tmp"]) {
      await writeFile(path.join(turbo, "cache", name), "");
    }

    expect(
      legacyTurboArtifacts(turbo)
        .map((file) => path.relative(turbo, file))
        .sort(),
    ).toEqual([
      "cache/0123456789abcdef-manifest.json.tmp",
      "f1b9cc0221797427-manifest.json",
      "f1b9cc0221797427-meta.json",
      "f1b9cc0221797427.tar.zst",
    ]);
    expect(legacyTurboArtifacts(path.join(root, "missing"))).toEqual([]);
  });

  test("measures preview partitions and counts those cleared for the next start", async () => {
    const partitions = path.join(root, "Partitions");
    const names = [
      "orkestrator-preview-svc-1-0123456789abcdef-0123456789abcdef",
      "orkestrator-preview-svc-1-0123456789abcdef-fedcba9876543210",
      "orkestrator-browser-previews-1-0123456789abcdef",
      "orkestrator-renderer-1-0123456789abcdef",
    ];
    for (const name of names) {
      await mkdir(path.join(partitions, name), { recursive: true });
      await writeFile(path.join(partitions, name, "Cookies"), "x".repeat(4096));
    }
    await writeFile(
      path.join(root, "preview-partitions-pending.json"),
      JSON.stringify([names[1], "orkestrator-preview-svc-9-gone", 7]),
    );
    const [service, shared] = previewPartitionRows(root);
    expect(service!.location).toBe(`${partitions}/orkestrator-preview-svc-*`);
    expect(service!.bytes).toBeGreaterThan(0);
    expect(service!.orphaned).toStartWith("1 of 2 cleared");
    expect(shared!.orphaned).toStartWith("0 of 1 cleared");
    // A profile without previews reports nothing, without failing.
    const empty = previewPartitionRows(path.join(root, "missing"));
    expect(empty.map((row) => [row.bytes, row.orphaned])).toEqual([
      [0, "0 of 0 cleared (0 kB)"],
      [0, "0 of 0 cleared (0 kB)"],
    ]);
  });

  test("formats sizes and aligns the table", () => {
    expect(formatBytes(null)).toBe("?");
    expect(formatBytes(2_500)).toBe("3 kB");
    expect(formatBytes(40.23e9)).toBe("40.2 GB");
    const table = formatReport([
      { location: "/a", bytes: 1e9, orphaned: "1", owner: "x", cleanup: "y" },
    ]).split("\n");
    expect(table[0]).toMatch(/^Location\s+Size\s+Orphaned\s+Owner\s+Cleanup$/);
    expect(table[2]).toMatch(/^\/a\s+1\.0 GB\s+1\s+x\s+y$/);
  });
});

describe("temporaryBrowserRows", () => {
  test("reports browser profiles and the directories holding them, each as its own row", async () => {
    const now = Date.parse("2026-10-28T12:00:00.000Z");
    const directories = {
      "playwright_chromiumdev_profile-Abc123": 50 * 3_600_000,
      "playwright_chromiumdev_profile-Def456": 2 * 3_600_000,
      "ork-artifact-preview-123-Ghi789": 5 * 3_600_000,
    };
    for (const [name, ageMs] of Object.entries(directories)) {
      const directory = path.join(root, name);
      await mkdir(path.join(directory, "Default"), { recursive: true });
      await writeFile(path.join(directory, "Default", "Preferences"), "x".repeat(4096));
      const modified = new Date(now - ageMs);
      await utimes(directory, modified, modified);
    }
    // Same prefix, but a file: not counted.
    await writeFile(path.join(root, "playwright_chromiumdev_profile-file00"), "");
    const commandLines = `chrome --user-data-dir=${path.join(root, "playwright_chromiumdev_profile-Def456")}`;

    const rows = temporaryBrowserRows(root, now, commandLines);

    expect(rows.map((row) => [row.location, row.orphaned])).toEqual([
      [`${root}/playwright_chromiumdev_profile-*`, "2 directories (1 in use, oldest 2d)"],
      [`${root}/ork-artifact-preview-*`, "1 directories (0 in use, oldest 5h)"],
      [`${root}/ork-test-tmp-*`, "0 directories (0 in use)"],
    ]);
    expect(rows[0]!.bytes).toBeGreaterThan(0);
    expect(rows[0]!.owner).toContain("owner unknown");
    expect(temporaryBrowserRows(root, now, null)[0]!.orphaned).toBe(
      "2 directories (in use unknown, oldest 2d)",
    );
    // Read-only: nothing was removed.
    for (const name of Object.keys(directories))
      expect(existsSync(path.join(root, name))).toBe(true);
  });
});
