import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  claudeProjectDirectoryName,
  formatBytes,
  formatReport,
  legacyTurboArtifacts,
  previewPartitionRows,
  readEnvironments,
} from "../../scripts/disk-report";
import { openBackendDatabase } from "../../apps/backend/src/core/storage-stores";

let root: string;

beforeEach(async () => {
  root = realpathSync(await mkdtemp(path.join(os.tmpdir(), "orkestrator-disk-report-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

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
          ORKESTRATOR_WORKTREE_DIR: path.join(root, "workspaces"),
        },
      });

    const report = invoke("--json");
    expect(report.status).toBe(0);
    const rows = JSON.parse(report.stdout) as Array<{ location: string; orphaned: string }>;
    expect(rows.find((row) => row.location === `${turbo} legacy artifacts`)?.orphaned).toBe(
      "1 files",
    );
    expect(rows.some((row) => row.location === `${checkout} environment branches`)).toBe(true);
    expect(existsSync(legacy)).toBe(true);

    const fixed = invoke("--fix", "legacy-turbo");
    expect(fixed.status).toBe(0);
    expect(fixed.stdout).toContain("Removed 1 legacy Turbo artifacts");
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(active)).toBe(true);
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
