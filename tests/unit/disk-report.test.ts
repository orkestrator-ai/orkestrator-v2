import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  claudeProjectDirectoryName,
  formatBytes,
  formatReport,
  legacyTurboArtifacts,
} from "../../scripts/disk-report";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "orkestrator-disk-report-"));
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
